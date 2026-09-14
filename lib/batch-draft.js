// lib/batch-draft.js — D2 · 并发批量起草。
//
// 目标：一次把 N 章草稿推出来，但**不牺牲任何一条硬约束**。
//
// 四个硬约束（每一条都对应一类真实事故）：
//   ① **并发生成、串行提交**。章节文件按章号命名、互不覆盖，可以并行写；但账本
//      （facts/伏笔/novel.json）并发写同一章会互相覆盖 —— 所以生成阶段并发，提交阶段排队。
//   ② **上下文预算 ×N**。N 章并发 = N 份上下文包同时在场。默认并发 1（保守），上限 4，
//      且**只在场景契约（B3）裁过上下文的书上放开** —— 第三批的收益在这里兑现。
//   ③ **顺序依赖是真实的**。并发起草的第 2+ 章看不到前一章的正文（它还没写出来），
//      所以细纲必须自带衔接信息；「连环悬念」的章节不要并行。
//   ④ **失败不整批回滚**。N 章里 1 章挂了，其余照落盘 —— 整批回滚等于把好章节扔了重跑。
//
// 提交链复用 lib/chapter-commit.js（与单章写**同一条**），所以机审/内容门禁/账本冲突/
// 悬念保护在批量路径上一个都不会漏。

import { contractFor } from './scene-contract.js';
import { buildBriefing } from './briefing.js';
import { commitChapter } from './chapter-commit.js';
import { extractChapterText } from './engine-tasks.js';

/** 并发上限。再高收益递减、上下文成本线性上升、限流概率陡增。 */
export const MAX_CONCURRENCY = 4;

/** 起草系统提示。注意第 5 条——并发场景下模型看不到前一章正文，衔接只能靠细纲。 */
export const DRAFT_SYSTEM = [
    '你是中文长篇小说的写手。按给定的写前简报与细纲，写出这一章的完整正文。',
    '硬要求：',
    '1. 只输出本章正文，不要任何解释、前言、结语、Markdown 代码围栏；',
    '2. 首行是章节标题（与细纲给的一致）；',
    '3. **严格按细纲的场景与顺序写**，细纲里的必写场景一个都不能少；',
    '4. 细纲「本章禁止偏离项」里禁止的内容绝对不许出现（尤其**隐藏人物不许露面、不许被提及**）；',
    '5. 本章可能与相邻章并行写作，你**看不到前后章正文**——衔接信息只以细纲与简报为准，不要臆造上一章结尾的细节；',
    '6. 对话要符合人物的语言基因卡（口头禅/绝不说的话/小动作），不要千人一腔；',
    '7. 情绪用动作/环境/留白暗示，不直写结论句；避免「不禁」「仿佛」「嘴角勾起一抹弧度」这类AI腔；',
    '8. 长短句交错；章末留钩子，但不要用新悬念去掩盖旧欠账。',
].join('\n');

/** 起草提示词（纯函数）。 */
export function buildDraftPrompt({ chapter, briefing, chapterOutline }) {
    return [
        `【第 ${chapter} 章 · 写前简报】`,
        String(briefing ?? ''),
        '',
        '【本章细纲】',
        String(chapterOutline ?? ''),
        '',
        '请写出这一章的完整正文。',
    ].join('\n');
}

/**
 * 从细纲里推标题与梗概（草稿提交需要，模型不负责起名）。
 * 标题优先取细纲里的 `# 第N章 XXX` / `第N章 XXX`；梗概取第一段正文内容。
 */
