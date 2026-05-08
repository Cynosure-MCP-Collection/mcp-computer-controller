#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { exec, execFile } from 'node:child_process';
import { platform, homedir, tmpdir } from 'node:os';
import robot from '@hurdlegroup/robotjs';
import { PNG } from 'pngjs';
import { getScaleInfo, scaleScreenshot, agentToScreen as _agentToScreen, screenToAgent as _screenToAgent, validateCoords, overrideScaleInfo, scaleBufferForDisplay, GEMINI_MODE } from './scaling.js';

// ══════════════════════════════════════════════════════════════════════════════
// Display restriction
// ══════════════════════════════════════════════════════════════════════════════

/**
 * DISPLAY_INDEX env var convention:
 *   0 (or unset) = all displays accessible
 *   1            = primary display only (internal index 0)
 *   2            = second display only  (internal index 1)
 *   N            = Nth display          (internal index N-1)
 */
const RESTRICTED_DISPLAY: number | undefined = (() => {
    if (process.env.DISPLAY_INDEX === undefined) return undefined;
    const idx = parseInt(process.env.DISPLAY_INDEX, 10);
    return idx === 0 ? undefined : idx - 1;
})();

/** Resolve which display to use: restricted env var takes priority, then explicit param, then undefined (primary). */
function resolveDisplay(requested?: number): number | undefined {
    if (RESTRICTED_DISPLAY !== undefined) return RESTRICTED_DISPLAY;
    return requested;
}

// ── Display-local coordinate helpers ────────────────────────────────────────

/**
 * Top-left pixel offset of the currently active display in virtual desktop space.
 * Set by get_screenshot whenever a specific display is captured. Null = full desktop mode.
 */
let restrictedDisplayOffset: { x: number; y: number } | null = null;

/** Convert agent-space → physical screen coordinates, applying the active display offset. */
function agentToScreen(ax: number, ay: number): { px: number; py: number } {
    const result = _agentToScreen(ax, ay);
    return restrictedDisplayOffset
        ? { px: result.px + restrictedDisplayOffset.x, py: result.py + restrictedDisplayOffset.y }
        : result;
}

/** Convert physical screen coordinates → agent-space, removing the active display offset. */
function screenToAgent(px: number, py: number): { ax: number; ay: number } {
    return restrictedDisplayOffset
        ? _screenToAgent(px - restrictedDisplayOffset.x, py - restrictedDisplayOffset.y)
        : _screenToAgent(px, py);
}

/** Read PNG width/height from the IHDR chunk without decoding pixel data. */
function getPngDimensions(buf: Buffer): { width: number; height: number } {
    // PNG layout: 8-byte signature + 4=chunk-len + 4="IHDR" + 4=width(BE) + 4=height(BE)
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// ══════════════════════════════════════════════════════════════════════════════
// Application Launcher
// ══════════════════════════════════════════════════════════════════════════════

interface AppEntry {
    name: string;
    exec: string;
    icon?: string;
    comment?: string;
    categories?: string[];
    source: string;
}

let cachedApps: AppEntry[] | null = null;

async function indexApplications(forceRefresh = false): Promise<AppEntry[]> {
    if (cachedApps && !forceRefresh) return cachedApps;

    const os = platform();
    if (os === 'linux') {
        cachedApps = await indexLinuxApps();
    } else if (os === 'win32') {
        cachedApps = await indexWindowsApps();
    } else {
        cachedApps = [];
    }

    cachedApps.sort((a, b) => a.name.localeCompare(b.name));
    return cachedApps;
}

// ── Linux .desktop file scanning ────────────────────────────────────────────

function getLinuxDesktopDirs(): string[] {
    const dirs = [
        '/usr/share/applications',
        '/usr/local/share/applications',
        path.join(homedir(), '.local', 'share', 'applications'),
    ];
    const xdgDataDirs = process.env.XDG_DATA_DIRS;
    if (xdgDataDirs) {
        for (const dir of xdgDataDirs.split(':')) {
            const appDir = path.join(dir, 'applications');
            if (!dirs.includes(appDir)) dirs.push(appDir);
        }
    }
    return dirs;
}

function parseDesktopFile(content: string, filePath: string): AppEntry | null {
    const lines = content.split('\n');
    let inDesktopEntry = false;
    const fields: Record<string, string> = {};

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '[Desktop Entry]') { inDesktopEntry = true; continue; }
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            if (inDesktopEntry) break;
            continue;
        }
        if (!inDesktopEntry) continue;

        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!key.includes('[')) fields[key] = value;
    }

    if (fields['Type'] !== 'Application') return null;
    if (fields['NoDisplay'] === 'true' || fields['Hidden'] === 'true') return null;
    if (!fields['Name'] || !fields['Exec']) return null;

    const execClean = fields['Exec'].replace(/%[fFuUdDnNickvm]/g, '').trim();

    return {
        name: fields['Name'],
        exec: execClean,
        icon: fields['Icon'] || undefined,
        comment: fields['Comment'] || undefined,
        categories: fields['Categories'] ? fields['Categories'].split(';').filter(Boolean) : undefined,
        source: filePath,
    };
}

async function indexLinuxApps(): Promise<AppEntry[]> {
    const dirs = getLinuxDesktopDirs();
    const apps: AppEntry[] = [];
    const seen = new Set<string>();

    for (const dir of dirs) {
        let entries: string[];
        try { entries = await fs.readdir(dir); } catch { continue; }

        for (const entry of entries) {
            if (!entry.endsWith('.desktop')) continue;
            const filePath = path.join(dir, entry);
            try {
                const content = await fs.readFile(filePath, 'utf-8');
                const app = parseDesktopFile(content, filePath);
                if (app && !seen.has(app.name.toLowerCase())) {
                    seen.add(app.name.toLowerCase());
                    apps.push(app);
                }
            } catch { /* skip unreadable */ }
        }
    }
    return apps;
}

// ── Windows Start Menu scanning ─────────────────────────────────────────────

