// lib/tools/writing-tools.js — novel_briefing / novel_write_chapter。
// briefing 组装上下文包（一致性供给侧）；write_chapter 只是**入口**——真正的硬约束链
// （阶段门禁 → 细纲存在性 → 机审 → 账本冲突 → 内容门禁 → 契约指标 → 版本落盘 → 审计）
// 在 lib/chapter-commit.js，与 D2 并发批量起草**共用同一条**，两者不可能漂移。

import { defineTool } from './define-tool.js';
import { pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { requireBook, parseList, parseFactLines, textBlock } from './common.js';
import { commitChapter } from '../chapter-commit.js';
import { buildBriefing } from '../briefing.js';

export function defineBriefingTool(ctx, config) {
    return defineTool({
        name: 'novel_briefing',
        description: '写前简报：为第N章组装上下文包（细纲→出场人物卡→账本摘要→未回收伏笔→命中的世界书条目→上一章结尾→原著锚段→前文摘要→全书大纲，按预算裁剪）。锚段是从最近章节挑的味道样本——模仿其语感节奏，勿抄词句；有基线时附文风指纹。写章前必调；模型「看不见前文」的问题由它兜底。',
        parameters: {
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', required: true, description: '章号。' },
            cast: { type: 'string', description: '本章出场人物（逗号分隔）；省略则用工程 cast 全员。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    chapter: { type: 'integer', required: true },
                    totalChars: { type: 'integer', required: true },
                    dropped: { type: 'array', items: { type: 'string' }, required: true },
                    rendered: { type: 'string', required: true },
                    sections: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        name: { type: 'string', required: true }, content: { type: 'string', required: true },
                    } } },
                    warnings: { type: 'array', items: { type: 'string' }, required: true },
                    voiceCount: { type: 'integer' },
                    contractDigest: { type: 'string' },
                    hiddenCount: { type: 'integer' },
                    droppedCast: { type: 'array', items: { type: 'string' } },
                },
            },
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const { novel } = await requireBook(io, book);
            const n = args.chapter;
            if (!Number.isInteger(n) || n < 1) throw new Error('chapter 必须是正整数');

            // 组装只有一个实现（lib/briefing.js）——批量起草走同一份，保护不会漏在批量路径上
            const brief = await buildBriefing({
                config, io, book, novel, n,
                castNames: args.cast !== undefined ? parseList(args.cast) : null,
            });
            return {
                book, chapter: brief.chapter,
                sections: brief.sections, totalChars: brief.totalChars, dropped: brief.dropped,
                rendered: brief.rendered, warnings: brief.warnings,
                ...(brief.contractDigest === null ? {} : { contractDigest: brief.contractDigest, hiddenCount: brief.hiddenCount }),
                ...(brief.droppedCast.length === 0 ? {} : { droppedCast: brief.droppedCast }),
                voiceCount: brief.voiceCount,
            };
        },
        render: (_args, v) => textBlock(
            `第${v.chapter}章写前简报（${v.totalChars} 字${v.dropped.length > 0 ? `，因预算丢弃：${v.dropped.join('、')}` : ''}）`
            + (v.contractDigest !== undefined ? `\n场景契约：${v.contractDigest}${v.hiddenCount > 0 ? `（隐藏 ${v.hiddenCount} 人·档案未注入、正文也不许出现其名）` : ''}` : '')
            + `\n\n${v.rendered}`
            + (v.warnings.length > 0 ? `\n\n⚠ ${v.warnings.join('\n⚠ ')}` : '')
        ),
    });
}

