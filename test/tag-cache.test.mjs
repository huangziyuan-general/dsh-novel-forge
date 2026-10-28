// test/tag-cache.test.mjs — 打标的**内容指纹缓存**（lib/tag-cache.js）+ 标签张冠李戴的修复。
//
// 修的是什么（**已复现**，不是理论风险）：
//   给第 2 段正文打了标签「雪夜 决斗」→ 下次 build 之后，第 1、3、4 段也全带上
//   「雪夜 决斗」。检索因此会召回根本不写决斗的段落——**标签增强反而在制造误召回**。
//
//   根因是三处相乘：
//     ① 标签继承是**章级**的（`SELECT DISTINCT ch, tags` → Map<ch, tags> → 整章共用一份）；
//     ② 块的指纹含标签 → 打标这个动作改掉了块的指纹；
//     ③ 增量索引靠「指纹没变」跳过 → 指纹一变整章判为「更新」，被那份章级标签重写。
//
// 这组测试钉五件事：
//   ① 标签绑定**内容指纹**，不绑定章或块序号（标签不张冠李戴）；
//   ② 内容没变 → 指纹没变 → 整块跳过 → 标签原样保留；
//   ③ **缓存命中不调模型**（同样的输入不重复调模型 = 竞品 A 的节点级缓存指纹）；
//   ④ 同文本只调一次模型（书里重复段落、跨章相似段落）；
//   ⑤ 老库迁移不丢标签，且**跳过被污染的章**（不把「整章标签一样」这份污染固化进缓存）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { tmpdir } = os;

import { applyCachedTags, legacyPollution, planAnnotations, tagFingerprint } from '../lib/tag-cache.js';
import {
    openIndex, chunkChapter, upsertChunks, setChunkTags, untaggedChunks,
    readTagCacheForTexts, writeTagCache, migrateLegacyTags, bigrams,
} from '../lib/retrieval.js';
import { annotateChunks } from '../lib/engine-tasks.js';
import { indexChapters, openIndexForBook } from '../lib/index-store.js';
import { pathsFor } from '../lib/store.js';
import { bootPlugin } from './helpers/plugin.mjs';

// ── 夹具 ────────────────────────────────────────────────────────────────────

/** 一章正文：四段足够长，能切出多块（切块目标 ~300 字）。 */
const CHAPTER_TEXT = [
    '雪夜的停尸房里，他点亮了油灯，灯焰在潮湿的墙面上晃出一道昏黄的影子。屋外雨没有停，檐水顺着瓦沟连成一条细线，落在阶前的石板上，碎成一片细密的白响。他把白布掀开一角，看了看那张已经僵硬的脸，又把布角掖回去，指节在灯下泛着青白。',
    '门外的脚步声停在门槛外，来人自称张三，敲了三下门，不轻不重，像是知道屋里有人却不肯先出声。他隔着门板问了一句来意，那人答得很短，说是要找一具没有名字的尸体。屋里的油灯又晃了一下，他才想起来门闩还插着。',
    '灯芯爆了一下，尸体上的红泥印记在灯下泛着湿光，像是刚从城外的路上带回来的。他弯下腰，用袖口蘸了一点泥，凑近鼻端闻了闻，泥里混着草叶和铁锈的味道。那不是河泥，是北街窑场一带才有的红土。这个念头让他停了很久。',
    '天快亮时，他把布鞋收进柜子，关上了门。雨停了，巷子里开始有挑担子的声音远远传过来。他站在门内听着，忽然觉得自己这一夜做过的所有事，从验尸到收殓，都不像是在处理一具尸体，倒像是在替某个还不肯露面的人，把一段路先铺好。',
].join('\n\n');

/** 假引擎：记录每次 annotate 调用，按 responder 回标签。 */
function fakeEngine(responder = () => '标签甲 标签乙') {
    const calls = [];
    return {
        calls,
        async run(channel, args) {
            calls.push({ channel, prompt: args.prompt });
            const text = responder(channel, args.prompt, calls.length);
            if (text === null) {
                return { ok: false, error: { code: 'SIM_FAIL', message: '模拟失败', advice: '重发一次' }, attempts: 1 };
            }
            return { ok: true, text, attempts: 1 };
        },
    };
}

/** 起一个真 sqlite 索引库（临时目录）。 */
async function tmpDb() {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'novel-tagcache-'));
    const opened = await openIndex(path.join(dir, 'index.db'));
    assert.ok(opened.ok, `索引库打不开：${opened.reason}`);
    return { dir, db: opened.db };
}

