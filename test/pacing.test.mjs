// test/pacing.test.mjs — 跨章叙事配额与节奏状态机（lib/pacing.js）。
//
// 本项目此前的门禁全是**单章**判定：noai 八维只看本章、重复检测只看最近 N 章。
// 于是「一章把长线的底牌全翻了」「连着五章都是爽点」「上章刚打过架这章又打」
// 这类病一道闸都拦不住——跨章约束此前只有 contextpack 注入的一段纯文本，
// 靠模型自觉，正是 AGENTS.md 开篇反对的那类约束。
//
// 这组测试钉住三件事：
//   ① 反向刹车只在「解决类信号 + ≥2 组配额信号」同时命中时才触发（宁可漏拦不可误拦）；
//   ② 事件冷却矩阵按章判定，冷却期内再写同类要报；
//   ③ 节奏档位（连续快档 / 每卷快档配额 / 慢档密度）能看见连着同调的问题。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    analyzePacing, analyzeResolutionBrake, detectEventTypes, detectTempoTier,
    parseOutlineTypes, pacingRecommendation, pacingRecord, onCooldown, lastUsedChapter,
    consecutiveFastChain, EVENT_TYPES, PACING_DEFAULTS,
} from '../lib/pacing.js';
import { bootPlugin, chapterOf } from './helpers/plugin.mjs';

/** 造一份 pacing 状态表：{ chapters: { "12": { types, tier } } }。 */
function state(entries) {
    const chapters = {};
    for (const [n, v] of Object.entries(entries)) chapters[n] = v;
    return { chapters };
}

// ── ① 反向刹车 ──────────────────────────────────────────────────────────────

test('反向刹车：解决类信号 + ≥2 组配额信号 → 触发', () => {
    const r = analyzeResolutionBrake({
        content: '他彻底击败了对手。江湖格局就此改写，两人结为兄弟，秘密的真相全部揭开。',
    });
    assert.equal(r.triggered, true, '必须触发');
    assert.ok(r.words.includes('彻底击败'), `要点名解决类信号：${r.words.join('、')}`);
    assert.ok(r.groups.length >= 2, `要列出命中的配额组：${r.groups.map((g) => g.id).join('、')}`);
    assert.match(r.message, /反向刹车/);
});

test('反向刹车：只命中 1 组配额信号 → 不触发（正常叙事别拦）', () => {
    const r = analyzeResolutionBrake({
        content: '这一战彻底击败了对手，江湖格局就此改写。',
    });
    assert.equal(r.triggered, false, `不该触发：${r.groups.map((g) => g.id).join('、')}`);
});

test('反向刹车：有配额信号但没有「解决类」表述 → 不触发', () => {
    const r = analyzeResolutionBrake({
        content: '江湖格局似乎要改写，两人结为兄弟，秘密的真相全部揭开。',
    });
    assert.equal(r.triggered, false, '没解决就别拦——只是谈到了而已');
});

test('反向刹车：阈值可覆盖（brakeGroups 调成 1 就放宽到单组）', () => {
    const text = '这一战彻底击败了对手，江湖格局就此改写。';
    assert.equal(analyzeResolutionBrake({ content: text }).triggered, false);
    assert.equal(analyzeResolutionBrake({ content: text, options: { brakeGroups: 1 } }).triggered, true);
});

test('反向刹车：局部解决不算（「解决了追兵」不是彻底解决）', () => {
    const r = analyzeResolutionBrake({ content: '他解决了追兵，从小巷里脱身出来。' });
    assert.equal(r.triggered, false);
});

// ── ② 事件冷却矩阵 ──────────────────────────────────────────────────────────

test('事件类型识别：一章内命中 ≥2 次才算这一类（一次提及说明不了走向）', () => {
    assert.deepEqual(detectEventTypes('他布局了一次，回来又布局。'), ['faction']);
    assert.deepEqual(detectEventTypes('他布局了一次。'), [], '只出现一次不归类');
});

test('事件类型识别：细纲显式声明优先于正文推断', () => {
    const outline = '## 本章节奏\n- 节奏：风土人情\n';
    assert.deepEqual(parseOutlineTypes(outline), ['locale']);
    assert.deepEqual(detectEventTypes('他布局了一次，回来又布局。', { outline }), ['locale'],
        '声明了「风土人情」就按声明算，不按正文词频猜');
});

test('事件冷却：冷却期内再写同类 → 报（并说清第几章解冻）', () => {
    const p = state({ 10: { types: ['conflict'], tier: 'normal' } });
    const r = analyzePacing({
        content: '两人厮杀，又是一阵激战，兵刃相接见血了。',
        chapter: 11,
        pacing: p,
    });
    assert.ok(r.issues.some((x) => x.includes('冷却') && x.includes('冲突爽点')),
        `必须报冷却：${r.issues.join(' | ')}`);
    assert.ok(r.issues.some((x) => x.includes('第13章')), '要说清什么时候解冻（10+2+1=13）');
});

