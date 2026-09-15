// lib/tools/asset-tools.js — novel_import / novel_export / novel_glossary / novel_clone_project。
// 书目资产侧工具：导入（txt/md 切分）、导出（整本拼装）、术语表、书籍克隆。
// 全部确定性、走 ctx.fs 收口、版本化/审计对齐既有约定。

import { defineTool } from './define-tool.js';
import { defaultNovel, pathsFor, chapterRecord } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { audit, requireBook, saveBook, textBlock } from './common.js';
import { cloneProject } from '../clone.js';
import { splitIntoChapters, inferOpeningPreview, roughOutline } from '../import.js';
import { detectHookKind } from '../hook.js';
import { assembleBookText, bookStats } from '../export.js';
import { upsertTerm, removeTerm } from '../glossary.js';
import { sanitizeTitle } from '../versioning.js';

export function defineImportTool(ctx, config) {
    return defineTool({
        name: 'novel_import',
        description: '本地书籍导入：给定正文（content 粘贴，或 file 指定工作区内的 .md/.txt），自动识别章节标题切分，preview 只预览不落盘，import 创建书目录并版本化落盘每章；backfill 为导入的书回补门禁（从已存正文生成粗纲，可选 approve 批准）。',
        parameters: {
            action: { type: 'string', required: true, enum: ['preview', 'import', 'backfill'], description: 'preview 只切分预览；import 创建书并落盘；backfill 回补细纲（门禁）。' },
            approve: { type: 'boolean', description: 'backfill 可选：true = 同时批准本次生成的粗纲（记入审计；已有细纲的章不受影响）。' },
            book: { type: 'string', required: true, description: '书目名（新目录名）。' },
            title: { type: 'string', description: '书名（默认与 book 相同）。' },
            genre: { type: 'string', description: '题材，如 玄幻/悬疑/都市。' },
            logline: { type: 'string', description: '一句话立意。' },
            content: { type: 'string', description: '正文全文（和 file 二选一）。' },
            file: { type: 'string', description: '工作区内正文文件路径（和 content 二选一）。' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    title: { type: 'string' },
                    chapters: { type: 'integer' },
                    chars: { type: 'integer' },
                    skipped: { type: 'integer' },
                    previews: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        n: { type: 'integer', required: true }, title: { type: 'string', required: true }, chars: { type: 'integer', required: true },
                    } } },
                    backfilled: { type: 'array', items: { type: 'integer' } },
                    approved: { type: 'boolean' },
                    next: { type: 'string' },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);

            // backfill —— 导入旧书的门禁回补：为已有正文的章生成粗纲（可选批准）。
            // 只回补缺失的细纲；已有细纲的章不动（用户手写的正式细纲优先）。
            // 注意：backfill 不需要 content/file，必须放在正文读取之前。
            if (args.action === 'backfill') {
                const { novel } = await requireBook(io, book);
                novel.approvals = novel.approvals ?? { outline: {} };
                novel.approvals.outline = novel.approvals.outline ?? {};
                const generated = [];
                let skipped = 0;
                const keys = Object.keys(novel.chapters ?? {}).map(Number).sort((a, b) => a - b);
                for (const n of keys) {
                    const rec = novel.chapters[String(n)];
                    const outlinePath = p.chapterOutline(n);
                    if ((await io.readText(outlinePath)) !== null) { skipped += 1; continue; }
                    const content = await io.readText(rec.path);
                    if (content === null) { skipped += 1; continue; }
                    const clean = content.trim();
                    const castHere = (novel.cast ?? []).filter((name) => clean.includes(name));
                    const md = roughOutline({
                        n, title: rec.title, chars: clean.replace(/\s/g, '').length,
                        opening: clean.replace(/\s+/g, ' ').slice(0, 60),
                        tail: clean.slice(-80).replace(/\s+/g, ' ').trim(),
                        hookKind: detectHookKind(clean), cast: castHere,
                    });
                    await io.writeText(outlinePath, `${md}\n`, 'auto');
                    generated.push(n);
                    if (args.approve === true) novel.approvals.outline[String(n)] = true;
                }
                if (args.approve === true && generated.length > 0) await saveBook(io, p, novel);
                await audit(io, p, 'import/backfill', { generated: generated.length, skipped, approved: args.approve === true });
                return {
                    book, action: 'backfill', chapters: generated.length, skipped,
                    backfilled: generated, approved: args.approve === true && generated.length > 0,
                    next: generated.length === 0
                        ? '所有章节都已有细纲，无需回补。'
                        : `已为 ${generated.length} 章生成粗纲${args.approve === true ? '并批准（记入审计）' : ''}。人物状态建议手工 novel_ledger update 补账；续写新章正常走 novel_outline save_chapter + approve。`,
                };
            }

            let raw = args.content;
            if (raw === undefined && args.file) raw = await io.readText(args.file);
            if (raw === undefined || String(raw).trim() === '') throw new Error('import 需要 content 粘贴全文，或 file 指向工作区内正文文件');
            const chapters = splitIntoChapters(raw);
            if (chapters.length === 0) throw new Error('未解析到任何章节（正文为空或切分异常）');
            const previews = chapters.map((c) => ({ n: c.n, title: c.title, chars: c.content.replace(/\s/g, '').length }));

            if (args.action === 'preview') {
                return { book, action: 'preview', chapters: chapters.length, previews, next: `共 ${chapters.length} 章——确认无误后 novel_import import 落盘` };
            }

            // import：建书 + 每章版本化落盘（novel.json 只写一次，避免中间态与 logline 二义）
            if ((await io.readJson(p.meta)) !== null) throw new Error(`书目已存在：「${book}」。克隆请用 novel_clone_project。`);
            const title = args.title ?? book;
            let totalChars = 0;
            for (const c of chapters) {
                totalChars += c.content.replace(/\s/g, '').length;
                const rel = p.chapterFile(c.n, c.title, 1);
                await io.writeText(rel, `${c.content.trimEnd()}\n`, 'create');
            }
            // 章节索引（以切分后的连续章号为准）
            const novel = { ...defaultNovel({ title, genre: args.genre ?? '未分类', logline: args.logline ?? inferOpeningPreview(raw) ?? '', session: io.sessionId }), chapters: {} };
            for (const c of chapters) {
                const rel = p.chapterFile(c.n, c.title, 1);
                const rec = chapterRecord(undefined, { title: c.title, version: 1, file: rel, chars: c.content.replace(/\s/g, '').length, summary: '' });
                novel.chapters[String(c.n)] = rec;
            }
            novel.stage = 'drafting';
            await saveBook(io, p, novel);
            await audit(io, p, 'import/done', { book, title, chapters: chapters.length, chars: totalChars });
            return {
                book, action: 'import', title, chapters: chapters.length, chars: totalChars, skipped: 0,
                next: '已导入。下一步：novel_diagnose 跑黄金三章诊断 → novel_outline save_chapter 补细纲 → 接回主链路。',
            };
        },
        render: (_args, v) => textBlock(
            v.action === 'preview'
                ? `切分预览：${v.chapters} 章\n${(v.previews ?? []).map((c) => `- 第${c.n}章《${c.title}》${c.chars}字`).join('\n')}`
                : v.action === 'backfill'
                    ? `${v.next}`
                    : `已导入《${v.title}》：${v.chapters} 章 / ${v.chars} 字。${v.next}`
        ),
    });
}

