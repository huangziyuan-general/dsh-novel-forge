// lib/engine-tasks.js — D1 · 内部工序（走旁路引擎，不占主对话）。
//
// 这两件事以前必须塞进聊天：校对往返把会话窗口塞满、烧主额度，还把创作主线淹没在
// 「这里改成 X」的噪音里。现在它们是**受约束的受控调用**：
//
//   润色 polish   —— 按段落病灶清单整章改写，产出的仍是**提案**（用户点应用才生效）；
//   校对 proofread —— 只修错别字/标点/易混字，守卫比润色严得多（几乎不许改结构）。
//
// 两条都复用 `validatePolishEdits` 保守编辑守卫（第二批 C1）——「校对改出新错」是这条
// 链路最大的真实风险，守卫是硬闸：改标题 / 引入高危易混字直接拒绝，不落提案。

import { analyzeParagraphs, validatePolishEdits } from './polish.js';
import { submitRevisionProposal } from './proposals.js';
import { openIndexForBook } from './index-store.js';
import { untaggedChunks, setChunkTags, readTagCacheForTexts } from './retrieval.js';
import { planAnnotations } from './tag-cache.js';

/** 润色系统提示：定位是「改写」而非「重写」，且必须原样保留标题行。 */
export const POLISH_SYSTEM = [
    '你是中文长篇小说的资深修订编辑。任务：按给定的「病灶清单」改写整章正文。',
    '硬要求：',
    '1. 只输出改写后的整章正文，不要任何解释、前言、结语、Markdown 代码围栏；',
    '2. **首行标题原样保留**，一个字都不许改；',
    '3. 保留全部情节、人物、专有名词、数字与伏笔信息——你是在改写表达，不是重写故事；',
    '4. 删冗优先于扩写：整章长度不得超过原稿的 1.3 倍；',
    '5. 情绪用动作/环境/留白暗示，不直写「他很愤怒」这类结论句；',
    '6. 不要出现这些AI腔：「不禁」「仿佛」「似乎」「嘴角勾起一抹弧度」「心中一凛」「空气仿佛凝固」；',
    '7. 长短句交错，段落不要一律等长。',
].join('\n');

/** 校对系统提示：机械校对，改动越小越好。 */
export const PROOFREAD_SYSTEM = [
    '你是中文小说的机械校对员，只做**低级错误修正**，不做文学性改写。',
    '只允许改这几类：错别字、同音/形近字误用、标点误用（含中英标点混用）、量词/称谓不一致、明显衍字漏字。',
    '硬要求：',
    '1. 只输出校对后的整章正文，不要任何解释、清单、Markdown 代码围栏；',
    '2. **首行标题原样保留**；',
    '3. **不许改动句式、语序、用词风格**——即使你觉得原文写得不好，也不许动；',
    '4. 总改动量应小于全章的 5%；不确定的地方一律保留原文。',
].join('\n');

/** 把病灶清单渲染成提示词里的条目（没有病灶时给一句兜底）。 */
function renderIssues(issues) {
    if (!Array.isArray(issues) || issues.length === 0) return '（未提供病灶清单，按通用修订标准处理）';
    return issues.map((it) => {
        const where = it.paragraph !== undefined ? `¶${it.paragraph}` : '全章';
        const detail = Array.isArray(it.issues) ? it.issues.join('；') : String(it.issues ?? '');
        return `- ${where}（${it.chars ?? '?'} 字，AI味 ${it.aiScore ?? '?'}）：${detail}`;
    }).join('\n');
}

/** 润色提示词（纯函数，可单测）。 */
export function buildPolishPrompt({ chapter, title, content, issues, forbidden }) {
    const parts = [
        `【第 ${chapter} 章】${title ?? ''}`.trim(),
        '',
        '【病灶清单】',
        renderIssues(issues),
    ];
    if (Array.isArray(forbidden) && forbidden.length > 0) {
        parts.push('', '【本章禁项（不得出现）】', forbidden.map((f) => `- ${f}`).join('\n'));
    }
    parts.push('', '【原稿】', String(content ?? ''));
    return parts.join('\n');
}

/** 校对提示词（纯函数，可单测）。 */
export function buildProofreadPrompt({ chapter, title, content }) {
    return [
        `【第 ${chapter} 章】${title ?? ''}`.trim(),
        '',
        '【原稿】',
        String(content ?? ''),
    ].join('\n');
}