test('事件冷却：过了冷却期 → 不报', () => {
    const p = state({ 10: { types: ['conflict'], tier: 'normal' } });
    const r = analyzePacing({
        content: '两人厮杀，又是一阵激战，兵刃相接见血了。',
        chapter: 13,          // 冲突爽点冷却 2 章 → 10+2+1=13 可用
        pacing: p,
    });
    assert.ok(!r.issues.some((x) => x.includes('冷却')), `不该报：${r.issues.join(' | ')}`);
});

test('冷却判定辅助函数：lastUsedChapter / onCooldown 与矩阵口径一致', () => {
    const p = state({ 10: { types: ['conflict'], tier: 'normal' }, 20: { types: ['locale'], tier: 'normal' } });
    const chapters = [{ chapter: 10, types: ['conflict'], tier: 'normal' }, { chapter: 20, types: ['locale'], tier: 'normal' }];
    assert.equal(lastUsedChapter(chapters, 'conflict'), 10);
    assert.equal(lastUsedChapter(chapters, 'bond'), null);
    assert.equal(onCooldown(chapters, 'conflict', 11, 2), true);
    assert.equal(onCooldown(chapters, 'conflict', 13, 2), false);
});

test('事件类型表：5 类、冷却章数 2/1/2/3/2（报告口径，不得漂移）', () => {
    assert.deepEqual(EVENT_TYPES.map((t) => t.id), ['conflict', 'bond', 'faction', 'locale', 'crisis']);
    assert.deepEqual(EVENT_TYPES.map((t) => t.cooldown), [2, 1, 2, 3, 2]);
});

// ── ③ 节奏档位 ──────────────────────────────────────────────────────────────

test('节奏档位：快档词够多才算快章', () => {
    assert.equal(detectTempoTier('他一鸣惊人，震惊全场，反杀横扫，技惊四座。'), 'fast');
    assert.equal(detectTempoTier('他坐着，琐事一堆，絮叨了半天，慢慢地等待。'), 'slow');
    assert.equal(detectTempoTier('他把灯芯捻短了一截。'), 'normal');
});

test('★ 连续快档 → 报（连着两章爽点，读者会疲劳）', () => {
    const p = state({ 10: { types: ['conflict'], tier: 'fast' } });
    const r = analyzePacing({
        content: '他一鸣惊人，震惊全场，反杀横扫，技惊四座。',
        chapter: 11, pacing: p,
    });
    assert.ok(r.issues.some((x) => x.includes('连续快档')), `必须报：${r.issues.join(' | ')}`);
});

test('每卷快档配额：超了要报', () => {
    const p = state({
        1: { types: [], tier: 'fast' },
        5: { types: [], tier: 'fast' },
        9: { types: [], tier: 'fast' },
    });
    const r = analyzePacing({
        content: '他一鸣惊人，震惊全场，反杀横扫，技惊四座。',
        chapter: 11, pacing: p,
    });
    assert.ok(r.issues.some((x) => x.includes('快档配额')), `必须报：${r.issues.join(' | ')}`);
});

test('慢档密度：连着几章日常铺垫 → 报（读者觉得没进展）', () => {
    const p = state({
        8: { types: [], tier: 'slow' },
        9: { types: [], tier: 'slow' },
    });
    const r = analyzePacing({
        content: '他坐着，琐事一堆，絮叨了半天，慢慢地等待。',
        chapter: 10, pacing: p,
    });
    assert.ok(r.issues.some((x) => x.includes('慢档')), `必须报：${r.issues.join(' | ')}`);
});

test('干净章节：一条都不该报（不许制造噪声）', () => {
    const r = analyzePacing({
        content: '他把灯芯捻短了一截，屋子里亮了一些。',
        chapter: 3,
        pacing: state({ 1: { types: ['bond'], tier: 'normal' }, 2: { types: ['locale'], tier: 'normal' } }),
    });
    assert.deepEqual(r.issues, [], `不该报：${r.issues.join(' | ')}`);
    assert.equal(r.brake.triggered, false);
});

// ── ③.1 连续快档的章号相邻性 ───────────────────────────────────────────────
//
// 「连续」必须按**章号**算，不能按「最近一条记录」算：第 10 章是快档、第 13 章
// 才动笔，中间两章没有记录——那不叫「连着快档」。按记录链算会得出「第10章是
// 快档、连着 2 章爽点」这种章号和数字对不上的告警，属于凭空捏造的证据。
// 缺记录 ≠ 快档（宁可漏判也不误判）。

