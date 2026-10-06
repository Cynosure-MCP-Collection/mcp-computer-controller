/**
 * Layout-aware text input for X11 via the XTest extension (same approach as `xdotool type`).
 *
 * Each character is resolved to a keysym and looked up in the active keyboard group. Characters
 * on level 1 or 2 are typed with the matching key (plus Shift); anything else is typed by
 * temporarily binding the keysym to an unused keycode. This keeps symbols like / ? = @ correct
 * on non-US layouts, where robotjs' typeString assumes a US keymap.
 */

const XK_RETURN = 0xff0d;
const XK_TAB = 0xff09;
const XK_SHIFT_L = 0xffe1;
const XKB_USE_CORE_KBD = 0x0100;
const LOCK_MASK = 1 << 1;
/** Pause around keymap changes so clients process the press before the next MappingNotify. */
const REMAP_SETTLE_MS = 25;

interface XLib {
    open(name: string | null): unknown;
    close(dpy: unknown): number;
    keysymToKeycode(dpy: unknown, keysym: number): number;
    keycodeToKeysym(dpy: unknown, keycode: number, group: number, level: number): number;
    getState(dpy: unknown, device: number, state: Record<string, number>): number;
    displayKeycodes(dpy: unknown, min: number[], max: number[]): number;
    getKeyboardMapping(dpy: unknown, first: number, count: number, perKeycode: number[]): unknown;
    changeKeyboardMapping(dpy: unknown, first: number, perKeycode: number, keysyms: number[], count: number): number;
    free(ptr: unknown): number;
    sync(dpy: unknown, discard: number): number;
    fakeKeyEvent(dpy: unknown, keycode: number, press: number, delay: number): number;
    decodeKeysyms(ptr: unknown, count: number): number[];
}

let xlib: Promise<XLib> | undefined;

async function loadXLib(): Promise<XLib> {
    const { default: koffi } = await import('koffi');
    const x11 = koffi.load('libX11.so.6');
    const xtst = koffi.load('libXtst.so.6');

    const XkbStateRec = koffi.struct('XkbStateRec', {
        group: 'uint8', locked_group: 'uint8', base_group: 'uint16', latched_group: 'uint16',
        mods: 'uint8', base_mods: 'uint8', latched_mods: 'uint8', locked_mods: 'uint8',
        compat_state: 'uint8', grab_mods: 'uint8', compat_grab_mods: 'uint8',
        lookup_mods: 'uint8', compat_lookup_mods: 'uint8', ptr_buttons: 'uint16',
    });

    return {
        open: x11.func('void *XOpenDisplay(const char *name)'),
        close: x11.func('int XCloseDisplay(void *dpy)'),
        keysymToKeycode: x11.func('uint8 XKeysymToKeycode(void *dpy, unsigned long keysym)'),
        keycodeToKeysym: x11.func('unsigned long XkbKeycodeToKeysym(void *dpy, uint8 kc, int group, int level)'),
        getState: x11.func('XkbGetState', 'int', ['void *', 'uint', koffi.out(koffi.pointer(XkbStateRec))]),
        displayKeycodes: x11.func('int XDisplayKeycodes(void *dpy, _Out_ int *min, _Out_ int *max)'),
        getKeyboardMapping: x11.func('void *XGetKeyboardMapping(void *dpy, uint8 first, int count, _Out_ int *perKeycode)'),
        changeKeyboardMapping: x11.func('int XChangeKeyboardMapping(void *dpy, int first, int perKeycode, unsigned long *keysyms, int count)'),
        free: x11.func('int XFree(void *ptr)'),
        sync: x11.func('int XSync(void *dpy, int discard)'),
        fakeKeyEvent: xtst.func('int XTestFakeKeyEvent(void *dpy, uint keycode, int press, unsigned long delay)'),
        decodeKeysyms: (ptr, count) => koffi.decode(ptr, 'unsigned long', count) as number[],
    } as XLib;
}

