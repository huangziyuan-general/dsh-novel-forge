// lib/tools/quality-tools.js — novel_ledger / novel_noai_scan / novel_audit。
// 质检三件套：账本读写（一致性的数据底座）、结构性去 AI 味扫描（纯本地零费用）、
// 确定性章节审计（机审与模型审分离，模型审稿必须引用这里的数字）。

import { defineTool } from './define-tool.js';
import { pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { applyFactUpdates, queryFacts, assertLedgerChapter, factsAt, statusTimeline, foreshadowSetup, foreshadowPayoff } from '../ledger.js';
import { scanAiFlavor } from '../noai.js';
import { measureStyleMetrics, measureMood, moodLabel, computeBaseline, judgeAgainstBaseline, STYLE_DIMENSIONS, MOOD_AXES } from '../style.js';
import { computeAudit, auditVerdict } from '../audit.js';
import { validateContinuity } from '../continuity.js';
import { loadContinuityInputs } from '../continuity-io.js';
import { computeGateMetrics } from '../gate-metrics.js';
import { reviewForPlatform, PLATFORM_IDS } from '../platform-review.js';
import { scanSensitive } from '../censor.js';
import { normalizeVoice, isEmptyVoice, voiceConsistency } from '../voice.js';
import { matchWorldEntries } from '../contextpack.js';
import { audit, requireBook, parseList, parseFactLines, textBlock, foreshadowView } from './common.js';

export function defineLedgerTool(ctx, config) {
    return defineTool({
        name: 'novel_ledger',
        description: '事实账本与伏笔台账：query 查某实体/键的**当前值**；status_at 查**第 n 章时**的值（时点推演——写新章要回溯旧状态、核对「第 40 章断腿第 50 章还能跑」时用它，不能拿最新值糊）；timeline 看某实体的状态演化线（对账「这个值是哪一章改的」）；update 追加状态变化（多行「实体|键|值[|备注]」，同章改值=冲突拒绝）；foreshadow_setup 埋伏笔；foreshadow_payoff 收伏笔。人物境界/物品/地点状态一律走这里——「百万字不崩设定」的底座。',
        parameters: {
            action: { type: 'string', required: true, enum: ['query', 'status_at', 'timeline', 'update', 'foreshadow_setup', 'foreshadow_payoff'], description: '六选一。' },
            book: { type: 'string', required: true, description: '书目名。' },
            entity: { type: 'string', description: 'query / status_at：按实体过滤（人物/物品/地点名，可多个用「、」分隔）；timeline：必填，要推演的实体。' },
            key: { type: 'string', description: 'query / status_at / timeline：按键过滤（如 境界/位置/持有）。' },
            since: { type: 'integer', description: 'query：只看第 N 章及以后的变化。' },
            at: { type: 'integer', description: 'status_at 必填：时点章号——第 n 章时各实体/键是什么值（含第 n 章）。' },
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
                    timeline: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        chapter: { type: 'integer', required: true }, key: { type: 'string', required: true },
                        value: { type: 'string', required: true }, note: { type: 'string' },
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
                // 实体支持「、」多值（与 status_at 的 parseList 对齐；0.13.6 修正——
                // 工具描述承诺了多实体，实现却把整串当单实体名过滤）
                const entities = parseList(args.entity);
                const base = { key: args.key, sinceChapter: Number.isInteger(args.since) ? args.since : undefined };
                const rows = entities.length === 0
                    ? queryFacts(facts, base)
                    : entities.flatMap((e) => queryFacts(facts, { ...base, entity: e }));
                return { book, action: 'query', addedCount: 0, facts: rows.map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, note: f.note ?? '' })), foreshadows: foreshadows.map(foreshadowView), timeline: [] };
            }
            if (args.action === 'status_at') {
                if (!Number.isInteger(args.at)) throw new Error('status_at 需要正整数 at（时点章号）');
                const rows = factsAt(facts, args.at, { entities: parseList(args.entity), keys: parseList(args.key) });
                return { book, action: 'status_at', addedCount: 0, facts: rows, foreshadows: foreshadows.map(foreshadowView), timeline: [] };
            }
            if (args.action === 'timeline') {
                if (typeof args.entity !== 'string' || args.entity.trim() === '') throw new Error('timeline 需要 entity（要推演的实体名）');
                const rows = statusTimeline(facts, args.entity.trim(), { keys: parseList(args.key) });
                return { book, action: 'timeline', addedCount: 0, facts: [], foreshadows: foreshadows.map(foreshadowView), timeline: rows };
            }
            if (args.action === 'update') {
                if (!Number.isInteger(args.chapter)) throw new Error('update 需要正整数 chapter');
                const maxWritten = Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
                assertLedgerChapter(args.chapter, maxWritten);
                const updates = parseFactLines(args.updates);
                if (updates.length === 0) throw new Error('update 需要 updates（多行 实体|键|值[|备注]）');
                const { facts: nextFacts, added, conflicts } = applyFactUpdates(facts, updates, { chapter: args.chapter, now: new Date().toISOString() });
                if (conflicts.length > 0) throw new Error(`账本冲突，未写入：${conflicts.map((c) => c.reason).join('；')}`);
                facts = nextFacts;
                await io.writeJson(p.facts, facts);
                await audit(io, p, 'ledger/update', { chapter: args.chapter, added: added.length });
                return { book, action: 'update', addedCount: added.length, facts: queryFacts(facts, {}).map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, note: f.note ?? '' })), foreshadows: foreshadows.map(foreshadowView), timeline: [] };
            }
            if (args.action === 'foreshadow_setup') {
                if (!Number.isInteger(args.chapter)) throw new Error('foreshadow_setup 需要正整数 chapter');
                const wasExisting = foreshadows.some((f) => f.id === args.id);
                foreshadows = foreshadowSetup(foreshadows, { id: args.id, setup: args.setup, chapter: args.chapter, plan: args.plan });
                await io.writeJson(p.foreshadows, foreshadows);
                await audit(io, p, wasExisting ? 'foreshadow/replan' : 'foreshadow/setup', { chapter: args.chapter, id: args.id ?? 'auto', setup: args.setup });
                return { book, action: 'foreshadow_setup', addedCount: 0, facts: queryFacts(facts, {}).map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, note: f.note ?? '' })), foreshadows: foreshadows.map(foreshadowView), timeline: [] };
            }
            // foreshadow_payoff
            if (!Number.isInteger(args.chapter)) throw new Error('foreshadow_payoff 需要正整数 chapter');
            foreshadows = foreshadowPayoff(foreshadows, args.id, args.chapter);
            await io.writeJson(p.foreshadows, foreshadows);
            await audit(io, p, 'foreshadow/payoff', { chapter: args.chapter, id: args.id });
            return { book, action: 'foreshadow_payoff', addedCount: 0, facts: queryFacts(facts, {}).map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, note: f.note ?? '' })), foreshadows: foreshadows.map(foreshadowView), timeline: [] };
        },
        render: (args, v) => {
            const open = v.foreshadows.filter((f) => f.payoffChapter == null);
            if (v.action === 'timeline') {
                const rows = v.timeline.map((r) => `第${r.chapter}章  ${r.key}: ${r.value}${r.note ? `（${r.note}）` : ''}`);
                return textBlock(`「${args.entity}」状态演化线 ${v.timeline.length} 步：\n${rows.join('\n') || '（该实体暂无账本记录）'}`);
            }
            const head = v.action === 'status_at'
                ? `第${args.at}章时点快照：${v.facts.length} 项`
                : `${v.action} 完成（新增 ${v.addedCount}）`;
            const lines = v.facts.slice(0, 20).map((f) => `${f.entity}·${f.key}: ${f.value}（第${f.chapter}章起）`);
            return textBlock(`${head}\n${lines.join('\n')}\n未回收伏笔 ${open.length} 条：${open.map((f) => f.id).join('、') || '无'}`);
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
        description: '确定性章节审计（机审）：字数/段落/对话占比/章末钩子/与前文重复率（8字shingle Jaccard）/细纲要素覆盖率。'
            + '**契约指标**（细纲写了「本章必写场景」「本章禁止偏离项」段时）：场景覆盖率/偏离度/漏写场景/命中禁项——代码算，零 token。'
            + '数字是证据——模型审稿的结论必须引用这些数字，不许和稀泥。'
            + 'continuity:true 附带全书一致性校验（死人复活/伏笔倒挂/索引缺失）；voice:true 附带语言基因卡核对（角色说了禁忌词 / 有台词却无一句口头禅）。'
            + 'platform 附带平台审稿（qidian 起点吃长线结构与章末钩子 / fanqie 番茄吃前千字爽点与完读率）；censor:true 附带敏感自查（涉政/色情擦边/未成年/赌博毒品/暴力/封建迷信/现实机构影射七类，发书前必跑）。',
        parameters: {
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', required: true, description: '要审计的章号（取最新版本）。' },
            continuity: { type: 'boolean', description: 'true=额外跑全书一致性校验（跨章节硬伤：死人复活/伏笔倒挂/索引缺失）。改稿与收尾前建议开。' },
            voice: { type: 'boolean', description: 'true=额外核对语言基因卡：角色说了自己声明过的禁忌词（硬伤）、有台词却没有一句口头禅（提示）。' },
            platform: { type: 'string', description: '平台审稿：qidian（起点）或 fanqie（番茄）。同一章在两家口味不同——起点看结构与章末钩子，番茄看前 1000 字爽点与完读率。' },
            censor: { type: 'boolean', description: 'true=跑敏感自查七类（涉政/色情擦边/未成年红线/赌博毒品/暴力血腥/封建迷信/现实机构影射）。发布前必跑；玄幻等题材可用 exempt 豁免封建迷信类。' },
            exempt: { type: 'string', description: 'censor 的豁免分类，逗号分隔（如「feudal」跳过封建迷信词）。' },
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
                    continuityResult: { type: 'object', additionalProperties: false, properties: {
                        ok: { type: 'boolean', required: true },
                        errors: { type: 'integer', required: true },
                        warnings: { type: 'integer', required: true },
                        issues: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                            severity: { type: 'string', required: true },
                            code: { type: 'string', required: true },
                            where: { type: 'string', required: true },
                            message: { type: 'string', required: true },
                        } } },
                    } },
                    gate: { type: 'object', additionalProperties: false, properties: {
                        available: { type: 'boolean', required: true },
                        coverage: { type: 'number' },
                        drift: { type: 'number' },
                        missedScenes: { type: 'array', items: { type: 'string' }, required: true },
                        bannedHits: { type: 'array', items: { type: 'string' }, required: true },
                        requirements: { type: 'array', items: { type: 'string' }, required: true },
                        conditional: { type: 'array', items: { type: 'string' }, required: true },
                        passed: { type: 'boolean' },
                        note: { type: 'string' },
                    } },
                    platformReview: { type: 'object', additionalProperties: false, properties: {
                        platform: { type: 'string', required: true },
                        name: { type: 'string', required: true },
                        score: { type: 'integer', required: true },
                        passed: { type: 'boolean', required: true },
                        errorCount: { type: 'integer', required: true },
                        warningCount: { type: 'integer', required: true },
                        checks: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                            key: { type: 'string', required: true }, label: { type: 'string', required: true },
                            ok: { type: 'boolean', required: true }, value: { type: 'string', required: true },
                            target: { type: 'string', required: true }, level: { type: 'string', required: true },
                            advice: { type: 'string', required: true },
                        } } },
                    } },
                    censorResult: { type: 'object', additionalProperties: false, properties: {
                        level: { type: 'string', required: true },
                        chars: { type: 'integer', required: true },
                        note: { type: 'string', required: true },
                        errorCount: { type: 'integer', required: true },
                        warningCount: { type: 'integer', required: true },
                        categories: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                            key: { type: 'string', required: true }, label: { type: 'string', required: true },
                            severity: { type: 'string', required: true }, count: { type: 'integer', required: true },
                            hint: { type: 'string', required: true },
                            hits: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                                term: { type: 'string', required: true }, count: { type: 'integer', required: true },
                                line: { type: 'integer', required: true }, excerpt: { type: 'string', required: true },
                            } } },
                        } } },
                    } },
                    voiceResult: { type: 'object', additionalProperties: false, properties: {
                        checked: { type: 'integer', required: true },
                        errors: { type: 'integer', required: true },
                        warnings: { type: 'integer', required: true },
                        issues: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                            severity: { type: 'string', required: true },
                            code: { type: 'string', required: true },
                            name: { type: 'string', required: true },
                            message: { type: 'string', required: true },
                        } } },
                    } },
                },
            },
        },
        // 宿主 dsh-tools 的 executionMode() 只有严格 true 才并行调度。基础审计（机审比对）
        // 是纯读，安全；但 platform/censor 路径会 appendLine 写审计行（读-改-写版本守卫），
        // 并发下抛 FS_VERSION_CONFLICT —— 带写路径必须排他。
        isConcurrencySafe: (args) => !args?.platform && !args?.censor,
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

            // 可选：全书一致性校验（零 token 纯函数）。IO 装配与面板 REST 共用 continuity-io。
            let continuityResult;
            if (args.continuity === true) {
                const inputs = await loadContinuityInputs(io, p, novel);
                const c = validateContinuity(inputs);
                continuityResult = { ok: c.ok, errors: c.stats.errors, warnings: c.stats.warnings, issues: c.issues };
            }

            // 契约指标（A3/A4）：细纲写了「本章必写场景」/「本章禁止偏离项」段才参与判定。
            const gmetrics = computeGateMetrics({ content, outline });
            const gate = {
                available: gmetrics.available,
                missedScenes: gmetrics.missedScenes,
                bannedHits: gmetrics.bannedHits,
                requirements: gmetrics.requirements,
                conditional: gmetrics.conditional,
                ...(gmetrics.coverage === null ? {} : { coverage: gmetrics.coverage }),
                ...(gmetrics.drift === null ? {} : { drift: gmetrics.drift }),
                ...(gmetrics.passed === null ? {} : { passed: gmetrics.passed }),
                ...(gmetrics.note === null ? {} : { note: gmetrics.note }),
            };

            // 平台审稿（C4）：把「编辑口味」算成条目——起点看结构，番茄看前千字爽点。
            let platformReview;
            if (args.platform !== undefined && String(args.platform).trim() !== '') {
                const r = reviewForPlatform({ content, chapter: args.chapter, platform: args.platform });
                platformReview = {
                    platform: r.platform, name: r.name, score: r.score, passed: r.passed,
                    errorCount: r.errorCount, warningCount: r.warningCount, checks: r.checks,
                };
                await audit(io, p, 'audit/platform', { chapter: args.chapter, platform: r.platform, score: r.score });
            }

            // 敏感自查（C5）：发书前的红线扫描（启发式预筛，非合规判定）。
            let censorResult;
            if (args.censor === true) {
                const exempt = args.exempt === undefined ? [] : parseList(args.exempt);
                const s = scanSensitive({ content, exempt });
                censorResult = {
                    level: s.level, chars: s.chars, note: s.note,
                    errorCount: s.stats.errorCount, warningCount: s.stats.warningCount,
                    categories: s.categories,
                };
                if (s.stats.errorCount > 0) {
                    await audit(io, p, 'audit/censor', { chapter: args.chapter, level: s.level, categories: s.categories.map((c) => c.key) });
                }
            }

            // 语言基因卡核对（E3）：禁忌词命中是硬伤；有台词无口头禅是提示。
            let voiceResult;
            if (args.voice === true) {
                const voicesRaw = (await io.readJson(p.voices)) ?? {};
                const voiced = (novel.cast ?? [])
                    .map((nm) => ({ name: nm, voice: normalizeVoice(voicesRaw[nm]) }))
                    .filter((e) => !isEmptyVoice(e.voice));
                const vc = voiceConsistency({ content, voices: voiced });
                voiceResult = { checked: vc.checked, errors: vc.stats.errors, warnings: vc.stats.warnings, issues: vc.issues };
            }

            return {
                book, chapter: args.chapter, path: rec.path,
                chars: a.chars, paragraphCount: a.paragraphCount, avgParagraphChars: a.avgParagraphChars,
                sentenceCount: a.sentenceCount, dialogueRatio: a.dialogueRatio,
                endingHook: { ...a.endingHook },
                repetition: { ...a.repetition },
                coverage: { terms: a.coverage.terms, missing: a.coverage.missing },
                verdict,
                gate,
                ...(continuityResult !== undefined ? { continuityResult } : {}),
                ...(platformReview !== undefined ? { platformReview } : {}),
                ...(censorResult !== undefined ? { censorResult } : {}),
                ...(voiceResult !== undefined ? { voiceResult } : {}),
            };
        },
        render: (_args, v) => textBlock(
            `第${v.chapter}章机审（${v.chars} 字）：段 ${v.paragraphCount}·对话占比 ${v.dialogueRatio}·章末钩子 ${v.endingHook.detected ? v.endingHook.kind : '⚠无'}·与前文最大重合 ${v.repetition.jaccard}${v.repetition.chapter != null ? `（第${v.repetition.chapter}章）` : ''}\n`
            + `判定：${v.verdict.ok ? '通过' : '不通过'}${v.verdict.problems.length > 0 ? `\n问题：${v.verdict.problems.join('；')}` : ''}${v.verdict.warnings.length > 0 ? `\n警告：${v.verdict.warnings.join('；')}` : ''}`
            + (v.gate.available === true
                ? `\n\n—— 细纲契约指标（代码算）——\n覆盖率 ${v.gate.coverage}%${v.gate.drift === undefined ? '' : ` / 偏离度 ${v.gate.drift}%`} / ${v.gate.passed ? '通过 ✓' : '未通过'}`
                    + `${v.gate.missedScenes.length > 0 ? `\n漏写场景：${v.gate.missedScenes.join('、')}` : ''}`
                    + `${v.gate.bannedHits.length > 0 ? `\n命中禁项：${v.gate.bannedHits.join('、')}` : ''}`
                : `\n\n—— 细纲契约指标 ——\n未启用（${v.gate.note ?? '细纲未写必写场景段'}）`)
            + (v.continuityResult !== undefined
                ? `\n\n—— 全书一致性（${v.continuityResult.errors} 错 / ${v.continuityResult.warnings} 警）——\n`
                    + (v.continuityResult.issues.length === 0
                        ? '未发现硬伤 ✓'
                        : v.continuityResult.issues.map((i) => `${i.severity === 'error' ? '✗' : '⚠'} ${i.message}`).join('\n'))
                : '')
            + (v.platformReview !== undefined
                ? `\n\n—— 平台审稿·${v.platformReview.name}（${v.platformReview.score}/100，${v.platformReview.passed ? '通过 ✓' : '需改'}）——\n`
                    + v.platformReview.checks.map((c) => `${c.ok ? '✓' : (c.level === 'error' ? '✗' : '⚠')} ${c.label}：${c.value}${c.ok || c.advice === '' ? '' : `\n    → ${c.advice}`}`).join('\n')
                : '')
            + (v.censorResult !== undefined
                ? `\n\n—— 敏感自查·${v.censorResult.level === 'clean' ? '未检出 ✓' : (v.censorResult.level === 'risky' ? '命中红线词 ⚠' : '注意')}（${v.censorResult.errorCount} 类红线 / ${v.censorResult.warningCount} 类提醒）——\n`
                    + (v.censorResult.categories.length === 0
                        ? '未检出敏感标记词。'
                        : v.censorResult.categories.map((c) => `${c.severity === 'error' ? '✗' : '⚠'} 【${c.label}】${c.count} 处（${c.hits.map((h) => h.term).join('、')}）\n    → ${c.hint}`).join('\n'))
                : '')
            + (v.voiceResult !== undefined
                ? `\n\n—— 语言基因卡核对（${v.voiceResult.checked} 人）——\n`
                    + (v.voiceResult.issues.length === 0
                        ? '未发现问题 ✓'
                        : v.voiceResult.issues.map((i) => `${i.severity === 'error' ? '✗' : '⚠'} ${i.message}`).join('\n'))
                : '')
        ),
    });
}

