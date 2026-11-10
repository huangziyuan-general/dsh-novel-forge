import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseExtractionDetails, mergeCharacterCard } from '../lib/extraction.js';
import {
    applyExtractionProposal, captureExtractionTargets, listExtractionProposals, submitExtractionProposal,
} from '../lib/extraction-io.js';
import { pathsFor } from '../lib/store.js';
import { createFsio } from '../lib/fsio.js';
import { createNodeFsBackend } from '../lib/mcp-standalone.js';
import { defineExtractionTool } from '../lib/tools/extraction-tool.js';

const chapters = [{ n: 1, title: '旧稿', content: '林砚把旧钥匙挂在腰间。别人只叫他阿砚。城南渡口每逢涨潮便封闭。' }];
const valid = {
    items: [
        { kind: 'character', name: '林砚', aliases: ['阿砚'], content: '随身带着一把旧钥匙。', chapter: 1, quote: '林砚把旧钥匙挂在腰间。别人只叫他阿砚。' },
        { kind: 'worldbook', name: '城南渡口', aliases: [], keywords: [], content: '涨潮时封闭。', chapter: 1, quote: '城南渡口每逢涨潮便封闭。' },
    ],
};

test('档案抽取：证据逐字核验，合法候选保留章节与引文', () => {
    const parsed = parseExtractionDetails(JSON.stringify(valid), { chapters });
    assert.equal(parsed.items.length, 2);
    assert.deepEqual(parsed.items[0].aliases, ['阿砚']);
    assert.deepEqual(parsed.items[1].keywords, ['城南渡口']);
    assert.equal(parsed.items[1].chapter, 1);
});

test('档案抽取：单条证据造假只拒该条，合法候选保留；全非法才抛错', () => {
    const fake = structuredClone(valid);
    fake.items[0].quote = '林砚有一把从未出现过的青铜钥匙。';
    const parsed = parseExtractionDetails(JSON.stringify(fake), { chapters });
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].name, '城南渡口');
    assert.equal(parsed.rejected.length, 1);
    assert.match(parsed.rejected[0].reason, /第 1 条.*逐字找不到/);

    const wrong = structuredClone(valid);
    wrong.items[0].name = '旁人';
    wrong.items[0].aliases = [];
    const parsedWrong = parseExtractionDetails(JSON.stringify(wrong), { chapters });
    assert.equal(parsedWrong.items.length, 1);
    assert.match(parsedWrong.rejected[0].reason, /第 1 条.*不能证明归属/);

    // 全部非法时仍抛错，避免调用方误以为「模型没找到候选」
    assert.throws(() => parseExtractionDetails(JSON.stringify({ items: [fake.items[0]] }), { chapters }), /没有可用的候选.*逐字找不到/);
});

test('档案抽取：aliases 类型错误先校验，报第几项哪个字段而非 TypeError', () => {
    const bad = structuredClone(valid);
    bad.items[0].aliases = '阿砚';
    const parsed = parseExtractionDetails(JSON.stringify(bad), { chapters });
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].name, '城南渡口');
    assert.equal(parsed.rejected.length, 1);
    assert.match(parsed.rejected[0].reason, /第 1 条 aliases 必须是最多 8 项的字符串数组/);
    assert.doesNotMatch(parsed.rejected[0].reason, /is not a function/);
});

test('档案抽取：首条非法候选不污染后续同名合法候选的去重状态', () => {
    const invalid = { ...valid.items[0], priority: -1 };
    const parsed = parseExtractionDetails(JSON.stringify({ items: [invalid, valid.items[0]] }), { chapters });
    assert.equal(parsed.items.length, 1);
    assert.equal(parsed.items[0].name, '林砚');
    assert.equal(parsed.rejected.length, 1);
    assert.match(parsed.rejected[0].reason, /priority/);
});

test('档案抽取：已有卡只追加候选，不抹掉原档案', () => {
    const next = mergeCharacterCard('# 林砚\n\n人工档案。', valid.items[0]);
    assert.match(next, /人工档案/);
    assert.match(next, /旧稿抽取补充/);
    assert.match(next, /别名：阿砚/);
});

async function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-extraction-'));
    const book = '抽取书';
    const p = pathsFor(book);
    fs.mkdirSync(path.join(root, book), { recursive: true });
    const rel = p.chapterFile(1, '旧稿', 1);
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), chapters[0].content);
    fs.writeFileSync(path.join(root, p.meta), JSON.stringify({ title: book, cast: [], chapters: { 1: {
        title: '旧稿', latest: 1, versions: [1], path: rel, files: [{ version: 1, file: rel }], chars: chapters[0].content.length, summary: '',
    } } }));
    const ctx = { fs: createNodeFsBackend(root), emit() {}, logger: { info() {} } };
    const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: root, id: 'extract-test' } } } };
    const io = createFsio(ctx, exec, root);
    return { root, book, p, io, ctx, exec };
}

