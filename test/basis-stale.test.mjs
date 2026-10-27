// test/basis-stale.test.mjs — 简报依据指纹（basis）与「简报已过期」检测。
//
// 要消灭的静默故障：novel_briefing 生成上下文包 → 用户在面板改了细纲/契约/世界书
// → 模型按**旧简报**写完一章 → 落盘。文件里的契约已经是新的，正文却是旧契约的产物，
// **全程没有任何告警**。这组测试钉住「漂移必须看得见」。
//
// 另外钉两条容易踩的边界：
//   · 契约的 updatedAt 变了**不算**漂移（语义指纹不含易变字段，否则原样重存也报警）；
//   · 账本**新增**条目不算漂移（批量起草每提交一章就多几条账，真报了就是噪声），
//     但**改写/删除**必须报。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { computeBasis, diffBasis, diffFacts, stableStringify } from '../lib/basis.js';
import { normalizeContract } from '../lib/scene-contract.js';
import { bootPlugin, chapterOf } from './helpers/plugin.mjs';

const OUTLINE = [
    '第1章：雨夜来客。出场：测试角色。事件：收殓无名的尸体。',
    '',
    '## 本章必写场景',
    '- 雨夜停尸房：验尸的动作要点、雨声与油灯的环境要点、与来客的对话要点',
    '- 无名尸体：布鞋留在门槛的动作要点、红泥印记的线索要点、收殓入殓的处置要点',
].join('\n');
const CONTRACT = { chapter: 1, scene: '雨夜收殓', participants: ['测试角色'], hidden: [], settings: [], forbidden: [], notes: '' };

