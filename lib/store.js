// lib/store.js — 书目数据布局与机器状态（纯函数 + 路径表）。
// 机器状态一律 JSON（AGENTS.md 不变量 6）；人类/模型文档一律 Markdown。

import { chapterFileName, sanitizeTitle, nextSuffixedId } from './versioning.js';

/** 书内相对路径表（POSIX，工作区相对）。 */
export function pathsFor(book) {
    const b = book;
    // 正文目录名单一真相：chapterFile 与 repair 的孤儿扫描共用它。
    // 各处再拼一次字面量，目录改名时写入与扫描会分家——扫描扫不到东西会报「零孤儿」，
    // 那是假清白，比报错更糟。
    const chaptersDir = `${b}/正文`;
    return {
        // 书名随路径表走（assertBookName 保证不含 /，可从 meta 反解）——io 装配层
        // 手上只有 p 没有 book 时（continuity-io 等）用它做路径收口，不必层层加参。
        bookName: b,
        meta: `${b}/novel.json`,
        bookOutline: `${b}/大纲/全书大纲.md`,
        outlineDir: `${b}/大纲/细纲`,
        chapterOutline: (n) => `${b}/大纲/细纲/第${n}章.md`,
        character: (name) => `${b}/人物/${sanitizeTitle(name)}.md`,
        worldbook: `${b}/设定/世界书.json`,
        glossary: `${b}/设定/术语表.json`,
        promise: `${b}/设定/故事承诺书.md`,
        sceneContracts: `${b}/设定/场景契约.json`,
        voices: `${b}/设定/语言基因.json`,
        facts: `${b}/账本/facts.json`,
        foreshadows: `${b}/账本/伏笔.json`,
        audit: `${b}/.novel/audit.jsonl`,
        styleBaseline: `${b}/.novel/style-baseline.json`,
        // G1 检索索引（派生物：删了重跑即得，绝不参与一致性判定）
        indexDb: `${b}/.novel/index.db`,
        proposalsDir: `${b}/.novel/proposals`,
        proposal: (id) => `${b}/.novel/proposals/${id}.json`,
        // 批量起草断点检查点（机器状态：中断后 resume 用）
        batchCheckpoint: `${b}/.novel/batch-checkpoint.json`,
        // 写前简报的依据指纹记录（机器状态：章号 → 简报生成时的依据哈希）。
        // 写章提交时拿它核对「简报是否已过期」——见 lib/basis.js。
        basis: `${b}/.novel/basis.json`,
        // 章节文件名格式统一走 versioning.chapterFileName（与 parseChapterFileName/nextVersion 同源）
        chaptersDir,
        chapterFile: (n, title, v) => `${chaptersDir}/${chapterFileName(n, title, v)}`,
    };
}

/**
 * `novel.json` 的数据格式版本锚点（方向3）。
 *
 * 为什么要有它：此前每次加字段/改语义都是「临时补丁」（如 worldbook id 回填），
 * 盘上数据到底是哪一版、还差哪些结构，没人能判定。落一个版本号后，「这本旧书需要升级」
 * 成为可判定的事实；升级逻辑集中在 migrateNovel（幂等、失败不阻断写作）。
 *
 * 维护约定：改了 novel.json 的结构（新增必需容器字段 / 字段语义变更）就 +1，
 * 并在 migrateNovel 里补对应的补结构分支。纯加可选字段不算。
 */
export const SCHEMA_VERSION = 1;

/**
 * 书目稳定 id（方向4）：书目录名会被改名/被多根同名拷贝撞车，`book` 只是**定位用的
 * 目录名**，不是身份。落一个稳定 id 后，「同名书的哪一份」才有可靠判据。
 * 刻意不 import node:crypto——本模块会被打进浏览器 bundle（panel 与宿主共用会话判据）。
 */
