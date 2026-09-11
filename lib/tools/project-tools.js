// lib/tools/project-tools.js — novel_project / novel_outline / novel_character / novel_worldbook。
// 书目生命周期与「设定资产」管理。所有可变写都带版本守卫（fsio 'auto'），
// 审批落 novel.json.approvals（写章门禁读取），全部动作记 audit.jsonl。

import { defineTool } from '@deepseek-ai/dsh-tools';
import { defaultNovel, normalizeWorldEntry, pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { audit, requireBook, saveBook, parseList, textBlock } from './common.js';
import { resetStage } from '../gate.js';
import { serializeWorldbook, parseWorldbookImport } from '../worldbook-io.js';

export function defineProjectTool(ctx, config) {
    return defineTool({
        name: 'novel_project',
        description: '小说工程管理：init 创建一本书的本地工程（novel.json + 目录骨架），status 查看阶段/章节/账本/伏笔概况，repair 把 novel.json 索引与磁盘对账（清理失效文件引用、撤销无细纲批准）。书 = 工作区内的一个目录。',
        parameters: {
            action: { type: 'string', required: true, enum: ['init', 'status', 'set_stage', 'repair'], description: 'init 创建新书；status 查看概况；set_stage 显式调整阶段；repair 索引-磁盘对账修复。' },
            book: { type: 'string', required: true, description: '书目名（工作区内的目录名，如「星海拾骨」）。' },
            title: { type: 'string', description: 'init：书名（默认与 book 相同）。' },
            genre: { type: 'string', description: 'init：题材，如 玄幻/悬疑/都市。' },
            logline: { type: 'string', description: 'init：一句话故事（立意层，之后每次写章都会随上下文包出现）。' },
            stage: { type: 'string', description: 'set_stage 必填：目标阶段 planning/outline/drafting/revising/done。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    title: { type: 'string' },
                    genre: { type: 'string' },
                    stage: { type: 'string' },
                    next: { type: 'string' },
                    chapters: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        chapter: { type: 'integer', required: true }, title: { type: 'string', required: true },
                        latest: { type: 'integer', required: true }, chars: { type: 'integer', required: true },
                        summary: { type: 'string' },
                    } } },
                    openForeshadows: { type: 'integer' },
                    factCount: { type: 'integer' },
                    missing: { type: 'array', items: { type: 'string' } },
                    droppedApprovals: { type: 'integer' },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);

            if (args.action === 'init') {
                const existing = await io.readJson(p.meta);
                if (existing !== null) throw new Error(`书目已存在：「${book}」。换一个书名，或直接 status 查看。`);
                const novel = defaultNovel({
                    title: args.title ?? book,
                    genre: args.genre ?? '未分类',
                    logline: args.logline ?? '',
                });
                await io.writeJson(p.meta, novel, 'create');
                await audit(io, p, 'init', { book, title: novel.title, genre: novel.genre });
                return {
                    book, action: 'init', title: novel.title, genre: novel.genre,
                    next: '依次：novel_outline save_book 存全书大纲 → novel_character save 建人物卡 → novel_worldbook add 固化设定 → novel_outline save_chapter+approve 批准细纲 → novel_write_chapter 写章',
                };
            }

            // status
            if (args.action === 'status') {
                const { novel } = await requireBook(io, book);
                const facts = (await io.readJson(p.facts)) ?? [];
                const foreshadows = (await io.readJson(p.foreshadows)) ?? [];
                const chapters = Object.entries(novel.chapters ?? {})
                    .map(([k, c]) => ({ chapter: Number(k), title: c.title, latest: c.latest, chars: c.chars, summary: c.summary }))
                    .sort((a, b) => a.chapter - b.chapter);
                return {
                    book, action: 'status', title: novel.title, genre: novel.genre, stage: novel.stage,
                    chapters, openForeshadows: foreshadows.filter((f) => f.payoffChapter === null).length,
                    factCount: facts.length,
                };
            }

            // set_stage —— 显式阶段重置/纠正通道（默认 advanceStage 只前进，无撤回口）
            if (args.action === 'set_stage') {
                const { novel } = await requireBook(io, book);
                resetStage(novel, args.stage);
                await saveBook(io, p, novel);
                await audit(io, p, 'project/set_stage', { stage: novel.stage });
                return { book, action: 'set_stage', stage: novel.stage, next: `阶段已设为 ${novel.stage}` };
            }

            // repair —— novel.json 索引与磁盘对账：文件被手工删除/移动后的自愈通道
            if (args.action === 'repair') {
                const { novel } = await requireBook(io, book);
                const missing = [];
                for (const [k, rec] of Object.entries(novel.chapters ?? {})) {
                    const files = [];
                    for (const f of rec.files ?? []) {
                        if ((await io.readText(f.file)) !== null) files.push(f);
                        else missing.push(f.file);
                    }
                    if (files.length === 0) { delete novel.chapters[k]; continue; } // 整章丢失 → 移除记录
                    rec.files = files;
                    rec.versions = [...new Set(files.map((f) => f.version))].sort((a, b) => a - b);
                    rec.latest = rec.versions[rec.versions.length - 1];
                    const lastFile = files[files.length - 1].file;
                    if (rec.path !== lastFile) rec.path = lastFile;
                    const content = await io.readText(rec.path);
                    if (content !== null) rec.chars = content.replace(/\s/g, '').length;
                }
                novel.chapters = Object.fromEntries(
                    Object.entries(novel.chapters ?? {}).sort(([a], [b]) => Number(a) - Number(b)),
                );
                let droppedApprovals = 0;
                const approvals = novel.approvals?.outline ?? {};
                for (const k of Object.keys(approvals)) {
                    if ((await io.readText(p.chapterOutline(Number(k)))) === null) {
                        delete approvals[k];
                        droppedApprovals += 1;
                    }
                }
                await saveBook(io, p, novel);
                await audit(io, p, 'project/repair', { missingFiles: missing.length, droppedApprovals, chapters: Object.keys(novel.chapters).length });
                const facts = (await io.readJson(p.facts)) ?? [];
                const foreshadows = (await io.readJson(p.foreshadows)) ?? [];
                return {
                    book, action: 'repair', stage: novel.stage, missing, droppedApprovals,
                    chapters: Object.entries(novel.chapters).map(([k, c]) => ({ chapter: Number(k), title: c.title, latest: c.latest, chars: c.chars, summary: c.summary })),
                    openForeshadows: foreshadows.filter((f) => f.payoffChapter === null).length,
                    factCount: facts.length,
                    next: `对账完成：清理 ${missing.length} 个失效文件引用，撤销 ${droppedApprovals} 个无细纲批准；现余 ${Object.keys(novel.chapters).length} 章。`,
                };
            }
        },
        render: (_args, v) => textBlock(
            v.action === 'init'
                ? `已创建《${v.title}》（${v.genre}）。下一步：${v.next}`
                : v.action === 'repair'
                    ? `${v.next}`
                    : `《${v.title}》 stage=${v.stage}；章节 ${v.chapters.length}；账本 ${v.factCount} 条；未回收伏笔 ${v.openForeshadows}。`
        ),
    });
}

