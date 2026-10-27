// test/ledger-tristate.test.mjs — 事实账本三态（confirmed/unknown/pending）
// 与内容门禁的「未知补齐」检查。
//
// 要治的病：设定里没写的，模型自己编一个填进正文——那个编的值随后落进账本，
// 就成了「事实」。本项目此前的账本只有「当前值 + 历史值」，**没有「未知」态**，
// 所以模型面对空白时唯一的合法动作就是填一个值进去。
//
// 三态各司其职：
//   confirmed —— 已确认，正文可依据；
//   unknown   —— 明确未知（且必须带原因）：正文**不得**替它补齐；
//   pending   —— 待复核（候选值）：可以写进正文，但要像未定论。
//
// 「未知不得被补齐」这条要真能挡住，必须有代码判定——所以有第 ⑥ 维内容门禁
// （lib/content-gate.js 的 detectUnknownFills）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyFactUpdates, queryFacts, factsAt, statusTimeline, factsDigest, FACT_STATUS } from '../lib/ledger.js';
import { detectUnknownFills, contentGate } from '../lib/content-gate.js';
import { parseFactLines } from '../lib/tools/common.js';
import { bootPlugin, chapterOf } from './helpers/plugin.mjs';

const NOW = '2026-10-27T12:00:00.000Z';

test('三态常量：就这三个词', () => {
    assert.deepEqual(FACT_STATUS, ['confirmed', 'unknown', 'pending']);
});

test('账本三态：status 落库、默认值 confirmed', () => {
    const r = applyFactUpdates([], [
        { entity: '甲', key: '境界', value: '筑基三层' },
        { entity: '乙', key: '身世', value: '未知', note: '作者还没定', status: 'unknown' },
        { entity: '丙', key: '位置', value: '城南', status: 'pending' },
    ], { chapter: 1, now: NOW });
    assert.equal(r.added.length, 3);
    assert.equal(r.added[0].status, 'confirmed', '缺省是 confirmed');
    assert.equal(r.added[1].status, 'unknown');
    assert.equal(r.added[2].status, 'pending');
});

test('status=unknown 必须带原因（未知要有边界，否则它会变成挡箭牌）', () => {
    assert.throws(
        () => applyFactUpdates([], [{ entity: '乙', key: '身世', value: '未知', status: 'unknown' }], { chapter: 1, now: NOW }),
        /未知原因/,
    );
    // 带原因就放行
    const ok = applyFactUpdates([], [{ entity: '乙', key: '身世', value: '未知', note: '作者还没定', status: 'unknown' }], { chapter: 1, now: NOW });
    assert.equal(ok.added.length, 1);
});

test('同章内同键同值但状态不同 → 冲突（状态也是终态，不能靠第二次 update 悄悄改）', () => {
    const first = applyFactUpdates([], [{ entity: '乙', key: '身世', value: '未知', note: '还没定', status: 'unknown' }], { chapter: 1, now: NOW });
    const second = applyFactUpdates(first.facts, [{ entity: '乙', key: '身世', value: '未知', status: 'confirmed', note: '' }], { chapter: 1, now: NOW });
    assert.equal(second.conflicts.length, 1, '必须报冲突');
    assert.match(second.conflicts[0].reason, /只落一行终态/);
});

test('跨章改状态 → 正常留历史（不是冲突）', () => {
    const first = applyFactUpdates([], [{ entity: '乙', key: '身世', value: '未知', note: '还没定', status: 'unknown' }], { chapter: 1, now: NOW });
    const second = applyFactUpdates(first.facts, [{ entity: '乙', key: '身世', value: '身世已定', status: 'confirmed', note: '第5章落定' }], { chapter: 5, now: NOW });
    assert.equal(second.conflicts.length, 0);
    assert.equal(second.added.length, 1);
});

test('旧账本记录没有 status 字段 → 一律按 confirmed 读（向后兼容）', () => {
    const old = [{ entity: '甲', key: '境界', value: '筑基三层', chapter: 1, note: '', ts: NOW }];
    assert.equal(queryFacts(old, {})[0].status, 'confirmed');
    assert.equal(factsAt(old, 5)[0].status, 'confirmed');
    assert.equal(statusTimeline(old, '甲')[0].status, 'confirmed');
});

