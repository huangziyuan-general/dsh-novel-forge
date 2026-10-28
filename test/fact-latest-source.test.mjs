// test/fact-latest-source.test.mjs — 「截至第 n 章的最新值」必须只有一份判据。
//
// 这条规则在生产里被手抄了五遍：ledger.queryFacts（简报摘要 factsDigest 的底座）、
// ledger.factsAt（novel_ledger status_at）、book-console.currentFacts（面板账本时间线）、
// content-gate.factStatesAt（内容门禁的过期状态/未知补齐判定）、basis.factsEntries
// （简报依据指纹的账本签名）。1.3.2 修「补录早章把当前值回退」时只改了其中一份，
// 其余各份对**畸形行**的处理互不相同，于是同一份 facts.json 会得出不同的「当前值」：
// 简报把某条告诉模型、内容门禁却看不见它——正是 0.13.6 修过的「供给与检测不对称」，
// 只不过换了个入口。本用例钉住五出口对同一输入给同一个答案。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { queryFacts, factsAt, factsDigest } from '../lib/ledger.js';
import { currentFacts } from '../lib/book-console.js';
import { factStatesAt } from '../lib/content-gate.js';
import { factsEntries } from '../lib/basis.js';

// 三种行混在一起：正常多章演化、补录早章（数组顺序与时间顺序相反）、畸形行（缺章号 / 章号非整数）
const FACTS = [
    { entity: '甲', key: '境界', value: '金丹一层', chapter: 5 },
    { entity: '甲', key: '境界', value: '筑基三层', chapter: 1, note: '补录' },
    { entity: '乙', key: '位置', value: '没有章号的野值' },
    { entity: '丙', key: '持有', value: '章号不是整数', chapter: '3' },
    { entity: '丁', key: '状态', value: '存活', chapter: 2, status: 'confirmed' },
];

const keysOf = (rows) => rows.map((r) => `${r.entity}|${r.key}`).sort();
const EXPECTED_KEYS = ['丁|状态', '甲|境界'];

test('★ 五个出口对「当前值」给同一个答案：畸形行一律不参与竞逐', () => {
    // 1) 写前简报的账本摘要（底座是 queryFacts）
    const digest = factsDigest(FACTS, ['甲', '乙', '丙', '丁']);
    assert.ok(digest.some((l) => l.includes('金丹一层')), '甲·境界 的最新值必须是第5章的金丹一层');
    assert.ok(!digest.some((l) => l.includes('筑基三层')), '补录的早章不许回退当前值');
    assert.equal(digest.some((l) => l.includes('没有章号的野值')), false, '★ 缺章号的行不得成为当前值');
    assert.equal(digest.some((l) => l.includes('章号不是整数')), false, '★ 章号非整数的行不得成为当前值');

    // 2) 工具面 novel_ledger query
    assert.deepEqual(keysOf(queryFacts(FACTS, {})), EXPECTED_KEYS, 'query 与摘要同答案');

    // 3) novel_ledger status_at（时点推演）
    assert.deepEqual(keysOf(factsAt(FACTS, 5, {})), EXPECTED_KEYS, '时点推演同答案');

    // 4) 面板账本时间线
    assert.deepEqual(keysOf(currentFacts(FACTS, 12)), EXPECTED_KEYS, '面板与工具同答案');

    // 5) 内容门禁的状态推演
    const states = factStatesAt(FACTS, 5);
    assert.deepEqual([...states.keys()].sort(), ['丁\0状态', '甲\0境界'], '门禁同答案');
});

test('★ 时点语义不被数组顺序污染：补录行在它的时点之前是当前值、之后不是', () => {
    assert.deepEqual(factsAt(FACTS, 1, {}).map((r) => `${r.entity}|${r.key}=${r.value}`),
        ['甲|境界=筑基三层'], '第1章时看到的就该是筑基三层');
    assert.equal(factsAt(FACTS, 5, { entity: undefined, entities: ['甲'], keys: ['境界'] })[0].value,
        '金丹一层', '第5章必须看到金丹一层（补录不得反超）');
});

test('★ 依据指纹（basis）与门禁同口径：畸形行不进签名，缺章号也不许当成第0章', () => {
    const entries = factsEntries(FACTS);
    assert.deepEqual(entries, ['丁|状态=存活', '甲|境界=金丹一层'].sort(),
        '签名里不得出现缺章号/非整数章号的行（否则指纹在管一条门禁看不见的账）');
});

test('三态仍进签名：confirmed 不加后缀（向后兼容），unknown/pending 必须加', () => {
    const rows = [
        { entity: '甲', key: '境界', value: '筑基', chapter: 1, status: 'confirmed' },
        { entity: '乙', key: '下落', value: '不明', chapter: 1, status: 'unknown', note: '没查' },
        { entity: '丙', key: '身份', value: '路人', chapter: 1, status: 'pending' },
    ];
    const entries = factsEntries(rows);
    assert.ok(entries.includes('甲|境界=筑基'), 'confirmed 不带后缀（老记录不误报漂移）');
    assert.ok(entries.includes('乙|下落=不明|unknown'), 'unknown 必须进签名');
    assert.ok(entries.includes('丙|身份=路人|pending'), 'pending 必须进签名');
    // 大小写/空格归一：与 normalizeFactStatus 同口径（枚举只认 ledger.js 那一份）
    assert.deepEqual(factsEntries([{ entity: '甲', key: 'k', value: 'v', chapter: 1, status: ' UNKNOWN ' }]),
        factsEntries([{ entity: '甲', key: 'k', value: 'v', chapter: 1, status: 'unknown' }]),
        '状态归一不得各写各的');
    assert.deepEqual(factsEntries([{ entity: '甲', key: 'k', value: 'v', chapter: 1, status: '编造的状态' }]),
        ['甲|k=v'], '枚举外的状态按 confirmed 处理（与 normalizeFactStatus 一致）');
});