async function indexWindowsApps(): Promise<AppEntry[]> {
    const apps: AppEntry[] = [];
    const seen = new Set<string>();
    const startMenuDirs = [
        path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        path.join(process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    ];
    for (const dir of startMenuDirs) {
        await scanWindowsDir(dir, apps, seen);
    }
    return apps;
}

async function scanWindowsDir(dir: string, apps: AppEntry[], seen: Set<string>): Promise<void> {
    let entries: string[];
    try { entries = await fs.readdir(dir); } catch { return; }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        try {
            const stat = await fs.stat(fullPath);
            if (stat.isDirectory()) {
                await scanWindowsDir(fullPath, apps, seen);
            } else if (entry.endsWith('.lnk') || entry.endsWith('.url')) {
                const name = path.basename(entry, path.extname(entry));
                const key = name.toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    apps.push({ name, exec: fullPath, source: fullPath });
                }
            }
        } catch { /* skip */ }
    }
}

// ── Launch helper ───────────────────────────────────────────────────────────

function launchApp(execCmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const os = platform();
        let command: string;

        if (os === 'linux') {
            command = `setsid ${execCmd} &>/dev/null &`;
        } else if (os === 'win32') {
            command = `start "" "${execCmd}"`;
        } else {
            command = execCmd;
        }

        exec(command, { timeout: 10_000 }, (error) => {
            if (error) {
                if (os === 'linux' && error.killed === false) {
                    resolve('launched');
                    return;
                }
                reject(error);
            } else {
                resolve('launched');
            }
        });
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// Screenshot capture
// ══════════════════════════════════════════════════════════════════════════════

/** Convert robotjs BGRA bitmap to PNG buffer */
function bitmapToPng(bitmap: { image: Buffer; width: number; height: number }): Buffer {
    const { width, height, image: bgra } = bitmap;
    const png = new PNG({ width, height });

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const srcIdx = (y * width + x) * 4;
            const dstIdx = (y * width + x) * 4;
            png.data[dstIdx + 0] = bgra[srcIdx + 2]; // R (from B)
            png.data[dstIdx + 1] = bgra[srcIdx + 1]; // G
            png.data[dstIdx + 2] = bgra[srcIdx + 0]; // B (from R)
            png.data[dstIdx + 3] = 255;               // A
        }
    }

    return PNG.sync.write(png);
}

/** Primary: capture screenshot using robotjs (no external tools needed) */
function captureWithRobotjs(): Buffer {
    const size = robot.getScreenSize();
    const bitmap = robot.screen.capture(0, 0, size.width, size.height);
    return bitmapToPng(bitmap);
}

/** Fallback: try platform-specific tools (may produce higher quality / multi-monitor) */
function captureWithExternalTools(display?: number): Promise<Buffer> {
    const os = platform();
    if (os === 'linux') return captureLinux(display);
    if (os === 'win32') return captureWindows(display);
    if (os === 'darwin') return captureMac(display);
    return Promise.reject(new Error(`Unsupported platform: ${os}`));
}

/** Capture screenshot: try external tools first (multi-monitor), fall back to robotjs.
 *  When display is specified and robotjs fallback is used, the result is cropped
 *  to that display's region using geometry from xrandr / swaymsg / hyprctl.
 */
async function captureScreenshot(display?: number): Promise<Buffer> {
    try {
        return await captureWithExternalTools(display);
    } catch {
        // External tools unavailable — robotjs always captures the full virtual desktop.
        // Crop to the requested display's bounds when a specific display is requested.
        const fullBuf = captureWithRobotjs();
        if (display !== undefined && platform() === 'linux') {
            const displays = await getLinuxDisplayGeometries();
            const geom = displays[display];
            if (geom) {
                return cropPng(fullBuf, geom.x, geom.y, geom.width, geom.height);
            }
        }
        return fullBuf;
    }
}

function captureLinux(display?: number): Promise<Buffer> {
    const tmpFile = path.join(tmpdir(), `mcp-screenshot-${Date.now()}.png`);
    return new Promise((resolve, reject) => {
        (async () => {
            // Resolve display geometry + output name from numeric index.
            // On Wayland, grim needs the output NAME (e.g. "HDMI-1"), not a numeric index.
            // On GNOME Wayland, xrandr (via XWayland) provides the geometry for cropping.
            let geom: DisplayGeometry | undefined;
            let outputName: string | undefined;
            if (display !== undefined) {
                const displays = await getLinuxDisplayGeometries();
                if (displays.length > display) {
                    geom = displays[display];
                    outputName = displays[display].name;
                }
            }

            // ── grim (Wayland native) ────────────────────────────────────────
            // Use resolved output name; if no name was resolved, capture all outputs.
            try {
                const grimArgs = outputName ? ['-o', outputName, tmpFile] : [tmpFile];
                await execFilePromise('grim', grimArgs);
                // grim with -o already captures a single output — no cropping needed.
                return readAndCleanup(tmpFile, resolve, reject);
            } catch { /* grim not available or failed */ }

            // ── Fallback tools: capture all displays, then crop ──────────────
            // None of these tools support per-display selection reliably on Wayland,
            // so we capture the full desktop and crop to the requested display bounds.
            const captureAll = async (): Promise<void> => {
                try { await execFilePromise('gnome-screenshot', ['--file', tmpFile]); return; } catch { /* next */ }
                try { await execFilePromise('scrot', [tmpFile]); return; } catch { /* next */ }
                try { await execFilePromise('import', ['-window', 'root', tmpFile]); return; } catch { /* next */ }
                throw new Error('No screenshot tool found. Install one of: grim (Wayland), gnome-screenshot, scrot, or imagemagick.');
            };

            await captureAll();

            // Crop to specific display if we know its geometry
            if (geom) {
                try {
                    const fullBuf = await fs.readFile(tmpFile);
                    fs.unlink(tmpFile).catch(() => { });
                    resolve(cropPng(fullBuf, geom.x, geom.y, geom.width, geom.height));
                    return;
                } catch { /* fall through and return full screenshot */ }
            }

            readAndCleanup(tmpFile, resolve, reject);
        })().catch(reject);
    });
}

function captureWindows(display?: number): Promise<Buffer> {
    const tmpFile = path.join(tmpdir(), `mcp-screenshot-${Date.now()}.png`);
    const displayIdx = display ?? 0;
    const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screens = [System.Windows.Forms.Screen]::AllScreens
$idx = ${displayIdx}
if ($idx -ge $screens.Length) { $idx = 0 }
$screen = $screens[$idx]
$bounds = $screen.Bounds
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bitmap.Save('${tmpFile.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`.trim();

    return new Promise((resolve, reject) => {
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], { timeout: 15_000 }, (err) => {
            if (err) { reject(new Error(`Screenshot capture failed: ${err.message}`)); return; }
            readAndCleanup(tmpFile, resolve, reject);
        });
    });
}

