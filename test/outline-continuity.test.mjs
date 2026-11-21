// test/outline-continuity.test.mjs — 细纲一致性预检（未定稿章节规划面反查）。
//
// 两条红线：
//   · 判据单一实现：死亡名册与闪回豁免复用 continuity 的 deathTimeline/FLASHBACK_RE，
//     关系过期值复用 relations.detectStaleRelations——本文件不写第二份匹配逻辑；
//   · 关口口径：命中一律 warning（细纲是规划不是成稿，拦截语义留给写章门禁），
//     approve 时并入 note 提示，不阻断批准。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkOutlineContinuity } from '../lib/outline-continuity.js';

const DEATH_FACTS = [
    { entity: '沈青', key: '生死', value: '已死', chapter: 5 },
    { entity: '顾长卿', key: '生死', value: '坠崖身亡', chapter: 3 },
    { entity: '测试角色', key: '境界', value: '练气三层', chapter: 1 },
];

const RELATIONS = [
    { a: '甲', b: '乙', relation: '信任度', value: '盟友', chapter: 2 },
    { a: '甲', b: '乙', relation: '信任度', value: '仇敌', chapter: 4 },
];

test('★ 细纲点名已死实体（死亡章早于本章）→ warning，同实体只报一次', () => {
    const { issues } = checkOutlineContinuity({
        chapter: 6,
        outline: '沈青出现在祠堂，顾长卿也来了。沈青再次开口说话。',
        facts: DEATH_FACTS, relations: [],
    });
    const dead = issues.filter((i) => i.code === 'outline-dead-reappear');
    assert.equal(dead.length, 2, '沈青、顾长卿各报一次（沈青出现两次只计一次）');
    assert.ok(dead.every((i) => i.severity === 'warning'), '关口口径：warning 不拦');
    assert.ok(dead.some((i) => i.message.includes('第5章')));
});

test('★ 细纲带闪回标记 → 死亡再现按豁免降级（与正文面同一 FLASHBACK_RE）', () => {
    const { issues } = checkOutlineContinuity({
        chapter: 6,
        outline: '（回忆）十年前，沈青最后一次出现在祠堂。',
        facts: DEATH_FACTS, relations: [],
    });
    const dead = issues.filter((i) => i.code.startsWith('outline-dead'));
    assert.equal(dead.length, 1, '豁免后仍留一条确认提示（防误标闪回）');
    assert.equal(dead[0].code, 'outline-dead-flashback');
    assert.match(dead[0].message, /确为回忆场景/);
});

test('死亡章 ≥ 本章（未来死亡/同章）不误报；未死实体不出现在预检面', () => {
    const { issues } = checkOutlineContinuity({
        chapter: 6,
        outline: '测试角色继续练功。',
        facts: [{ entity: '沈青', key: '生死', value: '已死', chapter: 9 }], // 第 9 章才死（未来）
        relations: [],
    });
    assert.deepEqual(issues, []);
});

test('★ 关系线过期值：细纲仍用旧值 → warning（时点推演到本章的当前值为准）', () => {
    const { issues } = checkOutlineContinuity({
        chapter: 5,
        outline: '甲仍以盟友之谊待乙，两人同殿议事。',
        facts: [], relations: RELATIONS,
    });
    const stale = issues.filter((i) => i.code === 'outline-stale-relation');
    assert.equal(stale.length, 1);
    assert.match(stale[0].message, /仇敌/);
    assert.match(stale[0].message, /盟友/);
});

test('细纲用当前值 → 零命中', () => {
    const { issues } = checkOutlineContinuity({
        chapter: 5,
        outline: '甲与乙已是仇敌，两人同殿议事。',
        facts: [], relations: RELATIONS,
    });
    assert.deepEqual(issues, []);
});

test('空细纲/空台账 → 零命中不炸', () => {
    assert.deepEqual(checkOutlineContinuity({ chapter: 1, outline: '', facts: [], relations: [] }).issues, []);
    assert.deepEqual(checkOutlineContinuity({ chapter: 1, outline: '正文若干。', facts: [], relations: [] }).issues, []);
});

// ── 接线层：approve 真跑一遍，预检警告并入 note 且批准不被阻断 ──────────

test('★ novel_outline approve：细纲点名已死实体 → 批准放行 + note 带预检警告', async () => {
    const { bootPlugin } = await import('./helpers/plugin.mjs');
    // minChapterChars 调低：夹具细纲拍量估算（约 460 字）需过 save_chapter 的机审下限
    const p = await bootPlugin({ config: { minChapterChars: 300, maxChapterChars: 20000 } });
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_project').execute({ action: 'init', book: '预检书', title: '预检书' }, exec);
        // 台账：沈青第 1 章已死
        await tool('novel_ledger').execute({
            action: 'update', book: '预检书', chapter: 1,
            updates: '沈青|生死|已死',
        }, exec);
        await tool('novel_outline').execute({
            action: 'save_chapter', book: '预检书', chapter: 2,
            outline: '第2章：祠堂夜访。出场：守夜人。事件：守夜人在祠堂见到了沈青。\n\n## 本章必写场景\n- 祠堂：守夜人夜访，见沈青身影。',
        }, exec);
        const r = await tool('novel_outline').execute({ action: 'approve', book: '预检书', chapter: 2 }, exec);
        assert.equal(r.approved, true, '预检是警告不是门禁：批准照放');
        assert.match(r.note ?? '', /沈青/, 'note 必须带出预检命中');
        assert.match(r.note ?? '', /已死|死亡/, '指认死亡章，模型有得改');
        // 干净细纲：同书第 3 章无命中 → note 里不出现预检文案（note 可能整体缺省）
        await tool('novel_outline').execute({
            action: 'save_chapter', book: '预检书', chapter: 3,
            outline: '第3章：守夜人下山。出场：守夜人。\n\n## 本章必写场景\n- 山路：守夜人连夜下山。',
        }, exec);
        const r3 = await tool('novel_outline').execute({ action: 'approve', book: '预检书', chapter: 3 }, exec);
        assert.equal(r3.approved, true);
        assert.ok(!/沈青/.test(r3.note ?? ''), '无命中不掺预检文案');
    } finally {
        cleanup();
    }
});
