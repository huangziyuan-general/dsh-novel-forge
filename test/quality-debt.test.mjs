// test/quality-debt.test.mjs — 质量债分级：局部问题不阻塞全书（lib/quality-debt.js）。
//
// 补的是门禁体系的**视角缺口**：门禁只有 blocking/warnings 两档 + 章级熔断。
// 熔断是章级的（同章驳回 3 次锁死）——没问题；但缺**书级**视角：第 30 章有个
// 非致命瑕疵，不该让作者觉得整本书写不下去了。`noai` 扣分、平台审稿的警告项、
// 被 force 放行的硬门禁，本质上就该是「记着的债」，不是「必须当场清零的失败」。
//
// 这组测试钉住四件事：
//   ① 三级口径（minor / major / hard）与代码→级别的映射表不得漂移；
//   ② 债表按章号覆盖（不可变条目，不是计数器）；
//   ③ 书级视图给的是「能不能继续写」的**行动结论**，不是一堆警告；
//   ④ 端到端：写章落盘 → 债进 novel.json.quality.debts → 工具能查能结清。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    DEBT_CODES, DEBT_LEVELS, accumulateDebt, actionableLine, bookQualityView,
    debtLevelOf, makeDebt, worstLevelOf,
} from '../lib/quality-debt.js';
import { bootPlugin, chapterOf } from './helpers/plugin.mjs';

// ── 分级口径 ────────────────────────────────────────────────────────────────

test('三级口径：minor 质量债 / major 需重规划 / hard 硬门禁放行', () => {
    assert.deepEqual(Object.keys(DEBT_LEVELS).sort(), ['hard', 'major', 'minor']);
    assert.equal(DEBT_LEVELS.minor.action, 'defer_and_continue');
    assert.equal(DEBT_LEVELS.major.action, 'stop_for_replan');
    assert.equal(DEBT_LEVELS.hard.action, 'hard_gate');
});

test('债目代码 → 级别：映射表不得漂移', () => {
    assert.equal(debtLevelOf('scene-not-covered'), 'minor');
    assert.equal(debtLevelOf('pacing-brake-warn'), 'major');
    assert.equal(debtLevelOf('basis-stale'), 'major');
    assert.equal(debtLevelOf('pacing-brake-forced'), 'hard');
    assert.equal(debtLevelOf('content-gate-forced'), 'hard');
});

test('未知代码按 minor（别把没登记的东西算成大事）', () => {
    assert.equal(debtLevelOf('根本没登记过的码'), 'minor');
    assert.equal(debtLevelOf(undefined), 'minor');
});

test('造债：形状固定，带级别名', () => {
    const d = makeDebt({ code: 'basis-stale', message: '简报过期', chapter: 30, ts: '2026-10-27T00:00:00.000Z' });
    assert.equal(d.code, 'basis-stale');
    assert.equal(d.level, 'major');
    assert.equal(d.levelName, '需重规划');
    assert.equal(d.chapter, 30);
    assert.equal(d.message, '简报过期');
});

// ── 债表 ────────────────────────────────────────────────────────────────────

test('债表：按章号覆盖（不可变条目，不是计数器）', () => {
    let debts = {};
    debts = accumulateDebt(debts, 3, [makeDebt({ code: 'scene-not-covered', message: 'a', chapter: 3 })]);
    debts = accumulateDebt(debts, 7, [makeDebt({ code: 'basis-stale', message: 'b', chapter: 7 })]);
    assert.deepEqual(Object.keys(debts).sort(), ['3', '7']);
    assert.equal(debts['3'].length, 1);
    // 同一章再记一次 → 覆盖，不是追加（并发写同书时计数键最容易算错）
    debts = accumulateDebt(debts, 3, [makeDebt({ code: 'noai', message: 'c', chapter: 3 })]);
    assert.equal(debts['3'].length, 1);
    assert.equal(debts['3'][0].code, 'noai');
});

test('债表：空债目不写键（不留空壳）', () => {
    const debts = accumulateDebt({}, 5, []);
    assert.deepEqual(Object.keys(debts), []);
});

// ── 书级视图 ────────────────────────────────────────────────────────────────

const novelWith = (debts) => ({ quality: { debts } });

test('书级视图：空账 → 干净，可以放心写', () => {
    const v = bookQualityView({});
    assert.equal(v.total, 0);
    assert.match(v.actionable, /干净/);
    assert.equal(v.worst, null);
});

