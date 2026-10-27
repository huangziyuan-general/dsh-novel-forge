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
import { chapterCharTarget, paragraphSpecRange } from './audit.js';
import { effectiveCharConfig, charConfigSourceLabel } from './store.js';
import { isVersionConflict } from './fsio.js';
import { recordBasis } from './tools/common.js';

/** 并发上限。再高收益递减、上下文成本线性上升、限流概率陡增。 */
export const MAX_CONCURRENCY = 4;

/** 起草系统提示（纯函数）。注意第 5 条——并发场景下模型看不到前一章正文，衔接只能靠细纲。
 *  字数目标此处**现算**（chapterCharTarget），不再写死「2000–4000 / 3000」：
 *  写死的数字一旦与配置漂移，批量路径就成了唯一说错话的地方。 */
export function draftSystem(config) {
    const target = chapterCharTarget(config);
    // 段落规格的算式只有一份（lib/audit.js）——简报、驳回文案、起草系统提示词共用，
    // 抄第二份就一定会在某次改口径时只改一处。
    const spec = paragraphSpecRange(config);
    return [
        '你是中文长篇小说的写手。按给定的写前简报与细纲，写出这一章的完整正文。',
        '硬要求：',
        '1. 只输出本章正文，不要任何解释、前言、结语、Markdown 代码围栏；',
        '2. 首行是章节标题（与细纲给的一致）；',
        '3. **严格按细纲的场景与顺序写**，细纲里的必写场景一个都不能少；',
        '4. 细纲「本章禁止偏离项」里禁止的内容绝对不许出现（尤其**隐藏人物不许露面、不许被提及**）；',
        '5. 本章可能与相邻章并行写作，你**看不到前后章正文**——衔接信息只以细纲与简报为准，不要臆造上一章结尾的细节；',
        '6. 对话要符合人物的语言基因卡（口头禅/绝不说的话/小动作），不要千人一腔；',
        '7. 情绪用动作/环境/留白暗示，不直写结论句；避免「不禁」「仿佛」「嘴角勾起一抹弧度」这类AI腔；',
        '8. 长短句交错；章末留钩子，但不要用新悬念去掩盖旧欠账；',
        `9. **单章正文 ${config.minChapterChars}–${config.maxChapterChars} 字、目标 ${target} 字左右**（正常网文连载单章篇幅）：不足就把细纲场景写细写透，不要注水凑字；快到 ${config.maxChapterChars} 字就收在钩子处收章——低于下限的稿子会被机审直接退掉。`,
        `10. **不要一句一段**：单段写足 ${Math.max(1, spec.min)}–${spec.max} 字（约 3–8 句），全章约 ${Math.round(target / spec.max)}–${Math.round(target / (spec.max / 2))} 段。短句单独成段 + 每句后空行，会让全章字数天然停在 1000 出头、怎么改都过不了下限。`,
    ].join('\n');
}

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
 * @param force             显式放行未批准细纲（熔断由解除通道清零，不由此放行）
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
        else if (tripped) reason = `第${n}章熔断中（连续驳回 ${failures[String(n)]} 次）——先改细纲或场景契约（novel_outline approve / novel_scene save），改完计数自动清零`;
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
 * 并发映射，**保序返回**。错误不中断整批：fn 抛错（含同步抛）由本函数捕获，以 Error 实例
 * 占位收进 results——不 reject、不吞项。旧实现裸 await fn，靠调用方自带 try/catch 兜底；
 * 这是导出函数，未来别处裸调一个同步抛错的 fn 就炸整批（真机导入书监控审查结论 P0-1）。
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
            try {
                results[index] = await fn(items[index], index);
            } catch (err) {
                results[index] = err instanceof Error ? err : new Error(String(err));
            }
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
    concurrency = 1, force = false, onEvent = null, signal = null, sessionId, sessionCandidates,
}) {
    const warnings = [];
    // 字数口径按本书档位现算（自定义 > 平台 > 插件默认）——批量起草与工具面写章、写前简报
    // 必须同一份 config，否则 D2 落盘的章会绕过用户给这本书设的区间（真机「先写后删」的
    // 批量版：D2 按默认 4000 上限放行，回头 novel_audit 按本书口径判超长）。
    const { config: bookConfig, source: charSource } = effectiveCharConfig(config, novel);
    if (charSource !== 'config') {
        warnings.push(`本章字数区间 ${bookConfig.minChapterChars}–${bookConfig.maxChapterChars}（出处：${charConfigSourceLabel(charSource, novel)}）`);
    }
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

    // 并发>1 时父锚定**只解析一次**：多章并发各自 agents.resume 同一持久化会话
    // 有撞宿主持久化写锁的风险（0.13.3 复盘）。解析结果经 run({ parent }) 传给
    // 每一章。解析失败→并发降 1，让单章路径自己锚定、给出完整的人话诊断。
    // （typeof 守卫：测试替身引擎可能只实现 run。）
    let sharedParent;
    if (limit > 1 && typeof engine.anchor === 'function') {
        const a = await engine.anchor({ channel: 'draft', sessionId, sessionIds: sessionCandidates, signal });
        if (a.ok) {
            sharedParent = a.parent;
        } else {
            limit = 1;
            warnings.push('父会话锚定失败——已把并发降为 1 逐章重试（' + String(a.error?.message ?? a.error).slice(0, 120) + '）');
        }
    }

    const emit = (event) => { if (typeof onEvent === 'function') onEvent(event); };
    const todo = plan.items.filter((i) => !i.blocked);

    // ── 断点检查点（.novel/batch-checkpoint.json，机器状态）──────────────────
    // 每章提交/被拦后更新；REST `resume:true` 从这里恢复参数。检查点写失败不阻断
    // 批量（它是便利设施，正确性靠 planDraftBatch 对已落盘章的自动拦截——重跑同
    // 范围天然跳过已完成的章）。
    const checkpoint = {
        book, from, count, concurrency: limit, force: force === true,
        status: 'running', startedAt: new Date().toISOString(),
        completed: [], failed: [],
    };
    // 并发写守卫（审查 L1）：两个 runDraftBatch 并发时，旧实现的 'auto' 整体覆盖会让
    // 后启动者把 startedAt 刷成自己的 now——resume 侧的 10 分钟防重入窗口被反复重置，
    // 面板「续跑」在批次正常结束前一直 409。现在每轮先读盘：盘上是**别人**的运行中
    // 检查点（startedAt 不同且未过期，与 insights.js resume 侧同一窗口/漂移语义）就让路，
    // 不动它的文件；自己的写走读时版本 + writeJsonAtVersion 守卫，抢写冲突重读重判一次。
    const CK_RUNNING_WINDOW_MS = 10 * 60_000;
    const saveCk = async () => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const { value: cur, version } = await io.readJsonWithVersion(p.batchCheckpoint);
                if (cur && cur.status === 'running' && cur.startedAt !== checkpoint.startedAt) {
                    const age = Date.now() - Date.parse(cur.startedAt);
                    if (Number.isFinite(age) && age >= -60_000 && age < CK_RUNNING_WINDOW_MS) return;
                }
                await io.writeJsonAtVersion(p.batchCheckpoint, checkpoint, version);
                return;
            } catch (error) {
                if (!isVersionConflict(error)) return; /* 检查点失败不阻断 */
                // 冲突：读后写前被人抢先——重读盘上现况再判一次
            }
        }
    };
    await saveCk();

    // ── 阶段一：并发生成草稿 ────────────────────────────────────────────────
    const drafts = (
        await mapWithConcurrency(todo, limit, async (item) => {
        const n = item.chapter;
        try {
            emit({ type: 'draft-start', chapter: n });
            // audience:'batch' —— 上下文包只有一个实现，但会话纪律段（待批提案/交付/输出预算）
            // 对单次补全的起草引擎没有读者：它没有工具可调、不向用户汇报。
            const brief = await buildBriefing({ config: bookConfig, io, book, novel, n, audience: 'batch' });
            // 落一份依据指纹（与 novel_briefing 同一份记录）：批量是先给所有章建简报、
            // 再逐章提交，若期间有人改了细纲/契约，提交时就会报「简报已过期」。
            await recordBasis(io, p, n, brief.basis);
            const r = await engine.run('draft', {
                system: draftSystem(bookConfig),
                prompt: buildDraftPrompt({ chapter: n, briefing: brief.rendered, chapterOutline: brief.chapterOutline }),
                signal,
                sessionId,
                sessionIds: sessionCandidates,
                ...(sharedParent !== undefined ? { parent: sharedParent } : {}),
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
    }, { signal })
    ).map((r, i) => (r instanceof Error
        ? { chapter: todo[i]?.chapter, ok: false, stage: 'generate', reason: `生成器异常：${r.message}` }
        : r));

    // ── 阶段二：逐章串行提交（同一条硬约束链）──────────────────────────────
    // L6 修复：abort 信号会让 mapWithConcurrency 在 results 里留下 undefined 空洞
    // ——此前空洞走进 !d.ok 被当成失败章，产出没有章号的幽灵结果行。
    const cancelled = drafts.filter((d) => d === undefined).length;
    if (cancelled > 0) warnings.push(`有 ${cancelled} 章因取消信号未生成（批次已被中断）`);
    const results = [];
    for (const d of drafts) {
        if (d === undefined) continue;
        if (!d.ok) {
            checkpoint.failed.push(d.chapter);
            await saveCk();
            results.push({ ...d, committed: false });
            continue;
        }
        const n = d.chapter;
        const outlineText = (await io.readText(p.chapterOutline(n))) ?? '';
        const { title, summary } = deriveTitleSummary(outlineText, n);
        try {
            emit({ type: 'commit-start', chapter: n });
            const committed = await commitChapter({
                config: bookConfig, io, p, book, novel, n,
                title, content: d.content, summary,
                castNames: [], updates: [], force: force === true,
                committedBy: 'agent',
                engine,
            });
            emit({ type: 'commit-done', chapter: n, version: committed.version });
            checkpoint.completed.push(n);
            await saveCk();
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
            checkpoint.failed.push(n);
            await saveCk();
            results.push({
                chapter: n, ok: false, committed: false, stage: 'commit',
                reason: String(error?.message ?? error),
            });
        }
    }

    const committedCount = results.filter((r) => r.committed).length;
    // 全部尝试章都落盘才算 done；有被拦/取消/未生成 → partial（可 resume 重试）。
    checkpoint.status = (todo.length === 0 || (results.length === todo.length && results.every((r) => r.ok))) ? 'done' : 'partial';
    checkpoint.finishedAt = new Date().toISOString();
    await saveCk();
    const stats = {
        planned: count,
        attempted: todo.length,
        blockedAtPlan: plan.blocked.length,
        committed: committedCount,
        failed: results.length - committedCount,
    };
    return { items: plan.items, results, concurrency: limit, warnings, stats };
}
