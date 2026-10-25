import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PNG } from 'pngjs';
import { captureLinux, captureWithRobotjs } from '../dist/screenshots.js';

function png(width, height, color) {
    const image = new PNG({ width, height });
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            image.data.set(color(x, y), (y * width + x) * 4);
        }
    }
    return PNG.sync.write(image);
}

test('X11 RobotJS fallback captures every monitor at its actual desktop offset', () => {
    const monitors = [
        { x: 1920, y: 237, width: 2560, height: 1440 },
        { x: 0, y: 597, width: 1920, height: 1080 },
        { x: 4480, y: 0, width: 1920, height: 1080 },
    ];
    const desktop = { x: 0, y: 0, width: 6400, height: 1677 };
    const calls = [];
    const backend = {
        getScreenSize: () => desktop,
        screen: { capture: (x, y, width, height) => {
            calls.push({ x, y, width, height });
            return { width, height, byteWidth: width * 4, bytesPerPixel: 4, image: Buffer.alloc(width * height * 4) };
        } },
    };
    for (const bounds of [...monitors, desktop]) {
        const image = PNG.sync.read(captureWithRobotjs(backend, bounds, true));
        assert.equal(image.width, bounds.width);
        assert.equal(image.height, bounds.height);
        assert.deepEqual(calls.at(-1), bounds);
    }
});

test('RobotJS rejects unsafe rectangles and keeps other platform geometry restrictions', () => {
    let calls = 0;
    const backend = {
        getScreenSize: () => ({ width: 10, height: 8 }),
        screen: { capture: () => { calls++; throw new Error('Must not capture'); } },
    };
    for (const bounds of [
        { x: -1, y: 0, width: 5, height: 5 },
        { x: 0, y: -1, width: 5, height: 5 },
        { x: 8, y: 0, width: 5, height: 5 },
        { x: 0, y: 6, width: 5, height: 5 },
        { x: 0, y: 0, width: 0, height: 5 },
    ]) assert.throws(() => captureWithRobotjs(backend, bounds, true), /geometry/);
    assert.throws(() => captureWithRobotjs(backend, { x: 5, y: 0, width: 5, height: 8 }, false), /geometry/);
    assert.equal(calls, 0);
});

test('RobotJS PNG conversion respects row padding and BGR pixel size', () => {
    for (const bytesPerPixel of [3, 4]) {
        const byteWidth = bytesPerPixel + 3;
        const image = Buffer.alloc(byteWidth * 2, 0xff);
        image.set([3, 2, 1], 0);
        image.set([6, 5, 4], byteWidth);
        const backend = {
            getScreenSize: () => ({ width: 1, height: 2 }),
            screen: { capture: () => ({ width: 1, height: 2, byteWidth, bytesPerPixel, image }) },
        };
        const result = PNG.sync.read(captureWithRobotjs(backend, { x: 0, y: 0, width: 1, height: 2 }, true));
        assert.deepEqual([...result.data], [1, 2, 3, 255, 4, 5, 6, 255]);
    }
});

test('Linux retries after successful commands produce no file, invalid PNG or wrong dimensions', async () => {
    const bounds = { x: 2, y: 1, width: 2, height: 2 };
    const desktop = { x: 0, y: 0, width: 4, height: 3 };
    const calls = [];
    const files = [];
    const result = await captureLinux(bounds, desktop, 'HDMI-0', async (command, args) => {
        calls.push(command);
        const file = args.at(-1);
        files.push(file);
        if (command === 'grim') return; // Exit 0, but no screenshot was written.
        if (command === 'gnome-screenshot') return writeFile(file, 'not a PNG');
        if (command === 'scrot') return writeFile(file, png(2, 2, () => [99, 0, 0, 255]));
        return writeFile(file, png(4, 3, (x, y) => [x, y, 42, 255]));
    });
    assert.deepEqual(calls, ['grim', 'gnome-screenshot', 'scrot', 'import']);
    const image = PNG.sync.read(result);
    assert.equal(image.width, 2);
    assert.equal(image.height, 2);
    assert.deepEqual([...image.data], [2, 1, 42, 255, 3, 1, 42, 255, 2, 2, 42, 255, 3, 2, 42, 255]);
    for (const file of files) await assert.rejects(access(dirname(file)), { code: 'ENOENT' });
});

test('Linux crops full desktop captures relative to a negative desktop origin', async () => {
    const desktop = { x: -2, y: -1, width: 4, height: 3 };
    const bounds = { x: 0, y: 0, width: 2, height: 2 };
    const result = await captureLinux(bounds, desktop, 'DP-1', async (command, args) => {
        if (command === 'grim') throw new Error('Unavailable');
        await writeFile(args.at(-1), png(4, 3, (x, y) => [x, y, 0, 255]));
    });
    assert.deepEqual([...PNG.sync.read(result).data.subarray(0, 4)], [2, 1, 0, 255]);
});

test('grim selects the output by name and its image is not cropped again', async () => {
    const bounds = { x: 4, y: 1, width: 2, height: 3 };
    const expected = png(2, 3, () => [1, 2, 3, 255]);
    const result = await captureLinux(bounds, { x: 0, y: 0, width: 6, height: 4 }, 'HDMI-0', async (command, args) => {
        assert.equal(command, 'grim');
        assert.deepEqual(args.slice(0, -1), ['-o', 'HDMI-0']);
        await writeFile(args.at(-1), expected);
    });
    assert.deepEqual(result, expected);
});

test('Linux full desktop capture preserves all monitors', async () => {
    const desktop = { x: 0, y: 0, width: 6, height: 4 };
    const expected = png(6, 4, (x, y) => [x, y, 3, 255]);
    const result = await captureLinux(desktop, desktop, undefined, async (command, args) => {
        assert.equal(command, 'grim');
        assert.equal(args.length, 1);
        await writeFile(args[0], expected);
    });
    assert.deepEqual(result, expected);
});

test('Linux reports all backend failures and cleans temporary files after failure', async () => {
    const bounds = { x: 0, y: 0, width: 2, height: 2 };
    let directory;
    await assert.rejects(captureLinux(bounds, bounds, 'DP-0', async (command, args) => {
        directory = dirname(args.at(-1));
        await writeFile(args.at(-1), 'partial image');
        throw new Error(`${command} failed`);
    }), /All Linux screenshot tools failed.*grim:.*gnome-screenshot:.*scrot:.*import:/);
    await assert.rejects(access(directory), { code: 'ENOENT' });
});