/**
 * 从模型输出里抠出正文。
 *
 * 模型爱加东西：代码围栏、`以下是润色后的正文：` 这类前言、章末的「改写说明」。
 * 这里只做**保守**清理（围栏 + 短前言），不做脑补——切错了会被守卫拦下，
 * 比悄悄吞掉半章安全。
 */
export function extractChapterText(raw, original) {
    let text = String(raw ?? '').replace(/\r\n/g, '\n').trim();
    if (text === '') return '';
    // 代码围栏：取最长的一个围栏块
    const fences = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
    if (fences.length > 0) {
        const longest = fences.map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
        if (longest.trim() !== '') text = longest.trim();
    }
    // 短前言：`以下是润色后的正文：` / `改写如下：`
    const lines = text.split('\n');
    const head = lines[0]?.trim() ?? '';
    const looksLikePreamble = head.length <= 30
        && /[:：]$/.test(head)
        && /(以下|如下|正文|润色|校对|修订|结果|输出)/.test(head);
    if (looksLikePreamble) {
        text = lines.slice(1).join('\n').trim();
    }
    // 抽取健全性闸（真机 2026-09-21 实锤）：推理模型无围栏输出时，兜底会把整段原始
    // 响应（英文推理链 + 正文）当正文入库——提案 59KB、中文占比 0.24。润色/校对的
    // 合法产出不可能比原文长 3 倍、也不可能中文占比 <50%：命中即判「无可抽取正文」，
    // 走 EMPTY_AFTER_EXTRACT 干净报错，绝不入库。
    if (typeof original === 'string' && original.trim() !== '') {
        const cjk = (x) => (x.match(/[\u4e00-\u9fff]/g) ?? []).length;
        if (text.length > original.length * 3) return '';
        if (cjk(text) < cjk(original) * 0.5) return '';
        if (cjk(text) / Math.max(text.length, 1) < 0.5) return '';
    }
    return text.trim();
}

/** 两种工序的守卫档案。校对严得多——它不该改结构。 */
export const GUARD_PROFILES = {
    polish: { growthLimit: 1.3, paraGrowthLimit: 2, minSim: 0.4, massRewriteRatio: 0.4 },
    proofread: { growthLimit: 1.06, paraGrowthLimit: 1.15, minSim: 0.72, massRewriteRatio: 0.2 },
};

const RECIPES = {
    polish: {
        channel: 'polish', system: POLISH_SYSTEM, buildPrompt: buildPolishPrompt,
        guard: GUARD_PROFILES.polish, label: '润色',
    },
    proofread: {
        channel: 'proofread', system: PROOFREAD_SYSTEM, buildPrompt: buildProofreadPrompt,
        guard: GUARD_PROFILES.proofread, label: '机械校对',
    },
};

/**
 * 跑一次修订工序：引擎调用 → 抠正文 → 保守守卫 → 落提案。
 *
 * **永远不落正文**：产物一律是提案，用户到面板点「应用」才生成新版本。
 * 这是第一批 A1 定下的规矩，旁路调用不能成为绕过它的后门。
 *
 * @returns {ok, mode, chapter, chars, deltaChars, proposalId?, warnings, blocked?, error?, attempts, route, usage}
 */
export async function runRevisionTask(engine, io, book, {
    mode = 'polish', chapter, title, content, issues, forbidden, signal, onDelta, actor = 'user', sessionId, sessionCandidates,
}) {
    const recipe = RECIPES[mode];
    if (recipe === undefined) throw new Error(`未知工序「${mode}」（可用：${Object.keys(RECIPES).join('、')}）`);
    const original = String(content ?? '');
    if (original.trim() === '') throw new Error(`第${chapter}章正文为空，无需${recipe.label}`);

    const prompt = recipe.buildPrompt({ chapter, title, content: original, issues, forbidden });
    const result = await engine.run(recipe.channel, {
        system: recipe.system, prompt, signal, onDelta, sessionId, sessionIds: sessionCandidates,
    });
    if (!result.ok) {
        return {
            ok: false, mode, chapter, attempts: result.attempts, route: result.route,
            error: result.error, warnings: [],
        };
    }

    const edited = extractChapterText(result.text, original);
    if (edited === '') {
        return {
            ok: false, mode, chapter, attempts: result.attempts, route: result.route,
            error: { code: 'EMPTY_AFTER_EXTRACT', message: '模型输出里没有可用的正文（可能只回了说明文字）', advice: '重发一次；若稳定复现，换模型或缩短病灶清单' },
            warnings: [],
        };
    }

    const guard = validatePolishEdits(original, edited, recipe.guard);
    if (!guard.ok) {
        return {
            ok: false, mode, chapter, attempts: result.attempts, route: result.route,
            chars: guard.stats.editedChars, deltaChars: guard.stats.editedChars - guard.stats.origChars,
            blocked: guard.blocking, warnings: guard.warnings,
            error: {
                code: 'GUARD_BLOCKED',
                message: `保守编辑守卫拦下了${recipe.label}结果：${guard.blocking.map((b) => b.message).join('；')}`,
                advice: '这通常说明模型改超纲了（动了标题或写错形近字）——重发一次，或改用在聊天里逐段处理',
            },
        };
    }

    const created = await submitRevisionProposal(io, book, {
        chapter, content: edited, reason: `${recipe.label}（旁路引擎）`, actor,
    });

    return {
        ok: true, mode, chapter, attempts: result.attempts, route: result.route,
        usage: result.usage,
        chars: guard.stats.editedChars,
        deltaChars: guard.stats.editedChars - guard.stats.origChars,
        introducedConfusables: guard.stats.introducedConfusables,
        proposalId: created.id,
        warnings: guard.warnings.map((w) => w.message),
    };
}

