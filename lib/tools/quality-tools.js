// lib/tools/quality-tools.js — novel_ledger / novel_noai_scan / novel_audit。
// 质检三件套：账本读写（一致性的数据底座）、结构性去 AI 味扫描（纯本地零费用）、
// 确定性章节审计（机审与模型审分离，模型审稿必须引用这里的数字）。

import { defineTool } from './define-tool.js';
import { pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { applyFactUpdates, queryFacts, assertLedgerChapter, foreshadowSetup, foreshadowPayoff } from '../ledger.js';
import { scanAiFlavor } from '../noai.js';
import { measureStyleMetrics, computeBaseline, judgeAgainstBaseline, STYLE_DIMENSIONS } from '../style.js';
import { computeAudit, auditVerdict } from '../audit.js';
import { matchWorldEntries } from '../contextpack.js';
import { audit, requireBook, parseList, parseFactLines, textBlock, foreshadowView } from './common.js';

export function defineLedgerTool(ctx, config) {
    return defineTool({
        name: 'novel_ledger',
        description: '事实账本与伏笔台账：query 查某实体/键的当前值；update 追加状态变化（多行「实体|键|值[|备注]」，同章改值=冲突拒绝）；foreshadow_setup 埋伏笔；foreshadow_payoff 收伏笔。人物境界/物品/地点状态一律走这里——「百万字不崩设定」的底座。',
        parameters: {
            action: { type: 'string', required: true, enum: ['query', 'update', 'foreshadow_setup', 'foreshadow_payoff'], description: '四选一。' },
            book: { type: 'string', required: true, description: '书目名。' },
            entity: { type: 'string', description: 'query：按实体过滤（人物/物品/地点名）。' },
            key: { type: 'string', description: 'query：按键过滤（如 境界/位置/持有）。' },
            since: { type: 'integer', description: 'query：只看第 N 章及以后的变化。' },
            chapter: { type: 'integer', description: 'update / foreshadow_* 必填：发生章号。' },
            updates: { type: 'string', description: 'update 必填：多行「实体|键|值[|备注]」。' },
            setup: { type: 'string', description: 'foreshadow_setup 必填：伏笔描述。' },
            plan: { type: 'integer', description: 'foreshadow_setup 可选：预计回收章号。briefing 会对超期未回收的伏笔告警。' },
            id: { type: 'string', description: 'foreshadow_* 必填：伏笔 id（setup 可省略自动编号）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    addedCount: { type: 'integer', required: true },
                    facts: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        entity: { type: 'string', required: true }, key: { type: 'string', required: true },
                        value: { type: 'string', required: true }, chapter: { type: 'integer', required: true },
                        note: { type: 'string' },
                    } } },
                    foreshadows: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        id: { type: 'string', required: true }, setup: { type: 'string', required: true },
                        chapter: { type: 'integer', required: true }, plan: { type: 'integer' },
                        payoffChapter: { type: 'integer' },
                    } } },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            let facts = (await io.readJson(p.facts)) ?? [];
            let foreshadows = (await io.readJson(p.foreshadows)) ?? [];

            if (args.action === 'query') {
                const rows = queryFacts(facts, {
                    entity: args.entity, key: args.key,
                    sinceChapter: Number.isInteger(args.since) ? args.since : undefined,
                });
                return { book, action: 'query', addedCount: 0, facts: rows.map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, note: f.note ?? '' })), foreshadows: foreshadows.map(foreshadowView) };
            }
            if (args.action === 'update') {
                if (!Number.isInteger(args.chapter)) throw new Error('update 需要正整数 chapter');
                const maxWritten = Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
                assertLedgerChapter(args.chapter, maxWritten);
                const updates = parseFactLines(args.updates);
                if (updates.length === 0) throw new Error('update 需要 updates（多行 实体|键|值[|备注]）');
                const { facts: nextFacts, added, conflicts } = applyFactUpdates(facts, updates, { chapter: args.chapter });
                if (conflicts.length > 0) throw new Error(`账本冲突，未写入：${conflicts.map((c) => c.reason).join('；')}`);
                facts = nextFacts;
                await io.writeJson(p.facts, facts);
                await audit(io, p, 'ledger/update', { chapter: args.chapter, added: added.length });
                return { book, action: 'update', addedCount: added.length, facts: queryFacts(facts, {}).map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, note: f.note ?? '' })), foreshadows: foreshadows.map(foreshadowView) };
            }
            if (args.action === 'foreshadow_setup') {
                if (!Number.isInteger(args.chapter)) throw new Error('foreshadow_setup 需要正整数 chapter');
                const wasExisting = foreshadows.some((f) => f.id === args.id);
                foreshadows = foreshadowSetup(foreshadows, { id: args.id, setup: args.setup, chapter: args.chapter, plan: args.plan });
                await io.writeJson(p.foreshadows, foreshadows);
                await audit(io, p, wasExisting ? 'foreshadow/replan' : 'foreshadow/setup', { chapter: args.chapter, id: args.id ?? 'auto', setup: args.setup });
                return { book, action: 'foreshadow_setup', addedCount: 0, facts: queryFacts(facts, {}).map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, note: f.note ?? '' })), foreshadows: foreshadows.map(foreshadowView) };
            }
            // foreshadow_payoff
            if (!Number.isInteger(args.chapter)) throw new Error('foreshadow_payoff 需要正整数 chapter');
            foreshadows = foreshadowPayoff(foreshadows, args.id, args.chapter);
            await io.writeJson(p.foreshadows, foreshadows);
            await audit(io, p, 'foreshadow/payoff', { chapter: args.chapter, id: args.id });
            return { book, action: 'foreshadow_payoff', addedCount: 0, facts: queryFacts(facts, {}).map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, note: f.note ?? '' })), foreshadows: foreshadows.map(foreshadowView) };
        },
        render: (_args, v) => {
            const open = v.foreshadows.filter((f) => f.payoffChapter == null);
            const lines = v.facts.slice(0, 20).map((f) => `${f.entity}·${f.key}: ${f.value}（第${f.chapter}章起）`);
            return textBlock(`${v.action} 完成（新增 ${v.addedCount}）\n${lines.join('\n')}\n未回收伏笔 ${open.length} 条：${open.map((f) => f.id).join('、') || '无'}`);
        },
    });
}

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

