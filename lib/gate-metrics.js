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

/** 元信息括号清洗（0.19.1，E9/E17）：细纲场景描述里的「（拍：洇条/逐字核/…）」是
 * 写作节拍提示、「（约 550 字）」是字数预算——都不是正文必须逐字复现的词。
 * 旧版把它们混进 keywordsOf → 「洇条/逐字核」这类拍短语在描写性正文里天然不出现，
 * 场景写全了仍判漏写（真机第 6/10/17/27 章四次覆盖率 FP 同根因）。在解析源头清洗，
 * 主体描述保留、关键词不受污染。
 *
 * ⚠️ 必须在 colon 分割**之前**对整行做（parseScenes 调用处），不能只清 title/desc：
 * 「开柜取纸（拍：揭纸/别签）：柜面旧痕」的冒号在拍括号**之后**——colon 的
 * `[^：:]{2,40}` 贪婪匹配会把「（拍」吞进 title、把「：揭纸/别签）」留在 desc，
 * 再对 title/desc 各自清就只剩残片「（拍」，正则匹配不上完整括号对，清洗失效。 */
const SCENE_META_RE = /[（(]\s*拍\s*[:：][^）)]*[）)]/g;
const SCENE_BUDGET_RE = /[（(]\s*约\s*\d+\s*字\s*[）)]/g;

function stripSceneMeta(text) {
    return String(text ?? '').replace(SCENE_META_RE, '').replace(SCENE_BUDGET_RE, '').trim();
}

/**
 * 场景标题别名拆解（0.20.0）：细纲条目支持「标题（别名）」与「标题｜别名1/别名2」——
 * 正文常用同义改写而不写标题字面（真机 ch16「章末收束」写成了内心独白收束、
 * ch18「残牌对火」写成了膳庖同源揭示，词面不中全判漏写）。别名也参与命中与
 * 禁项豁免；missedScenes 仍只报主标题。
 * @returns {{ title: string, aliases: string[] }}
 */
export function splitTitleAliases(rawTitle) {
    let t = String(rawTitle ?? '').trim();
    if (t === '') return { title: '', aliases: [] };
    const aliases = [];
    // 「｜」或「|」后的分隔别名（再按 / ／ ； ; 切）
    const bar = t.match(/^(.*?)\s*[｜|]\s*(.+)$/);
    if (bar !== null) {
        t = bar[1].trim();
        for (const a of bar[2].split(/\s*[/／;；]\s*/)) {
            if (a.trim() !== '') aliases.push(a.trim());
        }
    }
    // 尾部括号别名（stripSceneMeta 已清走「拍：/约N字」，剩下的括号是作者有意写的别名）
    const paren = t.match(/^(.+?)\s*[（(]\s*([^）)]{1,24}?)\s*[）)]\s*$/);
    if (paren !== null) {
        t = paren[1].trim();
        for (const a of paren[2].split(/\s*[/／;；、]\s*/)) {
            if (a.trim() !== '') aliases.push(a.trim());
        }
    }
    return { title: t, aliases };
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
        // 0.19.1（E9/E17）：先对整行做元信息清洗，再做冒号分割——
        // 拍/字数括号可能在冒号**之前**（「开柜取纸（拍：…）：柜面旧痕」），
        // 贪婪的 colon `[^：:]{2,40}` 会把「（拍」吞进 title 侧，残片清不干净。
        line = stripSceneMeta(line);
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
        // 0.20.0：标题侧拆别名（「残牌对火（膳庖同源）」「章末收束｜内心独白」）
        const split = splitTitleAliases(title);
        title = split.title;
        if (title === '' && desc === '') continue;
        out.push({ title, aliases: split.aliases, desc });
    }
    return out;
}

/**
 * 细纲容量口径（0.18.0 重标，真机 7 本 151 章「细纲 → 首稿字数」实测拟合）：
 *
 *   旧口径是 `场景数 × 480`。它在真机上是**错的**两遍：
 *     ① 场景数对首稿字数的解释力 R²=0.033（几乎为零）——4 场景的细纲实测写出
 *        2087 字（median），8 场景的反而有 40% 首稿不足 2000；
 *     ② 拿它当硬闸，在 151 章样本上拦 35 章、其中 22 章（63%）实际首稿 ≥2000，
 *        即误驳率 63%，同时漏判 19/32 章真正写不够的。
 *   新口径把「每场景声明了多少拍」计进来（拍＝描述里的动作分隔符），
 *   `场景数×300 + 拍×160`：拦 15 章、误驳 2 章（精确率 87%）、召回 41%。
 *   漏掉的那一半不补——剩下的首稿不足由**会话退化**造成（见 lib/health.js 的
 *   会话内趋势判据）与模型自身波动，细纲层看不见它，硬拦只会误伤。
 */
