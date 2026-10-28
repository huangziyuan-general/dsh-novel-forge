// test/fact-evidence.test.mjs — 事实账本的证据 grounding（facts_evidence）。
//
// 来源：竞品 MirrorNovel semanticMemory 的 evidence 子串校验（AI 抽的事实必须附
// 正文原句，否则拒收）。DSH 的对应缺口：facts_updates 是模型自述——账本可能记下
// **正文没写的事**，后续每一章都把它当硬约束遵守，一致性偏差被账本放大。
//
// 口径（代码强制 > 提示词自觉）：
//   · 不要求模型必须提供证据（批量起草/面板保存没有证据通道，向后兼容）；
//   · 但**给了就必须是真的**：证据（忽略空白差异）必须逐字出现在本章正文里，
//     找不到整章拒绝保存；太短定位不到内容也拒；对不上 updates 的 (entity,key) 也拒。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyFactUpdates, validateFactEvidence, MIN_EVIDENCE_CHARS } from '../lib/ledger.js';
import { parseFactLines, parseFactEvidence } from '../lib/tools/common.js';
import { bootPlugin, chapterOf } from './helpers/plugin.mjs';

const NOW = '2026-10-28T12:00:00.000Z';
const CONTENT = '他掐诀引动丹田灵机，境界在一线之间从筑基二层滑入了筑基三层。\n\n“筑基三层也不过如此。”他说。';

test('MIN_EVIDENCE_CHARS：定在 4（4 字以下几乎必然在正文撞上，是仪式不是证据）', () => {
    assert.equal(MIN_EVIDENCE_CHARS, 4);
});

test('parseFactEvidence：基本解析 / 空入参 / 格式错误 / 证据里的竖线不切断', () => {
    assert.deepEqual(parseFactEvidence(undefined), []);
    assert.deepEqual(parseFactEvidence(''), []);
    const rows = parseFactEvidence('主角|境界|他从筑基二层滑入了筑基三层。\n  主角|佩刀 | 刀鞘上有血，他说「给我|走」。 ');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { entity: '主角', key: '境界', evidence: '他从筑基二层滑入了筑基三层。' });
    assert.equal(rows[1].evidence, '刀鞘上有血，他说「给我|走」。', '第 3 段之后全部归证据（引语里的竖线不切断）');
    assert.throws(() => parseFactEvidence('主角|境界'), /行格式错误/);
    assert.throws(() => parseFactEvidence('主角|境界| '), /证据原句不能为空/);
    assert.throws(() => parseFactEvidence(42), /必须是多行文本/);
});

test('validateFactEvidence：证据在正文（忽略空白差异）→ 通过', () => {
    const updates = parseFactLines('主角|境界|筑基三层');
    const evidences = parseFactEvidence('主角|境界|境界在一线之间从筑基二层滑入了筑基三层。');
    assert.deepEqual(validateFactEvidence(updates, evidences, CONTENT), []);
});

test('validateFactEvidence：证据逐字找不到 → 拒（防账本记下正文没写的事）', () => {
    const updates = parseFactLines('主角|境界|筑基三层');
    const evidences = parseFactEvidence('主角|境界|主角突破了筑基三层，众人惊叹。');
    const v = validateFactEvidence(updates, evidences, CONTENT);
    assert.equal(v.length, 1);
    assert.equal(v[0].entity, '主角');
    assert.match(v[0].reason, /逐字找不到/);
});

test('validateFactEvidence：证据太短 → 拒（定位不到具体内容）', () => {
    const updates = parseFactLines('主角|境界|筑基三层');
    const evidences = parseFactEvidence('主角|境界|三层');
    const v = validateFactEvidence(updates, evidences, CONTENT);
    assert.equal(v.length, 1);
    assert.match(v[0].reason, /证据太短/);
});

test('validateFactEvidence：证据对不上 updates 的实体|键 → 拒（笔误不静默吞）', () => {
    const updates = parseFactLines('主角|境界|筑基三层');
    const evidences = parseFactEvidence('主角|佩刀|刀鞘上有血');
    const v = validateFactEvidence(updates, evidences, CONTENT);
    assert.equal(v.length, 1);
    assert.match(v[0].reason, /没有对应的 facts_updates/);
});

test('validateFactEvidence：不提供证据 → 一律放行（向后兼容）', () => {
    const updates = parseFactLines('主角|境界|筑基三层');
    assert.deepEqual(validateFactEvidence(updates, [], CONTENT), []);
    assert.deepEqual(validateFactEvidence(updates, undefined, CONTENT), []);
});