test('★ 连续快档只看章号紧邻的：第10章是快档、第13章才写 → 不算连着', () => {
    const p = state({ 10: { types: [], tier: 'fast' } });
    const r = analyzePacing({
        content: '他一鸣惊人，震惊全场，反杀横扫，技惊四座。',
        chapter: 13, pacing: p,
    });
    assert.ok(!r.issues.some((x) => x.includes('连续快档')),
        `不该报连续快档：${r.issues.join(' | ')}`);
    assert.equal(r.metrics.tempo.consecutiveFast, 0);
});

test('连续快档：紧邻才报，且告警里的章号是真实的相邻章', () => {
    const p = state({ 12: { types: [], tier: 'fast' } });
    const r = analyzePacing({
        content: '他一鸣惊人，震惊全场，反杀横扫，技惊四座。',
        chapter: 13, pacing: p,
    });
    const hit = r.issues.find((x) => x.includes('连续快档'));
    assert.ok(hit, `必须报：${r.issues.join(' | ')}`);
    assert.match(hit, /第12章/, '告警要指向紧邻的第12章');
    assert.ok(!hit.includes('第10章'), '不能拿不相邻的章号凑证据');
    assert.equal(r.metrics.tempo.consecutiveFast, 1);
});

test('连续快档链：连着数出来的章数要对（告警要写清是哪几章）', () => {
    const p = state({ 11: { types: [], tier: 'fast' }, 12: { types: [], tier: 'fast' } });
    const r = analyzePacing({
        content: '他一鸣惊人，震惊全场，反杀横扫，技惊四座。',
        chapter: 13, pacing: p,
    });
    assert.equal(r.metrics.tempo.consecutiveFast, 2);
    const hit = r.issues.find((x) => x.includes('连续快档'));
    assert.match(hit, /第11–12章/, '告警要写清连着的是哪几章');
});

test('consecutiveFastChain：章号必须相邻（缺记录≠快档，上限可覆盖）', () => {
    const two = [{ chapter: 10, types: [], tier: 'fast' }, { chapter: 11, types: [], tier: 'fast' }];
    assert.equal(consecutiveFastChain(two, 13), 0, '第12章没记录 → 链断');
    assert.equal(consecutiveFastChain(two, 12), 2, '第11、10章都紧邻且都是快档');
    assert.equal(consecutiveFastChain([...two, { chapter: 12, types: [], tier: 'fast' }], 13), 3);
    assert.equal(consecutiveFastChain([
        { chapter: 10, types: [], tier: 'fast' }, { chapter: 11, types: [], tier: 'normal' },
    ], 12), 0, '上一章是 normal → 链断');
});

test('连续快档阈值可覆盖（maxConsecutiveFast=2 时连着 2 章不算超限）', () => {
    const p = state({ 12: { types: [], tier: 'fast' } });
    const r = analyzePacing({
        content: '他一鸣惊人，震惊全场，反杀横扫，技惊四座。',
        chapter: 13, pacing: p, options: { maxConsecutiveFast: 2 },
    });
    assert.ok(!r.issues.some((x) => x.includes('连续快档')),
        `连着 2 章 = 上限 2，不该报：${r.issues.join(' | ')}`);
});

// ── 写前推荐 ────────────────────────────────────────────────────────────────

test('写前推荐：冷却中的类型不进推荐位（推荐的是现在能写的）', () => {
    const p = state({ 10: { types: ['conflict'], tier: 'normal' } });
    const rec = pacingRecommendation({ pacing: p, chapter: 11 });
    assert.ok(!rec.recommended.some((r) => r.id === 'conflict'), '冷却中的冲突爽点不能被推荐');
    assert.ok(rec.cooling.some((c) => c.id === 'conflict'), '它得出现在冷却清单里');
    assert.ok(rec.recommended.length > 0, '总得有可写的类型');
    assert.match(rec.line, /冷却中别用/);
});

test('写前推荐：无历史时推荐最饿的类型，且摘要不啰嗦', () => {
    const rec = pacingRecommendation({ pacing: null, chapter: 1 });
    assert.ok(rec.recommended.length > 0);
    assert.equal(rec.cooling.length, 0);
    assert.ok(rec.recommended.every((r) => r.why.includes('还没写过')));
});

