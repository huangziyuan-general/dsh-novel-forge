// lib/gate-metrics.js — 细纲契约指标（纯函数，零 token）。
//
// 来源：peterwangze/dsh-novel-writing 的 `computeGate()`。彼的做法是把「本章必写场景」
// 与「本章禁止偏离项」从看护卡里解析出来，用**代码**算覆盖率与偏离度，落盘到
// `meta.chapters[n].gate`——而不是让模型自报「我检查过了，都写到了」。
//
// 本插件适配与**关键差异**：
//   · 彼的场景段是必需的（缺段 fail-closed 阻断）；本插件的细纲是自由文本，
//     场景段是**可选增强**——不写就不判、不阻断，写了才按代码算。避免老书全部被拦。
//   · 段存在却解析不出任何场景 → 只给警告让用户改格式（不阻断），因为解析器正则
//     对中文格式漂移不可能穷尽，阻断的代价（写不了章）远大于漏判。
//   · 命中禁项 → 由调用方（novel_write_chapter）判 blocking + force 出口。
//
// 指标定义（与彼一致，便于横向对照）：
//   coverage = 命中的必写场景数 / 必写场景总数 × 100（一位小数）
//   drift    = 命中禁项数 / 禁项总数 × 100
//   passed   = coverage === 100 且 禁项零命中

/** 场景段标题别名（按顺序尝试，命中即用）。 */
const SCENE_HEADINGS = ['本章必写场景', '必写场景', '本章场景', '场景清单', '本章场景清单'];
/** 禁项段标题别名。 */
const BAN_HEADINGS = ['本章禁止偏离项', '禁止偏离项', '本章禁止项', '禁止项', '本章禁项', '禁项'];

