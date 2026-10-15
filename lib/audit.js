// lib/audit.js — 确定性章节审计（纯函数，零模型调用）。
// 机审与模型审分离：这里只算「有明确对错」的指标；审稿的口味判断交给模型，
// 但必须引用本审计的数字作证据，压缩「和稀泥」空间。

import { detectHookKind, stripEmphasis } from './hook.js';
import { finiteOr } from './json-numbers.js';

function shingles(text, k = 8) {
    const clean = String(text ?? '').replace(/\s/g, '');
    const set = new Set();
    for (let i = 0; i <= clean.length - k; i += 1) set.add(clean.slice(i, i + k));
    return set;
}

function jaccard(a, b) {
    if (a.size === 0 && b.size === 0) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter += 1;
    return inter / (a.size + b.size - inter);
}

/**
 * @param inputs { content, previous:[{chapter, content}], terms:[string] }
 *   terms = 出场人物名 + 命中世界书关键词（覆盖率检查）。
 */
export function computeAudit({ content, previous = [], terms = [] }) {
    // 字数口径：先剥 markdown 强调标记再数。`**` 是排版不是正文——真机一章 188 个 `*`
    // 被算成 188 字，门禁报「正文 1905 字」而读者实际只看到 1717 字（"还差 95" 是假的，真实差 283），
    // 模型据此以为快过线、继续用小改凑数。下游（段落/句子/对话比/去重 shingle）全部继承这个口径。
    const clean = stripEmphasis(content);
    const chars = clean.replace(/\s/g, '').length;
    const lines = clean.split('\n');
    const paragraphs = clean.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
    const sentences = clean.split(/[。！？!?…]+/).map((s) => s.trim()).filter((s) => s.length > 0);

    // 直引号（U+0022）必须计入：插件自己的写作规矩就是对话用直引号——
    // 真机导入书 226 个直引号、0 个弯引号、0 个「」，四章对话占比全报 0%，
    // 连带番茄平台审查「对话占比 15%–45%」直接判失败（平台分数被假指标拖垮）。
    const dialogueLines = lines.filter((l) => /[「“"]/.test(l)).length;
    const dialogueChars = lines.filter((l) => /[「“"]/.test(l)).join('').replace(/\s/g, '').length;

    // 章末钩子启发式（共享 hook.js）
    // 输出契约：缺省字段必须省略键——null/undefined 都会被宿主判 INVALID_TOOL_OUTPUT。
    const kind = detectHookKind(clean);
    const hook = kind !== null ? { detected: true, kind } : { detected: false };

    // 与前文重复：8 字 shingle 的最大 Jaccard。两侧 shingle 集合都为空时 jaccard 是
    // 0/0 = NaN（空正文对照空正文），Math.round(NaN) 仍是 NaN → 进输出被宿主
    // lossless 校验整次拒收——铸造统一过 lib/json-numbers.js 的 finiteOr。
    const mine = shingles(clean);
    let worst = null;
    for (const prev of previous) {
        const score = jaccard(mine, shingles(prev.content));
        if (worst === null || score > worst.jaccard) worst = { chapter: prev.chapter, jaccard: finiteOr(score, 3) };
    }

    const missingTerms = terms.filter((t) => t !== '' && !clean.includes(t));

    // 0.19.0：英文残留检测——《开局觉醒加特林》50 章「把残页folded好」实证。中文连载正文
    // 出现连续 ≥4 个英文字母几乎必是生成残留（承诺书明确无系统/面板元素的书没有英文专名位）。
    // 只报 ≥4 连续字母：A 股、X 光、维生素 C 这类合法单双字母不误伤。
    const latinRuns = clean.match(/[A-Za-z]{4,}/g) ?? [];

    return {
        chars,
        paragraphCount: paragraphs.length,
        avgParagraphChars: paragraphs.length === 0 ? 0 : Math.round(chars / paragraphs.length),
        sentenceCount: sentences.length,
        dialogueRatio: chars === 0 ? 0 : Math.round((dialogueChars / chars) * 100) / 100,
        endingHook: hook,
        repetition: worst ?? { jaccard: 0 },
        coverage: { terms: terms.length, missing: missingTerms },
        latinRuns,
    };
}

/**
 * 各段非空白字数（与 chars 逐段同口径：先剥强调标记，再按空行分段去空白）。
 * 字数驳回时随文案给出段落级分布：真机三章全靠 2–3 版**整章重发**才过下限，
 * 单轮输出预算就是这么烧穿的——给分布，模型才能定向补。
 */
export function paragraphCharProfile(content) {
    return stripEmphasis(content)
        .split(/\n\s*\n/)
        .map((p) => p.replace(/\s/g, '').length)
        .filter((n) => n > 0);
}

/**
 * 本章目标字数（上下限中值取整到百位）——全项目唯一口径。
 * 细纲 / 写前简报 / 驳回文案 / 批量起草必须共用它：真机细纲里模型自写「硬线 2000·目标 2200+」，
 * 驳回文案却写「本章目标 3000 字左右」，模型同时收到两个打架的数字，只能瞎猜。
 * 纯函数。
 */
export function chapterCharTarget({ minChapterChars, maxChapterChars }) {
    return Math.round((minChapterChars + maxChapterChars) / 2 / 100) * 100;
}

/**
 * 过线余量：模型对中文字数没有可靠自查，锚在精确下限会反复卡在
 * 1986/1994/1998 这种贴线值（真机全书 242 次字数驳回，最极端只差 2 字）。
 * 驳回文案与 novel_write_chapter 的自查提示共用本常量：让模型补到 ≥min+margin
 * 稳过下限；门禁本身仍按 minChapterChars 判定，不放松约束。
 */
export const CHAR_MARGIN = 100;

/**
 * 定向补字配额：挑最薄的几段，把差额均摊成「第 N 段 +X 字」的清单。
 * 为什么不能只说「加厚最薄的几段」：真机模型收到分布后照样整章重写
 * （1069→1124→1330→…→1905，十次才挪到 1905，末次只 +20），它对字数无感、越改越饱和。
 * 带段号与具体数字的清单才可执行。纯函数。
 * @returns null（无可加厚的段）/ { quota, items:[{no,n}] }
 */
export function thickenQuota(profile = [], deficit = 0, { maxPick = 5, maxParagraphChars = 150 } = {}) {
    if (!Array.isArray(profile) || deficit <= 0) return null;
    const thin = profile
        .map((n, i) => ({ no: i + 1, n }))
        .filter((x) => x.n < maxParagraphChars)
        .sort((a, b) => a.n - b.n || a.no - b.no)
        .slice(0, maxPick);
    if (thin.length === 0) return null;
    // 配额取整到十位：给模型「+60 字」这种整数比「+57 字」好执行
    return { quota: Math.max(10, Math.ceil(deficit / thin.length / 10) * 10), items: thin };
}

/**
 * 机审判定（写章门禁第二道：内容合格线）。
 * @param config { minChapterChars, maxChapterChars }
 * @param extra { paragraphChars?: number[] } 驳回文案用的段落分布（chapter-commit 传入；
 *   省略时文案退化为不带分布——向后兼容）。
 */
export function auditVerdict(audit, { minChapterChars, maxChapterChars }, extra = {}) {
    const problems = [];
    const warnings = [];
    // 目标字数：全项目唯一口径（chapterCharTarget，与 briefing / 细纲工具描述同源）。
    // 驳回文案必须带「还差多少 + 目标多少」——只说「低于下限 2000」模型无从下手（真机 89/102 次驳回都是这条）。
    const target = chapterCharTarget({ minChapterChars, maxChapterChars });
    // 过线余量见模块级 CHAR_MARGIN（驳回文案与写章自查提示共用）。
    if (audit.chars < minChapterChars) {
        const deficit = minChapterChars - audit.chars;
        // 段落分布封顶前 24 段：再多模型会整条忽略（同 coverage 前 10 项的逻辑）。
        const profile = Array.isArray(extra.paragraphChars) ? extra.paragraphChars : [];
        const shown = profile.slice(0, 24);
        const more = profile.length - shown.length;
        const dist = shown.length > 0
            ? `；各段字数：${shown.join('/')}${more > 0 ? `…（共 ${profile.length} 段）` : ''}`
            : '';
        // 可执行的补字配额（带段号 + 每段加多少）；拿不到分布时退化为旧文案
        const quota = thickenQuota(profile, deficit + CHAR_MARGIN);
        const hint = quota
            ? `；定向补字配额——照这个补：第 ${quota.items.map((x) => x.no).join('/')} 段各 +${quota.quota} 字（现在分别 ${quota.items.map((x) => x.n).join('/')} 字，都是短句），补到 ≥${minChapterChars + CHAR_MARGIN} 字（留 ${CHAR_MARGIN} 字余量，别只卡 ${minChapterChars} 线）即稳妥过线，不必整章重写`
            : `；对照分布定向加厚最薄的几段，补到 ≥${minChapterChars + CHAR_MARGIN} 字（留 ${CHAR_MARGIN} 字余量）即稳妥过线，不必整章重写`;
        problems.push(`正文 ${audit.chars} 字，低于下限 ${minChapterChars}（建议补到 ≥${minChapterChars + CHAR_MARGIN} 字，留 ${CHAR_MARGIN} 字余量；本章目标 ${target} 字左右）——把细纲里的场景写细写透（动作/环境/对话拉满），不要注水凑字${dist}${hint}`);
    }
    if (audit.chars > maxChapterChars) problems.push(`正文 ${audit.chars} 字，超过上限 ${maxChapterChars}（拆章或扩写细纲）`);
    if (audit.repetition.jaccard >= 0.35) problems.push(`与第${audit.repetition.chapter}章高度重复（8字重合率 ${audit.repetition.jaccard}）——查跨章复读`);
    // 0.19.0：英文残留阻断（可自救——删掉英文词即过，不设 force 通道也不会死锁）
    if ((audit.latinRuns?.length ?? 0) > 0) {
        const shown = audit.latinRuns.slice(0, 5);
        problems.push(`正文混入英文残留（${shown.join('、')}）——删掉或改为中文表述，机翻/英文草稿痕迹不落盘`);
    }
    if (audit.chars >= minChapterChars && audit.paragraphCount < 3) problems.push(`段落数 ${audit.paragraphCount} 过少——不是一整块墙`);
    // 达到下限但未达目标：**非阻断**提醒（不是驳回）。篇幅长期贴着下限会让连载显得单薄。
    if (audit.chars >= minChapterChars && audit.chars < target) {
        warnings.push(`正文 ${audit.chars} 字，已过下限但未达目标 ${target} 字左右（还差约 ${target - audit.chars} 字）——本章已保存，下章尽量写足`);
    }
    if (audit.endingHook.detected === false) warnings.push('章末未检出语义钩子（问句/悬念/省略/倒计时/打断）——纯感叹号收尾不算钩子（断章公式），建议改写末段');
    if (audit.coverage.terms > 0 && audit.coverage.missing.length > 0) {
        // 只列前 10 项：词表过宽时可能几十条，模型会整条忽略（真机第 69 章列了 50+ 词）。
        const shown = audit.coverage.missing.slice(0, 10);
        const more = audit.coverage.missing.length - shown.length;
        // 「字面未逐字出现」措辞：匹配是字面 includes——同义改写必然误报
        // （真机导入书某章实证），明说以免误导改稿。
        warnings.push(`细纲声明的要素字面未逐字出现（${audit.coverage.missing.length} 项，同义改写不算缺失，请人工判断是否真缺）：${shown.join('、')}${more > 0 ? `…等 ${more} 项` : ''}`);
    }
    return { ok: problems.length === 0, problems, warnings };
}
