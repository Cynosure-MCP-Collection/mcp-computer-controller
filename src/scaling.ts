import { PNG } from 'pngjs';

export interface Rect { x: number; y: number; width: number; height: number }
export interface ImageSpace { bounds: Rect; width: number; height: number }

function positiveEnv(name: string): number | undefined {
    const value = process.env[name];
    if (value === undefined || value === '') return undefined;
    if (!/^[1-9]\d*$/.test(value) || Number(value) > 16384) {
        throw new Error(`${name} must be an integer from 1 to 16384`);
    }
    return Number(value);
}

export const MAX_WIDTH = positiveEnv('WIDTH');
export const MAX_HEIGHT = positiveEnv('HEIGHT');

/** Screenshot and input tools use this same deterministic size calculation. */
export function imageSize(srcWidth: number, srcHeight: number): { width: number; height: number } {
    const ratio = Math.min(1, (MAX_WIDTH ?? Infinity) / srcWidth, (MAX_HEIGHT ?? Infinity) / srcHeight);
    return {
        width: Math.max(1, Math.round(srcWidth * ratio)),
        height: Math.max(1, Math.round(srcHeight * ratio)),
    };
}

/** Resize without padding or upscaling. The returned dimensions are the image's actual dimensions. */
export async function scaleScreenshot(srcBuf: Buffer, srcWidth: number, srcHeight: number): Promise<{ buf: Buffer; width: number; height: number }> {
    const { width, height } = imageSize(srcWidth, srcHeight);
    if (width === srcWidth && height === srcHeight) return { buf: srcBuf, width, height };

    try {
        const sharp = await import('sharp');
        return { buf: await sharp.default(srcBuf).resize(width, height, { kernel: 'lanczos3' }).png().toBuffer(), width, height };
    } catch {
        const src = PNG.sync.read(srcBuf);
        const dst = new PNG({ width, height });
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const sx = Math.min(Math.floor((x + 0.5) * src.width / width), src.width - 1);
                const sy = Math.min(Math.floor((y + 0.5) * src.height / height), src.height - 1);
                const si = (sy * src.width + sx) * 4;
                const di = (y * width + x) * 4;
                dst.data.set(src.data.subarray(si, si + 4), di);
            }
        }
        return { buf: PNG.sync.write(dst), width, height };
    }
}

export function validateCoords(space: ImageSpace, x: number, y: number): string | null {
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= space.width || y >= space.height) {
        return `Coordinates (${x}, ${y}) out of bounds. Valid range: [0, ${space.width - 1}] × [0, ${space.height - 1}].`;
    }
    return null;
}

export function agentToScreen(space: ImageSpace, x: number, y: number): { px: number; py: number } {
    return {
        px: space.bounds.x + Math.min(space.bounds.width - 1, Math.floor((x + 0.5) * space.bounds.width / space.width)),
        py: space.bounds.y + Math.min(space.bounds.height - 1, Math.floor((y + 0.5) * space.bounds.height / space.height)),
    };
}

export function screenToAgent(space: ImageSpace, px: number, py: number): { ax: number; ay: number } {
    return {
        ax: Math.floor((px - space.bounds.x) * space.width / space.bounds.width),
        ay: Math.floor((py - space.bounds.y) * space.height / space.bounds.height),
    };
}
