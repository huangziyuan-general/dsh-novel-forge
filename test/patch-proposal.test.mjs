// 1.6.x：润色守卫的数字/专名保护 + patch 类型提案（定位/重叠/比例/原子性）。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { validatePolishEdits, applyTextPatches, numberTokenDiff } from '../lib/polish.js';
import { proposeRevision } from '../lib/proposals.js';
import { bootPlugin, chapterOf } from './helpers/plugin.mjs';

test('润色守卫：数字 token 多重集变了就拦（格式归一不算）', () => {
    const original = '他数到 3，院外 300 步有 2 个人。';
    const changed = validatePolishEdits(original, '他数到 3，院外 300 步有 3 个人。');
    assert.equal(changed.ok, false);
    assert.ok(changed.blocking.some((b) => b.code === 'number-token-changed'));
    assert.ok(changed.blocking.find((b) => b.code === 'number-token-changed').message.includes('「2」1→0'));

    const formatOnly = validatePolishEdits('他数到 ３，院外 300 步有 2 个人。', '他数到 3，院外 300 步有 2 个人。');
    assert.equal(formatOnly.ok, true, '全角→半角只是格式，不算改数字');

    assert.deepEqual(numberTokenDiff('a 1 b 1', 'a 1 b 1'), []);
});

test('润色守卫：人物专名出现次数变了就拦；没给名字表时保持旧行为', () => {
    const original = '周传海推门进来。周传海把伞收好。灯还亮着。';
    const dropped = validatePolishEdits(original, '周传海推门进来。他把伞收好。灯还亮着。', { names: ['周传海'] });
    assert.equal(dropped.ok, false);
    assert.ok(dropped.blocking.some((b) => b.code === 'proper-name-count-changed'));
    assert.ok(dropped.blocking.find((b) => b.code === 'proper-name-count-changed').message.includes('「周传海」2→1'));

    const extra = validatePolishEdits('他推门进来。灯还亮着。', '周传海推门进来。灯还亮着。', { names: ['周传海'] });
    assert.equal(extra.ok, false, '多出来一次同样是换了人');

    const noNames = validatePolishEdits(original, '周传海推门进来。他把伞收好。灯还亮着。');
    assert.equal(noNames.ok, true, '不传 names 不启用专名校验（向后兼容）');
});

test('补丁应用：唯一匹配、从后往前、区间不重叠', () => {
    const pad = '这是一段与补丁无关的铺垫文字。'.repeat(20);
    const base = `开头 ${pad}AAA 中间 BBB 结尾 ${pad}CCC。`;
    const r = applyTextPatches(base, [
        { find: 'AAA', replace: '甲' },
        { find: 'CCC', replace: '丙' },
    ]);
    assert.equal(r.text, `开头 ${pad}甲 中间 BBB 结尾 ${pad}丙。`);
    assert.equal(r.patches.length, 2);
    assert.ok(r.touchedRatio > 0 && r.touchedRatio < 0.35);

    assert.throws(() => applyTextPatches('x AAA y AAA', [{ find: 'AAA', replace: 'b' }]), /出现多次/);
    assert.throws(() => applyTextPatches(base, [{ find: '不存在', replace: 'b' }]), /找不到/);
    assert.throws(() => applyTextPatches('abcdef', [
        { find: 'abc', replace: 'x' },
        { find: 'bcd', replace: 'y' },
    ]), /重叠/);
    const longBase = Array.from({ length: 200 }, (_, i) => String.fromCharCode(0x4e00 + i)).join('');
    assert.throws(() => applyTextPatches(longBase, [
        { find: longBase.slice(0, 80), replace: 'x' },
    ]), /超过上限/);
    assert.throws(() => applyTextPatches(`锚点${'甲'.repeat(408)}`, [
        { find: '锚点', replace: '乙'.repeat(880) },
    ]), /超过上限/, '短锚点夹带长 replace 也算大规模修改');
});

let h;
before(async () => { h = await bootPlugin(); });
after(() => h.cleanup());

async function bookWithChapter(book) {
    await h.tool('novel_project').execute({ action: 'init', book }, h.exec);
    await h.tool('novel_write_chapter').execute({
        book, chapter: 1, title: '初稿', content: chapterOf(2400), summary: '第一版', force: true,
    }, h.exec);
    const meta = h.readJson(`${book}/novel.json`);
    return { meta, content: h.read(meta.chapters['1'].path) };
}

const propose = (book, args) => h.tool('novel_propose').execute({
    action: 'propose', book, chapter: 1, reason: '局部修补', ...args,
}, h.exec);

