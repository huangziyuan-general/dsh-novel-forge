// lib/health.js — 「反复故障体检」的纯函数集（零 io、零 token）。
//
// 存在理由：这批**盘面残留**（控制字符路径 / NaN→null 数值 / 幽灵提案）repair（工具面）
// 与 /continuity（面板面）都要报，装配逻辑若不共用迟早漂移——这是 continuity-io 那层的
// 同一课。所有函数输入输出皆数据，不碰 io，便于 node --test 直测。
//
// 与 lib/continuity.js 的分工：continuity 查的是**内容一致性**（死人复活/伏笔倒挂…），
// 这里查的是**存储健康度**（文件路径能不能被 fs 找到、数值有没有被 JSON 吃成 null、
// 提案索引与文件对不对得上）。两者共用 issue 形状（severity/code/where/message），
// 由 /continuity 端点合并展示。

/** 路径里的控制字符（\r / \n / \t 等）。真机「Cannot present …\r\r…/正文/…: file not
 *  found」的根因——路径混入 \r 后 fs 找不到文件。 */
const CTRL_CHARS = /[\u0000-\u001F\u007F]/;

/** 字符串是否含控制字符（非字符串一律 false）。 */
export function hasControlChars(s) {
    return typeof s === 'string' && CTRL_CHARS.test(s);
}

/** 去掉字符串里的控制字符（repair 归一化用；非字符串原样返回）。 */
export function stripControlChars(s) {
    return typeof s === 'string' ? s.replace(/[\u0000-\u001F\u007F]/g, '') : s;
}

/**
 * 收集 novel 里含控制字符的章节路径（files[].file 与 rec.path），只报告不改。
 * repair 必须先归一化再对账，否则含 \r 的好章会被当成「整章丢失」误删。
 * @returns string[]（保持出现顺序，可能有重复——调用方自行去重）
 */
export function controlCharPaths(novel) {
    const hits = [];
    for (const rec of Object.values(novel?.chapters ?? {})) {
        for (const f of rec?.files ?? []) {
            if (hasControlChars(f?.file)) hits.push(f.file);
        }
        if (hasControlChars(rec?.path)) hits.push(rec.path);
    }
    return hits;
}

/**
 * 机器状态「数值字段落成 null」的体检。JSON.stringify(NaN/Infinity) 写成 null，
 * 读回 JSON 已无法还原成 NaN，却正是「value is not lossless JSON」那类事故的盘面痕迹。
 * 只查**本应为数值**的字段：chapter.chars / latest / files[].version、文风基线的 mu / sigma。
 * ⚠️ 这是**固定清单**：将来新增本应为数值的字段（如基线新维度），必须手动加进本函数，
 * 否则该字段的 NaN→null 残留不会被体检发现。
 * @returns string[] 人类可读的清单（repair 直接透传为 stateIssues）
 */
export function numericNullFields(novel, styleBaseline) {
    const issues = [];
    for (const [k, rec] of Object.entries(novel?.chapters ?? {})) {
        if (rec?.chars === null) issues.push(`第${k}章 chars=null（数值被写成 null）`);
        if (rec?.latest === null) issues.push(`第${k}章 latest=null`);
        for (const f of rec?.files ?? []) {
            if (f?.version === null) issues.push(`第${k}章 files[].version=null`);
        }
    }
    const dims = styleBaseline?.baseline?.dims;
    if (dims !== null && typeof dims === 'object') {
        for (const [key, d] of Object.entries(dims)) {
            if (d?.mu === null) issues.push(`文风基线 ${key}.mu=null`);
            if (d?.sigma === null) issues.push(`文风基线 ${key}.sigma=null`);
        }
    }
    return issues;
}

/**
 * 幽灵提案：索引有文件无（missing，面板点开必失败）/ 文件有索引无（orphan，冷归档）。
 * 只报告不删——文件缺失可能是同步未落盘，把索引清掉就再也找不回这条提案。
 * @param indexIds  novel.proposals 里的 id 列表
 * @param diskIds   .novel/proposals/*.json 去扩展名的文件名列表
 * @returns { missing: string[], orphan: string[] }（missing 保索引顺序，orphan 排序）
 */
export function ghostProposals(indexIds, diskIds) {
    const idx = [...new Set((indexIds ?? []).filter((x) => typeof x === 'string'))];
    const disk = new Set((diskIds ?? []).filter((x) => typeof x === 'string'));
    const missing = idx.filter((id) => !disk.has(id));
    const orphan = [...disk].filter((id) => !idx.includes(id)).sort();
    return { missing, orphan };
}

