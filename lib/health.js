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