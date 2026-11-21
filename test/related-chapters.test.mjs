// test/related-chapters.test.mjs — 相关历史章节四维确定性推荐（lib/related-chapters.js）。
//
// 四条红线：
//   · 四维各自判定（伏笔回收/出场/状态/关系），畸形行滤出不炸；
//   · 跨维去重（一章只推一次，按维度序保留首个理由）+ 最近窗口不推 + 只推历史章 + 封顶；
//   · 推荐理由带因（不裸章号）；
//   · 简报接线层：有台账出「相关历史章节」段，无数据整段省略（旧书零回归）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { relatedChapters, renderRelatedChaptersSection } from '../lib/related-chapters.js';

const CAST = ['沈夜', '顾青'];

test('★ 伏笔维：plan==本章 推埋设章；已超期未回收也推（还法要定）；已回收不推', () => {
    const foreshadows = [
        { id: 'F1', setup: '青铜灯芯', chapter: 5, plan: 20, payoffChapter: null },   // 计划本章（n=20）回收
        { id: 'F2', setup: '阴沉木匣', chapter: 3, plan: 8, payoffChapter: null },    // 已超期（plan<20）
        { id: 'F3', setup: '旧信', chapter: 2, plan: null, payoffChapter: 10 },        // 已回收
    ];
    const { items } = relatedChapters({ n: 20, cast: CAST, foreshadows });
    const byCh = (n) => items.find((i) => i.chapter === n);
    assert.equal(byCh(5)?.code, 'foreshadow', 'F1 计划本章 → 推第 5 章');
    assert.equal(byCh(3)?.code, 'foreshadow', 'F2 超期 → 推第 3 章');
    assert.equal(items.find((i) => i.chapter === 2), undefined, 'F3 已回收 → 不推第 2 章');
    assert.ok(byCh(5).reason.includes('计划本章回收'));
});

test('★ 出场维：最近一次更早登场章（扫场景契约 participants）；最近窗口内的登场不推', () => {
    const contracts = {
        '4': { participants: ['沈夜', '顾青'] },
        '12': { participants: ['顾青'] },
        '19': { participants: ['顾青'] }, // 19 在最近窗口（n=20，窗口 3）内 → 顾青整体不推
    };
    const { items } = relatedChapters({ n: 20, cast: CAST, contracts });
    const seen = items.filter((i) => i.code === 'cast');
    // 沈夜最近更早登场=4（窗口外）→ 推；顾青最近登场=19（窗口内，已在上下文）→ 不推
    assert.deepEqual(seen.map((i) => [i.chapter, i.reason.includes('登场')]), [[4, true]]);
});

test('★ 状态维：本章出场实体/人物最近一次 facts/arcs 改动章', () => {
    const facts = [
        { entity: '沈夜', key: '境界', value: '筑基', chapter: 6 },
        { entity: '沈夜', key: '境界', value: '炼气', chapter: 2 }, // 更旧，被 6 顶掉
        { entity: '旁人', key: '位置', value: '山门', chapter: 1 }, // 不在此章出场 → 不推
    ];
    const arcs = [
        { character: '顾青', dimension: '信任度', value: '敌', chapter: 9 },
    ];
    const { items } = relatedChapters({ n: 20, cast: CAST, facts, arcs });
    const byCh = (n) => items.find((i) => i.chapter === n);
    assert.equal(byCh(6)?.code, 'state', '沈夜·境界 第 6 章改 → 推 6');
    assert.equal(byCh(9)?.code, 'state', '顾青 弧线第 9 章推进 → 推 9');
    assert.equal(items.find((i) => i.chapter === 2), undefined, '更旧的 2 被 6 顶掉不重复推');
    assert.equal(items.find((i) => i.chapter === 1), undefined, '非出场实体不推');
});

test('★ 关系维：同台两人对最近一次关系推进章；非同台对不推', () => {
    const relations = [
        { a: '沈夜', b: '顾青', relation: '信任度', value: '仇敌', chapter: 11 },
        { a: '外人A', b: '外人B', relation: '信任度', value: '盟友', chapter: 3 }, // 不在此章同台
    ];
    const { items } = relatedChapters({ n: 20, cast: CAST, relations });
    assert.equal(items.find((i) => i.chapter === 11)?.code, 'relation', '同台对第 11 章推进 → 推 11');
    assert.equal(items.find((i) => i.chapter === 3), undefined, '非同台对不推');
});