export const SCENE_BASE_CHARS = 300;
export const SCENE_BEAT_CHARS = 160;
export const SCENE_BEATS_CAP = 5;
/** 旧常量名保留一个版本（面板/外部脚本可能引），值指向新口径的单场景基准。 */
export const SCENE_CAPACITY_CHARS = SCENE_BASE_CHARS;

/** 分隔符口径的「拍」：一个场景描述里写了几个动作/信息点。封顶 5（更多不额外加容量）。 */
const BEAT_SPLIT_RE = /[、；;→\/]/g;
const BEAT_NUMBERED_RE = /(?:^|[\s（(【])[1-9][.、)）]/g;
export function countSceneBeats(scene) {
    const desc = String(scene?.desc ?? '');
    const marks = (desc.match(BEAT_SPLIT_RE) ?? []).length;
    const numbered = (desc.match(BEAT_NUMBERED_RE) ?? []).length;
    return Math.min(SCENE_BEATS_CAP, 1 + Math.max(marks, numbered));
}

/** 解析细纲的「本章必写场景」条目；没写场景段或解析不出条目 → null（不判，兼容自由文本老细纲）。 */
export function outlineScenesOf(outline) {
    const section = sectionOf(outline, SCENE_HEADINGS);
    if (section === null) return null;
    const scenes = parseScenes(section);
    return scenes.length > 0 ? scenes : null;
}

/**
 * 细纲容量体检（纯函数）：按声明量估算本章首稿能写多少字。
 * @returns null（不判）或 { sceneCount, beats, estimated, thinScenes, neededBeats, minChars }
 *   thinScenes = 只有一拍（没描述或描述极短）的场景清单——补字数的正确位置。
 */
export function outlineCapacityEstimate({ outline, minChars } = {}) {
    if (!Number.isFinite(minChars)) return null;
    const scenes = outlineScenesOf(outline);
    if (scenes === null) return null;
    const per = scenes.map((s, i) => ({ no: i + 1, title: s.title, beats: countSceneBeats(s) }));
    const beats = per.reduce((a, s) => a + s.beats, 0);
    const estimated = scenes.length * SCENE_BASE_CHARS + beats * SCENE_BEAT_CHARS;
    if (estimated >= minChars) return { sceneCount: scenes.length, beats, estimated, thinScenes: [], neededBeats: 0, minChars };
    return {
        sceneCount: scenes.length,
        beats,
        estimated,
        thinScenes: per.filter((s) => s.beats <= 1),
        neededBeats: Math.ceil((minChars - estimated) / SCENE_BEAT_CHARS),
        minChars,
    };
}

/**
 * 逐场景字数预算（纯函数）：把「本章目标 N 字」摊到细纲声明的场景上。
 * 为什么要摊：模型对「3000 字」无感（真机一次过率只有 79%，失败的全是整章重写 3 轮），
 * 但对「这一场写 500 字、约 4 段」有操作性——它与细纲逐条对齐，写的时候能自查。
 * 分配按声明密度加权（描述越长的场景本来就该写更多），并给每个场景保底。
 * @returns null（无场景段）或 [{no, title, suggested}]
 */
export function sceneCharBudget({ outline, target, minChars } = {}) {
    if (!Number.isFinite(target) || target <= 0) return null;
    const scenes = outlineScenesOf(outline);
    if (scenes === null) return null;
    const weights = scenes.map((s) => SCENE_BASE_CHARS + countSceneBeats(s) * SCENE_BEAT_CHARS);
    const sum = weights.reduce((a, b) => a + b, 0);
    const floor = Number.isFinite(minChars) ? Math.max(200, Math.round(minChars / scenes.length / 10) * 10) : 200;
    return scenes.map((s, i) => ({
        no: i + 1,
        title: s.title,
        suggested: Math.max(floor, Math.round((target * weights[i]) / sum / 50) * 50),
    }));
}

/**
 * @deprecated 0.18.0 起改用 outlineCapacityEstimate（口径含拍数）。保留一版以兼容外部调用，
 * 内部实现已转发——不再返回「场景数×480」那套被真机证伪的数字。
 */
export function sceneCapacityShortfall({ outline, minChars, target } = {}) {
    const est = outlineCapacityEstimate({ outline, minChars });
    if (est === null || est.estimated >= minChars) return null;
    return {
        sceneCount: est.sceneCount,
        capacityChars: est.estimated,
        minChars,
        target,
        capacity: SCENE_BASE_CHARS,
        needed: Math.max(est.sceneCount + 1, Math.ceil((Number.isFinite(target) ? target : minChars) / SCENE_BASE_CHARS)),
    };
}

