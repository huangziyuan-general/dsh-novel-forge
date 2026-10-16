// test/punctuation.test.mjs — 引号规范化（GB/T 15834—2011）纯函数直测。
// 0.20.0：模型 RLHF 偏好直角引号，大陆横排文稿国标是弯引号——代码强制转弯。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeQuotes, countCornerQuotes } from '../lib/punctuation.js';

test('一层直角引号转弯引号', () => {
    const r = normalizeQuotes('他说：「记下了。」');
    assert.equal(r.text, '他说：“记下了。”');
    assert.equal(r.converted, 2);
});

test('嵌套：二层单线（国标示例结构）', () => {
    const r = normalizeQuotes('他说：「好，『照水』这个名字收下了。」');
    assert.equal(r.text, '他说：“好，‘照水’这个名字收下了。”');
    assert.equal(r.converted, 4);
});

test('三层循环回双线', () => {
    const r = normalizeQuotes('「一『二「三」二』一」');
    assert.equal(r.text, '“一‘二“三”二’一”');
});

test('无引号文本原样返回（converted=0）', () => {
    const r = normalizeQuotes('没有引号的一句。');
    assert.equal(r.text, '没有引号的一句。');
    assert.equal(r.converted, 0);
});

test('幂等：已是弯引号的文本不再变', () => {
    const s = '他说：“好，‘照水’收下了。”';
    const r = normalizeQuotes(s);
    assert.equal(r.text, s);
    assert.equal(r.converted, 0);
});

test('容错：孤立闭引号按一层闭转换', () => {
    const r = normalizeQuotes('残稿：忘了开』引号');
    assert.equal(r.text, '残稿：忘了开”引号');
    assert.equal(r.converted, 1);
});

test('容错：混搭开闭按层级配对（首个开引号=一层）', () => {
    const r = normalizeQuotes('『混搭」');
    assert.equal(r.text, '“混搭”');
});

test('countCornerQuotes 计数含开闭全部四种', () => {
    assert.equal(countCornerQuotes('「a」『b』'), 4);
    assert.equal(countCornerQuotes('“已是弯引号”'), 0);
    assert.equal(countCornerQuotes(null), 0);
});

test('null/undefined 安全', () => {
    assert.deepEqual(normalizeQuotes(null), { text: '', converted: 0 });
    assert.deepEqual(normalizeQuotes(undefined), { text: '', converted: 0 });
});
