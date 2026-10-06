// lib/tools/outline-tool.js — novel_outline（全书大纲 / 分章细纲 / 细纲批准门禁）。
// 从 project-tools.js 按工具拆出；schema 与描述原样保留。

import { defineTool } from './define-tool.js';
import { pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { audit, requireBook, saveBook, textBlock } from './common.js';
import { clearBreaker } from '../circuit-breaker.js';

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
            // L11 修复：save_book / save_chapter 此前不查书是否存在——对不存在的书
            // 调用会静默写出幽灵目录。requireBook 先行（approve 本来就有）。
            const { novel } = await requireBook(io, book);

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
            const rel = p.chapterOutline(args.chapter);
            if ((await io.readText(rel)) === null) throw new Error(`第${args.chapter}章细纲文件不存在：先 save_chapter 再 approve`);
            // 防御：旧版 clone 产物或手工编辑过的 novel.json 可能缺 approvals.outline
            novel.approvals = novel.approvals ?? { outline: {} };
            novel.approvals.outline = novel.approvals.outline ?? {};
            novel.approvals.outline[String(args.chapter)] = true;
            // 熔断解除通道之一：细纲重批＝重新校准，清零该章连续驳回计数
            clearBreaker(novel, args.chapter);
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
