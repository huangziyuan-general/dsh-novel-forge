// test/samples.test.mjs — 写作样稿库（lib/samples.js，借鉴 MirrorNovel writingSamples.js 的
// 样稿库纪律 + referenceDistillation 的「学习风格但不得串入他人设定」边界）。
// 候选池入口唯一（approved + allowedForModelInput）；注入边界文案（prose/revise 两套）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    sampleAdd, sampleAllow, sampleRevoke, sampleRemove, samplePool,
    validSampleRow, renderSamplesPrompt, SAMPLE_LIMITS,
    SAMPLE_PROMPT_RULES_PROSE, SAMPLE_PROMPT_RULES_REVISE,
} from '../lib/samples.js';

const GOOD = '他推开门，雨水顺着门框淌了一地，他没有回头，只把伞立在门边，等那阵雨过去才肯走。'; // 40 字

test('sampleAdd：字数下限/上限守卫', () => {
    assert.throws(() => sampleAdd([], { content: '太短' }), /40–2000/);
    assert.throws(() => sampleAdd([], { content: '字'.repeat(2001) }), /40–2000/);
    const list = sampleAdd([], { content: GOOD, now: 't' });
    assert.equal(list.length, 1);
    assert.equal(list[0].id, 'S1');
    assert.equal(list[0].allowedForModelInput, false, '默认不注入');
    assert.ok(validSampleRow(list[0]));
});

test('sampleAdd：重复 id / 超上限 拒绝', () => {
    const list = sampleAdd([], { content: GOOD, id: 'S9', now: 't' });
    assert.throws(() => sampleAdd(list, { content: GOOD, id: 'S9', now: 't' }), /已存在/);
});

test('候选池入口：只认 approved + allowedForModelInput（草稿/撤销永远查不出）', () => {
    let list = sampleAdd([], { content: GOOD, now: 't' });            // S1 默认未批准
    list = sampleAdd(list, { content: '另一段。'.repeat(10), now: 't' }); // S2 默认未批准（40 字）
    assert.deepEqual(samplePool(list).map((s) => s.id), [], '无批准 → 空池');
    list = sampleAllow(list, 'S1');
    assert.deepEqual(samplePool(list).map((s) => s.id), ['S1']);
    list = sampleAllow(list, 'S2');
    assert.deepEqual(samplePool(list).map((s) => s.id), ['S1', 'S2']);
    // 撤销后查不出来
    list = sampleRevoke(list, 'S1');
    assert.deepEqual(samplePool(list).map((s) => s.id), ['S2']);
});

test('sampleRemove：删除后池同步', () => {
    let list = sampleAdd([], { content: GOOD, now: 't' });
    list = sampleAllow(list, 'S1');
    list = sampleRemove(list, 'S1');
    assert.equal(list.length, 0);
    assert.deepEqual(samplePool(list), []);
});

test('renderSamplesPrompt：空池返回空串（向后兼容）；非空池带 prose 边界', () => {
    const list = sampleAdd([], { content: GOOD, sceneType: 'action', now: 't' });
    assert.equal(renderSamplesPrompt([]), '', '无样稿 → 空串');
    assert.equal(renderSamplesPrompt(list), '', '未批准 → 空池 → 空串');
    const allowed = sampleAllow(list, 'S1');
    const prose = renderSamplesPrompt(allowed, { purpose: 'prose' });
    assert.match(prose, /作者认可的写作样稿/);
    assert.ok(prose.includes(SAMPLE_PROMPT_RULES_PROSE.slice(0, 20)));
    const revise = renderSamplesPrompt(allowed, { purpose: 'revise' });
    assert.ok(revise.includes(SAMPLE_PROMPT_RULES_REVISE.slice(0, 20)));
});

test('renderSamplesPrompt：注入段数与单段字数受 SAMPLE_LIMITS 封顶', () => {
    let list = [];
    for (let i = 0; i < 5; i += 1) {
        list = sampleAdd(list, { content: '段'.repeat(40) + i, now: 't' });
        list = sampleAllow(list, `S${i + 1}`);
    }
    const rendered = renderSamplesPrompt(list, { purpose: 'prose' });
    // 候选池最多 3 段
    const parsed = JSON.parse(rendered.slice(rendered.indexOf('{')));
    assert.equal(parsed.samples.length, SAMPLE_LIMITS.maxExamples, `注入段数封顶 ${SAMPLE_LIMITS.maxExamples}`);
    assert.ok(parsed.samples.every((s) => s.content.length <= SAMPLE_LIMITS.maxExampleChars), '单段字数封顶');
});
