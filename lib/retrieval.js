// lib/retrieval.js — G1 · 长篇检索索引（词法路线 + 可选标签增强）。
//
// 为什么需要它：写到 100 章以后，「第 12 章那个戴斗笠的人是谁」这类问题靠模型记忆一律失败，
// 靠 `novel_briefing` 也只是近几章的窗口。作者真正要的是「按自己的记忆碎片把那段找回来」。
//
// 三条设计红线（见 docs/BATCH5-POC-2026-09-14.md §3）：
//   ① **索引是派生物，不是真相源**。真相永远是 `正文/*.md` + `novel.json`；索引删了重跑即得，
//      所以它可以单独损坏、单独重建，永不参与一致性判定。
//   ② **零依赖**：用 `node:sqlite`（Node 22+ 自带），不引 better-sqlite3（原生编译三重麻烦）。
//   ③ **中文必须自己切分**。实测：FTS5 默认分词器 2 字查询 0 命中；`tokenize='trigram'`
//      连 3 字查询也 0 命中。手工二元切分（bigram）2 万块查询均 11ms、BM25 排序正常。
//
// 本模块分两层：**纯函数**（切分/分块/摘要，可单测）+ **SQLite 层**（懒加载，不可用即降级）。

import { createHash } from 'node:crypto';

/** 索引相对书目根的位置。跟着书走：删书即删索引。 */
export const INDEX_RELATIVE = '.novel/index.db';

/** 分块目标字数——太小则片段断气，太大则召回拖泥带水。 */
export const CHUNK_TARGET_CHARS = 300;

/** 建索引时每块正面文本的上限（防止单块爆掉）。 */
const CHUNK_MAX_CHARS = 640;

// ── 纯函数层 ────────────────────────────────────────────────────────────────

