// lib/tools/writing-tools.js — novel_briefing / novel_write_chapter。
// 写作主链路：briefing 组装上下文包（一致性供给侧）；write_chapter 是全插件
// 硬约束最集中的地方——阶段门禁 → 细纲存在性 → 机审判定（字数/重复/覆盖）
// → 账本冲突检查 → 版本化落盘 → 审计，任何一环不过就是 throw。

import { defineTool } from '@deepseek-ai/dsh-tools';
import { pathsFor, chapterRecord } from '../store.js';
import { nextVersion } from '../versioning.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { gateChapterWrite, advanceStage } from '../gate.js';
import { buildContextPack, matchWorldEntries, renderPack } from '../contextpack.js';
import { applyFactUpdates, factsDigest, assertLedgerChapter, foreshadowDigest, overdueForeshadows } from '../ledger.js';
import { termsDigest } from '../glossary.js';
import { scanAiFlavor } from '../noai.js';
import { computeAudit, auditVerdict } from '../audit.js';
import { audit, requireBook, saveBook, parseList, parseFactLines, textBlock } from './common.js';

export function defineBriefingTool(ctx, config) {
    return defineTool({
        name: 'novel_briefing',
        description: '写前简报：为第N章组装上下文包（细纲→出场人物卡→账本摘要→未回收伏笔→命中的世界书条目→上一章结尾→前文摘要→全书大纲，按预算裁剪）。写章前必调；模型「看不见前文」的问题由它兜底。',
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
                },
            },
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            const n = args.chapter;
            if (!Number.isInteger(n) || n < 1) throw new Error('chapter 必须是正整数');

            const warnings = [];
            const chapterOutline = (await io.readText(p.chapterOutline(n))) ?? '';
            if (chapterOutline === '') warnings.push(`第${n}章细纲不存在——写章会被门禁拦下，先 novel_outline save_chapter`);
            const bookOutline = (await io.readText(p.bookOutline)) ?? '';
            if (bookOutline === '') warnings.push('全书大纲不存在（novel_outline save_book）');

            const castNames = args.cast !== undefined ? parseList(args.cast) : (novel.cast ?? []).slice(0, 8);
            if (castNames.length === 0) warnings.push('未指定出场人物且工程 cast 为空——人物卡不会被注入');
            const castCards = [];
            for (const name of castNames) {
                const card = await io.readText(p.character(name));
                if (card === null) warnings.push(`人物卡缺失：${name}（novel_character save）——该人物将以无卡状态写章`);
                else castCards.push({ name, card });
            }

            const entries = (await io.readJson(p.worldbook)) ?? [];
            const worldEntries = matchWorldEntries(entries, [chapterOutline, castNames.join('、'), novel.logline ?? '']);
            const facts = (await io.readJson(p.facts)) ?? [];
            const glossaries = (await io.readJson(p.glossary)) ?? [];
            const foreshadows = (await io.readJson(p.foreshadows)) ?? [];

            const prev = novel.chapters?.[String(n - 1)];
            let prevTail = '';
            if (prev?.path !== undefined) {
                const prevText = await io.readText(prev.path);
                if (prevText !== null) prevTail = prevText.trimEnd().slice(-600);
            } else if (n > 1) {
                warnings.push(`第${n - 1}章尚未写——没有上一章结尾可衔接`);
            }
            const summaries = Object.entries(novel.chapters ?? {})
                .filter(([k]) => Number(k) < n)
                .sort(([a], [b]) => Number(a) - Number(b))
                .map(([k, c]) => `第${k}章《${c.title}》：${c.summary ?? ''}`);

            const overdue = overdueForeshadows(foreshadows, n);
            if (overdue.length > 0) {
                warnings.push(`伏笔超期未回收：${overdue.map((f) => `${f.id}（预计第${f.plan}章收，第${f.chapter}章埋）`).join('、')}——考虑本章或近期回收，别让读者忘了`);
            }

            const pack = buildContextPack({
                chapter: n,
                chapterOutline,
                bookOutline,
                castCards,
                worldEntries,
                factsDigest: factsDigest(facts, castNames),
                glossaryDigest: termsDigest(glossaries, 40),
                foreshadowDigest: foreshadowDigest(foreshadows, 8, n),
                prevTail,
                summaries,
                budget: config.contextBudgetChars,
            });
            return {
                book, chapter: n,
                sections: pack.sections, totalChars: pack.totalChars, dropped: pack.dropped,
                rendered: renderPack(pack), warnings,
            };
        },
        render: (_args, v) => textBlock(
            `第${v.chapter}章写前简报（${v.totalChars} 字${v.dropped.length > 0 ? `，因预算丢弃：${v.dropped.join('、')}` : ''}）\n\n${v.rendered}`
            + (v.warnings.length > 0 ? `\n\n⚠ ${v.warnings.join('\n⚠ ')}` : '')
        ),
    });
}