export function defineOutlineTool(ctx, config) {
    return defineTool({
        name: 'novel_outline',
        description: '大纲与细纲：save_book 存全书大纲；save_chapter 保存第N章细纲；approve 批准该章细纲——未批准的章节 novel_write_chapter 会直接拒绝（阶段门禁）。',
        parameters: {
            action: { type: 'string', required: true, enum: ['save_book', 'save_chapter', 'approve'], description: 'save_book 存全书大纲；save_chapter 存第N章细纲；approve 批准第N章细纲。' },
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', description: 'save_chapter / approve 必填：章号。' },
            outline: { type: 'string', description: 'save_book / save_chapter 必填：Markdown 正文。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    chapter: { type: 'integer' },
                    path: { type: 'string' },
                    approved: { type: 'boolean' },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);

            if (args.action === 'save_book') {
                if (!args.outline || args.outline.trim() === '') throw new Error('save_book 需要 outline 正文');
                const rel = p.bookOutline;
                await io.writeText(rel, `${args.outline.trim()}\n`, 'auto');
                await audit(io, p, 'outline/save_book', { chars: args.outline.length });
                return { book, action: 'save_book', path: rel };
            }
            if (!Number.isInteger(args.chapter) || args.chapter < 1) throw new Error('save_chapter / approve 需要正整数 chapter');
            if (args.action === 'save_chapter') {
                if (!args.outline || args.outline.trim() === '') throw new Error('save_chapter 需要 outline 正文（含本章出场人物与必须覆盖的情节点）');
                const rel = p.chapterOutline(args.chapter);
                await io.writeText(rel, `${args.outline.trim()}\n`, 'auto');
                await audit(io, p, 'outline/save_chapter', { chapter: args.chapter, chars: args.outline.length });
                return { book, action: 'save_chapter', chapter: args.chapter, path: rel };
            }
            // approve
            const { novel } = await requireBook(io, book);
            const rel = p.chapterOutline(args.chapter);
            if ((await io.readText(rel)) === null) throw new Error(`第${args.chapter}章细纲文件不存在：先 save_chapter 再 approve`);
            // 防御：旧版 clone 产物或手工编辑过的 novel.json 可能缺 approvals.outline
            novel.approvals = novel.approvals ?? { outline: {} };
            novel.approvals.outline = novel.approvals.outline ?? {};
            novel.approvals.outline[String(args.chapter)] = true;
            await saveBook(io, p, novel);
            await audit(io, p, 'outline/approve', { chapter: args.chapter });
            return { book, action: 'approve', chapter: args.chapter, approved: true };
        },
        render: (_args, v) => textBlock(
            v.action === 'approve'
                ? `第${v.chapter}章细纲已批准，可以 novel_write_chapter。`
                : `已保存：${v.path}`
        ),
    });
}

