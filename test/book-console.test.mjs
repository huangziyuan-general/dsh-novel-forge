// test/book-console.test.mjs — 「锻炉」数据面解析核心的纯函数门禁。
// 用插件真实数据结构（lib/store.js / lib/ledger.js 同形）喂入，验证摘要正确且绝不崩。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseNovel, parseFacts, currentFacts, parseForeshadows, parseStyle,
    summarizeBook, stageLabel,
} from '../lib/book-console.js';

const SAMPLE_NOVEL = JSON.stringify({
    title: '星尘小记',
    genre: '玄幻',
    logline: '拾骨的旅人。',
    stage: 'drafting',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    approvals: { outline: { 1: 'ts', 2: 'ts', 3: 'ts' } },
    chapters: {
        1: { title: '启程', versions: [1], latest: 1, path: '正文/第1章-启程-v1.md', chars: 3200, summary: 'x' },
        2: { title: '灰谷', versions: [1], latest: 1, chars: 4100 },
        3: { title: '拾骨', versions: [1, 2], latest: 2, chars: 3900 },
    },
    cast: ['林晚', '北望'],
    proposals: [],
});

test('parseNovel: 正常 sketch → 章节/已批准/主角数', () => {
    const n = parseNovel(SAMPLE_NOVEL);
    assert.equal(n.ok, true);
    assert.equal(n.title, '星尘小记');
    assert.equal(n.stage, 'drafting');
    assert.deepEqual(n.chapters, [1, 2, 3]);
    assert.deepEqual(n.approved, [1, 2, 3]);
    assert.equal(n.castCount, 2);
});

test('parseNovel: 缺失/非法 JSON 都降级，不抛', () => {
    const none = parseNovel(null);
    assert.equal(none.ok, false);
    assert.equal(none.missing, true);
    assert.equal(none.title, null);
    const bad = parseNovel('{ not json');
    assert.equal(bad.ok, false);
    assert.match(bad.parseError, /非法 JSON/);
    assert.equal(bad.chapters, null);
});

test('parseFacts + currentFacts: 账本计数与每 entity·key 最新值（同章优先保留后写）', () => {
    const rows = [
        { entity: '林晚', key: '境界', value: '筑基一层', chapter: 1, ts: 't1' },
        { entity: '林晚', key: '境界', value: '筑基三层', chapter: 2, ts: 't2' },
        { entity: '北望', key: '位置', value: '灰谷', chapter: 3, ts: 't3' },
    ];
    const f = parseFacts(JSON.stringify(rows));
    assert.equal(f.ok, true);
    assert.equal(f.rows.length, 3);
    assert.equal(currentFacts(rows).length, 2, '同 entity·key 只留最新');
    const lw = currentFacts(rows).find((r) => r.entity === '林晚');
    assert.equal(lw.value, '筑基三层');
});

test('parseForeshadows: 计数与超期（plan < currentChapter 且未回收）', () => {
    const rows = [
        { id: 'F1', setup: '灰谷的雾', chapter: 1, plan: 5, payoffChapter: null },
        { id: 'F2', setup: '左手骨', chapter: 2, plan: 4, payoffChapter: null },
        { id: 'F3', setup: '旧名', chapter: 3, plan: 6, payoffChapter: 6 },
    ];
    const v = parseForeshadows(JSON.stringify(rows), 5);
    assert.equal(v.ok, true);
    assert.equal(v.total, 3);
    assert.equal(v.open, 2);
    // 过章 5：F1 plan=5（5>5 假→不超期）、F2 plan=4（5>4 真→超期）、F3 已回收不参与 → 1
    assert.equal(v.overdue, 1);
});

test('parseStyle: 基线六维 μ/σ 摘要', () => {
    const s = parseStyle(JSON.stringify({
        book: '星尘小记', chapters: 3, builtAt: '2026-01-02T00:00:00.000Z',
        baseline: { dims: { syntax: { mu: 4.2, sigma: 1.1 }, modifier: { mu: 30, sigma: 8 } } },
    }));
    assert.equal(s.ok, true);
    assert.equal(s.built, true);
    assert.equal(s.chapters, 3);
    assert.equal(s.dims.length, 2);
    assert.equal(s.dims.find((d) => d.key === 'modifier').mu, 30);
});

test('summarizeBook: 一书整体摘要（全字段都给的正常样本）', () => {
    const b = summarizeBook({
        name: '星尘小记',
        novel: SAMPLE_NOVEL,
        facts: JSON.stringify([{ entity: '林晚', key: '境界', value: '筑基三层', chapter: 2 }]),
        foreshadows: JSON.stringify([{ id: 'F1', setup: '雾', chapter: 1, plan: 2, payoffChapter: null }]),
        style: JSON.stringify({ book: '星尘小记', chapters: 3, baseline: { dims: {} }, builtAt: 't' }),
        currentChapter: 3,
    });
    assert.equal(b.title, '星尘小记');
    assert.equal(b.genre, '玄幻');
    assert.equal(b.stageLabel, '正文');
    assert.equal(b.chapters, 3);
    assert.equal(b.approved, 3);
    assert.equal(b.facts, 1);
    assert.equal(b.current[0].value, '筑基三层');
    assert.equal(b.foreshadows.open, 1);
    // 过章 3 > plan 2 → 超期
    assert.equal(b.foreshadows.overdue, 1);
    assert.equal(b.style.built, true);
});

test('summarizeBook: 非书籍/全缺失 → 不抛、字段降级', () => {
    const b = summarizeBook({ name: '空壳' });
    assert.equal(b.title, '空壳');
    assert.equal(b.parseError, null);
    assert.equal(b.chapters, null);
    assert.equal(b.facts, 0);
    assert.equal(b.foreshadows.total, 0);
    assert.equal(b.style.built, false);
});

test('stageLabel: 中文标签刻画', () => {
    assert.equal(stageLabel('planning'), '规划');
    assert.equal(stageLabel('done'), '完结');
    assert.equal(stageLabel('科研'), '科研');
});