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
// 一份逻辑两层共用：工具（lib/tools/propose-tools.js）与 REST（lib/server-api.js）
// 都调这里的函数，避免"两边各写一遍 apply"漂移。

import { pathsFor, chapterRecord } from './store.js';
import { nextVersion } from './versioning.js';
import { advanceStage } from './gate.js';
import { computeAudit, auditVerdict } from './audit.js';
import { contentGate } from './content-gate.js';
import { contractFor } from './scene-contract.js';
import { auditLine, updateJson, isVersionConflict } from './fsio.js';

/** 写一条审计（actor 由调用方给：工具=agent，REST=user）。 */
async function writeAudit(io, p, action, detail, actor) {
    await io.appendLine(p.audit, auditLine(action, detail, actor));
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
    const proposal = {
        id, book, chapter, reason, status: 'pending', createdAt, content: String(content).trimEnd(),
    };
    // H2 修复（根因版）：novel.json 的读-改-写走**读时捕获版本 + 冲突重放**。
    // 0.13.6 那版靠 writeJson 默认的 'auto'（stat 完立刻写）自称全链路守卫，实际拦不住
    // 并发登记：两头都从同一份索引出发，后写的把先写的提案条目整体抹掉 → 幽灵提案
    // （提案文件在、索引没了，面板再也看不到它）。
    const { result } = await updateJson(io, p.meta, async (novel) => {
        if (novel === undefined) throw new Error(`书目不存在：「${book}」。先用 novel_project action=init 创建。`);
        const rec = novel.chapters?.[String(chapter)];
        if (rec === undefined) throw new Error(`第${chapter}章尚未保存——初稿直接走 novel_write_chapter，无需提案`);
        // 提案文件先落（固定 id → 重放时是同内容幂等覆盖，不会产生第二份）
        await io.writeJson(p.proposal(id), proposal);
        novel.proposals = novel.proposals ?? [];
        novel.proposals.push({ id, chapter, status: 'pending', createdAt });
        novel.updatedAt = createdAt;
        return { value: novel, result: { id, chapter, status: 'pending', createdAt } };
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

    const a = computeAudit({ content: args.content, previous: [], terms: [] });
    if (a.chars < config.minChapterChars || a.chars > config.maxChapterChars) {
        throw new Error(`修订稿 ${a.chars} 字超出上下限（${config.minChapterChars}-${config.maxChapterChars}），未生成提案`);
    }

    const created = await submitRevisionProposal(io, book, {
        chapter: args.chapter, content: args.content, reason: args.reason ?? '', actor: 'agent',
    });

    return { book, action: 'propose', id: created.id, chapter: created.chapter, status: created.status };
}

/** 列出提案（模型可用）。每条附 reason / 内容摘要 / 章标题——
 *  0.13.1 之前只回 id+章号，面板上「第 1 章」三个字让人完全看不出提案要干嘛。 */
export async function listProposals(io, book) {
    const { p, novel } = await mustReadBook(io, book);
    const out = [];
    for (const x of novel.proposals) {
        const v = proposalView(x);
        // title 只在有值时携带——schema 声明 string，null 会撞宿主严格校验（S1 修复）
        const t = novel.chapters?.[String(x.chapter)]?.title;
        if (t != null) v.title = t;
        // 内容在提案文件里，索引只有指针；丢文件不算致命，标 missing 让 UI 有话可说
        const pf = await io.readJson(p.proposal(x.id)).catch(() => null);
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
    const entry = novel.proposals.find((x) => x.id === proposalId);
    if (entry === undefined) throw new Error('提案不存在：' + proposalId);
    const pf = await io.readJson(p.proposal(entry.id));
    if (pf === null) throw new Error('提案文件缺失：' + entry.id + '（提案索引还在，文件被删了？）');
    return {
        ...proposalView(entry),
        title: novel.chapters?.[String(entry.chapter)]?.title ?? null,
        reason: String(pf.reason ?? '').trim(),
        content: String(pf.content ?? '').trimEnd(),
    };
}

/**
 * 应用提案（**仅用户**）：把提案变成新版本，旧版保留。
 * @param actor 触发方（REST → 'user'；测试/内部调用可覆盖）
 */
export async function applyProposal(io, book, proposalId, config, actor = 'user') {
    const p = pathsFor(book);
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

        const names = (rec.files ?? []).map((f) => f.file.split('/').pop() ?? '');
        const version = nextVersion(names, n);
        const rel = p.chapterFile(n, rec.title, version);
        const intended = `${proposal.content.trimEnd()}\n`;
        try {
            await io.writeText(rel, intended, 'create');   // 旧版永远保留：存在即失败
        } catch (error) {
            // 重放时可能撞上**上一轮我们自己写的那一份**：内容逐字相同才认领；
            // 不同则说明是别人写的版本文件，原样抛错，绝不覆盖。
            if (!isVersionConflict(error) || (await io.readText(rel)) !== intended) throw error;
        }

        novel.chapters[String(n)] = chapterRecord(
            { title: rec.title, versions: rec.versions, files: rec.files },
            { title: rec.title, version, file: rel, chars: proposal.content.replace(/\s/g, '').length, summary: rec.summary }
        );
        entry.status = 'applied';
        entry.appliedAt = new Date().toISOString();
        advanceStage(novel, 'revising');
        novel.updatedAt = new Date().toISOString();
        return { value: novel, result: { n, rel, version, entryId: entry.id, proposal, novel } };
    });
    const { n, rel, version, entryId, proposal, novel } = result;
    await writeAudit(io, p, 'propose/apply', { id: entryId, chapter: n, version, file: rel }, actor);

    // 应用后跑一次机审，给 warnings 不拦截（修订通常针对具体问题）。
    const window = Number.isInteger(config.repetitionWindow) && config.repetitionWindow >= 1 ? config.repetitionWindow : 10;
    const auditChapterKeys = Object.keys(novel.chapters ?? {}).map(Number).filter((k) => k < n).sort((a, b) => b - a).slice(0, window);
    const auditPrevious = [];
    for (const k of auditChapterKeys) {
        const prevRec = novel.chapters[String(k)];
        if (prevRec?.path === undefined) continue;
        const text = await io.readText(prevRec.path);
        if (text !== null) auditPrevious.push({ chapter: k, content: text });
    }
    const a = computeAudit({ content: proposal.content, previous: auditPrevious, terms: [] });
    const verdict = auditVerdict(a, config);

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
    // 同 submit/apply：读-改-写必须走**读时版本 + 冲突重放**，否则与并发的登记互踩
    const { result } = await updateJson(io, p.meta, (novel) => {
        if (novel === undefined) throw new Error(`书目不存在：「${book}」。先用 novel_project action=init 创建。`);
        const entry = (novel.proposals ?? []).find((x) => x.id === proposalId);
        if (entry === undefined) throw new Error(`提案不存在：${proposalId}`);
        if (entry.status !== 'pending') throw new Error(`提案 ${entry.id} 状态为 ${entry.status}，不可丢弃`);
        entry.status = 'discarded';
        entry.discardedAt = new Date().toISOString();
        novel.updatedAt = new Date().toISOString();
        return { value: novel, result: { id: entry.id, chapter: entry.chapter } };
    });
    await writeAudit(io, p, 'propose/discard', result, actor);

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
