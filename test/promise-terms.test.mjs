// test/promise-terms.test.mjs — 题材承诺可机判条款（lib/promise-terms.js 纯函数面 + P2/P3 债判定）。
//
// 五条红线：
//   · 段落解析「## 可核验条款」行式「要素|关键词|每章最低命中」，坏行进 errors 不炸整批；
//     无段落（存量承诺书）→ 零条款零错（旧书零回归）；
//   · 单章词频核对：below 判据（命中 < minHits），关键词逐字计数；
//   · 批次漂移判据「起步强、收尾塌」：baseline≥0.6 且末批 <0.5 且跌 ≥0.4 才算 drift——
//     开书就没兑现的条款不算漂移（那是一贯没写，不是一贯写了后来不写）；
//   · promiseDebtItems：P2 近 3 章（含本章）≥2 章脱靶才落 minor；P3 仅 10 章批界落 major；
//     无条款全静默；前章正文缺失不假装达标；
//   · 简报渲染段：无条款返回 ''（整段省略），有则列各条款脱靶/达标。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    parsePromiseTerms, checkPromiseTerms, promiseDriftSeries, promiseDebtItems,
    renderPromiseTermSection,
} from '../lib/promise-terms.js';

const PROMISE_MD = [
    '# 故事承诺书',
    '',
    '本书承诺每章有笑点、师徒互动不断。',
    '',
    '## 可核验条款',
    '师徒互动|师傅,徒弟,拜师|1',
    '每章爆笑|笑,乐,哈,逗|2',
    '',
    '## 其它自由承诺（不机判）',
    '写崩了要重写|崩|1',   // 段落外的行不抽（「## 其它…」清段）
].join('\n');

test('★ parse：段落内条款抽出、段外行不掺、坏行进 errors', () => {
    const { terms, errors } = parsePromiseTerms(PROMISE_MD);
    assert.equal(terms.length, 2, '只抽「## 可核验条款」段的两条');
    assert.deepEqual(terms[0], { name: '师徒互动', keywords: ['师傅', '徒弟', '拜师'], minHits: 1 });
    assert.equal(terms[1].minHits, 2);
    assert.equal(errors.length, 0);
    assert.ok(!terms.some((t) => t.name === '写崩了要重写'), '段外行不抽（自由承诺不机判）');
    // 坏行
    const bad = parsePromiseTerms('## 可核验条款\n缺词|\n坏数|词|abc');
    assert.equal(bad.terms.length, 0);
    assert.equal(bad.errors.length, 2, '坏行进 errors 不炸整批');
    // 无段落 / 空输入
    assert.deepEqual(parsePromiseTerms(''), { terms: [], errors: [] });
    assert.deepEqual(parsePromiseTerms('# 承诺书\n自由散文，无结构化段。'), { terms: [], errors: [] }, '存量承诺书零条款（旧书零回归）');
});

test('★ check：below 判据（命中 < minHits 脱靶）+ 逐字计数', () => {
    const terms = parsePromiseTerms(PROMISE_MD).terms;
    const hit = checkPromiseTerms('师傅说：徒弟你笑了两次', terms);
    const a = hit.find((c) => c.name === '师徒互动');
    assert.equal(a.hits, 2, '师傅×1 + 徒弟×1');
    assert.equal(a.below, false, '≥1 达标');
    const b = hit.find((c) => c.name === '每章爆笑');
    assert.equal(b.hits, 1, '笑×1');
    assert.equal(b.below, true, '需 ≥2，命中 1 → 脱靶');
    // 空文本
    const empty = checkPromiseTerms('', terms);
    assert.ok(empty.every((c) => c.below), '空正文全条款脱靶');
    // 无条款 → 空数组（调用方整维静默）
    assert.deepEqual(checkPromiseTerms('x', []), []);
});

const CH = (no, text) => ({ no, content: text });

// 前 20 章达标（两条条款都覆盖：师徒≥1、爆笑≥2）、后 20 章全塌（零命中）→ 漂移
const STRONG = Array.from({ length: 20 }, (_, i) => CH(i + 1, '师傅教徒弟，弟子笑得乐呵呵'));
const FLAT = Array.from({ length: 20 }, (_, i) => CH(i + 21, '他推开门，走进屋子'));
const TERMS = parsePromiseTerms(PROMISE_MD).terms;

