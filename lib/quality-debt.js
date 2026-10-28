// lib/quality-debt.js — 质量债分级：局部问题不阻塞全书（纯函数，零 IO、零模型调用）。
//
// 补的是本项目门禁体系的一个**视角缺口**：门禁只有 blocking/warnings 两档 +
// 章级熔断。熔断是章级的（同章驳回 3 次锁死）——没问题。但缺**书级视角**：
// 第 30 章有个非致命瑕疵，不该让作者觉得整本书写不下去了；`noai` 扣分、
// 平台审稿的警告项，本质上就该是「记着的债」，而不是「必须当场清零的失败」。
//
// 借竞品 C 的三级（defer_and_continue / stop_for_replan / hard_gate），但**口径按
// 本项目改写**：C 的三级决定「这章能不能落盘」，本项目的落盘口径是既有门禁
// （blocking 拒稿 / warnings 放行），一个字都不许动。本模块只做一件事：
//
//   **把「提示」升级成「带账本的状态」**——每个警告项落成一条**质量债**（有级别、
//   有来源代码、有章号），全书的质量债汇总成一张书级视图。
//
// 级别语义（与 C 同名同义）：
//   minor  质量债       defer_and_continue —— 局部瑕疵，正文保留，继续写下一章
//   major  需重规划     stop_for_replan    —— 影响后续章节的结构，建议停下调整
//   hard   硬门禁放行   hard_gate          —— 本该拒稿、被 force 放行，必须回头核对
//
// 为什么要把 hard 单列一档：force 放行是**人为越过硬约束**，不是瑕疵。它和
// minor 完全不是一回事——minor 可以攒，hard 攒不得。
//
// 纯函数（AGENTS.md 不变量 2）：不碰 io、不取钟、不写文件（时间戳由调用方给）。

/**
 * 三级质量债。
 *
 * `action` 是 C 那套三级动作名，保留是为了口径可对照；本项目**不据此改落盘口径**
 * （那是既有门禁的事），它只决定这条债在书级视图里怎么被对待。
 */
export const DEBT_LEVELS = {
    minor: {
        id: 'minor',
        name: '质量债',
        action: 'defer_and_continue',
        desc: '局部瑕疵——正文保留，记着账，可以继续写下一章。',
    },
    major: {
        id: 'major',
        name: '需重规划',
        action: 'stop_for_replan',
        desc: '影响后续章节的结构（节奏冲突、简报过期）——建议停下调整后再往下写。',
    },
    hard: {
        id: 'hard',
        name: '硬门禁放行',
        action: 'hard_gate',
        desc: '本该拒稿、被 force 放行——这不是瑕疵，是人为越过了硬约束，必须回头核对。',
    },
};

/**
 * 债目代码 → 级别（**单一真相表**）。
 *
 * 为什么集中在一张表：级别散在各调用点写，早晚会出现同一个 code 在两处被标成
 * 不同级别——那书级视图就成了薛定谔的债。本项目在 noai 八维与机审重复检测上
 * 都吃过「同一算式抄两份」的亏，这张表是同一个教训的补丁。
 */
export const DEBT_CODES = {
    // ── minor：局部瑕疵，可欠着 ──────────────────────────────────────────
    'quote-normalized': 'minor',      // 直角引号已自动转（已修，只是提醒）
    'cast-not-in-contract': 'minor',  // 出场人物没写进场景契约（配置项）
    'scene-not-covered': 'minor',      // 细纲必写场景没覆盖到
    'pacing-check': 'minor',           // 节奏体检（事件冷却 / 档位配额）
    'cross-check': 'minor',            // 跨章体检（重复小动作 / 撞场等）
    'noai': 'minor',                   // 去 AI 味扣分项
    'platform-review': 'minor',        // 平台审稿警告
    'ledger-pending': 'minor',         // 账本待复核项
    // ── major：结构性问题，建议停下重规划 ───────────────────────────────
    'pacing-brake-warn': 'major',      // 反向刹车（warning 档）：这章动了太多长线
    'basis-stale': 'major',            // 简报已过期（依据被改过）
    // ── hard：本该拒稿，被 force 放行 ──────────────────────────────────
    'outline-banned-forced': 'hard',   // 细纲禁项被 force 放行
    'pacing-brake-forced': 'hard',     // 节奏刹车被 force 放行
    'content-gate-forced': 'hard',     // 内容门禁被 force 放行
    'machine-audit-forced': 'hard',    // 机审被 force 放行
};

/** 某个债目代码的级别；未知代码按 minor（最宽松的一档——别把没登记的东西算成大事）。 */
export function debtLevelOf(code) {
    const lv = DEBT_CODES[code];
    return typeof lv === 'string' && DEBT_LEVELS[lv] !== undefined ? lv : 'minor';
}

/**
 * 造一条质量债。
 *
 * @param code    债目代码（见 DEBT_CODES）
 * @param message 人话说明（**原样保留**：这条债是给人看的，模型下次能看到它）
 * @param chapter 章号
 * @param ts      时间戳（由调用方给——纯函数不取钟）
 * @returns {{code,level,levelName,message,chapter,ts}}
 */
export function makeDebt({ code, message = '', chapter = 0, ts = '' } = {}) {
    const level = debtLevelOf(code);
    return {
        code: String(code ?? ''),
        level,
        levelName: DEBT_LEVELS[level].name,
        message: String(message ?? ''),
        chapter: Number(chapter) || 0,
        ts: String(ts ?? ''),
    };
}