export function defineAuditTool(ctx, config) {
    return defineTool({
        name: 'novel_audit',
        description: '确定性章节审计（机审）：字数/段落/对话占比/章末钩子/与前文重复率（8字shingle Jaccard）/细纲要素覆盖率。数字是证据——模型审稿的结论必须引用这些数字，不许和稀泥。',
        parameters: {
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', required: true, description: '要审计的章号（取最新版本）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    chapter: { type: 'integer', required: true },
                    path: { type: 'string', required: true },
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
                    verdict: { type: 'object', required: true, additionalProperties: false, properties: {
                        ok: { type: 'boolean', required: true },
                        problems: { type: 'array', items: { type: 'string' }, required: true },
                        warnings: { type: 'array', items: { type: 'string' }, required: true },
                    } },
                },
            },
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            if (!Number.isInteger(args.chapter)) throw new Error('chapter 必须是正整数');
            const rec = novel.chapters?.[String(args.chapter)];
            if (rec?.path === undefined) throw new Error(`第${args.chapter}章尚未保存`);
            const content = await io.readText(rec.path);
            if (content === null) throw new Error(`章节文件缺失：${rec.path}`);

            const outline = (await io.readText(p.chapterOutline(args.chapter))) ?? '';
            const entries = (await io.readJson(p.worldbook)) ?? [];
            const worldEntries = matchWorldEntries(entries, [outline, (novel.cast ?? []).join('、')]);
            const terms = [...(novel.cast ?? []), ...worldEntries.flatMap((e) => (e.keywords ?? []))];

            const window = Number.isInteger(config.repetitionWindow) && config.repetitionWindow >= 1 ? config.repetitionWindow : 10;
            const chapterKeys = Object.keys(novel.chapters ?? {}).map(Number).filter((k) => k < args.chapter).sort((a, b) => b - a).slice(0, window);
            const previous = [];
            for (const k of chapterKeys) {
                const rec = novel.chapters[String(k)];
                if (rec?.path === undefined) continue; // 索引记录不完整时跳过，不让审计崩掉
                const text = await io.readText(rec.path);
                if (text !== null) previous.push({ chapter: k, content: text });
            }

            const a = computeAudit({ content, previous, terms });
            const verdict = auditVerdict(a, config);
            return {
                book, chapter: args.chapter, path: rec.path,
                chars: a.chars, paragraphCount: a.paragraphCount, avgParagraphChars: a.avgParagraphChars,
                sentenceCount: a.sentenceCount, dialogueRatio: a.dialogueRatio,
                endingHook: { ...a.endingHook },
                repetition: { ...a.repetition },
                coverage: { terms: a.coverage.terms, missing: a.coverage.missing },
                verdict,
            };
        },
        render: (_args, v) => textBlock(
            `第${v.chapter}章机审（${v.chars} 字）：段 ${v.paragraphCount}·对话占比 ${v.dialogueRatio}·章末钩子 ${v.endingHook.detected ? v.endingHook.kind : '⚠无'}·与前文最大重合 ${v.repetition.jaccard}${v.repetition.chapter != null ? `（第${v.repetition.chapter}章）` : ''}\n`
            + `判定：${v.verdict.ok ? '通过' : '不通过'}${v.verdict.problems.length > 0 ? `\n问题：${v.verdict.problems.join('；')}` : ''}${v.verdict.warnings.length > 0 ? `\n警告：${v.verdict.warnings.join('；')}` : ''}`
        ),
    });
}

