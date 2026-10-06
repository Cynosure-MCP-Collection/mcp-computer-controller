import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayAtCursor, DisplaySelection, describeDisplays, neighbor, relativePosition } from '../dist/displays.js';

const displays = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: -1280, y: -200, width: 1280, height: 1024 },
    { x: 1920, y: 0, width: 1080, height: 1920 },
];

test('cursor selects monitors with negative origins, portrait layouts and shared edges', () => {
    assert.equal(displayAtCursor(displays, { x: 100, y: 100 }), 0);
    assert.equal(displayAtCursor(displays, { x: -1, y: -100 }), 1);
    assert.equal(displayAtCursor(displays, { x: 0, y: 100 }), 0);
    assert.equal(displayAtCursor(displays, { x: 1920, y: 1500 }), 2);
    assert.equal(displayAtCursor(displays, { x: -1280, y: -200 }), 1);
});

test('unknown cursor positions fail instead of selecting another monitor', () => {
    assert.throws(() => displayAtCursor(displays, { x: 3000, y: 0 }), /outside/);
    assert.throws(() => displayAtCursor(displays, { x: -1, y: 1080 }), /outside/);
    assert.throws(() => displayAtCursor([], { x: 0, y: 0 }), /outside/);
});

test('selection starts at the primary and remembers explicit displays', () => {
    const selection = new DisplaySelection();
    assert.equal(selection.resolve(undefined, 3), 0);
    assert.equal(selection.resolve(2, 3), 2);
    assert.equal(selection.resolve(undefined, 3), 2);
    assert.equal(selection.current, 2);
    assert.equal(selection.resolve(-1, 3), undefined);
    assert.equal(selection.resolve(undefined, 3), undefined);
    assert.equal(selection.resolve(0, 3), 0);
});

test('invalid displays throw without changing the current display', () => {
    const selection = new DisplaySelection();
    selection.resolve(1, 3);
    assert.throws(() => selection.resolve(3, 3), /valid displays are 0-2, or -1/);
    assert.throws(() => selection.resolve(-2, 3), /unavailable/);
    assert.equal(selection.resolve(undefined, 3), 1);
});

test('a vanished current display fails once, then falls back to the primary', () => {
    const selection = new DisplaySelection();
    selection.resolve(2, 3);
    assert.throws(() => selection.resolve(undefined, 2), /no longer exists; switched to primary/);
    assert.equal(selection.resolve(undefined, 2), 0);
});

test('DISPLAY_INDEX restriction overrides requests and the remembered display', () => {
    const selection = new DisplaySelection(1);
    assert.equal(selection.resolve(undefined, 3), 1);
    assert.equal(selection.resolve(2, 3), 1);
    assert.equal(selection.resolve(-1, 3), 1);
    assert.equal(selection.current, 1);
    assert.throws(() => selection.resolve(undefined, 1), /DISPLAY_INDEX/);
});

test('displays are described relative to the primary', () => {
    assert.equal(relativePosition(displays[1], displays[0]), 'left of');
    assert.equal(relativePosition(displays[2], displays[0]), 'right of');
    assert.equal(relativePosition({ x: 0, y: -1080, width: 1920, height: 1080 }, displays[0]), 'above');
    assert.equal(relativePosition({ x: 0, y: 1080, width: 1920, height: 1080 }, displays[0]), 'below');
    assert.equal(relativePosition(displays[0], displays[0]), 'overlapping');
    assert.equal(describeDisplays([{ ...displays[0], isPrimary: true }, displays[1], displays[2]], 2),
        '0: primary 1920×1080 · 1: 1280×1024, left of 0 · 2: 1080×1920, right of 0 (current)');
});

test('neighbor finds the nearest display beyond each edge', () => {
    assert.equal(neighbor(displays, 0, 'left'), 1);
    assert.equal(neighbor(displays, 0, 'right'), 2);
    assert.equal(neighbor(displays, 0, 'up'), undefined);
    assert.equal(neighbor(displays, 1, 'right'), 0);
    assert.equal(neighbor(displays, 2, 'left'), 0);
    const stacked = [displays[0], { x: 0, y: 1080, width: 1920, height: 1080 }, { x: 0, y: 2160, width: 1920, height: 1080 }];
    assert.equal(neighbor(stacked, 0, 'down'), 1);
    assert.equal(neighbor(stacked, 2, 'up'), 1);
});