function captureMac(display?: number): Promise<Buffer> {
    const tmpFile = path.join(tmpdir(), `mcp-screenshot-${Date.now()}.png`);
    const args = display !== undefined ? ['-D', String(display), tmpFile] : [tmpFile];
    return new Promise((resolve, reject) => {
        execFile('screencapture', args, { timeout: 15_000 }, (err) => {
            if (err) { reject(new Error(`screencapture failed: ${err.message}`)); return; }
            readAndCleanup(tmpFile, resolve, reject);
        });
    });
}

/** Promise wrapper for execFile */
function execFilePromise(cmd: string, args: string[], timeoutMs = 8_000): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
            if (err) reject(err); else resolve(stdout);
        });
    });
}

interface DisplayGeometry { name: string; x: number; y: number; width: number; height: number; isPrimary: boolean; }

let _displayGeomCache: { time: number; data: DisplayGeometry[] } | null = null;
const DISPLAY_GEOM_CACHE_TTL_MS = 30_000;

/**
 * Get per-display geometry sorted so that index 0 = primary display.
 * Tries xrandr (works on X11 and GNOME Wayland via XWayland), then swaymsg, then hyprctl.
 * Results are cached for 30 s to avoid redundant system calls.
 */
async function getLinuxDisplayGeometries(): Promise<DisplayGeometry[]> {
    const now = Date.now();
    if (_displayGeomCache && now - _displayGeomCache.time < DISPLAY_GEOM_CACHE_TTL_MS) {
        return _displayGeomCache.data;
    }

    // xrandr: works on X11 and GNOME Wayland (via XWayland)
    // Line format: "HDMI-1 connected primary 1920x1080+0+0 ..."
    try {
        const stdout = await execFilePromise('xrandr', ['--query']);
        const displays: DisplayGeometry[] = [];
        for (const line of stdout.split('\n')) {
            // Capture the optional "primary" word so we can mark it
            const m = /^(\S+)\s+connected\s+(primary\s+)?(\d+)x(\d+)\+(\d+)\+(\d+)/.exec(line);
            if (m) displays.push({ name: m[1], isPrimary: !!m[2]?.trim(), width: +m[3], height: +m[4], x: +m[5], y: +m[6] });
        }
        if (displays.length > 0) {
            // Ensure the display marked "primary" is always at index 0
            displays.sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0));
            _displayGeomCache = { time: now, data: displays };
            return displays;
        }
    } catch { /* xrandr not available */ }

    // swaymsg: Sway / wlroots compositors
    try {
        const stdout = await execFilePromise('swaymsg', ['-t', 'get_outputs']);
        const result: DisplayGeometry[] = (JSON.parse(stdout) as any[])
            .filter(o => o.active)
            .map(o => ({
                name: o.name as string,
                isPrimary: !!(o.primary),
                x: (o.rect?.x ?? 0) as number,
                y: (o.rect?.y ?? 0) as number,
                width: (o.current_mode?.width ?? o.rect?.width ?? 0) as number,
                height: (o.current_mode?.height ?? o.rect?.height ?? 0) as number,
            }));
        if (result.length > 0) {
            result.sort((a, b) => (b.isPrimary ? 1 : 0) - (a.isPrimary ? 1 : 0));
            _displayGeomCache = { time: now, data: result };
            return result;
        }
    } catch { /* swaymsg not available */ }

    // hyprctl: Hyprland (no explicit primary flag — use array order)
    try {
        const stdout = await execFilePromise('hyprctl', ['monitors', '-j']);
        const result: DisplayGeometry[] = (JSON.parse(stdout) as any[]).map((m, idx) => ({
            name: m.name as string,
            isPrimary: idx === 0,
            x: (m.x ?? 0) as number,
            y: (m.y ?? 0) as number,
            width: (m.width ?? 0) as number,
            height: (m.height ?? 0) as number,
        }));
        if (result.length > 0) {
            _displayGeomCache = { time: now, data: result };
            return result;
        }
    } catch { /* hyprctl not available */ }

    return [];
}

/** Crop a PNG buffer to the given rectangle. */
function cropPng(buf: Buffer, x: number, y: number, w: number, h: number): Buffer {
    const src = PNG.sync.read(buf);
    // Clamp to source bounds
    const cx = Math.max(0, x), cy = Math.max(0, y);
    const cw = Math.min(w, src.width - cx), ch = Math.min(h, src.height - cy);
    const dst = new PNG({ width: cw, height: ch });
    for (let row = 0; row < ch; row++) {
        const srcOff = ((cy + row) * src.width + cx) * 4;
        src.data.copy(dst.data, row * cw * 4, srcOff, srcOff + cw * 4);
    }
    return PNG.sync.write(dst);
}