test('事实摘要：unknown 行必须显形成「未知」（模型看不见就会替它编一个值）', () => {
    const facts = applyFactUpdates([], [
        { entity: '甲', key: '境界', value: '筑基三层' },
        { entity: '乙', key: '身世', value: '未知', note: '作者还没定', status: 'unknown' },
    ], { chapter: 1, now: NOW }).facts;
    const rows = factsDigest(facts, []);
    assert.ok(rows.some((r) => r.includes('甲·境界: 筑基三层')), `普通事实照旧：${rows.join(' | ')}`);
    const unknownRow = rows.find((r) => r.startsWith('乙·身世'));
    assert.ok(unknownRow.includes('未知'), `未知项必须显形：${unknownRow}`);
    assert.ok(unknownRow.includes('作者还没定'), '原因要带出来');
    assert.ok(unknownRow.includes('不得替它补'), '要写清楚不许补齐');
});

test('事实行解析：状态字段在第 4 段或第 5 段都认', () => {
    const rows = parseFactLines([
        '甲|境界|筑基三层',
        '乙|身世|未知|unknown',
        '丙|位置|城南|待复核|pending',
        '丁|来历|不详|作者没交代',
    ].join('\n'));
    assert.equal(rows[0].status, 'confirmed');
    assert.equal(rows[0].note, '');
    assert.equal(rows[1].status, 'unknown');
    assert.equal(rows[1].note, '');
    assert.equal(rows[2].status, 'pending');
    assert.equal(rows[2].note, '待复核');
    assert.equal(rows[3].status, 'confirmed', '第 4 段不是状态词就当备注');
    assert.equal(rows[3].note, '作者没交代');
});

// ── 未知补齐检测 ────────────────────────────────────────────────────────────

const FACTS = applyFactUpdates([], [
    { entity: '测试角色', key: '境界', value: '未知', note: '作者还没定', status: 'unknown' },
], { chapter: 1, now: NOW }).facts;

test('未知补齐：正文断言了具体值 → 抓出来', () => {
    const hits = detectUnknownFills({
        content: '雨还在下。\n\n测试角色的境界是筑基三层了。\n\n他把手里的伞收了。',
        facts: FACTS,
        chapter: 1,
    });
    assert.equal(hits.length, 1, `必须抓到：${JSON.stringify(hits)}`);
    assert.equal(hits[0].entity, '测试角色');
    assert.equal(hits[0].key, '境界');
    assert.equal(hits[0].value, '筑基三层');
});

test('未知补齐：正文守住「未知」不算补齐（境界是不明 / 至今不明）', () => {
    assert.equal(detectUnknownFills({ content: '测试角色的境界是不明。', facts: FACTS, chapter: 1 }).length, 0);
    assert.equal(detectUnknownFills({ content: '测试角色的境界至今不明。', facts: FACTS, chapter: 1 }).length, 0);
    assert.equal(detectUnknownFills({ content: '测试角色的境界不得而知。', facts: FACTS, chapter: 1 }).length, 0);
});

test('未知补齐：同段里没有该实体 → 不归因（宁可漏判不可误判）', () => {
    const hits = detectUnknownFills({
        content: '旁人的境界是金丹。\n\n测试角色站在雨里，什么也没说。',
        facts: FACTS,
        chapter: 1,
    });
    assert.equal(hits.length, 0, `不该抓到别人的属性：${JSON.stringify(hits)}`);
});

test('未知补齐：已确认的事实不受影响（断言已确认的值是正常的）', () => {
    const confirmed = applyFactUpdates([], [{ entity: '测试角色', key: '境界', value: '筑基三层' }], { chapter: 1, now: NOW }).facts;
    assert.equal(detectUnknownFills({ content: '测试角色的境界是筑基三层。', facts: confirmed, chapter: 1 }).length, 0);
});

test('内容门禁：未知补齐是阻断级（contentGate.ok 必须为 false）', () => {
    const g = contentGate({
        content: '测试角色的境界是筑基三层。',
        chapter: 1,
        facts: FACTS,
    });
    assert.equal(g.ok, false, '必须拦下');
    assert.ok(g.blocking.some((b) => b.code === 'unknown-fact-filled'), `必须点名：${g.blocking.map((b) => b.code).join('、')}`);
    assert.match(g.blocking.find((b) => b.code === 'unknown-fact-filled').message, /未知/);
});