test('★ 书级视图：只有 minor → 明确说「不阻塞全书」（这是本模块存在的意义）', () => {
    const v = bookQualityView(novelWith({
        3: [makeDebt({ code: 'scene-not-covered', message: 'x', chapter: 3 })],
        4: [makeDebt({ code: 'noai', message: 'y', chapter: 4 })],
    }));
    assert.equal(v.total, 2);
    assert.equal(v.byLevel.minor, 2);
    assert.equal(v.byLevel.major, 0);
    assert.equal(v.byLevel.hard, 0);
    assert.match(v.actionable, /不阻塞全书/);
    assert.match(v.actionable, /继续写/);
});

test('书级视图：有 major → 建议停下重规划', () => {
    const v = bookQualityView(novelWith({
        30: [makeDebt({ code: 'basis-stale', message: 'x', chapter: 30 })],
    }));
    assert.equal(v.byLevel.major, 1);
    assert.match(v.actionable, /需重规划/);
    assert.match(v.actionable, /第 30 章/);
});

test('书级视图：有 hard → 必须回头核对（优先级高于一切）', () => {
    const v = bookQualityView(novelWith({
        10: [makeDebt({ code: 'noai', message: 'x', chapter: 10 })],
        20: [makeDebt({ code: 'content-gate-forced', message: 'y', chapter: 20 })],
    }));
    assert.equal(v.byLevel.hard, 1);
    assert.match(v.actionable, /force/);
    assert.match(v.actionable, /必须回头核对/);
});

test('书级视图：最重的一章 = 级别最重的那章', () => {
    const v = bookQualityView(novelWith({
        5: [makeDebt({ code: 'noai', message: 'x', chapter: 5 })],
        30: [makeDebt({ code: 'basis-stale', message: 'y', chapter: 30 })],
        40: [makeDebt({ code: 'pacing-brake-forced', message: 'z', chapter: 40 })],
    }));
    assert.equal(v.worst.chapter, 40);
    assert.equal(v.worst.level, 'hard');
    assert.deepEqual(v.chapters.map((c) => c.chapter), [5, 30, 40]);
});

test('最重一档：none / minor / major / hard', () => {
    assert.equal(worstLevelOf([]), 'none');
    assert.equal(worstLevelOf([{ level: 'minor' }]), 'minor');
    assert.equal(worstLevelOf([{ level: 'minor' }, { level: 'major' }]), 'major');
    assert.equal(worstLevelOf([{ level: 'major' }, { level: 'hard' }]), 'hard');
    // 没写 level 的条目按 code 推
    assert.equal(worstLevelOf([{ code: 'basis-stale' }]), 'major');
});

test('行动结论：空账与有账给的答复必须不同（不许糊一句套话）', () => {
    assert.notEqual(actionableLine({ total: 0, byLevel: {} }), actionableLine({ total: 1, byLevel: { minor: 1 } }));
});

// ── 端到端（写章提交链 → 债落盘 → 工具查/结清）────────────────────────────

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

test('★ 端到端：写章的警告落成质量债，进 novel.json.quality.debts', async () => {
    const p = await bootBook('质量债书');
    const { tool, exec, cleanup, readJson } = p;
    try {
        // 正文不覆盖细纲的必写场景 → 该章欠一笔 minor 质量债（局部瑕疵，不拦稿）
        const r = await tool('novel_write_chapter').execute({
            book: '质量债书', chapter: 1, title: '雨夜来客',
            content: chapterOf(400),
            summary: '来客留鞋',
        }, exec);
        assert.ok(r.path, '必须落盘成功——质量债是「欠着」，不是「拒稿」');
        assert.ok(r.qualityDebt, '回执必须带质量债字段');
        assert.equal(r.qualityDebt.level, 'minor');
        assert.ok(r.qualityDebt.items.some((i) => i.code === 'scene-not-covered'),
            `应记下必写场景未覆盖：${JSON.stringify(r.qualityDebt.items)}`);

        const novel = readJson('质量债书/novel.json');
        const debts = novel.quality?.debts?.['1'];
        assert.ok(Array.isArray(debts) && debts.length > 0, `债必须落盘：${JSON.stringify(novel.quality)}`);
        assert.equal(debts[0].level, 'minor');
        assert.equal(debts[0].chapter, 1);
        assert.ok(typeof debts[0].ts === 'string' && debts[0].ts !== '', '债要带时间戳');
    } finally {
        cleanup();
    }
});