async function readAndCleanup(filePath: string, resolve: (buf: Buffer) => void, reject: (err: Error) => void): Promise<void> {
    try {
        const data = await fs.readFile(filePath);
        fs.unlink(filePath).catch(() => { });
        resolve(data);
    } catch (err) {
        reject(new Error(`Failed to read screenshot file: ${(err as Error).message}`));
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MCP Server — Tool registration
// ══════════════════════════════════════════════════════════════════════════════

const server = new McpServer({
    name: 'Computer Controller',
    version: '1.0.0',
    title: 'Computer Controller',
    description: 'Desktop automation: launch apps, capture screenshots, control mouse and keyboard.',
    icons: [{ src: 'https://raw.githubusercontent.com/andreasjhagen/Cynosure-MCPs/main/mcp-computer-controller/icon.png', mimeType: 'image/png' }],
});

// ── App launcher tools ──────────────────────────────────────────────────────

server.registerTool(
    'list_applications',
    {
        description: 'List installed applications on the computer. Optionally filter by a search query. Use refresh=true to re-scan.',
        inputSchema: {
            query: z.string().optional().describe('Search filter — matches against app name, comment, or categories'),
            refresh: z.boolean().optional().describe('Force re-index of applications (default: false)'),
        },
    },
    async ({ query, refresh }) => {
        try {
            const apps = await indexApplications(refresh ?? false);
            let results = apps;
            if (query) {
                const q = query.toLowerCase();
                results = apps.filter(
                    (app) =>
                        app.name.toLowerCase().includes(q) ||
                        (app.comment && app.comment.toLowerCase().includes(q)) ||
                        (app.categories && app.categories.some((c) => c.toLowerCase().includes(q)))
                );
            }
            if (results.length === 0) {
                return { content: [{ type: 'text' as const, text: query ? `No applications found matching "${query}".` : 'No applications found on this system.' }] };
            }
            const formatted = results.map((app) => {
                let line = `• ${app.name}`;
                if (app.comment) line += ` — ${app.comment}`;
                if (app.categories?.length) line += ` [${app.categories.join(', ')}]`;
                return line;
            });
            return { content: [{ type: 'text' as const, text: `Found ${results.length} application${results.length !== 1 ? 's' : ''}:\n\n${formatted.join('\n')}` }] };
        } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error listing applications: ${(err as Error).message}` }], isError: true };
        }
    },
);

server.registerTool(
    'launch_application',
    {
        description: 'Launch an installed application by name. The name must match an indexed application (case-insensitive, supports partial matching).',
        inputSchema: {
            name: z.string().describe('The name of the application to launch'),
        },
    },
    async ({ name }) => {
        try {
            const apps = await indexApplications();
            const match = apps.find((app) => app.name.toLowerCase() === name.toLowerCase());

            if (!match) {
                const partials = apps.filter((app) => app.name.toLowerCase().includes(name.toLowerCase()));
                if (partials.length === 1) {
                    await launchApp(partials[0].exec);
                    return { content: [{ type: 'text' as const, text: `Launched "${partials[0].name}".` }] };
                }
                if (partials.length > 1) {
                    const names = partials.map((a) => `  • ${a.name}`).join('\n');
                    return { content: [{ type: 'text' as const, text: `Multiple applications match "${name}". Please be more specific:\n${names}` }] };
                }
                return { content: [{ type: 'text' as const, text: `Application "${name}" not found. Use list_applications to see available apps.` }], isError: true };
            }

            await launchApp(match.exec);
            return { content: [{ type: 'text' as const, text: `Launched "${match.name}".` }] };
        } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error launching application: ${(err as Error).message}` }], isError: true };
        }
    },
);

// ── Display enumeration ─────────────────────────────────────────────────────

function getDisplayCount(): Promise<number> {
    const os = platform();
    return new Promise((resolve) => {
        if (os === 'linux') {
            exec('xrandr --listmonitors 2>/dev/null | head -1', (err, stdout) => {
                if (!err && stdout) {
                    const match = stdout.match(/Monitors:\s*(\d+)/);
                    if (match) { resolve(parseInt(match[1], 10)); return; }
                }
                // fallback: try wlr-randr for Wayland
                exec('wlr-randr 2>/dev/null | grep -c "^[^ ]"', (err2, stdout2) => {
                    if (!err2 && stdout2.trim()) { resolve(parseInt(stdout2.trim(), 10) || 1); return; }
                    resolve(1);
                });
            });
        } else if (os === 'win32') {
            exec('powershell -NoProfile -Command "[System.Windows.Forms.Screen]::AllScreens.Length"', (err, stdout) => {
                if (!err && stdout.trim()) { resolve(parseInt(stdout.trim(), 10) || 1); return; }
                resolve(1);
            });
        } else if (os === 'darwin') {
            exec('system_profiler SPDisplaysDataType 2>/dev/null | grep -c "Resolution:"', (err, stdout) => {
                if (!err && stdout.trim()) { resolve(parseInt(stdout.trim(), 10) || 1); return; }
                resolve(1);
            });
        } else {
            resolve(1);
        }
    });
}

// ── Screenshot tool ─────────────────────────────────────────────────────────

/** Draw a crosshair on a PNG buffer at the given (x, y) position to show cursor location */
function drawCursorCrosshair(pngBuf: Buffer, cx: number, cy: number): Buffer {
    const png = PNG.sync.read(pngBuf);
    const { width, height } = png;

    // Clamp to image bounds
    cx = Math.max(0, Math.min(cx, width - 1));
    cy = Math.max(0, Math.min(cy, height - 1));

    const armLen = 12;      // pixels each arm extends from center
    const gap = 3;          // gap around center point
    const thickness = 1;    // line thickness (1 = single pixel)

    // Draw colour: bright red with full opacity, plus a 1px black outline
    const colors = [
        { r: 0, g: 0, b: 0, offset: 1 },       // black outline
        { r: 255, g: 50, b: 50, offset: 0 },    // red crosshair
    ];

    function setPixel(x: number, y: number, r: number, g: number, b: number): void {
        if (x < 0 || x >= width || y < 0 || y >= height) return;
        const idx = (y * width + x) * 4;
        png.data[idx] = r;
        png.data[idx + 1] = g;
        png.data[idx + 2] = b;
        png.data[idx + 3] = 255;
    }

    for (const { r, g, b, offset } of colors) {
        // Horizontal arms
        for (let dx = gap; dx <= armLen; dx++) {
            for (let t = -offset; t <= offset; t++) {
                setPixel(cx + dx, cy + t, r, g, b);
                setPixel(cx - dx, cy + t, r, g, b);
            }
        }
        // Vertical arms
        for (let dy = gap; dy <= armLen; dy++) {
            for (let t = -offset; t <= offset; t++) {
                setPixel(cx + t, cy + dy, r, g, b);
                setPixel(cx + t, cy - dy, r, g, b);
            }
        }
        // Center dot
        setPixel(cx, cy, r, g, b);
    }

    return PNG.sync.write(png);
}

