// lib/tools/style-tool.js — novel_style（文笔六维基线 + 氛围光谱）。
// 从 quality-tools.js 按工具拆出；schema 与描述原样保留。

import { defineTool } from './define-tool.js';
import { pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { measureStyleMetrics, measureMood, moodLabel, computeBaseline, judgeAgainstBaseline, STYLE_DIMENSIONS, MOOD_AXES } from '../style.js';
import { requireBook, textBlock } from './common.js';

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
