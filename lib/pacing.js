// lib/pacing.js — 跨章叙事配额与节奏状态机（纯函数，零 IO、零模型调用）。
//
// 补的是本项目**单章强、跨章弱**这条结构性短板的另一半：noai 八维与内容门禁
// 全部只看「本章」，跨章约束此前只有 `contextpack.js` 里注入的一段纯文本
// （RHYTHM_CONSTRAINT）——靠模型自觉，正是 AGENTS.md 开篇反对的那类约束。
//
// 三个机制（借竞品 D 的 anti_resolution_guard / event_matrix_scheduler /
// pacing_tracker，判据按本项目的数据形态重写）：
//
//   ① 反向刹车（anti-resolution brake）
//      「AI 爱当救世主，一口气把主线解决了，长篇后面无事可写」是长篇最典型的
//      结构性塌陷。判据：解决类信号词（彻底解决/水落石出/一举拿下…）+ 3 组
//      配额信号（主线格局变化 / 关系决定性升级 / 秘密完整揭露），
//      **同时命中 ≥2 组配额信号**才触发（单组命中不算——一格里换个结盟不算塌）。
//
//   ② 事件冷却矩阵（event cooldown）
//      5 类事件各有冷却章数：冲突爽点 2 / 人物羁绊 1 / 势力经营 2 /
//      风土人情 3 / 危机升级 2。同一类事件连着写，读者会觉得「又是这一套」。
//      判定单位是**章**（一类事件占一章），不是段落——段落级会让冷却形同虚设。
//
//   ③ 节奏档位（tempo tiers）
//      快档（爽点章）每卷配额 max_fast_per_volume、连续快档上限
//      max_consecutive_fast；慢档（日常/铺垫章）有密度窗口——
//      连着三章日常，读者会觉得「没进展」。
//
// 与既有门禁的关系：**刹车可阻断（force 可放行，与内容门禁同档）**，
// 冷却与档位只报不拦（证据不是判决）。跨章判据不改动任何既有判定口径——
// 机审的重复检测仍看 repetitionWindow 章，noai 八维权重恒为 1 的红线不动。
//
// 纯函数（AGENTS.md 不变量 2）：不碰 io、不取钟、不写文件。

/**
 * 5 类事件 + 冷却章数 + 判定词表。
 *
 * 词表是「判定信号」不是「题材词典」：宁可漏判（那章只是没被归类，冷却检查
 * 跳过）也不要误判（把一本日常向的书硬判成「连续势力经营」）。
 * 判定还要求**同一章内命中 ≥2 次**才算这一类——一次提及说明不了这一章的走向。
 */
export const EVENT_TYPES = [
    {
        id: 'conflict',
        name: '冲突爽点',
        cooldown: 2,
        words: ['厮杀', '激战', '鏖战', '决战', '反杀', '碾压', '力战', '搏杀', '围攻', '围杀',
            '见血', '拼杀', '恶战', '大战', '交手', '拔刀', '对砍', '一刀', '重创', '反扑'],
    },
    {
        id: 'bond',
        name: '人物羁绊',
        cooldown: 1,
        words: ['交心', '倾谈', '夜谈', '闲话', '叙旧', '话旧', '把酒', '煮茶', '陪伴', '守护',
            '守候', '并肩', '托付', '等候', '照料', '相依', '默契', '交情', '旧识', '熟稔'],
    },
    {
        id: 'faction',
        name: '势力经营',
        cooldown: 2,
        words: ['布局', '经营', '招兵', '募兵', '结盟', '谈判', '争权', '夺权', '整合', '收编',
            '拉拢', '分舵', '堂口', '山头', '班底', '版图', '地盘', '嫡系', '外派', '收服',
            '举荐', '提拔', '安插', '布局图'],
    },
    {
        id: 'locale',
        name: '风土人情',
        cooldown: 3,
        words: ['市井', '坊间', '街巷', '巷陌', '庙会', '灯市', '集市', '摆摊', '摊贩', '闲汉',
            '婆娘', '掌柜', '伙计', '乡俗', '方言', '节令', '节气', '年俗', '小吃', '吃食',
            '茶摊', '酒肆', '客栈', '街坊', '邻人', '坊市'],
    },
    {
        id: 'crisis',
        name: '危机升级',
        cooldown: 2,
        words: ['围城', '兵临城下', '断粮', '粮尽', '绝境', '险境', '危机', '灾祸', '浩劫', '崩塌',
            '反噬', '失控', '蔓延', '告急', '求援', '瘟疫', '饥荒', '山洪', '地动', '烽火',
            '走投无路', '水深火热'],
    },
];

