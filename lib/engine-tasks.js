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
export function extractChapterText(raw) {
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
    mode = 'polish', chapter, title, content, issues, forbidden, signal, onDelta, actor = 'user',
}) {
    const recipe = RECIPES[mode];
    if (recipe === undefined) throw new Error(`未知工序「${mode}」（可用：${Object.keys(RECIPES).join('、')}）`);
    const original = String(content ?? '');
    if (original.trim() === '') throw new Error(`第${chapter}章正文为空，无需${recipe.label}`);

    const prompt = recipe.buildPrompt({ chapter, title, content: original, issues, forbidden });
    const result = await engine.run(recipe.channel, {
        system: recipe.system, prompt, signal, onDelta,
    });
    if (!result.ok) {
        return {
            ok: false, mode, chapter, attempts: result.attempts, route: result.route,
            error: result.error, warnings: [],
        };
    }

    const edited = extractChapterText(result.text);
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