/** 建一章、索引、返回库与块。 */
async function indexedChapter(text = CHAPTER_TEXT) {
    const { dir, db } = await tmpDb();
    const chunks = chunkChapter(text, { chapter: 1 });
    upsertChunks(db, chunks);
    return { dir, db, chunks };
}

const tagsOf = (db, ch = 1) => db.prepare('SELECT seq, tags FROM chunks WHERE ch = ? ORDER BY seq').all(ch);

// ── ① 纯函数：指纹 ──────────────────────────────────────────────────────────

test('指纹：同一段文字永远同一个，不同文字不同', () => {
    assert.equal(tagFingerprint('同一段文字'), tagFingerprint('同一段文字'));
    assert.notEqual(tagFingerprint('同一段文字'), tagFingerprint('另一段文字'));
    assert.match(tagFingerprint('x'), /^[0-9a-f]{16}$/, '指纹格式与依据指纹一致（sha256 前 16 位）');
});

test('指纹：空白差异算不同（内容变了就该重新打标）', () => {
    assert.notEqual(tagFingerprint('雪夜 决斗'), tagFingerprint('雪夜 决斗 '));
});

// ── ② 纯函数：打标计划三分 ──────────────────────────────────────────────────

test('打标计划：缓存命中 / 未命中 / 同文本合并，三种去向各归各', () => {
    const rows = [
        { ch: 1, seq: 0, text: '甲段' },
        { ch: 1, seq: 1, text: '乙段' },
        { ch: 2, seq: 0, text: '乙段' },
    ];
    const cache = new Map([[tagFingerprint('甲段'), '命中标签']]);
    const plan = planAnnotations(rows, cache);
    assert.equal(plan.hits.length, 1, '缓存命中的块直接写回，不调模型');
    assert.equal(plan.hits[0].row.seq, 0);
    assert.equal(plan.hits[0].tags, '命中标签');
    assert.equal(plan.misses.length, 1, '乙段是本批的代表，要调一次模型');
    assert.equal(plan.misses[0].row.seq, 1);
    assert.equal(plan.dupes.length, 1, '同样的文字不重复调模型');
    assert.equal(plan.dupes[0].row.ch, 2, '重复的那块是第 2 章那块');
    assert.equal(plan.dupes[0].fp, plan.misses[0].fp, '它与代表块同指纹');
});

test('打标计划：有键但没值不算命中（宁可多调一次模型）', () => {
    const cache = new Map([[tagFingerprint('甲段'), '']]);
    const plan = planAnnotations([{ ch: 1, seq: 0, text: '甲段' }], cache);
    assert.equal(plan.hits.length, 0);
    assert.equal(plan.misses.length, 1);
});

// ── ③ 纯函数：标签回填 ──────────────────────────────────────────────────────

test('回填：按内容指纹把标签贴回块；缓存里没有的不动', () => {
    const chunks = chunkChapter(CHAPTER_TEXT, { chapter: 1 });
    const target = chunks[1];
    const cache = new Map([[tagFingerprint(target.text), '雪夜 决斗']]);
    const out = applyCachedTags(chunks, cache);
    assert.equal(out[1].tags, '雪夜 决斗', '命中的块该有标签');
    assert.equal(out[0].tags, '', '没命中的块不该有标签');
    assert.equal(chunks[1].tags, '', '不得改动入参');
});

// ── ④ 纯函数：污染判定 ──────────────────────────────────────────────────────

test('污染判定：整章标签一模一样 = 被广播过的（污染签名）', () => {
    const same = legacyPollution([
        { text: '甲', tags: '雪夜 决斗' },
        { text: '乙', tags: '雪夜 决斗' },
        { text: '丙', tags: '雪夜 决斗' },
    ]);
    assert.equal(same.polluted, true);
});

test('污染判定：标签各不相同 = 正常章；单块章不算污染', () => {
    assert.equal(legacyPollution([
        { text: '甲', tags: '雪夜' },
        { text: '乙', tags: '决斗' },
    ]).polluted, false);
    assert.equal(legacyPollution([{ text: '甲', tags: '雪夜' }]).polluted, false);
});

// ── ⑤ ★ 核心回归：标签不张冠李戴 ───────────────────────────────────────────