/** 只保留有信息量的字符（去掉空白与纯标点噪声）。 */
export function normalizeForIndex(text) {
    return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * 二元切分：`斗笠人` → `['斗笠','笠人']`。
 * 这是中文进 FTS5 的唯一可行路径——默认分词器与 trigram 都实测不可用。
 * 按码点（Array.from）而非 UTF-16 单元切：slice 会把 emoji 等代理对切成
 * 孤半代理，成为进索引的噪声 token。
 */
export function bigrams(text) {
    const chars = Array.from(String(text ?? '').replace(/\s+/g, ''));
    const out = [];
    for (let i = 0; i < chars.length - 1; i += 1) out.push(chars[i] + chars[i + 1]);
    return out;
}

/** FTS5 检索表达式：查询侧同样二元切分，用 OR 提升召回，bm25 负责排序。 */
export function ftsQuery(query) {
    const raw = String(query ?? '').trim();
    if (raw === '') return '';
    const quote = (t) => `"${t.replace(/"/g, '""')}"`;
    const grams = [...new Set(bigrams(raw))];
    if (grams.length === 0) return quote(raw); // 单字查询：直接当词用
    return grams.map(quote).join(' OR ');
}

/** 内容指纹：增量索引靠它判断「这块变没变」。 */
export function hashChunk(text) {
    return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 按自然段把一章切成块（目标 ~300 字）。
 * 不跨段切：片段断在段中间读起来没有意义，而检索结果是要给人看的。
 */
export function chunkChapter(content, { chapter, target = CHUNK_TARGET_CHARS, tags = '' } = {}) {
    const paras = String(content ?? '')
        .replace(/\r\n/g, '\n')
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter((p) => p !== '');
    const chunks = [];
    let buf = [];
    let bufChars = 0;
    const flush = () => {
        if (buf.length === 0) return;
        const text = buf.join('\n\n').slice(0, CHUNK_MAX_CHARS);
        chunks.push({ seq: chunks.length, text, hash: hashChunk(`${text}\u0000${tags}`), tags });
        buf = [];
        bufChars = 0;
    };
    for (const p of paras) {
        buf.push(p);
        bufChars += p.length;
        if (bufChars >= target) flush();
    }
    flush();
    return chunks.map((c) => ({ ...c, chapter }));
}

/** 命中位置附近的摘录（给模型/面板看的那一段）。 */export function makeSnippet(text, query, { width = 120 } = {}) {
    const t = String(text ?? '');
    const q = String(query ?? '').trim();
    if (t === '') return '';
    if (q === '') return t.slice(0, width);
    // 先试整串，再退化到最长的二元片段（用户给的往往是记忆碎片）
    const probes = [q, ...bigrams(q).sort((a, b) => b.length - a.length)];
    let at = -1;
    for (const probe of probes) {
        at = t.indexOf(probe);
        if (at >= 0) break;
    }
    if (at < 0) return t.slice(0, width);
    const start = Math.max(0, at - Math.floor(width / 3));
    const end = Math.min(t.length, start + width);
    return `${start > 0 ? '…' : ''}${t.slice(start, end)}${end < t.length ? '…' : ''}`;
}

/** 「命中了查询里的几个片段」——用来在排序后做最后一道精度过滤。 */
export function hitRatio(text, query) {
    const grams = [...new Set(bigrams(query))];
    if (grams.length === 0) return String(text ?? '').includes(String(query ?? '').trim()) ? 1 : 0;
    const t = String(text ?? '');
    const hit = grams.filter((g) => t.includes(g)).length;
    return hit / grams.length;
}

/**
 * 「1-20」/「3,5,7」/「15-」 → 章号数组（只保留 available 里真实存在的章）。
 * 空串/未给 → null，语义是「全部」。
 */
export function parseChapterSpec(spec, available = []) {
    const raw = String(spec ?? '').trim();
    if (raw === '') return null;
    const pool = new Set(available);
    const wanted = new Set();
    for (const part of raw.split(/[,，、\s]+/).filter((x) => x !== '')) {
        const range = part.match(/^(\d+)\s*[-~—]\s*(\d*)$/);
        if (range !== null) {
            const from = Number(range[1]);
            const to = range[2] === '' ? Math.max(...available, from) : Number(range[2]);
            for (let k = from; k <= to; k += 1) wanted.add(k);
            continue;
        }
        const one = Number(part);
        if (Number.isInteger(one) && one >= 1) wanted.add(one);
    }
    return [...wanted].filter((k) => pool.has(k)).sort((a, b) => a - b);
}

// ── SQLite 层（懒加载 + 优雅降级）──────────────────────────────────────────

let sqliteModule; // undefined=未探测，null=不可用，object=可用

/**
 * 探测 `node:sqlite`。探测失败不是错误——老 Node 或裁剪运行时上，
 * 检索功能整体退化成关键词匹配，其它功能不受影响。
 */
export async function loadSqlite() {
    if (sqliteModule !== undefined) return sqliteModule;
    try {
        const mod = await import('node:sqlite');
        sqliteModule = typeof mod.DatabaseSync === 'function' ? mod : null;
    } catch {
        sqliteModule = null;
    }
    return sqliteModule;
}

/** 打开（必要时创建）索引库；不可用时返回 {ok:false, reason}，**不抛**。 */
export async function openIndex(dbPath) {
    const mod = await loadSqlite();
    if (mod === null) {
        return { ok: false, db: null, reason: '本运行时不提供 node:sqlite（需要 Node 22+），检索退化为关键词匹配' };
    }
    try {
        const db = new mod.DatabaseSync(dbPath);
        db.exec('CREATE TABLE IF NOT EXISTS chunks (ch INTEGER NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT \'\', PRIMARY KEY (ch, seq))');
        db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS seg USING fts5(ch UNINDEXED, seq UNINDEXED, body)');
        db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
        return { ok: true, db, reason: null };
    } catch (error) {
        return { ok: false, db: null, reason: `索引库打开失败：${error.message}` };
    }
}

/** 已入索引的内容指纹表（`ch:seq` → hash）。用于跳过没变的块。 */
export function indexedHashes(db) {
    const map = new Map();
    for (const row of db.prepare('SELECT ch, seq, hash FROM chunks').all()) {
        map.set(`${row.ch}:${row.seq}`, row.hash);
    }
    return map;
}

/**
 * 增量写入：只写指纹变了的块；块被删/变短时清掉多余序号。
 * @returns {{added, updated, removed, skipped}}
 */
export function upsertChunks(db, chunks) {
    let added = 0; let updated = 0;
    const hasStmt = db.prepare('SELECT hash FROM chunks WHERE ch = ? AND seq = ?');
    const delChunk = db.prepare('DELETE FROM chunks WHERE ch = ? AND seq = ?');
    const delSeg = db.prepare('DELETE FROM seg WHERE ch = ? AND seq = ?');
    const insChunk = db.prepare('INSERT INTO chunks (ch, seq, hash, text, tags) VALUES (?, ?, ?, ?, ?)');
    const insSeg = db.prepare('INSERT INTO seg (ch, seq, body) VALUES (?, ?, ?)');

    const maxSeqByChapter = new Map();
    for (const c of chunks) {
        maxSeqByChapter.set(c.chapter, Math.max(maxSeqByChapter.get(c.chapter) ?? -1, c.seq));
        const prev = hasStmt.get(c.chapter, c.seq);
        if (prev !== undefined && prev.hash === c.hash) continue;
        delChunk.run(c.chapter, c.seq);
        delSeg.run(c.chapter, c.seq);
        insChunk.run(c.chapter, c.seq, c.hash, c.text, c.tags ?? '');
        // 标签与正文进同一个检索列：标签增强因此不需要改查询语法
        const body = `${bigrams(c.text).join(' ')}${c.tags ? ` ${bigrams(c.tags).join(' ')}` : ''}`;
        insSeg.run(c.chapter, c.seq, body);
        if (prev === undefined) added += 1; else updated += 1;
    }

    // 章节变短 → 多出来的旧块要清掉（否则会搜到已删掉的内容）。
    // 只对本轮出现过的章节做——增量索引只喂新章时，别的章不在 chunks 里，不能误删。
    let removed = 0;
    for (const key of indexedHashes(db).keys()) {
        const [ch, seq] = key.split(':').map(Number);
        if (!maxSeqByChapter.has(ch)) continue;
        if (seq > maxSeqByChapter.get(ch)) {
            delChunk.run(ch, seq);
            delSeg.run(ch, seq);
            removed += 1;
        }
    }
    return { added, updated, removed, skipped: chunks.length - added - updated };
}

/**
 * 检索。返回按 bm25 排序的块，含摘录与命中比例。
 *
 * `minHitRatio` 是精度闸门：长查询只要有一个二元片段撞上就会被 FTS5 捞回来，
 * 全靠闸门挡噪声。默认 0.25 是实测调出来的——再高会误杀「戴斗笠的人」这类
 * 只记得一个关键词的**真实**查询（4 个片段命中 1 个 = 0.25）。
 * @param opts {limit=8, minHitRatio=0.25}
 */
export function searchChunks(db, query, { limit = 8, minHitRatio = 0.25 } = {}) {
    const match = ftsQuery(query);
    if (match === '') return [];
    let rows;
    try {
        rows = db.prepare('SELECT ch, seq, bm25(seg) AS score FROM seg WHERE seg MATCH ? ORDER BY rank LIMIT ?').all(match, Math.max(limit * 4, 16));
    } catch {
        return []; // 查询语法被 FTS5 拒绝（极端输入）：当作 0 命中，不抛
    }
    const getText = db.prepare('SELECT text, tags FROM chunks WHERE ch = ? AND seq = ?');
    const out = [];
    for (const r of rows) {
        const chunk = getText.get(r.ch, r.seq);
        if (chunk === undefined) continue;
        // 命中的可能是标签而不是正文（标签增强的全部意义）——比例必须把标签算进去
        const ratio = hitRatio(`${chunk.text} ${chunk.tags ?? ''}`, query);
        if (ratio < minHitRatio) continue;
        out.push({
            chapter: r.ch, seq: r.seq, score: Number(r.score.toFixed(3)),
            hitRatio: Number(ratio.toFixed(2)),
            snippet: makeSnippet(chunk.text, query),
            tags: chunk.tags === '' ? null : chunk.tags,
        });
        if (out.length >= limit) break;
    }
    return out;
}

/** 索引统计（面板/工具输出用）。 */
export function indexStats(db) {
    const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
    const chapters = db.prepare('SELECT COUNT(DISTINCT ch) AS n FROM chunks').get().n;
    const tagged = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE tags <> \'\'').get().n;
    return { chunks, chapters, tagged };
}

/** 还没有标签的块（打标任务按这个列表排队，只处理未标的 = 成本可控）。 */
export function untaggedChunks(db, { chapter = null, limit = 20 } = {}) {
    const sql = chapter === null
        ? 'SELECT ch, seq, text FROM chunks WHERE tags = \'\' ORDER BY ch, seq LIMIT ?'
        : 'SELECT ch, seq, text FROM chunks WHERE tags = \'\' AND ch = ? ORDER BY seq LIMIT ?';
    return chapter === null ? db.prepare(sql).all(limit) : db.prepare(sql).all(chapter, limit);
}

/** 给一块补标签：改 chunks.tags 并重建该块的检索列（标签与正文同列，查询语法无需变化）。 */
export function setChunkTags(db, chapter, seq, tags) {
    const row = db.prepare('SELECT text FROM chunks WHERE ch = ? AND seq = ?').get(chapter, seq);
    if (row === undefined) return false;
    db.prepare('UPDATE chunks SET tags = ? WHERE ch = ? AND seq = ?').run(tags, chapter, seq);
    db.prepare('DELETE FROM seg WHERE ch = ? AND seq = ?').run(chapter, seq);
    db.prepare('INSERT INTO seg (ch, seq, body) VALUES (?, ?, ?)').run(
        chapter, seq,
        `${bigrams(row.text).join(' ')}${tags ? ` ${bigrams(tags).join(' ')}` : ''}`,
    );
    return true;
}
