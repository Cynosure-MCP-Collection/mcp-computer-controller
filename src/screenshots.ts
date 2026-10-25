import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import * as path from 'node:path';
import { PNG } from 'pngjs';
import type { Rect } from './scaling.js';

interface CaptureBackend {
    getScreenSize(): { width: number; height: number };
    screen: {
        capture(x: number, y: number, width: number, height: number): {
            image: Buffer; width: number; height: number; byteWidth: number; bytesPerPixel: number;
        };
    };
}

/** X11 captures rectangles in the root window, which includes all monitors. */
export function captureWithRobotjs(backend: CaptureBackend, bounds: Rect,
    x11 = platform() === 'linux' && process.env.XDG_SESSION_TYPE !== 'wayland' && !process.env.WAYLAND_DISPLAY): Buffer {
    const size = backend.getScreenSize();
    const fits = bounds.x >= 0 && bounds.y >= 0 && bounds.width > 0 && bounds.height > 0 &&
        bounds.x + bounds.width <= size.width && bounds.y + bounds.height <= size.height;
    const exact = bounds.x === 0 && bounds.y === 0 && bounds.width === size.width && bounds.height === size.height;
    if (!fits || (!x11 && !exact)) throw new Error('RobotJS geometry does not match the requested display.');

    const bitmap = backend.screen.capture(bounds.x, bounds.y, bounds.width, bounds.height);
    const { width, height, image, byteWidth, bytesPerPixel } = bitmap;
    if (width !== bounds.width || height !== bounds.height) throw new Error('RobotJS returned unexpected screenshot dimensions.');
    if ((bytesPerPixel !== 3 && bytesPerPixel !== 4) || byteWidth < width * bytesPerPixel || image.length < byteWidth * height) {
        throw new Error('RobotJS returned an unsupported bitmap layout.');
    }
    const png = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const src = y * byteWidth + x * bytesPerPixel;
            const dst = (y * width + x) * 4;
            png.data[dst] = image[src + 2];
            png.data[dst + 1] = image[src + 1];
            png.data[dst + 2] = image[src];
            png.data[dst + 3] = 255;
        }
    }
    return PNG.sync.write(png);
}

/** Crop only after the source image's coordinate space has been verified. */
export function cropPng(buf: Buffer, x: number, y: number, width: number, height: number): Buffer {
    const src = PNG.sync.read(buf);
    if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > src.width || y + height > src.height) {
        throw new Error('Requested monitor does not fit within the captured desktop.');
    }
    const dst = new PNG({ width, height });
    for (let row = 0; row < height; row++) {
        const offset = ((y + row) * src.width + x) * 4;
        src.data.copy(dst.data, row * width * 4, offset, offset + width * 4);
    }
    return PNG.sync.write(dst);
}

function runCommand(command: string, args: string[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout: 8_000 }, (error) => error ? reject(error) : resolve(undefined));
    });
}

/** A successful command must also produce a valid image in the expected coordinate space. */
export async function captureLinux(bounds: Rect, desktop: Rect, outputName?: string,
    run: (command: string, args: string[]) => Promise<unknown> = runCommand): Promise<Buffer> {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'mcp-screenshot-'));
    const failures: string[] = [];
    const attempts = [
        { command: 'grim', args: outputName ? ['-o', outputName] : [], direct: !!outputName },
        { command: 'gnome-screenshot', args: ['--file'], direct: false },
        { command: 'scrot', args: [], direct: false },
        { command: 'import', args: ['-window', 'root'], direct: false },
    ];
    try {
        for (const { command, args, direct } of attempts) {
            const file = path.join(directory, `${command}.png`);
            try {
                await run(command, [...args, file]);
                const buf = await fs.readFile(file);
                const image = PNG.sync.read(buf);
                const expected = direct ? bounds : desktop;
                if (image.width !== expected.width || image.height !== expected.height) {
                    throw new Error(`Image is ${image.width}×${image.height}; expected ${expected.width}×${expected.height}.`);
                }
                return direct ? buf : cropPng(buf, bounds.x - desktop.x, bounds.y - desktop.y, bounds.width, bounds.height);
            } catch (error) {
                failures.push(`${command}: ${(error as Error).message}`);
            }
        }
        throw new Error(`All Linux screenshot tools failed. ${failures.join('; ')}`);
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
}
