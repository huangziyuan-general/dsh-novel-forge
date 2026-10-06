// lib/tools/worldbook-tool.js — novel_worldbook（世界书增删改查 / 导入导出）。
// 从 project-tools.js 按工具拆出；schema 与描述原样保留。

import { defineTool } from './define-tool.js';
import { normalizeWorldEntry, pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { audit, requireBook, parseList, textBlock } from './common.js';
import { serializeWorldbook, parseWorldbookImport } from '../worldbook-io.js';

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