export function defineStyleTool(ctx, config) {
    return defineTool({
        name: 'novel_style',
        description: '文笔六维基线（纯本地计算，零模型调用）：build 测全书各章的句法复杂度/修饰密度/抽象度/动作密度/不确定性/留白指数，算出每维 μ±σ 基线带存盘；check 拿某章（或给定 text）对照基线，逐维报带内✓/出带⚠与偏差百分比——把「文风跑偏了」变成可对照的数字。续写/润色前建议先 build 一次、交稿前 check 一次。',
        parameters: {
            action: { type: 'string', required: true, enum: ['build', 'check'], description: 'build=测全书建基线；check=拿某章/某段对照基线。' },
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', description: 'check：要对照的章号（取最新版本）；省略则需给 text。' },
            text: { type: 'string', description: 'check：直接对照的正文（不给 chapter 时用）。' },
            tolerance: { type: 'string', description: 'check：每维容差覆盖，格式「syntax:40 modifier:25」（维 key:百分数），缺省用基线内置（1.5σ）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    action: { type: 'string', required: true },
                    book: { type: 'string', required: true },
                    chapters: { type: 'integer', required: true },
                    path: { type: 'string' },
                    source: { type: 'string' },
                    verdict: { type: 'string' },
                    outCount: { type: 'integer' },
                    dims: { type: 'object', required: true, additionalProperties: true },
                    deviations: { type: 'array', items: { type: 'object', additionalProperties: true } },
                },
            },
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);

            if (args.action === 'build') {
                const chapterKeys = Object.keys(novel.chapters ?? {}).map(Number).filter((k) => novel.chapters[String(k)]?.path !== undefined).sort((a, b) => a - b);
                if (chapterKeys.length === 0) throw new Error(`「${book}」还没有已保存的章节，无从建基线`);
                const metricsList = [];
                for (const k of chapterKeys) {
                    const content = await io.readText(novel.chapters[String(k)].path);
                    if (content === null) continue; // 文件缺失跳过，不让基线崩掉
                    metricsList.push(measureStyleMetrics(content));
                }
                if (metricsList.length === 0) throw new Error(`「${book}」的章节文件全部缺失，无法建基线（可用 novel_project repair 对账）`);
                const baseline = computeBaseline(metricsList);
                const path = p.styleBaseline;
                await io.writeJson(path, { book, chapters: metricsList.length, baseline, builtAt: new Date().toISOString() }, 'replace');
                return { action: 'build', book, chapters: baseline.chapters, path, dims: baseline.dims };
            }

            // check
            const raw = await io.readJson(p.styleBaseline);
            if (raw === null || raw.baseline === undefined) throw new Error(`「${book}」还没有风格基线，先跑 novel_style {action:'build'}`);
            const baseline = raw.baseline;
            const overrides = {};
            if (typeof args.tolerance === 'string' && args.tolerance.trim() !== '') {
                for (const pair of args.tolerance.trim().split(/\s+/)) {
                    const [dim, pct] = pair.split(':');
                    const n = Number(pct);
                    if (STYLE_DIMENSIONS.some((d) => d.key === dim) && n >= 10 && n <= 100) overrides[dim] = Math.round(n);
                }
            }
            let source;
            let metrics;
            if (Number.isInteger(args.chapter)) {
                const rec = novel.chapters?.[String(args.chapter)];
                if (rec?.path === undefined) throw new Error(`第${args.chapter}章尚未保存`);
                const content = await io.readText(rec.path);
                if (content === null) throw new Error(`章节文件缺失：${rec.path}`);
                source = rec.path;
                metrics = measureStyleMetrics(content);
            } else if (typeof args.text === 'string' && args.text.trim() !== '') {
                source = 'text';
                metrics = measureStyleMetrics(args.text);
            } else {
                throw new Error('check 需要 chapter 或 text 二选一');
            }
            const judged = judgeAgainstBaseline(metrics, baseline, overrides);
            return {
                action: 'check', book, chapters: baseline.chapters, source,
                verdict: judged.verdict, outCount: judged.outCount,
                dims: judged.dims, deviations: judged.deviations,
            };
        },
        render: (_args, v) => {
            if (v.action === 'build') {
                const lines = STYLE_DIMENSIONS.map(({ key, label, unit }) => {
                    const d = v.dims[key];
                    return `- ${label}（${unit}）μ=${d.mu} σ=${d.sigma ?? '—'} 容差±${d.tolerance}%`;
                });
                return textBlock(`风格基线已建立：${v.book}，${v.chapters} 章 → ${v.path}\n${lines.join('\n')}`);
            }
            const lines = STYLE_DIMENSIONS.map(({ key, label, unit }) => {
                const d = v.dims[key] ?? {};
                const mark = d.inBand ? '✓' : `⚠ 偏差 ${d.deviationPct > 0 ? '+' : ''}${d.deviationPct}%`;
                return `- ${label}：${d.value}（基线 ${d.mu} ±${d.tolerance}%）${mark}`;
            });
            const verdictText = v.verdict === 'in_band' ? '带内 ✓' : v.verdict === 'minor_drift' ? '轻度漂移' : '明显漂移 ⚠';
            return textBlock(`风格对照（${verdictText}，出带 ${v.outCount}/6）\n${lines.join('\n')}${v.deviations.length > 0 ? `\n最偏维度：${v.deviations.map((d) => `${d.label} ${d.deviationPct > 0 ? '+' : ''}${d.deviationPct}%`).join('、')}` : ''}`);
        },
    });
}
