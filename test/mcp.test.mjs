import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('guide resource and frame-based mouse contract are exposed over MCP', async () => {
    const client = new Client({ name: 'computer-controller-test', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: ['dist/index.js'] });
    await client.connect(transport);
    try {
        const resources = await client.listResources();
        assert.ok(resources.resources.some(resource => resource.uri === 'computer-controller://guide'));
        const guide = await client.readResource({ uri: 'computer-controller://guide' });
        assert.match(guide.contents[0].text, /frame token/i);
        const listed = await client.listTools();
        assert.ok(listed.tools.find(tool => tool.name === 'move_mouse').inputSchema.required.includes('frame'));
        assert.ok(listed.tools.find(tool => tool.name === 'get_cursor_area').inputSchema.required.includes('frame'));
        const result = await client.callTool({ name: 'move_mouse', arguments: { x: 0, y: 0, frame: 'invalid' } });
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /Invalid frame/);
    } finally {
        await client.close();
    }
});
