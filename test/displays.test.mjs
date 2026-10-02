import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayAtCursor } from '../dist/displays.js';

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