/**
 * 债目入库（**唯一一份**「本章债目落进债表」的实现；两处生产写法都走它）。
 *
 * 形状：`{ [章号]: 债目[] }`——按章号覆盖，不做计数算术（同 pacing 状态表的
 * 纪律：并发写同书时计数键最容易算错）。
 *
 * ⚠️ **空账目也必须覆盖**（1.3.3）：1.3.2 修「重写干净后旧账必须清零」时改的是两处生产
 * 写法，这个自称「增量合入用的纯函数版本」的实现还留着「空列表就不写键」——
 * 一旦被接上，刚修的清零立刻回归。清零和记账是同一条规则的两面，只能有一份实现。
 *
 * @param debts  现有债表
 * @param chapter 章号
 * @param items  本章债目（空数组 = 本章不欠账，旧账一并清掉）
 * @returns 新的债表（不修改入参）
 */
export function accumulateDebt(debts, chapter, items) {
    const base = (debts !== null && typeof debts === 'object' && !Array.isArray(debts)) ? { ...debts } : {};
    const list = Array.isArray(items) ? items.filter((x) => x !== null && typeof x === 'object') : [];
    base[String(chapter)] = list;
    return base;
}

/**
 * 书级质量视图：这本书欠了多少债、最严重的是哪章、现在该怎么办。
 *
 * 这是本模块真正要回答的问题——**「第 30 章有个非致命瑕疵，不该让作者觉得整本书
 * 写不下去了」**。视图给出的是「继续写 / 停下重规划 / 回头核对硬门禁」三选一，
 * 而不是把一堆警告糊在作者脸上。
 *
 * @param novel novel.json（读 quality.debts）
 * @returns {{total, byLevel, chapters, worst, actionable}}
 */
export function bookQualityView(novel) {
    const debts = novel?.quality?.debts;
    const rows = [];
    if (debts !== null && typeof debts === 'object' && !Array.isArray(debts)) {
        for (const [k, v] of Object.entries(debts)) {
            const chapter = Number(k);
            if (!Number.isInteger(chapter) || chapter <= 0) continue;
            const items = Array.isArray(v) ? v : [];
            for (const it of items) {
                if (it === null || typeof it !== 'object') continue;
                const level = DEBT_LEVELS[it.level] !== undefined ? it.level : debtLevelOf(it.code);
                rows.push({
                    chapter,
                    code: String(it.code ?? ''),
                    level,
                    message: String(it.message ?? ''),
                    ts: String(it.ts ?? ''),
                });
            }
        }
    }
    rows.sort((a, b) => a.chapter - b.chapter || a.level.localeCompare(b.level));

    const byLevel = { minor: 0, major: 0, hard: 0 };
    for (const r of rows) byLevel[r.level] = (byLevel[r.level] ?? 0) + 1;

    const chapters = [];
    for (const r of rows) {
        const last = chapters[chapters.length - 1];
        if (last !== undefined && last.chapter === r.chapter) {
            last.items.push(r);
            if (levelRank(r.level) > levelRank(last.level)) last.level = r.level;
        } else {
            chapters.push({ chapter: r.chapter, level: r.level, items: [r] });
        }
    }

    const worst = chapters.length === 0
        ? null
        : chapters.reduce((acc, c) => (levelRank(c.level) > levelRank(acc.level) ? c : acc), chapters[0]);

    return {
        total: rows.length,
        byLevel,
        chapters,
        worst,
        actionable: actionableLine({ total: rows.length, byLevel, worst }),
    };
}

/** 级别严重度序（hard > major > minor）。 */
function levelRank(level) {
    if (level === 'hard') return 3;
    if (level === 'major') return 2;
    return 1;
}

/**
 * 一批债里最重的一档（'none' 表示没有债）。
 *
 * 写章回执要用它给模型一个**一眼能懂的总判**：「本章欠的债里最重的是什么」——
 * 比让模型自己扫一堆条目强。
 */
export function worstLevelOf(items = []) {
    let best = 'none';
    let rank = 0;
    for (const it of Array.isArray(items) ? items : []) {
        const lv = DEBT_LEVELS[it?.level] !== undefined ? it.level : debtLevelOf(it?.code);
        if (levelRank(lv) > rank) { best = lv; rank = levelRank(lv); }
    }
    return best;
}

/**
 * 书级行动建议（纯函数，直测口径）。
 *
 * 三选一，顺序即优先级：**硬门禁放行 > 需重规划 > 质量债**。
 * 措辞原则：说清「能不能继续写」，而不是把一堆警告糊上去——本模块存在的意义
 * 就是让「局部瑕疵」不再等于「这本书写不下去了」。
 */
export function actionableLine({ total = 0, byLevel = {}, worst = null } = {}) {
    if (total === 0) return '质量账干净：没有欠债，可以放心往下写。';
    const hard = byLevel?.hard ?? 0;
    const major = byLevel?.major ?? 0;
    const minor = byLevel?.minor ?? 0;
    const at = worst !== null && worst !== undefined ? `最重的一笔在第 ${worst.chapter} 章` : '';
    if (hard > 0) {
        return `有 ${hard} 处硬门禁被 force 放行（本该拒稿）——这不是瑕疵，必须回头核对那几章；`
            + `${at}。其余 ${major} 处需重规划、${minor} 处质量债可以先欠着。`;
    }
    if (major > 0) {
        return `有 ${major} 处需重规划的问题（影响后续章节的结构）${at ? `，${at}` : ''}——`
            + `建议先处理再往下写；另有 ${minor} 处局部质量债，记着账就行，不阻塞全书。`;
    }
    return `累计 ${minor} 处局部质量债${at ? `，${at}` : ''}——都是可以欠着的瑕疵，正文保留，`
        + '继续写下一章，**不阻塞全书**；但别攒成灾（同一类反复出现就该回头改了）。';
}
