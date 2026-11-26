// test/quality-trend.test.mjs — 质量趋势（lib/quality-trend.js 纯函数面）。
//
// 重点锁新加的「题材承诺漂移进趋势面」通道（会话接力盲区补丁）：
//   · riskFlags 出 promise-drift-recent / promise-term-below-recent（近 5 章落过对应债）；
//   · countPromiseDebt 是单一纯实现（按债码数未结条目，不抄第二份读 quality.debts 的判据）；
//   · 旧旗标（hard-debt-recent / noai-rising）与 note 判读不受新旗标干扰；
//   · 序列太短（<4 章）不判方向但旗标照算（旗标是「近 5 章有某债」，与样本量无关）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { qualityTrend, savedNoaiSeries, countPromiseDebt } from '../lib/quality-trend.js';

// 造 N 章的 saved 审计行（noaiScore 固定 80，避免 noai-rising 干扰断言）
const auditOf = (chapters) => chapters.map((c) => JSON.stringify({ action: 'write_chapter/saved', chapter: c, noaiScore: 80 })).join('\n');

// 造 novel.json 的 quality.debts（章号 → 条目；条目形状同 makeDebt）
const debt = (code, level, chapter) => ({ code, level, levelName: '', message: '', chapter, ts: '' });
const novelOf = (debts) => ({ quality: { debts }, chapters: {} });

test('★ countPromiseDebt：按债码数未结条目（单一实现，只认 code）', () => {
    const novel = novelOf({
        5: [debt('promise-drift', 'major', 5), debt('noai', 'minor', 5)],
        9: [debt('promise-term-below', 'minor', 9)],
    });
    assert.equal(countPromiseDebt(novel, [5, 9], 'promise-drift'), 1);
    assert.equal(countPromiseDebt(novel, [5, 9], 'promise-term-below'), 1);
    assert.equal(countPromiseDebt(novel, [5], 'promise-drift'), 1, '只数给定的章号集');
    assert.equal(countPromiseDebt(novel, [7], 'promise-drift'), 0, '没债的章 → 0');
    assert.equal(countPromiseDebt(novel, [5], 'noai'), 1, '非承诺债码也能数（纯按 code）');
    assert.equal(countPromiseDebt(novel, [], 'promise-drift'), 0, '空章号集 → 0');
    assert.equal(countPromiseDebt(null, [5], 'promise-drift'), 0, '无 novel 不炸');
});

test('★ promise-drift 旗标：近 5 章落 promise-drift 债 → 出旗标 + note 提示', () => {
    const novel = novelOf({ 9: [debt('promise-drift', 'major', 9)] });
    const t = qualityTrend(auditOf([6, 7, 8, 9, 10]), novel);
    assert.ok(t.riskFlags.includes('promise-drift-recent'), '近 5 章（含第9章）有批次漂移债');
    assert.match(t.note, /题材承诺批次漂移债/, 'note 点名要回头核对承诺书/大纲');
    assert.ok(!t.riskFlags.includes('promise-term-below-recent'), '两种旗标互不串');
});

test('★ promise-term-below 旗标：近 5 章落条款脱靶债 → 出旗标（与 drift 分列）', () => {
    const novel = novelOf({ 8: [debt('promise-term-below', 'minor', 8)] });
    const t = qualityTrend(auditOf([6, 7, 8, 9, 10]), novel);
    assert.ok(t.riskFlags.includes('promise-term-below-recent'));
    assert.ok(!t.riskFlags.includes('promise-drift-recent'), '只有 term-below 时不掺 drift 旗标');
    assert.match(t.note, /条款脱靶/);
});

test('★ 旗标只认「近 5 章」：漂移债落在 5 章之前 → 不出旗标（不追历史旧账）', () => {
    const novel = novelOf({ 1: [debt('promise-drift', 'major', 1)] });
    // 序列是第 1–5 章，last5=[1..5] 其实含第1章 → 应出；换成第 1–5 但债在第 1 章（仍在 last5）
    const t = qualityTrend(auditOf([1, 2, 3, 4, 5]), novel);
    assert.ok(t.riskFlags.includes('promise-drift-recent'), '第1章在 last5=[1..5] 内 → 出旗标');
    // 债落在序列窗口之外（第 0 章，不在 savedNoaiSeries 序列里）→ 不进 last5
    const novelFar = novelOf({ 0: [debt('promise-drift', 'major', 0)] });
    const t2 = qualityTrend(auditOf([1, 2, 3, 4, 5]), novelFar);
    assert.ok(!t2.riskFlags.includes('promise-drift-recent'), '债所在章不在趋势序列里 → 不追');
});

test('★ 旧旗标与新旗标共存，互不覆盖；无债时全静默', () => {
    const novel = novelOf({
        9: [debt('promise-drift', 'major', 9)],
        10: [debt('outline-banned-forced', 'hard', 10)],
    });
    const t = qualityTrend(auditOf([6, 7, 8, 9, 10]), novel);
    assert.ok(t.riskFlags.includes('hard-debt-recent'), '旧 hard 旗标仍在');
    assert.ok(t.riskFlags.includes('promise-drift-recent'), '新 drift 旗标同时在');
    // 无债 → 没有任何 promise 旗标
    const empty = qualityTrend(auditOf([6, 7, 8, 9, 10]), novelOf({}));
    assert.deepEqual(empty.riskFlags.filter((f) => f.startsWith('promise')), [], '空债表 → 无 promise 旗标');
});

test('★ 序列太短（<4）不判方向，但旗标照算（旗标与样本量解耦）', () => {
    const novel = novelOf({ 3: [debt('promise-term-below', 'minor', 3)] });
    const t = qualityTrend(auditOf([1, 2, 3]), novel);
    assert.equal(t.noaiTrend, null, '3 章不判 noai 方向');
    assert.ok(t.riskFlags.includes('promise-term-below-recent'), '但近 5 章旗标照出');
});

test('savedNoaiSeries：只认带 noaiScore 的 saved 行，同章取最后一版，升序去重', () => {
    const lines = [
        JSON.stringify({ action: 'write_chapter/saved', chapter: 2, noaiScore: 70 }),
        JSON.stringify({ action: 'write_chapter/saved', chapter: 1, noaiScore: 80 }),
        JSON.stringify({ action: 'write_chapter/saved', chapter: 2, noaiScore: 50 }), // 第2章重写过
        JSON.stringify({ action: 'other', chapter: 3, noaiScore: 10 }),             // 非 saved 行跳过
        JSON.stringify({ action: 'write_chapter/saved', chapter: 4 }),             // 无 noaiScore 跳过
        'garbage',
    ].join('\n');
    const rows = savedNoaiSeries(lines);
    assert.deepEqual(rows.map((r) => r.chapter), [1, 2], '升序、去重、只认 saved+noaiScore');
    assert.equal(rows.find((r) => r.chapter === 2).noaiScore, 50, '同章取最后一版');
});