/**
 * 细纲契约段状态（纯函数）：给 save_chapter 的书级策略（novel.outlineContract）当判据，
 * 与 sceneCapacityShortfall 共用同一份 sectionOf/parseScenes——解析口径不许漂移。
 * present=false＝没写场景段；present=true 且 sceneCount=0＝格式漂移（有标题无条目）。
 */
export function outlineContractCheck(outline) {
    const section = sectionOf(outline, SCENE_HEADINGS);
    if (section === null) return { present: false, sceneCount: 0 };
    return { present: true, sceneCount: parseScenes(section).length };
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
/** 许可/指称语境（只许以「X」指称 / 用语用《X》/ 只写「X」）——引号词是「应该出现的写法」，不是禁词。 */
const PERMISSIVE_BEFORE_RE = /(只许|许以|可用|写作|称为|叫作|代称|用语用|一律用|改用|只写|应写|只能写|统一写|一律写)[^「《（(]*$/;
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
 * 真机完结本第 1 章两连拒的根因（均已修，有回归钉）：
 *   ① 「不得出现X」前置否定句式里，主语正则（{1,8}? 下限=1，引擎回溯到最短可行）
 *      捕获到的是否定词本身 → banned:['不得']，正文含「不得」二字即误判命中；
 *   ② 「不得让某角色说出…」按人名收禁词 → 角色名在正文无处不在，必命中；
 *      真正想禁的是引号里的那句话（归条件型 + 引号词照收禁词）。
 */
/** 便捷导出：细纲的禁项词表（banned）——供 contextpack.declaredCoverageTerms 的
 * forbidden 参数用（E2：契约禁项不进覆盖率要素表）。纯函数。 */
export function bannedTermsOf(outline) {
    return parseBanRules(sectionOf(outline, BAN_HEADINGS)).banned;
}

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
            // 0.19.1（E12）：「不得让X登场/出场/现身/出现」是**登场禁令**不是提及禁令——
            // 回忆/引用性提及（「老周当年…」）在叙事里合法，字面 includes 分不出在场与提及。
            // X 降级 conditional（不计偏离度、不阻断，人工复核在场性）——放宽方向遵循
            // 本文件既有原则：漏禁缓降、误禁拦章。
            const appear = line.match(APPEAR_NAMED_RE);
            if (appear !== null && appear[1] !== '') conditional.push(appear[1]);
            // 「不得让X说/提/知道…」——禁的是那件事；人名归条件型（人物必然在
            // 正文出现，收进禁词表=必误判），真正禁的引号宾语由下方引号循环收
            const act = appear === null ? line.match(ACT_NAMED_RE) : null;
            if (act !== null && act[1] !== '') conditional.push(act[1]);
            // 0.19.1（E11）：主宾并存句式（「对账单不得出现人名与日期」）禁的是宾语——
            // 主语（对账单）是主角道具必然出现在正文，收进禁词表=必命中。宾语捕获扩展到
            // 「不得出现/不能出现/不可出现/禁止出现」句式，并拆「X与Y」枚举；
            // 主语捕获只在**没有宾语捕获**时跑（「现代词汇不得出现」主语前置、无宾语）。
            let caughtObject = false;
            if (!/^(?:一概|不得|不能|不可|切勿|不要|禁止)让/.test(line)) {
                const lead = line.match(LEAD_OBJECT_RE);
                if (lead !== null && lead[1] !== '') {
                    banned.push(lead[1]);
                    caughtObject = true;
                }
            }
            const verb = line.match(/(?:禁止使用|不得使用|不得提及|禁止提及|不得出现|不能出现|不可出现|禁止出现|一概不出现)\s*[「"']?([\u4e00-\u9fffA-Za-z0-9]{1,16})/);
            if (verb !== null && verb[1] !== '') {
                caughtObject = true;
                for (const p of verb[1].split(/[与和、，]/).map((t) => t.trim())) {
                    if (p.length >= 2) banned.push(p);
                }
            }
            // 主语前置句式（「现代词汇不得出现」→ 禁 现代词汇）；宾语已在场（主宾并存）
            // 时跳过——禁宾语不收主语（E11）。捕获到纯否定词时也跳过，否定词永不入禁词表
            if (!caughtObject) {
                const subj = line.match(/^([\u4e00-\u9fffA-Za-z]{1,8}?)(?:一概|不得|不能|不可|禁止)?不?(?:出现|登场)/);
                if (subj !== null && subj[1] !== '' && subj[1].length >= 2 && !NEG_WORDS.has(subj[1])) banned.push(subj[1]);
            }
        }
        // 范围限定括号（排除行里的（只推进到"X"）（仅限"Y"）（止于"Z"））：括号是对禁令
        // 【推进程度】的说明——X/Y 是允许且通常必须写到的小节点，不是禁词本体。真机某章
        // 实证（真机导入书监控报告）：括号说明里的引号词被收进禁词表，正文一句自然反问
        // 命中即整章被拦（write_chapter/rejected，白烧一整轮生成）。
        // 在跨度内【独立】提取引号词归条件型——不能只靠主循环跳过：主循环的括号开启符（
        // 会吞掉紧随的引号开启符（「只推进到"X"」里 X 的开引号被当成 只推进到
        // 的闭引号），钥匙证人 就永远轮不到匹配。放宽方向是「少禁」（漏禁缓降、误禁拦章）。
        const scopeSpans = [];
        if (isExclusion) {
            for (const m of line.matchAll(/[（(][^）)]*[）)]/g)) {
                if (!/(?:只|仅|限|推进到|止于|到[^）)]{0,6}为止)/.test(m[0])) continue;
                scopeSpans.push([m.index, m.index + m[0].length]);
                // 从首个引号开始匹配：触发词（只推进到…）直接贴着开引号，若不剥掉前缀，
                //（只推进到" 会被当成一个「括号开启符+闭引号」的伪配对，把 钥匙证人 的
                // 开引号吞掉、钥匙证人 永远轮不到匹配。
                const qStart = m[0].search(/[「《"']/);
                if (qStart === -1) continue;
                for (const q of m[0].slice(qStart).matchAll(/[「《"'（(]([^」》"'）)]{2,24})[」》"'）)]/g)) {
                    const t = q[1].trim();
                    if (t !== '') conditional.push(t);
                }
            }
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
            // 命中范围限定括号跨度的引号词已在上面独立提取（条件型），主循环跳过
            if (scopeSpans.some(([s, e]) => q.index >= s && q.index < e)) continue;
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

/**
 * 关键词候选：提取 CJK/字母/数字 的**连续串**——任何标点或符号（——、·、《》、「」…）
 * 都会自然断开，无需再维护标点枚举表（旧实现只枚举了常见中文标点，漏掉 —— 与 ·，
 * 于是「井欠的七条命一座封——苗在还——」被粘成一个超长 token，正文永远无法逐字复现，
 * 造成系统性假阴性）。
 *
 * 不再「按长度降序取前 5」：最长的从句恰恰是最不可能在正文里逐字复现的，优先取它
 * 等于主动制造漏判。改为保留全部候选，由 sceneMatched 按命中证据强弱判定。
 *
 * 长度下限取 3：2 字人名（如「孙宇」）在正文随处可见，收进来会让「完全没写的场景」
 * 也因名字出现而误判命中（假阳性）。
 */
export function keywordsOf(text) {
    const tokens = String(text ?? '').match(/[\u4e00-\u9fffA-Za-z0-9]+/g) ?? [];
    return [...new Set(tokens)].filter((t) => t.length >= 3);
}

/** 去标点正文流：细纲描述与正文措辞常有标点微差（细纲「按手印领食」、正文
 * 「按手印，领食」），逐字滑窗会被一个逗号全灭（真机《食妖帖》第 1 章两场景
 * 写全仍判漏写）。滑窗匹配在去标点流上做——只保留汉字/字母/数字。 */
function stripPunct(text) {
    return String(text ?? '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '');
}

/**
 * 模糊命中强度：精确包含 = 99；否则计命中的 4 字滑窗数（不同窗口分别计数）。
 * 0.19.1（E20）：滑窗在去标点流上匹配——跨标点仍算命中。
 */
export function fuzzyHitCount(content, token) {
    if (token.length < 4) return content.includes(token) ? 99 : 0;
    if (content.includes(token)) return 99;
    const clean = stripPunct(content);
    let count = 0;
    for (let i = 0; i + 4 <= token.length; i += 1) {
        if (clean.includes(token.slice(i, i + 4))) count += 1;
    }
    return count;
}

/**
 * 场景是否命中：标题精确出现，或描述关键词命中达阈值。
 *
 * 阈值重新校准（旧版 `hits >= min(max(2, ceil(n*0.4)), n)` 在 n≥2 时几乎要求全中，
 * 叠加超长 token 造成系统性假阴性）：
 *   · **≥4 字的整词精确命中** ＝强证据（一条完整从句逐字出现在正文），单条即判命中；
 *   · 否则需 **≥2 条** 关键词命中（精确或模糊 4 字滑窗）。要求 2 条而非 1 条，是为了
 *     挡住「专有名词/短通用短语在正文里到处出现」造成的假阳性；
 *   · 描述只有 1 条关键词时无从「两条互证」，放宽为 1 条（否则单关键词场景必假阴性）；
 *   · 一条都不命中 → 判漏写（真漏写场景的典型形态：正文里压根没有相关从句）。
 */
/**
 * 短词同窗共现（0.20.0，真机《夜半来客》两轮踩坑）：2 字词面「落闩」在正文里常被
 * 跨字拆开（「门闩…咔…自己落了」），连续 includes 必漏。判定放宽为：词的全部
 * **去重后**字符都在正文中、且存在一个 ≤window 字的窗口同时容纳它们（顺序不限）。
 * 「声明即意图」——别名是作者自己写的同义改写，共现即视为场景落实的证据
 * （missedScenes 是警告级指标，宁松勿漏；防假阳性交给 desc 的互证结构）。
 * 守卫：去重后不足 2 字（叠字词「层层」）不判——单字共现等价于字出现，过宽。
 */
export function proximityHit(text, word, window = 12) {
    const chars = [...new Set([...String(word ?? '')])];
    if (chars.length < 2) return false;
    const positions = chars.map((c) => {
        const ps = [];
        let i = text.indexOf(c);
        while (i !== -1) { ps.push(i); i = text.indexOf(c, i + 1); }
        return ps;
    });
    if (positions.some((ps) => ps.length === 0)) return false;
    // 组合搜索：每步纳入一个字符的某个位置，跨度超窗剪枝；全部纳入即命中。
    // （中途跨度检查只在「已选」集合上做——初始哨兵态不参与判定，防提前放行。）
    const comboFrom = (idx, min, max) => {
        if (idx === positions.length) return true;
        return positions[idx].some((p) => {
            const nmin = Math.min(min, p);
            const nmax = Math.max(max, p);
            if (nmax - nmin > window) return false;
            return comboFrom(idx + 1, nmin, nmax);
        });
    };
    return positions[0].some((p0) => comboFrom(1, p0, p0));
}

export function sceneMatched(content, scene) {
    const text = String(content ?? '');
    // 0.20.0：主标题或任一别名命中即算——细纲条目可声明同义改写（splitTitleAliases）
    const titles = [scene.title, ...(Array.isArray(scene.aliases) ? scene.aliases : [])]
        .filter((t) => t !== '');
    for (const t of titles) {
        if (text.includes(t)) return true;
        // ≤2 字别名走同窗共现（跨字拆写「门闩…落了」也算落实）；3+ 字仍要连续词面
        if (t.length <= 2 && proximityHit(text, t)) return true;
    }
    const words = keywordsOf(scene.desc);
    if (words.length === 0) return false;
    // 0.19.1（E20）：长描述句 token 化后动辄 8-12 字，要求滑窗 ≥2 对「正文换词」
    // 太脆（《食妖帖》ch1 实证）。改为：≥4 字 token 命中 **任一** 滑窗（跨标点）即算
    // 该 token 命中；互证结构不变——仍需 ≥2 个 token 命中才判场景命中，
    // 「专有名词到处出现」的假阳性由互证挡住。
    const hits = words.filter((w) => (w.length >= 4 ? fuzzyHitCount(text, w) >= 1 : fuzzyHitCount(text, w) >= 99));
    if (hits.length === 0) return false;
    if (hits.some((w) => w.length >= 4 && text.includes(w))) return true;
    return hits.length >= Math.min(2, words.length);
}

/**
 * 计算细纲契约指标。
 * @param inputs { content, outline, target? } —— target 目标字数（默认 3000，仅用于达成率留痕）
 * @returns { available, coverage, drift, scenes, missedScenes, bannedHits, requirements, conditional, passed, chars, targetRatio, note }
 *   available=false 时其余指标为 null（细纲没写契约段，或格式解析不出）。
 */
export function computeGateMetrics({ content, outline, target = 3000 } = {}) {
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
        for (const a of s.aliases ?? []) sceneTerms.add(a); // 0.20.0：别名同享豁免
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
        // 0.20.0：目标字数达成率——机审 chars 口径（去空白，与 audit 同源），
        // 只留痕不阻断；「长期贴下限」从此有数字可查（真机 6 章均值 78%）。
        chars: text.replace(/\s/g, '').length,
        targetRatio: Math.round((text.replace(/\s/g, '').length / target) * 100),
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
