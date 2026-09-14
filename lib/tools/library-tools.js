// lib/tools/library-tools.js — novel_library：书库（外部小说「饲料」）。
//
// 这是全插件唯一**不服务于「写下去」**的工具——它服务于「学别人怎么写」。
// 所以它刻意与书目体系隔离：饲料不是稿件，没有审计、不进上下文包、
// 不参与一致性判定（对照标准是别人，不是本书）。
//
// 落点在**工作区根的 书库/**（与各书目平级），多本书共享同一批饲料。

import { defineTool } from './define-tool.js';
import { createFsio, sessionCwd } from '../fsio.js';
import {
    chaptersFromText, analyzeStructure, compareStructures,
    libraryId, structureDigest, LIBRARY_INDEX, sourcePath, MAX_SOURCE_CHARS,
} from '../library.js';
import { requireBook, textBlock } from './common.js';

/** 定位书库条目：id 优先，其次 title（口语化调用常只给作品名）。 */
function findEntry(index, args) {
    const key = String(args.id ?? args.title ?? '').trim();
    if (key === '') throw new Error('需要用 id 或 title 指定作品（先 action=list 看有哪些）');
    const hit = index.find((e) => e.id === key || e.title === key);
    if (hit === undefined) {
        throw new Error(`书库里没有「${key}」。用 action=list 看已有作品，或 action=import 导入。`);
    }
    return hit;
}

/** 读自家书的逐章正文（与书库喂同一个 analyzeStructure，才能并排比）。 */
async function ownChapters(io, book) {
    const { novel } = await requireBook(io, book);
    const nums = Object.keys(novel.chapters ?? {}).map(Number).filter((n) => Number.isInteger(n)).sort((a, b) => a - b);
    const out = [];
    for (const n of nums) {
        const rec = novel.chapters[String(n)];
        if (rec?.path === undefined) continue;
        const text = await io.readText(rec.path);
        if (text === null) continue;
        out.push({ title: rec.title ?? `第${n}章`, content: text });
    }
    if (out.length === 0) throw new Error(`「${book}」还没有可分析的正文（先写几章，或检查 novel_project action=status）。`);
    return out;
}

/** 结构画像 → 扁平可校验的 report（扁平是为了 schema 简单、渲染直接）。 */
function toReport(a) {
    return {
        chapters: a.chapters,
        chars: a.chars,
        meanChars: a.length.mean,
        medianChars: a.length.median,
        minChars: a.length.min,
        maxChars: a.length.max,
        lengthCv: a.length.cv,
        dialogueRatio: a.dialogueRatio,
        paragraphsPerChapter: a.paragraph.mean,
        hookRate: a.hookRate,
        hooksQuestion: a.hookKinds.question ?? 0,
        hooksEllipsis: a.hookKinds.ellipsis ?? 0,
        hooksSuspense: a.hookKinds.suspense ?? 0,
        hooksExclaim: a.hookKinds.exclaim ?? 0,
        meanSentence: a.freeform.meanSentence,
        firstThreeMean: a.freeform.firstThreeMean,
        topPhrases: a.topPhrases,
    };
}