server.registerTool(
    'get_screenshot',
    {
        description:
            'Capture a screenshot of the desktop. Call this after every action to verify the result before proceeding. ' +
            'The screenshot is scaled to agent display resolution. All click/mouse coordinates must be in this agent display space.',
        inputSchema: {
            display: z.number().int().min(0).optional().describe('Display/monitor number (0-indexed). Omit for the primary display.'),
            delay_ms: z.number().int().min(0).max(5000).default(2000)
                .describe('Wait this many ms before capturing (default 2000). Pass 0 for an immediate snapshot before taking an action.'),
        },
    },
    async ({ display, delay_ms }) => {
        try {
            const effectiveDisplay = resolveDisplay(display);
            if (delay_ms > 0) await new Promise(r => setTimeout(r, delay_ms));
            const rawBuf = await captureScreenshot(effectiveDisplay);

            // Scale to agent space.
            // When a specific display is targeted we use per-display scale so that:
            //   • The image fills a proper agent resolution (e.g. 1280×720 for a 1920×1080 display)
            //   • Reported coordinate bounds match the image dimensions
            //   • agentToScreen() correctly maps back to virtual-desktop coordinates
            let scaledBuf: Buffer;
            let info: ReturnType<typeof getScaleInfo>;
            if (effectiveDisplay !== undefined) {
                const dims = getPngDimensions(rawBuf); // O(1): reads PNG IHDR header only
                const scaled = await scaleBufferForDisplay(rawBuf, dims.width, dims.height);
                scaledBuf = scaled.buf;
                info = scaled.info;
                overrideScaleInfo(info); // keep validateCoords and all coordinate helpers in sync

                // Determine display offset for virtual-desktop coordinate translation
                const displayGeoms = await getLinuxDisplayGeometries();
                const geom = displayGeoms[effectiveDisplay];
                restrictedDisplayOffset = geom ? { x: geom.x, y: geom.y } : { x: 0, y: 0 };
            } else {
                scaledBuf = await scaleScreenshot(rawBuf);
                info = getScaleInfo();
                overrideScaleInfo(null); // revert to global full-desktop scale
                restrictedDisplayOffset = null;
            }

            // Get current mouse position and draw crosshair on screenshot
            const mousePos = robot.getMousePos();
            const { ax: mouseX, ay: mouseY } = screenToAgent(mousePos.x, mousePos.y);
            const annotatedBuf = drawCursorCrosshair(scaledBuf, mouseX, mouseY);

            const base64 = annotatedBuf.toString('base64');
            return {
                content: [
                    { type: 'image' as const, data: base64, mimeType: 'image/png' },
                    {
                        type: 'text' as const,
                        text: `Display: ${info.agentWidth}×${info.contentHeight} (agent space). ` +
                            `Screen: ${info.screenWidth}×${info.screenHeight}. ` +
                            `Mouse cursor: (${mouseX}, ${mouseY}). ` +
                            `Use coordinates within [0, ${info.agentWidth}] × [0, ${info.contentHeight}].`
                    },
                ]
            };
        } catch (err) {
            const displayCount = await getDisplayCount();
            const hint = displayCount > 1
                ? ` This system has ${displayCount} displays (valid indices: 0-${displayCount - 1}).`
                : ` Only 1 display detected on this system.`;
            return { content: [{ type: 'text' as const, text: `Error capturing screenshot: ${(err as Error).message}${hint}` }], isError: true };
        }
    },
);

// ── Shared helpers ─────────────────────────────────────────────────────────

/** Time (ms) to let moveMouseSmooth finish before clicking. */
const MOUSE_SETTLE_MS = 80;

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

/** Type text by copying to clipboard and pasting — works with any keyboard layout. */
async function typeViaClipboard(text: string): Promise<void> {
    const os = platform();

    if (os === 'linux') {
        // Try xdotool first (types directly, respects keyboard layout, no clipboard needed)
        try {
            await runCmdInput(text, 'xdotool type --delay 0 --clearmodifiers --file -');
            return;
        } catch { /* xdotool not available */ }

        // Try clipboard tools: xclip → xsel → wl-copy
        const clipboardTools = [
            { copy: 'xclip -selection clipboard', paste: 'xclip -selection clipboard -o' },
            { copy: 'xsel --clipboard --input', paste: 'xsel --clipboard --output' },
            { copy: 'wl-copy', paste: 'wl-paste' },
        ];

        for (const tool of clipboardTools) {
            try {
                const saved = await runCmd(`${tool.paste} 2>/dev/null || true`).catch(() => null);
                await runCmdInput(text, tool.copy);
                await sleep(50);
                robot.keyTap('v', ['control']);
                await sleep(50);
                if (saved) await runCmdInput(saved, tool.copy).catch(() => { });
                return;
            } catch { /* try next tool */ }
        }

        // Final fallback
        robot.typeString(text);
    } else if (os === 'darwin') {
        const saved = await runCmd('pbpaste').catch(() => null);
        await runCmdInput(text, 'pbcopy');
        await sleep(50);
        robot.keyTap('v', ['command']);
        await sleep(50);
        if (saved) await runCmdInput(saved, 'pbcopy').catch(() => { });
    } else if (os === 'win32') {
        const saved = await runCmd('powershell -command "Get-Clipboard"').catch(() => null);
        await runCmdInput(text, 'powershell -command "$input | Set-Clipboard"');
        await sleep(50);
        robot.keyTap('v', ['control']);
        await sleep(50);
        if (saved) await runCmdInput(saved, 'powershell -command "$input | Set-Clipboard"').catch(() => { });
    } else {
        robot.typeString(text);
    }
}

function runCmd(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 5000 }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
        });
    });
}

function runCmdInput(input: string, cmd: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = exec(cmd, { timeout: 5000 }, (err) => {
            if (err) reject(err);
            else resolve();
        });
        child.stdin?.write(input);
        child.stdin?.end();
    });
}

// ── Mouse control tools ─────────────────────────────────────────────────────