export function defineStyleTool(ctx, config) {
    return defineTool({
        name: 'novel_style',
        description: '文笔六维基线 + 氛围光谱（纯本地计算，零模型调用）：build 测全书各章的句法复杂度/修饰密度/抽象度/动作密度/不确定性/留白指数算 μ±σ 基线带，并测 12 轴氛围（热血/悬疑/惊悚/压抑/甜宠/温情/悲情/诙谐/爽感/神秘/肃杀/苍凉）取全书均值；check 拿某章（或给定 text）对照基线，逐维报带内✓/出带⚠、偏差百分比与主导氛围漂移——把「文风跑偏了」变成可对照的数字。续写/润色前建议先 build 一次、交稿前 check 一次。',
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
                    mood: { type: 'object', additionalProperties: true },
                },
            },
        },
        // check 是纯读，可并行；build 会写 style-baseline.json（'replace' 无版本守卫，
        // 并发下与其它写工具交错有丢更新/撕读风险）—— build 必须排他。
        isConcurrencySafe: (args) => args?.action === 'check',
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);

            if (args.action === 'build') {
                const chapterKeys = Object.keys(novel.chapters ?? {}).map(Number).filter((k) => novel.chapters[String(k)]?.path !== undefined).sort((a, b) => a - b);
                if (chapterKeys.length === 0) throw new Error(`「${book}」还没有已保存的章节，无从建基线`);
                const metricsList = [];
                const moodList = [];
                for (const k of chapterKeys) {
                    const content = await io.readText(novel.chapters[String(k)].path);
                    if (content === null) continue; // 文件缺失跳过，不让基线崩掉
                    metricsList.push(measureStyleMetrics(content));
                    moodList.push(measureMood(content));
                }
                if (metricsList.length === 0) throw new Error(`「${book}」的章节文件缺失，无法建基线（可用 novel_project repair 对账）`);
                const baseline = computeBaseline(metricsList);
                // 氛围光谱：全书各轴均值 + 最浓的三个轴
                const moodAxes = {};
                for (const { key } of MOOD_AXES) {
                    const xs = moodList.map((m) => m.axes[key]);
                    moodAxes[key] = Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;
                }
                const moodTop = Object.entries(moodAxes).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
                baseline.mood = { axes: moodAxes, top: moodTop };
                const path = p.styleBaseline;
                await io.writeJson(path, { book, chapters: metricsList.length, baseline, builtAt: new Date().toISOString() }, 'replace');
                return { action: 'build', book, chapters: baseline.chapters, path, dims: baseline.dims, mood: { axes: moodAxes, top: moodTop } };
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
            let sourceText;
            let metrics;
            if (Number.isInteger(args.chapter)) {
                const rec = novel.chapters?.[String(args.chapter)];
                if (rec?.path === undefined) throw new Error(`第${args.chapter}章尚未保存`);
                const content = await io.readText(rec.path);
                if (content === null) throw new Error(`章节文件缺失：${rec.path}`);
                source = rec.path;
                sourceText = content;
                metrics = measureStyleMetrics(content);
            } else if (typeof args.text === 'string' && args.text.trim() !== '') {
                source = 'text';
                sourceText = args.text;
                metrics = measureStyleMetrics(args.text);
            } else {
                throw new Error('check 需要 chapter 或 text 二选一');
            }
            const judged = judgeAgainstBaseline(metrics, baseline, overrides);
            // 氛围对照：本段 12 轴向量；主导氛围漂移 = 最浓轴不在基线前三（基线有明确主导时）
            const mood = measureMood(sourceText);
            let moodDrift = null;
            const baseMood = baseline.mood;
            if (baseMood?.top && baseMood.top.length > 0 && (baseMood.axes?.[baseMood.top[0]] ?? 0) > 0) {
                const myTop = mood.top[0];
                if (myTop !== undefined && !baseMood.top.includes(myTop)) {
                    moodDrift = { from: baseMood.top[0], to: myTop };
                }
            }
            return {
                action: 'check', book, chapters: Number.isInteger(baseline.chapters) ? baseline.chapters : 0, source,
                verdict: judged.verdict, outCount: judged.outCount,
                dims: judged.dims, deviations: judged.deviations,
                mood: { axes: mood.axes, top: mood.top, dominantDrift: moodDrift },
            };
        },
        render: (_args, v) => {
            const moodLine = v.mood?.top && v.mood.top.length > 0
                ? `\n氛围：${v.mood.top.map((k) => moodLabel(k)).join('/')} 最浓`
                : '';
            if (v.action === 'build') {
                const lines = STYLE_DIMENSIONS.map(({ key, label, unit }) => {
                    const d = v.dims[key];
                    return `- ${label}（${unit}）μ=${d.mu} σ=${d.sigma ?? '—'} 容差±${d.tolerance}%`;
                });
                return textBlock(`风格基线已建立：${v.book}，${v.chapters} 章 → ${v.path}\n${lines.join('\n')}${moodLine}`);
            }
            const lines = STYLE_DIMENSIONS.map(({ key, label, unit }) => {
                const d = v.dims[key] ?? {};
                const mark = d.inBand ? '✓' : `⚠ 偏差 ${d.deviationPct > 0 ? '+' : ''}${d.deviationPct}%`;
                return `- ${label}：${d.value}（基线 ${d.mu} ±${d.tolerance}%）${mark}`;
            });
            const verdictText = v.verdict === 'in_band' ? '带内 ✓' : v.verdict === 'minor_drift' ? '轻度漂移' : '明显漂移 ⚠';
            const drift = v.mood?.dominantDrift
                ? `\n主导氛围漂移：${moodLabel(v.mood.dominantDrift.from)} → ${moodLabel(v.mood.dominantDrift.to)}（方向参考，不是错误）`
                : '';
            return textBlock(`风格对照（${verdictText}，出带 ${v.outCount}/6）\n${lines.join('\n')}${moodLine}${drift}${v.deviations.length > 0 ? `\n最偏维度：${v.deviations.map((d) => `${d.label} ${d.deviationPct > 0 ? '+' : ''}${d.deviationPct}%`).join('、')}` : ''}`);
        },
    });
}