test('★ 漂移判据：起步强收尾塌 → drifted；一贯无兑现 → 不算漂移（不冤枉一贯没写的书）', () => {
    const d = promiseDriftSeries([...STRONG, ...FLAT], TERMS);
    assert.equal(d.drifted, true, '前批 1.0 → 末批 0 → 漂移');
    assert.ok(d.baseline >= 0.6);
    assert.ok(d.floor < 0.5);
    assert.equal(d.series.length, 4, '40 章 / 10 章批 = 4 批');
    // 全程达标 → 不漂移
    const good = promiseDriftSeries(STRONG, TERMS);
    assert.equal(good.drifted, false);
    assert.equal(good.floor, 1);
    // 一贯全塌（开书就没兑现）→ 不算「漂移」（没有「起步强」的前半段可比）
    const flat = promiseDriftSeries(FLAT, TERMS);
    assert.equal(flat.drifted, false, '全程 0 不是漂移（是一贯没写，债另有通道）');
});

test('★ promiseDebtItems：P2 近 3 章 ≥2 章脱靶落 minor；单章脱靶不落；无条款全静默', () => {
    const term = [{ name: '师徒', keywords: ['师傅', '徒弟'], minHits: 1 }];
    // 本章 + 前 2 章都脱靶 → minor
    const both = promiseDebtItems({
        content: '推门进屋', chapter: 5,
        history: [CH(3, '走路'), CH(4, '吃饭')],
        terms: term,
    });
    assert.ok(both.some((i) => i.code === 'promise-term-below'), '3/3 脱靶落 minor');
    // 单章脱靶（前 2 章都达标）→ 不落（信号攒够才成债）
    const one = promiseDebtItems({
        content: '推门进屋', chapter: 5,
        history: [CH(3, '师傅来了'), CH(4, '徒弟笑')],
        terms: term,
    });
    assert.ok(!one.some((i) => i.code === 'promise-term-below'), '单章脱靶不落债');
    // 前章正文缺失（no<1 过滤 + 缺失章不参与计数）
    const gap = promiseDebtItems({
        content: '推门进屋', chapter: 5,
        history: [CH(4, '推门进屋')], // 只有前 1 章缺 1 章 → 窗口内脱靶 2 章仍落
        terms: term,
    });
    assert.ok(gap.some((i) => i.code === 'promise-term-below'), '窗口内 2 章脱靶仍落（缺章不假装达标，也不阻止记账）');
    // 无条款 → 空
    assert.deepEqual(promiseDebtItems({ content: 'x', chapter: 5, history: [], terms: [] }), []);
});

test('★ P3 仅 10 章批界落 major：第 29 章不报、第 30 章报（同批漂移 10 章内只落一条）', () => {
    const term = [{ name: '师徒', keywords: ['师傅'], minHits: 1 }];
    // 前 20 章强（覆盖率 1.0）、21-30 全塌（0）：3 批时间线 1.0 → 1.0 → 0.0，起步强收尾塌
    const strong20 = Array.from({ length: 20 }, (_, i) => CH(i + 1, '师傅带徒弟修炼，天天笑'));
    const weak10 = Array.from({ length: 10 }, (_, i) => CH(i + 21, '推门进屋，天黑了'));
    // 第 29 章非批界：窗口内强、批界外，drift 债不落（P2 窗口脱靶也不够：前 2 章达标）
    const at29 = promiseDebtItems({ content: '推门进屋', chapter: 29, history: [...strong20, ...weak10.slice(0, 8)], terms: term });
    assert.ok(!at29.some((i) => i.code === 'promise-drift'), '第 29 章非批界，不落 drift 债');
    // 第 30 章批界：前 29 章（20 强 + 9 弱）+ 本章弱 → 时间线漂移
    const at30 = promiseDebtItems({ content: '推门进屋', chapter: 30, history: [...strong20, ...weak10], terms: term });
    assert.ok(at30.some((i) => i.code === 'promise-drift'), '第 30 章批界 + 起步强收尾塌 → major');
    // 全程达标走到批界 → 不落
    const good30 = promiseDebtItems({ content: '师傅来了', chapter: 30, history: Array.from({ length: 29 }, (_, i) => CH(i + 1, '师傅在修炼')), terms: term });
    assert.ok(!good30.some((i) => i.code === 'promise-drift'), '全程达标不冤枉');
});

test('renderPromiseTermSection：无条款 → 空串；有 → 列脱靶/达标 + 纪律说明', () => {
    assert.equal(renderPromiseTermSection([], []), '');
    const body = renderPromiseTermSection(TERMS, [CH(99, '师傅说徒弟笑了两次，大家乐翻了')]);
    assert.match(body, /最近一章（第99章）/, '带最近章号');
    assert.match(body, /✓ 师徒互动/, '达标条款 ✓');
    assert.match(body, /脱靶|✓/, '逐条款状态');
    assert.match(body, /不判死刑/, '纪律说明在场');
    // 无最近章（新书写第 1 章）→ 不列章态、纪律说明仍在
    const fresh = renderPromiseTermSection(TERMS, []);
    assert.ok(fresh !== '');
    assert.ok(!/最近一章/.test(fresh), '无最近章不掺章态');
});