/**
 * 派生检索索引（G1 `书/.novel/index.db`）与书稿的对账：只诊断「索引里还有块、书里已删章」。
 *
 * 症状：删章后、下次 novel_search build 之前，检索仍会命中那些幽灵段落，作者会把
 * 「查无此文」的内容当素材用。索引是**派生物**（删了重跑 build 即得），所以这类问题
 * 属于可修复的陈旧态，而不是内容错误 —— repair 会直接把幽灵块清掉。
 *
 * 索引本体是 sqlite 二进制，纯函数层只吃**已抽出的章号集合**（io 在工具/REST 层做）。
 * @param indexedChapters  索引里出现过的章号（number）
 * @param novelChapterKeys novel.chapters 的键（字符串或数字皆可）
 * @returns {number[]} 只存于索引、书里已无的章号（升序）
 */
export function ghostIndexChapters(indexedChapters, novelChapterKeys) {
    // 章号是数字语义：字符串数字（'12'）要对齐，但 null/'' 等**不得**被 Number() 折成 0
    // （Number(null)===0、Number('')===0 会凭空造出一个「第 0 章幽灵」）。
    const toCh = (v) => {
        if (typeof v === 'number') return Number.isInteger(v) ? v : null;
        if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
        return null;
    };
    const alive = new Set((novelChapterKeys ?? []).map(toCh).filter((k) => k !== null));
    const idx = [...new Set((indexedChapters ?? []).map(toCh).filter((k) => k !== null))];
    return idx.filter((k) => !alive.has(k)).sort((a, b) => a - b);
}

/**
 * 全书首稿字数基线：各章**落盘**字数的均值（只计有效数值——NaN→null 的盘面残留会被滤掉）。
 * 无任何有效章时返回 0（调用方按「无基线」跳过判定）。
 *
 * ⚠️ 0.18.0 起它**不再**是会话疲劳的分母（拿成稿均值除首稿均值是量纲错配，见 sessionFatigue
 * 注释），只保留给面板/看板展示「全书成稿平均篇幅」。
 */
export function bookCharBaseline(novel) {
    const xs = Object.values(novel?.chapters ?? {})
        .map((r) => r?.chars)
        .filter((c) => typeof c === 'number' && Number.isFinite(c));
    if (xs.length === 0) return 0;
    return Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
}

const FATIGUE_DEFAULTS = {
    chapterThreshold: 8,   // 兜底：同会话连写这么多章就该换（真机 19 章实录）
    ratio: 0.7,            // 水平判据：本会话首稿均值 < 参照首稿均值 × 0.7
    trendRatio: 0.75,      // 趋势判据：会话内后半首稿 < 前半 × 0.75
    levelMinChapters: 3,   // 水平判据最小样本（本会话有首稿数据的章）
    trendMinChapters: 4,   // 趋势判据最小样本（前后各 ≥2）
    referenceMinChapters: 3, // 参照池（全书**其它**会话的首稿）最少几章，不足就不判水平
    // 上下文体量护栏（真机外部用户实证 2026-10-23：写到 42 章整轮 400 CONTEXT_WINDOW_EXCEEDED，
    // 输入 49.3 万 tokens——会话历史只增不减，草稿全文两份（tool call + 回执）+ 每回合简报包
    // 是三大堆积源；轮次死在模型侧，插件连反应机会都没有，只能**提前**把体量变成可见数字）。
    contextBudgetTokens: 262144, // 预算基准：常见窗口的保守中间档（真机窗口 128k–1M 都有；偏小只会早提醒，换会话零损失）
    volumeLoadRatio: 0.6,        // 预估体量 ≥ 预算 × 0.6 → 硬警告（这不是质量建议，是继续写就大概率 400）
    briefingChars: 6000,         // 每回合简报包体量（与 config.contextBudgetChars 默认一致；调用方可传真值）
};

/**
 * 从审计全文解析「每章首稿字数」——同口径的地基。
 * 首稿 = 该章**第一次**出现的 write_chapter 行：优先取显式 chars 字段（1.0.4 起
 * rejected 行也带），历史行 rejected 从 reason 提「正文 N 字」兜底，saved 取 chars。
 * 非成稿探针（nonDraft）不占槽位。历史行没有 session 字段（0.15.1 起才有）→ session 为 null，
 * 仍计入全书参照池（它们是同一本书的首稿，口径一致），只是不归属任何会话。
 * @returns Map<chapter, {chars, session}>（按章号升序由调用方排序）
 */
