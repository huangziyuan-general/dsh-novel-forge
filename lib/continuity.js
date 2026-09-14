// lib/continuity.js — 一致性校验（纯函数，零模型调用，零 token）。
//
// 来源：novel-studio 的 validateContinuity。**适配而非照抄**——那一套建在
// characters/relations/scenes 的结构化模型上（我们的人物是 .md 卡 + cast 名单，
// 关系与场景没有独立实体），所以这里改写为本插件真实可判定的信号：
//
//   A. 死亡/退场实体：账本里记了「死」的实体，在死亡章之后又出现（闪回/梦境豁免）
//   B. 伏笔台账自洽：回收早于埋设、同 id 重复、超期未回收
//   C. 章节索引与文件：索引指向缺失文件、章号断档、缺摘要、版本号与文件不一致
//   D. 账本自身：章号超前（污染历史）、同章同键两个值
//   E. 人物：cast 里的人没有人物卡、已写章节 cast 为空
//
// 为什么值得做：这些是长篇最常见的硬伤，且**有明确对错**——不需要 LLM 判断，
// 不花 token，能写单测。模型「记得住」是不可靠的，代码算得出来才是证据。

/** 判定「这个实体死了」的键名（账本 key）。 */
const DEATH_KEYS = ['状态', '生死', '存亡', '结局', '生命', '下落'];
/** 死亡词。 */
const DEATH_RE = /(阵亡|身亡|殒命|殒身|命殒|毙命|陨落|已逝|去世|牺牲|道消|身死|死了|已死|死亡|身亡|殁)/;
/** 反例：这些词里有「死」但不是死亡。 */
const DEATH_NEG_RE = /(不死|未死|没死|未亡|复活|重生|诈死|假死|死里逃生|死战|死磕|死守|拼死|誓死|至死|生死|死寂|死穴|死角|死路|死气|死党|死忠|死士|绝处逢生)/;
/** 闪回/梦境叙事标记——出现在细纲或正文开头时，死亡实体再现可豁免。 */
const FLASHBACK_RE = /(闪回|回忆|倒叙|追忆|梦境|做梦|梦中|十年前|当年|年少时|往事|初见|昔日)/;
/** 闪回豁免只看正文开头这么长的窗口（避免全文命中一个「回忆」就豁免整章）。 */
const FLASHBACK_WINDOW = 400;

/**
 * 账本记录是否在宣告「该实体已死亡/退场」。
 * 键名命中 + 值命中死亡词 + 值不命中反例 → 判死。
 */
export function isDeathRecord(fact) {
    if (fact === null || typeof fact !== 'object') return false;
    const key = String(fact.key ?? '');
    const value = String(fact.value ?? '');
    if (!DEATH_KEYS.some((k) => key.includes(k))) return false;
    if (DEATH_NEG_RE.test(value)) return false;
    return DEATH_RE.test(value);
}

/**
 * 从账本推演「实体 → 死亡章号」。
 * 同一实体多条死亡记录取**最早**那条（第一死才算数；后文再记「尸骨被发现」不改变死亡时点）。
 * @returns Map<entity, {chapter, value, key, note}>
 */
export function deathTimeline(facts) {
    const out = new Map();
    for (const f of facts ?? []) {
        if (!isDeathRecord(f)) continue;
        const prev = out.get(f.entity);
        if (prev === undefined || f.chapter < prev.chapter) {
            out.set(f.entity, { chapter: f.chapter, value: f.value, key: f.key, note: f.note ?? '' });
        }
    }
    return out;
}

/**
 * 死亡实体在死亡章之后再现扫描。
 * @param deaths  deathTimeline 的输出
 * @param texts   { [chapter:number]: string } 已读正文
 * @param outlines { [chapter:number]: string } 细纲（闪回豁免判定优先用它，缺则看正文开头窗口）
 * @returns issues
 */
function scanDeadReappear(deaths, texts, outlines) {
    const issues = [];
    for (const [entity, d] of deaths) {
        if (typeof entity !== 'string' || entity.trim() === '') continue;
        const chapters = Object.keys(texts ?? {}).map(Number).filter((n) => n > d.chapter).sort((a, b) => a - b);
        for (const n of chapters) {
            const text = texts[n] ?? '';
            if (!text.includes(entity)) continue;
            const hay = (outlines?.[n] ?? '') + '\n' + text.slice(0, FLASHBACK_WINDOW);
            const exempt = FLASHBACK_RE.test(hay);
            issues.push({
                severity: exempt ? 'warning' : 'error',
                code: exempt ? 'dead-reappear-in-flashback' : 'dead-reappear',
                where: `第${n}章·${entity}`,
                message: exempt
                    ? `「${entity}」已在第${d.chapter}章${d.value}（${d.key}），第${n}章再次出现；该章有闪回/梦境标记，判定为豁免（请确认确为回忆而非复活）`
                    : `「${entity}」已在第${d.chapter}章${d.value}（${d.key}），第${n}章正文再次出现——死亡人物复活是最常见硬伤（若非复活剧情，请改稿；若确为闪回，请在细纲或开头写明「回忆/闪回/梦境」）`,
            });
            break; // 每个实体只报首次再现，避免 30 章连报刷屏
        }
    }
    return issues;
}