/** 供 REST 层预取病灶清单（润色提示词要用）。 */
export function polishIssues(content, { top = 8 } = {}) {
    return analyzeParagraphs(content, { top }).paragraphs;
}

// ── 打标（G1 路线 C：把「语义」外包给已有的 ctx.llm，不新增任何配置项）──────────
//
// 为什么不做 embedding：宿主的 `ModelModalityMap` 只有 text|image，**没有 embedding 模态**，
// 真语义检索必须另配一个 provider + 向量存储 + 阈值调参 —— 那是货真价实的新配置。
// 打标是折中：入索引时为每块生成 3–5 个「事件/人物/地点/物件」标签，与正文一起进 FTS5。
// 查询「决斗」就能召回正文里只写了「刀收回袖中」的那一段。

/** 打标系统提示：只出标签，不要句子。 */
export const ANNOTATE_SYSTEM = [
    '你是小说检索索引的标注员。为给定正文片段生成 3-5 个检索标签，供作者日后用碎片记忆找回这一段。',
    '硬要求：',
    '1. 只输出标签，用空格分隔，不要编号、不要解释、不要标点、不要 Markdown；',
    '2. 标签各 2-6 个汉字，覆盖四类：**人物**、**地点/物件**、**事件/动作**、**情绪/氛围**；',
    '3. 用正文里出现的词，或读者自然会用来找这一段的词（例如「雪夜」「决斗」「飞刀」「送别」）；',
    '4. 不要复述整句，不要输出超过 5 个标签。',
].join('\n');

/** 打标提示词（纯函数）。 */
export function buildAnnotatePrompt(text) {
    return `正文片段：\n${String(text ?? '')}`;
}

/** 解析标签行：空格/逗号/顿号分隔，去重、限长、至多 5 个。 */
export function parseTags(raw) {
    const parts = String(raw ?? '')
        .replace(/[，、,;；/|]+/g, ' ')
        .split(/\s+/)
        .map((t) => t.replace(/^[-*\d.、]+/, '').trim())
        .filter((t) => t.length >= 2 && t.length <= 8);
    return [...new Set(parts)].slice(0, 5);
}

/**
 * 跑一次打标。
 * @returns {{ok, tags, error?, attempts}}
 */
export async function runAnnotateTask(engine, text, { signal } = {}) {
    const result = await engine.run('annotate', {
        system: ANNOTATE_SYSTEM, prompt: buildAnnotatePrompt(text), signal,
    });
    if (!result.ok) return { ok: false, tags: [], error: result.error, attempts: result.attempts };
    const tags = parseTags(result.text);
    if (tags.length === 0) {
        return { ok: false, tags: [], attempts: result.attempts, error: { code: 'NO_TAGS', message: '模型没有产出可用的标签', advice: '重发一次；若稳定复现，换模型' } };
    }
    return { ok: true, tags, attempts: result.attempts };
}

