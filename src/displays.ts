import type { Rect } from './scaling.js';

export type Side = 'left' | 'right' | 'up' | 'down';
export type Relation = 'left of' | 'right of' | 'above' | 'below' | 'overlapping';

const RELATION_BY_SIDE: Record<Side, Relation> = { left: 'left of', right: 'right of', up: 'above', down: 'below' };

/** Half-open bounds assign shared edges to exactly one adjacent monitor. */
export function displayAtCursor(displays: Rect[], cursor: { x: number; y: number }): number {
    const index = displays.findIndex(d => cursor.x >= d.x && cursor.y >= d.y &&
        cursor.x < d.x + d.width && cursor.y < d.y + d.height);
    if (index < 0) throw new Error('Cursor is outside the known displays; cannot select its monitor.');
    return index;
}

/**
 * Remembers which display tools use when no display is passed. It starts at the
 * primary (0); any explicit display, including -1 for the full desktop, becomes current.
 * `undefined` means the full desktop.
 */
export class DisplaySelection {
    private active: number | undefined = 0;

    constructor(private readonly restricted?: number) { }

    get current(): number | undefined {
        return this.restricted ?? this.active;
    }

    resolve(requested: number | undefined, count: number): number | undefined {
        if (this.restricted !== undefined) {
            if (this.restricted >= count) throw new Error(`DISPLAY_INDEX selects display ${this.restricted}, but only displays 0-${count - 1} exist.`);
            return this.restricted;
        }
        if (requested !== undefined) {
            if (!Number.isInteger(requested) || requested < -1 || requested >= count) {
                throw new Error(`Display ${requested} unavailable; valid displays are 0-${count - 1}, or -1 for the full desktop.`);
            }
            this.active = requested === -1 ? undefined : requested;
            return this.active;
        }
        if (this.active !== undefined && this.active >= count) {
            const missing = this.active;
            this.active = 0;
            throw new Error(`Current display ${missing} no longer exists; switched to primary display 0. Take a new screenshot.`);
        }
        return this.active;
    }
}

/** Where `d` sits relative to `ref`, judged by the dominant axis between their centres. */
export function relativePosition(d: Rect, ref: Rect): Relation {
    const dx = (d.x + d.width / 2) - (ref.x + ref.width / 2);
    const dy = (d.y + d.height / 2) - (ref.y + ref.height / 2);
    if (dx === 0 && dy === 0) return 'overlapping';
    if (Math.abs(dx) >= Math.abs(dy)) return dx < 0 ? 'left of' : 'right of';
    return dy < 0 ? 'above' : 'below';
}

/** The nearest display beyond the given edge of `displays[index]`, if any. */
export function neighbor(displays: Rect[], index: number, side: Side): number | undefined {
    const ref = displays[index];
    let best: { index: number; distance: number } | undefined;
    displays.forEach((d, i) => {
        if (i === index || relativePosition(d, ref) !== RELATION_BY_SIDE[side]) return;
        const distance = Math.hypot((d.x + d.width / 2) - (ref.x + ref.width / 2), (d.y + d.height / 2) - (ref.y + ref.height / 2));
        if (!best || distance < best.distance) best = { index: i, distance };
    });
    return best?.index;
}

/** One-line layout summary positioned relative to display 0 (the primary). */
export function describeDisplays(displays: (Rect & { isPrimary?: boolean })[], current: number | undefined): string {
    return displays.map((d, i) =>
        `${i}: ${d.isPrimary ? 'primary ' : ''}${d.width}×${d.height}` +
        (i === 0 ? '' : `, ${relativePosition(d, displays[0])} 0`) +
        (i === current ? ' (current)' : ''),
    ).join(' · ');
}
