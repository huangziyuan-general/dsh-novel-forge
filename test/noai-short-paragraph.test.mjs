// test/noai-short-paragraph.test.mjs — 「一句一段」占比判据（structure 维盲区补充）。
// 纯函数直测：全短段 / 正常长短交错 / 40 字边界 / 样本不足，并锁定八维返回结构不变。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oneSentenceParagraphProfile, ONE_SENTENCE_PARA_RATIO, scanAiFlavor } from '../lib/noai.js';

/** 段落数组 → 空行分隔的正文。 */
const chapter = (paras) => paras.join('\n\n');

/** 正常长段：3 句、60 字上下，句数 ≠ 1，必然不计入。 */
const LONG = '风从山口灌下来，带着湿土的味道。老槐树的影子压在石阶上，一动不动。他把褡裢往肩上提了提，继续往前走。';

test('一句一段：全短段章占比 1.0（含引号收尾的单句也不漏判）', () => {
    const paras = Array.from({ length: 20 }, (_, i) => (i === 0 ? '「走吧。」' : '他走了。'));
    const r = oneSentenceParagraphProfile(chapter(paras));
    assert.equal(r.status, 'ok');
    assert.equal(r.hits, 20, '「走吧。」只算 1 句，引号收尾不额外拆句');
    assert.equal(r.paragraphs, 20);
    assert.equal(r.ratio, 1);
});

test('一句一段：正常长短交错章占比低，不触发阈值', () => {
    const paras = Array.from({ length: 18 }, () => LONG);
    paras.push('天黑了。', '他推门进去。');
    const r = oneSentenceParagraphProfile(chapter(paras));
    assert.equal(r.status, 'ok');
    assert.equal(r.hits, 2);
    assert.equal(r.ratio, 2 / 20);
    assert.ok(r.ratio < ONE_SENTENCE_PARA_RATIO, '长短交错章不得进入告警区');
});

test('一句一段：40 字边界——恰好 40 计、41 不计', () => {
    const exact = `${'他'}${'走'.repeat(38)}。`; // 40 字、1 个句末标点
    const over = `${'他'}${'走'.repeat(39)}。`; // 41 字，同样 1 句
    assert.equal(exact.replace(/\s/g, '').length, 40);
    assert.equal(over.replace(/\s/g, '').length, 41);
    const paras = Array.from({ length: 15 }, () => LONG);
    paras.push(exact, over, '');
    const r = oneSentenceParagraphProfile(chapter(paras.filter((p) => p !== '')));
    assert.equal(r.paragraphs, 17);
    assert.equal(r.hits, 1, '只有恰好 40 字的段算一句一段');
});

test('一句一段：样本不足（<15 段）返回 insufficient，不判定', () => {
    const r = oneSentenceParagraphProfile(chapter(Array.from({ length: 10 }, () => '他走了。')));
    assert.equal(r.status, 'insufficient');
    assert.equal(r.ratio, 0);
    assert.equal(r.paragraphs, 10);
});

test('一句一段：标题行不参与占比（# 与「第N章」短行剔除）', () => {
    const paras = ['# 第十五章 夜路', '第十五章 夜路', ...Array.from({ length: 16 }, () => LONG), '他走了。'];
    const r = oneSentenceParagraphProfile(chapter(paras));
    assert.equal(r.paragraphs, 17, '两个标题行都不算段落');
    assert.equal(r.hits, 1);
});

test('八维输出结构不变：新增判据不得改动 scanAiFlavor 的键', () => {
    const r = scanAiFlavor('他走了。');
    assert.deepEqual(Object.keys(r), ['score', 'level', 'chars', 'categories', 'topIssues']);
    assert.deepEqual(Object.keys(r.categories), ['cliche', 'stock', 'emotion', 'template', 'structure', 'dilution', 'formula', 'defaultword']);
});

test('阈值锁定：0.45（高于正常本最大 0.405，压在碎句本 p90 0.448 之上）', () => {
    assert.equal(ONE_SENTENCE_PARA_RATIO, 0.45);
});
