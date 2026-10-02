import type { Rect } from './scaling.js';

/** Half-open bounds assign shared edges to exactly one adjacent monitor. */
export function displayAtCursor(displays: Rect[], cursor: { x: number; y: number }): number {
    const index = displays.findIndex(d => cursor.x >= d.x && cursor.y >= d.y &&
        cursor.x < d.x + d.width && cursor.y < d.y + d.height);
    if (index < 0) throw new Error('Cursor is outside the known displays; cannot select its monitor.');
    return index;
}
