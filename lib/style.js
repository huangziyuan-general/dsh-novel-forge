// lib/style.js — 文笔六维基线（纯函数，零依赖，零模型调用）。
//
// 把「文风跑偏了」变成可对照的数字：对全书各章测六个维度，
// 得到每维 μ±σ 基线带；新章逐维对照，带内 ✓ / 出带 ⚠。
// 灵感来自 dsh-novel-writer（siweina，MIT）的六维测量思路，实现为本插件
// 自己的口径：密度维统一「每千字」，句法维为「小句/句」。
//
// 设计约束（与插件整体一致）：
//   - 只报数不贴标签：这里产出的是测量与偏差，判断留给模型/人；
//   - 全部启发式可解释，每一维都能说出「为什么这个数」。

/** 密度维的统一分母：每千字。 */
const PER_1K = 1000;

// ── 词表（刻意精简：宁漏勿误，误报比漏报更伤可信度） ────────────────────

/** 模糊限制语（不确定性维度）：叙述犹疑/推测的口癖。 */
const HEDGE_WORDS = [
    '似乎', '仿佛', '好像', '大概', '也许', '或许', '可能', '像是', '隐约', '依稀',
    '差不多', '八成', '兴许', '恍若', '貌似', '好似', '疑似', '说不清', '说不准', '不知怎的',
];

/** 抽象名词后缀（抽象度维度）：以这些字结尾的 2-3 字词多为抽象名词。 */
const ABSTRACT_SUFFIXES = [
    '感', '性', '度', '绪', '念', '意', '命', '运', '缘', '罪',
    '怨', '恨', '哀', '惧', '耻', '愧', '志', '望', '欲', '魂',
    '魄', '灵', '梦', '寂', '寞', '孤', '独', '茫', '惑', '悟',
];

/** 高频动作动词（动作密度维度）：白话叙事的高频具象动作，两字组合不重复计。 */
const ACTION_VERBS = [
    '推', '拉', '抓', '拿', '抱', '举', '抬', '踢', '踩', '打', '拍', '敲', '砸',
    '扔', '丢', '接', '递', '握', '捏', '拧', '扯', '撕', '拔', '插', '刺', '砍',
    '劈', '割', '放', '摆', '搁', '挂', '贴', '塞', '灌', '倒', '泼', '洒', '翻',
    '卷', '铺', '盖', '叠', '折', '脱', '穿', '戴', '摘', '开', '关', '锁', '按',
    '压', '撞', '碰', '触', '摸', '抚', '揉', '搓', '擦', '抹', '洗', '刷', '扫',
    '挖', '埋', '堆', '修', '补', '缝', '织', '绑', '扎', '蒙', '罩', '捂', '挡',
    '遮', '掩', '藏', '躲', '避', '逃', '追', '赶', '跑', '奔', '冲', '闯', '跨',
    '跳', '爬', '攀', '登', '降', '升', '沉', '浮', '荡', '摇', '晃', '抖', '颤',
    '停', '立', '坐', '躺', '跪', '蹲', '站', '靠', '趴', '转', '回', '返', '退',
    '落', '哭', '笑', '喊', '叫', '嚷', '吼', '骂', '斥', '叹', '喘', '吞', '咬',
    '舔', '嗅', '闻', '听', '看', '望', '瞧', '盯', '瞪', '瞥', '瞟', '瞄', '读',
    '写', '画', '刻', '雕', '铸', '炼', '烧', '煮', '炒', '炸', '烤', '倒', '嚼',
    '喝', '饮', '咽', '吐', '泼', '淌', '涌', '冒', '射', '溅', '裂', '碎', '破',
    '赢', '输', '借', '还', '付', '收', '送', '寄', '交', '夺', '抢', '偷', '盗',
    '搜', '查', '寻', '找', '觅', '探', '挣', '搏', '抗', '防', '守', '护', '救',
    '帮', '扶', '领', '引', '教', '训', '激', '鼓', '振', '挥', '攥', '拎', '扛',
    '扛', '挑', '担', '撬', '戳', '扒', '掏', '摸', '拂', '掸', '扑', '扇', '燃',
    '焚', '灼', '烫', '熬', '烹', '拌', '搅', '咽', '啃', '吮',
];

/** 动态助词：动词后缀上这些字视为动作完成/进行（「她推开门」型）。 */
const DYNAMIC_PARTICLES = '了着过起住上下进出开完掉';