/** 伏笔台账自洽。 */
function checkForeshadows(foreshadows, maxWritten) {
    const issues = [];
    const seen = new Map();
    for (const f of foreshadows ?? []) {
        const id = f?.id ?? '(无 id)';
        if (seen.has(id)) {
            issues.push({
                severity: 'error', code: 'foreshadow-duplicate-id', where: `伏笔 ${id}`,
                message: `伏笔 id「${id}」重复登记——id 必须唯一，否则回收会打到错误条目`,
            });
        }
        seen.set(id, f);

        if (!Number.isInteger(f?.chapter)) {
            issues.push({
                severity: 'warning', code: 'foreshadow-no-chapter', where: `伏笔 ${id}`,
                message: `伏笔「${id}」缺埋设章号（chapter）——超期判定与顺序都依赖它`,
            });
            continue;
        }
        if (Number.isInteger(f.plan) && f.plan < f.chapter) {
            issues.push({
                severity: 'warning', code: 'foreshadow-plan-before-setup', where: `伏笔 ${id}`,
                message: `伏笔「${id}」预计回收章（第${f.plan}章）早于埋设章（第${f.chapter}章）——计划不成立`,
            });
        }
        if (Number.isInteger(f.payoffChapter)) {
            if (f.payoffChapter < f.chapter) {
                issues.push({
                    severity: 'error', code: 'foreshadow-payoff-before-setup', where: `伏笔 ${id}`,
                    message: `伏笔「${id}」回收章（第${f.payoffChapter}章）早于埋设章（第${f.chapter}章）——时间线倒挂`,
                });
            }
        } else if (Number.isInteger(f.plan) && f.plan >= f.chapter && Number.isInteger(maxWritten) && maxWritten > f.plan) {
            issues.push({
                severity: 'warning', code: 'foreshadow-overdue', where: `伏笔 ${id}`,
                message: `伏笔「${id}」预计第${f.plan}章回收，现已写到第${maxWritten}章仍未收——欠账未还，别让读者忘了`,
            });
        }
    }
    return issues;
}

/** 章节索引与文件。 */
function checkChapters(novel, existingFiles) {
    const issues = [];
    const chapters = novel?.chapters ?? {};
    const nums = Object.keys(chapters).map(Number).filter((n) => Number.isInteger(n) && n >= 1).sort((a, b) => a - b);

    for (const n of nums) {
        const rec = chapters[String(n)];
        if (typeof rec?.path !== 'string' || rec.path === '') {
            issues.push({
                severity: 'error', code: 'chapter-path-missing', where: `第${n}章`,
                message: `第${n}章索引没有正文路径——索引损坏，请用 novel_project repair 对账`,
            });
            continue;
        }
        if (existingFiles !== null && existingFiles !== undefined && !existingFiles.has(rec.path)) {
            issues.push({
                severity: 'error', code: 'chapter-file-missing', where: `第${n}章`,
                message: `第${n}章索引指向的文件不存在：${rec.path}——先 novel_project repair 对账，别继续往后写`,
            });
        }
        if (typeof rec.summary !== 'string' || rec.summary.trim() === '') {
            issues.push({
                severity: 'warning', code: 'chapter-summary-missing', where: `第${n}章`,
                message: `第${n}章缺 summary——写前简报的「前情提要」会缺这一章，后续章节容易接不上`,
            });
        }
        // 版本号 vs 文件列表：latest 应是 files 里的最大版本
        if (Array.isArray(rec.files) && Number.isInteger(rec.latest)) {
            const vers = rec.files.map((f) => Number(String(f?.file ?? '').match(/-v(\d+)\.md$/)?.[1])).filter((v) => Number.isInteger(v));
            const maxV = vers.length > 0 ? Math.max(...vers) : null;
            if (maxV !== null && maxV !== rec.latest) {
                issues.push({
                    severity: 'warning', code: 'chapter-version-mismatch', where: `第${n}章`,
                    message: `第${n}章索引 latest=${rec.latest}，但文件里最大版本是 v${maxV}——索引与磁盘不一致，读到的可能不是最新稿`,
                });
            }
        }
    }

    // 章号断档：只报首个缺口，避免长书刷屏
    if (nums.length > 1) {
        for (let i = 1; i < nums.length; i += 1) {
            if (nums[i] !== nums[i - 1] + 1) {
                issues.push({
                    severity: 'warning', code: 'chapter-gap', where: `第${nums[i - 1]}→${nums[i]}章`,
                    message: `第${nums[i - 1] + 1}～${nums[i] - 1}章缺号——写前简报的「上一章结尾」会跳过缺口`,
                });
                break;
            }
        }
    }
    return issues;
}