/**
 * 解决类信号词（反向刹车的「必要信号」）。
 *
 * 只收**「彻底完成」型**的短语，不收「解决了追兵」这种局部解决——局部冲突收尾
 * 是正常叙事，进了这张表就会把正常章节误判成「主线被解决」。
 */
export const RESOLUTION_WORDS = [
    '彻底解决', '完全解决', '一并解决', '就此了结', '彻底终结', '终于结束', '全部落幕',
    '水落石出', '尘埃落定', '谜底揭晓', '真相大白', '一举拿下', '彻底击败', '终于查清',
    '全部查明', '彻底解决掉', '终于真相大白', '落下帷幕', '再无悬念',
];

/**
 * 3 组配额信号：命中 ≥2 组才触发反向刹车。
 *
 * 每组各管一件事——主线格局变了没有 / 关系有没有决定性升级 / 秘密是不是全揭了。
 * 三件事同时动 + 出现「彻底解决」类信号 = 这一章把长线的底牌全翻了。
 */
export const QUOTA_GROUPS = [
    {
        id: 'arc',
        name: '主线格局变化',
        words: ['格局', '翻盘', '洗牌', '易主', '变天', '大势', '重写', '改写', '天翻地覆', '重新洗牌',
            '天下大势', '局面', '彻底扭转'],
    },
    {
        id: 'bond',
        name: '关系决定性升级',
        words: ['盟约', '结盟', '联姻', '歃血', '拜师', '收徒', '认主', '结拜', '道侣', '缔约',
            '定亲', '结为', '结为兄弟', '同门'],
    },
    {
        id: 'secret',
        name: '秘密完整揭露',
        words: ['全部真相', '完整真相', '所有真相', '真相全貌', '底牌全翻', '尽数揭开', '无一隐瞒',
            '真相大白', '谜底揭晓'],
    },
];

/** 节奏档位判定词表。 */
const FAST_WORDS = [
    '一鸣惊人', '震惊全场', '碾压', '反杀', '逆转', '翻盘', '狂喜', '轰动', '大获全胜', '轻松拿下',
    '秒杀', '横扫', '一战成名', '哗然', '欢呼', '夺魁', '力挽狂澜', '全场哗然', '技惊四座', '破纪录',
];
const SLOW_WORDS = [
    '絮叨', '闲坐', '琐事', '琐碎', '细水长流', '沉淀', '酝酿', '等待', '静默', '发呆', '熬',
    '蹉跎', '消磨', '打发', '磨蹭', '缓慢', '一点点', '不急不缓', '照旧',
];

/** 判据默认阈值（可被调用方覆盖）。 */
export const PACING_DEFAULTS = {
    /** 反向刹车：命中几组配额信号才触发。 */
    brakeGroups: 2,
    /** 反向刹车档位：blocking（阻断）/ warning（只报）/ off（不判）。 */
    brake: 'blocking',
    /** 一章内同一类事件命中几次才算「这一章是这类」。 */
    typeMinHits: 2,
    /** 快档判定：命中几个快档词算快章。 */
    fastMinHits: 3,
    /** 慢档判定：命中几个慢档词算慢章。 */
    slowMinHits: 3,
    /** 每卷章数（快档配额的计数窗口）。 */
    volumeChapters: 20,
    /** 每卷快档配额。 */
    maxFastPerVolume: 3,
    /** 连续快档上限。 */
    maxConsecutiveFast: 1,
    /** 慢档密度窗口（章）。 */
    slowWindow: 4,
    /** 密度窗口内慢档上限。 */
    maxSlowPerWindow: 2,
};

