import { test } from 'node:test';
import assert from 'node:assert/strict';

const { keysymForCodePoint } = await import('../dist/xtest.js');

test('characters map to X keysyms', () => {
    assert.equal(keysymForCodePoint('/'.codePointAt(0)), 0x2f);
    assert.equal(keysymForCodePoint('ß'.codePointAt(0)), 0xdf);
    assert.equal(keysymForCodePoint('€'.codePointAt(0)), 0x10020ac);
    assert.equal(keysymForCodePoint('✓'.codePointAt(0)), 0x1002713);
    assert.equal(keysymForCodePoint(0x0a), 0xff0d);
    assert.equal(keysymForCodePoint(0x09), 0xff09);
});
