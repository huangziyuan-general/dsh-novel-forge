// lib/tools/review-tools.js — novel_diagnose / novel_polish。
// 评审侧工具：黄金三章确定性诊断；段落级润色病灶定位 +「润色也走提案制」提交。

import { defineTool } from './define-tool.js';
import { pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { audit, requireBook, saveBook, textBlock } from './common.js';
import { diagnoseIntro } from '../diagnose.js';
import { analyzeParagraphs, validatePolishEdits } from '../polish.js';
import { computeAudit, auditVerdict } from '../audit.js';

export function defineDiagnoseTool(ctx, config) {
    return defineTool({
        name: 'novel_diagnose',
        description: '黄金三章确定性诊断：逐章输出 钩子/开场/冲突/信息灌输 四维数字（0-100）与可操作建议，总评给一句结论。审阅者拿数字做判断，不是模型口味。',
        parameters: {
            book: { type: 'string', required: true, description: '书目名。' },
            chapters: { type: 'integer', description: '要诊断的章节数（默认取前 3 章的上限）。' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true }, action: { type: 'string', required: true },
                    overall: { type: 'string', required: true },
                    perChapter: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        chapter: { type: 'integer', required: true }, title: { type: 'string', required: true },
                        hook: { type: 'integer', required: true }, opening: { type: 'integer', required: true },
                        conflict: { type: 'integer', required: true }, infodump: { type: 'integer', required: true },
                    } } },
                    issues: { type: 'array', items: { type: 'string' }, required: true },
                },
            },
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            const limit = Number.isInteger(args.chapters) && args.chapters >= 1 ? args.chapters : 3;
            const keys = Object.keys(novel.chapters ?? {}).map(Number).filter((k) => k >= 1).sort((a, b) => a - b).slice(0, limit);
            const chapters = [];
            for (const k of keys) {
                const rec = novel.chapters[String(k)];
                if (rec?.path === undefined) continue;
                const content = await io.readText(rec.path);
                if (content !== null) chapters.push({ chapter: k, title: rec.title, content });
            }
            const outline = (await io.readText(p.bookOutline)) ?? '';
            const d = diagnoseIntro({ chapters, outline, logline: novel.logline ?? '' });
            return { book, action: 'diagnose', overall: d.overall, perChapter: d.perChapter, issues: d.issues };
        },
        render: (_args, v) => textBlock(
            `黄金三章诊断 —— ${v.overall}\n${v.perChapter.map((c) =>
                `第${c.chapter}章《${c.title}》：钩子 ${c.hook} 开场 ${c.opening} 冲突 ${c.conflict} 灌输 ${c.infodump}`).join('\n')}\n`
            + (v.issues.length ? `\n建议：\n${v.issues.map((s) => `- ${s}`).join('\n')}` : '')
        ),
    });
}