test('★ 端到端：novel_quality 能查账、能结清（局部瑕疵结清后不算还欠）', async () => {
    const p = await bootBook('查账书');
    const { tool, exec, cleanup, readJson } = p;
    try {
        await tool('novel_write_chapter').execute({
            book: '查账书', chapter: 1, title: '雨夜来客',
            content: chapterOf(400),
            summary: '来客留鞋',
        }, exec);

        const view = await tool('novel_quality').execute({ action: 'view', book: '查账书' }, exec);
        assert.ok(view.total > 0, '查得到账');
        assert.equal(view.byLevel.minor, view.total);
        assert.match(view.actionable, /不阻塞全书/);

        const settled = await tool('novel_quality').execute({ action: 'settle', book: '查账书', chapter: 1 }, exec);
        assert.equal(settled.total, 0, '结清后这本书不欠债了');
        assert.match(settled.actionable, /干净/);

        const novel = readJson('查账书/novel.json');
        assert.deepEqual(novel.quality.debts['1'], [], '该章的债条目清空');
        assert.ok(Array.isArray(novel.quality.settled['1']), '结清要留一笔记录');
    } finally {
        cleanup();
    }
});

test('★ 质量债字段进了 output.schema（漏声明就是 INVALID_TOOL_OUTPUT）', async () => {
    const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
    const p = await bootBook('校验书');
    const { tool, exec, cleanup } = p;
    try {
        const write = tool('novel_write_chapter');
        const w = await write.execute({
            book: '校验书', chapter: 1, title: '雨夜来客',
            content: chapterOf(400), summary: '来客留鞋',
        }, exec);
        assert.deepEqual(validateJsonSchemaValue(write.output.schema, w), [],
            'novel_write_chapter 的输出（带 qualityDebt）被宿主校验器判违规');
        assert.ok(w.qualityDebt.items.length > 0, '质量债字段不能是空壳');

        const quality = tool('novel_quality');
        for (const args of [
            { action: 'view', book: '校验书' },
            { action: 'settle', book: '校验书', chapter: 1 },
        ]) {
            const v = await quality.execute(args, exec);
            assert.deepEqual(validateJsonSchemaValue(quality.output.schema, v), [],
                `novel_quality ${args.action} 的输出被宿主校验器判违规`);
        }
    } finally {
        cleanup();
    }
});

test('★ settle 无债路径的 worst 必须裁剪：别章还欠债时，回传 worst 只许 {chapter,level}', async () => {
    const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
    const p = await bootBook('裁剪书');
    const { tool, exec, cleanup, readJson, writeJson } = p;
    try {
        await tool('novel_write_chapter').execute({
            book: '裁剪书', chapter: 1, title: '雨夜来客',
            content: chapterOf(400), summary: '来客留鞋',
        }, exec);
        // bookQualityView 的 worst 是整行 {chapter,level,items}——原实现在无债 settle
        // 路径里 `worst: view0.worst ?? undefined` 原样回传，items 撞 worst 的
        // additionalProperties:false → INVALID_TOOL_OUTPUT。复现条件恰恰是
        // 「结清的这章没债、别的章还有债」——上面的单章用例打不中它，这里注入第 2 章的债。
        const novel = readJson('裁剪书/novel.json');
        novel.quality = {
            ...(novel.quality ?? {}),
            debts: {
                ...(novel.quality?.debts ?? {}),
                '2': [makeDebt({ code: 'basis-stale', message: '注入的测试债', chapter: 2, ts: '2026-10-28T00:00:00.000Z' })],
            },
        };
        writeJson('裁剪书/novel.json', novel);

        const quality = tool('novel_quality');
        await quality.execute({ action: 'settle', book: '裁剪书', chapter: 1 }, exec); // 有债路径
        const v = await quality.execute({ action: 'settle', book: '裁剪书', chapter: 1 }, exec); // 无债路径
        assert.ok(v.total > 0, '前置：别章（第2章）还欠着债');
        assert.deepEqual(validateJsonSchemaValue(quality.output.schema, v), [],
            '★ 无债 settle 的输出被宿主校验器判违规（worst 带了 items）');
        if (v.worst !== undefined) {
            assert.deepEqual(Object.keys(v.worst).sort(), ['chapter', 'level'], 'worst 只许 {chapter,level}');
        }
    } finally {
        cleanup();
    }
});
