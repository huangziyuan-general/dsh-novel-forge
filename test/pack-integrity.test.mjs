// test/pack-integrity.test.mjs — 上下文包的硬约束完整性（宁报错，不静默丢弃）。
//
// 来源：竞品 QMAI context-engine 的「正典是硬约束：静默丢掉它会让模型凭空编造，
// 宁可停下来报错」。DSH 的对应缺口（1.3.3 及以前）：
//   · buildContextPack 的 push() 里 clip(content, cap) 把超长硬约束块**无声截短**——
//     dropped 只登记「整块装不下」，登记不到「装进来了但被砍了一半」；
//   · 硬块整块进 dropped 后没有恢复路径（衔接两件套有 recoveryNotes，硬块没有）。
// 本轮口径：contextpack 只**如实登记**（truncated / hardIntegrity），briefing 把硬块
// 的问题升成 warnings + 恢复指令——不进门禁放行口径（与既有红线一致）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildContextPack, isHardBlockName, hardIntegrity } from '../lib/contextpack.js';
import { bootPlugin } from './helpers/plugin.mjs';

const BASE = {
    chapter: 1,
    chapterOutline: '第一节：主角进山。',
    promise: '本书承诺：不圣母、不烂尾。',
    sceneContract: '',
    castCards: [],
    voiceCards: [],
    worldEntries: [],
    factsDigest: [],
    glossaryDigest: [],
    foreshadowDigest: [],
    prevTail: '',
    summaries: [],
    anchors: [],
    budget: 6000,
};

test('isHardBlockName：六个硬块（含带章号的动态名）都在名单里，弹性块不在', () => {
    assert.equal(isHardBlockName('本章细纲（第12章·必须逐点覆盖）'), true);
    assert.equal(isHardBlockName('故事承诺书（本书对读者的承诺·本章不许违背）'), true);
    assert.equal(isHardBlockName('场景契约（本章人物与禁区·硬约束）'), true);
    assert.equal(isHardBlockName('追读节奏·硬约束（网文追读的命门）'), true);
    assert.equal(isHardBlockName('事实账本·本章必须遵守'), true);
    assert.equal(isHardBlockName('未回收伏笔'), true);
    assert.equal(isHardBlockName('人物卡·测试角色'), false, '人物卡是弹性块（有均摊+旁路获取）');
    assert.equal(isHardBlockName('世界书·w1'), false);
    assert.equal(isHardBlockName('全书大纲'), false, '全书大纲可整块丢弃且可从文件找回，不算硬块');
    assert.equal(isHardBlockName(''), false);
    assert.equal(isHardBlockName(undefined), false);
});

test('硬约束块被部分截断 → truncated 有账，hardIntegrity 抓得到（此前完全静默）', () => {
    const pack = buildContextPack({
        ...BASE,
        factsDigest: ['测·境界: ' + '很长的设定'.repeat(200)], // ≫ 900 字 cap
    });
    const hit = pack.truncated.find((t) => t.name.startsWith('事实账本'));
    assert.ok(hit, '事实账本摘要超 900 字必须出现在 truncated 登记里');
    assert.equal(hit.original > hit.kept, true, 'original 必须大于 kept');
    assert.equal(hit.kept, 900, 'kept 等于事实账本的 cap');
    const integrity = hardIntegrity({ dropped: pack.dropped, truncated: pack.truncated });
    assert.equal(integrity.hardTruncated.length, 1);
    assert.equal(integrity.hardTruncated[0].name.startsWith('事实账本'), true);
    assert.equal(integrity.hardDropped.length, 0);
});

test('细纲超长被截短 → 登记（模型此前会按截断版「逐点覆盖」而不知道漏了点）', () => {
    const pack = buildContextPack({ ...BASE, chapterOutline: '细'.repeat(2000) });
    const hit = pack.truncated.find((t) => t.name.startsWith('本章细纲'));
    assert.ok(hit, '细纲 cap 1200，2000 字必被截');
    assert.equal(hit.kept, 1200);
});

test('弹性块截断 → truncated 如实登记，但不算硬约束问题（它们本就有均摊机制）', () => {
    const pack = buildContextPack({
        ...BASE,
        castCards: [{ name: '甲', card: '人'.repeat(2000) }],
    });
    const hit = pack.truncated.find((t) => t.name === '人物卡·甲');
    assert.ok(hit, '人物卡 2000 字超 cap 700 必被截且登记');
    const integrity = hardIntegrity({ dropped: pack.dropped, truncated: pack.truncated });
    assert.equal(integrity.hardTruncated.length, 0, '弹性块的截断不算硬约束问题');
});

test('硬约束块整块被预算挤掉 → hardDropped 抓得到', () => {
    const pack = buildContextPack({
        ...BASE,
        chapterOutline: '纲'.repeat(50),
        promise: '承'.repeat(150), // 细纲占 ~70 后，承诺书 176 字装不进 200 预算
        budget: 200,
    });
    assert.equal(pack.dropped.some((d) => d.startsWith('故事承诺书')), true, '承诺书必须整块进 dropped');
    const integrity = hardIntegrity({ dropped: pack.dropped, truncated: pack.truncated });
    assert.equal(integrity.hardDropped.some((d) => d.startsWith('故事承诺书')), true);
});

test('预算充裕、无截断 → hardIntegrity 两栏全空', () => {
    const pack = buildContextPack(BASE);
    assert.deepEqual(pack.truncated, []);
    const integrity = hardIntegrity({ dropped: pack.dropped, truncated: pack.truncated });
    assert.deepEqual(integrity, { hardDropped: [], hardTruncated: [] });
});

test('端到端：简报把硬约束截断/挤掉升成 warnings（带恢复路径），输出过 schema 校验', async () => {
    const p = await bootPlugin({ config: { contextBudgetChars: 250 } });
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_project').execute({ action: 'init', book: '完整性书', title: '完整性书' }, exec);
        // 容量门禁：3 场景 × 5 拍 ≈ 3300 字 ≥ 下限 2000；总长 ≫ 250 字预算 → 细纲整块装不下
        const beat = (t) => `山道第${t}段的风把火把压得忽明忽暗，主角贴着崖壁缓步前行，脚下碎石滚进深谷；`;
        const outline = '## 本章必写场景\n' + [1, 2, 3].map((i) => `- 进山${i}：` + [1, 2, 3, 4].map(beat).join('')).join('\n');
        await tool('novel_outline').execute({ action: 'save_chapter', book: '完整性书', chapter: 1, outline }, exec);
        const v = await tool('novel_briefing').execute({ book: '完整性书', chapter: 1 }, exec);
        assert.ok(Array.isArray(v.truncated), '输出必须带 truncated（schema 同步校验，缺了会 INVALID_TOOL_OUTPUT）');
        const warnHit = v.warnings.find((w) => w.includes('硬约束整块被预算挤掉') && w.includes('本章细纲'));
        assert.ok(warnHit, `warnings 里必须有细纲被挤掉的硬约束告警：${JSON.stringify(v.warnings)}`);
        assert.match(warnHit, /大纲\/细纲\/第1章\.md/, '告警必须带恢复路径（引用真实文件名）');
        assert.match(v.rendered ?? '', /硬约束/, '人读形态也要看得见');
    } finally {
        cleanup();
    }
});