function countAll(text, needle) {
    let count = 0;
    let idx = text.indexOf(needle);
    while (idx !== -1) { count += 1; idx = text.indexOf(needle, idx + needle.length); }
    return count;
}

/**
 * 细纲里的显式节奏声明（优先于关键词推断）。
 * 认「节奏：冲突爽点」这类写法——作者/模型自己声明的事件类型比词频推断可信。
 * @returns {string[]} 命中的事件类型 id（可为空）
 */
export function parseOutlineTypes(outline) {
    const text = String(outline ?? '');
    if (text === '') return [];
    const out = [];
    const re = /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?(?:本章节奏|节奏|事件类型|事件类别|本章事件)(?:\*\*)?\s*[：:]\s*([^\n]+)/g;
    let m = re.exec(text);
    while (m !== null) {
        const value = m[1];
        for (const t of EVENT_TYPES) {
            if (value.includes(t.name) || value.includes(t.id)) {
                if (!out.includes(t.id)) out.push(t.id);
            }
        }
        m = re.exec(text);
    }
    return out;
}

/**
 * 本章的事件类型（显式声明优先，关键词推断兜底）。
 * @returns {string[]} 事件类型 id（可能为空——判不出就不归类，不硬凑）
 */
export function detectEventTypes(content, { outline = '', minHits = PACING_DEFAULTS.typeMinHits } = {}) {
    const declared = parseOutlineTypes(outline);
    if (declared.length > 0) return declared;
    const text = String(content ?? '');
    const hits = [];
    for (const t of EVENT_TYPES) {
        let n = 0;
        for (const w of t.words) n += countAll(text, w);
        if (n >= minHits) hits.push({ id: t.id, n });
    }
    // 同分时按 EVENT_TYPES 的声明顺序（冲突 → 羁绊 → 势力 → 风土 → 危机），
    // 避免同一份文本在不同机器上因排序抖动得出不同结论（纯函数必须确定）。
    hits.sort((a, b) => b.n - a.n || EVENT_TYPES.findIndex((t) => t.id === a.id) - EVENT_TYPES.findIndex((t) => t.id === b.id));
    return hits.slice(0, 2).map((h) => h.id);
}

/**
 * 本章的节奏档位：fast（爽点章）/ slow（日常铺垫章）/ normal（其余）。
 */
export function detectTempoTier(content, { fastMinHits = PACING_DEFAULTS.fastMinHits, slowMinHits = PACING_DEFAULTS.slowMinHits } = {}) {
    const text = String(content ?? '');
    let fast = 0;
    for (const w of FAST_WORDS) fast += countAll(text, w);
    let slow = 0;
    for (const w of SLOW_WORDS) slow += countAll(text, w);
    if (fast >= fastMinHits && fast >= slow) return 'fast';
    if (slow >= slowMinHits && slow > fast) return 'slow';
    return 'normal';
}

/**
 * 反向刹车（主判据，纯函数）。
 *
 * 触发条件：**同时**满足
 *   ① 出现 ≥1 个解决类信号词；
 *   ② 命中 ≥N 组配额信号（默认 2 组：主线格局变化 / 关系决定性升级 / 秘密完整揭露）。
 *
 * 为什么要求「同时」：只命中 2 组配额信号但没有「彻底解决」类词，多半是章节
 * 里同时谈到了格局与关系、但没真的把事解决——那是正常叙事，不该拦。
 *
 * @returns {{triggered:boolean, words:string[], groups:{id,name,hits:string[]}[], message:string}}
 */
