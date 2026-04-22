import robot from '@hurdlegroup/robotjs';
import { PNG } from 'pngjs';

/** Whether Gemini mode is active (1000×1000 letterboxed output) */
export const GEMINI_MODE = process.env.GEMINI_MODE === 'true' || process.env.GEMINI_MODE === '1';
const GEMINI_SIZE = 1000;

/** Anthropic-recommended target resolutions, matched by aspect ratio */
const SCALE_TARGETS = [
    { width: 1024, height: 768 },  // XGA  4:3
    { width: 1280, height: 800 },  // WXGA 16:10
    { width: 1280, height: 720 },  // HD   16:9
];

export interface ScaleInfo {
    /** Resolution Claude sees (= what you send to API / report in display_width_px) */
    agentWidth: number;
    agentHeight: number;
    /** Uniform scale factor: agentPx = screenPx * scale */
    scaleX: number;
    scaleY: number;
    /** Actual screen logical pixels (robotjs space) */
    screenWidth: number;
    screenHeight: number;
    /** Height of the actual content within the agent image (before padding). Equals agentHeight when not in Gemini mode. */
    contentHeight: number;
}

let cached: ScaleInfo | null = null;

export function getScaleInfo(): ScaleInfo {
    if (cached) return cached;

    const { width: sw, height: sh } = robot.getScreenSize();

    if (GEMINI_MODE) {
        // Scale to fit within GEMINI_SIZE × GEMINI_SIZE maintaining aspect ratio.
        // Content is placed at the top; bottom is padded with black.
        const scale = Math.min(GEMINI_SIZE / sw, GEMINI_SIZE / sh);
        const contentW = Math.round(sw * scale);
        const contentH = Math.round(sh * scale);
        cached = {
            agentWidth: GEMINI_SIZE,
            agentHeight: GEMINI_SIZE,
            scaleX: scale,
            scaleY: scale,
            screenWidth: sw,
            screenHeight: sh,
            contentHeight: contentH,
        };
        return cached;
    }

    const screenRatio = sw / sh;

    // Find best matching target by aspect ratio
    let best = SCALE_TARGETS[0];
    let bestDiff = Infinity;
    for (const t of SCALE_TARGETS) {
        const diff = Math.abs(t.width / t.height - screenRatio);
        if (diff < bestDiff) { bestDiff = diff; best = t; }
    }

    // Only scale down, never up — use uniform scaling
    const scaleX = sw > best.width ? best.width / sw : 1;
    const scaleY = sh > best.height ? best.height / sh : 1;
    const scale = Math.min(scaleX, scaleY);

    const aw = Math.round(sw * scale);
    const ah = Math.round(sh * scale);
    cached = {
        agentWidth: aw,
        agentHeight: ah,
        scaleX: scale,
        scaleY: scale,
        screenWidth: sw,
        screenHeight: sh,
        contentHeight: ah,
    };
    return cached;
}

/** Reset cached scale info (e.g. if screen resolution changes) */
export function resetScaleInfo(): void {
    cached = null;
}

/** Scale a screenshot PNG down to agent resolution using pngjs (nearest-neighbour) */
function scaleScreenshotPngjs(srcBuf: Buffer, info: ScaleInfo): Buffer {
    const src = PNG.sync.read(srcBuf);
    const dw = info.agentWidth;
    const dh = info.agentHeight;
    const dst = new PNG({ width: dw, height: dh });

    for (let y = 0; y < dh; y++) {
        for (let x = 0; x < dw; x++) {
            const sx = Math.min(Math.round(x / info.scaleX), src.width - 1);
            const sy = Math.min(Math.round(y / info.scaleY), src.height - 1);
            const si = (sy * src.width + sx) * 4;
            const di = (y * dw + x) * 4;
            dst.data[di] = src.data[si];
            dst.data[di + 1] = src.data[si + 1];
            dst.data[di + 2] = src.data[si + 2];
            dst.data[di + 3] = 255;
        }
    }
    return PNG.sync.write(dst);
}

/** Scale a screenshot PNG down to agent resolution. Prefers sharp (lanczos3) if available.
 *  In Gemini mode, pads the bottom with black to produce a square 1000×1000 image. */
export async function scaleScreenshot(srcBuf: Buffer): Promise<Buffer> {
    const info = getScaleInfo();
    if (info.scaleX === 1 && info.scaleY === 1 && !GEMINI_MODE) return srcBuf;

    const contentW = GEMINI_MODE ? Math.round(info.screenWidth * info.scaleX) : info.agentWidth;
    const contentH = info.contentHeight;

    let scaledBuf: Buffer;
    try {
        const sharp = await import('sharp');
        scaledBuf = await sharp.default(srcBuf)
            .resize(contentW, contentH, { kernel: 'lanczos3' })
            .png()
            .toBuffer();
    } catch {
        scaledBuf = scaleScreenshotPngjs(srcBuf, { ...info, agentWidth: contentW, agentHeight: contentH });
    }

    // In Gemini mode, pad bottom to make GEMINI_SIZE × GEMINI_SIZE
    if (GEMINI_MODE && contentH < GEMINI_SIZE) {
        scaledBuf = padBottom(scaledBuf, contentW, contentH, GEMINI_SIZE);
    }

    return scaledBuf;
}

