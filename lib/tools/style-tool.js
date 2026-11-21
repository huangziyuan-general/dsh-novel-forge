// lib/tools/style-tool.js — novel_style（文笔六维基线 + 氛围光谱）。
// 从 quality-tools.js 按工具拆出；schema 与描述原样保留。

import { defineTool } from './define-tool.js';
import { pathsFor, chapterRelPath } from '../store.js';
import { assertBookName, createFsio, sessionCwd, updateJson } from '../fsio.js';
import { measureStyleMetrics, measureMood, moodLabel, computeBaseline, judgeAgainstBaseline, STYLE_DIMENSIONS, MOOD_AXES } from '../style.js';
import { parseWhitelistLines, reconcileWhitelist } from '../style-whitelist.js';
import { parseWritingRulesText, reconcileWritingRules, validRuleRow } from '../writing-rules.js';
import { requireBook, textBlock } from './common.js';

export function defineStyleTool(ctx, config) {
    return defineTool({
        name: 'novel_style',
        description: '文笔六维基线 + 氛围光谱（纯本地计算，零模型调用）：build 测全书各章的句法复杂度/修饰密度/抽象度/动作密度/不确定性/留白指数算 μ±σ 基线带，并测 12 轴氛围（热血/悬疑/惊悚/压抑/甜宠/温情/悲情/诙谐/爽感/神秘/肃杀/苍凉）取全书均值；check 拿某章（或给定 text）对照基线，逐维报带内✓/出带⚠、偏差百分比与主导氛围漂移——把「文风跑偏了」变成可对照的数字。whitelist/whitelist_add/whitelist_remove 管理**本书文风白名单**（作者手登记的「这是我，别拦」字面串：去 AI 味扫描前把这些写法掩掉，所有维度都不再数它们——解决「改到没有 AI 味就改成不是我」的矛盾）；白名单只影响去 AI 味证据面，不影响字数/重复/内容门禁。rules/rules_add/rules_remove 管理**本书写法规则**（作者手定的「禁止/风险/鼓励」写法规矩，带检测词确定性计数：noai 扫描命中 report-only，修正方向进写章简报当写作纪律位）；规则按书隔离，命中只报不拦（拦的语义归内容门禁）。续写/润色前建议先 build 一次、交稿前 check 一次。',
        parameters: {
            action: { type: 'string', required: true, enum: ['build', 'check', 'whitelist', 'whitelist_add', 'whitelist_remove', 'rules', 'rules_add', 'rules_remove'], description: 'build=测全书建基线；check=拿某章/某段对照基线；whitelist=看当前白名单；whitelist_add/remove=按 text 多行「一条一行」增删字面串；rules=看当前写法规则；rules_add/remove=按 text 多行规则增删。' },
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', description: 'check：要对照的章号（取最新版本）；省略则需给 text。' },
            text: { type: 'string', description: 'check：直接对照的正文（不给 chapter 时用）；whitelist_add/remove：多行字面串（一条一行，# 开头为注释）；rules_add：多行规则，行式「名称|类型|严重度|检测词1,检测词2|修正方向」（类型限 forbidden/risk/encourage、严重度限 low/medium/high，后两段可省；坏行进回执 errors 不炸整批）；rules_remove：多行规则名（一行一个，删整条）。' },
            tolerance: { type: 'string', description: 'check：每维容差覆盖，格式「syntax:40 modifier:25」（维 key:百分数），缺省用基线内置（1.5σ）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    action: { type: 'string', required: true },
                    book: { type: 'string', required: true },
                    // 白名单动作不返回 chapters/dims（只 build/check 返回）——required 收窄到按动作区分
                    // 需要宿主校验器支持 if/then，schema 层做不了；故 chapters/dims 放宽为可选（build/check 仍恒返回）。
                    chapters: { type: 'integer' },
                    path: { type: 'string' },
                    source: { type: 'string' },
                    verdict: { type: 'string' },
                    outCount: { type: 'integer' },
                    dims: { type: 'object', additionalProperties: true },
                    deviations: { type: 'array', items: { type: 'object', additionalProperties: true } },
                    mood: { type: 'object', additionalProperties: true },
                    whitelist: { type: 'object', additionalProperties: false, properties: {
                        count: { type: 'integer', required: true },
                        items: { type: 'array', items: { type: 'string' }, required: true },
                        changed: { type: 'boolean', required: true },
                        // 回执明细（新增/移除的串、口径说明）——schema 逐键对齐（additionalProperties:false）
                        added: { type: 'array', items: { type: 'string' }, required: true },
                        removed: { type: 'array', items: { type: 'string' }, required: true },
                        note: { type: 'string', required: true },
                    } },
                    // 写法规则台账（rules 动作族）：只写 设定/写法规则.json（updateJson 版本重放）
                    rules: { type: 'object', additionalProperties: false, properties: {
                        count: { type: 'integer', required: true },
                        items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                            id: { type: 'string', required: true },
                            name: { type: 'string', required: true },
                            type: { type: 'string', required: true },
                            severity: { type: 'string', required: true },
                            patterns: { type: 'array', items: { type: 'string' }, required: true },
                            instruction: { type: 'string', required: true },
                        } } },
                        changed: { type: 'boolean', required: true },
                        added: { type: 'array', items: { type: 'string' }, required: true },
                        removed: { type: 'array', items: { type: 'string' }, required: true },
                        errors: { type: 'array', items: { type: 'string' }, required: true },
                        note: { type: 'string', required: true },
                    } },
                },
            },
        },
        // check / whitelist / rules 是纯读或只写各自的数据文件（updateJson 版本重放），可并行；
        // build 写 style-baseline.json（'replace' 无版本守卫，并发写会撕读）—— build 排他。
        isConcurrencySafe: (args) => ['check', 'whitelist', 'whitelist_add', 'whitelist_remove', 'rules', 'rules_add', 'rules_remove'].includes(args?.action),
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);

            // ── 白名单三动作（list / add / remove，共用 reconcileWhitelist 单一实现）──
            if (args.action === 'whitelist' || args.action === 'whitelist_add' || args.action === 'whitelist_remove') {
                const existing = (await io.readJson(p.styleWhitelist)) ?? [];
                if (args.action === 'whitelist') {
                    return {
                        action: 'whitelist', book,
                        whitelist: {
                            count: Array.isArray(existing) ? existing.length : 0,
                            items: Array.isArray(existing) ? existing : [],
                            changed: false, added: [], removed: [],
                            note: '去 AI 味扫描（novel_noai_scan / 写章链）前自动掩掉这些字面串；只影响 AI 味证据面，不影响其它门禁',
                        },
                    };
                }
                const addText = args.action === 'whitelist_add' ? (typeof args.text === 'string' ? args.text : '') : '';
                const removeText = args.action === 'whitelist_remove' ? (typeof args.text === 'string' ? args.text : '') : '';
                if (args.action === 'whitelist_add' && addText.trim() === '') throw new Error('whitelist_add 需要 text（多行字面串，一条一行）');
                if (args.action === 'whitelist_remove' && removeText.trim() === '') throw new Error('whitelist_remove 需要 text（多行字面串，一条一行）');
                const next = reconcileWhitelist(existing, addText, removeText);
                const changed = next.length !== (Array.isArray(existing) ? existing.length : 0)
                    || JSON.stringify(next) !== JSON.stringify(Array.isArray(existing) ? existing : []);
                // 白名单是机器状态（JSON，不变量 6）；updateJson 版本重放防并发写冲突
                await updateJson(io, p.styleWhitelist, () => ({ value: next, result: next }));
                const added = next.filter((s) => !(Array.isArray(existing) ? existing : []).includes(s));
                const removed = (Array.isArray(existing) ? existing : []).filter((s) => !next.includes(s));
                return {
                    action: args.action, book,
                    whitelist: {
                        count: next.length, items: next, changed, added, removed,
                        note: changed
                            ? `白名单更新：新增 ${added.length} 条（${added.slice(0, 5).join('、')}${added.length > 5 ? '…' : ''}）、移除 ${removed.length} 条`
                            : '白名单无变化（这批字面串已在/不在清单里，去重后原样）',
                    },
                };
            }

            // ── 写法规则三动作（list / add / remove，共用 writing-rules 的解析与合并单一实现）──
            // 台账落 设定/写法规则.json（机器状态 JSON，与 facts 同构）；坏行不炸整批，
            // 进回执 errors 留痕（解析层逐行校验，静默吞行=作者以为登记了其实没有）。
            if (args.action === 'rules' || args.action === 'rules_add' || args.action === 'rules_remove') {
                const existing = (await io.readJson(p.writingRules)) ?? [];
                // 读回原样会把手编坏行透进 items（schema 每项字段全 required）——
                // 读动作也按 validRuleRow 过滤，坏行不出工具面；add/remove 写回时本就过滤。
                const base = (Array.isArray(existing) ? existing : []).filter(validRuleRow);
                if (args.action === 'rules') {
                    return {
                        action: 'rules', book,
                        rules: {
                            count: base.length, items: base, changed: false,
                            added: [], removed: [], errors: [],
                            note: '写法规则：forbidden 命中即报 / risk 成片（≥2）才报 / encourage 只注入不罚缺；noai 扫描 report-only，修正方向进写章简报',
                        },
                    };
                }
                const addText = args.action === 'rules_add' ? (typeof args.text === 'string' ? args.text : '') : '';
                const removeText = args.action === 'rules_remove' ? (typeof args.text === 'string' ? args.text : '') : '';
                if (args.action === 'rules_add' && addText.trim() === '') throw new Error('rules_add 需要 text（多行规则，行式「名称|类型|严重度|检测词|修正方向」）');
                if (args.action === 'rules_remove' && removeText.trim() === '') throw new Error('rules_remove 需要 text（多行规则名，一行一个）');
                const parsed = parseWritingRulesText(addText);
                const removeNames = String(removeText).split(/\r?\n/)
                    .map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
                const { rules: next, added, removed } = reconcileWritingRules(base, parsed.rules, removeNames);
                const changed = next.length !== base.length || JSON.stringify(next) !== JSON.stringify(base);
                // 版本重放防并发写冲突（同白名单/账本纪律）
                await updateJson(io, p.writingRules, () => ({ value: next, result: next }));
                return {
                    action: args.action, book,
                    rules: {
                        count: next.length, items: next, changed, added, removed,
                        errors: parsed.errors,
                        note: parsed.errors.length > 0
                            ? `${parsed.errors.length} 行未登记（见 errors）：${parsed.errors[0]}${parsed.errors.length > 1 ? '…' : ''}`
                            : (changed
                                ? `写法规则更新：${added.length} 条新增/更新、${removed.length} 条移除`
                                : '写法规则无变化（这批规则已在/不在台账里，去重后原样）'),
                    },
                };
            }

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
                // 路径收口（跟进项①）：越书路径不读，报可行动错误而不是把外来文件当正文量。
                const rel = chapterRelPath(rec, book);
                if (rel === null) throw new Error(`章节路径越出书目录（索引可能被污染，先 novel_project repair 对账）：${String(rec.path).slice(0, 80)}`);
                const content = await io.readText(rel);
                if (content === null) throw new Error(`章节文件缺失：${rel}`);
                source = rel;
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
            // 写法规则动作：只出台账清单与回执，不走基线/维度渲染（rules 返回体没有 dims/mood）
            if (v.rules !== undefined) {
                const rl = v.rules;
                const list = rl.items.length > 0
                    ? rl.items.map((r) => `【${r.type}/${r.severity}】${r.name}（${r.patterns.join('、') || '纯文字纪律'}）`).join('\n  ')
                    : '（空——noai 扫描无书级规则、简报无写法规则段）';
                return textBlock(`本书写法规则：${rl.count} 条\n  ${list}\n${rl.note}`
                    + (rl.errors.length > 0 ? `\n⚠ 未登记行：${rl.errors.join('；')}` : '')
                    + '\n规则按书隔离；命中只报不拦（拦的语义归内容门禁），修正方向进写章简报当写作纪律位。');
            }
            // 白名单动作：只出清单与回执，不走基线/维度渲染（whitelist 返回体没有 dims/mood）
            if (v.whitelist !== undefined) {
                const wl = v.whitelist;
                const list = wl.items.length > 0
                    ? `登记了 ${wl.count} 条（${wl.items.map((s) => `「${s}」`).join('、')}${wl.items.length > 6 ? '…' : ''}）`
                    : '（空——去 AI 味扫描不豁免任何写法）';
                return textBlock(`本书文风白名单：${list}\n${wl.note}\n`
                    + '白名单只在去 AI 味扫描前掩码，不影响字数/重复/内容门禁；登记的是**字面串**，逐字匹配，别写正则或半句。');
            }
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