/** 取 markdown 标题下的正文块（到下一个标题为止）。 */
export function sectionOf(text, headings) {
    const lines = String(text ?? '').split('\n');
    const hit = lines.findIndex((l) => /^#{1,6}\s/.test(l.trim()) && headings.some((h) => l.includes(h)));
    if (hit < 0) return null;
    const block = [];
    for (let i = hit + 1; i < lines.length; i += 1) {
        if (/^#{1,6}\s/.test(lines[i])) break;
        block.push(lines[i]);
    }
    return block.join('\n');
}

/**
 * 解析场景列表。兼容格式漂移：
 *   `1. **标题**：描述` / `- 标题：描述` / `**标题**` / `- [ ] 标题：描述`
 */
export function parseScenes(sectionText) {
    const out = [];
    for (const raw of String(sectionText ?? '').split('\n')) {
        let line = raw.trim();
        if (line === '') continue;
        line = line.replace(/^[-*+]\s+/, ''); // 列表符号
        line = line.replace(/^\[[ xX]\]\s*/, ''); // 复选框
        line = line.replace(/^[（(]?\s*\d+\s*[)）.．、:：]?\s*/, ''); // 序号
        let title = '';
        let desc = '';
        const bold = line.match(/^\*\*(.+?)\*\*\s*[:：]?\s*(.*)$/);
        if (bold !== null) {
            title = bold[1].trim();
            desc = bold[2].trim();
        } else {
            const colon = line.match(/^([^：:]{2,40})\s*[:：]\s*(.*)$/);
            if (colon !== null) {
                title = colon[1].trim();
                desc = colon[2].trim();
            } else {
                title = line.replace(/\*\*/g, '').trim();
            }
        }
        if (title === '' && desc === '') continue;
        out.push({ title, desc });
    }
    return out;
}

const REQUIREMENT_RE = /不得(跳过|缺少|省略|遗漏|删去|忽略)|必须/;
const CONDITIONAL_RE = /不得[^（）()，。；]*引入|有铺垫/;
const EXCLUDE_RE = /一概不出现|不出现|不得出现|不得让|禁止出现|不能出现|不可出现|禁止使用|不得使用|不得提及|不得提前/;

/**
 * 解析禁项段，按否定句式分三类（避免把「需求」误判为禁词——彼踩过的坑）：
 *   banned       排除型：计入偏离度
 *   conditional  条件型：不计偏离度，只提示人工复核
 *   requirements 需求型：出现在正文是正确行为
 * 引号/括号内的术语按所在句式的类型归类。
 */
export function parseBanRules(sectionText) {
    if (sectionText === null) return { banned: [], requirements: [], conditional: [] };
    const banned = [];
    const requirements = [];
    const conditional = [];
    for (const raw of String(sectionText).split('\n')) {
        const line = raw.replace(/^\s*[-*+]\s*/, '').trim();
        if (line === '') continue;
        const isRequirement = REQUIREMENT_RE.test(line);
        const isConditional = CONDITIONAL_RE.test(line) && !isRequirement;
        const isExclusion = EXCLUDE_RE.test(line) && !isRequirement && !isConditional;
        if (isExclusion) {
            const named = line.match(/(?:不得让|禁止让)\s*([\u4e00-\u9fffA-Za-z]{1,8}?)(?=[出场现身登场参与介入知道发现提到说见在本章于本章，。；、：！？】）]|$)/);
            if (named !== null && named[1] !== '') banned.push(named[1]);
            const subj = line.match(/^([\u4e00-\u9fffA-Za-z]{1,8}?)(?:一概|不得|不能|不可|禁止)?不?(?:出现|登场)/);
            if (subj !== null && subj[1] !== '' && subj[1].length >= 2) banned.push(subj[1]);
            const verb = line.match(/(?:禁止使用|不得使用|不得提及|禁止提及)\s*[「"']?([\u4e00-\u9fffA-Za-z]{1,10})/);
            if (verb !== null && verb[1] !== '') banned.push(verb[1]);
        }
        for (const q of line.matchAll(/[「《"'（(]([^」》"'）)]{2,16})[」》"'）)]/g)) {
            const term = q[1].trim();
            if (term === '') continue;
            if (isExclusion) banned.push(term);
            else if (isConditional) conditional.push(term);
            else if (isRequirement) requirements.push(term);
        }
    }
    const dedup = (arr, max) => [...new Set(arr)].filter((t) => t.length >= 2 && t.length <= max);
    return { banned: dedup(banned, 16), requirements: dedup(requirements, 32), conditional: dedup(conditional, 16) };
}

/** 关键词候选：按标点切分、去掉少于 3 字的碎片、去重后按长度降序取前 5。 */
export function keywordsOf(text) {
    const tokens = String(text ?? '')
        .split(/[\s，。；、：！？（）()【】\[\]"'“”]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 3);
    const dedup = [...new Set(tokens)];
    dedup.sort((a, b) => b.length - a.length);
    return dedup.slice(0, 5);
}

/** 模糊命中强度：精确包含 = 99；否则计命中的 4 字滑窗数（不同窗口分别计数）。 */
export function fuzzyHitCount(content, token) {
    if (token.length < 4) return content.includes(token) ? 99 : 0;
    if (content.includes(token)) return 99;
    let count = 0;
    for (let i = 0; i + 4 <= token.length; i += 1) {
        if (content.includes(token.slice(i, i + 4))) count += 1;
    }
    return count;
}

/** 场景是否命中：标题精确出现，或描述关键词按 4 字滑窗模糊命中达阈值。 */
export function sceneMatched(content, scene) {
    if (scene.title !== '' && content.includes(scene.title)) return true;
    const words = keywordsOf(scene.desc);
    if (words.length === 0) return false;
    const hits = words.filter((w) => fuzzyHitCount(content, w) >= 2).length;
    const threshold = Math.max(2, Math.ceil(words.length * 0.4));
    return hits >= Math.min(threshold, words.length);
}

/**
 * 计算细纲契约指标。
 * @param inputs { content, outline }
 * @returns { available, coverage, drift, scenes, missedScenes, bannedHits, requirements, conditional, passed, note }
 *   available=false 时其余指标为 null（细纲没写契约段，或格式解析不出）。
 */
export function computeGateMetrics({ content, outline } = {}) {
    const text = String(content ?? '');
    const sceneSection = sectionOf(outline, SCENE_HEADINGS);
    if (sceneSection === null) {
        return {
            available: false, coverage: null, drift: null, scenes: [], missedScenes: [],
            bannedHits: [], requirements: [], conditional: [], passed: null, note: '细纲未写「本章必写场景」段——不参与契约判定',
        };
    }
    const scenes = parseScenes(sceneSection);
    if (scenes.length === 0) {
        return {
            available: false, coverage: null, drift: null, scenes: [], missedScenes: [],
            bannedHits: [], requirements: [], conditional: [], passed: null,
            note: '「本章必写场景」段存在但解析不出条目（格式漂移）——请写成「- 标题：描述」或「1. **标题**：描述」',
        };
    }
    const rules = parseBanRules(sectionOf(outline, BAN_HEADINGS));

    // 场景豁免：必写场景标题/描述里出现的词不可能是禁词（同卡自相矛盾时以场景为准）
    const sceneTerms = new Set();
    for (const s of scenes) {
        if (s.title !== '') sceneTerms.add(s.title);
        for (const w of keywordsOf(s.desc)) sceneTerms.add(w);
    }
    const effectiveBanned = rules.banned.filter((t) => !sceneTerms.has(t));

    const covered = scenes.map((s) => ({ ...s, matched: sceneMatched(text, s) }));
    const coverage = Math.round((covered.filter((s) => s.matched).length / scenes.length) * 1000) / 10;
    const bannedHits = effectiveBanned.filter((term) => term !== '' && text.includes(term));
    const drift = effectiveBanned.length === 0 ? null : Math.round((bannedHits.length / effectiveBanned.length) * 1000) / 10;

    return {
        available: true,
        coverage,
        drift,
        scenes: covered,
        missedScenes: covered.filter((s) => !s.matched).map((s) => s.title),
        bannedHits,
        requirements: rules.requirements,
        conditional: rules.conditional,
        passed: coverage === 100 && bannedHits.length === 0,
        note: null,
    };
}

/** 一行摘要（供工具 render）。 */
export function gateMetricsDigest(gate) {
    if (gate === null || gate.available !== true) {
        return `契约指标：未启用${gate?.note !== undefined && gate.note !== null ? `（${gate.note}）` : ''}`;
    }
    return `契约指标：覆盖率 ${gate.coverage}%`
        + `${gate.drift === null ? '' : ` / 偏离度 ${gate.drift}%`}`
        + ` / ${gate.passed ? '通过 ✓' : '未通过'}`
        + `${gate.missedScenes.length > 0 ? `\n  漏写场景：${gate.missedScenes.join('、')}` : ''}`
        + `${gate.bannedHits.length > 0 ? `\n  命中禁项：${gate.bannedHits.join('、')}` : ''}`;
}