server.registerTool(
    'move_mouse',
    {
        description:
            'Move the mouse cursor to a position in agent display space (coordinates from the most recent screenshot). ' +
            'After moving, take a screenshot to verify. Use smooth=true for a human-like gliding motion.',
        inputSchema: {
            x: z.number().int().describe('X coordinate in agent display space'),
            y: z.number().int().describe('Y coordinate in agent display space'),
            smooth: z.boolean().default(true).describe('Use smooth/humanized movement (default: true)'),
        },
    },
    async ({ x, y, smooth }) => {
        const err = validateCoords(x, y);
        if (err) return { content: [{ type: 'text' as const, text: err }], isError: true };
        try {
            const { px, py } = agentToScreen(x, y);
            if (smooth) {
                robot.moveMouseSmooth(px, py);
            } else {
                robot.moveMouse(px, py);
            }
            await sleep(MOUSE_SETTLE_MS); // let the move complete before returning
            return { content: [{ type: 'text' as const, text: `Mouse moved to (${x}, ${y})${smooth ? ' smoothly' : ''}.` }] };
        } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error moving mouse: ${(err as Error).message}` }], isError: true };
        }
    },
);

server.registerTool(
    'click_mouse',
    {
        description:
            'Click a mouse button at the current cursor position. ' +
            'Use move_mouse first to position the cursor, then get_cursor_area to verify placement, then click. ' +
            'Workflow: move_mouse → get_cursor_area → (refine if needed) → click_mouse.',
        inputSchema: {
            button: z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button to click'),
        },
    },
    async ({ button }) => {
        try {
            const pos = robot.getMousePos();
            robot.mouseClick(button);
            const { ax, ay } = screenToAgent(pos.x, pos.y);
            return { content: [{ type: 'text' as const, text: `${button} clicked at (${ax}, ${ay}).` }] };
        } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error clicking: ${(err as Error).message}` }], isError: true };
        }
    },
);

server.registerTool(
    'double_click',
    {
        description:
            'Double-click at the current cursor position. ' +
            'Use move_mouse first to position the cursor, then get_cursor_area to verify, then double_click.',
        inputSchema: {},
    },
    async () => {
        try {
            const pos = robot.getMousePos();
            robot.mouseClick('left', true);
            const { ax, ay } = screenToAgent(pos.x, pos.y);
            return { content: [{ type: 'text' as const, text: `Double-clicked at (${ax}, ${ay}).` }] };
        } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error double-clicking: ${(err as Error).message}` }], isError: true };
        }
    },
);

server.registerTool(
    'drag_mouse',
    {
        description:
            'Click and drag from one position to another in agent display space. ' +
            'Useful for selecting text, moving windows, or drag-and-drop operations. ' +
            'After dragging, take a screenshot to verify the result.',
        inputSchema: {
            startX: z.number().int().describe('Start X in agent display space'),
            startY: z.number().int().describe('Start Y in agent display space'),
            endX: z.number().int().describe('End X in agent display space'),
            endY: z.number().int().describe('End Y in agent display space'),
        },
    },
    async ({ startX, startY, endX, endY }) => {
        const startErr = validateCoords(startX, startY);
        if (startErr) return { content: [{ type: 'text' as const, text: `Start ${startErr}` }], isError: true };
        const endErr = validateCoords(endX, endY);
        if (endErr) return { content: [{ type: 'text' as const, text: `End ${endErr}` }], isError: true };
        try {
            const start = agentToScreen(startX, startY);
            const end = agentToScreen(endX, endY);
            robot.moveMouseSmooth(start.px, start.py);
            await sleep(MOUSE_SETTLE_MS); // wait for move to complete before pressing down
            robot.mouseToggle('down', 'left');
            robot.moveMouseSmooth(end.px, end.py);
            await sleep(MOUSE_SETTLE_MS); // wait for drag move to complete before releasing
            robot.mouseToggle('up', 'left');
            return { content: [{ type: 'text' as const, text: `Dragged (${startX}, ${startY}) → (${endX}, ${endY}).` }] };
        } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error dragging: ${(err as Error).message}` }], isError: true };
        }
    },
);

server.registerTool(
    'scroll_mouse',
    {
        description:
            'Scroll the mouse wheel at the current position or at specific coordinates. ' +
            'Positive values scroll down/right, negative scroll up/left. ' +
            'After scrolling, take a screenshot to verify.',
        inputSchema: {
            y: z.number().int().default(0).describe('Vertical scroll amount (positive = down, negative = up)'),
            x: z.number().int().default(0).describe('Horizontal scroll amount (positive = right, negative = left)'),
            atX: z.number().int().optional().describe('Optional X in agent display space to move to before scrolling'),
            atY: z.number().int().optional().describe('Optional Y in agent display space to move to before scrolling'),
        },
    },
    async ({ x, y, atX, atY }) => {
        try {
            if (atX !== undefined && atY !== undefined) {
                const coordErr = validateCoords(atX, atY);
                if (coordErr) return { content: [{ type: 'text' as const, text: coordErr }], isError: true };
                const { px, py } = agentToScreen(atX, atY);
                robot.moveMouseSmooth(px, py);
            }
            robot.scrollMouse(x, y);
            return { content: [{ type: 'text' as const, text: `Scrolled (x: ${x}, y: ${y})${atX !== undefined ? ` at (${atX}, ${atY})` : ''}.` }] };
        } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error scrolling: ${(err as Error).message}` }], isError: true };
        }
    },
);

server.registerTool(
    'get_mouse_position',
    {
        description: 'Get the current mouse cursor position in agent display space.',
    },
    async () => {
        try {
            const pos = robot.getMousePos();
            const { ax, ay } = screenToAgent(pos.x, pos.y);
            return { content: [{ type: 'text' as const, text: `Mouse position: (${ax}, ${ay}) in agent display space.` }] };
        } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error getting mouse position: ${(err as Error).message}` }], isError: true };
        }
    },
);

// ── Keyboard control tools ──────────────────────────────────────────────────