export function analyzeResolutionBrake({ content = '', options = {} } = {}) {
    const opt = { ...PACING_DEFAULTS, ...options };
    const text = String(content ?? '');
    const words = RESOLUTION_WORDS.filter((w) => text.includes(w));
    const groups = QUOTA_GROUPS
        .map((g) => ({ id: g.id, name: g.name, hits: g.words.filter((w) => text.includes(w)) }))
        .filter((g) => g.hits.length > 0);
    const triggered = words.length >= 1 && groups.length >= opt.brakeGroups;
    let message = '';
    if (triggered) {
        message = `反向刹车：这一章同时动了 ${groups.map((g) => g.name).join('、')}，并出现解决类表述「${words.slice(0, 3).join('、')}」`
            + '——一章把长线的底牌全翻，后面就无事可写了。本章只推进一步：格局/关系/秘密里挑一样动，其余留到后面几章分次解决。';
    }
    return { triggered, words, groups, message };
}

/**
 * 把 novel.json 里的 pacing 状态表读成「章号 → 记录」的列表（缺字段一律当没有）。
 * 状态表形状：{ chapters: { "12": { types: ['conflict'], tier: 'fast' } } }
 */
export function pacingChapters(pacing) {
    const raw = pacing?.chapters;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
    return Object.entries(raw)
        .map(([k, v]) => ({
            chapter: Number(k),
            types: Array.isArray(v?.types) ? v.types.filter((x) => typeof x === 'string') : [],
            tier: typeof v?.tier === 'string' ? v.tier : 'normal',
        }))
        .filter((x) => Number.isInteger(x.chapter) && x.chapter > 0)
        .sort((a, b) => a.chapter - b.chapter);
}

/** 某类事件上次用在哪一章（没有则 null）。 */
export function lastUsedChapter(chapters, typeId) {
    let last = null;
    for (const c of chapters) {
        if (c.types.includes(typeId)) last = c.chapter;
    }
    return last;
}

/**
 * 冷却判定：某类事件在第 chapter 章是否仍在冷却中。
 * 冷却 C 章 = 用过之后的 C 章内不可再用（lastUsed=10, C=2 → 11、12 章冷却，13 章可用）。
 */
export function onCooldown(chapters, typeId, chapter, cooldown) {
    const last = lastUsedChapter(chapters, typeId);
    if (last === null) return false;
    return (chapter - last) <= cooldown;
}

/**
 * 连续快档链的长度：从本章（chapter）往前数，**章号严格相邻**且档位为 fast 的章数。
 *
 * 「连续」必须按章号算，不能按「最近一条记录」算——第 10 章是快档、第 13 章才动笔，
 * 中间两章没有记录，那不叫「连着快档」。按记录链算会得出「第10章是快档、连着 2 章爽点」
 * 这种章号和数字对不上的告警，属于凭空捏造的证据。
 *
 * 章号相邻性只认「本章往前的紧邻链」：第 chapter 章往前第 1 章没有记录 → 链断 → 0。
 * 缺记录不等于快档（宁可漏判也不误判，与本模块其他判据同一原则）。
 *
 * @param past    已有记录（章号升序，通常已过滤掉 chapter 本章）
 * @param chapter 本章章号
 * @returns {number} 紧邻的连续快档章数
 */
export function consecutiveFastChain(past = [], chapter = 0) {
    const list = Array.isArray(past) ? past : [];
    let run = 0;
    let prev = Number(chapter) || 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
        const c = list[i];
        if (!c || c.tier !== 'fast') break;
        if (prev - c.chapter !== 1) break;
        run += 1;
        prev = c.chapter;
    }
    return run;
}

/**
 * 本章的节奏记录（写进 novel.json.pacing.chapters[n] 的形状）。
 * 纯函数：同一份正文 + 同一份细纲 → 同一份记录（可重放、可对账）。
 */
export function pacingRecord({ content = '', outline = '' } = {}) {
    return {
        types: detectEventTypes(content, { outline }),
        tier: detectTempoTier(content),
    };
}