test('patch 提案：先应用成完整文本再过原提案通道，文件与回执照实标注语义未判', async () => {
    const book = '补丁本';
    const { content } = await bookWithChapter(book);
    const find = '门外忽然传来三声叩击';
    assert.equal(content.split(find).length - 1, 1, '夹具锚点必须唯一');

    const created = await propose(book, { patches: [{ find, replace: '门外忽然传来两声叩击' }], base_version: 1 });
    assert.equal(created.patch.count, 1);
    assert.equal(created.patch.semanticCheck, 'unverified');
    assert.equal(created.baseVersion, 1);

    const file = h.readJson(`${book}/.novel/proposals/${created.id}.json`);
    assert.equal(file.type, 'patch');
    assert.equal(file.baseVersion, 1);
    assert.equal(file.semanticCheck, 'unverified');
    assert.ok(file.reason.includes('语义'), 'reason 里要如实写明语义判不了');
    assert.ok(file.content.includes('两声叩击') && !file.content.includes('三声叩击'), '提案内容是补丁应用后的完整文本');
    assert.ok(Array.isArray(file.patches) && file.patches[0].start >= 0, '补丁定位进文件，便于事后核对');
    assert.equal(h.readJson(`${book}/novel.json`).proposals.length, 1);
});

test('patch 提案原子失败：任一补丁不成立 → 抛错且不登记提案', async () => {
    const book = '补丁失败本';
    const { content } = await bookWithChapter(book);
    await assert.rejects(
        () => propose(book, { patches: [
            { find: '门外忽然传来三声叩击', replace: '门外忽然传来两声叩击' },
            { find: '这段正文里没有', replace: 'x' },
        ] }),
        /找不到/,
    );
    assert.equal(h.readJson(`${book}/novel.json`).proposals.length, 0, '整稿回退：不能留下半份提案');
    assert.ok(content.includes('三声叩击'), '正文不受影响');
});

test('patch 提案：content 与 patches 二选一；base_version 不一致拒绝', async () => {
    const book = '补丁参数本';
    await bookWithChapter(book);
    await assert.rejects(() => propose(book, { content: chapterOf(2400), patches: [{ find: 'x', replace: 'y' }] }), /二选一/);
    await assert.rejects(
        () => propose(book, { patches: [{ find: '门外忽然传来三声叩击', replace: '两声' }], base_version: 9 }),
        /基于 v9.*当前已是 v1/,
    );
    assert.equal(h.readJson(`${book}/novel.json`).proposals.length, 0);
});

test('patch 提案：读取基线后章节升级，登记时必须拒绝而不是改写 baseVersion', async () => {
    const book = '补丁竞态本';
    const metaPath = `${book}/novel.json`;
    let latest = 1;
    let diskVersion = 1;
    let registered = false;
    const novel = () => ({
        title: book, platform: '', proposals: [], updatedAt: '2026-01-01T00:00:00.000Z',
        chapters: { 1: { title: '一', latest, path: `${book}/ch1.md`, files: [{ version: latest, file: `${book}/ch1.md` }] } },
    });
    const io = {
        readJson: async (path) => path === metaPath ? novel() : null,
        readJsonWithVersion: async (path) => ({ value: path === metaPath ? novel() : null, version: String(diskVersion) }),
        readText: async () => { latest = 2; diskVersion += 1; return `甲${'文'.repeat(99)}`; },
        writeJson: async () => { registered = true; },
        writeJsonAtVersion: async () => { registered = true; },
        appendLine: async () => {},
    };
    await assert.rejects(() => proposeRevision(io, book, {
        chapter: 1, base_version: 1, patches: [{ find: '甲', replace: '乙' }],
    }, { minChapterChars: 1, maxChapterChars: 1000, quoteStyle: 'block' }), /提案基于 v1.*当前已是 v2/);
    assert.equal(registered, false, '陈旧补丁不得留下提案文件或索引');
});

test('content 提案同样受乐观锁保护：base_version 与当前 latest 不一致直接拒绝', async () => {
    const book = '整章基线本';
    await bookWithChapter(book);
    await assert.rejects(
        () => propose(book, { content: chapterOf(2400), base_version: 9 }),
        /提案基于 v9.*当前已是 v1/,
    );
    assert.equal(h.readJson(`${book}/novel.json`).proposals.length, 0);
});

test('content 提案：读取后章节升级，登记时必须拒绝（CAS 复核，不只靠入口快照）', async () => {
    const book = '整章竞态本';
    const metaPath = `${book}/novel.json`;
    let registered = false;
    const novel = (latest) => ({
        title: book, platform: '', proposals: [], updatedAt: '2026-01-01T00:00:00.000Z',
        chapters: { 1: { title: '一', latest, path: `${book}/ch1.md`, files: [{ version: latest, file: `${book}/ch1.md` }] } },
    });
    // 入口读到 v1（本次提案基于它），登记时盘上已是 v2 —— 模拟「读正文 → 提交」之间的升级。
    const io = {
        readJson: async (path) => path === metaPath ? novel(1) : null,
        readJsonWithVersion: async (path) => ({ value: path === metaPath ? novel(2) : null, version: '2' }),
        writeJson: async () => { registered = true; },
        writeJsonAtVersion: async () => { registered = true; },
        appendLine: async () => {},
    };
    await assert.rejects(() => proposeRevision(io, book, {
        chapter: 1, content: `修${'文'.repeat(99)}`,
    }, { minChapterChars: 1, maxChapterChars: 1000, quoteStyle: 'block' }), /提案基于 v1.*当前已是 v2/);
    assert.equal(registered, false, '陈旧整章提案不得留下提案文件或索引');
});
