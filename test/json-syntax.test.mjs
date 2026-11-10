// test/json-syntax.test.mjs — 模型 JSON 解析：重复键必须响亮（带路径与原文片段），
// 合法 JSON 与「字符串值里的同名文本」不得误报。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseJsonWithSyntaxRepair, repairJsonSyntax } from '../lib/json-syntax.js';

function duplicateOf(raw) {
    try {
        parseJsonWithSyntaxRepair(raw);
    } catch (error) {
        return error;
    }
    return null;
}

test('json-syntax: 顶层重复键 → 报错带路径与原文片段', () => {
    const error = duplicateOf('{"a":1,"a":2}');
    assert.ok(error !== null, '重复键必须抛错');
    assert.equal(error.code, 'DUPLICATE_JSON_KEY');
    assert.equal(error.path, '$["a"]');
    assert.match(error.message, /\$\["a"\]/);
    assert.match(error.message, /"a":2/);
});

test('json-syntax: 嵌套对象与数组元素里的重复键路径逐层可读', () => {
    assert.equal(duplicateOf('{"outer":{"a":1,"a":2}}').path, '$["outer"]["a"]');
    assert.equal(duplicateOf('{"items":[{"id":1},{"id":1,"id":2}]}').path, '$["items"][1]["id"]');
    assert.equal(duplicateOf('{"a":[1,{"b":[{"c":1,"c":2}]}]}').path, '$["a"][1]["b"][0]["c"]');
});

test('json-syntax: 转义后的键按 JSON 语义判重', () => {
    assert.equal(duplicateOf(String.raw`{"a\u0062":1,"ab":2}`).path, '$["ab"]');
});

test('json-syntax: 字符串值里的同名文本不误报（含转义引号）', () => {
    const raw = String.raw`{"a":"a\":1,\"a\":2"}`;
    const parsed = parseJsonWithSyntaxRepair(raw);
    assert.equal(parsed.value.a, String.raw`a":1,"a":2`);
    assert.equal(parsed.repaired, false);
});

test('json-syntax: 不同对象/数组元素里的同名键是合法 JSON，不误报', () => {
    const raw = '{"a":{"a":1},"list":[{"a":1},{"a":2}],"x":"a","y":{"a":"a","b":{"a":3}}}';
    const parsed = parseJsonWithSyntaxRepair(raw);
    assert.deepEqual(parsed.value, { a: { a: 1 }, list: [{ a: 1 }, { a: 2 }], x: 'a', y: { a: 'a', b: { a: 3 } } });
    assert.equal(parsed.repaired, false);
});

test('json-syntax: 修复路径也不许把重复键静默吃掉', () => {
    // 带 code fence + 尾逗号：能保守修复，但重复键必须仍然报错。
    const raw = '```json\n{"a":1,"a":2,}\n```';
    assert.doesNotThrow(() => repairJsonSyntax(raw), '这是可修复的语法');
    const error = duplicateOf(raw);
    assert.ok(error !== null);
    assert.equal(error.code, 'DUPLICATE_JSON_KEY');
});

test('json-syntax: 非 JSON 垃圾仍按原来的语法失败报错，不被重复键逻辑改写', () => {
    assert.throws(() => parseJsonWithSyntaxRepair('not-json'), (error) => error.code !== 'DUPLICATE_JSON_KEY');
    assert.throws(() => parseJsonWithSyntaxRepair(''), (error) => error.code !== 'DUPLICATE_JSON_KEY');
});