/**
 * 跨章节奏体检（主入口，纯函数）。
 *
 * @param content   本章正文
 * @param chapter   本章章号
 * @param outline   本章细纲（显式声明优先）
 * @param pacing    novel.json 的 pacing 状态表
 * @param options   阈值覆盖
 * @returns {{issues:string[], metrics:object, record:{types:string[], tier:string}, brake:object}}
 */
export function analyzePacing({ content = '', chapter = 0, outline = '', pacing = null, options = {} } = {}) {
    const opt = { ...PACING_DEFAULTS, ...options };
    const text = String(content ?? '');
    const chapters = pacingChapters(pacing);
    const past = chapters.filter((c) => c.chapter < chapter);
    const record = pacingRecord({ content, outline });
    const issues = [];
    const metrics = { chapter, types: record.types, tier: record.tier, cooling: [], tempo: {} };

    // ② 事件冷却：本章归到的类型里，有没有还在冷却中的
    for (const id of record.types) {
        const def = EVENT_TYPES.find((t) => t.id === id);
        if (def === undefined) continue;
        const last = lastUsedChapter(chapters, id);
        if (last === null) continue;
        const cd = Number.isInteger(opt.cooldown?.[id]) ? opt.cooldown[id] : def.cooldown;
        if ((chapter - last) <= cd) {
            metrics.cooling.push({ id, name: def.name, last, cooldown: cd, readyAt: last + cd + 1 });
            issues.push(`事件类型「${def.name}」还在冷却中：上次用在第${last}章，冷却 ${cd} 章（要到第${last + cd + 1}章才能再用）`
                + '——连着写同一类事件，读者会觉得「又是这一套」。本章换一类，或在细纲里改声明的事件类型。');
        }
    }

    // ③ 节奏档位
    const tier = record.tier;
    metrics.tempo.tier = tier;
    if (tier === 'fast') {
        // 连续快档：只认**章号紧邻**的快档链（见 consecutiveFastChain 的口径说明）
        const run = consecutiveFastChain(past, chapter);
        metrics.tempo.consecutiveFast = run;
        if (run + 1 > opt.maxConsecutiveFast) {
            const first = chapter - run;
            const last = chapter - 1;
            const span = first === last ? `第${first}章` : `第${first}–${last}章`;
            const desc = run === 1
                ? `${span}已经是快档（爽点章）`
                : `${span}连着 ${run} 章都是快档（爽点章）`;
            issues.push(`连续快档：${desc}，本章又快档——连着 ${run + 1} 章爽点`
                + `（上限 ${opt.maxConsecutiveFast} 章），读者会疲劳。中间插一章日常/铺垫。`);
        }
        // 每卷快档配额
        const volSize = Number.isInteger(opt.volumeChapters) && opt.volumeChapters > 0 ? opt.volumeChapters : PACING_DEFAULTS.volumeChapters;
        const volStart = Math.floor((chapter - 1) / volSize) * volSize + 1;
        const volFast = past.filter((c) => c.chapter >= volStart && c.tier === 'fast').length + 1;
        metrics.tempo.volume = { start: volStart, end: volStart + volSize - 1, fast: volFast };
        if (volFast > opt.maxFastPerVolume) {
            issues.push(`快档配额超了：第${volStart}–${volStart + volSize - 1}章这一卷里已有 ${volFast} 个快档`
                + `（配额 ${opt.maxFastPerVolume} 个/卷）——爽点用光了，后半卷会平。`);
        }
    }
    if (tier === 'slow') {
        const win = Number.isInteger(opt.slowWindow) && opt.slowWindow > 0 ? opt.slowWindow : PACING_DEFAULTS.slowWindow;
        const recent = past.filter((c) => c.chapter > chapter - win);
        const slowCount = recent.filter((c) => c.tier === 'slow').length + 1;
        metrics.tempo.slowWindow = { size: win, slow: slowCount };
        if (slowCount > opt.maxSlowPerWindow) {
            issues.push(`慢档过密：最近 ${win} 章里有 ${slowCount} 章是日常/铺垫章（上限 ${opt.maxSlowPerWindow} 章）`
                + '——连着几章没推进，读者会觉得这章可以不读。');
        }
    }

    // ① 反向刹车（判定独立，blocking 与否由调用方决定）
    const brake = analyzeResolutionBrake({ content, options });

    return { issues, metrics, record, brake };
}

