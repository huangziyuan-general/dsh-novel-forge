// test/v140-wiring-fixes.test.mjs — v1.4.0 三主线的**工具接线层**回归。
//
// 来源：v1.4.0 review 实锤的三个接线 bug（纯函数测试全绿、一上真路径就炸的同一类）：
//   ① novel_polish submit 的 review_quotes 校验引用了还没声明的 original（TDZ，带引文必炸）；
//   ② novel_project check 把 fullscan 提示**字符串**展开进 return（数字键垃圾 + schema 违约）；
//   ③ novel_arc query 只把首个人物传进 arcsAt（多人物查询静默丢人）。
// 纯函数层已有 v140-relations-arcs.test.mjs；本文件专钉「接线层必须真的能跑」。
// review 收编三条（continuity-io 损坏响亮 / relation query 成对 guard / arc query 前瞻可见性）也钉在这里。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bootPlugin, chapterOf } from './helpers/plugin.mjs';

const OUTLINE = [
    '第1章：雨夜来客。出场：测试角色。事件：收殓无名的尸体。',
    '',
    '## 本章必写场景',
    '- 雨夜停尸房：验尸的动作要点、雨声与油灯的环境要点、与来客的对话要点',
    '- 无名尸体：布鞋留在门槛的动作要点、红泥印记的线索要点、收殓入殓的处置要点',
].join('\n');

test('★ novel_arc query：多人物查询必须回全（快照层只传首人 = 静默丢人）', async () => {
    const p = await bootPlugin();
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_project').execute({ action: 'init', book: '弧线书', title: '弧线书' }, exec);
        // 未写章的书 query 快照落在第 1 章（maxWritten=0 → n=1）——登记章号须落在快照内才可见
        await tool('novel_arc').execute({ action: 'update', book: '弧线书', chapter: 1, updates: '张三|心性|隐忍' }, exec);
        await tool('novel_arc').execute({ action: 'update', book: '弧线书', chapter: 1, updates: '李四|心性|张扬' }, exec);
        const q = await tool('novel_arc').execute({ action: 'query', book: '弧线书', character: '张三、李四' }, exec);
        assert.deepEqual(
            q.arcs.map((a) => a.character).sort(),
            ['张三', '李四'],
            '两个人物都登记过，query 必须两条都回',
        );
    } finally {
        cleanup();
    }
});

test('★ novel_project check fullscan：return 形状必须逐字段守 schema（字符串展开 = 数字键垃圾）', async () => {
    const p = await bootPlugin();
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_project').execute({ action: 'init', book: '体检书', title: '体检书' }, exec);
        const r = await tool('novel_project').execute({ action: 'check', book: '体检书', fullscan: true }, exec);
        assert.deepEqual(
            Object.keys(r).sort(),
            ['action', 'book', 'continuity', 'fullscan', 'next'],
            `return 键集必须与 output.schema 一致：${Object.keys(r).join(',')}`,
        );
        assert.equal(r.fullscan.ok, true, '空书 fullscan 应该是干净的');
        assert.match(r.next, /全书深扫（线程自洽）通过/, '深扫结论必须进 next 提示，不许散成数字键');
    } finally {
        cleanup();
    }
});

test('★ novel_polish submit + review_quotes：引文校验必须在原文读取之后（TDZ）且真拦假引文', async () => {
    const p = await bootPlugin({ config: { minChapterChars: 300, maxChapterChars: 5000 } });
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_project').execute({ action: 'init', book: '润色书', title: '润色书' }, exec);
        await tool('novel_outline').execute({ action: 'save_chapter', book: '润色书', chapter: 1, outline: OUTLINE }, exec);
        await tool('novel_outline').execute({ action: 'approve', book: '润色书', chapter: 1 }, exec);
        const original = chapterOf(400);
        await tool('novel_write_chapter').execute({
            book: '润色书', chapter: 1, title: '雨夜来客',
            content: original, summary: '来客留鞋',
        }, exec);

        // 假引文：逐字不在原文里 → 必须被 grounding 闸拦下（而不是 ReferenceError）
        await assert.rejects(
            () => tool('novel_polish').execute({
                action: 'submit', book: '润色书', chapter: 1,
                content: original + '结尾补一句。',
                review_quotes: '段1|这句引文根本不在正文里出现',
            }, exec),
            /审稿引文未通过 grounding/,
            '假引文必须被拒收——报 ReferenceError 或放行都算失败',
        );

        // 真引文（逐字取自原文）→ 校验通过，提交继续走到落提案
        const quote = original.replace(/\s+/g, '').slice(0, 12);
        const ok = await tool('novel_polish').execute({
            action: 'submit', book: '润色书', chapter: 1,
            content: original + '结尾补一句。',
            review_quotes: `段1|${quote}`,
        }, exec);
        assert.equal(ok.action, 'submit');
        assert.equal(typeof ok.id, 'string', '真引文必须放行到提案登记');
    } finally {
        cleanup();
    }
});