server.registerTool(
    'type_text',
    {
        description:
            'Inserts a string of text at the current cursor position. Click the target field first before typing to ensure focus. ',
        inputSchema: {
            text: z.string().describe('The text to type'),
        },
    },
    async ({ text }) => {
        try {
            await typeViaClipboard(text);
            return { content: [{ type: 'text' as const, text: `Typed ${text.length} characters.` }] };
        } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error typing: ${(err as Error).message}` }], isError: true };
        }
    },
);

server.registerTool(
    'press_key_combination',
    {
        description:
            'Press a key or key combination. Supports combined format with "+" separator for shortcuts. ' +
            'Examples: "ctrl+c", "ctrl+shift+t", "alt+F4", "ctrl+a". ' +
            'Single keys: "Return", "Escape", "Tab", "space", "BackSpace", "Delete", "Up", "Down", "Left", "Right". ' +
            'Function keys: "F1"–"F12". ' +
            'You can also use the separate modifiers array. After pressing, take a screenshot to verify.',
        inputSchema: {
            key: z.string().describe(
                'Key to press. Use combined format for shortcuts: "ctrl+c", "alt+F4", "ctrl+shift+t". ' +
                'Single keys: "Return", "Escape", "Tab", "space", "BackSpace", "Delete". ' +
                'Function keys: "F1"–"F12".'
            ),
            modifiers: z.array(z.enum(['control', 'shift', 'alt', 'command'])).optional()
                .describe('Optional modifier keys (used when key is not in combined format)'),
        },
    },
    async ({ key, modifiers }) => {
        try {
            // Normalize common key name variants to robotjs-expected names
            const keyMap: Record<string, string> = {
                backspace: 'backspace', enter: 'return', return: 'return',
                escape: 'escape', esc: 'escape', tab: 'tab', space: 'space',
                delete: 'delete', del: 'delete', insert: 'insert',
                home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown',
                up: 'up', down: 'down', left: 'left', right: 'right',
                capslock: 'capslock', numlock: 'numlock', scrolllock: 'scrolllock',
                printscreen: 'printscreen', pause: 'pause',
                // Multimedia aliases
                volumeup: 'audio_vol_up', volup: 'audio_vol_up',
                volumedown: 'audio_vol_down', voldown: 'audio_vol_down',
                volumemute: 'audio_mute', mute: 'audio_mute',
                mediaplay: 'audio_play', playpause: 'audio_play',
                mediapause: 'audio_pause', mediaresume: 'audio_play',
                mediastop: 'audio_stop',
                medianext: 'audio_next', mediaprevious: 'audio_prev',
            };

            // Support combined format like "ctrl+c", "alt+F4"
            const parts = key.split('+');
            let actualKey: string;
            let actualModifiers = modifiers || [];

            if (parts.length > 1) {
                const rawKey = parts[parts.length - 1].toLowerCase();
                actualKey = keyMap[rawKey] || rawKey;
                const modMap: Record<string, string> = { ctrl: 'control', control: 'control', shift: 'shift', alt: 'alt', cmd: 'command', command: 'command', super: 'command' };
                actualModifiers = parts.slice(0, -1)
                    .map(m => modMap[m.toLowerCase()])
                    .filter((m): m is string => !!m) as ('control' | 'shift' | 'alt' | 'command')[];
            } else {
                const rawKey = key.toLowerCase();
                actualKey = keyMap[rawKey] || rawKey;
            }

            robot.keyTap(actualKey, actualModifiers);
            const desc = actualModifiers.length ? `${actualModifiers.join('+')}+${actualKey}` : actualKey;
            return { content: [{ type: 'text' as const, text: `Pressed ${desc}.` }] };
        } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error pressing key: ${(err as Error).message}` }], isError: true };
        }
    },
);

// ── Media / volume controls ────────────────────────────────────────────────

function tapMultimediaKey(key: string): void {
    robot.keyTap(key as any);
}

server.registerTool(
    'control_media_playback',
    {
        description:
            'Control system media playback (play/pause/stop/next/previous). ' +
            'This uses multimedia key presses at OS level.',
        inputSchema: {
            action: z
                .enum(['play_pause', 'play', 'pause', 'stop', 'next', 'previous'])
                .describe('Media action to perform.'),
        },
    },
    async ({ action }) => {
        try {
            const keyByAction: Record<string, string> = {
                play_pause: 'audio_play',
                play: 'audio_play',
                pause: 'audio_pause',
                stop: 'audio_stop',
                next: 'audio_next',
                previous: 'audio_prev',
            };

            const multimediaKey = keyByAction[action];
            tapMultimediaKey(multimediaKey);
            return { content: [{ type: 'text' as const, text: `Media action executed: ${action}.` }] };
        } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error controlling media playback: ${(err as Error).message}` }], isError: true };
        }
    },
);

server.registerTool(
    'control_volume',
    {
        description:
            'Control system volume using multimedia keys. ' +
            'Use up/down with optional steps, or mute to toggle mute state.',
        inputSchema: {
            action: z.enum(['up', 'down', 'mute']).describe('Volume action to perform.'),
            steps: z
                .number()
                .int()
                .min(1)
                .max(30)
                .optional()
                .describe('How many key presses to apply for up/down (default: 1). Ignored for mute.'),
        },
    },
    async ({ action, steps }) => {
        try {
            if (action === 'mute') {
                tapMultimediaKey('audio_mute');
                return { content: [{ type: 'text' as const, text: 'Volume mute toggled.' }] };
            }

            const key = action === 'up' ? 'audio_vol_up' : 'audio_vol_down';
            const count = steps ?? 1;
            for (let i = 0; i < count; i++) {
                tapMultimediaKey(key);
            }

            return {
                content: [{ type: 'text' as const, text: `Volume ${action} applied (${count} step${count === 1 ? '' : 's'}).` }],
            };
        } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error controlling volume: ${(err as Error).message}` }], isError: true };
        }
    },
);

// ── Screen info tool ────────────────────────────────────────────────────────

server.registerTool(
    'wait',
    {
        description: 'Pause execution for a specified number of seconds. Useful for waiting for UI transitions, page loads, or animations to complete.',
        inputSchema: {
            seconds: z.number().min(1).max(10).describe('Number of seconds to wait (1 – 10)'),
        },
    },
    async ({ seconds }) => {
        await new Promise(resolve => setTimeout(resolve, Math.round(seconds * 1000)));
        return { content: [{ type: 'text' as const, text: `Waited ${seconds}s.` }] };
    },
);