/**
 * 给一批待打标的块补上语义标签（**内容指纹缓存**版）。
 *
 * 降本从哪来（对齐竞品 A 的「节点级缓存指纹」：同样的输入不重复调模型）：
 *   ① **缓存命中**——这段文字以前打过标，标签直接写回，**零模型调用**；
 *   ② **同文本合并**——本批里出现同样的文字（书里重复段落、跨章相似段落），
 *      只调一次模型，其余块复用它的标签。
 *
 * 什么时候这两种情况常见：
 *   · 重建索引（删库重跑 build）后补标——标签从缓存回填，一分钱不花；
 *   · 改了一章正文又改回来——同一段文字的标签还在；
 *   · 批量起草完一次性补标——各章模板化的对白、开场句往往是同一段文字。
 *
 * 缓存是**旁路**：缓存读不到就照常调模型，绝不因为缓存坏了就打不出标。
 *
 * @param rows [{ ch, seq, text }]
 * @param maxCalls   最多调模型几次（缓存命中与同文本合并**不计入**——它们不花钱）
 * @param maxFailures 连续失败几次就停（模型异常时别把额度烧完）
 * @returns {{annotated, reused, calls, deduped, failures: string[]}}
 *   annotated 打上标的块数（含复用的）
 *   reused    缓存命中、没花模型调用的块数
 *   calls     真正调了模型的次数
 *   deduped   同文本合并（复用同批代表块标签）的块数
 */
export async function annotateChunks({ db, engine, rows, signal, maxCalls = Infinity, maxFailures = 2, maxTotalFailures = Infinity }) {
    const list = Array.isArray(rows) ? rows : [];
    const failures = [];
    if (list.length === 0) return { annotated: 0, reused: 0, calls: 0, deduped: 0, failures };

    // 行形状有两种：`untaggedChunks` 出来的行是 {ch, seq, text}，`chunkChapter` 出来的块是
    // {chapter, seq, text, ...}。两种都得能用——写死一种形状，调用方换个来源就静默写错块。
    const chOf = (row) => (row?.ch !== undefined ? row.ch : row?.chapter);

    const cache = readTagCacheForTexts(db, list.map((r) => r?.text ?? ''));
    const plan = planAnnotations(list, cache);

    let annotated = 0;
    let reused = 0;
    let calls = 0;
    let deduped = 0;

    // ① 缓存命中：直接写回，一次模型调用都不花
    for (const hit of plan.hits) {
        if (setChunkTags(db, chOf(hit.row), hit.row.seq, hit.tags)) { annotated += 1; reused += 1; }
    }

    // ② 未命中：逐个调模型
    const produced = new Map(); // fp → 标签（本批现打的，供同文本块复用）
    let consecutiveFailures = 0;
    for (const miss of plan.misses) {
        if (calls >= maxCalls) break;
        calls += 1;
        const r = await runAnnotateTask(engine, miss.row.text, { signal });
        if (!r.ok) {
            failures.push(`第${chOf(miss.row)}章#${miss.row.seq}：${r.error?.message ?? '打标失败'}`);
            consecutiveFailures += 1;
            if (consecutiveFailures >= maxFailures) break; // 连续失败就别烧钱了
            if (failures.length >= maxTotalFailures) break; // 累计失败也别烧了
            continue;
        }
        consecutiveFailures = 0;
        const tags = r.tags.join(' ');
        produced.set(miss.fp, tags);
        if (setChunkTags(db, chOf(miss.row), miss.row.seq, tags)) annotated += 1;
    }

    // ③ 同文本：复用代表块的标签，不重复调模型
    for (const dup of plan.dupes) {
        const tags = produced.get(dup.fp);
        if (tags === undefined) continue;
        if (setChunkTags(db, chOf(dup.row), dup.row.seq, tags)) { annotated += 1; deduped += 1; }
    }

    return { annotated, reused, calls, deduped, failures };
}

// ── 查询扩写（G1 路线 C 的**查询侧**：弱结果时把记忆碎片改写成多路候选）────────
//
// 打标解决的是「索引词 ≠ 正文词」（标签把「决斗」贴到只写了「刀收回袖中」的段上），
// 解决不了「查询词 ≠ 索引词」：查「师尊陨落」，正文写「真人坐化」、标签写「师父 去世」，
// 三方零重叠 → 零召回。扩写把查询也外包给模型：弱结果时把记忆碎片改写成 3-5 个
// 候选检索词（同义/上下位/换角度），逐路词法检索后合并重排——索引不用动，成本是
// 弱查询时的一次小调用（annotate 通道同款短任务预算）。