/**
 * 写前推荐（简报用，纯函数）。
 *
 * 给模型三个可执行的答案：哪类事件现在**可以写**、哪类还在**冷却**、
 * 当前节奏档位处于什么状态。「推荐」不是命令——它只是把冷却状态翻译成人话，
 * 让模型在动笔前就知道上一章刚用过哪类。
 *
 * @returns {{recommended:{id,name,why}[], cooling:{id,name,lastUsed,readyAt}[], tempo:object, line:string}}
 */
export function pacingRecommendation({ pacing = null, chapter = 0, options = {} } = {}) {
    const opt = { ...PACING_DEFAULTS, ...options };
    const chapters = pacingChapters(pacing);
    const past = chapters.filter((c) => c.chapter < chapter);

    const cooling = [];
    const ready = [];
    for (const t of EVENT_TYPES) {
        const cd = Number.isInteger(opt.cooldown?.[t.id]) ? opt.cooldown[t.id] : t.cooldown;
        const last = lastUsedChapter(chapters, t.id);
        if (last !== null && (chapter - last) <= cd) {
            cooling.push({ id: t.id, name: t.name, lastUsed: last, readyAt: last + cd + 1 });
        } else {
            const idle = last === null ? chapter : chapter - last - cd;
            ready.push({ id: t.id, name: t.name, idle, lastUsed: last });
        }
    }
    // 推荐「最饿」的那类：闲置越久越该写。
    ready.sort((a, b) => b.idle - a.idle || EVENT_TYPES.findIndex((t) => t.id === a.id) - EVENT_TYPES.findIndex((t) => t.id === b.id));
    const recommended = ready.slice(0, 2).map((r) => ({
        id: r.id,
        name: r.name,
        why: r.lastUsed === null ? '本书还没写过这类' : `上次写这类是第${r.lastUsed}章，已过冷却`,
    }));

    // 节奏档位实况（连续快档与 analyzePacing 同一口径：章号紧邻才算「连续」）
    const consecutiveFast = consecutiveFastChain(past, chapter);
    const volSize = Number.isInteger(opt.volumeChapters) && opt.volumeChapters > 0 ? opt.volumeChapters : PACING_DEFAULTS.volumeChapters;
    const volStart = Math.floor((chapter - 1) / volSize) * volSize + 1;
    const volFast = past.filter((c) => c.chapter >= volStart && c.tier === 'fast').length;
    const tempo = {
        // lastTier = **最近一条记录**的档位（跳章时未必等于「上一章」）；
        // 「上一章是不是快档」问 consecutiveFast——它只认章号紧邻的链。
        lastTier: past.length > 0 ? past[past.length - 1].tier : 'normal',
        consecutiveFast,
        volume: { start: volStart, end: volStart + volSize - 1, fast: volFast, quota: opt.maxFastPerVolume },
        slowWindow: { size: opt.slowWindow, slow: past.filter((c) => c.chapter > chapter - opt.slowWindow && c.tier === 'slow').length },
    };

    // 一行摘要（简报段直接用；空状态不啰嗦）
    const parts = [];
    if (recommended.length > 0) parts.push(`建议本章考虑：${recommended.map((r) => r.name).join(' / ')}`);
    if (cooling.length > 0) parts.push(`冷却中别用：${cooling.map((c) => `${c.name}（第${c.readyAt}章解冻）`).join('、')}`);
    if (tempo.consecutiveFast + 1 > opt.maxConsecutiveFast) parts.push('上一章是快档（爽点章），本章别再连着快');
    if (tempo.volume.fast >= opt.maxFastPerVolume) parts.push(`本卷快档已用 ${tempo.volume.fast}/${tempo.volume.quota}`);
    const line = parts.join('；');

    return { recommended, cooling, tempo, line };
}
