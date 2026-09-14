// lib/polish.js — 纯函数：段落级润色病灶定位（AI 味/长段/钩子）。
// 定位→模型改写→走 novel_propose 落提案：润色也不覆盖旧版。

import { scanAiFlavor } from './noai.js';
import { detectHookKind } from './hook.js';

/**
 * 段落级热点扫描：返回有问题的段落及原因，供用户/模型精准修改。
 * 超过 top 条按严重度截断。
 * @returns {chapterHook, paragraphs:[{paragraph,chars,issues[],aiScore}]}
 */
export function analyzeParagraphs(content, { top = 20 } = {}) {
    const text = String(content ?? '');
    const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
    const out = [];
    paras.forEach((p, idx) => {
        const issues = [];
        const chars = p.replace(/\s/g, '').length;
        const ai = scanAiFlavor(p, { topK: 2 });
        if (ai.score >= 30) issues.push(`AI 味偏高（${ai.score}）：${(ai.topIssues[0] ?? '').slice(0, 40)}`);
        if (chars > 220) issues.push(`段落过长（${chars} 字）——考虑拆段或删冗余`);
        if (/^(因为|所以|因此|于是).+，.{5,}。/m.test(p) && chars < 80) issues.push('结论式短句连贯出现，有灌输腔');
        if (issues.length > 0) out.push({ paragraph: idx + 1, chars, aiScore: ai.score, issues });
    });
    out.sort((a, b) => (b.aiScore - a.aiScore) || (b.chars - a.chars));
    return {
        chapterHook: detectHookKind(text),
        paragraphs: out.slice(0, top),
    };
}

// ── 保守编辑守卫（来源：dsh-tool-writing 的 autoproof） ──────────────────────
//
// 润色最大的风险不是「没改好」，而是**改出了新错**：校对模型自作主张重写、
// 把形近字替错、把短句膨胀成长段。tw 的 autoproof 用三条保守规则防这个，
// 我们把它适配成「整章提交」形态的守卫（我们的润色是整章提交而非逐条替换）：
//
//   ① 标题行不得改（首行形似 `第N章`/`# 标题` 时）
//   ② 易混字黑名单：改后引入了原文没有的形近字 → 判定校对自伤（直接拒绝）
//   ③ 长度纪律：整章膨胀超阈值、或单段膨胀超 2 倍+20 → 是重写不是润色
//   ④ 段落对齐：相似度太低 = 整段被换掉；大面积如此 → 疑似重写而非润色
//
// 「可议项只报告不代改」由 analyzeParagraphs 保证（它本来就不改正文）。

/** 高危易混字黑名单：这些字被「顺手改错」的概率极高，且错得隐蔽。 */
export const CONFUSABLE_CHARS = ['恨', '戍', '戌', '柝', '祗', '祇', '菅', '圮'];

function splitParas(text) {
    return String(text ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p !== '');
}

function bigramSet(s) {
    const set = new Set();
    const t = String(s).replace(/\s/g, '');
    for (let i = 0; i < t.length - 1; i += 1) set.add(t.slice(i, i + 2));
    return set;
}

function jaccardSet(a, b) {
    if (a.size === 0 && b.size === 0) return 1;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter += 1;
    return inter / (a.size + b.size - inter);
}