export function defineExportTool(ctx, config) {
    return defineTool({
        name: 'novel_export',
        description: '导出整本：把已写章节按版本顺序拼装成 .md / .txt，写回 导出/ 目录。返回值含 stats（章节/总字/平均每章）。',
        parameters: {
            book: { type: 'string', required: true, description: '书目名。' },
            format: { type: 'string', enum: ['md', 'txt'], description: 'md=Markdown 章节标题；txt=纯文本。' },
            file: { type: 'string', description: '可覆盖输出路径（工作区相对，默认 书/导出/书名.md|txt）。' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    format: { type: 'string', required: true },
                    path: { type: 'string', required: true },
                    chars: { type: 'integer', required: true },
                    chapters: { type: 'integer', required: true },
                    stats: { type: 'object', required: true, additionalProperties: false, properties: {
                        chapters: { type: 'integer', required: true }, totalChars: { type: 'integer', required: true }, avgChapterChars: { type: 'integer', required: true },
                    } },
                    next: { type: 'string' },
                },
            },
        },
        // 无条件写导出文件 + 审计行（无"只读分支"可豁免）—— 必须静态排他。
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            const rows = Object.entries(novel.chapters ?? {})
                .map(([k, c]) => ({ chapter: Number(k), title: c.title, files: c.files ?? [] }))
                .sort((a, b) => a.chapter - b.chapter);
            const chapters = [];
            for (const r of rows) {
                const verses = [];
                for (const f of r.files ?? []) {
                    const content = await io.readText(f.file);
                    verses.push({ version: f.version, content: content ?? '' });
                }
                if (verses.length > 0) chapters.push({ chapter: r.chapter, title: r.title, versions: verses });
            }
            const format = args.format === 'txt' ? 'txt' : 'md';
            const rel = args.file ?? `${book}/导出/《${sanitizeTitle(novel.title)}》.${format}`;
            const text = assembleBookText(chapters, format);
            await io.writeText(rel, `${text}\n`, 'replace');
            await audit(io, p, 'export', { format, chapters: chapters.length });
            const stats = bookStats(chapters);
            return {
                book, format, path: rel, chars: stats.totalChars, chapters: stats.chapters, stats,
                next: format === 'md' ? '或 novel_export format:txt 导出纯文本' : `已导出 ${rel}`,
            };
        },
        render: (_args, v) => textBlock(`${v.format.toUpperCase()} 导出完成：${v.path}（${v.chapters} 章 / ${v.chars} 字，均章 ${v.stats.avgChapterChars}）`),
    });
}