/** 账本自身：章号超前 + 同章同键冲突（历史数据复查）。 */
function checkFacts(facts, maxWritten) {
    const issues = [];
    const limit = maxWritten >= 1 ? maxWritten + 1 : 0;
    const seen = new Set();
    const ahead = new Set();
    for (const f of facts ?? []) {
        if (!Number.isInteger(f?.chapter)) continue;
        if (limit > 0 && f.chapter > limit && !ahead.has(f.entity)) {
            ahead.add(f.entity);
            issues.push({
                severity: 'error', code: 'ledger-chapter-ahead', where: `${f.entity}·${f.key}`,
                message: `账本记录章号第${f.chapter}章超前于已写进度（第${maxWritten}章）——历史被污染，先 novel_project repair 对账`,
            });
        }
        const k = `${f.entity}\u0000${f.key}\u0000${f.chapter}\u0000${f.value}`;
        if (seen.has(k)) {
            issues.push({
                severity: 'warning', code: 'ledger-duplicate-record', where: `${f.entity}·${f.key}`,
                message: `账本「${f.entity}.${f.key}」第${f.chapter}章有重复记录——冗余，建议清理`,
            });
        }
        seen.add(k);
    }
    // 同章同键不同值（applyFactUpdates 会拦新写入，这里抓历史遗留）
    const byKey = new Map();
    for (const f of facts ?? []) {
        if (!Number.isInteger(f?.chapter)) continue;
        const k = `${f.entity}\u0000${f.key}\u0000${f.chapter}`;
        if (!byKey.has(k)) byKey.set(k, new Set());
        byKey.get(k).add(String(f.value));
    }
    for (const [k, values] of byKey) {
        if (values.size <= 1) continue;
        const [entity, key, chapter] = k.split('\u0000');
        issues.push({
            severity: 'error', code: 'ledger-same-chapter-conflict', where: `${entity}·${key}`,
            message: `账本「${entity}.${key}」第${chapter}章同时存在 ${values.size} 个值（${[...values].join(' / ')}）——同章改值即冲突，必须人工裁定`,
        });
    }
    return issues;
}

/** 人物：cast 缺卡。 */
function checkCharacters(novel, castCards) {
    const issues = [];
    const cast = novel?.cast ?? [];
    if (castCards !== null && castCards !== undefined) {
        for (const name of cast) {
            if (castCards[name] === true) continue;
            issues.push({
                severity: 'warning', code: 'character-card-missing', where: `人物 ${name}`,
                message: `工程 cast 里的「${name}」没有人物卡——写前简报无法注入该角色（novel_character save 补建）`,
            });
        }
    }
    return issues;
}

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

/**
 * 全书一致性校验（纯函数，零 token）。
 * 所有输入都是已加载的数据，本函数不碰 io —— 便于单测，也便于面板/REST 复用。
 *
 * @param inputs {
 *   novel,                      // novel.json（必有）
 *   facts = [],                 // 账本
 *   foreshadows = [],           // 伏笔台账
 *   texts = {},                 // { [chapter:n]: 正文 }（缺则跳过死亡再现扫描）
 *   outlines = {},              // { [chapter:n]: 细纲 }（闪回豁免判定）
 *   existingFiles = null,       // Set<string>：存在的相对路径；null=跳过文件存在性检查
 *   castCards = null,           // { [name]: true }：人物卡存在表；null=跳过
 * }
 * @returns { ok, issues, stats }
 */
export function validateContinuity({
    novel,
    facts = [],
    foreshadows = [],
    texts = {},
    outlines = {},
    existingFiles = null,
    castCards = null,
} = {}) {
    const chapters = novel?.chapters ?? {};
    const nums = Object.keys(chapters).map(Number).filter((n) => Number.isInteger(n) && n >= 1);
    const maxWritten = nums.length > 0 ? Math.max(...nums) : 0;

    const deaths = deathTimeline(facts);
    const issues = [
        ...scanDeadReappear(deaths, texts, outlines),
        ...checkForeshadows(foreshadows, maxWritten),
        ...checkChapters(novel, existingFiles),
        ...checkFacts(facts, maxWritten),
        ...checkCharacters(novel, castCards),
    ];
    issues.sort((a, b) => (SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]) || String(a.where).localeCompare(String(b.where)));

    const errors = issues.filter((i) => i.severity === 'error').length;
    const warnings = issues.filter((i) => i.severity === 'warning').length;
    return {
        ok: errors === 0,
        issues,
        stats: {
            chapters: nums.length, facts: (facts ?? []).length,
            foreshadows: (foreshadows ?? []).length, deaths: deaths.size,
            errors, warnings,
        },
    };
}

/** 一句话摘要（供 audit 渲染）。 */
export function continuityDigest(result) {
    const { stats, issues } = result;
    const head = `一致性校验：${stats.chapters} 章·${stats.facts} 条账本·${stats.foreshadows} 条伏笔·死亡实体 ${stats.deaths}`;
    if (issues.length === 0) return `${head} —— 未发现硬伤 ✓`;
    const lines = issues.slice(0, 20).map((i) => `${i.severity === 'error' ? '✗' : '⚠'} [${i.code}] ${i.message}`);
    const more = issues.length > 20 ? `\n…另有 ${issues.length - 20} 条` : '';
    return `${head}\n${lines.join('\n')}${more}`;
}