test('applyFactUpdates：带证据的更新随行落账；不带的不造 evidence 键（老行形状不变）', () => {
    const withEv = applyFactUpdates([], [
        { entity: '主角', key: '境界', value: '筑基三层', evidence: '从筑基二层滑入了筑基三层' },
        { entity: '主角', key: '佩刀', value: '鞘上有血' },
    ], { chapter: 3, now: NOW });
    assert.equal(withEv.added.length, 2);
    assert.equal(withEv.added[0].evidence, '从筑基二层滑入了筑基三层');
    assert.equal('evidence' in withEv.added[1], false, '没有证据的行不得出现空 evidence 键');
});

// ── 端到端（走真工具面：novel_write_chapter 的三入口共用同一条提交链）────────────

async function bootBook(book) {
    const p = await bootPlugin({ config: { minChapterChars: 300, maxChapterChars: 5000 } });
    const { tool, exec } = p;
    await tool('novel_project').execute({ action: 'init', book, title: book }, exec);
    await tool('novel_outline').execute({
        action: 'save_chapter', book, chapter: 1,
        outline: '## 本章必写场景\n- 破境：主角掐诀引动丹田灵机，境界从筑基二层滑入筑基三层（动作/环境/对话各 1 拍）\n- 染血：佩刀入鞘，刀鞘上有血（动作 1 拍）',
    }, exec);
    await tool('novel_outline').execute({ action: 'approve', book, chapter: 1 }, exec);
    return p;
}

test('端到端：证据不在正文 → 整章拒绝保存（GateRejectionError，文案点名实体|键）', async () => {
    const p = await bootBook('证据不符书');
    const { tool, exec, cleanup } = p;
    try {
        await assert.rejects(
            async () => tool('novel_write_chapter').execute({
                book: '证据不符书', chapter: 1, title: '破境',
                content: chapterOf(400),
                summary: '主角破境',
                facts_updates: '主角|境界|筑基三层',
                facts_evidence: '主角|境界|主角当场突破筑基三层，全场哗然。',
            }, exec),
            (err) => {
                assert.match(String(err?.message ?? err), /账本证据不符/, `驳回要点名证据不符：${err?.message ?? err}`);
                assert.match(String(err?.message ?? err), /主角\|境界/, '要点名是哪条事实的证据出了问题');
                assert.match(String(err?.message ?? err), /逐字找不到/, '要说清为什么拦');
                return true;
            },
        );
    } finally {
        cleanup();
    }
});

test('端到端：证据逐字在正文 → 落账成功，facts.json 行带 evidence，回执 addedFacts 带证据', async () => {
    const p = await bootBook('证据合规书');
    const { tool, exec, cleanup, readJson } = p;
    try {
        const content = `${chapterOf(400)}\n\n他掐诀引动丹田灵机，境界在一线之间从筑基二层滑入了筑基三层。`;
        const v = await tool('novel_write_chapter').execute({
            book: '证据合规书', chapter: 1, title: '破境',
            content,
            summary: '主角破境',
            facts_updates: '主角|境界|筑基三层',
            facts_evidence: '主角|境界|境界在一线之间从筑基二层滑入了筑基三层。',
        }, exec);
        assert.equal(v.addedFacts.length, 1);
        assert.equal(v.addedFacts[0].evidence, '境界在一线之间从筑基二层滑入了筑基三层。', '回执要带证据');
        const facts = readJson('证据合规书/账本/facts.json');
        const row = facts.find((f) => f.entity === '主角' && f.key === '境界');
        assert.ok(row, 'facts.json 里要有这条行');
        assert.equal(row.evidence, '境界在一线之间从筑基二层滑入了筑基三层。', '落盘行带证据（事后可对账）');
    } finally {
        cleanup();
    }
});

test('端到端：不给 facts_evidence → 行为与改造前完全一致（行无 evidence 键）', async () => {
    const p = await bootBook('无证据书');
    const { tool, exec, cleanup, readJson } = p;
    try {
        const v = await tool('novel_write_chapter').execute({
            book: '无证据书', chapter: 1, title: '破境',
            content: chapterOf(400),
            summary: '主角破境',
            facts_updates: '主角|境界|筑基三层',
        }, exec);
        assert.equal(v.addedFacts.length, 1);
        assert.equal('evidence' in v.addedFacts[0], false, '没给证据就不造键');
        const facts = readJson('无证据书/账本/facts.json');
        assert.equal('evidence' in facts[facts.length - 1], false);
    } finally {
        cleanup();
    }
});