test('稳定序列化：键序不同不算变更（否则换个键序就误报「依据变了」）', () => {
    assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
    assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test('依据指纹：细纲/契约/世界书任一改动 → digest 变', () => {
    const base = { outline: OUTLINE, contract: normalizeContract(CONTRACT), worldbook: [{ id: 'W1', content: 'x' }], facts: [] };
    const d0 = computeBasis(base);
    assert.ok(d0.digest.length > 0);
    assert.equal(computeBasis(base).digest, d0.digest, '同输入 → 同指纹');
    assert.notEqual(computeBasis({ ...base, outline: OUTLINE + '改' }).digest, d0.digest, '细纲改了 → 指纹变');
    assert.notEqual(computeBasis({ ...base, worldbook: [{ id: 'W1', content: 'y' }] }).digest, d0.digest, '世界书改了 → 指纹变');
});

test('契约的 updatedAt 变化**不算**漂移（语义指纹不含易变字段）', () => {
    const a = normalizeContract({ ...CONTRACT, updatedAt: '2026-10-27T10:00:00.000Z' });
    const b = normalizeContract({ ...CONTRACT, updatedAt: '2026-10-27T18:00:00.000Z' });
    assert.equal(computeBasis({ outline: OUTLINE, contract: a, worldbook: [], facts: [] }).digest,
        computeBasis({ outline: OUTLINE, contract: b, worldbook: [], facts: [] }).digest);
    // 但语义字段改了必须变
    const c = normalizeContract({ ...CONTRACT, scene: '另一场', updatedAt: '2026-10-27T10:00:00.000Z' });
    assert.notEqual(computeBasis({ outline: OUTLINE, contract: a, worldbook: [], facts: [] }).digest,
        computeBasis({ outline: OUTLINE, contract: c, worldbook: [], facts: [] }).digest);
});

test('账本比对：新增静默、改写与删除必须报出来', () => {
    const d = diffFacts(['甲|境界=筑基', '乙|状态=存活'], ['甲|境界=筑基', '丙|状态=存活']);
    assert.deepEqual(d.added, ['丙|状态']);
    assert.deepEqual(d.removed, ['乙|状态']);
    assert.deepEqual(d.modified, []);

    const m = diffFacts(['甲|境界=筑基'], ['甲|境界=金丹']);
    assert.deepEqual(m.modified, ['甲|境界']);
    assert.deepEqual(m.added, []);
});

test('★ 端到端：简报生成后改了细纲 → 写章落盘时必须报「简报已过期」', async () => {
    const p = await bootPlugin({ config: { minChapterChars: 300, maxChapterChars: 5000 } });
    const { tool, exec, cleanup, root } = p;
    try {
        await tool('novel_project').execute({ action: 'init', book: '依据书', title: '依据书' }, exec);
        await tool('novel_outline').execute({ action: 'save_chapter', book: '依据书', chapter: 1, outline: OUTLINE }, exec);
        await tool('novel_outline').execute({ action: 'approve', book: '依据书', chapter: 1 }, exec);

        // 写前简报：生成依据指纹并落一份服务端记录
        const brief = await tool('novel_briefing').execute({ book: '依据书', chapter: 1 }, exec);
        assert.ok(brief.basis?.digest, '简报回执必须带 basis 指纹');
        assert.ok(p.exists('依据书/.novel/basis.json'), '服务端必须自己留一份记录（不靠模型自觉）');

        // 简报之后，用户改了细纲
        fs.writeFileSync(path.join(root, '依据书/大纲/细纲/第1章.md'), OUTLINE + '\n补充：这一章多写一场。', 'utf8');

        const r = await tool('novel_write_chapter').execute({
            book: '依据书', chapter: 1, title: '雨夜来客',
            content: chapterOf(400), summary: '来客留鞋',
            basis: brief.basis.digest,
        }, exec);
        const warns = r.warnings.join('\n');
        assert.match(warns, /简报已过期/, `必须报出简报已过期：${warns}`);
        assert.match(warns, /细纲/, '要点名是细纲变了');
    } finally {
        cleanup();
    }
});

test('端到端：没改任何东西 → 不许误报「简报已过期」', async () => {
    const p = await bootPlugin({ config: { minChapterChars: 300, maxChapterChars: 5000 } });
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_project').execute({ action: 'init', book: '干净书', title: '干净书' }, exec);
        await tool('novel_outline').execute({ action: 'save_chapter', book: '干净书', chapter: 1, outline: OUTLINE }, exec);
        await tool('novel_outline').execute({ action: 'approve', book: '干净书', chapter: 1 }, exec);
        await tool('novel_briefing').execute({ book: '干净书', chapter: 1 }, exec);

        const r = await tool('novel_write_chapter').execute({
            book: '干净书', chapter: 1, title: '雨夜来客',
            content: chapterOf(400), summary: '来客留鞋',
        }, exec);
        assert.doesNotMatch(r.warnings.join('\n'), /简报已过期/, '没改依据就不该报');
    } finally {
        cleanup();
    }
});

test('端到端：模型带来的指纹与当前状态对不上 → 明确告警（不靠自觉的那道交叉核对）', async () => {
    const p = await bootPlugin({ config: { minChapterChars: 300, maxChapterChars: 5000 } });
    const { tool, exec, cleanup } = p;
    try {
        await tool('novel_project').execute({ action: 'init', book: '指纹书', title: '指纹书' }, exec);
        await tool('novel_outline').execute({ action: 'save_chapter', book: '指纹书', chapter: 1, outline: OUTLINE }, exec);
        await tool('novel_outline').execute({ action: 'approve', book: '指纹书', chapter: 1 }, exec);
        await tool('novel_briefing').execute({ book: '指纹书', chapter: 1 }, exec);

        const r = await tool('novel_write_chapter').execute({
            book: '指纹书', chapter: 1, title: '雨夜来客',
            content: chapterOf(400), summary: '来客留鞋',
            basis: 'deadbeefdeadbeef',
        }, exec);
        assert.match(r.warnings.join('\n'), /简报指纹与当前设定对不上/, '带的指纹不对必须报');
    } finally {
        cleanup();
    }
});