const HEADING_RE = /^(#{1,6}\s|第[0-9一二三四五六七八九十百零]+[章节回])/;

/**
 * 保守编辑守卫：对照原稿审查润色稿，把「可能改错」的地方挑出来。
 * 纯函数，零 token。
 *
 * @param original 磁盘上的原稿
 * @param edited   模型提交的润色稿
 * @param opts { growthLimit=1.3 整章膨胀上限, paraGrowthLimit=2 单段膨胀上限（另有 +20 字宽容）,
 *               minSim=0.4 段落同源阈值, massRewriteRatio=0.4 大面积重写阈值 }
 * @returns { ok, blocking:[...], warnings:[...], risks:[{severity,code,message}], stats }
 *   ok = 无 blocking。blocking 级必须拒绝提交；warnings 级随提案返回给用户看。
 */
export function validatePolishEdits(original, edited, opts = {}) {
    const {
        growthLimit = 1.3, paraGrowthLimit = 2, minSim = 0.4, massRewriteRatio = 0.4,
    } = opts;
    const orig = String(original ?? '');
    const next = String(edited ?? '');
    const risks = [];

    // ① 标题行保护
    const firstLine = (s) => (s.split('\n').find((l) => l.trim() !== '') ?? '').trim();
    const of = firstLine(orig);
    const nf = firstLine(next);
    if (of !== nf && HEADING_RE.test(of)) {
        risks.push({ severity: 'error', code: 'heading-changed', message: `首行标题被改动（「${of}」→「${nf}」）——标题不参与润色，章节名由 novel_write_chapter 管理` });
    }

    // ② 易混字黑名单
    const introduced = CONFUSABLE_CHARS.filter((c) => next.includes(c) && !orig.includes(c));
    if (introduced.length > 0) {
        risks.push({ severity: 'error', code: 'confusable-char', message: `润色稿引入了原文没有的高危易混字「${introduced.join('、')}」——这通常是校对模型自己写错的信号，请逐处核对该字是否用对` });
    }

    // ③ 整章长度纪律
    const oc = orig.replace(/\s/g, '').length;
    const nc = next.replace(/\s/g, '').length;
    if (oc > 0 && nc > oc * growthLimit) {
        risks.push({ severity: 'warning', code: 'chapter-growth', message: `润色稿比原稿多 ${nc - oc} 字（${oc}→${nc}，+${Math.round((nc / oc - 1) * 100)}%）——润色应删冗而不是扩写；确认不是把「重写」当润色交了` });
    }

    // ④ 段落对齐：相似度过低 = 整段被换
    const origParas = splitParas(orig);
    const nextParas = splitParas(next);
    const nextSig = nextParas.map((p) => bigramSet(p));
    const used = new Set();
    let rewritten = 0;
    const grown = [];
    for (const p of origParas) {
        const sig = bigramSet(p);
        let best = { idx: -1, sim: -1 };
        for (let i = 0; i < nextParas.length; i += 1) {
            if (used.has(i)) continue;
            // 长度差距过大的候选直接压分，避免长段抢走短段的匹配
            const sim = jaccardSet(sig, nextSig[i]);
            if (sim > best.sim) best = { idx: i, sim };
        }
        if (best.idx === -1) { rewritten += 1; continue; }
        used.add(best.idx);
        if (best.sim < minSim) {
            rewritten += 1;
            continue;
        }
        const ocp = p.replace(/\s/g, '').length;
        const ncp = nextParas[best.idx].replace(/\s/g, '').length;
        if (ocp > 0 && ncp > ocp * paraGrowthLimit + 20) grown.push(`¶${best.idx + 1}（${ocp}→${ncp} 字）`);
    }
    if (origParas.length >= 5 && rewritten / origParas.length > massRewriteRatio) {
        risks.push({ severity: 'warning', code: 'mass-rewrite', message: `${rewritten}/${origParas.length} 段与原稿几乎无重叠——这是重写而非润色，请确认意图（重写应走 novel_propose 的正常提案）` });
    }
    if (grown.length > 0) {
        risks.push({ severity: 'warning', code: 'paragraph-growth', message: `单段膨胀超 ${paraGrowthLimit} 倍：${grown.slice(0, 3).join('、')}${grown.length > 3 ? ` 等 ${grown.length} 处` : ''}——多半是注水，建议压回去` });
    }

    const blocking = risks.filter((r) => r.severity === 'error');
    return {
        ok: blocking.length === 0,
        blocking,
        warnings: risks.filter((r) => r.severity === 'warning'),
        risks,
        stats: {
            origChars: oc, editedChars: nc, paragraphs: origParas.length,
            rewrittenParagraphs: rewritten, introducedConfusables: introduced,
        },
    };
}