export function firstDraftByChapter(auditText) {
    const firsts = new Map();
    for (const line of String(auditText ?? '').split('\n')) {
        if (line.trim() === '') continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j?.action !== 'write_chapter/rejected' && j?.action !== 'write_chapter/saved') continue;
        // 非成稿探针不占首稿槽位（1.0.4 起 rejected 行带显式 chars，不加这条，
        // 9 字探针会顶掉真正的首稿）——与旧正则「提不到 9 字」的兜底语义一致。
        if (j.nonDraft === true) continue;
        if (!Number.isInteger(j.chapter) || firsts.has(j.chapter)) continue;
        // 显式 chars 优先（1.0.4：文案一改，reason 正则就静默失灵）；历史行回退正则。
        let chars = typeof j.chars === 'number' && Number.isFinite(j.chars) ? j.chars : null;
        if (chars === null && j.action === 'write_chapter/rejected') {
            const m = typeof j.reason === 'string' ? j.reason.match(/正文 (\d+) 字/) : null;
            chars = m ? Number(m[1]) : null;
        }
        if (chars !== null) firsts.set(j.chapter, { chars, session: typeof j.session === 'string' ? j.session : null });
    }
    return firsts;
}

const avg = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);

/**
 * 会话疲劳检测（纯函数）。
 *
 * ⚠️ 0.18.0 重写判据——旧版是**量纲错配**的必然误报：分子用「首稿字数」（门禁驳回前的
 * 裸稿），分母用「全书落盘字数均值」（被门禁顶到 ≥min 之后的成稿）。门禁越起作用，
 * 比值必然越低，于是「门禁正常工作」这件事本身被判成会话疲劳。本地真机 7 本 183 章
 * 实测：首稿 1197/1717 → 落盘 2046/2429 时比值 0.65 < 0.7，**第 1 章落盘就告警**；
 * 换成同口径（首稿 vs 首稿）比值 1.00，零退化。
 *
 * 新判据全部同口径，并且要求参照物存在：
 *   ① trend（主判据）：本会话内首稿**逐章变短**——后半均值 < 前半 × trendRatio。
 *      这是真机里唯一稳定复现的退化形状（每本真书都能测到负斜率 −10～−64 字/章，
 *      换会话后首稿立刻回弹：某完结本 2062→2411、某连载本 974→1902）。
 *   ② level：本会话首稿均值 < **全书其它会话**首稿均值 × ratio，且本会话 ≥3 章、
 *      参照池 ≥3 章。新书（参照池只有本会话）一律不判——此时"换会话"零收益。
 *   ③ chapters：同会话 saved ≥8 章的兜底提醒。
 *
 * @param auditText  audit.jsonl 全文（io 在调用方做）
 * @param sessionId  当前会话 id
 */
