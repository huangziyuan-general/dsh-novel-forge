// lib/proposals.js — 提案（修订稿）的共享实现。
//
// 为什么单独一层：本插件的「修订已存章节」走提案制——先落提案文件、不改正文，
// 用户确认后 apply 才生成新版本（旧版永远保留）。
//
// 关键设计（对齐 @ethanyoq/dsh-ai-novel-writer 的门禁思路）：
//   · **工具面只暴露 propose / list** —— 模型能做的就这些；
//   · **apply / discard / prune 不进工具面**，只从 REST 端点（面板按钮）进入。
//   → 「批准钥匙」因此是**工具层保证**的，不依赖 persona 自觉，模型无法自己批自己。
//
// 为什么不给工具面加 discard（T5，写在这里免得后人再想加）：模型「清掉自己提的旧提案」
// 这个需求已经由**代码**满足了——apply 先比基线（提案登记时的 baseVersion，存量提案退回
// 时间戳兜底），陈旧的当场被标 superseded 并抛出可执行错误，模型不必也不能靠 discard 收尾；
// 反过来真开了 discard，等于让模型能抹掉待批记录，「批准钥匙归用户」的门禁就漏了一角。
// （test/smoke.test.mjs 有一条 deepEqual(actions, ['propose','list']) 锁着这条不变式。）
//
// 一份逻辑两层共用：工具（lib/tools/propose-tools.js）与 REST（lib/server-api.js）
// 都调这里的函数，避免"两边各写一遍 apply"漂移。

import { pathsFor, chapterRecord, chapterRelPath, effectiveCharConfig } from './store.js';
import { nextVersion } from './versioning.js';
import { advanceStage } from './gate.js';
import { computeAudit, auditVerdict, chapterCharTarget } from './audit.js';
import { contentGate } from './content-gate.js';
import { contractFor } from './scene-contract.js';
import { computeGateMetrics } from './gate-metrics.js';
import { normalizeQuotes } from './punctuation.js';
import { auditLine, updateJson, isVersionConflict } from './fsio.js';

/** 写一条审计（actor 由调用方给：工具=agent，REST=user）。 */
async function writeAudit(io, p, action, detail, actor) {
    await io.appendLine(p.audit, auditLine(action, detail, actor));
}

/** 提案 id 收口（CodeBuddy 审计 2026-10-09）：id 直接拼进读路径 `${book}/.novel/proposals/${id}.json`，
 *  而 novel.json.proposals[] 是数据文件——被污染的 id（../ 等）可越出提案目录读任意 JSON。
 *  生成侧形状固定（P{章}-{base36}-{4位}），白名单收紧到 alnum/_- 且限长。 */
const PROPOSAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function validProposalId(id) {
    return typeof id === 'string' && PROPOSAL_ID_RE.test(id);
}

/** 读书；不存在则抛出可读错误。 */
async function mustReadBook(io, book) {
    const p = pathsFor(book);
    const novel = await io.readJson(p.meta);
    if (novel === null) throw new Error(`书目不存在：「${book}」。先用 novel_project action=init 创建。`);
    novel.proposals = novel.proposals ?? [];
    return { p, novel };
}

/** 提案的对外投影（去掉 content，列表不该把整章正文塞进响应）。 */
function proposalView(x) {
    return { id: x.id, chapter: x.chapter, status: x.status, createdAt: x.createdAt };
}

/**
 * 落一份修订提案（三个调用方共用：propose 工具 / polish 工具 / 旁路引擎的润色与校对）。
 *
 * 为什么要抽出来：提案落盘是「写提案文件 + 登记索引 + 存书 + 审计」四步，
 * 少一步就会出现「面板看不到的幽灵提案」或「索引里有、文件不在」的坏状态。
 * 一处实现，三处调用。
 *
 * @returns {{id, chapter, status:'pending', createdAt}}
 */
