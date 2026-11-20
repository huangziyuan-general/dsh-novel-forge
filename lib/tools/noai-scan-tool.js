// lib/tools/noai-scan-tool.js — novel_noai_scan（结构性去 AI 味扫描）。
// 从 quality-tools.js 按工具拆出；schema 与描述原样保留。

import { defineTool } from './define-tool.js';
import { pathsFor, chapterRelPath } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { scanAiFlavor, scanNoaiPhrases } from '../noai.js';
import { countCornerQuotes } from '../punctuation.js';
import { requireBook, textBlock } from './common.js';

export function defineNoaiScanTool(ctx, config) {
    return defineTool({
        name: 'novel_noai_scan',
        description: '结构性去 AI 味扫描（纯本地计算，零模型调用）：八维判定——模板句/库存词密度/情绪直写/句式模板与标点滥用/段落节奏方差/信息稀释/断章公式/AI 默认值词；另附句式腔调判据（微动作补语/音量反差腔/否定排比/预告式收尾，report-only，不进八维分）。给 text 直接扫；给 book+chapter 扫该书该章最新版本并自动应用本书文风白名单（novel_style whitelist）。审稿前必跑。',
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
                    // 句式腔调判据（report-only，不进八维 score）：只出证据与计数，是否改由作者定。
                    phrases: { type: 'object', required: true, additionalProperties: false, properties: {
                        counts: { type: 'object', required: true, additionalProperties: false, properties: {
                            microTic: { type: 'integer', required: true },
                            voiceContrast: { type: 'integer', required: true },
                            negationPair: { type: 'integer', required: true },
                            trailerEnding: { type: 'integer', required: true },
                        } },
                        issues: { type: 'array', items: { type: 'string' }, required: true },
                        narrationChars: { type: 'integer', required: true },
                    } },
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
                        formula: { type: 'object', required: true, additionalProperties: false, properties: {
                            score: { type: 'integer', required: true }, endFormula: { type: 'boolean', required: true },
                            exclaimShort: { type: 'integer', required: true }, exclaimRatio: { type: 'number', required: true },
                        } },
                        // defaultword（1.0.2 第八维）：与 stock 同形——按千字密度计，hits 带 per1k。
                        // schema 必须与 scanAiFlavor 的 categories 逐键对齐：宿主对工具输出做
                        // lossless 严格校验，多一个键（defaultword 在返回里）整次调用 INVALID_TOOL_OUTPUT。
                        defaultword: { type: 'object', required: true, additionalProperties: false, properties: {
                            score: { type: 'integer', required: true }, total: { type: 'integer', required: true },
                            hits: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                                term: { type: 'string', required: true }, count: { type: 'integer', required: true },
                                per1k: { type: 'number', required: true },
                            } } },
                        } },
                    } },
                },
            },
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            // 直角引号检测（GB/T 15834—2011）：并入 topIssues 展示，不改八维 score 口径。
            // 写章/提案链落盘时已自动转换，这里扫的是「还没进链的裸文本」与存量旧稿。
            // 句式腔调判据（scanNoaiPhrases）独立于八维 score：只出证据与计数，
            // 是否改由作者定（与 noai/cross-check「证据不是判决」同一档，不进加权）。
            const withQuoteNote = (source, scan, raw, phrases) => {
                const corners = countCornerQuotes(raw);
                return {
                    source,
                    ...scan,
                    phrases,
                    topIssues: corners > 0
                        ? [`直角引号 ${corners} 处——横排文稿国标引号为弯引号“”‘’，落盘/应用时会自动转换（下笔请直接写弯引号）`, ...scan.topIssues]
                        : scan.topIssues,
                };
            };
            if (typeof args.text === 'string' && args.text.trim() !== '') {
                // 裸文本：无书内白名单可套（白名单按书隔离），句式判据照跑但不掩码
                const phrases = scanNoaiPhrases(args.text, {});
                return withQuoteNote('text', scanAiFlavor(args.text, { topK: config.scanTopK }), args.text, phrases);
            }
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            if (!Number.isInteger(args.chapter)) throw new Error('需要 text，或 book+chapter');
            // 本书文风白名单（机器状态 JSON；读不到/读坏按空——掩码是加分项，坏了不阻断扫描）
            let whitelist = [];
            try { whitelist = (await io.readJson(p.styleWhitelist)) ?? []; } catch { whitelist = []; }
            if (!Array.isArray(whitelist)) whitelist = [];
            const rec = novel.chapters?.[String(args.chapter)];
            if (rec?.path === undefined) throw new Error(`第${args.chapter}章尚未保存`);
            // 路径收口（跟进项①）：越书路径不读。
            const rel = chapterRelPath(rec, book);
            if (rel === null) throw new Error(`章节路径越出书目录（索引可能被污染，先 novel_project repair 对账）：${String(rec.path).slice(0, 80)}`);
            const content = await io.readText(rel);
            if (content === null) throw new Error(`章节文件缺失：${rel}`);
            const phrases = scanNoaiPhrases(content, { whitelist });
            return withQuoteNote(rel, scanAiFlavor(content, { topK: config.scanTopK, whitelist }), content, phrases);
        },
        render: (_args, v) => {
            const lines = [`去AI味 ${v.level}（${v.score}/100，${v.chars} 字，来源 ${v.source}）`];
            if (v.topIssues.length > 0) lines.push(...v.topIssues.map((s) => `- ${s}`));
            else lines.push('- 未检出显著问题');
            // 句式腔调判据（report-only）：命中才展开，不挤八维证据面
            if (v.phrases && v.phrases.issues.length > 0) {
                lines.push('句式腔调：');
                lines.push(...v.phrases.issues.map((s) => `- ${s}`));
            }
            return textBlock(lines.join('\n'));
        },
    });
}