server.registerTool(
    'get_screen_size',
    {
        description: 'Get the agent display resolution and physical screen resolution. Mouse/click coordinates use agent display space.',
    },
    async () => {
        try {
            const info = getScaleInfo();
            const restrictionNote = RESTRICTED_DISPLAY !== undefined
                ? `\nDisplay restricted to monitor ${RESTRICTED_DISPLAY}.`
                : '';
            const geminiNote = GEMINI_MODE
                ? `\nGemini mode: image is ${info.agentWidth}×${info.agentHeight} with content area ${info.agentWidth}×${info.contentHeight}. Click coordinates must be within content area.`
                : '';
            return {
                content: [{
                    type: 'text' as const,
                    text:
                        `Agent display: ${info.agentWidth}×${info.contentHeight} px — USE THESE for click coordinates.\n` +
                        `Physical screen: ${info.screenWidth}×${info.screenHeight} px (handled internally).\n` +
                        `Scale factor: ${info.scaleX.toFixed(3)}.` +
                        restrictionNote +
                        geminiNote
                }]
            };
        } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error getting screen size: ${(err as Error).message}` }], isError: true };
        }
    },
);

server.registerTool(
    'get_system_details',
    {
        description: 'Get comprehensive system information including OS, CPU, memory, disk usage, hostname, uptime, and environment details.',
    },
    async () => {
        try {
            const os = await import('node:os');
            const { execSync } = await import('node:child_process');
            const cpus = os.cpus();
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;

            const lines: string[] = [
                `Hostname: ${os.hostname()}`,
                `Platform: ${os.platform()} (${os.arch()})`,
                `OS Release: ${os.release()}`,
                `Uptime: ${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`,
                `CPU: ${cpus[0]?.model || 'Unknown'} (${cpus.length} cores)`,
                `Memory: ${(usedMem / 1073741824).toFixed(1)} GB used / ${(totalMem / 1073741824).toFixed(1)} GB total (${Math.round(usedMem / totalMem * 100)}%)`,
                `Free Memory: ${(freeMem / 1073741824).toFixed(1)} GB`,
                `User: ${os.userInfo().username}`,
                `Home: ${os.homedir()}`,
                `Temp Dir: ${os.tmpdir()}`,
                `Node.js: ${process.version}`,
            ];

            // Disk usage (Linux/macOS)
            if (os.platform() !== 'win32') {
                try {
                    const df = execSync('df -h / --output=size,used,avail,pcent 2>/dev/null || df -h /', { encoding: 'utf-8' }).trim();
                    lines.push(`Disk (root):\n${df}`);
                } catch { /* ignore */ }
            } else {
                try {
                    const wmic = execSync('wmic logicaldisk get size,freespace,caption', { encoding: 'utf-8' }).trim();
                    lines.push(`Disks:\n${wmic}`);
                } catch { /* ignore */ }
            }

            return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error getting system details: ${(err as Error).message}` }], isError: true };
        }
    },
);

// ── Cursor area tool ────────────────────────────────────────────────────────

server.registerTool(
    'get_cursor_area',
    {
        description:
            `Capture a ${GEMINI_MODE ? '1000×1000' : '512×512'} screenshot centred on the current mouse cursor at full (native) resolution, ` +
            'with a red crosshair overlay marking the exact cursor position. ' +
            'Useful for inspecting the precise area around the cursor: reading small text, verifying click targets, or confirming hover states. ' +
            'Returns the screenshot plus the cursor coordinates in agent display space.',
        inputSchema: {},
    },
    async () => {
        try {
            const SIZE = GEMINI_MODE ? 1000 : 512;
            const HALF = SIZE / 2;

            // 1. Get cursor position in physical screen coordinates
            const mousePos = robot.getMousePos();

            // 2. Determine capture region, clamped to screen bounds
            const screenSize = robot.getScreenSize();
            const left = Math.max(0, mousePos.x - HALF);
            const top = Math.max(0, mousePos.y - HALF);
            const right = Math.min(screenSize.width, mousePos.x + HALF);
            const bottom = Math.min(screenSize.height, mousePos.y + HALF);
            const captureW = right - left;
            const captureH = bottom - top;

            if (captureW <= 0 || captureH <= 0) {
                return { content: [{ type: 'text' as const, text: 'Cursor is outside screen bounds.' }], isError: true };
            }

            // 3. Capture the region at full resolution
            const bitmap = robot.screen.capture(left, top, captureW, captureH);
            let pngBuf = bitmapToPng(bitmap);

            // 4. If capture is smaller than 512×512 (cursor near edge), paste into a 512×512 canvas
            if (captureW < SIZE || captureH < SIZE) {
                const captured = PNG.sync.read(pngBuf);
                const canvas = new PNG({ width: SIZE, height: SIZE, fill: true });
                // Fill with dark grey background
                for (let i = 0; i < canvas.data.length; i += 4) {
                    canvas.data[i] = 30; canvas.data[i + 1] = 30; canvas.data[i + 2] = 30; canvas.data[i + 3] = 255;
                }
                // Offset: where the captured pixels sit inside the canvas
                const offsetX = mousePos.x - left < HALF ? 0 : SIZE - captureW;
                const offsetY = mousePos.y - top < HALF ? 0 : SIZE - captureH;
                // Manual pixel copy (pngjs v7 removed bitblt)
                for (let y = 0; y < captureH; y++) {
                    for (let x = 0; x < captureW; x++) {
                        const srcIdx = (y * captured.width + x) * 4;
                        const dstIdx = ((y + offsetY) * canvas.width + (x + offsetX)) * 4;
                        canvas.data[dstIdx] = captured.data[srcIdx];
                        canvas.data[dstIdx + 1] = captured.data[srcIdx + 1];
                        canvas.data[dstIdx + 2] = captured.data[srcIdx + 2];
                        canvas.data[dstIdx + 3] = captured.data[srcIdx + 3];
                    }
                }
                pngBuf = PNG.sync.write(canvas);
            }

            // 5. Calculate cursor position within the 512×512 image
            const cursorInImageX = mousePos.x - left + (captureW < SIZE && mousePos.x - left >= HALF ? SIZE - captureW : 0);
            const cursorInImageY = mousePos.y - top + (captureH < SIZE && mousePos.y - top >= HALF ? SIZE - captureH : 0);

            // 6. Draw crosshair at cursor position
            const annotated = drawCursorCrosshair(pngBuf, cursorInImageX, cursorInImageY);

            // 7. Report coordinates in agent display space
            const { ax, ay } = screenToAgent(mousePos.x, mousePos.y);

            return {
                content: [
                    { type: 'image' as const, data: annotated.toString('base64'), mimeType: 'image/png' },
                    {
                        type: 'text' as const,
                        text: `Cursor area (${SIZE}×${SIZE} native pixels) centred on cursor.\n` +
                            `Cursor position: (${ax}, ${ay}) in agent space, (${mousePos.x}, ${mousePos.y}) physical.`,
                    },
                ],
            };
        } catch (err) {
            return { content: [{ type: 'text' as const, text: `Error: ${(err as Error).message}` }], isError: true };
        }
    },
);

// ── Start ───────────────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
});