export function defineCharacterTool(ctx, config) {
    return defineTool({
        name: 'novel_character',
        description: '人物卡：save 保存/更新「人物/<名>.md」（外在底色、隐性欲望、语言基因卡：口癖/禁忌词/句长习惯——写章时自动注入上下文包）；list 列出已建人物。',
        parameters: {
            action: { type: 'string', required: true, enum: ['save', 'list'], description: 'save 保存人物卡；list 列出。' },
            book: { type: 'string', required: true, description: '书目名。' },
            name: { type: 'string', description: 'save 必填：人物名。' },
            card: { type: 'string', description: 'save 必填：人物卡 Markdown 正文。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    name: { type: 'string' },
                    path: { type: 'string' },
                    cast: { type: 'array', items: { type: 'string' } },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            novel.cast = novel.cast ?? [];

            if (args.action === 'list') {
                return { book, action: 'list', cast: [...novel.cast] };
            }
            if (!args.name || !args.card || args.card.trim() === '') throw new Error('save 需要 name 与 card 正文');
            const rel = p.character(args.name);
            await io.writeText(rel, `${args.card.trim()}\n`, 'auto');
            if (!novel.cast.includes(args.name.trim())) novel.cast.push(args.name.trim());
            await saveBook(io, p, novel);
            await audit(io, p, 'character/save', { name: args.name, chars: args.card.length });
            return { book, action: 'save', name: args.name.trim(), path: rel, cast: [...novel.cast] };
        },
        render: (_args, v) => textBlock(v.action === 'list'
            ? `已建人物：${v.cast.length === 0 ? '（无）' : v.cast.join('、')}`
            : `人物卡已保存：${v.path}；当前 cast ${v.cast.length} 人`),
    });
}

export function defineWorldbookTool(ctx, config) {
    return defineTool({
        name: 'novel_worldbook',
        description: '世界书（lorebook）：add 固化一条设定（关键词触发或 always 常驻，写章时按细纲/出场人物自动注入）；list 列出；remove 按 id 删除。设定崩坏的解药——设定只认这里。',
        parameters: {
            action: { type: 'string', required: true, enum: ['add', 'update', 'list', 'remove', 'import', 'export'], description: 'add 新增；update 按 id 合并更新；list 列出；remove 删除；import 批量导入（JSON 数组或 关键词|内容 行）；export 导出 JSON。' },
            book: { type: 'string', required: true, description: '书目名。' },
            id: { type: 'string', description: 'add 可自定义 id；update / remove 必填。' },
            keywords: { type: 'string', description: 'add/update：触发关键词，逗号/顿号分隔（如「灵潮,溯回者」）；always=true 时可省。' },
            priority: { type: 'integer', description: 'add/update：注入优先级 0-100（默认 50）。预算不足时高优先级条目先入上下文。' },
            content: { type: 'string', description: 'add 必填；update 可选：设定内容（是什么+为什么+对故事的影响）。' },
            always: { type: 'boolean', description: 'add/update：true = 常驻注入（仅限全书级核心设定，省预算）。' },
            payload: { type: 'string', description: 'import 必填：批量导入内容。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    removed: { type: 'string' },
                    count: { type: 'integer', required: true },
                    entries: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        id: { type: 'string', required: true }, keywords: { type: 'array', items: { type: 'string' }, required: true },
                        always: { type: 'boolean', required: true }, priority: { type: 'integer', required: true },
                        content: { type: 'string', required: true },
                    } } },
                    entry: { type: 'object', additionalProperties: false, properties: {
                        id: { type: 'string', required: true }, keywords: { type: 'array', items: { type: 'string' }, required: true },
                        always: { type: 'boolean', required: true }, priority: { type: 'integer', required: true },
                        content: { type: 'string', required: true },
                    } },
                    payload: { type: 'string' },
                    errors: { type: 'array', items: { type: 'string' } },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            await requireBook(io, book);
            const entries = (await io.readJson(p.worldbook)) ?? [];

            if (args.action === 'add') {
                const entry = normalizeWorldEntry({
                    id: args.id, keywords: parseList(args.keywords), content: args.content,
                    always: args.always === true, priority: args.priority,
                }, entries);
                entries.push(entry);
                await io.writeJson(p.worldbook, entries);
                await audit(io, p, 'worldbook/add', { id: entry.id });
                return { book, action: 'add', entry, count: entries.length };
            }
            if (args.action === 'list') {
                return { book, action: 'list', entries, count: entries.length };
            }
            if (args.action === 'update') {
                const idx = entries.findIndex((e) => e.id === args.id);
                if (idx === -1) throw new Error(`世界书条目不存在：${args.id}`);
                const old = entries[idx];
                if (args.content === undefined && args.keywords === undefined && args.always === undefined && args.priority === undefined) {
                    throw new Error('update 至少需要 content / keywords / priority / always 之一');
                }
                const merged = normalizeWorldEntry({
                    id: args.id,
                    keywords: args.keywords !== undefined ? parseList(args.keywords) : old.keywords,
                    content: args.content !== undefined ? args.content.trim() : old.content,
                    always: args.always !== undefined ? args.always === true : old.always,
                    priority: args.priority !== undefined ? args.priority : old.priority,
                }, entries.filter((e) => e.id !== args.id));
                entries[idx] = merged;
                await io.writeJson(p.worldbook, entries);
                await audit(io, p, 'worldbook/update', { id: args.id });
                return { book, action: 'update', entry: merged, count: entries.length };
            }
            if (args.action === 'export') {
                return { book, action: 'export', entries, count: entries.length, payload: serializeWorldbook(entries) };
            }
            if (args.action === 'import') {
                if (!args.payload || String(args.payload).trim() === '') throw new Error('import 需要 payload');
                const parsed = parseWorldbookImport(args.payload, entries);
                let next = entries;
                for (const e of parsed.entries) {
                    const i = next.findIndex((x) => x.id === e.id);
                    if (i === -1) next.push(e); else next[i] = e;
                }
                await io.writeJson(p.worldbook, next);
                await audit(io, p, 'worldbook/import', { accepted: parsed.entries.length, errors: parsed.errors.length });
                return { book, action: 'import', count: next.length, entries: next, errors: parsed.errors };
            }
            const rest = entries.filter((e) => e.id !== args.id);
            if (rest.length === entries.length) throw new Error(`世界书条目不存在：${args.id}`);
            await io.writeJson(p.worldbook, rest);
            await audit(io, p, 'worldbook/remove', { id: args.id });
            return { book, action: 'remove', removed: args.id, count: rest.length };
        },
        render: (_args, v) => textBlock(
            v.action === 'list' || v.action === 'import' || v.action === 'export'
                ? `世界书 ${v.count} 条${v.action === 'export' ? '\n' + v.payload : ''}${v.action === 'import' && v.errors?.length ? `（${v.errors.length} 行跳过）` : ''}`
                : v.action === 'add' ? `已固化设定 ${v.entry.id}（触发词：${v.entry.keywords.join('、') || '常驻'}）；世界书共 ${v.count} 条`
                : v.action === 'update' ? `已更新 ${v.entry.id}；世界书 ${v.count} 条`
                : `已删除 ${v.removed}；剩余 ${v.count} 条`),
    });
}