export function newBookId(now = Date.now()) {
    return `nb_${now.toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * novel.json 数据格式迁移（**纯函数**，幂等）。旧书读到时自动补齐结构锚点。
 *
 * 语义（重要）：
 *   - 只**补结构**、不改内容：缺失的容器字段补空壳，旧书补稳定 id。
 *   - 版本缺失 → 视为 v0；已是当前 → 只补缺的字段；**高于当前 → 一律不动**
 *     （用户可能装过更新的插件，本地降级不得把数据改坏）。
 *   - 幂等：对已迁移的书再跑一次返回 changed:false。
 *
 * @returns {{ novel, from:number, to:number, changed:boolean, notes:string[] }}
 */
export function migrateNovel(novel) {
    const notes = [];
    if (novel === null || typeof novel !== 'object') return { novel, from: 0, to: 0, changed: false, notes };
    const from = Number.isInteger(novel.schemaVersion) ? novel.schemaVersion : 0;
    if (from > SCHEMA_VERSION) {
        notes.push(`本书数据版本 v${from} 高于本插件支持的 v${SCHEMA_VERSION}——可能装过更新的插件，不做降级迁移`);
        return { novel, from, to: from, changed: false, notes };
    }
    let changed = false;
    const ensureObj = (key, label) => {
        if (novel[key] === null || typeof novel[key] !== 'object' || Array.isArray(novel[key])) {
            novel[key] = {}; changed = true; notes.push(label);
        }
    };
    if (typeof novel.id !== 'string' || novel.id === '') { novel.id = newBookId(); changed = true; notes.push('补稳定 id'); }
    if (!Array.isArray(novel.sessions)) { novel.sessions = []; changed = true; notes.push('补会话归属集'); }
    if (!Array.isArray(novel.cast)) { novel.cast = []; changed = true; notes.push('补人物名册'); }
    if (!Array.isArray(novel.proposals)) { novel.proposals = []; changed = true; notes.push('补提案索引'); }
    ensureObj('chapters', '补章节索引');
    ensureObj('gateFailures', '补熔断计数');
    ensureObj('approvals', '补审批表');
    // 克隆书曾落成 approvals:{}，approve 读 approvals.outline 会 TypeError——旧书一并补上
    if (novel.approvals.outline === null || typeof novel.approvals.outline !== 'object' || Array.isArray(novel.approvals.outline)) {
        novel.approvals.outline = {}; changed = true; notes.push('补细纲审批对象（缺它 approve 会报错）');
    }
    if (from < SCHEMA_VERSION) { changed = true; notes.push(`数据格式 v${from} → v${SCHEMA_VERSION}`); }
    novel.schemaVersion = SCHEMA_VERSION;
    return { novel, from, to: SCHEMA_VERSION, changed, notes };
}

/**
 * 新书机器状态。session 传了就把创建会话记进归属集（面板按会话过滤列表）。
 * platform / charLimits 是**开书时收集**的字数口径（用户 2026-10-20）：
 * 两者都是可选——不给就不落字段，行为与旧版一字不差（判定回落到插件配置）。
 */
export function defaultNovel({
    title, genre, logline = '', now = new Date().toISOString(), session = null,
    platform = '', charLimits = null,
}) {
    return {
        id: newBookId(),
        // 数据格式版本锚点：新书直接落当前版本，旧书由 migrateNovel 在读到时补齐
        schemaVersion: SCHEMA_VERSION,
        title,
        genre,
        logline,
        sessions: session ? [session] : [],
        ...(platform === '' ? {} : { platform }),
        ...(charLimits === null || charLimits === undefined ? {} : { charLimits: { min: charLimits.min, max: charLimits.max } }),
        // 九阶段状态机（lib/phases.js）的当前阶段；phases 记每阶段状态与 PhaseReport。
        stage: 'topic',
        phases: {},
        createdAt: now,
        updatedAt: now,
        approvals: { outline: {} },
        chapters: {},
        cast: [],
        proposals: [],
        // 熔断计数器（lib/circuit-breaker.js）：章号 → 连续驳回次数。
        gateFailures: {},
        // 细纲契约段策略：新建的书默认 strict——save_chapter 缺「## 本章必写场景」段
        // （或有段无条目）直接驳回。存量旧书无此字段＝warn（不拒稿但留痕提示补段），
        // 老写法的自由文本细纲不受冲击（lib/tools/outline-tool.js save_chapter 消费）。
        outlineContract: 'strict',
    };
}

/**
 * 字数口径的**唯一真相表**（T1 + 用户 2026-10-20 追加自定义档）。
 *
 * 生效优先级：本书自定义（`novel.charLimits`）> 平台口径（`novel.platform`）> 插件配置。
 * 三档全都拿不到时才是「未设置」——沿用调用方 config，默认行为一字不变。
 *
 * 为什么数字必须只写在这里：此前番茄 1500–3000 / 起点 2000–4000 在 `platform-review.js`
 * 的判定里各抄了一份字面量，`store.js` 又抄了第三份——「审稿口径」与「写作门禁口径」
 * 一旦漂移，就回到本轮要消灭的那个病：同一章在两处得到相反结论。现在 platform-review
 * 反向 import 本表，字面量全仓只剩这一处。
 *
 * 平台 id 集合同理单点：PLATFORM_IDS 直接从 PLATFORM_PROFILES 键派生（曾吃过三处
 * 声明的亏——platform-review 的审稿表键集与这张档案表靠人肉对齐，分家时
 * project-tool 的准入放行、审稿函数却炸「未知平台」，或反之）。platform-review
 * 侧另有模块加载时的键集对账（缺谁加载即抛，npm test 立刻红）。
 */
export const PLATFORM_PROFILES = {
    qidian: { id: 'qidian', name: '起点', minChapterChars: 2000, maxChapterChars: 4000, landing: '' },
    fanqie: { id: 'fanqie', name: '番茄', minChapterChars: 1500, maxChapterChars: 3000, landing: '2800–2990' },
    // 晋江：订阅制按千字计费，全勤基准档 3000 字/日、月度底线「每章不少于 3000」——下限是硬的
    // （字数即收入，短章是读者实亏与高频差评源）；上限 6000，手机端长章同样掉追读，宁拆章。
    jjwxc: { id: 'jjwxc', name: '晋江', minChapterChars: 3000, maxChapterChars: 6000, landing: '' },
    // 七猫：免费流（广告分成），完读率/阅读时长导向同番茄；日更 4000 惯例常拆两章 → 单章 2000–3500
    //（作家助手硬底线是单章 >500，但那只是能发的下限，不是能留住人的下限）。
    qimao: { id: 'qimao', name: '七猫', minChapterChars: 2000, maxChapterChars: 3500, landing: '' },
    // 飞卢：单章区间是两段式——上架前 1500–2000、上架后 2500–5050（2026-06 前后公开规则；
    // VIP 章不满 1000 字不计费、不计入全勤；日更保底 4000、全勤 6000）。单一档案装不下两段，
    // 这里取包络 1500–5050：写作门禁按包络放行，细口径由 reviewFeilu 的字数项分带给 advice
    // （两带间隙 2001–2499 单独 warn，不冒充合格）。
    feilu: { id: 'feilu', name: '飞卢', minChapterChars: 1500, maxChapterChars: 5050, landing: '' },
};

/** 平台 id 集合 = 档案表键派生（唯一声明点；见上方注释）。 */
export const PLATFORM_IDS = Object.keys(PLATFORM_PROFILES);

/** 自定义字数区间的合理边界（防手滑填 20 或 200000 把门禁变成摆设/死闸）。 */
export const CHAR_LIMITS_MIN = 100;
export const CHAR_LIMITS_MAX = 20000;

/**
 * 平台字段解析（纯函数）：'' = 未设置；合法 id 归一为小写；**非法 → null**
 * （调用方自己决定是报错还是忽略——写入口报错，读入口按未设置处理）。
 */
export function parsePlatform(value) {
    if (value === undefined || value === null) return '';
    const s = String(value).trim().toLowerCase();
    if (s === '') return '';
    return PLATFORM_IDS.includes(s) ? s : null;
}

/** 书上的平台（纯读）。手工改坏的 novel.json 不 throw——非法值一律按未设置处理。 */
export function platformOf(novel) {
    const p = parsePlatform(novel?.platform);
    return p === null ? '' : p;
}

/**
 * 自定义每章字数区间的解析（纯函数，**写入面用它**）：
 * @returns {{ ok:true, limits:{min,max}|null } | { ok:false, error:string }}
 *  - 两值都不给（undefined/null/空串）→ `limits: null`＝清除自定义，回落到平台/插件档。
 *  - 只给一头、非整数、越界、min>max → ok:false（写入口必须响亮报错，不能静默半套）。
 */
export function parseCharLimits(rawMin, rawMax) {
    const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    const minBlank = blank(rawMin);
    const maxBlank = blank(rawMax);
    if (minBlank && maxBlank) return { ok: true, limits: null };
    if (minBlank !== maxBlank) {
        return { ok: false, error: '自定义字数区间必须**同时**给下限与上限（只给一个等于没说）；要清除设置就两个都留空。' };
    }
    const min = Number(rawMin);
    const max = Number(rawMax);
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
        return { ok: false, error: `字数区间必须是整数（收到 ${rawMin} / ${rawMax}）。` };
    }
    if (min < CHAR_LIMITS_MIN || max > CHAR_LIMITS_MAX) {
        return { ok: false, error: `字数区间要在 ${CHAR_LIMITS_MIN}–${CHAR_LIMITS_MAX} 之间（收到 ${min}–${max}）。` };
    }
    if (min > max) return { ok: false, error: `下限不能大于上限（${min} > ${max}）。` };
    return { ok: true, limits: { min, max } };
}

/**
 * 「2500-3500」这类**区间文本**的解析（工具面与 REST 面共用一份，防两处语法漂移）。
 * 分隔符接受 - – — ~ 、/ 逗号 斜杠 **与空白**（空格/制表/全角空格）；一个数也不给
 * → 清除（limits:null）。只给一个数（"2500"、"2500-"）一律报错：半套区间比没有区间更危险。
 * 返回值三分：`limits` 为对象＝设置；`null`＝清除；`undefined`＝**缺省（没提供）**——调用方
 * 自行决定语义（工具面「不动」，REST 写端点按不变量 #11 响亮报错）。
 */
export function parseCharsSpec(value) {
    if (value === undefined || value === null) return { ok: true, limits: undefined };
    const s = String(value).trim();
    if (s === '') return { ok: true, limits: null };
    const parts = s.split(/[-–—~、,，/]|\s+/).filter((x) => x !== '');
    if (parts.length !== 2) {
        return { ok: false, error: `字数区间要写成「下限-上限」两个数（如 2500-3500），收到「${s.slice(0, 40)}」。要清除就传空串。` };
    }
    return parseCharLimits(parts[0], parts[1]);
}

/**
 * 读书上的自定义区间（纯读，**判定链用它**）。手工改坏/半套的 novel.json 不 throw：
 * 任何不完整的自定义档一律按「没有自定义」处理，回落平台/插件档——门禁宁可回到
 * 已知可用的口径，也不要拿一个残缺区间去放行 0 字或拒掉一切。
 */
export function charLimitsOf(novel) {
    const raw = novel?.charLimits;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const parsed = parseCharLimits(raw.min, raw.max);
    return parsed.ok ? parsed.limits : null;
}

/**
 * config → **本书当前平台的字数区间**。未设置平台时连对象都原样返回（同一个引用），
 * 「默认行为一字不变」是结构性保证而不是巧合。
 * 需要「含自定义档」的完整判据请用 `effectiveCharConfig`。
 */
export function charConfigForPlatform(config, platform) {
    if (!PLATFORM_IDS.includes(platform)) return config;
    const prof = PLATFORM_PROFILES[platform];
    return { ...config, minChapterChars: prof.minChapterChars, maxChapterChars: prof.maxChapterChars };
}

/**
 * 本书**真正生效**的字数口径（判定链唯一入口）：自定义 > 平台 > 插件配置。
 * 三级都没动过时原样返回传入的 config 引用（默认行为的结构性保证）。
 * 返回 `{ config, source }`，source ∈ 'custom' | 'platform' | 'config'——
 * 回执与面板要告诉用户「这个数是哪儿来的」，只给数字不算说清楚。
 */
export function effectiveCharConfig(config, novel) {
    const custom = charLimitsOf(novel);
    if (custom !== null) {
        return { config: { ...config, minChapterChars: custom.min, maxChapterChars: custom.max }, source: 'custom' };
    }
    const platform = platformOf(novel);
    // 平台档的换算只有 charConfigForPlatform 一份实现，这里只做「有没有平台」的分派
    // ——判定链若各自拼一遍 min/max，就又是「两处数字不一样」的老病。
    return platform === ''
        ? { config, source: 'config' }
        : { config: charConfigForPlatform(config, platform), source: 'platform' };
}

/** 生效口径的一句话出处（面板与工具回执共用）。 */
export function charConfigSourceLabel(source, novel) {
    if (source === 'custom') return '本书自定义';
    if (source === 'platform') {
        const prof = PLATFORM_PROFILES[platformOf(novel)];
        return prof === undefined ? '平台口径' : `${prof.name}平台口径`;
    }
    return '本插件配置（默认）';
}

/**
 * 工具/REST 输出用的字数口径视图（纯函数）。
 * **undefined 的键一律不进对象**——宿主对工具输出做 lossless JSON 严格校验，
 * 多一个 null/undefined 字段就整次调用被拒（S1 事故的同一类）。
 * 所以这里返回的是「有自定义才带 charLimits，其余三键恒在」的形状，调用方直接展开。
 */
export function charLimitsView(config, novel) {
    const custom = charLimitsOf(novel);
    const { config: eff, source } = effectiveCharConfig(config, novel);
    return {
        ...(custom === null ? {} : { charLimits: `${custom.min}-${custom.max}` }),
        charMin: eff.minChapterChars,
        charMax: eff.maxChapterChars,
        charSource: source,
    };
}

/** 平台字数口径的文案单一真相：novel_outline / novel_write_chapter 的描述共用它，防两处漂移。 */
export function platformLimitsText() {
    return PLATFORM_IDS.map((id) => {
        const p = PLATFORM_PROFILES[id];
        return `${p.name} ${p.minChapterChars}–${p.maxChapterChars}`
            + (p.landing === '' ? '' : `（建议落点 ${p.landing}，别贴 ${p.maxChapterChars} 顶线）`);
    }).join('、');
}

/**
 * 「本书生效口径是怎么算出来的」这条说明的唯一写法（工具回执与面板共用）。
 * @param config 插件配置（第三档兜底）
 * @param novel  本书（读 charLimits / platform；也接受已经改好的对象）
 */
export function charLimitsNote(config, novel) {
    const { config: eff, source } = effectiveCharConfig(config, novel);
    const target = Math.round((eff.minChapterChars + eff.maxChapterChars) / 2);
    const where = charConfigSourceLabel(source, novel);
    const head = `本书每章字数按${where}判定：${eff.minChapterChars}–${eff.maxChapterChars} 字（目标约 ${target} 字）。`;
    if (source === 'custom') {
        return head + '想改回来：novel_project action=chars（两个数都传空即清除，回落到平台/插件口径）。';
    }
    if (source === 'platform') {
        return head + `想自定义：novel_project action=chars 传 chars: "2500-3500"（自定义优先于平台口径）。`;
    }
    return head + '本书既没设平台也没设自定义区间；要按平台走用 novel_project action=platform，要自己定用 action=chars。';
}

/** 平台设置的落点提示（novel_project action=platform 的回执文案）。 */
export function platformNote(platform) {
    if (platform === '') {
        return '本书未设置平台——写作门禁按本插件配置的字数口径（默认 2000–4000、目标 3000 字左右），novel_audit 不显式传 platform 就不跑平台审稿。';
    }
    const p = PLATFORM_PROFILES[platform];
    return `本书平台＝${p.name}：写章门禁 ${p.minChapterChars}–${p.maxChapterChars} 字`
        + (p.landing === '' ? '' : `（建议落点 ${p.landing}）`)
        + `，novel_audit 不显式传 platform 时默认跑${p.name}审稿。`
        + '本书若另设了自定义字数区间，以区间为准（action=chars 可清除）。';
}

/**
 * 会话归属：这本书是否属于某会话。
 *
 * 列表按会话过滤（「项目跟会话走」）的**唯一判据**，所以放在这里当纯函数，
 * 服务端 REST 与面板共用一份实现。`sessions` 缺失/为空 = 未归属（旧版建的书），
 * 不属于任何会话 —— 由面板的「认领」通道补录。
 */
export function bookInSession(novel, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    return (novel?.sessions ?? []).includes(sessionId);
}

/** 是否未归属（任何会话都看不到，等认领）。 */
export function isUnclaimed(novel) {
    return (novel?.sessions ?? []).length === 0;
}

/**
 * 把会话补录进书的归属集。
 * @returns {boolean} 是否真的改了（已存在或 sessionId 为空 → false）
 */
export function addBookSession(novel, sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return false;
    if (!Array.isArray(novel.sessions)) novel.sessions = [];
    if (novel.sessions.includes(sessionId)) return false;
    novel.sessions.push(sessionId);
    return true;
}

/** 章节 index 记录（novel.json.chapters[n]）。files 保留近 20 个版本文件名。
 *  gate 传入时落盘契约指标（覆盖率/偏离度/漏写场景/命中禁项，带时间戳）——趋势可查。 */
export function chapterRecord(prev, { title, version, file, chars, summary, gate }) {
    const base = prev ?? { title, versions: [], files: [] };
    return {
        title,
        versions: [...new Set([...(base.versions ?? []), version])].sort((a, b) => a - b),
        files: [...(base.files ?? []), { version, file }].slice(-20),
        latest: version,
        path: file,
        chars,
        // summary 缺省补 ''：REST 面板存章不传 summary（undefined 混进 novel_project
        // status/repair 的输出会让宿主 lossless JSON 拒收整次调用——真机已复现）；
        // 工具写的章在面板再存一版时，旧 summary 也不能被 REST 路径抹掉
        summary: summary ?? base.summary ?? '',
        ...(gate === undefined || gate === null ? (base.gate === undefined ? {} : { gate: base.gate }) : { gate }),
        updatedAt: new Date().toISOString(),
    };
}

/** 从章节记录解析「当前正文」的工作区相对路径（rec.path 优先，回退 files 末条）。
 *  0.13.1 事故：server-api 曾读不存在的 rec.file 还另拼一层 bookId/正文/ → 阅读器恒空。
 *  schema 只认 path / files[].file，两者都已含书目前缀，直接交给 fsio.readText。
 *
 *  路径收口（CodeBuddy 审计 2026-10-09）：novel.json 是数据文件，rec.path 可能被手工
 *  改坏或外来导入污染——REST 面按它 readText **全文回传**，不收口 = 工作区内任意读。
 *  传 bookId 时强制「以 ${bookId}/ 开头 + 无空段/./.. 段」，不合式返回 null（调用方按
 *  缺文件处理）。纯函数，不碰 io。 */
export function containedBookPath(bookId, rel) {
    if (typeof bookId !== 'string' || bookId === '') return null;
    if (typeof rel !== 'string' || rel === '') return null;
    const parts = rel.split('/');
    if (parts.length < 2 || parts[0] !== bookId) return null;
    if (parts.some((seg) => seg === '' || seg === '.' || seg === '..')) return null;
    return rel;
}

export function chapterRelPath(rec, bookId) {
    const rel = rec?.path ?? (rec?.files ?? []).at(-1)?.file ?? null;
    return bookId === undefined ? rel : containedBookPath(bookId, rel);
}

/** 事实账本 / 伏笔台账为空时的初始形态。 */
export const emptyFacts = [];
export const emptyForeshadows = [];

/**
 * 世界书条目 id 的**单一生成入口**。工具（novel_worldbook add）、REST 面板
 * （POST /worldbook）与导入都必须走它，保证 id 方案一致（`W` 前缀自增）。
 *
 * 曾有两条并行方案（工具 `W1`、REST 用 Math.max 数字自增），对已有字符串 id 求
 * 数值会得 NaN → 落盘成 `"id": null`（真机可复现）。统一到 `W` 前缀后这类事故从根上消失。
 */
export function nextWorldEntryId(entries) {
    return nextSuffixedId((Array.isArray(entries) ? entries : []).map((e) => e?.id), 'W');
}

/**
 * 世界书条目 id 的**单一比较入口**。契约是字符串（工具默认 `'W1'`），但历史数据里
 * 可能混有数字（旧 REST 面板建过），一律按字符串比较。
 *
 * ⚠️ 严禁调用方自行 `Number(id)` 强转：`Number('W1')` = NaN，比较恒假 → 面板
 * 「编辑 / 启用·停用」对工具生成的条目**静默失效**（点了没反应，真机已复现）。
 * 任一值为 null/undefined 时返回 false（find 语义：空 id 不匹配任何条目）。
 */
export function sameEntryId(a, b) {
    if (a === undefined || a === null || b === undefined || b === null) return false;
    return String(a) === String(b);
}

/**
 * 世界书条目校验。priority（0-100，默认 50）决定预算不足时的注入顺序。
 *
 * ⚠️ 触发词缺失时的**兜底**不在这里做（那要读盘上的 cast/账本/术语表，属 io）——
 * 由调用方（novel_worldbook add/update）先 `deriveEntryKeywords` 抽词、抽不到再转
 * `always:true`，两条路都带可见 warning。本函数保留抛错分支只服务一类对象：
 * REST 面板与导入等**没有兜底通道**的调用方（它们必须给出词或显式常驻）。
 */
export function normalizeWorldEntry({ id, keywords = [], content, always = false, priority = 50 }, existing = []) {
    if (typeof content !== 'string' || content.trim() === '') throw new Error('世界书条目 content 不能为空');
    if (!Array.isArray(keywords) || (keywords.length === 0 && !always)) {
        throw new Error('世界书条目需要至少一个关键词，或 always:true 常驻注入');
    }
    const eid = id ?? nextWorldEntryId(existing);
    if (existing.some((e) => sameEntryId(e.id, eid))) throw new Error(`世界书条目 id 重复：${eid}`);
    const prio = Number.isInteger(priority) ? Math.max(0, Math.min(100, priority)) : 50;
    return { id: eid, keywords: keywords.map(String), content: content.trim(), always: Boolean(always), priority: prio };
}

/**
 * 从条目内容里挑**本书已知实体名**当触发词（纯函数，零 io）。
 *
 * 为什么要有它：真机首发会话第一条红色报错就是「世界书条目需要至少一个关键词」——
 * 开书阶段要固化的天然是「题材定位/主线/金手指」这类全书级设定，本来就没有触发词，
 * 而 `always` 是个可选布尔，模型得先想到它（常驻 systemPrompt 只带过一句「或 always」）。
 * 按本项目的老规矩：凡是靠模型自觉的约束都会失效，所以这一步由代码补位。
 *
 * 只从**候选名池**里挑（cast ∪ 账本实体 ∪ 术语表 ∪ 已有条目关键词），不凭空造词：
 * 自己拼 2-4gram 会把「的/了」这类噪声送进触发词，命中面失控。
 * 命中内容的最长者优先（「顾氏集团」比「顾氏」更该当词）。
 * @returns string[]（最多 limit 个；一个都没有 → 调用方转 always:true）
 */
export function deriveEntryKeywords(content, names = [], { limit = 5 } = {}) {
    const text = String(content ?? '');
    const seen = new Set();
    const hits = [];
    for (const raw of names) {
        const name = typeof raw === 'string' ? raw.trim() : '';
        // 单字名不当触发词：命中面太宽（「雨」「门」会把无关章节全捞进上下文）
        if (name.length < 2 || seen.has(name)) continue;
        seen.add(name);
        if (text.includes(name)) hits.push(name);
    }
    hits.sort((a, b) => b.length - a.length || a.localeCompare(b));
    return hits.slice(0, Math.max(1, limit));
}

/**
 * 世界书触发词的**兜底决议**（纯函数，add/update 共用）：
 * 给了词或显式常驻 → 原样通过；否则先按内容抽本书已知实体名，抽不到转 `always:true`。
 * 两条兜底路都必须带 warning（UI 失败/降级必须可见，禁止静默）。
 * @returns { keywords, always, warning }  warning 为空串表示没走兜底
 */
export function resolveWorldTrigger({ keywords = [], always = false, content = '', names = [] } = {}) {
    const list = Array.isArray(keywords) ? keywords.filter((k) => typeof k === 'string' && k.trim() !== '') : [];
    if (always === true || list.length > 0) return { keywords: list, always: always === true, warning: '' };
    const derived = deriveEntryKeywords(content, names);
    if (derived.length > 0) {
        return { keywords: derived, always: false, warning: `未给触发词，已按内容自动取词：${derived.join('、')}（不合适请 novel_worldbook update 改）` };
    }
    return {
        keywords: [],
        always: true,
        warning: '未给触发词，且内容里没有本书已知实体名（人物/术语/账本实体）可当触发词——已按 always:true 常驻注入。常驻条目每章都进上下文、吃预算，建议补触发词。',
    };
}