export function definePolishTool(ctx, config) {
    return defineTool({
        name: 'novel_polish',
        description: '润色定位 + 提交：analyze 返回本章段落级病灶（AI 味/长段/灌输腔/章末钩子）；submit 把模型改好的整章文本作为「润色提案」提交（走提案制、用户确认才 apply 新版本，永不覆盖旧版）。**保守编辑守卫**：提交前逐条对照原稿——改标题、引入高危易混字直接拒绝；整章大幅膨胀/大面积重写只警告不拦（是重写还是润色由用户看警告决定）。',
        parameters: {
            action: { type: 'string', required: true, enum: ['analyze', 'submit'], description: 'analyze 定位病灶；submit 提交润色提案。' },
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', required: true, description: '章号。' },
            content: { type: 'string', description: 'submit 必填：润色后的整章文本。' },
            reason: { type: 'string', description: 'submit：润色说明（进审计/提案）。' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true }, action: { type: 'string', required: true }, chapter: { type: 'integer', required: true },
                    chapterHook: { type: 'string' },
                    id: { type: 'string' }, status: { type: 'string' }, previous_version: { type: 'integer' },
                    risks: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        severity: { type: 'string', required: true }, code: { type: 'string', required: true }, message: { type: 'string', required: true },
                    } } },
                    paragraphs: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        paragraph: { type: 'integer', required: true }, chars: { type: 'integer', required: true },
                        aiScore: { type: 'integer', required: true }, issues: { type: 'array', items: { type: 'string' }, required: true },
                    } } },
                    next: { type: 'string' },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            if (!Number.isInteger(args.chapter) || args.chapter < 1) throw new Error('chapter 必须是正整数');
            const rec = novel.chapters?.[String(args.chapter)];
            if (rec?.path === undefined) throw new Error(`第${args.chapter}章尚未保存`);

            if (args.action === 'analyze') {
                const content = await io.readText(rec.path);
                if (content === null) throw new Error(`章节文件缺失：${rec.path}`);
                const a = analyzeParagraphs(content, { top: Math.max(1, config.scanTopK) });
                return {
                    book, action: 'analyze', chapter: args.chapter,
                    // 无钩子时省略 chapterHook 键——null 会被宿主判 INVALID_TOOL_OUTPUT
                    ...(a.chapterHook !== null ? { chapterHook: a.chapterHook } : {}),
                    paragraphs: a.paragraphs,
                    next: `${a.paragraphs.length} 处病灶——让模型针对这些改写全章，再 novel_polish submit 提交润色提案`,
                };
            }

            // submit —— 润色也走提案制（复用 propose 的 id/status 约定）
            if (!args.content || String(args.content).trim() === '') throw new Error('submit 需要 content（润色后的整章文本）');
            const content = String(args.content).trim();
            const chars = content.replace(/\s/g, '').length;
            if (chars < config.minChapterChars) throw new Error(`润色稿 ${chars} 字低于下限 ${config.minChapterChars}，未提交`);

            // 保守编辑守卫（autoproof 保守三原则）：防「校对改出新错」——改标题/引入易混字直接拒绝
            const original = (await io.readText(rec.path)) ?? '';
            const guard = validatePolishEdits(original, content);
            if (!guard.ok) {
                await audit(io, p, 'polish/rejected', { chapter: args.chapter, blocking: guard.blocking.map((r) => r.code) });
                throw new Error(`润色稿被保守编辑守卫拦下，未提交：${guard.blocking.map((r) => r.message).join('；')}`);
            }

            // 机审：字数上限 + 重复率（与 write_chapter 同一标准）
            if (chars > config.maxChapterChars) throw new Error(`润色稿 ${chars} 字超过上限 ${config.maxChapterChars}，未提交`);
            const window = Number.isInteger(config.repetitionWindow) && config.repetitionWindow >= 1 ? config.repetitionWindow : 10;
            const chapterKeys = Object.keys(novel.chapters ?? {}).map(Number).filter((k) => k < args.chapter).sort((a, b) => b - a).slice(0, window);
            const previous = [];
            for (const k of chapterKeys) {
                const rec = novel.chapters[String(k)];
                if (rec?.path === undefined) continue;
                const text = await io.readText(rec.path);
                if (text !== null) previous.push({ chapter: k, content: text });
            }
            const auditResult = computeAudit({ content, previous, terms: [] });
            const verdict = auditVerdict(auditResult, config);
            if (!verdict.ok) {
                throw new Error(`润色稿机审未通过：${verdict.problems.join('；')}`);
            }
            const id = `P${args.chapter}-${Date.now().toString(36)}`;
            const proposal = {
                id, book, chapter: args.chapter, reason: args.reason ?? 'polish',
                status: 'pending', createdAt: new Date().toISOString(), content,
            };
            await io.writeJson(p.proposal(id), proposal, 'create');
            novel.proposals = novel.proposals ?? [];
            novel.proposals.push({ id, chapter: args.chapter, status: 'pending', createdAt: proposal.createdAt });
            await saveBook(io, p, novel);
            await audit(io, p, 'polish/submit', { id, chapter: args.chapter, chars, warnings: guard.warnings.map((w) => w.code) });
            return {
                book, action: 'submit', chapter: args.chapter, id, status: 'pending', previous_version: rec.latest,
                ...(guard.warnings.length > 0 ? { risks: guard.warnings.map((w) => ({ severity: w.severity, code: w.code, message: w.message })) } : {}),
                next: `润色提案 ${id} 已登记——用户确认后应用提案生成 v${rec.latest + 1}${guard.warnings.length > 0 ? '（先看上面的保守性警告）' : ''}`,
            };
        },
        render: (_args, v) => textBlock(
            v.action === 'analyze'
                ? `第${v.chapter}章 段落级病灶 ${v.paragraphs.length} 处（章末钩子：${v.chapterHook ?? '无'}）\n${v.paragraphs.map((q) => `- ¶${q.paragraph}（${q.chars}字，AI味${q.aiScore}）：${q.issues.join('；')}`).join('\n')}`
                : `已提交润色提案 ${v.id}（v${v.previous_version} → 待应用成 v${v.previous_version + 1}），走提案制不改原稿`
                    + (v.risks !== undefined && v.risks.length > 0 ? `\n\n保守性警告（不拦，但你该看一眼）：\n${v.risks.map((r) => `⚠ ${r.message}`).join('\n')}` : '')
        ),
    });
}