/** 扩写系统提示：只出检索词，每行一个。 */
export const EXPAND_SYSTEM = [
    '你是小说检索索引的查询扩写器。作者的检索词是「记忆碎片」，用词可能与正文不同。',
    '任务：为它改写 3-5 个候选检索词，帮助在书稿全文索引里召回目标段落。',
    '硬要求：',
    '1. 每行只输出一个检索词，不要编号、不要解释、不要标点、不要 Markdown；',
    '2. 候选要覆盖：同义/近义说法、上下位词（具体⇄笼统）、换角度的描述（人物/事件/物件/地点）；',
    '3. 每个检索词 2-12 个汉字；原词里的人名/地名/物件名原样保留，不要改写；',
    '4. 不要输出原词本身，不要输出问句。',
].join('\n');

/** 扩写提示词（纯函数）。 */
export function buildExpandPrompt(query) {
    return `作者的检索词：\n${String(query ?? '').trim()}`;
}

/** 解析扩写结果：按行/分号切，去编号去重，每条 2-20 字，至多 5 个。 */
export function parseExpandedQueries(raw, { cap = 5 } = {}) {
    const parts = String(raw ?? '')
        .replace(/[，、,;；]+/g, '\n')
        .split(/\r?\n/)
        .map((t) => t.replace(/^[-*\d.、)）]+/, '').trim())
        .filter((t) => t.length >= 2 && t.length <= 20 && !/[？?]/.test(t));
    return [...new Set(parts)].slice(0, cap);
}

/** 跑一次扩写。
 * @returns {{ok, queries, error?, attempts}}
 */
export async function runExpandTask(engine, query, { signal } = {}) {
    const result = await engine.run('expand', {
        system: EXPAND_SYSTEM, prompt: buildExpandPrompt(query), signal,
    });
    if (!result.ok) return { ok: false, queries: [], error: result.error, attempts: result.attempts };
    const queries = parseExpandedQueries(result.text);
    if (queries.length === 0) {
        return { ok: false, queries: [], attempts: result.attempts, error: { code: 'NO_QUERIES', message: '模型没有产出可用的扩写检索词', advice: '重发一次；若稳定复现，换模型' } };
    }
    return { ok: true, queries, attempts: result.attempts };
}

// ── 写后自动打标（把「标签增强」从纯手动变成落盘即跟上）────────────────────
//
// annotate 是独立动作，写章链路只自动续索引不打标——真机上大部分块永远没标签，
// 检索因此常年跑在纯词法档（mode:lexical），语义层形同虚设。落盘后对新块后台补标
// （每章封顶 AUTO_ANNOTATE_CAP 块、连续失败即停），成本有明确的顶，config.search.
// autoAnnotate=false 可整体关掉。打标走 annotate 通道（短任务预算 512 tok / 60s）。

/** 每次落盘最多自动补标几块（新章一般 2-5 块，封顶 4 控成本）。 */
export const AUTO_ANNOTATE_CAP = 4;

/**
 * 对一章的未标块后台补语义标签（走旁路引擎 annotate 通道）。
 * 只开一次句柄、只处理未标的块；连续 2 块失败就停（模型异常时别把额度烧完）。
 *
 * 缓存命中与同文本合并**不计入额度**（它们不调模型）——所以「封顶 4 块」指的是
 * 真正要花模型调用的次数，不是「最多处理 4 块」。
 *
 * @returns {{ok, annotated, reused, calls, deduped, remaining, reason}}
 */
export async function autoAnnotateChapter({ io, p, book, chapter, engine, cap = AUTO_ANNOTATE_CAP }) {
    const opened = await openIndexForBook(io, p);
    if (!opened.ok) {
        return { ok: false, annotated: 0, reused: 0, calls: 0, deduped: 0, remaining: null, reason: opened.reason };
    }
    try {
        // 取数上限放宽到 cap 的 4 倍：**缓存命中不花钱**，多取几块能白捡回标签。
        // 真正花模型调用的次数仍由 maxCalls=cap 兜住（成本上限没松）。
        const pending = untaggedChunks(opened.db, { chapter, limit: cap * 4 });
        if (pending.length === 0) {
            return { ok: true, annotated: 0, reused: 0, calls: 0, deduped: 0, remaining: 0, reason: null };
        }
        const r = await annotateChunks({ db: opened.db, engine, rows: pending, maxCalls: cap });
        const remaining = untaggedChunks(opened.db, { limit: 9999 }).length;
        return {
            ok: true, annotated: r.annotated, reused: r.reused, calls: r.calls, deduped: r.deduped,
            remaining, reason: null,
        };
    } finally {
        // 与手动 annotate 的 L13 同款：中途抛错也必须关掉 sqlite 句柄
        try { opened.db.close(); } catch { /* 已关闭则忽略 */ }
    }
}