export function defineWriteChapterTool(ctx, config) {
    return defineTool({
        name: 'novel_write_chapter',
        description: '写整章并落盘（硬约束链）：先 novel_briefing 拿上下文包，再按细纲成稿后调用本工具。**字数标准（网文连载常规）：单章 2000–4000 字、目标 3000 字左右**——简报里「本章字数目标」段为准，不足下限直接退稿，字数不够就把细纲场景写细写透、不要注水。门禁：细纲未批准→拒绝；机审不过（字数上下限/与前文高度重复/要素缺失）→拒绝；账本同章改值冲突→拒绝。通过后版本化保存（永不覆盖旧版）+ 落账 + 审计。**节奏铁律：一次只写一章**——本章落盘后立即停下向用户汇报（本章要点 + 下一章建议），由用户决定是否继续，绝不擅自连写下一章。',
        parameters: {
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', required: true, description: '章号。' },
            title: { type: 'string', required: true, description: '本章标题（进文件名，非法字符自动清洗）。' },
            content: { type: 'string', required: true, description: '本章正文全文（按「落笔即防」规范写干净再交）。' },
            summary: { type: 'string', required: true, description: '本章一句话梗概（进章节索引，供后续写前简报）。' },
            cast: { type: 'string', description: '本章出场人物（逗号分隔），用于覆盖率检查与账本摘要。' },
            facts_updates: { type: 'string', description: '本章状态变化，多行「实体|键|值[|备注]」（如：林晚|境界|筑基三层）。账本冲突会拒绝保存。' },
            force: { type: 'boolean', description: 'true=显式放行未批准细纲（记入审计，慎用）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    chapter: { type: 'integer', required: true },
                    path: { type: 'string', required: true },
                    version: { type: 'integer', required: true },
                    chars: { type: 'integer', required: true },
                    forced: { type: 'boolean', required: true },
                    addedFacts: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        entity: { type: 'string', required: true }, key: { type: 'string', required: true },
                        value: { type: 'string', required: true }, chapter: { type: 'integer', required: true },
                        note: { type: 'string' },
                    } } },
                    audit: { type: 'object', required: true, additionalProperties: false, properties: {
                        chars: { type: 'integer', required: true },
                        paragraphCount: { type: 'integer', required: true },
                        avgParagraphChars: { type: 'integer', required: true },
                        sentenceCount: { type: 'integer', required: true },
                        dialogueRatio: { type: 'number', required: true },
                        endingHook: { type: 'object', required: true, additionalProperties: false, properties: {
                            detected: { type: 'boolean', required: true }, kind: { type: 'string' },
                        } },
                        repetition: { type: 'object', required: true, additionalProperties: false, properties: {
                            chapter: { type: 'integer' }, jaccard: { type: 'number', required: true },
                        } },
                        coverage: { type: 'object', required: true, additionalProperties: false, properties: {
                            terms: { type: 'integer', required: true },
                            missing: { type: 'array', items: { type: 'string' }, required: true },
                        } },
                    } },
                    noai: { type: 'object', required: true, additionalProperties: false, properties: {
                        score: { type: 'integer', required: true }, level: { type: 'string', required: true },
                        topIssues: { type: 'array', items: { type: 'string' }, required: true },
                    } },
                    contentGate: { type: 'object', required: true, additionalProperties: false, properties: {
                        ok: { type: 'boolean', required: true },
                        blocking: { type: 'array', items: { type: 'string' }, required: true },
                        warnings: { type: 'array', items: { type: 'string' }, required: true },
                    } },
                    gate: { type: 'object', additionalProperties: false, properties: {
                        coverage: { type: 'number', required: true },
                        drift: { type: 'number' },
                        missedScenes: { type: 'array', items: { type: 'string' }, required: true },
                        bannedHits: { type: 'array', items: { type: 'string' }, required: true },
                        passed: { type: 'boolean', required: true },
                    } },
                    warnings: { type: 'array', items: { type: 'string' }, required: true },
                    reminders: { type: 'array', items: { type: 'string' }, required: true },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            const n = args.chapter;
            if (!Number.isInteger(n) || n < 1) throw new Error('chapter 必须是正整数');
            if (typeof args.title !== 'string' || args.title.trim() === '') throw new Error('title 不能为空');
            if (typeof args.content !== 'string' || args.content.trim() === '') throw new Error('content 不能为空');
            if (typeof args.summary !== 'string' || args.summary.trim() === '') throw new Error('summary 不能为空（供后续写前简报）');

            // 全部硬约束在 lib/chapter-commit.js —— 与 D2 并发批量起草共用同一条提交链。
            // 这里只做入参校验，然后交给它（阶段门禁/熔断/机审/账本/内容门禁/契约指标/落盘/审计）。
            const committed = await commitChapter({
                config, io, p, book, novel, n,
                title: args.title, content: args.content, summary: args.summary,
                castNames: args.cast !== undefined ? parseList(args.cast) : [],
                updates: parseFactLines(args.facts_updates),
                force: args.force === true,
            });
            return { book, chapter: n, ...committed };
        },
        render: (_args, v) => textBlock(
            `已保存 第${v.chapter}章 v${v.version}（${v.chars} 字）→ ${v.path}${v.forced ? '（⚠ force 放行）' : ''}\n`
            + `机审：段 ${v.audit.paragraphCount}·对话占比 ${v.audit.dialogueRatio}·章末钩子 ${v.audit.endingHook.detected ? v.audit.endingHook.kind : '无'}·与前文最大重合 ${v.audit.repetition.jaccard}\n`
            + `去AI味：${v.noai.level}（${v.noai.score}/100）${v.noai.topIssues.length > 0 ? `\n  - ${v.noai.topIssues.join('\n  - ')}` : ''}\n`
            + `内容门禁：${v.contentGate.ok ? '通过 ✓' : '⚠ 有阻断项（force 放行）'}\n`
            + (v.warnings.length > 0 ? `警告：${v.warnings.join('；')}\n` : '')
            + `账本落账 ${v.addedFacts.length} 条`
        ),
    });
}