test('★ novel_arc query/status_at：前瞻可见性——登记在快照之后的行必须报 forwardRows（不能像「登记丢了」）', async () => {
    const p = await bootPlugin();
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_project').execute({ action: 'init', book: '前瞻书', title: '前瞻书' }, exec);
        // 未写章新书 update 不设章号上限（guard 跳过）——正好造出「快照(第1章)之后」的登记
        await tool('novel_arc').execute({ action: 'update', book: '前瞻书', chapter: 1, updates: '张三|心性|隐忍' }, exec);
        await tool('novel_arc').execute({ action: 'update', book: '前瞻书', chapter: 5, updates: '张三|心性|爆发' }, exec);
        const q = await tool('novel_arc').execute({ action: 'query', book: '前瞻书' }, exec);
        assert.equal(q.snapshotChapter, 1, 'query 快照 = 已写章号（新书为 1）');
        assert.equal(q.arcs.length, 1, '第 5 章的登记不在第 1 章快照里');
        assert.equal(q.arcs[0].chapter, 1, '可见的是第 1 章那条');
        assert.equal(q.forwardRows, 1, '快照之后的登记必须以 forwardRows 报出来');
        const s = await tool('novel_arc').execute({ action: 'status_at', book: '前瞻书', at: 5 }, exec);
        assert.equal(s.snapshotChapter, 5);
        assert.equal(s.arcs.length, 1, 'arcsAt 是「每 人物·维度 取时点最新读数」——第 1 章那条在第 5 章已被接替');
        assert.equal(s.arcs[0].value, '爆发', '第 5 章时点的读数是最新值');
        assert.equal(s.forwardRows, 0, '快照之后没有剩余登记');
        const s1 = await tool('novel_arc').execute({ action: 'status_at', book: '前瞻书', at: 1 }, exec);
        assert.equal(s1.arcs[0].value, '隐忍', '时点推演回第 1 章必须看到当时的值');
    } finally {
        cleanup();
    }
});

test('★ novel_relation query/status_at：a 与 b 必须成对给出（单边 = 费解的「实体名不能为空」）', async () => {
    const p = await bootPlugin();
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_project').execute({ action: 'init', book: '成对书', title: '成对书' }, exec);
        await assert.rejects(
            () => tool('novel_relation').execute({ action: 'query', book: '成对书', a: '甲' }, exec),
            /成对给出/,
            '只给 a 必须前置拒绝并说清怎么改',
        );
        await assert.rejects(
            () => tool('novel_relation').execute({ action: 'status_at', book: '成对书', b: '乙', at: 1 }, exec),
            /成对给出/,
            '只给 b 同样必须拒绝',
        );
        // 成对给出（即便空账本）照常可用
        const ok = await tool('novel_relation').execute({ action: 'query', book: '成对书', a: '甲', b: '乙' }, exec);
        assert.deepEqual(ok.relations, []);
    } finally {
        cleanup();
    }
});

test('★ continuity-io：relations.json 损坏必须响亮（静默 .catch(()=>[]) = 一致性维度失踪）', async () => {
    const p = await bootPlugin();
    const { tool, exec, io, cleanup } = p;
    try {
        await tool('novel_project').execute({ action: 'init', book: '损坏书', title: '损坏书' }, exec);
        await tool('novel_relation').execute({ action: 'update', book: '损坏书', chapter: 1, updates: '甲|乙|盟友|结盟' }, exec);
        // 手工改坏（机器状态 JSON 不许坏；坏了体检必须喊出来而不是当「没有关系数据」）
        await io().writeText('损坏书/账本/relations.json', '{oops', {});
        await assert.rejects(
            () => tool('novel_project').execute({ action: 'check', book: '损坏书', fullscan: true }, exec),
            /不是合法 JSON/,
            '损坏的关系账本必须让 check 响亮失败',
        );
    } finally {
        cleanup();
    }
});
