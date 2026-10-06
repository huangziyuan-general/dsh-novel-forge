// lib/tools/noai-scan-tool.js — novel_noai_scan（结构性去 AI 味扫描）。
// 从 quality-tools.js 按工具拆出；schema 与描述原样保留。

import { defineTool } from './define-tool.js';
import { pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { scanAiFlavor } from '../noai.js';
import { requireBook, textBlock } from './common.js';

export function defineNoaiScanTool(ctx, config) {
    return defineTool({
        name: 'novel_noai_scan',
        description: '结构性去 AI 味扫描（纯本地计算，零模型调用）：六维判定——模板句/库存词密度/情绪直写/句式模板与标点滥用/段落节奏方差/信息稀释。给 text 直接扫；给 book+chapter 扫该书该章最新版本。审稿前必跑。',
        parameters: {
            text: { type: 'string', description: 'text / (book+chapter) 二选一：要扫描的正文。' },
            book: { type: 'string', description: '书目名（与 chapter 同给，扫已保存章节最新版）。' },
            chapter: { type: 'integer', description: '章号。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    source: { type: 'string', required: true },
                    score: { type: 'integer', required: true },
                    level: { type: 'string', required: true },
                    chars: { type: 'integer', required: true },
                    topIssues: { type: 'array', items: { type: 'string' }, required: true },
                    categories: { type: 'object', required: true, additionalProperties: false, properties: {
                        cliche: { type: 'object', required: true, additionalProperties: false, properties: {
                            score: { type: 'integer', required: true }, total: { type: 'integer', required: true },
                            hits: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                                term: { type: 'string', required: true }, count: { type: 'integer', required: true },
                                lines: { type: 'array', items: { type: 'integer' }, required: true },
                            } } },
                        } },
                        stock: { type: 'object', required: true, additionalProperties: false, properties: {
                            score: { type: 'integer', required: true }, total: { type: 'integer', required: true },
                            hits: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                                term: { type: 'string', required: true }, count: { type: 'integer', required: true },
                                per1k: { type: 'number', required: true },
                            } } },
                        } },
                        emotion: { type: 'object', required: true, additionalProperties: false, properties: {
                            score: { type: 'integer', required: true }, total: { type: 'integer', required: true },
                            hits: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                                match: { type: 'string', required: true }, line: { type: 'integer', required: true },
                            } } },
                        } },
                        template: { type: 'object', required: true, additionalProperties: false, properties: {
                            score: { type: 'integer', required: true }, paired: { type: 'integer', required: true },
                            summary: { type: 'integer', required: true }, ellipsis: { type: 'integer', required: true },
                            dash: { type: 'integer', required: true },
                            hits: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                                term: { type: 'string', required: true }, count: { type: 'integer', required: true },
                            } } },
                        } },
                        structure: { type: 'object', required: true, additionalProperties: false, properties: {
                            score: { type: 'integer', required: true }, paraCount: { type: 'integer', required: true },
                            avgPara: { type: 'integer', required: true }, paraCv: { type: 'number', required: true },
                            sentCv: { type: 'number', required: true },
                        } },
                        dilution: { type: 'object', required: true, additionalProperties: false, properties: {
                            score: { type: 'integer', required: true }, bigramRate: { type: 'number', required: true },
                            dePerSentence: { type: 'number', required: true },
                        } },
                    } },
                },
            },
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            if (typeof args.text === 'string' && args.text.trim() !== '') {
                const scan = scanAiFlavor(args.text, { topK: config.scanTopK });
                return { source: 'text', ...scan };
            }
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            if (!Number.isInteger(args.chapter)) throw new Error('需要 text，或 book+chapter');
            const rec = novel.chapters?.[String(args.chapter)];
            if (rec?.path === undefined) throw new Error(`第${args.chapter}章尚未保存`);
            const content = await io.readText(rec.path);
            if (content === null) throw new Error(`章节文件缺失：${rec.path}`);
            const scan = scanAiFlavor(content, { topK: config.scanTopK });
            return { source: rec.path, ...scan };
        },
        render: (_args, v) => textBlock(
            `去AI味 ${v.level}（${v.score}/100，${v.chars} 字，来源 ${v.source}）\n${v.topIssues.map((s) => `- ${s}`).join('\n') || '- 未检出显著问题'}`
        ),
    });
}