export function defineWriteChapterTool(ctx, config) {
    return defineTool({
        name: 'novel_write_chapter',
        description: '写整章并落盘（硬约束链）：先 novel_briefing 拿上下文包，再按细纲成稿后调用本工具。门禁：细纲未批准→拒绝；机审不过（字数上下限/与前文高度重复/要素缺失）→拒绝；账本同章改值冲突→拒绝。通过后版本化保存（永不覆盖旧版）+ 落账 + 审计。',
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

            // ① 阶段门禁（代码强制）
            const gate = gateChapterWrite(novel, n, { force: args.force === true });
            if (!gate.ok) throw new Error(gate.reason);

            // ② 细纲存在性（批准了但文件被删也算异常）
            const outline = await io.readText(p.chapterOutline(n));
            if (outline === null && !gate.forced) throw new Error(`第${n}章细纲文件缺失（novel.json 标记已批准但文件不在）——请重新 save_chapter`);

            // ③ 覆盖率要素与重复检测基线
            const castNames = args.cast !== undefined ? parseList(args.cast) : [];
            const entries = (await io.readJson(p.worldbook)) ?? [];
            const worldEntries = matchWorldEntries(entries, [outline ?? '', castNames.join('、')]);
            const terms = [...castNames, ...worldEntries.flatMap((e) => (e.keywords ?? []))];

            const window = Number.isInteger(config.repetitionWindow) && config.repetitionWindow >= 1 ? config.repetitionWindow : 10;
            const chapterKeys = Object.keys(novel.chapters ?? {}).map(Number).filter((k) => k < n).sort((a, b) => b - a).slice(0, window);
            const previous = [];
            for (const k of chapterKeys) {
                const rec = novel.chapters[String(k)];
                if (rec?.path === undefined) continue;
                const text = await io.readText(rec.path);
                if (text !== null) previous.push({ chapter: k, content: text });
            }

            // ④ 机审判定（确定性指标，不是模型口味）
            const auditResult = computeAudit({ content: args.content, previous, terms });
            const verdict = auditVerdict(auditResult, config);
            if (!verdict.ok) {
                await audit(io, p, 'write_chapter/rejected', { chapter: n, problems: verdict.problems });
                throw new Error(`机审未通过，未保存：${verdict.problems.join('；')}`);
            }

            // ⑤ 账本：同章改值冲突 → 拒绝保存；章号超前（force 场景）也拒
            const updates = parseFactLines(args.facts_updates);
            const facts = (await io.readJson(p.facts)) ?? [];
            if (updates.length > 0) {
                const maxWritten = Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
                assertLedgerChapter(n, maxWritten);
            }
            const { facts: nextFacts, added, conflicts } = applyFactUpdates(facts, updates, { chapter: n });
            if (conflicts.length > 0) {
                await audit(io, p, 'write_chapter/rejected', { chapter: n, conflicts });
                throw new Error(`账本冲突，未保存：${conflicts.map((c) => c.reason).join('；')}`);
            }

            // ⑥ 版本化落盘（永不覆盖旧版）——版本号统一走 versioning.nextVersion
            const names = (novel.chapters?.[String(n)]?.files ?? []).map((f) => f.file.split('/').pop() ?? '');
            const version = nextVersion(names, n);
            const rel = p.chapterFile(n, args.title, version);
            await io.writeText(rel, `${args.content.trimEnd()}\n`, 'create');

            // ⑦ 索引 + 账本持久化 + 审计
            if (nextFacts.length > 0) await io.writeJson(p.facts, nextFacts);
            const record = chapterRecord(novel.chapters?.[String(n)], {
                title: args.title.trim(), version, file: rel, chars: auditResult.chars, summary: args.summary.trim(),
            });
            novel.chapters[String(n)] = record;
            advanceStage(novel, 'drafting');
            await saveBook(io, p, novel);

            // 去 AI 味只扫一次，审计日志与返回值复用同一结果
            const noai = scanAiFlavor(args.content, { topK: config.scanTopK });
            await audit(io, p, 'write_chapter/saved', {
                chapter: n, version, file: rel, chars: auditResult.chars, forced: gate.forced,
                noaiScore: noai.score,
            });

            return {
                book, chapter: n, path: rel, version, chars: auditResult.chars, forced: gate.forced,
                addedFacts: added.map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, note: f.note ?? '' })),
                audit: {
                    chars: auditResult.chars, paragraphCount: auditResult.paragraphCount,
                    avgParagraphChars: auditResult.avgParagraphChars, sentenceCount: auditResult.sentenceCount,
                    dialogueRatio: auditResult.dialogueRatio,
                    endingHook: { ...auditResult.endingHook },
                    repetition: { ...auditResult.repetition },
                    coverage: { terms: auditResult.coverage.terms, missing: auditResult.coverage.missing },
                },
                noai: { score: noai.score, level: noai.level, topIssues: noai.topIssues },
                warnings: verdict.warnings,
                reminders: [
                    '章末修订走 novel_propose（提案制，不直接覆盖已存版本）',
                    '新设定及时 novel_worldbook add 固化',
                    `下一章从 novel_outline save_chapter（第${n + 1}章）开始`,
                ],
            };
        },
        render: (_args, v) => textBlock(
            `已保存 第${v.chapter}章 v${v.version}（${v.chars} 字）→ ${v.path}${v.forced ? '（⚠ force 放行）' : ''}\n`
            + `机审：段 ${v.audit.paragraphCount}·对话占比 ${v.audit.dialogueRatio}·章末钩子 ${v.audit.endingHook.detected ? v.audit.endingHook.kind : '无'}·与前文最大重合 ${v.audit.repetition.jaccard}\n`
            + `去AI味：${v.noai.level}（${v.noai.score}/100）${v.noai.topIssues.length > 0 ? `\n  - ${v.noai.topIssues.join('\n  - ')}` : ''}\n`
            + (v.warnings.length > 0 ? `警告：${v.warnings.join('；')}\n` : '')
            + `账本落账 ${v.addedFacts.length} 条`
        ),
    });
}