export function sessionFatigue(auditText, sessionId, opts = {}) {
    // ⚠️ 不能直接 { ...FATIGUE_DEFAULTS, ...opts }：opts 里显式的 undefined（如调用方传
    // briefingChars: config?.x 而配置缺项）会覆盖掉默认值，估算 NaN 化——undefined 的键跳过。
    const merged = { ...FATIGUE_DEFAULTS };
    for (const [k, v] of Object.entries(opts)) if (v !== undefined) merged[k] = v;
    const { chapterThreshold, ratio, trendRatio, levelMinChapters, trendMinChapters, referenceMinChapters,
        contextBudgetTokens, volumeLoadRatio, briefingChars } = merged;
    // 单遍解析 write_chapter 行（saved + rejected），顺带收集会话归属。
    // 每行的 chars 就是进过一次会话历史的草稿全文；旧版审计的 rejected 行不带 chars
    // （只写在 reason 里）→ 历史数据会被低估；saved 行恒有 chars，主线数据完整。
    const rows = [];
    const sessionsSeen = new Set();
    for (const line of String(auditText ?? '').split('\n')) {
        if (line.trim() === '') continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (typeof j?.action !== 'string' || !j.action.startsWith('write_chapter/')) continue;
        rows.push(j);
        if (j.session) sessionsSeen.add(j.session);
    }
    // 会话归属兜底（2026-10-23 外部用户实证）：面板发来的会话 id 可能与工具面写进审计行
    // 的 id 不同源、甚至整个缺失（0.13.2 起的老病）——此前判据按目标会话聚合，对不上就
    // **全部空转**：42 章连写把上下文写爆，面板疲劳横幅整个没出现，「创建新会话并交接」
    // 按钮也随之缺席，用户只能看着裸 400。兜底口径：目标会话没命中记账行、且**全书只被
    // 一个会话写过**（长篇常态，「谁在写这本书」只有一个答案）→ 按那个会话估算，口径与
    // 真会话等价；多会话书无法归因 → 不兜底——拿全书累计冒充当前会话历史，会把刚开的新
    // 会话误判成爆栈，宁可缺席也不给假数字。
    let effectiveSession = sessionId ?? null;
    let scopeNote = null;
    if (!sessionsSeen.has(effectiveSession) && sessionsSeen.size === 1) {
        effectiveSession = [...sessionsSeen][0];
        scopeNote = '面板会话 id 与记账不同源（或缺失）——疲劳数据按写这本书的唯一会话兜底估算';
    }
    const firsts = firstDraftByChapter(auditText);
    const all = [...firsts.entries()].sort((a, b) => a[0] - b[0]);
    const own = all.filter(([, v]) => v.session === effectiveSession);
    const savedChapters = new Set();
    let turnCount = 0;
    let draftChars = 0;
    for (const j of rows) {
        if (j.session !== effectiveSession) continue;
        if (Number.isInteger(j.chapter)) turnCount += 1;
        if (Number.isFinite(j.chars)) draftChars += j.chars;
        if (j?.action === 'write_chapter/saved' && Number.isInteger(j.chapter)) savedChapters.add(j.chapter);
    }
    const ownChars = own.map(([, v]) => v.chars);
    const sessionFirstAvg = ownChars.length > 0 ? avg(ownChars) : null;
    // 参照池：全书首稿，**排除本会话**（否则新书拿自己比自己，恒等式没有信息量）
    const others = all.filter(([, v]) => v.session !== effectiveSession).map(([, v]) => v.chars);
    const bookFirstAvg = others.length > 0 ? avg(others) : null;

    // 上下文体量估算（保守下限）：每个写章回合在会话历史里至少留下
    // ① 草稿全文两份（模型 tool call 的 content + 落盘/驳回回执）＝ chars × 0.6 tok/字 × 2；
    // ② 一份简报包（按 config.contextBudgetChars 估）＝ briefingChars × 0.6。
    // 其余回执（审计报告/提案/进度卡）未计 → 只会低估。系数校准自真机一例
    // （42 章 ≈ 49.3 万 input tokens：简报包与草稿双份是两大头），量级而非精算。
    const estTokens = Math.round(draftChars * 1.2 + turnCount * briefingChars * 0.6);
    const contextEst = turnCount > 0
        ? { turns: turnCount, draftChars, estTokens, budgetTokens: contextBudgetTokens,
            pct: Math.min(999, Math.round((estTokens / contextBudgetTokens) * 100)) }
        : null;

    let warn = null;
    let reason = null;
    let level = null;
    // 体量判据**排第一**：它回答的不是「质量退没退」而是「历史还装不装得下下一章」——
    // 真 400 发生在模型侧，工具层来不及反应，必须在到达前喊。硬警告（level: 'hard'）。
    if (contextEst !== null && estTokens >= contextBudgetTokens * volumeLoadRatio) {
        reason = 'volume';
        level = 'hard';
        warn = `本会话上下文体量预估 ${estTokens} tokens（${turnCount} 次写章、累计草稿 ${draftChars} 字，简报包按每回合 ${briefingChars} 字估）`
            + `——已到常见模型窗口的 ~${contextEst.pct}%。继续写大概率整轮 400（CONTEXT_WINDOW_EXCEEDED），报错发生在模型侧、工具救不回来。`
            + '现在换会话零损失（书的状态全在盘上）：面板「创建新会话并交接」，或复制交接摘要开新会话。';
    }
    if (warn === null && ownChars.length >= trendMinChapters) {
        const half = Math.floor(ownChars.length / 2);
        const head = avg(ownChars.slice(0, half));
        const tail = avg(ownChars.slice(-half));
        if (head > 0 && tail < head * trendRatio) {
            reason = 'trend';
            level = 'soft';
            warn = `本会话首稿逐章变短：前 ${half} 章平均 ${head} 字 → 最近 ${half} 章平均 ${tail} 字（降 ${Math.round((1 - tail / head) * 100)}%）`
                + '——对话历史堆积在稀释输出质量，建议开新会话继续（书的状态全在盘上，零损失）。'
                + `口径：首稿＝门禁驳回前的初稿字数，不是成稿字数。`;
        }
    }
    if (warn === null && ownChars.length >= levelMinChapters && others.length >= referenceMinChapters && bookFirstAvg > 0) {
        if (sessionFirstAvg < bookFirstAvg * ratio) {
            reason = 'level';
            level = 'soft';
            warn = `本会话首稿均长 ${sessionFirstAvg} 字，低于其它会话首稿均值 ${bookFirstAvg} 字的 ${Math.round(ratio * 100)}%`
                + '——输出质量在掉，建议开新会话继续（书的状态全在盘上，零损失）。'
                + `口径：首稿＝门禁驳回前的初稿字数，不是成稿字数。`;
        }
    }
    if (warn === null && savedChapters.size >= chapterThreshold) {
        reason = 'chapters';
        level = 'soft';
        // ⚠️ 这条**不声称**质量已经退化——外部用户真机 20 章连写实测首稿是往上走的
        // （1650/1267/1258/1692 → 后段稳定 2100–2655），退化由 ① 趋势判据管，不靠章数猜。
        // 章数只回答一件事：单会话上下文规模在持续上涨，重开是零损失的成本控制。
        warn = `本会话已连续写 ${savedChapters.size} 章、首稿均值 ${sessionFirstAvg ?? '?'} 字——单会话上下文规模持续上涨，`
            + '换会话可零损失重开预算（书的状态全在盘上）。是否真的在退化以本会话首稿趋势为准。';
    }
    return {
        sessionChapters: savedChapters.size,
        sessionFirstAvg,
        sessionFirstSeries: own.map(([chapter, v]) => ({ chapter, chars: v.chars })),
        bookFirstAvg,
        referenceChapters: others.length,
        warn,
        reason,
        level,
        ...(contextEst !== null ? { contextEst } : {}),
        ...(scopeNote ? { scopeNote, effectiveSession } : {}),
    };
}