export async function submitRevisionProposal(io, book, { chapter, content, reason = '', actor = 'agent' }) {
    const p = pathsFor(book);
    // 提案 id 带随机后缀：纯毫秒时间戳（base36）在同一毫秒内提交两份提案会撞 id
    const id = `P${chapter}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const createdAt = new Date().toISOString();
    // 引号规范（GB/T 15834—2011）：提案内容就是将来 apply 的正文——入库前先规范，
    // 应用侧（applyProposal 写盘）再兜一道幂等转换，旧提案也一并覆盖。
    const norm = normalizeQuotes(String(content));
    // T2 同章去重：同章已有待批提案时**拒绝**，不让两条互相矛盾的 pending 一起摆在面板上
    // （真机实证：同章两条提案都说改同一处，用户无从选择，且两条都已不是最新版正文）。
    // 判定分两段，各司其职：
    //   · 入口快照 = 「提交那一刻」的判定（与 proposeRevision 的字数上下限同层语义）；
    //   · 登记时复核 = 用户在这中间把它应用/丢弃了，本次提交不该被一条已终态的陈旧记录卡死。
    // 本次调用窗口内**由别的通道**并发登记的同章提案不拦：那是幽灵提案防线守的另一类竞态
    // （见 test/batch5.test.mjs 的并发登记用例），它也不会让「两条都基于旧版」的语义成立。
    const preexisting = new Set(
        ((await io.readJson(p.meta))?.proposals ?? [])
            .filter((x) => x?.chapter === chapter && x?.status === 'pending')
            .map((x) => x.id),
    );
    // H2 修复（根因版）：novel.json 的读-改-写走**读时捕获版本 + 冲突重放**。
    // 0.13.6 那版靠 writeJson 默认的 'auto'（stat 完立刻写）自称全链路守卫，实际拦不住
    // 并发登记：两头都从同一份索引出发，后写的把先写的提案条目整体抹掉 → 幽灵提案
    // （提案文件在、索引没了，面板再也看不到它）。
    const { result } = await updateJson(io, p.meta, async (novel) => {
        if (novel === undefined) throw new Error(`书目不存在：「${book}」。先用 novel_project action=init 创建。`);
        const rec = novel.chapters?.[String(chapter)];
        if (rec === undefined) throw new Error(`第${chapter}章尚未保存——初稿直接走 novel_write_chapter，无需提案`);
        const blocker = (novel.proposals ?? []).find((x) => preexisting.has(x?.id) && x.status === 'pending');
        if (blocker !== undefined) {
            const based = Number.isInteger(blocker.baseVersion) ? `基于 v${blocker.baseVersion}` : '基线未知（旧提案）';
            throw new Error(`第${chapter}章已有待处理提案 ${blocker.id}（${based}）——请先在面板应用或丢弃，再提新的`);
        }
        // T1 层1 · 预留基线：记下本提案依据的正文版本（章记录的 latest），**文件与索引两处都写**。
        // 取的是这一次读到的 novel.json，与索引同一次写回——基线不会与被登记的条目错位。
        // 没有 latest（异常记录）时落 null：apply 侧退回时间戳兜底判定。
        const baseVersion = Number.isInteger(rec.latest) ? rec.latest : null;
        const proposal = {
            id, book, chapter, reason, status: 'pending', createdAt, baseVersion,
            content: norm.text.trimEnd(),
            quoteConverted: norm.converted,
        };
        // 提案文件先落（固定 id → 重放时是同内容幂等覆盖，不会产生第二份）
        await io.writeJson(p.proposal(id), proposal);
        novel.proposals = novel.proposals ?? [];
        novel.proposals.push({ id, chapter, status: 'pending', createdAt, baseVersion });
        novel.updatedAt = createdAt;
        return { value: novel, result: { id, chapter, status: 'pending', createdAt, baseVersion } };
    });
    await writeAudit(io, p, 'propose/create', { id, chapter, reason }, actor);
    return result;
}

/**
 * 提交修订提案（模型可用）。只写提案文件，**不动正文**。
 * @returns {{book, action:'propose', id, chapter, status:'pending'}}
 */
export async function proposeRevision(io, book, args, config) {
    const { novel } = await mustReadBook(io, book);

    if (!Number.isInteger(args.chapter)) throw new Error('propose 需要正整数 chapter');
    const rec = novel.chapters?.[String(args.chapter)];
    if (rec === undefined) throw new Error(`第${args.chapter}章尚未保存——初稿直接走 novel_write_chapter，无需提案`);
    if (typeof args.content !== 'string' || args.content.trim() === '') {
        throw new Error('propose 需要 content（修订后的整章正文）');
    }
    // 引号规范先行（0.20.0）：机审跑在规范化后的文本上，否则带直角引号的修订稿
    // 在 quoteStyle:block 下被拒——与写章/润色/面板保存同一道前置闸。
    args = { ...args, content: normalizeQuotes(args.content).text };

    const a = computeAudit({ content: args.content, previous: [], terms: [] });
    // 提案的字数上下限必须与写章门禁同一口径（自定义区间 > 平台 > 插件默认）：
    // 否则修订稿按默认 4000 收进来，落盘后 novel_audit 按本书口径判超长——
    // 「改一版就把书改坏」正是提案制最不该出现的形状。
    const { config: bookConfig } = effectiveCharConfig(config, novel);
    if (a.chars < bookConfig.minChapterChars || a.chars > bookConfig.maxChapterChars) {
        throw new Error(`修订稿 ${a.chars} 字超出上下限（${bookConfig.minChapterChars}-${bookConfig.maxChapterChars}），未生成提案`);
    }

    const created = await submitRevisionProposal(io, book, {
        chapter: args.chapter, content: args.content, reason: args.reason ?? '', actor: 'agent',
    });

    return {
        book, action: 'propose', id: created.id, chapter: created.chapter, status: created.status,
        // baseVersion 只在有值时携带：schema 声明 integer，null 会撞宿主严格校验（S1 事故）
        ...(Number.isInteger(created.baseVersion) ? { baseVersion: created.baseVersion } : {}),
    };
}

/** 列出提案（模型可用）。每条附 reason / 内容摘要 / 章标题——
 *  0.13.1 之前只回 id+章号，面板上「第 1 章」三个字让人完全看不出提案要干嘛。 */
export async function listProposals(io, book) {
    const { p, novel } = await mustReadBook(io, book);
    const out = [];
    for (const x of novel.proposals) {
        const v = proposalView(x);
        const rec = novel.chapters?.[String(x.chapter)];
        // title 只在有值时携带——schema 声明 string，null 会撞宿主严格校验（S1 修复）
        const t = rec?.title;
        if (t != null) v.title = t;
        // T1 层3 · 基线曝光：面板与模型自己看得出这条提案基于哪一版、本章现在到哪一版。
        // 同上，null/undefined 不进响应（schema 是 integer，宿主严格校验会拒整次调用）。
        if (Number.isInteger(x.baseVersion)) v.baseVersion = x.baseVersion;
        if (Number.isInteger(rec?.latest)) v.latestVersion = rec.latest;
        // 内容在提案文件里，索引只有指针；丢文件不算致命，标 missing 让 UI 有话可说。
        // id 不合式（索引被污染）同样按 missing 处理，不把坏 id 拼进读路径。
        const pf = validProposalId(x.id) ? await io.readJson(p.proposal(x.id)).catch(() => null) : null;
        if (pf === null) {
            v.missing = true; v.reason = ''; v.preview = '';
        } else {
            v.reason = String(pf.reason ?? '').trim();
            v.preview = String(pf.content ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        }
        out.push(v);
    }
    return { book, action: 'list', proposals: out };
}

/** 读单条提案全文（**仅面板**——应用前让人看清楚到底改了什么）。 */
export async function readProposal(io, book, proposalId) {
    const { p, novel } = await mustReadBook(io, book);
    if (!validProposalId(proposalId)) throw new Error('提案 id 不合式：' + String(proposalId).slice(0, 64));
    const entry = novel.proposals.find((x) => x.id === proposalId);
    if (entry === undefined) throw new Error('提案不存在：' + proposalId);
    const pf = await io.readJson(p.proposal(entry.id));
    if (pf === null) throw new Error('提案文件缺失：' + entry.id + '（提案索引还在，文件被删了？）');
    const rec = novel.chapters?.[String(entry.chapter)];
    return {
        ...proposalView(entry),
        title: rec?.title ?? null,
        // T1 层3 · 面板详情同样带基线（**仅面板通道**，不进工具 schema，因此可以为 null）
        baseVersion: Number.isInteger(pf.baseVersion) ? pf.baseVersion : null,
        latestVersion: Number.isInteger(rec?.latest) ? rec.latest : null,
        reason: String(pf.reason ?? '').trim(),
        content: String(pf.content ?? '').trimEnd(),
    };
}

/**
 * 应用提案（**仅用户**）：把提案变成新版本，旧版保留。
 * @param actor 触发方（REST → 'user'；测试/内部调用可覆盖）
 */
/**
 * 对「即将应用为新版本的正文」重算契约指标（0.20.0）。返回与写章链 gateRecord
 * 同形状的对象；细纲缺失/无契约段/解析不出 → null（chapterRecord 的 gate 兜底语义）。
 *
 * target（与写章门禁/审计同口径）由调用方算出再传入——这样函数签名变更面最小，
 * 保持纯函数（输入输出皆数据），便于直测。漏传时退回 computeGateMetrics 的默认
 * 3000，与写章链口径分家——真机就这么把 targetRatio 留痕数字写进 novel.json 落盘，
 * 修订后再读就是一条错的达成率（本次修根）。
 */
async function recomputeGateFor(io, p, n, content, { target } = {}) {
    const outline = await io.readText(p.chapterOutline(n));
    if (outline === null) return null;
    const m = computeGateMetrics({ content, outline, target });
    if (m.available !== true) return null;
    return {
        at: new Date().toISOString(),
        coverage: m.coverage,
        drift: m.drift,
        missedScenes: m.missedScenes,
        bannedHits: m.bannedHits,
        requirements: m.requirements,
        conditional: m.conditional,
        passed: m.passed,
        chars: m.chars,
        targetRatio: m.targetRatio,
    };
}

/**
 * 提案是否已被当前正文超越（**纯函数**，T1 层2）。
 *
 * 两种判定，缺一不可：
 *   · 新提案有 baseVersion（登记时章记录的 latest）→ 与当前 latest 直接比；
 *   · **存量提案没有 baseVersion（兼容分支，必须做）**→ 用「提案 createdAt 早于章记录
 *     updatedAt」兜底：章记录每次落盘都会刷新 updatedAt，「提案是在本章最后一次落盘之前
 *     提的」就是陈旧。少了这一支，盘上那些老 pending 一条都拦不住，等于没修。
 * 两个时间戳缺任一（老数据/测试替身）→ 判为不陈旧：无从证明就不拦，避免把存量提案全卡死。
 *
 * @returns null（不陈旧）| { base, latest, message }（陈旧，message 是给用户看的可执行中文错误）
 */
function stalenessOf(entry, proposal, rec) {
    const id = entry?.id ?? proposal?.id ?? '(未知提案)';
    const latest = Number.isInteger(rec?.latest) ? rec.latest : null;
    const base = Number.isInteger(proposal?.baseVersion) ? proposal.baseVersion
        : (Number.isInteger(entry?.baseVersion) ? entry.baseVersion : null);
    if (base !== null) {
        if (latest === null || base === latest) return null;
        return {
            base, latest,
            message: `提案 ${id} 基于 v${base}，本章当前已是 v${latest}——应用会把正文回退；请丢弃后基于最新版重提`,
        };
    }
    const createdAt = typeof proposal?.createdAt === 'string' ? proposal.createdAt
        : (typeof entry?.createdAt === 'string' ? entry.createdAt : null);
    const updatedAt = typeof rec?.updatedAt === 'string' ? rec.updatedAt : null;
    if (createdAt === null || updatedAt === null || createdAt >= updatedAt) return null;
    return {
        base: null, latest,
        message: `提案 ${id} 基于旧版正文（登记于 ${createdAt}，本章最后落盘于 ${updatedAt}${latest === null ? '' : `，当前 v${latest}`}）——应用会把正文回退；请丢弃后基于最新版重提`,
    };
}

export async function applyProposal(io, book, proposalId, config, actor = 'user') {
    const p = pathsFor(book);
    if (!validProposalId(proposalId)) throw new Error('提案 id 不合式：' + String(proposalId).slice(0, 64));
    // H2 修复（根因版）：整段「读 novel.json → 改 → 写回」放进 updateJson ——
    // 基线版本来自**读取那一刻**，撞上并发改动就重读最新状态重放，而不是用陈旧对象
    // 把别人的更新整体覆盖掉。
    // （0.13.6 那句「'auto' 已是版本守卫」的注释记错了功劳：'auto' 是写前一刻才 stat，
    // 版本永远匹配，拦不住陈旧覆盖；当时真正挡住「连点两次应用」的是版本文件的 'create'。）
    const { result } = await updateJson(io, p.meta, async (novel) => {
        if (novel === undefined) throw new Error(`书目不存在：「${book}」。先用 novel_project action=init 创建。`);
        const entry = (novel.proposals ?? []).find((x) => x.id === proposalId);
        if (entry === undefined) throw new Error(`提案不存在：${proposalId}（novel_propose list 查看）`);
        if (entry.status !== 'pending') throw new Error(`提案 ${entry.id} 状态为 ${entry.status}，不可再次应用`);

        const proposal = await io.readJson(p.proposal(entry.id));
        if (proposal === null) throw new Error(`提案文件缺失：${p.proposal(entry.id)}`);

        const n = proposal.chapter;
        const rec = novel.chapters?.[String(n)];
        if (rec === undefined) throw new Error(`第${n}章记录缺失，提案失效`);

        // T1 层2 · 陈旧守卫（真机那个「点应用把正文改回旧版」就在这里被拦下）：
        // 「status 还是 pending」只说明它没被处理过，「nextVersion = latest + 1」只保证版本号 +1——
        // 两者都不防**语义回退**：提案基于 v1、正文已由写章链路走到 v2，apply 会拿旧稿生成
        // v3 把正文改回去。基线与现状不符即拒，并把该提案标为终态 superseded。
        const stale = stalenessOf(entry, proposal, rec);
        if (stale !== null) {
            entry.status = 'superseded';
            entry.supersededAt = new Date().toISOString();
            novel.updatedAt = entry.supersededAt;
            return { value: novel, result: { superseded: { ...stale, id: entry.id, chapter: n } } };
        }

        const names = (rec.files ?? []).map((f) => f.file.split('/').pop() ?? '');
        const version = nextVersion(names, n);
        const rel = p.chapterFile(n, rec.title, version);
        // 引号规范兜底（幂等）：0.20.0 前登记的旧提案可能带直角引号，应用写盘时一并转换
        const intended = `${normalizeQuotes(proposal.content).text.trimEnd()}\n`;
        try {
            await io.writeText(rel, intended, 'create');   // 旧版永远保留：存在即失败
        } catch (error) {
            // 重放时可能撞上**上一轮我们自己写的那一份**：内容逐字相同才认领；
            // 不同则说明是别人写的版本文件，原样抛错，绝不覆盖。
            if (!isVersionConflict(error) || (await io.readText(rel)) !== intended) throw error;
        }

        // T4：prev 传**当前章记录的完整对象**（此前是三字段浅字面量，丢了 gate）。
        // store.chapterRecord 只在 prev.gate 存在时才保留 gate，而重算在「细纲文件缺失 /
        // 契约段解析不出」时返回 null（降级不阻断应用）——于是新版本记录的 gate 字段直接消失，
        // 契约指标趋势断档。传整条记录后，重算返 null 时自动回落到上一版的 gate。
        novel.chapters[String(n)] = chapterRecord(
            rec,
            {
                title: rec.title, version, file: rel, chars: proposal.content.replace(/\s/g, '').length, summary: rec.summary,
                // 0.20.0：应用后**立即对新版本重算契约指标**——此前 gate 记录停在旧版，
                // ch1 v2 修订后 passed=None 的断档就是这么来的。细纲读不到/解析不出时
                // gate 置 null（与写章链 available=false 同义），失败降级不阻断应用。
                // target 与写章门禁/审计同口径（effectiveCharConfig 统一取书的自定义/平台/插件档）：
                // 旧实现漏传，targetRatio 落盘默认 3000，修订后读就是一条错的达成率留痕。
                gate: await recomputeGateFor(io, p, n, normalizeQuotes(proposal.content).text, {
                    target: chapterCharTarget(effectiveCharConfig(config, novel).config),
                }).catch(() => null),
            }
        );
        entry.status = 'applied';
        entry.appliedAt = new Date().toISOString();
        advanceStage(novel, 'revising');
        novel.updatedAt = new Date().toISOString();
        return { value: novel, result: { n, rel, version, entryId: entry.id, proposal, novel } };
    });
    if (result.superseded !== undefined) {
        const s = result.superseded;
        // 终态双写（照抄下面 applied 的手法）：索引已写 superseded，文件里的 status 也必须同步，
        // 否则「文件说 pending、索引说 superseded」的双源分裂会把读文件的诊断带偏。
        try {
            const pf = await io.readJson(p.proposal(s.id));
            if (pf !== null && pf.status !== 'superseded') {
                await io.writeJson(p.proposal(s.id), { ...pf, status: 'superseded', supersededAt: new Date().toISOString() });
            }
        } catch (error) {
            console.warn(`[novel-forge] 陈旧提案状态回写失败（索引已为准，不影响拒绝结果）: ${error?.message ?? error}`);
        }
        await writeAudit(io, p, 'propose/superseded', { id: s.id, chapter: s.chapter, base: s.base, latest: s.latest }, actor);
        throw new Error(s.message);
    }
    const { n, rel, version, entryId, proposal, novel } = result;
    await writeAudit(io, p, 'propose/apply', { id: entryId, chapter: n, version, file: rel }, actor);

    // 状态回写（2026-09-23 真机排障）：apply 此前只更新 novel.json 索引，盘上提案文件永远停在
    // 创建时的 pending——任何读文件的诊断都会被撒谎的字段带偏（索引是唯一真相，文件是内容快照，
    // 但留着会过期的 status 字段就是双源不一致）。best-effort 回写，失败降级不阻断（应用已成功）。
    try {
        const pf = await io.readJson(p.proposal(entryId));
        if (pf !== null && pf.status !== 'applied') {
            await io.writeJson(p.proposal(entryId), { ...pf, status: 'applied', appliedAt: new Date().toISOString() });
        }
    } catch (error) {
        console.warn(`[novel-forge] 提案文件状态回写失败（索引已为准，不影响应用结果）: ${error?.message ?? error}`);
    }

    // 应用后跑一次机审，给 warnings 不拦截（修订通常针对具体问题）。
    // 口径同样按本书档位取——回执里的「还差 N 字」必须与写章门禁说的是同一件事。
    const { config: bookConfig } = effectiveCharConfig(config, novel);
    const window = Number.isInteger(config.repetitionWindow) && config.repetitionWindow >= 1 ? config.repetitionWindow : 10;
    const auditChapterKeys = Object.keys(novel.chapters ?? {}).map(Number).filter((k) => k < n).sort((a, b) => b - a).slice(0, window);
    const auditPrevious = [];
    for (const k of auditChapterKeys) {
        const prevRec = novel.chapters[String(k)];
        if (prevRec?.path === undefined) continue;
        // 路径收口（跟进项①同规）：novel.json 是数据文件，rec.path 可能被手工改坏——
        // 越书路径按缺章跳过，不把审计的读取面开放成「工作区内任意读」。
        const rel = chapterRelPath(prevRec, book);
        if (rel === null) continue;
        const text = await io.readText(rel);
        if (text !== null) auditPrevious.push({ chapter: k, content: text });
    }
    const a = computeAudit({ content: proposal.content, previous: auditPrevious, terms: [] });
    const verdict = auditVerdict(a, bookConfig);

    // M6 修复：应用也过一遍内容门禁，结果**只作 notice 附在返回值里**（应用是用户
    // 主权，不拦）——但这版改出了死人复活/泄底/欠账倒挂必须当场有话可说，不能等
    // 下一次写章的机审才在别的章节冒出来。门禁所需输入读不到就跳过（不阻断应用）。
    let gateNotice = null;
    try {
        const facts = (await io.readJson(p.facts)) ?? [];
        const foreshadows = (await io.readJson(p.foreshadows)) ?? [];
        const contracts = (await io.readJson(p.sceneContracts)) ?? {};
        const cg = contentGate({
            content: proposal.content,
            chapter: n,
            facts,
            foreshadows,
            cast: novel.cast ?? [],
            actorNames: [...(novel.cast ?? []), ...facts.map((f) => f.entity)],
            contract: contractFor(contracts, n),
        });
        gateNotice = {
            ok: cg.ok,
            blocking: cg.blocking.map((b) => b.message),
            warnings: cg.warnings.map((w) => w.message),
        };
    } catch { gateNotice = null; }

    return {
        book, action: 'apply', id: entryId, chapter: n, status: 'applied',
        path: rel, version, chars: a.chars, warnings: verdict.warnings, gate: gateNotice,
    };
}

/** 丢弃提案（**仅用户**）：标记为 discarded，正文不动（提案文件保留为冷归档）。 */
export async function discardProposal(io, book, proposalId, actor = 'user') {
    const p = pathsFor(book);
    // id 形状守卫（T3）：readProposal / applyProposal 都有，只有这里漏了——而这里同样把 id
    // 拼进**写路径**（下面回写提案文件的 p.proposal(...)），索引被污染的 id（../ 等）
    // 能越出提案目录写文件。读路径已收口，写路径同样必须收。
    if (!validProposalId(proposalId)) throw new Error('提案 id 不合式：' + String(proposalId).slice(0, 64));
    // 同 submit/apply：读-改-写必须走**读时版本 + 冲突重放**，否则与并发的登记互踩
    const { result } = await updateJson(io, p.meta, (novel) => {
        if (novel === undefined) throw new Error(`书目不存在：「${book}」。先用 novel_project action=init 创建。`);
        const entry = (novel.proposals ?? []).find((x) => x.id === proposalId);
        if (entry === undefined) throw new Error(`提案不存在：${proposalId}`);
        // superseded 也必须能丢：陈旧守卫拒下 apply 的文案就是「请丢弃后基于最新版
        // 重提」，而这里此前只收 pending——照提示操作必撞 400，面板之外的通道又
        // 不提供清理，流程就死锁在那条提案上（它永远不会再变成 pending）。
        // superseded 已是终态（永不参与 apply），丢弃它不会丢掉任何还能生效的东西。
        if (entry.status !== 'pending' && entry.status !== 'superseded') {
            throw new Error(`提案 ${entry.id} 状态为 ${entry.status}，不可丢弃（只有待处理/已陈旧的提案需要清理）`);
        }
        entry.status = 'discarded';
        entry.discardedAt = new Date().toISOString();
        novel.updatedAt = new Date().toISOString();
        return { value: novel, result: { id: entry.id, chapter: entry.chapter } };
    });
    await writeAudit(io, p, 'propose/discard', result, actor);

    // 同 apply：文件里的 status 字段同步终态，防「文件说 pending、索引说 discarded」的双源分裂
    try {
        const pf = await io.readJson(p.proposal(result.id));
        if (pf !== null && pf.status !== 'discarded') {
            await io.writeJson(p.proposal(result.id), { ...pf, status: 'discarded', discardedAt: new Date().toISOString() });
        }
    } catch (error) {
        console.warn(`[novel-forge] 提案文件状态回写失败（索引已为准，不影响丢弃结果）: ${error?.message ?? error}`);
    }

    return { book, action: 'discard', id: result.id, status: 'discarded' };
}

/**
 * 清理已终态（非 pending）提案的索引引用。
 *
 * 宿主 fs 无删除原语（resolve/stat/readText/writeText），真文件无法物理删，
 * 故保留为冷归档（.novel/proposals/*.json 不再被 novel.json.proposals 追踪）。
 */
export async function pruneProposals(io, book, actor = 'user') {
    const p = pathsFor(book);
    let summary = { removed: 0, proposals: [] };
    const { written } = await updateJson(io, p.meta, (novel) => {
        if (novel === undefined) throw new Error(`书目不存在：「${book}」。先用 novel_project action=init 创建。`);
        const all = novel.proposals ?? [];
        const keep = all.filter((x) => x.status === 'pending');
        // 每轮用**最新**内容重算，重放不会少报/多报
        summary = { removed: all.length - keep.length, proposals: keep.map(proposalView) };
        if (summary.removed === 0) return undefined;    // 无可清理 → 不动版本、不落审计
        novel.proposals = keep;
        novel.updatedAt = new Date().toISOString();
        return { value: novel };
    });
    if (written) await writeAudit(io, p, 'propose/prune', { removed: summary.removed }, actor);
    return { book, action: 'prune', removed: summary.removed, proposals: summary.proposals };
}
