// test/milestone.test.mjs — 里程碑台账（细纲生成前对齐检查）的核心解析锁。
// 用内联全集大纲 fixture，不依赖真实书目，避免耦合磁盘。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMilestones, milestoneLedger, formatLedger, conceptTerms } from '../lib/milestone.js';

const BOOK = `# 全书大纲

## 六、写作纪律
- 每 10-20 章跑一次全书一致性体检。

### 卷一 · 凡界（第 1-60 章，并发 8→三千）
- 第 1-10 章：码头据点战→夺符、三合一异变（并发 8→32→256）。
- 第 11-30 章：灵枢扩容试炼、石桥立威；北潮据点连拔（单元剧打脸）；潮首浮出水面并总攻（约第 30 章反扑）。
- 第 31-50 章：北潮全面反扑→青岸被掳欲以地脉献祭→断桥破阵救人（约 45-48 章）、结契（约 45-50 章）→潮首覆灭。
- 第 51-60 章：凡界秩序重定、石桥改制；人仙界通道现（第 60 章换图钩子）。
`;

test('parseMilestones：卷头/条目都解析，界域名不进概念', () => {
    const nodes = parseMilestones(BOOK);
    // 卷头(1-60) + 4 条 bullet = 5 个节点
    assert.equal(nodes.length, 5);
    const header = nodes[0];
    assert.equal(header.from, 1);
    assert.equal(header.to, 60);
    // 界域名（凡界）应被 STOP_TERMS 剔除，但档位「三千」保留
    assert.ok(!header.terms.some((t) => t.term === '凡界'));
    assert.ok(header.terms.some((t) => t.term === '三千'));
    // 第 11-30 条带「石桥立威」实体概念
    const n1130 = nodes.find((n) => n.from === 11 && n.to === 30);
    assert.ok(n1130.terms.some((t) => t.term === '石桥立威'));
});

test('milestoneLedger：已写正文命中则不算欠账，逾期零命中列为候选', () => {
    // 已写到第 40 章；第 11-30 节点此时已是 past，进 overdue 而非 active。
    // corpus 里 ch12 含完整子串「石桥立威」→ 命中；ch30 含「总攻」→ 命中；
    // 但「反扑」从未出现 → 第 11-30 节点逾期欠账。
    const chapters = [
        { n: 12, text: '石桥立威的架势在城西摆出来了。' },
        { n: 30, text: '潮首终于露面，发起总攻。' },
    ];
    const ledger = milestoneLedger({ bookOutline: BOOK, chapter: 40, chapters });
    assert.ok(!ledger.active.some((r) => r.from === 11 && r.to === 30), '第 40 章时 11-30 应为 past，不在 active');
    const past1130 = ledger.overdue.find((r) => r.from === 11 && r.to === 30);
    assert.ok(past1130, '第 11-30 章应进 overdue');
    const missed = past1130.missed;
    assert.ok(missed.includes('反扑'), '「反扑」零命中应列为欠账');
    assert.ok(!missed.includes('石桥立威'), '正文含「石桥立威」不应算欠账');
    assert.ok(!missed.includes('总攻'), '正文含「总攻」不应算欠账');
});

test('formatLedger：输出含「尚未兑现」与逾期候选标记', () => {
    const chapters = [{ n: 30, text: '潮首露面。' }]; // 仅让部分命中
    const ledger = milestoneLedger({ bookOutline: BOOK, chapter: 40, chapters });
    const out = formatLedger(ledger);
    assert.match(out, /尚未兑现/);
    assert.match(out, /欠账候选/);
});

test('milestoneLedger：chapter 在区间内标 active，过了标 past', () => {
    const ledger = milestoneLedger({ bookOutline: BOOK, chapter: 70, chapters: [] });
    // fixture 共 5 个节点（卷头 1-60 + 4 条 bullet），对第 70 章全部 past
    assert.equal(ledger.active.length, 0);
    assert.equal(ledger.overdue.length, 5);
    assert.equal(ledger.total, 5);
    assert.equal(ledger.upcoming.length, 0);
});

test('parseMilestones：卷界解析与 volumeSection 同形，并支持条目开区间', () => {
    const outline = [
        '### 卷一（1-40章）',
        '- 第 1-10 章：夺符、立威。',
        '### 卷五（第 71 章起）',
        '- 第 71 章起：北潮反扑、结契。',
    ].join('\n');
    const nodes = parseMilestones(outline);
    assert.deepEqual(nodes.slice(0, 2).map((n) => [n.from, n.to]), [[1, 40], [1, 10]]);
    assert.deepEqual(nodes.slice(2).map((n) => [n.from, n.to === Infinity]), [[71, true], [71, true]]);
    assert.ok(nodes.at(-1).terms.some((t) => t.term === '北潮反扑'));
});

test('formatLedger：当前细纲已回应的词不再冒充未回应', () => {
    const outline = '### 卷一（第 1-20 章）\n- 第 1-20 章：北潮反扑、结契。';
    const ledger = milestoneLedger({
        bookOutline: outline, chapter: 10, chapters: [],
        outlineText: '本章写北潮反扑。',
    });
    const out = formatLedger(ledger);
    assert.match(out, /当前细纲已回应：北潮反扑/);
    assert.match(out, /本章细纲未回应：结契/);
    assert.doesNotMatch(out, /尚未兑现/);
});

test('formatLedger：逾期节点里已排补与仍未安排分开，且回执可截断', () => {
    const outline = '### 卷一（第 1-4 章）\n' + Array.from({ length: 8 }, (_, i) => `- 第 ${i + 1} 章：概念${i}。`).join('\n');
    const ledger = milestoneLedger({
        bookOutline: outline, chapter: 9, chapters: [],
        outlineText: '本章准备概念1。',
    });
    const out = formatLedger(ledger, { maxRows: 2, maxTerms: 2 });
    assert.match(out, /当前细纲已排补：概念1/);
    assert.match(out, /仍未安排：/);
    assert.match(out, /另有 6 个逾期节点未展开/);
    assert.ok(out.length < 1600);
});

test('conceptTerms：度量词保护表护住内含功能字的实体词', () => {
    const terms = conceptTerms('码头据点战→夺符（并发 8→32）。').map((x) => x.term);
    assert.ok(terms.includes('并发'), '并发不应被功能字劈碎');
    assert.ok(!terms.includes('发'), '单字残片不应入表');
});

test('conceptTerms：元注释词不冒充情节点', () => {
    const terms = conceptTerms('北潮反扑、结契（约第 6 章换图钩子）。').map((x) => x.term);
    assert.ok(!terms.includes('换图钩子'), '元注释词不进欠账信号');
    assert.ok(terms.includes('北潮反扑') && terms.includes('结契'), '真情节点保留');
});

test('formatLedger：开区间节点在后续节点里显示「第N章起」而不是 Infinity', () => {
    const outline = '### 卷末（第 9 章起）\n- 第 9 章起：终局决战。';
    const ledger = milestoneLedger({ bookOutline: outline, chapter: 3, chapters: [] });
    const out = formatLedger(ledger);
    assert.ok(out.includes('第9章起'), '开区间用「第N章起」显示');
    assert.ok(!out.includes('Infinity'), 'Infinity 不外漏');
});