test('档案抽取工具：annotate 只落待批提案，输出过宿主真 schema', async () => {
    const { root, book, p, io, ctx, exec } = await fixture();
    try {
        const calls = [];
        const tool = defineExtractionTool(ctx, {}, { engine: { run: async (channel, request) => {
            calls.push({ channel, request });
            return { ok: true, text: JSON.stringify(valid) };
        } } });
        const result = await tool.execute({ book, from: 1, to: 1 }, exec);
        assert.equal(result.count, 2);
        assert.equal(calls[0].channel, 'annotate');
        assert.match(calls[0].request.prompt, /林砚把旧钥匙/);
        const proposals = await listExtractionProposals(io, p);
        assert.equal(proposals[0].status, 'pending');
        assert.equal(proposals[0].items.every((item) => item.status === 'pending'), true);
        const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
        assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result), []);
        assert.doesNotThrow(() => tool.output.render({}, result));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('档案抽取：逐项编辑应用，未选项不动正式档案', async () => {
    const { root, book, p, io } = await fixture();
    try {
        const items = await captureExtractionTargets(io, p, parseExtractionDetails(JSON.stringify(valid), { chapters }).items);
        const proposal = await submitExtractionProposal(io, p, { items, from: 1, to: 1 });
        const result = await applyExtractionProposal(io, book, proposal.id, [
            { id: 'X1', name: '林砚', aliases: ['阿砚'], content: '旧钥匙是他的随身物。' },
        ]);
        assert.equal(result.count, 1);
        assert.match(await io.readText(p.character('林砚')), /旧钥匙是他的随身物/);
        assert.equal(await io.readJson(p.worldbook), null, '未选世界书候选不得落盘');
        const saved = await listExtractionProposals(io, p);
        assert.equal(saved[0].status, 'partial');
        assert.equal(saved[0].items[0].status, 'applied');
        assert.equal(saved[0].items[1].status, 'pending');
        await assert.rejects(() => applyExtractionProposal(io, book, proposal.id, [{ id: 'X1' }, { id: 'X2' }]), /尚未应用任何一项/);
        assert.equal(await io.readJson(p.worldbook), null, '含已处理项的过期批量选择必须在校验阶段整体拒绝');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('档案抽取：中途失败时错误文案带已应用项数与项标识', async () => {
    const { root, book, p, io } = await fixture();
    try {
        const items = await captureExtractionTargets(io, p, parseExtractionDetails(JSON.stringify(valid), { chapters }).items);
        const proposal = await submitExtractionProposal(io, p, { items, from: 1, to: 1 });
        // 提案生成后人工新建世界书 → 第二项（世界书）必然冲突，第一项（人物）已落盘
        await io.writeJson(p.worldbook, [{ name: '城南渡口', aliases: [], keywords: ['城南渡口'], content: '人工写的旧条目。', always: false, priority: 50 }]);
        await assert.rejects(
            () => applyExtractionProposal(io, book, proposal.id, [{ id: 'X1' }, { id: 'X2' }]),
            (error) => /已应用 1 项（X1）/.test(String(error?.message ?? '')),
        );
        assert.match(await io.readText(p.character('林砚')), /随身带着一把旧钥匙/);
        const saved = await listExtractionProposals(io, p);
        assert.equal(saved[0].items[0].status, 'applied');
        assert.equal(saved[0].items[1].status, 'pending');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('档案抽取：当前项写入后标记失败必须明示，并可用同项重试完成对账', async () => {
    const { root, book, p, io } = await fixture();
    try {
        const items = await captureExtractionTargets(io, p, parseExtractionDetails(JSON.stringify(valid), { chapters }).items);
        const proposal = await submitExtractionProposal(io, p, { items, from: 1, to: 1 });
        const failingIo = { ...io, async writeJsonAtVersion(target, value, version) {
            if (target === p.extractionProposals) throw new Error('INJECTED_MARK_FAILURE');
            return io.writeJsonAtVersion(target, value, version);
        } };
        await assert.rejects(
            () => applyExtractionProposal(failingIo, book, proposal.id, [{ id: 'X1' }]),
            (error) => /已应用 0 项；第 X1 项档案已写入，但提案状态未更新/.test(String(error?.message ?? '')),
        );
        assert.match(await io.readText(p.character('林砚')), /随身带着一把旧钥匙/);
        assert.deepEqual((await io.readJson(p.meta)).cast, ['林砚']);
        assert.equal((await listExtractionProposals(io, p))[0].items[0].status, 'pending');

        const retried = await applyExtractionProposal(io, book, proposal.id, [{ id: 'X1' }]);
        assert.equal(retried.count, 1);
        assert.equal((await listExtractionProposals(io, p))[0].items[0].status, 'applied');
        const card = await io.readText(p.character('林砚'));
        assert.equal(card.match(/随身带着一把旧钥匙。/g)?.length, 1, '重试不得重复追加人物卡内容');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('档案抽取：人物卡已写但书目索引失败时报告部分写入，重试后补齐状态', async () => {
    const { root, book, p, io } = await fixture();
    try {
        const items = await captureExtractionTargets(io, p, parseExtractionDetails(JSON.stringify(valid), { chapters }).items);
        const proposal = await submitExtractionProposal(io, p, { items, from: 1, to: 1 });
        const failingIo = { ...io, async writeJsonAtVersion(target, value, version) {
            if (target === p.meta) throw new Error('INJECTED_META_FAILURE');
            return io.writeJsonAtVersion(target, value, version);
        } };
        await assert.rejects(
            () => applyExtractionProposal(failingIo, book, proposal.id, [{ id: 'X1' }]),
            (error) => /第 X1 项人物卡内容已落盘，但书目人物索引与提案状态未确认/.test(String(error?.message ?? '')),
        );
        assert.match(await io.readText(p.character('林砚')), /随身带着一把旧钥匙/);
        assert.deepEqual((await io.readJson(p.meta)).cast, []);
        assert.equal((await listExtractionProposals(io, p))[0].items[0].status, 'pending');

        const retried = await applyExtractionProposal(io, book, proposal.id, [{ id: 'X1' }]);
        assert.equal(retried.count, 1);
        assert.deepEqual((await io.readJson(p.meta)).cast, ['林砚']);
        assert.equal((await listExtractionProposals(io, p))[0].items[0].status, 'applied');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('档案抽取：目标档案被人工改过后拒绝覆盖', async () => {
    const { root, book, p, io } = await fixture();
    try {
        await io.writeText(p.character('林砚'), '# 林砚\n\n抽取时档案。\n');
        const items = await captureExtractionTargets(io, p, parseExtractionDetails(JSON.stringify(valid), { chapters }).items);
        const proposal = await submitExtractionProposal(io, p, { items, from: 1, to: 1 });
        await io.writeText(p.character('林砚'), '# 林砚\n\n后来的人工修改。\n');
        await assert.rejects(() => applyExtractionProposal(io, book, proposal.id, [{ id: 'X1' }]), /已变化/);
        assert.match(await io.readText(p.character('林砚')), /后来的人工修改/);
        const saved = await listExtractionProposals(io, p);
        assert.equal(saved[0].items[0].status, 'pending');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('档案抽取：世界书只落所选项，冲突与重复应用都不覆盖现档', async () => {
    const { root, book, p, io } = await fixture();
    try {
        const parsed = parseExtractionDetails(JSON.stringify(valid), { chapters }).items;
        const items = await captureExtractionTargets(io, p, parsed);
        const proposal = await submitExtractionProposal(io, p, { items, from: 1, to: 1 });
        const applied = await applyExtractionProposal(io, book, proposal.id, [
            { id: 'X2', name: '城南渡口', content: '涨潮封闭，只有持牌船家可通行。', keywords: ['渡口', '城南渡口'], always: true, priority: 70 },
        ]);
        assert.equal(applied.count, 1);
        const entries = await io.readJson(p.worldbook);
        assert.equal(entries.length, 1);
        assert.equal(entries[0].always, true);
        assert.match(entries[0].content, /持牌船家/);
        assert.equal(await io.readText(p.character('林砚')), null);
        await assert.rejects(() => applyExtractionProposal(io, book, proposal.id, [{ id: 'X2' }]), /已处理/);

        const secondItems = await captureExtractionTargets(io, p, [parsed[1]]);
        const second = await submitExtractionProposal(io, p, { items: secondItems, from: 1, to: 1 });
        const changed = structuredClone(entries);
        changed[0].content = '人工修订：渡口已经停用。';
        await io.writeJson(p.worldbook, changed);
        await assert.rejects(() => applyExtractionProposal(io, book, second.id, [{ id: 'X2' }]), /已变化/);
        assert.match((await io.readJson(p.worldbook))[0].content, /人工修订/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