export function defineLibraryTool(ctx, config) {
    return defineTool({
        name: 'novel_library',
        description: '书库（外部小说「饲料」）：import 导入对标作品（给 path 读工作区文本文件，或直接给 text）；list 列书库；'
            + 'read 看某作品的分章概览；analyze 拆书——章节长度曲线/对话密度/段落节奏/章末钩子率/高频意象，**纯本地零 token**；'
            + 'delete 移出书库（宿主 fs 不提供删除能力，只移索引）。'
            + 'analyze 给 compare_book 时，会把拆解结果**与自己的书并排**给数——把「凭感觉学」换成「照着自己的数调参数」。',
        parameters: {
            action: { type: 'string', required: true, enum: ['import', 'list', 'read', 'analyze', 'delete'], description: '五选一。' },
            title: { type: 'string', description: 'import 必填：作品名；其它动作可用它定位（与 id 二选一）。' },
            id: { type: 'string', description: '作品 id（list 里给出）；与 title 二选一。' },
            path: { type: 'string', description: 'import 用：工作区内的文本文件路径（.txt/.md），按**工作区相对**算。' },
            text: { type: 'string', description: 'import 用：直接把全文粘进来（与 path 二选一，优先 text）。' },
            from: { type: 'integer', description: 'read 用：起始章号（默认 1）。' },
            to: { type: 'integer', description: 'read 用：结束章号（默认与 from 同章；给大数可一次看完）。' },
            compare_book: { type: 'string', description: 'analyze 用：把画像与这本书并排对比（建议对标的题材相近）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    action: { type: 'string', required: true },
                    note: { type: 'string', required: true },
                    entries: { type: 'array', required: true, items: {
                        type: 'object', additionalProperties: false, properties: {
                            id: { type: 'string', required: true },
                            title: { type: 'string', required: true },
                            chapters: { type: 'integer', required: true },
                            chars: { type: 'integer', required: true },
                            origin: { type: 'string', required: true },
                            importedAt: { type: 'string', required: true },
                        },
                    } },
                    report: { type: 'object', additionalProperties: false, properties: {
                        chapters: { type: 'integer', required: true },
                        chars: { type: 'integer', required: true },
                        meanChars: { type: 'integer', required: true },
                        medianChars: { type: 'integer', required: true },
                        minChars: { type: 'integer', required: true },
                        maxChars: { type: 'integer', required: true },
                        lengthCv: { type: 'number', required: true },
                        dialogueRatio: { type: 'number', required: true },
                        paragraphsPerChapter: { type: 'number', required: true },
                        hookRate: { type: 'number', required: true },
                        hooksQuestion: { type: 'integer', required: true },
                        hooksEllipsis: { type: 'integer', required: true },
                        hooksSuspense: { type: 'integer', required: true },
                        hooksExclaim: { type: 'integer', required: true },
                        meanSentence: { type: 'number', required: true },
                        firstThreeMean: { type: 'integer', required: true },
                        topPhrases: { type: 'array', required: true, items: {
                            type: 'object', additionalProperties: false, properties: {
                                term: { type: 'string', required: true },
                                count: { type: 'integer', required: true },
                            },
                        } },
                    } },
                    compare: { type: 'array', items: {
                        type: 'object', additionalProperties: false, properties: {
                            label: { type: 'string', required: true },
                            mine: { type: 'string', required: true },
                            theirs: { type: 'string', required: true },
                        },
                    } },
                    chapters: { type: 'array', items: {
                        type: 'object', additionalProperties: false, properties: {
                            n: { type: 'integer', required: true },
                            title: { type: 'string', required: true },
                            chars: { type: 'integer', required: true },
                            excerpt: { type: 'string', required: true },
                        },
                    } },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const index = (await io.readJson(LIBRARY_INDEX)) ?? [];
            if (!Array.isArray(index)) throw new Error(`${LIBRARY_INDEX} 不是数组（可能被手工改坏）`);
            const entryView = (e) => ({
                id: e.id, title: e.title, chapters: e.chapters, chars: e.chars,
                origin: e.origin ?? '', importedAt: e.importedAt ?? '',
            });

            if (args.action === 'list') {
                return {
                    action: 'list',
                    note: index.length === 0 ? '书库是空的。用 import 把对标作品导进来当饲料。' : `书库有 ${index.length} 部作品。`,
                    entries: index.map(entryView),
                };
            }

            if (args.action === 'import') {
                let text = typeof args.text === 'string' ? args.text : null;
                let origin = '直接粘贴';
                if (text === null && typeof args.path === 'string' && args.path.trim() !== '') {
                    const p = args.path.trim();
                    text = await io.readText(p);
                    if (text === null) {
                        throw new Error(`读不到文件「${p}」。路径按**工作区相对**算（如 素材/斗破.txt），绝对路径会被沙箱拒绝。`);
                    }
                    origin = p;
                }
                if (text === null || text.trim() === '') throw new Error('import 需要 text 或 path（二选一）');
                if (text.length > MAX_SOURCE_CHARS) {
                    throw new Error(`原文 ${text.length} 字，超过单次上限 ${MAX_SOURCE_CHARS}——请先切分成几部导入。`);
                }
                const title = String(args.title ?? '').trim();
                if (title === '') throw new Error('import 需要 title（作品名，也是书库里的 id 来源）');
                const id = libraryId(title);
                if (index.some((e) => e.id === id)) {
                    throw new Error(`书库已有「${title}」。要替换请先 action=delete，或换个 title。`);
                }
                const chapters = chaptersFromText(text);
                if (chapters.length === 0) throw new Error('没切出任何章节——确认原文里有「第X章」这类标题行。');
                const chars = chapters.reduce((n, c) => n + c.content.replace(/\s/g, '').length, 0);
                await io.writeText(sourcePath(id), text, 'create');
                const entry = {
                    id, title, origin, chapters: chapters.length, chars,
                    importedAt: new Date().toISOString(),
                };
                await io.writeJson(LIBRARY_INDEX, [...index, entry]);
                return {
                    action: 'import',
                    note: `已导入「${title}」：${chapters.length} 章 / ${chars} 字。用 action=analyze 拆它的结构。`,
                    entries: [entryView(entry)],
                };
            }

            if (args.action === 'delete') {
                const hit = findEntry(index, args);
                await io.writeJson(LIBRARY_INDEX, index.filter((e) => e.id !== hit.id));
                return {
                    action: 'delete',
                    note: `已把「${hit.title}」移出书库索引。注意：宿主 fs 服务不提供删除能力，原文仍在 书库/${hit.id}/ 下——要彻底清除请手工删掉该目录。`,
                    entries: index.filter((e) => e.id !== hit.id).map(entryView),
                };
            }

            // read / analyze 都要原文
            const hit = findEntry(index, args);
            const text = await io.readText(sourcePath(hit.id));
            if (text === null) {
                throw new Error(`书库里没有「${hit.title}」的原文（书库/${hit.id}/原文.txt 缺失）——重新 import 一次。`);
            }
            const chapters = chaptersFromText(text);

            if (args.action === 'read') {
                const from = Number.isInteger(args.from) && args.from >= 1 ? args.from : 1;
                const to = Number.isInteger(args.to) && args.to >= from ? args.to : from;
                const slice = chapters.slice(from - 1, to);
                if (slice.length === 0) throw new Error(`「${hit.title}」只有 ${chapters.length} 章，读不到第 ${from}–${to} 章。`);
                return {
                    action: 'read',
                    note: `「${hit.title}」第 ${from}–${to} 章（共 ${chapters.length} 章）`,
                    entries: [],
                    chapters: slice.map((c, i) => ({
                        n: from + i,
                        title: c.title,
                        chars: c.content.replace(/\s/g, '').length,
                        excerpt: c.content.replace(/\s+/g, ' ').trim().slice(0, 200),
                    })),
                };
            }

            // analyze
            const report = analyzeStructure(chapters);
            const out = {
                action: 'analyze',
                note: structureDigest(report, `「${hit.title}」`),
                entries: [],
                report: toReport(report),
            };
            if (typeof args.compare_book === 'string' && args.compare_book.trim() !== '') {
                const own = analyzeStructure(await ownChapters(io, args.compare_book.trim()));
                out.compare = compareStructures(own, report).map((r) => ({
                    label: r.label, mine: String(r.mine), theirs: String(r.theirs),
                }));
                out.note = `${structureDigest(own, `「${args.compare_book.trim()}」（本书）`)}\n${structureDigest(report, `「${hit.title}」（对标）`)}`;
            }
            return out;
        },
        render: (args, v) => {
            if (v.action === 'list' || v.action === 'delete') {
                const rows = v.entries.map((e) => `${e.title}（${e.id}）：${e.chapters} 章 / ${e.chars} 字${e.origin !== '直接粘贴' ? ` ← ${e.origin}` : ''}`);
                return textBlock(`${v.note}\n${rows.join('\n')}`);
            }
            if (v.action === 'import') return textBlock(v.note);
            if (v.action === 'read') {
                const rows = v.chapters.map((c) => `第${c.n}章 ${c.title}（${c.chars}字）\n  ${c.excerpt}…`);
                return textBlock(`${v.note}\n\n${rows.join('\n')}`);
            }
            const pct = (x) => `${(x * 100).toFixed(1)}%`;
            const r = v.report;
            const lines = [
                v.note, '',
                `章长：均值 ${r.meanChars} / 中位 ${r.medianChars}（${r.minChars}–${r.maxChars}）· 波动 cv ${r.lengthCv}`,
                `对话密度 ${pct(r.dialogueRatio)} · 平均 ${r.paragraphsPerChapter} 段/章 · 单句均长 ${r.meanSentence} 字`,
                `章末钩子率 ${pct(r.hookRate)}（疑问 ${r.hooksQuestion} / 省略 ${r.hooksEllipsis} / 悬念 ${r.hooksSuspense} / 感叹 ${r.hooksExclaim}）`,
                `前 3 章均长 ${r.firstThreeMean} 字`,
                `高频意象：${r.topPhrases.slice(0, 8).map((t) => `${t.term}×${t.count}`).join('、') || '（无）'}`,
            ];
            if (v.compare !== undefined) {
                lines.push('', '── 本书 vs 对标 ──');
                for (const row of v.compare) lines.push(`${row.label}：${row.mine}  ←→  ${row.theirs}`);
            }
            return textBlock(lines.join('\n'));
        },
    });
}
