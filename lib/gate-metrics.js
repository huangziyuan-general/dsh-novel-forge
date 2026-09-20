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
        // 序号：必须跟分隔符（括号/点/顿号/冒号/空白）才算——否则「12岁少女进城」
        // 这类数字开头的场景标题会把「12」吃掉（L18 修复）
        line = line.replace(/^[（(]?\s*\d+\s*(?:[)）.．、:：]|\s)\s*/, '');
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
/** 行首否定词——禁项段里以否定词开头的行，语义上就是在禁某样东西（此前「禁止现代词汇…」整行漏解析，禁令静默失效）。 */
const LEAD_NEG_RE = /^(?:一概|不得|不能|不可|切勿|不要|禁止)/;
/** 前置否定 + 排除动词后的宾语（不得出现X / 禁止使用X / 不得点破X）——禁的是 X，不是否定词。 */
const LEAD_OBJECT_RE = /^(?:一概|不得|不能|不可|切勿|不要|禁止)(?:出现|登场|出场|使用|提及|描写|点破)?\s*[「"']?([\u4e00-\u9fffA-Za-z][\u4e00-\u9fffA-Za-z]{1,15}?)(?=[，。；、：！？」』】）"'（(]|$)/;
/** 禁出场人物：不得让X（出场|登场|现身|出现）——X 是「不许在本章露面」的人，人名即禁词。 */
const APPEAR_NAMED_RE = /(?:不得让|禁止让|不能让|不可让|切勿让)\s*([\u4e00-\u9fffA-Za-z]{2,6}?)(?:出场|登场|现身|出现)/;
/** 禁行为人物：不得让X（说|提|知|见…）某事——禁的是那件事，不是人；人名归条件型人工复核。 */
const ACT_NAMED_RE = /(?:不得让|禁止让|不能让|不可让|切勿让)\s*([\u4e00-\u9fffA-Za-z]{2,6}?)(?=[说提知见讲问答写画认自曝承])/;
/** 许可/指称语境（只许以「X」指称 / 用语用《X》）——引号词是「应该出现的写法」，不是禁词。 */
const PERMISSIVE_BEFORE_RE = /(只许|许以|可用|写作|称为|叫作|代称|用语用|一律用|改用)[^「《（(]*$/;
/** 纯否定词集合——主语位捕获到它们=句式退化（「不得出现X」），否定词本身永不入禁词表。 */
const NEG_WORDS = new Set(['一概', '不得', '不能', '不可', '不要', '切勿', '禁止']);

/**
 * 解析禁项段，按否定句式分三类（避免把「需求」误判为禁词——彼踩过的坑）：
 *   banned       排除型：计入偏离度
 *   conditional  条件型：不计偏离度，只提示人工复核
 *   requirements 需求型：出现在正文是正确行为
 * 引号/括号内的术语按所在句式的类型归类；顿号枚举逐项拆开；许可/指称语境
 * （只许以「X」指称）里的引号词归条件型而非禁词。
 *
 * 墨骨录第 1 章两连拒的根因（均已修，有回归钉）：
 *   ① 「不得出现X」前置否定句式里，主语正则（{1,8}? 下限=1，引擎回溯到最短可行）
 *      捕获到的是否定词本身 → banned:['不得']，正文含「不得」二字即误判命中；
 *   ② 「不得让沈无咎说出…」按人名收禁词 → 主角名在正文无处不在，必命中；
 *      真正想禁的是引号里的那句话（归条件型 + 引号词照收禁词）。
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
        const isExclusion = !isRequirement && !isConditional
            && (EXCLUDE_RE.test(line) || LEAD_NEG_RE.test(line));
        if (isExclusion) {
            // 「不得让X登场/出场/现身/出现」——X 确实不许在本章露面，人名即禁词
            const appear = line.match(APPEAR_NAMED_RE);
            if (appear !== null && appear[1] !== '') banned.push(appear[1]);
            // 「不得让X说/提/知道…」——禁的是那件事；人名归条件型（人物必然在
            // 正文出现，收进禁词表=必误判），真正禁的引号宾语由下方引号循环收
            const act = appear === null ? line.match(ACT_NAMED_RE) : null;
            if (act !== null && act[1] !== '') conditional.push(act[1]);
            // 前置否定宾语（不得出现墨银 / 禁止使用X / 不得点破X）；「不得让…」
            // 句式已由上面两条分支处理，这里跳过防重复捕获
            if (!/^(?:一概|不得|不能|不可|切勿|不要|禁止)让/.test(line)) {
                const lead = line.match(LEAD_OBJECT_RE);
                if (lead !== null && lead[1] !== '') banned.push(lead[1]);
            }
            const verb = line.match(/(?:禁止使用|不得使用|不得提及|禁止提及)\s*[「"']?([\u4e00-\u9fffA-Za-z]{1,10})/);
            if (verb !== null && verb[1] !== '') banned.push(verb[1]);
            // 主语前置句式（「现代词汇不得出现」→ 禁 现代词汇）；捕获到纯否定词
            // （前置否定句式退化）时跳过，否定词永不入禁词表
            const subj = line.match(/^([\u4e00-\u9fffA-Za-z]{1,8}?)(?:一概|不得|不能|不可|禁止)?不?(?:出现|登场)/);
            if (subj !== null && subj[1] !== '' && subj[1].length >= 2 && !NEG_WORDS.has(subj[1])) banned.push(subj[1]);
        }
        // 裸词表行：无句式、无引号括号、无否定/许可词，整行是 、/， 分隔的短词清单
        // ——禁项段最朴素的写法。旧版整体漏解析（禁令静默失效，写手被迫改格式绕门禁）。
        if (!isRequirement && !isExclusion && !isConditional
            && !/[「《"'（(]/.test(line)
            && !/(?:不得|不能|不可|不要|切勿|禁止|只许|必须|有铺垫|[禁忌勿])/.test(line)
            && /[、，]/.test(line)) {
            const parts = line.split(/[、，]/).map((t) => t.trim()).filter((t) => t.length >= 2 && t.length <= 16);
            if (parts.length >= 2 && parts.every((t) => /^[\u4e00-\u9fffA-Za-z]+$/.test(t))) {
                for (const p of parts) banned.push(p);
                continue;
            }
        }
        for (const q of line.matchAll(/[「《"'（(]([^」》"'）)]{2,24})[」》"'）)]/g)) {
            const term = q[1].trim();
            if (term === '') continue;
            // 「幕后只许以「漕面上的人」模糊指称」——许可/指称语境里的引号词是
            // 应该出现的写法，归条件型，不进禁词表
            if (isExclusion && PERMISSIVE_BEFORE_RE.test(line.slice(0, q.index))) {
                conditional.push(term);
                continue;
            }
            // 枚举拆分：（法医、指纹、解剖、窒息、证据链等）→ 逐项成禁词，「等」尾去掉；
            // 单一术语（拓印有半枚）保持整体
            const parts = term.split(/[、，,]/)
                .map((t) => t.replace(/等(词汇|词)?$/, '').trim())
                .filter((t) => t.length >= 2 && t.length <= 16);
            for (const p of (parts.length > 1 ? parts : [term])) {
                if (isExclusion) banned.push(p);
                else if (isConditional) conditional.push(p);
                else if (isRequirement) requirements.push(p);
            }
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
