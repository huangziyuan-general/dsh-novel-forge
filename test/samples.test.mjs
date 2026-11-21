// test/samples.test.mjs — 写作样稿库（lib/samples.js，借鉴 MirrorNovel writingSamples.js 的
// 样稿库纪律 + referenceDistillation 的「学习风格但不得串入他人设定」边界）。
// 候选池入口唯一（approved + allowedForModelInput）；注入边界文案（prose/revise 两套）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    sampleAdd, sampleAllow, sampleRevoke, sampleRemove, samplePool,
    validSampleRow, renderSamplesPrompt, renderSamplesSection, SAMPLE_LIMITS,
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

// ── 样稿轮转（offset=章号种子）────────────────────────────────────────────
// 红线：同章重跑同组（确定性，不引随机源）；池 ≤ 窗口不轮转（旧行为零回归）；
// 越界种子回卷（offset>池长 按模取，负数/NaN 落回首段）。

function poolOf(n) {
    let list = [];
    for (let i = 1; i <= n; i += 1) {
        list = sampleAdd(list, { content: `第${i}段样稿正文。${'夜色落进纸里。'.repeat(5)}`, now: 't' });
        list = sampleAllow(list, `S${i}`);
    }
    return list;
}

test('★ samplePool 轮转：同章重跑同组，换章换段，确定性不引随机', () => {
    const list = poolOf(6);
    const ids = (offset) => samplePool(list, { limit: 2, offset }).map((s) => s.id);
    assert.deepEqual(ids(0), ['S1', 'S2'], 'offset 0 = 首段起（旧行为）');
    assert.deepEqual(ids(1), ['S2', 'S3'], 'offset 1 = 滚一段');
    assert.deepEqual(ids(3), ['S4', 'S5']);
    // 回卷：offset 越界按模取（6 段池、窗口 2）
    assert.deepEqual(ids(6), ['S1', 'S2'], 'offset=池长 回卷到首段');
    assert.deepEqual(ids(7), ['S2', 'S3']);
    // 确定性：同章重跑两次必须同组（无随机源）
    assert.deepEqual(ids(2), ids(2));
    // 非法种子不炸：NaN/负数落到合法位（NaN→0 首段；负数按模转正）
    assert.deepEqual(ids(NaN), ['S1', 'S2'], 'NaN 种子按 0 处理');
    assert.deepEqual(ids(-1), ['S6', 'S1'], '负种子按模回卷');
});

test('★ samplePool 轮转：池 ≤ 窗口不轮转（旧行为零回归）', () => {
    const list = poolOf(2);
    // 池只有 2 段、窗口 2 —— 全取，offset 无意义
    assert.deepEqual(samplePool(list, { limit: 2, offset: 0 }).map((s) => s.id), ['S1', 'S2']);
    assert.deepEqual(samplePool(list, { limit: 2, offset: 1 }).map((s) => s.id), ['S1', 'S2'], '池=窗口时 offset 不改变结果');
    // 旧调用（不传 offset）行为不变
    assert.deepEqual(samplePool(list).map((s) => s.id), ['S1', 'S2']);
});

test('★ renderSamplesSection/Prompt 透传 offset（章号种子到渲染入口）', () => {
    const list = poolOf(4);
    const a = renderSamplesSection(list, { purpose: 'prose', scope: 'novel', maxExamples: 2, offset: 0 });
    const b = renderSamplesSection(list, { purpose: 'prose', scope: 'novel', maxExamples: 2, offset: 1 });
    assert.notEqual(a, b, '不同 offset 出不同样稿段（轮转生效到渲染）');
    assert.ok(a.includes('[other]') === true);
    // 章号 0（=不传）与显式 0 同组
    assert.equal(renderSamplesSection(list, { maxExamples: 2 }), renderSamplesSection(list, { maxExamples: 2, offset: 0 }));
});