/**
 * 把上述体检项汇总成 continuity 同款的 issue 列表（severity/code/where/message），
 * 供 /continuity 端点追加进全书体检（面板零改动即能看到）。
 * @param { novel, styleBaseline, proposalIds, proposalFilesOnDisk, indexedChapters }
 */
export function healthIssues({ novel, styleBaseline = null, proposalIds = [], proposalFilesOnDisk = [], indexedChapters = [] } = {}) {
    const issues = [];
    for (const raw of controlCharPaths(novel)) {
        issues.push({
            severity: 'error', code: 'path-control-char', where: '章节索引',
            message: `索引里的路径含控制字符（\\r/\\n 等会被 fs 判为 file not found）：${JSON.stringify(raw)}——novel_project repair 可归一化`,
        });
    }
    for (const msg of numericNullFields(novel, styleBaseline)) {
        issues.push({
            severity: 'warning', code: 'state-numeric-null', where: '机器状态',
            message: `${msg}——JSON 存不下 NaN/Infinity，这是写入时算出非有限值的盘面残留`,
        });
    }
    const { missing, orphan } = ghostProposals(proposalIds, proposalFilesOnDisk);
    for (const id of missing) {
        issues.push({
            severity: 'error', code: 'proposal-file-missing', where: `提案 ${id}`,
            message: `索引登记了提案 ${id}，但 .novel/proposals/${id}.json 不在——面板点开会失败`,
        });
    }
    for (const id of orphan) {
        issues.push({
            severity: 'warning', code: 'proposal-orphan-file', where: `提案 ${id}`,
            message: `提案文件 ${id}.json 已不在索引中（冷归档，不删仅报告）`,
        });
    }
    for (const ch of ghostIndexChapters(indexedChapters, Object.keys(novel?.chapters ?? {}))) {
        issues.push({
            severity: 'warning', code: 'search-index-stale', where: `检索索引 第${ch}章`,
            message: `检索索引里还留着第${ch}章的块，但书里已没有这一章——novel_search 会命中「查无此文」的段落；跑 novel_project repair 可清掉（索引是派生物，novel_search build 重跑也能重建）`,
        });
    }
    return issues;
}