/** Map a Unicode code point to its X keysym. */
export function keysymForCodePoint(cp: number): number {
    if (cp === 0x0a || cp === 0x0d) return XK_RETURN;
    if (cp === 0x09) return XK_TAB;
    if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
    return 0x01000000 + cp;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Type text into the focused X11 window. Throws if libX11/libXtst or the display are unavailable. */
export async function typeViaXTest(text: string): Promise<void> {
    xlib ??= loadXLib();
    const x = await xlib.catch(err => { xlib = undefined; throw err; });

    const dpy = x.open(null);
    if (!dpy) throw new Error('Cannot open X display');

    try {
        const state: Record<string, number> = {};
        x.getState(dpy, XKB_USE_CORE_KBD, state);
        const group = state.group ?? 0;
        const capsLock = ((state.locked_mods ?? 0) & LOCK_MASK) !== 0;

        const min = [0], max = [0];
        x.displayKeycodes(dpy, min, max);

        // keysym → [keycode, needs shift] for levels 1–2 of the active group
        const direct = new Map<number, [number, boolean]>();
        for (let kc = min[0]; kc <= max[0]; kc++) {
            for (const level of [0, 1]) {
                const ks = x.keycodeToKeysym(dpy, kc, group, level);
                if (ks && !direct.has(ks)) direct.set(ks, [kc, level === 1]);
            }
        }

        const shift = x.keysymToKeycode(dpy, XK_SHIFT_L);
        const tap = (kc: number, withShift: boolean) => {
            if (withShift && shift) x.fakeKeyEvent(dpy, shift, 1, 0);
            x.fakeKeyEvent(dpy, kc, 1, 0);
            x.fakeKeyEvent(dpy, kc, 0, 0);
            if (withShift && shift) x.fakeKeyEvent(dpy, shift, 0, 0);
            x.sync(dpy, 0);
        };

        let scratch: ScratchKey | undefined;
        try {
            for (const ch of text.replace(/\r\n/g, '\n')) {
                const cp = ch.codePointAt(0)!;
                const keysym = keysymForCodePoint(cp);
                const hit = direct.get(keysym);
                if (hit) {
                    // Caps Lock inverts Shift on letter keys
                    const isLetter = ch.toLowerCase() !== ch.toUpperCase();
                    tap(hit[0], capsLock && isLetter ? !hit[1] : hit[1]);
                    continue;
                }

                scratch ??= findScratchKeycode(x, dpy, min[0], max[0]);
                x.changeKeyboardMapping(dpy, scratch.keycode, 2, [keysym, keysym], 1);
                x.sync(dpy, 0);
                await sleep(REMAP_SETTLE_MS);
                tap(scratch.keycode, false);
                await sleep(REMAP_SETTLE_MS);
            }
        } finally {
            if (scratch) {
                x.changeKeyboardMapping(dpy, scratch.keycode, scratch.original.length, scratch.original, 1);
                x.sync(dpy, 0);
            }
        }
    } finally {
        x.close(dpy);
    }
}

interface ScratchKey { keycode: number; original: number[] }

/** Pick a keycode to remap: an unused one if possible, otherwise borrow the highest (restored afterwards). */
function findScratchKeycode(x: XLib, dpy: unknown, min: number, max: number): ScratchKey {
    const count = max - min + 1;
    const perKeycode = [0];
    const ptr = x.getKeyboardMapping(dpy, min, count, perKeycode);
    if (!ptr) throw new Error('Cannot read keyboard mapping');
    try {
        const n = perKeycode[0];
        const syms = x.decodeKeysyms(ptr, count * n);
        const symsOf = (i: number) => syms.slice(i * n, (i + 1) * n);
        // Search from the top: high keycodes are the least likely to be in use
        for (let i = count - 1; i >= 0; i--) {
            const original = symsOf(i);
            if (original.every(s => s === 0)) return { keycode: min + i, original };
        }
        return { keycode: max, original: symsOf(count - 1) };
    } finally {
        x.free(ptr);
    }
}
