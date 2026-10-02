import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';

process.env.WIDTH = '1000';
process.env.HEIGHT = '1000';
const { scaleScreenshot, agentToScreen, screenToAgent, validateCoords } = await import('../dist/scaling.js');

function png(width, height) {
    const image = new PNG({ width, height });
    image.data.fill(255);
    return PNG.sync.write(image);
}

test('landscape and portrait images keep aspect ratio without padding', async () => {
    const landscape = await scaleScreenshot(png(1920, 1080), 1920, 1080);
    assert.deepEqual([landscape.width, landscape.height], [1000, 563]);
    assert.deepEqual([PNG.sync.read(landscape.buf).width, PNG.sync.read(landscape.buf).height], [1000, 563]);

    const portrait = await scaleScreenshot(png(1080, 1920), 1080, 1920);
    assert.deepEqual([portrait.width, portrait.height], [563, 1000]);
    assert.deepEqual([PNG.sync.read(portrait.buf).width, PNG.sync.read(portrait.buf).height], [563, 1000]);
});

test('coordinates map to the exact captured rectangle, including negative offsets', () => {
    const space = { bounds: { x: -1920, y: -100, width: 1920, height: 1080 }, width: 1000, height: 563 };
    assert.equal(validateCoords(space, 999, 562), null);
    assert.match(validateCoords(space, 1000, 562), /out of bounds/);
    assert.match(validateCoords(space, 0, 563), /out of bounds/);
    assert.deepEqual(agentToScreen(space, 0, 0), { px: -1920, py: -100 });
    assert.deepEqual(agentToScreen(space, 999, 562), { px: -1, py: 979 });
    for (const [x, y] of [[0, 0], [500, 300], [999, 562]]) {
        const { px, py } = agentToScreen(space, x, y);
        const roundTrip = screenToAgent(space, px, py);
        assert.ok(Math.abs(roundTrip.ax - x) <= 1);
        assert.ok(Math.abs(roundTrip.ay - y) <= 1);
    }
});