test('写前推荐：只有紧邻的上一章是快档才提示「别再连着快」（与体检同口径）', () => {
    const 跳章 = pacingRecommendation({ pacing: state({ 10: { types: [], tier: 'fast' } }), chapter: 13 });
    assert.ok(!跳章.line.includes('别再连着快'), `不该提示：${跳章.line}`);
    assert.equal(跳章.tempo.consecutiveFast, 0);

    const 紧邻 = pacingRecommendation({ pacing: state({ 12: { types: [], tier: 'fast' } }), chapter: 13 });
    assert.match(紧邻.line, /别再连着快/);
    assert.equal(紧邻.tempo.consecutiveFast, 1);
});

test('节奏记录：同一份正文 + 同一份细纲 → 同一份记录（可重放可对账）', () => {
    const a = pacingRecord({ content: '他布局了一次，回来又布局。', outline: '' });
    const b = pacingRecord({ content: '他布局了一次，回来又布局。', outline: '' });
    assert.deepEqual(a, b);
    assert.deepEqual(a.types, ['faction']);
    assert.equal(a.tier, 'normal');
});

test('默认阈值表：报告给的那组数字不得漂移', () => {
    assert.equal(PACING_DEFAULTS.brakeGroups, 2);
    assert.equal(PACING_DEFAULTS.maxFastPerVolume, 3);
    assert.equal(PACING_DEFAULTS.maxConsecutiveFast, 1);
    assert.equal(PACING_DEFAULTS.slowWindow, 4);
});

// ── 端到端（写章提交链）─────────────────────────────────────────────────────

const OUTLINE = [
    '第1章：雨夜来客。出场：测试角色。事件：收殓无名的尸体。',
    '',
    '## 本章必写场景',
    '- 雨夜停尸房：验尸的动作要点、雨声与油灯的环境要点、与来客的对话要点',
    '- 无名尸体：布鞋留在门槛的动作要点、红泥印记的线索要点、收殓入殓的处置要点',
].join('\n');

async function bootBook(book, config = {}) {
    const p = await bootPlugin({ config: { minChapterChars: 300, maxChapterChars: 5000, ...config } });
    const { tool, exec } = p;
    await tool('novel_project').execute({ action: 'init', book, title: book }, exec);
    await tool('novel_outline').execute({ action: 'save_chapter', book, chapter: 1, outline: OUTLINE }, exec);
    await tool('novel_outline').execute({ action: 'approve', book, chapter: 1 }, exec);
    return p;
}

test('★ 端到端：一章把格局/关系/秘密全解决 → 写章被节奏刹车拦下', async () => {
    const p = await bootBook('刹车书');
    const { tool, exec, cleanup } = p;
    try {
        const bomb = '他彻底击败了对手。江湖格局就此改写，两人结为兄弟，秘密的真相全部揭开。';
        await assert.rejects(
            async () => tool('novel_write_chapter').execute({
                book: '刹车书', chapter: 1, title: '雨夜来客',
                content: `${chapterOf(400)}\n\n${bomb}`,
                summary: '来客留鞋',
            }, exec),
            (err) => {
                const msg = String(err?.message ?? err);
                assert.match(msg, /节奏刹车/, `驳回文案要点名「节奏刹车」：${msg}`);
                assert.match(msg, /拆到后面几章/, '要说清怎么改');
                return true;
            },
        );
    } finally {
        cleanup();
    }
});

test('端到端：正常章节放行，并把本章的节奏记录写进 novel.json.pacing', async () => {
    const p = await bootBook('节奏书');
    const { tool, exec, cleanup, readJson } = p;
    try {
        const r = await tool('novel_write_chapter').execute({
            book: '节奏书', chapter: 1, title: '雨夜来客',
            content: chapterOf(400),
            summary: '来客留鞋',
        }, exec);
        assert.ok(r.path, '必须落盘成功');
        const novel = readJson('节奏书/novel.json');
        assert.ok(novel.pacing?.chapters?.['1'], `节奏记录必须落盘：${JSON.stringify(novel.pacing)}`);
        assert.ok(Array.isArray(novel.pacing.chapters['1'].types), '记录里要有事件类型');
        assert.equal(typeof novel.pacing.chapters['1'].tier, 'string', '记录里要有节奏档位');
    } finally {
        cleanup();
    }
});

test('端到端：brake=off 时同样的稿子放行（开关得真管用）', async () => {
    const p = await bootBook('不刹车书', { pacing: { brake: 'off' } });
    const { tool, exec, cleanup } = p;
    try {
        const bomb = '他彻底击败了对手。江湖格局就此改写，两人结为兄弟，秘密的真相全部揭开。';
        const r = await tool('novel_write_chapter').execute({
            book: '不刹车书', chapter: 1, title: '雨夜来客',
            content: `${chapterOf(400)}\n\n${bomb}`,
            summary: '来客留鞋',
        }, exec);
        assert.ok(r.path, '关掉刹车就该放行');
    } finally {
        cleanup();
    }
});
