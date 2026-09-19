// lib/tools/search-tools.js — novel_search（G1 检索：长篇「找回来」能力）。
//
// 写到 100 章以后，「第 12 章那个戴斗笠的人是谁」靠模型记忆一律失败，靠 briefing 也只有
// 近几章的窗口。这个工具给作者一个**按自己的记忆碎片**把段落找回来的入口。
//
// 三个动作：
//   build    建/增量建索引（只处理新增或改动的块，指纹判断）
//   query    检索（词法路线；带标签的块自动获得语义增强）
//   annotate 给未打标的块补标签（走 D1 旁路引擎，零新增配置）
//
// 索引落在 `书/.novel/index.db`，是**派生物**：删了重跑即得，绝不参与一致性判定；
// `node:sqlite` 不可用时整体退化为关键词匹配，不抛错。

import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineTool } from './define-tool.js';
import { pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { audit, requireBook, textBlock } from './common.js';
import {
    openIndex, chunkChapter, upsertChunks, searchChunks, indexStats,
    untaggedChunks, setChunkTags, loadSqlite, hitRatio, makeSnippet, INDEX_RELATIVE, parseChapterSpec,
} from '../retrieval.js';
import { runAnnotateTask } from '../engine-tasks.js';

export function defineSearchTool(ctx, config, deps = {}) {
    /** D1 引擎（annotate 动作要用）。缺省 null → annotate 返回可读错误。 */
    const engine = deps.engine ?? null;

    return defineTool({
        name: 'novel_search',
        description: '长篇检索：把「那段大概写了什么」找回来。build 建/增量建索引（书/.novel/index.db，可删可重建）；query 按记忆碎片检索，返回章号+摘录+命中比例（词法二元切分，中文实测 11ms/次）；annotate 给未打标的块补语义标签（走旁路引擎，让「决斗」能召回只写了「刀收回袖中」的那段）。索引是派生物，删了重跑即得；不支持 node:sqlite 的运行时自动退化为关键词匹配。',
        parameters: {
            action: { type: 'string', required: true, enum: ['build', 'query', 'annotate', 'status'], description: 'build 建/增量建索引；query 检索；annotate 补语义标签；status 看索引状态。' },
            book: { type: 'string', required: true, description: '书目名。' },
            q: { type: 'string', description: 'query 必填：检索词（可以是记忆碎片，如「戴斗笠的人」「码头 风灯」）。' },
            limit: { type: 'integer', description: 'query：最多返回几条（默认 8）。' },
            min_hit: { type: 'number', description: 'query：命中比例闸门（0-1，默认 0.25）。记不清时调低到 0.15 提高召回，噪声多时调高。' },
            chapters: { type: 'string', description: 'build/annotate：限定章节（如「1-20」「3,5,7」「15-」），缺省全书。' },
            top: { type: 'integer', description: 'annotate：本次最多打标几块（默认 20，控制成本）。' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    hits: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        chapter: { type: 'integer', required: true }, seq: { type: 'integer', required: true },
                        snippet: { type: 'string', required: true }, hitRatio: { type: 'number', required: true },
                        score: { type: 'number', required: true }, tags: { type: 'string' },
                    } } },
                    chunks: { type: 'integer' }, chapters: { type: 'integer' }, tagged: { type: 'integer' },
                    added: { type: 'integer' }, updated: { type: 'integer' }, removed: { type: 'integer' },
                    scanned: { type: 'integer' },
                    annotated: { type: 'integer' }, remaining: { type: 'integer' },
                    mode: { type: 'string' }, degraded: { type: 'boolean', required: true },
                    reason: { type: 'string' },
                    notes: { type: 'array', items: { type: 'string' }, required: true },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            const notes = [];

            const chapterKeys = Object.keys(novel.chapters ?? {})
                .map(Number).filter((k) => Number.isInteger(k) && k >= 1).sort((a, b) => a - b);

            /**
             * 解析索引库的**真实磁盘路径**。
             *
             * 为什么不直接用 ctx.fs：宿主的 fs 是**沙箱抽象**，`resolve()` 返回的是不透明
             * target（`{targetKey, displayPath}`），刻意不暴露真实路径——而 `node:sqlite`
             * 要的就是一个真实路径。所以这里按本仓库既有约定从 cwd 拼（`bookPath` 同款），
             * 拿不到 cwd 就降级（非本地 fs 后端上检索退化为关键词匹配）。
             */
            const resolveIndexPath = async () => {
                try {
                    const abs = await io.abs(p.indexDb);
                    if (typeof abs === 'string' && abs !== '') return abs;
                } catch { /* 宿主 fs 不提供绝对路径，走 cwd 拼 */ }
                if (typeof io.cwd === 'string' && io.cwd !== '') {
                    // M9 修复：cwd 拼接只在**确认本地后端**时可信——宿主 fs 的 resolve()
                    // 返回不透明对象时，用 statSync 验证 cwd 真实存在；不存在（远端/
                    // 虚拟后端）就地降级，别把索引写进说不清的地方。
                    const candidate = join(io.cwd, p.indexDb);
                    try { if (statSync(io.cwd).isDirectory()) return candidate; } catch { /* 非本地 */ }
                }
                return null;
            };

            /** 打开索引（含目录创建）。sqlite 不可用时返回 ok:false 但不抛。 */
            const openForBook = async () => {
                const runtime = await loadSqlite();
                if (runtime === null) {
                    return { ok: false, db: null, reason: '本运行时不提供 node:sqlite（需要 Node 22+）' };
                }
                const abs = await resolveIndexPath();
                if (abs === null) {
                    return { ok: false, db: null, reason: '当前文件系统后端不暴露真实路径，索引无法落盘' };
                }
                try {
                    mkdirSync(dirname(abs), { recursive: true });
                } catch (error) {
                    return { ok: false, db: null, reason: `索引目录创建失败：${error.message}` };
                }
                return openIndex(abs);
            };

            // ── status ───────────────────────────────────────────────────
            if (args.action === 'status') {
                const opened = await openForBook();
                if (!opened.ok) {
                    return {
                        book, action: 'status', degraded: true, reason: opened.reason,
                        notes: ['索引不可用，query 会自动退化为关键词匹配（功能受限但不报错）'],
                    };
                }
                const stats = indexStats(opened.db);
                opened.db.close();
                return {
                    book, action: 'status', degraded: false,
                    chunks: stats.chunks, chapters: stats.chapters, tagged: stats.tagged,
                    notes: [
                        `索引位置：${p.indexDb}（派生物，删掉重跑 build 即得）`,
                        stats.chunks === 0 ? '索引为空——先 action=build' : `已索引 ${stats.chapters} 章 / ${stats.chunks} 块，其中 ${stats.tagged} 块有语义标签`,
                        `全书现有 ${chapterKeys.length} 章`,
                    ],
                };
            }

            // ── build ────────────────────────────────────────────────────
            if (args.action === 'build') {
                if (chapterKeys.length === 0) throw new Error('本书还没有已保存的章节，无可索引内容');
                const opened = await openForBook();
                if (!opened.ok) {
                    return {
                        book, action: 'build', degraded: true, reason: opened.reason, scanned: 0,
                        notes: ['本运行时不支持 sqlite，未建索引；query 仍可用（关键词匹配）'],
                    };
                }
                // 章级标签保留：已打标的块重新分块后仍沿用该章标签（避免 build 抹掉 annotate 的成果）
                const existingTags = new Map();
                for (const row of opened.db.prepare('SELECT DISTINCT ch, tags FROM chunks WHERE tags <> \'\'').all()) {
                    existingTags.set(row.ch, row.tags);
                }
                const wanted = parseChapterSpec(args.chapters, chapterKeys) ?? chapterKeys;
                const chunks = [];
                let scanned = 0;
                for (const k of wanted) {
                    const rec = novel.chapters[String(k)];
                    if (rec?.path === undefined) continue;
                    const content = await io.readText(rec.path);
                    if (content === null) continue;
                    scanned += 1;
                    chunks.push(...chunkChapter(content, { chapter: k, tags: existingTags.get(k) ?? '' }));
                }
                // 全量 build（未指定章节范围）时传当前章节集合：书里已删掉的章，索引里的
                // 旧块一并清掉（M8 修复——此前只清「本轮出现的章」内部的多余块）。
                const result = upsertChunks(opened.db, chunks, args.chapters === undefined ? new Set(chapterKeys) : undefined);
                const stats = indexStats(opened.db);
                opened.db.close();
                await audit(io, p, 'search/build', { chapters: wanted.length, ...result });
                return {
                    book, action: 'build', degraded: false, scanned,
                    added: result.added, updated: result.updated, removed: result.removed,
                    chunks: stats.chunks, chapters: stats.chapters, tagged: stats.tagged,
                    mode: 'lexical',
                    notes: [
                        `扫描 ${scanned} 章 → 新增 ${result.added} 块 / 更新 ${result.updated} 块 / 清理 ${result.removed} 块（未变的 ${result.skipped} 块跳过）`,
                        stats.chunks === 0 ? '索引仍为空——检查章节文件是否可读' : `索引现有 ${stats.chunks} 块`,
                    ],
                };
            }

            // ── annotate（路线 C：把语义外包给旁路引擎）─────────────────────
            if (args.action === 'annotate') {
                if (engine === null) throw new Error('打标需要模型引擎，但本进程没有可用的模型服务');
                const opened = await openForBook();
                if (!opened.ok) throw new Error(`打标需要索引：${opened.reason}`);
                const wanted = parseChapterSpec(args.chapters, chapterKeys);
                const top = Number.isInteger(args.top) && args.top >= 1 ? args.top : 20;
                const pending = wanted === null
                    ? untaggedChunks(opened.db, { limit: top })
                    : wanted.flatMap((k) => untaggedChunks(opened.db, { chapter: k, limit: top })).slice(0, top);
                if (pending.length === 0) {
                    const stats = indexStats(opened.db);
                    opened.db.close();
                    return {
                        book, action: 'annotate', degraded: false, annotated: 0, remaining: 0,
                        chunks: stats.chunks, tagged: stats.tagged,
                        notes: ['没有待打标的块（build 会保留已有标签；全部块都已标注）'],
                    };
                }
                let annotated = 0;
                const failures = [];
                let stats;
                let remaining;
                try {
                    for (const row of pending) {
                        const r = await runAnnotateTask(engine, row.text, { signal: exec?.signal });
                        if (!r.ok) {
                            failures.push(`第${row.ch}章#${row.seq}：${r.error.message}`);
                            if (failures.length >= 3) break; // 连续失败就别烧钱了
                            continue;
                        }
                        if (setChunkTags(opened.db, row.ch, row.seq, r.tags.join(' '))) annotated += 1;
                    }
                    stats = indexStats(opened.db);
                    remaining = untaggedChunks(opened.db, { limit: 9999 }).length;
                } finally {
                    // L13 修复：打标中途抛错（模型异常/取消信号）也必须关掉 sqlite 句柄
                    try { opened.db.close(); } catch { /* 已关闭则忽略 */ }
                }
                await audit(io, p, 'search/annotate', { annotated, remaining });
                if (failures.length > 0) notes.push(`有 ${failures.length} 块打标失败：${failures.slice(0, 3).join('；')}`);
                return {
                    book, action: 'annotate', degraded: false, annotated, remaining,
                    chunks: stats.chunks, tagged: stats.tagged, mode: 'hybrid',
                    notes: [
                        `本次打标 ${annotated} 块，剩余未标 ${remaining} 块（再跑一次可继续）`,
                        remaining > 0 ? '标签是一次性生成、可增量的——成本可控，可以分批慢慢补' : '全部块已带上语义标签',
                    ],
                };
            }

            // ── query ────────────────────────────────────────────────────
            const q = String(args.q ?? '').trim();
            if (q === '') throw new Error('query 需要 q（检索词，可以是记忆碎片）');
            const limit = Number.isInteger(args.limit) && args.limit >= 1 ? args.limit : 8;
            const minHit = typeof args.min_hit === 'number' && args.min_hit > 0 && args.min_hit <= 1 ? args.min_hit : 0.25;

            const opened = await openForBook();
            if (!opened.ok) {
                // 优雅降级：不引 sqlite 的运行时也能「找一段」（子串匹配，零依赖）
                const hits = await degradeQuery(io, novel, chapterKeys, q, limit);
                return {
                    book, action: 'query', degraded: true, reason: opened.reason,
                    mode: 'substring', hits,
                    notes: [
                        opened.reason,
                        `已退回关键词匹配，命中 ${hits.length} 条（只做字面子串，不做排序与标签增强）`,
                    ],
                };
            }

            // M8 修复的另一半：索引清理只发生在全量 build。删章之后、下次 build 之前，
            // 块还在索引里 —— 出口必须按现有章号过滤，否则会把「查无此文」的幽灵段落
            // 交给作者当素材用。
            let hits, stats;
            try {
                hits = searchChunks(opened.db, q, { limit, minHitRatio: minHit });
                stats = indexStats(opened.db);
            } finally {
                try { opened.db.close(); } catch { /* 已关闭则忽略 */ }
            }
            const alive = new Set(chapterKeys);
            const ghosts = hits.filter((h) => !alive.has(h.chapter));
            if (ghosts.length > 0) hits = hits.filter((h) => alive.has(h.chapter));
            if (stats.chunks === 0) {
                notes.push('索引为空——先 action=build 才能检索');
            } else if (hits.length === 0) {
                notes.push(`未命中（索引 ${stats.chunks} 块）。可试：换更短的词 / min_hit 调低到 0.15 / 先 annotate 补语义标签`);
            }
            if (ghosts.length > 0) {
                notes.push(`已过滤 ${ghosts.length} 条指向不存在章节的残留块（删章后索引未重建），跑一次 action=build 可清干净`);
            }
            const taggedHit = hits.filter((h) => h.tags !== undefined).length;
            return {
                book, action: 'query', degraded: false,
                mode: taggedHit > 0 ? 'hybrid' : 'lexical',
                hits: hits.map((h) => ({ ...h, ...(h.tags === null ? {} : { tags: h.tags }) })),
                chunks: stats.chunks, chapters: stats.chapters, tagged: stats.tagged,
                notes,
            };
        },
        render: (_args, v) => {
            if (v.action === 'query') {
                if (v.hits.length === 0) return textBlock(`检索「${_args.q}」：0 命中${v.notes.length > 0 ? `\n${v.notes.map((n) => `- ${n}`).join('\n')}` : ''}`);
                return textBlock(
                    `检索「${_args.q}」→ ${v.hits.length} 条（${v.mode}${v.degraded ? '·降级' : ''}）\n`
                    + v.hits.map((h) => `- 第${h.chapter}章#${h.seq}（命中 ${h.hitRatio}${h.tags === undefined ? '' : `·标签 ${h.tags}`}）：${h.snippet.replace(/\n/g, ' ')}`).join('\n')
                    + (v.notes.length > 0 ? `\n\n${v.notes.map((n) => `- ${n}`).join('\n')}` : ''),
                );
            }
            if (v.action === 'status') {
                return textBlock(v.degraded
                    ? `检索索引不可用：${v.reason}`
                    : `检索索引：${v.chapters} 章 / ${v.chunks} 块（${v.tagged} 块有标签）${v.notes.length > 0 ? `\n${v.notes.map((n) => `- ${n}`).join('\n')}` : ''}`);
            }
            if (v.action === 'annotate') {
                return textBlock(`打标：本次 ${v.annotated} 块，剩余 ${v.remaining} 块${v.notes.length > 0 ? `\n${v.notes.map((n) => `- ${n}`).join('\n')}` : ''}`);
            }
            return textBlock(v.degraded
                ? `建索引失败（降级）：${v.reason}`
                : `建索引：扫描 ${v.scanned} 章，新增 ${v.added} / 更新 ${v.updated} / 清理 ${v.removed} 块，索引共 ${v.chunks} 块${v.notes.length > 0 ? `\n${v.notes.map((n) => `- ${n}`).join('\n')}` : ''}`);
        },
    });
}

/**
 * 降级检索：不依赖 sqlite 的字面子串扫描。
 * 只在运行时没有 `node:sqlite` 时走这条路——功能弱（无排序、无标签），但「找一段」仍可用。
 */
async function degradeQuery(io, novel, chapterKeys, query, limit) {
    const hits = [];
    for (const k of chapterKeys) {
        const rec = novel.chapters[String(k)];
        if (rec?.path === undefined) continue;
        const content = await io.readText(rec.path);
        if (content === null || !content.includes(query)) continue;
        hits.push({
            chapter: k, seq: 0, snippet: makeSnippet(content, query),
            hitRatio: Number(hitRatio(content, query).toFixed(2)), score: 0,
        });
        if (hits.length >= limit) break;
    }
    return hits;
}

/** 索引文件相对路径（对外文档/面板用）。 */
export const INDEX_PATH_HINT = INDEX_RELATIVE;
