import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('guide resource and current-display mouse contract are exposed over MCP', async () => {
    const client = new Client({ name: 'computer-controller-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] });
    await client.connect(transport);
    try {
        const resources = await client.listResources();
        assert.ok(resources.resources.some(resource => resource.uri === 'computer-controller://guide'));
        const guide = await client.readResource({ uri: 'computer-controller://guide' });
        assert.match(guide.contents[0].text, /Coordinates always refer to the current display/i);
        const listed = await client.listTools();
        const screenshot = listed.tools.find(tool => tool.name === 'get_screenshot');
        assert.equal(screenshot.inputSchema.properties.display.minimum, -1);
        assert.match(screenshot.inputSchema.properties.display.description, /current display/);
        const move = listed.tools.find(tool => tool.name === 'move_mouse');
        assert.deepEqual(move.inputSchema.required.sort(), ['x', 'y']);
        assert.ok(move.inputSchema.properties.display);
        assert.equal(move.inputSchema.properties.frame, undefined);
        for (const name of ['move_mouse', 'click_mouse', 'double_click', 'drag_mouse', 'scroll_mouse', 'get_mouse_position', 'get_cursor_area']) {
            const display = listed.tools.find(tool => tool.name === name).inputSchema.properties.display;
            assert.equal(display.minimum, -1, name);
            assert.match(display.description, /current display/, name);
        }
        const click = listed.tools.find(tool => tool.name === 'click_mouse');
        assert.ok(click.inputSchema.properties.x && click.inputSchema.properties.y);
        assert.ok(!(click.inputSchema.required ?? []).includes('x'));
        const cursor = listed.tools.find(tool => tool.name === 'get_cursor_area');
        assert.ok(cursor.inputSchema.properties.display);
        assert.equal(cursor.inputSchema.properties.frame, undefined);
    } finally {
        await client.close();
    }
});