export function deriveTitleSummary(outlineText, chapter) {
    const lines = String(outlineText ?? '').split('\n').map((l) => l.trim());
    let title = `第 ${chapter} 章`;
    let summary = '';
    for (const line of lines) {
        if (line === '') continue;
        const heading = line.match(/^#{1,6}\s*(.+)$/);
        const plain = heading !== null ? heading[1].trim() : line;
        if (/^第\s*[0-9一二三四五六七八九十百零]+\s*[章回]/.test(plain)) {
            title = plain.replace(/^#+\s*/, '').slice(0, 40);
            continue;
        }
        if (summary === '') summary = plain.replace(/^[-*+]\s*/, '').slice(0, 60);
    }
    if (summary === '') summary = `${title}（细纲未提供梗概）`;
    return { title, summary };
}

/**
 * 计划一次批量起草（纯函数，可单测）：哪些章能写、哪些被拦、为什么。
 *
 * @param novel             novel.json
 * @param from              起始章号
 * @param count             章数
 * @param availableOutlines 有细纲文件的章号
 * @param approvedOutlines  已在 novel.json 里被批准的章号（缺省 force 时为空）
 * @param force             显式放行未批准细纲与熔断
 */
export function planDraftBatch({ novel, from, count, availableOutlines = [], approvedOutlines = [], force = false }) {
    const items = [];
    const warnings = [];
    const approved = new Set(approvedOutlines);
    const available = new Set(availableOutlines);
    const failures = novel.gateFailures ?? {};

    for (let n = from; n < from + count; n += 1) {
        const written = novel.chapters?.[String(n)]?.path !== undefined;
        const tripped = (failures[String(n)] ?? 0) >= 3;
        let reason = null;
        if (written) reason = `第${n}章已有正文——修订请走提案（novel_propose），批量起草只写新章`;
        else if (!available.has(n)) reason = `第${n}章细纲不存在——先 novel_outline save_chapter`;
        else if (!force && !approved.has(n)) reason = `第${n}章细纲未批准——先 novel_outline approve（确要跳过用 force）`;
        else if (!force && tripped) reason = `第${n}章熔断中（连续驳回 ${failures[String(n)]} 次）——先改细纲或场景契约，改完计数自动清零`;
        items.push(reason === null
            ? { chapter: n, blocked: false, reason: null }
            : { chapter: n, blocked: true, reason });
    }

    // 章号连续性：中间缺一章，后面那章的上下文（上一章结尾）就是错的
    const ready = items.filter((i) => !i.blocked).map((i) => i.chapter);
    for (let i = 1; i < ready.length; i += 1) {
        if (ready[i] !== ready[i - 1] + 1) {
            warnings.push(`可写章号不连续（${ready[i - 1]} → ${ready[i]}）：跳过的那章没有正文，后一章的「上一章结尾」会是空的，衔接只能靠细纲`);
        }
    }
    if (items.every((i) => i.blocked) && items.length > 0) {
        warnings.push('没有任何一章可以起草——看下面每章的拦截原因');
    }
    return { items, ready, blocked: items.filter((i) => i.blocked), warnings };
}

/**
 * 并发映射，**保序返回**。错误不中断整批（每项自己捕获）。
 * @param limit 并发上限（>=1）
 */
export async function mapWithConcurrency(items, limit, fn, { signal = null } = {}) {
    const size = Math.max(1, Math.min(limit, items.length === 0 ? 1 : items.length));
    const results = new Array(items.length);
    let cursor = 0;
    const worker = async () => {
        for (;;) {
            if (signal?.aborted === true) return;
            const index = cursor;
            cursor += 1;
            if (index >= items.length) return;
            results[index] = await fn(items[index], index);
        }
    };
    await Promise.all(Array.from({ length: size }, worker));
    return results;
}

/**
 * 跑一次批量起草：计划 → 并发生成 → 串行提交。
 *
 * 生成失败或提交被门禁拦下都只影响那一章（`ok:false` + 原因），其余照落。
 * @returns {{items, results, concurrency, warnings, stats}}
 */
export async function runDraftBatch({
    engine, config, io, p, book, novel, from, count,
    concurrency = 1, force = false, onEvent = null, signal = null,
}) {
    const warnings = [];
    const availableOutlines = [];
    for (let n = from; n < from + count; n += 1) {
        if ((await io.readText(p.chapterOutline(n))) !== null) availableOutlines.push(n);
    }
    const approvedOutlines = Object.keys(novel.approvals?.outline ?? {}).map(Number);
    const plan = planDraftBatch({ novel, from, count, availableOutlines, approvedOutlines, force });
    warnings.push(...plan.warnings);

    // 约束②：上下文预算 ×N —— 没有场景契约就退回串行
    const contracts = (await io.readJson(p.sceneContracts)) ?? {};
    const covered = plan.ready.filter((n) => contractFor(contracts, n) !== null).length;
    let limit = Math.max(1, Math.min(Number.isInteger(concurrency) && concurrency >= 1 ? concurrency : 1, MAX_CONCURRENCY));
    if (limit > 1 && covered === 0) {
        warnings.push(`这 ${plan.ready.length} 章都没有场景契约（上下文未裁剪）——已把并发降到 1（novel_scene save 建契约后可提速）`);
        limit = 1;
    } else if (limit > 1 && covered < plan.ready.length) {
        warnings.push(`只有 ${covered}/${plan.ready.length} 章有场景契约，未裁剪的章上下文更重，注意额度`);
    }
    if (limit > 1 && plan.ready.length > 1) {
        warnings.push('并发生成：第 2 章起看不到前面章节的正文（还没写出来），衔接完全依赖细纲——连环悬念章建议单独串行写');
    }

    const emit = (event) => { if (typeof onEvent === 'function') onEvent(event); };
    const todo = plan.items.filter((i) => !i.blocked);

    // ── 阶段一：并发生成草稿 ────────────────────────────────────────────────
    const drafts = await mapWithConcurrency(todo, limit, async (item) => {
        const n = item.chapter;
        try {
            emit({ type: 'draft-start', chapter: n });
            const brief = await buildBriefing({ config, io, book, novel, n });
            const r = await engine.run('draft', {
                system: DRAFT_SYSTEM,
                prompt: buildDraftPrompt({ chapter: n, briefing: brief.rendered, chapterOutline: brief.chapterOutline }),
                signal,
            });
            if (!r.ok) {
                emit({ type: 'draft-failed', chapter: n, code: r.error.code });
                return { chapter: n, ok: false, stage: 'generate', reason: `${r.error.message}（${r.error.advice}）`, error: r.error };
            }
            const content = extractChapterText(r.text);
            if (content === '') {
                return { chapter: n, ok: false, stage: 'generate', reason: '模型输出里没有可用正文（可能只回了说明）' };
            }
            emit({ type: 'draft-done', chapter: n, chars: content.length });
            return { chapter: n, ok: true, content, chars: content.length, briefingChars: brief.totalChars, briefWarnings: brief.warnings };
        } catch (error) {
            return { chapter: n, ok: false, stage: 'generate', reason: String(error?.message ?? error) };
        }
    }, { signal });

    // ── 阶段二：逐章串行提交（同一条硬约束链）──────────────────────────────
    const results = [];
    for (const d of drafts) {
        if (!d.ok) {
            results.push({ ...d, committed: false });
            continue;
        }
        const n = d.chapter;
        const outlineText = (await io.readText(p.chapterOutline(n))) ?? '';
        const { title, summary } = deriveTitleSummary(outlineText, n);
        try {
            emit({ type: 'commit-start', chapter: n });
            const committed = await commitChapter({
                config, io, p, book, novel, n,
                title, content: d.content, summary,
                castNames: [], updates: [], force: force === true,
                committedBy: 'agent',
            });
            emit({ type: 'commit-done', chapter: n, version: committed.version });
            results.push({
                chapter: n, ok: true, committed: true, title, chars: committed.chars,
                version: committed.version, path: committed.path,
                contentGate: committed.contentGate.ok ? 'pass' : 'forced',
                noai: committed.noai.score,
                warnings: [...(d.briefWarnings ?? []), ...committed.warnings],
            });
        } catch (error) {
            // 门禁拦下：这一章不落盘，其余照旧（不整批回滚）
            emit({ type: 'commit-rejected', chapter: n });
            results.push({
                chapter: n, ok: false, committed: false, stage: 'commit',
                reason: String(error?.message ?? error),
            });
        }
    }

    const committedCount = results.filter((r) => r.committed).length;
    const stats = {
        planned: count,
        attempted: todo.length,
        blockedAtPlan: plan.blocked.length,
        committed: committedCount,
        failed: results.length - committedCount,
    };
    return { items: plan.items, results, concurrency: limit, warnings, stats };
}