// ── 端到端 ──────────────────────────────────────────────────────────────────

const OUTLINE = [
    '第1章：雨夜来客。出场：测试角色。事件：收殓无名的尸体。',
    '',
    '## 本章必写场景',
    '- 雨夜停尸房：验尸的动作要点、雨声与油灯的环境要点、与来客的对话要点',
    '- 无名尸体：布鞋留在门槛的动作要点、红泥印记的线索要点、收殓入殓的处置要点',
].join('\n');

async function bootBook(book) {
    const p = await bootPlugin({ config: { minChapterChars: 300, maxChapterChars: 5000 } });
    const { tool, exec } = p;
    await tool('novel_project').execute({ action: 'init', book, title: book }, exec);
    await tool('novel_outline').execute({ action: 'save_chapter', book, chapter: 1, outline: OUTLINE }, exec);
    await tool('novel_outline').execute({ action: 'approve', book, chapter: 1 }, exec);
    return p;
}

test('★ 端到端：账本标 unknown → 正文替它补了值 → 写章被拒', async () => {
    const p = await bootBook('未知书');
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_ledger').execute({
            action: 'update', book: '未知书', chapter: 1,
            updates: '测试角色|境界|未知|作者还没定这一层的境界|unknown',
        }, exec);

        await assert.rejects(
            async () => tool('novel_write_chapter').execute({
                book: '未知书', chapter: 1, title: '雨夜来客',
                content: `${chapterOf(400)}\n\n测试角色的境界是筑基三层。`,
                summary: '来客留鞋',
            }, exec),
            (err) => {
                assert.match(String(err?.message ?? err), /未知/, `驳回文案要点名「未知」：${err?.message ?? err}`);
                assert.match(String(err?.message ?? err), /不得替设定补一个值/, '要说清为什么拦');
                return true;
            },
        );
    } finally {
        cleanup();
    }
});

test('端到端：正文守住「未知」→ 放行（不能把好写法也拦了）', async () => {
    const p = await bootBook('守未知书');
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_ledger').execute({
            action: 'update', book: '守未知书', chapter: 1,
            updates: '测试角色|境界|未知|作者还没定这一层的境界|unknown',
        }, exec);
        const r = await tool('novel_write_chapter').execute({
            book: '守未知书', chapter: 1, title: '雨夜来客',
            content: `${chapterOf(400)}\n\n测试角色的境界至今不明。`,
            summary: '来客留鞋',
        }, exec);
        assert.ok(r.path, '必须落盘成功');
        assert.ok(!r.warnings.join('\n').includes('不得替设定补一个值'), '不该报补齐告警');
    } finally {
        cleanup();
    }
});

test('★ 三态字段进了 output.schema（漏声明就是 INVALID_TOOL_OUTPUT）', async () => {
    const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
    const p = await bootBook('校验书');
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_ledger').execute({
            action: 'update', book: '校验书', chapter: 1,
            updates: '测试角色|境界|未知|作者还没定这一层的境界|unknown',
        }, exec);
        const ledger = tool('novel_ledger');
        for (const args of [
            { action: 'query', book: '校验书' },
            { action: 'status_at', book: '校验书', at: 1 },
            { action: 'timeline', book: '校验书', entity: '测试角色' },
        ]) {
            const v = await ledger.execute(args, exec);
            assert.deepEqual(validateJsonSchemaValue(ledger.output.schema, v), [],
                `novel_ledger ${args.action} 的输出被宿主校验器判违规`);
        }
        const write = tool('novel_write_chapter');
        const w = await write.execute({
            book: '校验书', chapter: 1, title: '雨夜来客',
            content: chapterOf(400), summary: '来客留鞋',
            facts_updates: '测试角色|位置|城南',
        }, exec);
        assert.deepEqual(validateJsonSchemaValue(write.output.schema, w), [],
            'novel_write_chapter 的输出（addedFacts 带 status）被宿主校验器判违规');
        assert.equal(w.addedFacts[0].status, 'confirmed');
    } finally {
        cleanup();
    }
});
