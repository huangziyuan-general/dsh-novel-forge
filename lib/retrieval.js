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
import { finiteOr } from './json-numbers.js';
import { legacyPollution, tagFingerprint, TAG_CACHE_VERSION } from './tag-cache.js';

/** 索引相对书目根的位置。跟着书走：删书即删索引。 */
export const INDEX_RELATIVE = '.novel/index.db';

/**
 * 语料种类（**字段级隔离**，不是目录位置隔离）。
 *
 * 为什么要有这一列：`书库/`（外部小说饲料）此前只靠「谁去读它」隔离——书库根本不进
 * 本索引，所以隔离靠的是「没人写那条代码」。一旦将来索引构建路径被扩展到书库/
 * （或用户把外部素材塞进书里），外部小说的原文就会进索引 → 被检索召回 → 被简报
 * 注入正文上下文 → **竞品小说的人名与设定污染续写**。目录位置挡不住一次路径扩展，
 * 字段能挡：每一块都带 corpus，检索侧按 corpus 过滤，生成上下文路径默认只放行 project。
 *
 *   project   —— 本书正文（唯一允许进生成上下文的语料；建索引时写死）
 *   reference —— 外部参考素材（只供人查；默认不召回，见 searchChunks 的 corpora 参数）
 */
export const CORPUS_PROJECT = 'project';
export const CORPUS_REFERENCE = 'reference';
export const CORPORA = [CORPUS_PROJECT, CORPUS_REFERENCE];

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
    // FTS5 query 语法的保留字符（" ( ) { } [ ] * : ^ ,）不进 gram：query 侧每个 gram
    // 要加双引号，gram 若自带引号，`""` 转义后语法不炸但引号本身成了检索字——查
    // 「斗笠"人」会去找字面含引号的文本（审查 L2）。索引与查询共用本函数，两侧同过滤，
    // 已建索引不受影响（含标点的 gram 本来就不参与命中；.novel/index.db 是派生物，可重建）。
    const chars = Array.from(String(text ?? '').replace(/[\s"(){}[\]*:^,]/g, ''));
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
    if (grams.length === 0) {
        // 单字 fallback 同样先剔除保留字符：全保留字符的查询（如 '"""'）返回空表达式，
        // 不做 quote(raw)——那会去找字面含引号的文本（审查 L2 的反直觉点）。
        const clean = raw.replace(/[\s"(){}[\]*:^,]/g, '');
        return clean === '' ? '' : quote(clean);
    }
    return grams.map(quote).join(' OR ');
}

/** 内容指纹：增量索引靠它判断「这块变没变」。 */
// 数值铸造统一走 lib/json-numbers.js 的 finiteOr（本文件曾是同族事故第二案发地：
// bm25 极小负分 toFixed(3) 产 "-0"，宿主整次拒收——本地变体已收编，别在这里再写新版）。

export function hashChunk(text) {
    return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 按自然段把一章切成块（目标 ~300 字）。
 * 不跨段切：片段断在段中间读起来没有意义，而检索结果是要给人看的。
 *
 * `corpus` 进块的**内容指纹**：同一段文字换个语料种类必须重写（否则 upsertChunks
 * 会因「指纹没变」跳过，库里留着旧语料标记——隔离闸门就漏了）。
 *
 * ⚠️ **标签不进指纹**（v1.3.0 改）。标签是**派生属性**——它是「这段文字写的是什么」
 * 的描述，不是这段文字的一部分。标签进了指纹，打标这个动作就会改掉块的指纹，
 * 下次建索引时整章判为「更新」→ 被「章级继承」的那份标签重写 → 给第 2 段打的标签
 * 盖到第 1、3、4 段身上（已复现的标签张冠李戴）。
 *
 * 指纹现在只吃「正文 + 语料」：**内容没变 = 指纹没变 = 整块跳过 = 标签原样保留**。
 * 正文变了 → 指纹变了 → 整块重写 → 标签按**新正文的内容指纹**从缓存回填
 * （见 lib/tag-cache.js）。
 */
export function chunkChapter(content, { chapter, target = CHUNK_TARGET_CHARS, tags = '', corpus = CORPUS_PROJECT } = {}) {
    const kind = CORPORA.includes(corpus) ? corpus : CORPUS_PROJECT;
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
        chunks.push({ seq: chunks.length, text, hash: hashChunk(`${text}\u0000${kind}`), tags, corpus: kind });
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
 * 弱结果判定（查询扩写的触发闸，纯函数）：
 * 零命中必扩；命中少（< limit/2）且全部浅命中（最高 hitRatio < 0.5）才扩——
 * 命中够多或已有一个扎实命中就别烧那次调用（扩写走引擎，不是免费的）。
 */
export function isWeakResult(hits, { limit = 8 } = {}) {
    if (!Array.isArray(hits) || hits.length === 0) return true;
    if (hits.length >= limit) return false;
    const best = Math.max(...hits.map((h) => h.hitRatio ?? 0), 0);
    return hits.length < Math.ceil(limit / 2) && best < 0.5;
}

/**
 * 多路检索结果合并（查询扩写的重排器，纯函数）。
 * 去重键 (chapter,seq)；主排序「被几路查询命中」（多路独立命中 = 更强的证据），
 * 次排序 bm25 分数（FTS5 约定：越小越相关）。evidence 是内部字段，**必须剥掉**——
 * 工具 output.schema 是 additionalProperties:false，多一个键整次调用被宿主拒收。
 */
export function mergeExpandedHits(hitLists, { limit = 8 } = {}) {
    const byKey = new Map();
    for (const hits of hitLists ?? []) {
        for (const h of hits ?? []) {
            const key = `${h.chapter}:${h.seq}`;
            const cur = byKey.get(key);
            if (cur === undefined) {
                byKey.set(key, { ...h, hitRatio: h.hitRatio ?? 0, evidence: 1 });
                continue;
            }
            cur.evidence += 1;
            // 最好（最小）的 bm25 代表这一块的最高证据形态；摘录跟着最好那路走
            if ((h.score ?? 0) < (cur.score ?? 0)) {
                cur.score = h.score;
                cur.snippet = h.snippet;
            }
            cur.hitRatio = Math.max(cur.hitRatio, h.hitRatio ?? 0);
            if (cur.tags === undefined && h.tags !== undefined) cur.tags = h.tags;
        }
    }
    return [...byKey.values()]
        .sort((a, b) => (b.evidence - a.evidence) || ((a.score ?? 0) - (b.score ?? 0)))
        .slice(0, limit)
        .map(({ evidence, ...rest }) => rest);
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

/**
 * 老库补列：1.0.8 及以前建的 chunks 表没有 corpus 列。
 *
 * `CREATE TABLE IF NOT EXISTS` 对**已存在**的表不会补列——不补的话后面的
 * INSERT（带 corpus）会直接炸，整个索引不可用。而索引是派生物（删了重跑 build 即得），
 * 可这里的迁移必须**保留已打的语义标签**（annotate 的成果，重跑 build 会丢），
 * 所以走 ALTER 补列而不是删库重建。
 *
 * 补列失败（文件只读/损坏）→ 抛给 openIndex 的 catch → 索引整体降级，
 * 绝不半开半坏（带列写不进去的库比没有库更危险）。
 */
function migrateCorpusColumn(db) {
    const cols = db.prepare('PRAGMA table_info(chunks)').all().map((r) => String(r.name));
    if (cols.includes('corpus')) return;
    db.exec(`ALTER TABLE chunks ADD COLUMN corpus TEXT NOT NULL DEFAULT '${CORPUS_PROJECT}'`);
}

/**
 * 打标缓存表：**内容指纹 → 标签**。
 *
 * 为什么要有这张表：标签是「块文本」的函数。绑定在文本上而不是（章, 块序号）上，
 * 才禁得住两件事——① 块序号因正文改写而移位时的张冠李戴；② 重建索引后标签全丢、
 * 几百块要重新调模型。
 *
 * 只存**指纹与标签**，不存原文：外部参考素材的原文因此不会多出一处落地位置。
 */
export function ensureTagCacheTable(db) {
    db.exec('CREATE TABLE IF NOT EXISTS tag_cache (fp TEXT PRIMARY KEY, tags TEXT NOT NULL, at TEXT NOT NULL)');
}

/** 缓存条目上限——超了就淘汰最老的一批（缓存是便利设施，不该无限膨胀）。 */
export const TAG_CACHE_MAX = 20000;

/**
 * 老库迁移：把 `chunks` 里已有的标签按**内容指纹**补录进缓存（幂等）。
 *
 * 为什么必须迁移：老库的标签是用户**已经付过模型调用费**换来的成果。不迁移的话，
 * 指纹口径一改（标签不再进指纹），下次建索引会把所有块判为「更新」→ 标签全部丢失 →
 * 用户得重新打标几百次。
 *
 * 为什么**跳过被污染的章**：老实现的「章级继承」会把某一组标签盖到该章所有块上——
 * 重建后的老库里，整章的块标签一模一样。这份「整齐」正是污染的签名（正常情况下
 * 各块标签各不相同）。这种章的标签已分不清原属哪一块，补录进缓存等于**把污染固化**，
 * 所以宁可丢掉（那一章重新打标即可，几百次调用换几十次重标不亏）。
 *
 * @returns {{migrated:number, skippedChapters:number}}
 */
export function migrateLegacyTags(db) {
    ensureTagCacheTable(db);
    const rows = db.prepare('SELECT ch, seq, text, tags FROM chunks WHERE tags <> \'\' ORDER BY ch, seq').all();
    // 早退形状与尾部的完整返回保持一致（clearedTags 恒在）——调用方统一按三键读统计。
    if (rows.length === 0) return { migrated: 0, skippedChapters: 0, clearedTags: 0 };
    const byChapter = new Map();
    for (const row of rows) {
        const ch = Number(row.ch);
        if (!byChapter.has(ch)) byChapter.set(ch, []);
        byChapter.get(ch).push({ seq: Number(row.seq), text: String(row.text ?? ''), tags: String(row.tags ?? '') });
    }
    const at = new Date().toISOString();
    const stmt = db.prepare('INSERT OR IGNORE INTO tag_cache (fp, tags, at) VALUES (?, ?, ?)');
    let migrated = 0;
    let skippedChapters = 0;
    let clearedTags = 0;
    for (const [ch, blocks] of byChapter) {
        // 污染判定需要「该章所有块」的标签形状（含未打标的空标签块），这里只有打过标的，
        // 所以用「打过标的块是否整齐」来判——被广播过的章，打过标的块必然整齐。
        const { polluted } = legacyPollution(blocks);
        if (polluted) {
            skippedChapters += 1;
            clearedTags += blocks.length;
            // 只跳过缓存会把污染留在 chunks 里：upsertChunks 会因正文指纹没变继续跳过，
            // untaggedChunks 又看不见非空标签，污染标签就永远清不掉。这里连正文索引一起清。
            // ⚠️ 清标签**只能走 setChunkTags**：`seg.body` 里拼的是 bigrams(正文)+bigrams(标签)，
            // 换一条 `UPDATE chunks SET tags=''` 会把表清干净、却把污染留在检索列里
            // ——误召回原样还在，回归钉在 tag-cache.test.mjs「污染章清标必须把标签从检索列里一起抹掉」。
            for (const b of blocks) setChunkTags(db, ch, Number(b.seq), '');
            continue;
        }
        for (const b of blocks) {
            stmt.run(tagFingerprint(b.text), b.tags, at);
            migrated += 1;
        }
    }
    return { migrated, skippedChapters, clearedTags };
}

/**
 * 读缓存：给定一批文本，返回 Map<指纹, 标签>（只含真正有标签的条目）。
 *
 * 一次查一批（而不是每块一次查）：批量打标几百块时，逐块查 sqlite 的开销不可忽略。
 */
export function readTagCacheForTexts(db, texts) {
    const out = new Map();
    const list = Array.isArray(texts) ? texts : [];
    const fps = [...new Set(list.map((t) => tagFingerprint(t)))];
    if (fps.length === 0) return out;
    const stmt = db.prepare('SELECT fp, tags FROM tag_cache WHERE fp = ?');
    for (const fp of fps) {
        const row = stmt.get(fp);
        if (row === undefined) continue;
        const tags = String(row.tags ?? '');
        if (tags !== '') out.set(fp, tags);
    }
    return out;
}

/**
 * 写缓存：[{fp, tags}]。超上限时淘汰最老的一批（缓存是便利设施，不该无限膨胀）。
 * @returns 实际写入条数
 */
export function writeTagCache(db, entries, at = new Date().toISOString()) {
    const list = Array.isArray(entries) ? entries : [];
    if (list.length === 0) return 0;
    ensureTagCacheTable(db);
    const stmt = db.prepare('INSERT OR REPLACE INTO tag_cache (fp, tags, at) VALUES (?, ?, ?)');
    let n = 0;
    for (const e of list) {
        const fp = String(e?.fp ?? '');
        const tags = String(e?.tags ?? '');
        if (fp === '' || tags === '') continue;
        stmt.run(fp, tags, at);
        n += 1;
    }
    const total = Number(db.prepare('SELECT COUNT(*) AS n FROM tag_cache').get()?.n ?? 0);
    if (total > TAG_CACHE_MAX) {
        const cut = Math.floor(total * 0.2);
        db.prepare('DELETE FROM tag_cache WHERE fp IN (SELECT fp FROM tag_cache ORDER BY at ASC LIMIT ?)').run(cut);
    }
    return n;
}

/** 打开（必要时创建）索引库；不可用时返回 {ok:false, reason}，**不抛**。 */
export async function openIndex(dbPath) {
    const mod = await loadSqlite();
    if (mod === null) {
        return { ok: false, db: null, reason: '本运行时不提供 node:sqlite（需要 Node 22+），检索退化为关键词匹配' };
    }
    try {
        const db = new mod.DatabaseSync(dbPath);
        db.exec(`CREATE TABLE IF NOT EXISTS chunks (ch INTEGER NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', corpus TEXT NOT NULL DEFAULT '${CORPUS_PROJECT}', PRIMARY KEY (ch, seq))`);
        db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS seg USING fts5(ch UNINDEXED, seq UNINDEXED, body)');
        db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
        migrateCorpusColumn(db);
        ensureTagCacheTable(db);
        migrateLegacyTagsOnce(db);
        return { ok: true, db, reason: null };
    } catch (error) {
        return { ok: false, db: null, reason: `索引库打开失败：${error.message}` };
    }
}

/**
 * 老库标签迁移：**每个版本跑一次**（meta 标记存版本号）。
 *
 * 跑失败不许拖垮索引——迁移是便利设施（不迁移只是标签要重打），索引打不开才是灾难。
 * 但失败与工作量都要**看得见**（0.13.x 起的一贯要求：静默的旁路迟早变成没人知道的死角）：
 * 从 TAG_CACHE v2 起这一步会**破坏性改写派生数据**（把污染章的标签从 chunks 与检索列一起清掉），
 * 悄悄做掉又不留痕，出问题时连"到底动过没有"都查不到。索引库没有审计通道，
 * 这里走 logger 级别的 console（与 server-workspace 的同名书回退提示同一手法）。
 */
function migrateLegacyTagsOnce(db) {
    try {
        const done = db.prepare("SELECT v FROM meta WHERE k = 'tag_cache_migrated'").get();
        if (done !== undefined && String(done.v) === String(TAG_CACHE_VERSION)) return;
        const r = migrateLegacyTags(db);
        db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('tag_cache_migrated', ?)").run(String(TAG_CACHE_VERSION));
        if (r.migrated > 0 || r.skippedChapters > 0) {
            console.info(`[novel-forge] 打标缓存迁移(v${TAG_CACHE_VERSION})：补录 ${r.migrated} 块，`
                + `污染章 ${r.skippedChapters} 个（清掉旧标签 ${r.clearedTags} 条，需重打标）`);
        }
    } catch (error) {
        console.warn(`[novel-forge] 打标缓存迁移失败（不阻断检索，下次开库重试）：${error?.message ?? error}`);
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
 * `knownChapters`（可选，Set）：全量 build 时传**当前书里的章节集合**——索引里
 * 存在但书里已不存在的章（章节被删/索引残留）一并清掉（M8 修复）。增量 build
 * 不传，维持原状（只清本轮出现章节的多余块，不误删未喂的章）。
 * @returns {{added, updated, removed, skipped}}
 */
export function upsertChunks(db, chunks, knownChapters) {
    let added = 0; let updated = 0;
    const hasStmt = db.prepare('SELECT hash FROM chunks WHERE ch = ? AND seq = ?');
    const delChunk = db.prepare('DELETE FROM chunks WHERE ch = ? AND seq = ?');
    const delSeg = db.prepare('DELETE FROM seg WHERE ch = ? AND seq = ?');
    const insChunk = db.prepare('INSERT INTO chunks (ch, seq, hash, text, tags, corpus) VALUES (?, ?, ?, ?, ?, ?)');
    const insSeg = db.prepare('INSERT INTO seg (ch, seq, body) VALUES (?, ?, ?)');

    const maxSeqByChapter = new Map();
    for (const c of chunks) {
        maxSeqByChapter.set(c.chapter, Math.max(maxSeqByChapter.get(c.chapter) ?? -1, c.seq));
        const prev = hasStmt.get(c.chapter, c.seq);
        if (prev !== undefined && prev.hash === c.hash) continue;
        delChunk.run(c.chapter, c.seq);
        delSeg.run(c.chapter, c.seq);
        insChunk.run(c.chapter, c.seq, c.hash, c.text, c.tags ?? '', c.corpus ?? CORPUS_PROJECT);
        // 标签与正文进同一个检索列：标签增强因此不需要改查询语法
        const body = `${bigrams(c.text).join(' ')}${c.tags ? ` ${bigrams(c.tags).join(' ')}` : ''}`;
        insSeg.run(c.chapter, c.seq, body);
        if (prev === undefined) added += 1; else updated += 1;
    }

    // 章节变短 → 多出来的旧块要清掉（否则会搜到已删掉的内容）。
    // 只对本轮出现过的章节做——增量索引只喂新章时，别的章不在 chunks 里，不能误删。
    // ⚠️ 非 project 语料的块**不参与清理**：它们的章号不在本书章节集合里，
    // 全量 build 的「清幽灵章」会把外部参考素材整片删掉（语料隔离的另一条边界）。
    let removed = 0;
    for (const row of db.prepare('SELECT ch, seq, corpus FROM chunks').all()) {
        const ch = row.ch;
        const seq = row.seq;
        if ((row.corpus ?? CORPUS_PROJECT) !== CORPUS_PROJECT) continue;
        if (!maxSeqByChapter.has(ch)) {
            // 全量 build 且该章已不在书里 → 索引残留，清掉
            if (knownChapters !== undefined && !knownChapters.has(ch)) {
                delChunk.run(ch, seq);
                delSeg.run(ch, seq);
                removed += 1;
            }
            continue;
        }
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
 *
 * `corpora` 是**语料隔离闸门**（字段级，不是目录位置级）：
 *   null            → 不过滤（调用方自己负责，默认不该这么用）
 *   ['project']     → 只放行本书正文（生成上下文路径固定这么传）
 *   ['reference']   → 只放行外部参考素材
 * 过滤发生在**命中之后、返回之前**：命中的块逐个查 chunks.corpus，不在白名单的直接丢。
 * 这一步必须在扩写路径上同样生效——否则弱结果触发的「查询扩写」会绕过隔离，
 * 把外部素材从后门放进来（那才是隔离失效的真正形态）。
 * @param opts {limit=8, minHitRatio=0.25, corpora=null}
 */
export function searchChunks(db, query, { limit = 8, minHitRatio = 0.25, corpora = null } = {}) {
    const match = ftsQuery(query);
    if (match === '') return [];
    // 过滤会吃掉一部分候选 → 按语料收窄时多取一些，避免把 limit 提前喂满在错语料上。
    const fetch = Math.max(limit * 4, 16) * (corpora === null ? 1 : 2);
    const allow = corpora === null || corpora === undefined ? null : new Set(corpora);
    let rows;
    try {
        rows = db.prepare('SELECT ch, seq, bm25(seg) AS score FROM seg WHERE seg MATCH ? ORDER BY rank LIMIT ?').all(match, fetch);
    } catch {
        return []; // 查询语法被 FTS5 拒绝（极端输入）：当作 0 命中，不抛
    }
    const getText = db.prepare('SELECT text, tags, corpus FROM chunks WHERE ch = ? AND seq = ?');
    const out = [];
    for (const r of rows) {
        const chunk = getText.get(r.ch, r.seq);
        if (chunk === undefined) continue;
        const corpus = chunk.corpus ?? CORPUS_PROJECT;
        // ★ 隔离闸门：不在白名单的语料一律不返回（外部素材不得进续写上下文）
        if (allow !== null && !allow.has(corpus)) continue;
        // 命中的可能是标签而不是正文（标签增强的全部意义）——比例必须把标签算进去
        const ratio = hitRatio(`${chunk.text} ${chunk.tags ?? ''}`, query);
        // 非有限的命中比例（空查询分母为 0 → NaN）不过闸门，也不许进输出：
        // NaN/Infinity 会被宿主 lossless 校验判 "must be a finite JSON number" 整次拒收。
        if (!Number.isFinite(ratio) || ratio < minHitRatio) continue;
        out.push({
            chapter: r.ch, seq: r.seq,
            // bm25 在极端输入下能给 ±Infinity —— 同样要在铸造点收成有限数
            score: finiteOr(Number(r.score), 3),
            hitRatio: finiteOr(ratio, 2),
            snippet: makeSnippet(chunk.text, query),
            tags: chunk.tags === '' ? null : chunk.tags,
            corpus,
        });
        if (out.length >= limit) break;
    }
    return out;
}

/** 索引里出现过的章号（升序去重）。派生索引与书稿对账（幽灵块）用。 */
export function indexedChapters(db) {
    return db.prepare('SELECT DISTINCT ch FROM chunks ORDER BY ch').all().map((r) => r.ch);
}

/**
 * 从索引里删掉指定章的全部块 —— 清理「书里已删章、索引仍留块」的幽灵内容。
 *
 * 与正文「只报告不删」相反：索引是**派生物**（删了重跑 build 即得），删错也无损，
 * 所以这里允许真删；不清理的话 novel_search 会把「查无此文」的段落当素材交给作者。
 * @returns {number} 实际删掉的块数（chunks+seg 同删）
 */
export function pruneChapters(db, chapters) {
    const list = [...new Set((chapters ?? []).map(Number).filter((k) => Number.isInteger(k)))];
    if (list.length === 0) return 0;
    const countStmt = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE ch = ?');
    const delChunk = db.prepare('DELETE FROM chunks WHERE ch = ?');
    const delSeg = db.prepare('DELETE FROM seg WHERE ch = ?');
    let removed = 0;
    for (const ch of list) {
        removed += countStmt.get(ch).n;
        delChunk.run(ch);
        delSeg.run(ch);
    }
    return removed;
}

/** 索引统计（面板/工具输出用）。 */
export function indexStats(db) {
    const chunks = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
    const chapters = db.prepare('SELECT COUNT(DISTINCT ch) AS n FROM chunks').get().n;
    const tagged = db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE tags <> \'\'').get().n;
    // 按语料分类统计：让「库里有没有混进外部素材」这件事**看得见**（看不见的隔离
    // 等于没有隔离）。只在工具回执的 notes 里渲染，不进工具输出 schema（避免
    // additionalProperties 与宿主校验打架）。
    const byCorpus = {};
    for (const row of db.prepare('SELECT corpus, COUNT(*) AS n FROM chunks GROUP BY corpus').all()) {
        byCorpus[String(row.corpus ?? CORPUS_PROJECT)] = row.n;
    }
    return { chunks, chapters, tagged, byCorpus };
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
    // 顺带把「这段文字 → 这组标签」记进内容指纹缓存（写不进不阻断打标：缓存是旁路）。
    // 这一句是「同样的输入不重复调模型」真正落地的地方——**所有**打标入口都经过这里，
    // 所以只要走这个函数打标，缓存就自动是全的，不靠调用方自觉。
    try {
        writeTagCache(db, [{ fp: tagFingerprint(String(row.text ?? '')), tags: String(tags ?? '') }]);
    } catch { /* 缓存写不进不影响标签本身 */ }
    return true;
}