/** Pad a PNG buffer with black pixels at the bottom to reach targetHeight. */
function padBottom(srcBuf: Buffer, w: number, contentH: number, targetH: number): Buffer {
    const src = PNG.sync.read(srcBuf);
    const dst = new PNG({ width: w, height: targetH, fill: true });
    // Fill entire canvas with black
    for (let i = 0; i < dst.data.length; i += 4) {
        dst.data[i] = 0; dst.data[i + 1] = 0; dst.data[i + 2] = 0; dst.data[i + 3] = 255;
    }
    // Copy content pixels
    for (let y = 0; y < contentH; y++) {
        const srcOff = y * w * 4;
        const dstOff = y * w * 4;
        src.data.copy(dst.data, dstOff, srcOff, srcOff + w * 4);
    }
    return PNG.sync.write(dst);
}

/** Convert agent-space coordinates → screen logical pixels for robotjs */
export function agentToScreen(ax: number, ay: number): { px: number; py: number } {
    const info = getScaleInfo();
    return {
        px: Math.round(ax / info.scaleX),
        py: Math.round(ay / info.scaleY),
    };
}

/** Convert screen logical pixels → agent-space coordinates */
export function screenToAgent(px: number, py: number): { ax: number; ay: number } {
    const info = getScaleInfo();
    return {
        ax: Math.round(px * info.scaleX),
        ay: Math.round(py * info.scaleY),
    };
}

/** Validate that coordinates are within agent display bounds. Returns error message or null. */
export function validateCoords(x: number, y: number): string | null {
    const info = getScaleInfo();
    if (x < 0 || y < 0 || x > info.agentWidth || y > info.contentHeight) {
        return `Coordinates (${x}, ${y}) out of bounds. ` +
            `Valid range: [0, ${info.agentWidth}] × [0, ${info.contentHeight}].`;
    }
    return null;
}

// ── Per-display scaling helpers ─────────────────────────────────────────────

/** Compute scale info for specific image dimensions (e.g. a single display) without touching the global cache. */
export function computeScaleInfoForDimensions(w: number, h: number): ScaleInfo {
    if (GEMINI_MODE) {
        const scale = Math.min(GEMINI_SIZE / w, GEMINI_SIZE / h);
        const contentH = Math.round(h * scale);
        return {
            agentWidth: GEMINI_SIZE,
            agentHeight: GEMINI_SIZE,
            scaleX: scale,
            scaleY: scale,
            screenWidth: w,
            screenHeight: h,
            contentHeight: contentH,
        };
    }

    const screenRatio = w / h;
    let best = SCALE_TARGETS[0];
    let bestDiff = Infinity;
    for (const t of SCALE_TARGETS) {
        const diff = Math.abs(t.width / t.height - screenRatio);
        if (diff < bestDiff) { bestDiff = diff; best = t; }
    }
    const scaleX = w > best.width ? best.width / w : 1;
    const scaleY = h > best.height ? best.height / h : 1;
    const scale = Math.min(scaleX, scaleY);
    const aw = Math.round(w * scale);
    const ah = Math.round(h * scale);
    return {
        agentWidth: aw,
        agentHeight: ah,
        scaleX: scale,
        scaleY: scale,
        screenWidth: w,
        screenHeight: h,
        contentHeight: ah,
    };
}

/**
 * Override the global scale info cache (e.g. when restricting to a single display).
 * Pass null to clear the override — the next getScaleInfo() call will re-read from robot.
 */
export function overrideScaleInfo(info: ScaleInfo | null): void {
    cached = info;
}

/** Scale a buffer using specific source dimensions (for single-display captures). Returns scaled buffer + scale info. */
export async function scaleBufferForDisplay(srcBuf: Buffer, srcW: number, srcH: number): Promise<{ buf: Buffer; info: ScaleInfo }> {
    const info = computeScaleInfoForDimensions(srcW, srcH);
    const contentW = GEMINI_MODE ? Math.round(srcW * info.scaleX) : info.agentWidth;
    const contentH = info.contentHeight;

    if (info.scaleX === 1 && info.scaleY === 1 && !GEMINI_MODE) return { buf: srcBuf, info };

    let scaledBuf: Buffer;
    try {
        const sharp = await import('sharp');
        scaledBuf = await sharp.default(srcBuf)
            .resize(contentW, contentH, { kernel: 'lanczos3' })
            .png()
            .toBuffer();
    } catch {
        // pngjs nearest-neighbour fallback
        const src = PNG.sync.read(srcBuf);
        const dw = contentW, dh = contentH;
        const dst = new PNG({ width: dw, height: dh });
        for (let y = 0; y < dh; y++) {
            for (let x = 0; x < dw; x++) {
                const sx = Math.min(Math.round(x / info.scaleX), src.width - 1);
                const sy = Math.min(Math.round(y / info.scaleY), src.height - 1);
                const si = (sy * src.width + sx) * 4;
                const di = (y * dw + x) * 4;
                dst.data[di] = src.data[si];
                dst.data[di + 1] = src.data[si + 1];
                dst.data[di + 2] = src.data[si + 2];
                dst.data[di + 3] = 255;
            }
        }
        scaledBuf = PNG.sync.write(dst);
    }

    // In Gemini mode, pad bottom to make GEMINI_SIZE × GEMINI_SIZE
    if (GEMINI_MODE && contentH < GEMINI_SIZE) {
        scaledBuf = padBottom(scaledBuf, contentW, contentH, GEMINI_SIZE);
    }

    return { buf: scaledBuf, info };
}