/** 「X地」排除表：这些「地」结尾是名词词素，不算修饰语。 */
const DI_NOUN_ENDINGS = new Set([
    '地上', '地下', '地方', '土地', '地面', '地区', '地位', '地铁', '地图', '地板',
    '地道', '地理', '地球', '地域', '地点', '地址', '原地', '当地', '特地', '墓地',
    '产地', '场地', '落地', '阵地', '田地', '旱地', '湿地', '耕地', '草地', '雪地',
    '山地', '坡地', '林地', '园地', '荒地', '宝地', '圣地', '禁地', '腹地', '属地',
    '领地', '封地', '外地', '洼地', '谷地', '泥地', '大地', '平地', '内地', '目的地',
]);

// ── 基础切分 ─────────────────────────────────────────────────────────────

/** 切句：按句末标点切分；剥 Markdown 标题行；连续句末符不拆残片。 */
export function splitSentences(text) {
    return String(text ?? '')
        .replace(/^#{1,6}[ \t]+[^\n]*\n?/gm, '')
        .split(/(?<=[。！？!?])(?![。！？!?])\s*|\n+/)
        .map((s) => s.replace(/[”」』’"']+$/, '').trim())
        .filter((s) => s.length > 0 && !/^[。！？!?]+$/.test(s));
}

/** 非空白字符数（测量分母口径）。 */
function countChars(text) {
    return text.replace(/\s/g, '').length;
}

/** 统计词串出现次数（子串计数，够用即可）。 */
function countOccurrences(text, word) {
    let n = 0;
    let i = text.indexOf(word);
    while (i !== -1) {
        n += 1;
        i = text.indexOf(word, i + word.length);
    }
    return n;
}

// ── 六维测量 ─────────────────────────────────────────────────────────────

/**
 * 对一段正文测六个维度。
 * 句法复杂度 = 小句/句；其余五维 = 每千字命中数。
 * 返回 { chars, sentences, syntax, modifier, abstract, action, hedging, blank }。
 */
export function measureStyleMetrics(text) {
    const raw = String(text ?? '');
    const t = raw.replace(/^#{1,6}[ \t]+[^\n]*\n?/gm, '');
    const chars = countChars(t);
    const sentences = splitSentences(t);
    const per1k = (n) => (chars > 0 ? (n / chars) * PER_1K : 0);

    // 1) 句法复杂度：逗号/分号/冒号分隔的小句，平均每句几个
    let clauses = 0;
    for (const s of sentences) {
        clauses += s.split(/[，、；：,;:]/).filter((p) => p.trim() !== '').length;
    }
    const syntax = sentences.length > 0 ? clauses / sentences.length : 0;

    // 2) 修饰密度：「X的」「X地」（X 为单字，且排除名词词素「X地」）
    let modifier = 0;
    for (const m of t.matchAll(/([\u4e00-\u9fff])的/g)) modifier += 1;
    for (const m of t.matchAll(/([\u4e00-\u9fff])地/g)) {
        if (!DI_NOUN_ENDINGS.has(`${m[1]}地`)) modifier += 1;
    }

    // 3) 抽象度：以抽象后缀结尾的双字词（穷举二字窗口代价高，滑窗匹配）
    let abstractHits = 0;
    for (const m of t.matchAll(/([\u4e00-\u9fff]{2,3})/g)) {
        const w = m[1];
        if (w.length === 2 && ABSTRACT_SUFFIXES.includes(w[1])) abstractHits += 1;
        else if (w.length === 3 && ABSTRACT_SUFFIXES.includes(w[2])) abstractHits += 1;
    }

    // 4) 动作密度：动作动词命中（+1）；动词后跟动态助词再计一次完成态
    let actionHits = 0;
    const seen = new Set();
    for (const v of ACTION_VERBS) {
        if (seen.has(v)) continue;
        seen.add(v);
        let i = t.indexOf(v);
        while (i !== -1) {
            actionHits += 1;
            if (DYNAMIC_PARTICLES.includes(t[i + v.length] ?? '')) actionHits += 1;
            i = t.indexOf(v, i + v.length);
        }
    }

    // 5) 不确定性：模糊限制语命中
    let hedging = 0;
    for (const w of HEDGE_WORDS) hedging += countOccurrences(t, w);

    // 6) 留白指数：省略号 + 破折号（每千字），外加未完句占比加权
    const ellipsis = (t.match(/……|\.\.\.|…/g) ?? []).length;
    const dash = (t.match(/——|——/g) ?? []).length;
    const unfinished = sentences.filter((s) => /[—…]$/.test(s)).length;
    const blankBase = per1k(ellipsis + dash);
    const blank = sentences.length > 0 ? blankBase + (unfinished / sentences.length) * 10 : blankBase;

    return {
        chars,
        sentences: sentences.length,
        syntax: round2(syntax),
        modifier: round2(per1k(modifier)),
        abstract: round2(per1k(abstractHits)),
        action: round2(per1k(actionHits)),
        hedging: round2(per1k(hedging)),
        blank: round2(blank),
    };
}

// ── 基线与判定 ───────────────────────────────────────────────────────────

export const STYLE_DIMENSIONS = [
    { key: 'syntax', label: '句法复杂度', unit: '小句/句' },
    { key: 'modifier', label: '修饰密度', unit: '次/千字' },
    { key: 'abstract', label: '抽象度', unit: '词/千字' },
    { key: 'action', label: '动作密度', unit: '次/千字' },
    { key: 'hedging', label: '不确定性', unit: '次/千字' },
    { key: 'blank', label: '留白指数', unit: '混合' },
];

function round2(n) {
    return Math.round(n * 100) / 100;
}

function mean(xs) {
    return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** 总体标准差；单样本返回 null（无波动信息，基线带退化为 ±默认容差）。 */
function stdev(xs) {
    if (xs.length < 2) return null;
    const mu = mean(xs);
    return Math.sqrt(xs.reduce((acc, x) => acc + (x - mu) ** 2, 0) / xs.length);
}

/** 默认容差：1.5σ 相对 μ 的占比，夹在 10%~100%；σ 未知时用 35%。 */
export function defaultTolerance(mu, sigma) {
    if (sigma === null || sigma === undefined || mu === 0) return 35;
    const rel = Math.round((sigma / Math.abs(mu)) * 150);
    return Math.min(100, Math.max(10, rel));
}

/**
 * 从各章测量值算基线：每维 { mu, sigma, tolerance, chapters }。
 * metricsList：measureStyleMetrics 输出的数组（每章一个）。
 */
export function computeBaseline(metricsList) {
    const chapters = metricsList.length;
    const dims = {};
    for (const { key } of STYLE_DIMENSIONS) {
        const xs = metricsList.map((m) => m[key]);
        const mu = round2(mean(xs));
        const sigma = stdev(xs);
        dims[key] = {
            mu,
            sigma: sigma === null ? null : round2(sigma),
            tolerance: defaultTolerance(mu, sigma),
        };
    }
    return { chapters, dims };
}

/**
 * 新章对照基线：逐维给出带内/出带与偏差百分比。
 * baseline：computeBaseline 输出；toleranceOverrides：{ dim: pct } 可选。
 * 返回 { verdict, inBand, deviations, dims }。
 */
export function judgeAgainstBaseline(metrics, baseline, toleranceOverrides = {}) {
    const dims = {};
    const deviations = [];
    let outCount = 0;
    for (const { key, label, unit } of STYLE_DIMENSIONS) {
        const base = baseline.dims[key] ?? { mu: metrics[key], sigma: null, tolerance: 35 };
        const tol = toleranceOverrides[key] ?? base.tolerance;
        const mu = base.mu || 0;
        const devPct = mu !== 0 ? Math.round(((metrics[key] - mu) / Math.abs(mu)) * 100) : (metrics[key] > 0 ? 100 : 0);
        const inBand = Math.abs(devPct) <= tol;
        if (!inBand) {
            outCount += 1;
            deviations.push({ dim: key, label, unit, value: metrics[key], mu, deviationPct: devPct, tolerance: tol });
        }
        dims[key] = {
            value: metrics[key], mu, sigma: base.sigma, tolerance: tol,
            deviationPct: devPct, inBand,
        };
    }
    deviations.sort((a, b) => Math.abs(b.deviationPct) - Math.abs(a.deviationPct));
    const verdict = outCount === 0 ? 'in_band' : outCount <= 2 ? 'minor_drift' : 'drift';
    return { verdict, outCount, inBand: outCount === 0, deviations, dims };
}
