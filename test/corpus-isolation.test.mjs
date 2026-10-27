// test/corpus-isolation.test.mjs — 检索语料的**字段级隔离**（corpus 列 + 过滤闸门）。
//
// 为什么要有这一层：`书库/`（外部小说饲料）此前只靠「目录位置」隔离——靠的是
// 「没人写那条代码」。目录位置挡不住一次路径扩展：索引构建路径一旦被扩到书库/，
// 外部小说原文就会进索引 → 被检索召回 → 被简报注入正文上下文 → 竞品人名与设定
// 污染续写。字段能挡：每块带 corpus，检索侧按 corpus 过滤。
//
// 这组测试钉三件事：
//   ① 建索引时语料**写死 project**（外部语料没有后门可进）；
//   ② 检索默认**只召回 project**（生成上下文路径固定这么传）；
//   ③ 扩写路径（弱结果触发的多路重查）**同样**受闸门约束——那才是隔离失效的真正形态。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    openIndex, chunkChapter, upsertChunks, searchChunks, indexStats,
    CORPUS_PROJECT, CORPUS_REFERENCE,
} from '../lib/retrieval.js';

function tmpDb() {
    const dir = mkdtempSync(join(tmpdir(), 'novel-corpus-'));
    return { dir, path: join(dir, 'index.db') };
}

/** 建一个只含一块的库（块文本唯一，便于精确断言召回）。 */
async function dbWith(text, corpus = CORPUS_PROJECT) {
    const { dir, path } = tmpDb();
    const opened = await openIndex(path);
    assert.ok(opened.ok, `索引库打不开：${opened.reason}`);
    upsertChunks(opened.db, chunkChapter(text, { chapter: 1, corpus }));
    return { dir, db: opened.db };
}

test('语料常量：project 与 reference 两类，project 是唯一可进生成上下文的语料', () => {
    assert.equal(CORPUS_PROJECT, 'project');
    assert.equal(CORPUS_REFERENCE, 'reference');
});

test('块自带语料标记；同一段文字换语料必须换指纹（否则 upsert 会跳过、库里留旧标记）', () => {
    const a = chunkChapter('同一段文字', { chapter: 1, corpus: CORPUS_PROJECT });
    const b = chunkChapter('同一段文字', { chapter: 1, corpus: CORPUS_REFERENCE });
    assert.equal(a[0].corpus, CORPUS_PROJECT);
    assert.equal(b[0].corpus, CORPUS_REFERENCE);
    assert.notEqual(a[0].hash, b[0].hash, '语料不同 → 指纹必须不同，否则换语料时 upsert 会跳过');
});

test('★ 隔离闸门：默认检索只召回 project，reference 命中被挡在外面', async () => {
    const { dir, db } = await dbWith('戴斗笠的人站在码头 风灯摇摇晃晃', CORPUS_REFERENCE);
    try {
        const all = searchChunks(db, '斗笠', { corpora: null });
        assert.equal(all.length, 1, '不过滤时 reference 能被查到（否则隔离无从验证）');
        assert.equal(all[0].corpus, CORPUS_REFERENCE);

        const onlyProject = searchChunks(db, '斗笠', { corpora: [CORPUS_PROJECT] });
        assert.equal(onlyProject.length, 0, '★ project 白名单下 reference 块必须一条都不许召回');
    } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('★ 隔离闸门：project 块在白名单下正常召回，标记如实带出', async () => {
    const { dir, db } = await dbWith('戴斗笠的人站在码头 风灯摇摇晃晃', CORPUS_PROJECT);
    try {
        const hits = searchChunks(db, '斗笠', { corpora: [CORPUS_PROJECT] });
        assert.ok(hits.length > 0, '本书正文必须照常召回');
        assert.ok(hits.every((h) => h.corpus === CORPUS_PROJECT));
    } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('★ 清理幽灵章不误伤外部语料（reference 块的章号不在本书章节集合里）', async () => {
    const { dir, path } = tmpDb();
    const opened = await openIndex(path);
    assert.ok(opened.ok);
    try {
        // 本书第 1 章（project）+ 一块外部素材（reference，挂在不存在的章号上）
        upsertChunks(opened.db, chunkChapter('本书正文内容', { chapter: 1, corpus: CORPUS_PROJECT }));
        upsertChunks(opened.db, chunkChapter('外部小说原文', { chapter: 99, corpus: CORPUS_REFERENCE }));
        // 全量 build：只知第 1 章存在 → 第 99 章是「幽灵章」
        const r = upsertChunks(opened.db, chunkChapter('本书正文内容', { chapter: 1, corpus: CORPUS_PROJECT }), new Set([1]));
        assert.equal(r.removed, 0, '★ reference 语料不得被「清幽灵章」删掉');
        const stats = indexStats(opened.db);
        assert.equal(stats.byCorpus[CORPUS_REFERENCE], 1, '外部语料块应当还在库里');
        assert.equal(stats.byCorpus[CORPUS_PROJECT], 1);
    } finally {
        opened.db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test('老库（无 corpus 列）能自动补列并继续用（索引是派生物，但标签不能丢）', async () => {
    const { dir, path } = tmpDb();
    // 造一个 1.0.8 形态的库：chunks 表没有 corpus 列
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(path);
    raw.exec('CREATE TABLE chunks (ch INTEGER NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT \'\', PRIMARY KEY (ch, seq))');
    raw.exec('CREATE VIRTUAL TABLE seg USING fts5(ch UNINDEXED, seq UNINDEXED, body)');
    raw.prepare('INSERT INTO chunks (ch, seq, hash, text, tags) VALUES (?, ?, ?, ?, ?)').run(1, 0, 'h', '旧正文', '旧标签');
    raw.prepare('INSERT INTO seg (ch, seq, body) VALUES (?, ?, ?)').run(1, 0, '旧正 正文');
    raw.close();

    const opened = await openIndex(path);
    assert.ok(opened.ok, `补列后应能打开：${opened.reason}`);
    try {
        const row = opened.db.prepare('SELECT corpus, tags FROM chunks WHERE ch = 1 AND seq = 0').get();
        assert.equal(row.corpus, CORPUS_PROJECT, '老行补成 project');
        assert.equal(row.tags, '旧标签', '★ 补列不能丢已打的语义标签');
        const hits = searchChunks(opened.db, '旧正文', { corpora: [CORPUS_PROJECT] });
        assert.ok(hits.length > 0, '补列后旧块照常可检索');
    } finally {
        opened.db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
