// lib/tools/worldbook-tool.js — novel_worldbook（世界书增删改查 / 导入导出）。
// 从 project-tools.js 按工具拆出；schema 与描述原样保留。

import { defineTool } from './define-tool.js';
import { normalizeWorldEntry, pathsFor, resolveWorldTrigger, sameEntryId } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { audit, requireBook, parseList, textBlock } from './common.js';
import { serializeWorldbook, parseWorldbookImport } from '../worldbook-io.js';

/**
 * 本书已知实体名池（纯 io 拼装，交给 store.resolveWorldTrigger 做判定）：
 * cast ∪ 账本实体 ∪ 术语表 ∪ 已有条目的触发词。读不到的一律跳过，不阻断固化设定。
 */
async function candidateNames(io, p, novel, entries) {
    const names = [...(novel?.cast ?? [])];
    try { for (const f of (await io.readJson(p.facts)) ?? []) names.push(f?.entity); } catch { /* 无账本 */ }
    try { for (const t of (await io.readJson(p.glossary)) ?? []) names.push(t?.term); } catch { /* 无术语表 */ }
    for (const e of entries ?? []) names.push(...(Array.isArray(e?.keywords) ? e.keywords : []));
    return names.filter((n) => typeof n === 'string' && n.trim() !== '');
}

export function defineWorldbookTool(ctx, config) {
    return defineTool({
        name: 'novel_worldbook',
        description: '世界书（lorebook）：add 固化一条设定（关键词触发或 always 常驻，写章时按细纲/出场人物自动注入）；list 列出；remove 按 id 删除。设定崩坏的解药——设定只认这里。没给 keywords 时不会报错：先按内容自动取本书已知实体名当触发词，取不到则转常驻注入，并在返回里说明走了哪条兜底。',
        parameters: {
            action: { type: 'string', required: true, enum: ['add', 'update', 'list', 'remove', 'import', 'export'], description: 'add 新增；update 按 id 合并更新；list 列出；remove 删除；import 批量导入（JSON 数组或 关键词|内容 行）；export 导出 JSON。' },
            book: { type: 'string', required: true, description: '书目名。' },
            id: { type: 'string', description: 'add 可自定义 id；update / remove 必填。' },
            keywords: { type: 'string', description: 'add/update：触发关键词，逗号/顿号分隔（如「灵潮,溯回者」）。省略时由代码兜底（自动取词→转常驻），不会报错。' },
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
                    // 兜底说明（缺触发词时走了哪条路）——降级必须可见，禁止静默
                    warnings: { type: 'array', items: { type: 'string' } },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            const entries = (await io.readJson(p.worldbook)) ?? [];

            if (args.action === 'add') {
                const given = parseList(args.keywords);
                const names = given.length > 0 || args.always === true ? [] : await candidateNames(io, p, novel, entries);
                const trigger = resolveWorldTrigger({ keywords: given, always: args.always === true, content: args.content, names });
                const entry = normalizeWorldEntry({
                    id: args.id, keywords: trigger.keywords, content: args.content,
                    always: trigger.always, priority: args.priority,
                }, entries);
                entries.push(entry);
                await io.writeJson(p.worldbook, entries);
                await audit(io, p, 'worldbook/add', { id: entry.id, derived: trigger.warning !== '' });
                return {
                    book, action: 'add', entry, count: entries.length,
                    ...(trigger.warning === '' ? {} : { warnings: [trigger.warning] }),
                };
            }
            if (args.action === 'list') {
                return { book, action: 'list', entries, count: entries.length };
            }
            if (args.action === 'update') {
                const idx = entries.findIndex((e) => sameEntryId(e.id, args.id));
                if (idx === -1) throw new Error(`世界书条目不存在：${args.id}`);
                const old = entries[idx];
                if (args.content === undefined && args.keywords === undefined && args.always === undefined && args.priority === undefined) {
                    throw new Error('update 至少需要 content / keywords / priority / always 之一');
                }
                const nextContent = args.content !== undefined ? args.content.trim() : old.content;
                const nextAlways = args.always !== undefined ? args.always === true : old.always;
                const given = args.keywords !== undefined ? parseList(args.keywords) : (old.keywords ?? []);
                const names = given.length > 0 || nextAlways ? [] : await candidateNames(io, p, novel, entries.filter((e) => e !== old));
                const trigger = resolveWorldTrigger({ keywords: given, always: nextAlways, content: nextContent, names });
                const merged = normalizeWorldEntry({
                    id: args.id,
                    keywords: trigger.keywords,
                    content: nextContent,
                    always: trigger.always,
                    priority: args.priority !== undefined ? args.priority : old.priority,
                }, entries.filter((e) => !sameEntryId(e.id, args.id)));
                entries[idx] = merged;
                await io.writeJson(p.worldbook, entries);
                await audit(io, p, 'worldbook/update', { id: args.id, derived: trigger.warning !== '' });
                return {
                    book, action: 'update', entry: merged, count: entries.length,
                    ...(trigger.warning === '' ? {} : { warnings: [trigger.warning] }),
                };
            }
            if (args.action === 'export') {
                return { book, action: 'export', entries, count: entries.length, payload: serializeWorldbook(entries) };
            }
            if (args.action === 'import') {
                if (!args.payload || String(args.payload).trim() === '') throw new Error('import 需要 payload');
                const parsed = parseWorldbookImport(args.payload, entries);
                let next = entries;
                for (const e of parsed.entries) {
                    const i = next.findIndex((x) => sameEntryId(x.id, e.id));
                    if (i === -1) next.push(e); else next[i] = e;
                }
                await io.writeJson(p.worldbook, next);
                await audit(io, p, 'worldbook/import', { accepted: parsed.entries.length, errors: parsed.errors.length });
                return { book, action: 'import', count: next.length, entries: next, errors: parsed.errors };
            }
            const rest = entries.filter((e) => !sameEntryId(e.id, args.id));
            if (rest.length === entries.length) throw new Error(`世界书条目不存在：${args.id}`);
            await io.writeJson(p.worldbook, rest);
            await audit(io, p, 'worldbook/remove', { id: args.id });
            return { book, action: 'remove', removed: args.id, count: rest.length };
        },
        render: (_args, v) => textBlock(
            (v.action === 'list' || v.action === 'import' || v.action === 'export'
                ? `世界书 ${v.count} 条${v.action === 'export' ? '\n' + v.payload : ''}${v.action === 'import' && v.errors?.length ? `（${v.errors.length} 行跳过）` : ''}`
                : v.action === 'add' ? `已固化设定 ${v.entry.id}（触发词：${v.entry.keywords.join('、') || '常驻'}）；世界书共 ${v.count} 条`
                : v.action === 'update' ? `已更新 ${v.entry.id}；世界书 ${v.count} 条`
                : `已删除 ${v.removed}；剩余 ${v.count} 条`)
            // 兜底必须可见：走了自动取词/转常驻，模型要把这条转述给用户，不能当成静默成功
            + (v.warnings?.length ? `\n⚠ ${v.warnings.join('\n⚠ ')}` : '')),
    });
}
