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
export function computeAudit({ content, previous = [], terms = [], castNames = [] }) {
    // castNames（0.19.1，E4）：missing 判定对人物名放宽——全名不在但去姓短称
    // （≥2 字）在正文出现也算覆盖（对话惯例用短称「小满」，全名「陈小满」整章
    // 不出现是常态，逐字 includes 判它 missing 是系统性误报）。
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
    // 0.19.2（引号规范）：对话占比只认中文双引号 " / " 与直引号 "（横排小说的合规引号）。
    // 直角引号「『』」不算对话——它只出现在竖排版，横排小说用了会被 AI 检测工具
    // 当生成残留特征抓（直角引号出现率是常见的 AI 创作判据之一）。
    const QUOTE_RE = /["“"]/;
    const dialogueLines = lines.filter((l) => QUOTE_RE.test(l)).length;
    const dialogueChars = lines.filter((l) => QUOTE_RE.test(l)).join('').replace(/\s/g, '').length;

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

    // 0.19.1（E4）：人物名缺失判定放宽——全名不在，但去姓短称（≥2 字）在正文出现
    // 也算覆盖。仅对 castNames 里的名字生效（世界书关键词不享受放宽）。
    const nickIndex = new Map();
    for (const nm of castNames ?? []) {
        if (typeof nm === 'string' && nm.length >= 3 && !nickIndex.has(nm)) nickIndex.set(nm, nm.slice(1));
    }
    const missingTerms = terms.filter((t) => {
        if (t === '' || clean.includes(t)) return false;
        const nick = nickIndex.get(t);
        return !(nick !== undefined && clean.includes(nick));
    });

    // 0.19.0：英文残留检测——《开局觉醒加特林》50 章「把残页folded好」实证。中文连载正文
    // 出现连续 ≥4 个外文字母几乎必是生成残留（承诺书明确无系统/面板元素的书没有英文专名位）。
    // 0.19.1（E7）：扩到拉丁扩展/希腊/西里尔——真机第 5 章西里尔词「самая」漏检实证，
    // 生成污染不挑字母表。只报 ≥4 连续字母：A 股、X 光、维生素 C 这类合法单双字母不误伤。
    const latinRuns = clean.match(/[A-Za-z\u00C0-\u024F\u0370-\u04FF]{4,}/g) ?? [];

    // 0.19.2（引号规范）：直角引号「『』」检测。横排小说正文合规引号是中文双引号 "…"/"…"，
    // 直角引号只用于竖排版；很多 AI 检测工具把「直角引号出现率」当生成残留特征，
    // 用了会被判"疑似 AI 创作"。computeAudit 只**统计**命中次数（纯函数，不判定），
    // 是否阻断/警告由 auditVerdict 的 quoteStyle 配置决定（与 latinRuns 同款"可自救"语义：
    // 把「」全局替换成 "" 即过，不会死锁）。
    const cornerQuotes = (clean.match(/[「」『』]/g) ?? []).length;

    // 0.20.0（真机《夜半来客》第 6 章险情）：元叙述（破墙）词检测——模型补写时写出
    // 「他让小满扶好，故事本该这么写」级别的句子，noai/机审六维都抓不住（语义层事故
    // 只有人工自查能拦）。把最常见的破墙词列成启发式：命中只**统计**进 audit，
    // verdict 层出 warning（引用合理语境如话本体「看官」不算——词表避开它）。
    const metaNarrative = (clean.match(/本章|这一章|下一章|这个故事|读者|作者/g) ?? []).length;

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
        cornerQuotes,
        metaNarrative,
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
 * @param config { minChapterChars, maxChapterChars, quoteStyle? }
 *   quoteStyle（0.19.2）：直角引号「『』」判定策略。
 *   · 'block'（默认）：正文出现「」『』→ 阻断（problems），可自救（全局替换成 "" 即过，
 *     与英文残留同款"可过即不落"语义，不设 force 通道也不会死锁）；
 *   · 'warn'：只提示不阻断（warnings）；
 *   · 'off'：不判（存量书 / 确实要竖排引号的场景显式关）。
 * @param extra { paragraphChars?: number[] } 驳回文案用的段落分布（chapter-commit 传入；
 *   省略时文案退化为不带分布——向后兼容）。
 */
export function auditVerdict(audit, { minChapterChars, maxChapterChars, quoteStyle = 'block' } = {}, extra = {}) {
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
    // 0.19.2（引号规范）：直角引号「『』」判定。横排小说合规引号是中文双引号 "…"，
    // 直角引号只用于竖排版，且是 AI 检测工具常用的"生成残留"特征——出现了就改，不让落盘。
    // block（默认）进 problems（可自救：全局替换即过，不产生熔断死锁）；warn 进 warnings；off 不判。
    if ((audit.cornerQuotes ?? 0) > 0) {
        const msg = `正文 ${audit.cornerQuotes} 处直角引号（「」『』）——横排小说统一用中文双引号（“…”），直角引号是竖排版/AI 生成特征，全局替换后即过`;
        if (quoteStyle === 'warn') warnings.push(msg);
        else if (quoteStyle !== 'off') problems.push(msg);
    }
    if (audit.chars >= minChapterChars && audit.paragraphCount < 3) problems.push(`段落数 ${audit.paragraphCount} 过少——不是一整块墙`);
    // 达到下限但未达目标：**非阻断**提醒（不是驳回）。篇幅长期贴着下限会让连载显得单薄。
    if (audit.chars >= minChapterChars && audit.chars < target) {
        warnings.push(`正文 ${audit.chars} 字，已过下限但未达目标 ${target} 字左右（还差约 ${target - audit.chars} 字）——本章已保存，下章尽量写足`);
    }
    if (audit.endingHook.detected === false) warnings.push('章末未检出语义钩子（问句/悬念/省略/倒计时/预告/打断）——纯感叹号收尾不算钩子（断章公式），建议改写末段');
    // 0.20.0：元叙述（破墙）词——正文中出现「本章/读者/作者」等叙述层泄漏
    if ((audit.metaNarrative ?? 0) > 0) {
        warnings.push(`正文 ${audit.metaNarrative} 处疑似元叙述词（本章/读者/作者等）——小说正文里不该出现叙述层泄漏，请逐处核对并改写`);
    }
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