test('跨维去重 + 封顶 + 最近窗口：一章只推一次、条数封顶、窗口内不推', () => {
    const input = {
        n: 30,
        cast: CAST,
        foreshadows: [{ id: 'F1', setup: 'x', chapter: 3, plan: 30, payoffChapter: null }],
        facts: [{ entity: '沈夜', key: 'k', value: 'v', chapter: 3 }], // 与 F1 同章 → 去重
        recentWindow: 5,
        maxResults: 2,
    };
    const { items } = relatedChapters(input);
    assert.ok(items.every((i) => i.chapter < 30), '只推历史章');
    // 第 3 章被伏笔维先占（维度序 ①），状态维同章不再推
    assert.equal(items.filter((i) => i.chapter === 3).length, 1);
    assert.ok(items.every((i) => i.chapter < 25), '最近窗口 5（n-5=25 及以后太近）不推，只推更早的非相邻章');
    assert.ok(items.length <= 2, '封顶 2 条');
});

test('空数据全零：无推荐、渲染返回空串（旧书零回归）', () => {
    assert.deepEqual(relatedChapters({ n: 10, cast: CAST }).items, []);
    assert.equal(renderRelatedChaptersSection({ items: [] }), '');
    assert.equal(relatedChapters({ n: 0, cast: CAST }).items.length, 0, 'n=0 不炸');
});

test('★ 简报接线：有台账出「相关历史章节」段 / 无数据整段省略', async () => {
    const { bootPlugin, chapterOf } = await import('./helpers/plugin.mjs');
    const p = await bootPlugin({ config: { minChapterChars: 300, maxChapterChars: 20000 } });
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_project').execute({ action: 'init', book: '相关书', title: '相关书' }, exec);
        // 落第 1 章 + 台账：守夜人境界改动（第 1 章）+ 伏笔埋第 1 章、plan=8（第 8 章回收）
        await tool('novel_outline').execute({
            action: 'save_chapter', book: '相关书', chapter: 1,
            outline: '第1章：夜访。出场：守夜人。\n\n## 本章必写场景\n- 祠堂：守夜人夜访。',
        }, exec);
        await tool('novel_outline').execute({ action: 'approve', book: '相关书', chapter: 1 }, exec);
        await tool('novel_write_chapter').execute({
            book: '相关书', chapter: 1, title: '夜访', content: chapterOf(400), summary: '守夜人夜访', cast: '守夜人',
        }, exec);
        await tool('novel_ledger').execute({
            action: 'update', book: '相关书', chapter: 1, updates: '守夜人|境界|练气',
        }, exec);
        await tool('novel_ledger').execute({
            action: 'foreshadow_setup', book: '相关书', chapter: 1, setup: '青铜灯芯', plan: 8,
        }, exec);
        // 第 8 章简报：伏笔 plan=8==n、守夜人第 1 章改动——第 1 章在默认窗口（n-3=5）外 → 被推荐
        const brief = await tool('novel_briefing').execute({ book: '相关书', chapter: 8 }, exec);
        const sec = brief.sections.find((s) => s.name === '相关历史章节（按需回读）');
        assert.ok(sec !== undefined, '有台账 → 简报出相关历史章节段');
        assert.match(sec.content, /第1章/, '推荐了第 1 章');
        assert.match(sec.content, /伏笔|境界|登场/, '带推荐理由（不裸章号）');

        // 清空四维台账（直接改写盘上数据，绕开「回收章必须已写」的门禁——本步骤只验证
        // 空数据时简报段省略，不走回收门禁语义）→ 四维全空 → 段消失
        const io = p.io();
        await io.writeJson('相关书/账本/facts.json', []);
        await io.writeJson('相关书/账本/伏笔.json', []);
        await io.writeJson('相关书/账本/relations.json', []);
        await io.writeJson('相关书/账本/arcs.json', []);
        const brief2 = await tool('novel_briefing').execute({ book: '相关书', chapter: 8 }, exec);
        assert.equal(brief2.sections.find((s) => s.name === '相关历史章节（按需回读）'), undefined, '无推荐整段省略');
    } finally {
        cleanup();
    }
});