test('★ 打标一次后重建索引，标签留在原块，不广播到别的块', async () => {
    const { dir, db, chunks } = await indexedChapter();
    try {
        assert.ok(chunks.length >= 2, '本章要能切出多块才验得出广播');
        // 只给第 2 块（seq=1）打标
        setChunkTags(db, 1, 1, '雪夜 决斗');

        // 重建索引（旧实现在这里会把整章刷成同一份标签）
        const cache = readTagCacheForTexts(db, chunks.map((c) => c.text));
        const tagged = applyCachedTags(chunks, cache);
        upsertChunks(db, tagged);

        const rows = tagsOf(db);
        assert.equal(rows[1].tags, '雪夜 决斗', '被打标的块标签还在');
        assert.equal(rows[0].tags, '', '★ 别的块不许被贴上这份标签');
        assert.ok(rows.slice(2).every((r) => r.tags === ''), '★ 后续块也不许被贴');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('★ 内容没变 → 指纹没变 → 整块跳过 → 标签原样保留', async () => {
    const { dir, db, chunks } = await indexedChapter();
    try {
        setChunkTags(db, 1, 1, '雪夜 决斗');
        const before = tagsOf(db);
        // 原样重建（内容没变）
        upsertChunks(db, applyCachedTags(chunks, readTagCacheForTexts(db, chunks.map((c) => c.text))));
        const after = tagsOf(db);
        assert.deepEqual(after.map((r) => r.tags), before.map((r) => r.tags), '标签必须一字不差地留着');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── ⑥ ★ 缓存命中不调模型 ───────────────────────────────────────────────────

test('★ 同样的输入不重复调模型：缓存命中时 calls=0', async () => {
    const { dir, db, chunks } = await indexedChapter();
    try {
        const engine = fakeEngine(() => '雪夜 决斗');
        const first = await annotateChunks({ db, engine, rows: chunks });
        assert.equal(first.calls, chunks.length, '第一次每块不同文本，各调一次模型');
        assert.equal(first.annotated, chunks.length);
        assert.equal(first.reused, 0);

        // 把标签清掉（模拟「块还没标上」），但缓存里已经有了
        db.prepare("UPDATE chunks SET tags = ''").run();
        const second = await annotateChunks({ db, engine, rows: untaggedChunks(db, { limit: 99 }) });
        assert.equal(second.calls, 0, '★ 缓存命中，一次模型调用都不该花');
        assert.equal(second.reused, chunks.length, '全部块都是复用的');
        assert.equal(engine.calls.length, chunks.length, '★ 引擎总共只被调过每块一次');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('★ 同文本只调一次模型：书里重复的段落不重复烧钱', async () => {
    const { dir, db } = await tmpDb();
    try {
        const same = '门外的脚步声停在门槛外，来人自称张三，敲了三下门，不轻不重。';
        upsertChunks(db, [
            { chapter: 1, seq: 0, text: same, hash: 'h0', tags: '', corpus: 'project' },
            { chapter: 1, seq: 1, text: same, hash: 'h1', tags: '', corpus: 'project' },
        ]);
        const engine = fakeEngine(() => '脚步 张三 叩门');
        const r = await annotateChunks({ db, engine, rows: untaggedChunks(db, { limit: 99 }) });
        assert.equal(r.calls, 1, '★ 同样的文字只调一次模型');
        assert.equal(r.deduped, 1, '另一块复用同一份标签');
        assert.equal(r.annotated, 2, '两块都打上了标');
        assert.equal(engine.calls.length, 1);
        const rows = tagsOf(db);
        assert.equal(rows[0].tags, rows[1].tags, '同样的文字该有同样的标签');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('打标失败：不写标签、不崩，其余块照常', async () => {
    const { dir, db, chunks } = await indexedChapter();
    try {
        const engine = fakeEngine(() => null);
        const r = await annotateChunks({ db, engine, rows: chunks });
        assert.equal(r.annotated, 0);
        assert.ok(r.failures.length > 0, '失败要报出来');
        assert.ok(tagsOf(db).every((x) => x.tags === ''), '失败的块不许有标签');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── ⑦ 老库迁移 ─────────────────────────────────────────────────────────────

test('老库迁移：干净的章保留标签（用户付过的模型调用费不能白花）', async () => {
    const { dir, db, chunks } = await indexedChapter();
    try {
        setChunkTags(db, 1, 0, '第一段标签');
        setChunkTags(db, 1, 1, '第二段标签');
        const r = migrateLegacyTags(db);
        assert.equal(r.skippedChapters, 0, '标签各不相同的章不算污染');
        assert.ok(r.migrated >= 2);
        const cache = readTagCacheForTexts(db, chunks.map((c) => c.text));
        assert.equal(cache.get(tagFingerprint(chunks[0].text)), '第一段标签');
        assert.equal(cache.get(tagFingerprint(chunks[1].text)), '第二段标签');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('老库迁移：被广播污染的章清空正文索引里的标签', async () => {
    const { dir, db, chunks } = await indexedChapter();
    try {
        // 模拟老实现的章级继承：整章所有块被刷成同一份标签
        db.prepare("UPDATE chunks SET tags = '雪夜 决斗'").run();
        const r = migrateLegacyTags(db);
        assert.equal(r.skippedChapters, 1, '★ 整章标签一样的章判定为污染');
        assert.equal(r.migrated, 0, '污染的章不补录');
        const cache = readTagCacheForTexts(db, chunks.map((c) => c.text));
        assert.equal(cache.size, 0, '缓存里不该留下这份污染');
        assert.ok(r.clearedTags > 0, '要报告清掉了多少条旧标签');
        const rows = db.prepare('SELECT tags FROM chunks ORDER BY seq').all();
        assert.ok(rows.every((row) => row.tags === ''), '★ 正文索引里的污染标签也必须清空');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

/**
 * 污染清理必须**同步重建检索列**：`seg.body` 里拼的是 `bigrams(正文) + bigrams(标签)`，
 * 只 `UPDATE chunks SET tags=''` 而不动 seg，标签就从表面上消失了、检索里却还能命中它
 * （误召回原样留着）。这条用例钉住的是「将来有人把逐块 setChunkTags 当成与 bulk UPDATE
 * 重复的代码删掉」——那不是一次清理，是把污染从索引里留在检索面上。
 */
test('★ 污染章清标必须把标签从检索列（seg）里一起抹掉', async () => {
    const { dir, db, chunks } = await indexedChapter();
    try {
        const pollutedTag = '雪夜 决斗';
        // 走**真打标路径**污染整章（老实现的章级继承就是这个形状）：
        // setChunkTags 同时写 chunks.tags 与 seg.body，标签因此既在表上也在检索列里。
        for (const c of chunks) setChunkTags(db, 1, c.seq, pollutedTag);
        // 前置：污染标签确实在检索列里（不清 = 误召回原样留着）
        const tagBigram = bigrams(pollutedTag).filter((g) => !bigrams(chunks[0].text).includes(g))[0];
        assert.ok(tagBigram, '夹具：要有一个只属于标签、不在正文里的大片段');
        assert.ok(db.prepare('SELECT count(*) AS n FROM seg WHERE body LIKE ?').get(`%${tagBigram}%`).n > 0,
            '前置：污染标签已进入检索列');

        migrateLegacyTags(db);

        assert.equal(db.prepare('SELECT count(*) AS n FROM seg WHERE body LIKE ?').get(`%${tagBigram}%`).n, 0,
            '★ 迁移后检索列里不得再残留污染标签');
        // 正文本身仍可被搜到（清污不许把索引清废）
        const bodyGram = bigrams(chunks[0].text)[10];
        assert.ok(db.prepare('SELECT count(*) AS n FROM seg WHERE body LIKE ?').get(`%${bodyGram}%`).n > 0,
            '正文大片段必须还在');
    } finally {
        db.close();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

// ── ⑧ 端到端：真插件 + 真索引（indexChapters 那条路径）─────────────────────

test('★ 端到端：indexChapters 不再章级继承（打标后重建，标签留在原块）', async () => {
    const p = await bootPlugin();
    const { root, cleanup } = p;
    try {
        const book = '标签书';
        const rel = `${book}/正文/第1章.md`;
        fs.mkdirSync(path.join(root, book, '正文'), { recursive: true });
        fs.writeFileSync(path.join(root, rel), CHAPTER_TEXT, 'utf8');

        const io = p.io();
        const paths = pathsFor(book);
        const novel = { chapters: { 1: { path: rel } } };

        const built = await indexChapters({ io, p: paths, book, novel });
        assert.equal(built.ok, true, built.reason ?? '');
        assert.ok(built.chunks >= 2, '本章要切出多块');

        // 给第 2 块打标
        const opened = await openIndexForBook(io, paths);
        assert.ok(opened.ok, opened.reason ?? '');
        setChunkTags(opened.db, 1, 1, '雪夜 决斗');
        opened.db.close();

        // 重建索引——这一步以前会把整章刷成同一份标签
        const rebuilt = await indexChapters({ io, p: paths, book, novel });
        assert.equal(rebuilt.ok, true, rebuilt.reason ?? '');

        const opened2 = await openIndexForBook(io, paths);
        const rows = tagsOf(opened2.db);
        opened2.db.close();
        assert.equal(rows[1].tags, '雪夜 决斗', '被打标的块标签还在');
        assert.equal(rows[0].tags, '', '★ 别的块不许被贴上这份标签');
    } finally {
        cleanup();
    }
});