export function defineGlossaryTool(ctx, config) {
    return defineTool({
        name: 'novel_glossary',
        description: '术语表：add 添加/覆盖一条专有名词定义；remove 删除；list 列出。写前简报会把术语表随上下文包注入，防专有名词乱译/前后不一。',
        parameters: {
            action: { type: 'string', required: true, enum: ['add', 'remove', 'list'], description: 'add/remove/list。' },
            book: { type: 'string', required: true, description: '书目名。' },
            term: { type: 'string', description: 'add/remove 必填：术语。' },
            definition: { type: 'string', description: 'add 必填：定义。' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true }, action: { type: 'string', required: true },
                    term: { type: 'string' }, definition: { type: 'string' }, count: { type: 'integer', required: true },
                    terms: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        term: { type: 'string', required: true }, definition: { type: 'string', required: true },
                    } } },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            await requireBook(io, book);
            let terms = (await io.readJson(p.glossary)) ?? [];
            if (args.action === 'add') {
                if (!args.term || !args.definition) throw new Error('add 需要 term 与 definition');
                terms = upsertTerm(terms, { term: args.term, definition: args.definition });
                await io.writeJson(p.glossary, terms);
                await audit(io, p, 'glossary/add', { term: args.term.trim() });
                return { book, action: 'add', term: args.term.trim(), definition: args.definition.trim(), count: terms.length, terms };
            }
            if (args.action === 'remove') {
                if (!args.term) throw new Error('remove 需要 term');
                const before = terms.length;
                terms = removeTerm(terms, args.term);
                await io.writeJson(p.glossary, terms);
                await audit(io, p, 'glossary/remove', { term: args.term.trim() });
                return { book, action: 'remove', term: args.term.trim(), count: terms.length, terms };
            }
            return { book, action: 'list', count: terms.length, terms };
        },
        render: (_args, v) => textBlock(
            v.action === 'list' ? `术语表 ${v.count} 条${v.terms.length ? `\n${v.terms.map((t) => `- ${t.term}：${t.definition.slice(0, 60)}`).join('\n')}` : '（空）'}`
            : `${v.action === 'add' ? '已记录' : '已删除'}术语「${v.term}」（${v.count} 条）`
        ),
    });
}

export function defineCloneTool(ctx, config) {
    return defineTool({
        name: 'novel_clone_project',
        description: '克隆一本书为模板：把 novel.json 索引、已写章节、大纲/细纲、人物卡、世界书、账本、伏笔复制到新书目录（阶段重置为 planning，提案清空，旧书不动）。',
        parameters: {
            from_book: { type: 'string', required: true, description: '源书目。' },
            new_book: { type: 'string', required: true, description: '新书目名（目录名）。' },
            title: { type: 'string', description: '新书名（默认 new_book）。' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true }, from_book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    chapters: { type: 'integer', required: true }, missing: { type: 'integer', required: true },
                    new_stage: { type: 'string', required: true }, next: { type: 'string' },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            // 克隆规则全在 lib/clone.js（与 REST 面板共用一份，别在这里再抄一遍）
            const io = createFsio(ctx, exec, sessionCwd(exec));
            return cloneProject(io, {
                fromBook: args.from_book,
                newBook: args.new_book,
                title: args.title,
                actor: 'agent',
            });
        },
        render: (_args, v) => textBlock(`已克隆 ${v.from_book} → ${v.book}：${v.chapters} 章（缺失 ${v.missing} 个文件），阶段重置为 ${v.new_stage}`),
    });
}