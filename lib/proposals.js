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
import { auditLine } from './fsio.js';

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
 * 提交修订提案（模型可用）。只写提案文件，**不动正文**。
 * @returns {{book, action:'propose', id, chapter, status:'pending'}}
 */
export async function proposeRevision(io, book, args, config) {
    const { p, novel } = await mustReadBook(io, book);

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

    const id = `P${args.chapter}-${Date.now().toString(36)}`;
    const proposal = {
        id, book, chapter: args.chapter, reason: args.reason ?? '',
        status: 'pending', createdAt: new Date().toISOString(), content: args.content.trimEnd(),
    };
    await io.writeJson(p.proposal(id), proposal);
    novel.proposals.push({ id, chapter: args.chapter, status: 'pending', createdAt: proposal.createdAt });
    novel.updatedAt = new Date().toISOString();
    await io.writeJson(p.meta, novel);
    await writeAudit(io, p, 'propose/create', { id, chapter: args.chapter, reason: proposal.reason }, 'agent');

    return { book, action: 'propose', id, chapter: args.chapter, status: 'pending' };
}

/** 列出提案（模型可用）。 */
export async function listProposals(io, book) {
    const { novel } = await mustReadBook(io, book);
    return { book, action: 'list', proposals: novel.proposals.map(proposalView) };
}

/**
 * 应用提案（**仅用户**）：把提案变成新版本，旧版保留。
 * @param actor 触发方（REST → 'user'；测试/内部调用可覆盖）
 */
export async function applyProposal(io, book, proposalId, config, actor = 'user') {
    const { p, novel } = await mustReadBook(io, book);

    const idx = novel.proposals.findIndex((x) => x.id === proposalId);
    if (idx === -1) throw new Error(`提案不存在：${proposalId}（novel_propose list 查看）`);
    const entry = novel.proposals[idx];
    if (entry.status !== 'pending') throw new Error(`提案 ${entry.id} 状态为 ${entry.status}，不可再次应用`);

    const proposal = await io.readJson(p.proposal(entry.id));
    if (proposal === null) throw new Error(`提案文件缺失：${p.proposal(entry.id)}`);

    const n = proposal.chapter;
    const rec = novel.chapters?.[String(n)];
    if (rec === undefined) throw new Error(`第${n}章记录缺失，提案失效`);

    const names = (rec.files ?? []).map((f) => f.file.split('/').pop() ?? '');
    const version = nextVersion(names, n);
    const rel = p.chapterFile(n, rec.title, version);
    await io.writeText(rel, `${proposal.content.trimEnd()}\n`, 'create');

    novel.chapters[String(n)] = chapterRecord(
        { title: rec.title, versions: rec.versions, files: rec.files },
        { title: rec.title, version, file: rel, chars: proposal.content.replace(/\s/g, '').length, summary: rec.summary }
    );
    entry.status = 'applied';
    entry.appliedAt = new Date().toISOString();
    advanceStage(novel, 'revising');
    novel.updatedAt = new Date().toISOString();
    await io.writeJson(p.meta, novel);
    await writeAudit(io, p, 'propose/apply', { id: entry.id, chapter: n, version, file: rel }, actor);

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

    return {
        book, action: 'apply', id: entry.id, chapter: n, status: 'applied',
        path: rel, version, chars: a.chars, warnings: verdict.warnings,
    };
}

/** 丢弃提案（**仅用户**）：标记为 discarded，正文不动（提案文件保留为冷归档）。 */
export async function discardProposal(io, book, proposalId, actor = 'user') {
    const { p, novel } = await mustReadBook(io, book);
    const idx = novel.proposals.findIndex((x) => x.id === proposalId);
    if (idx === -1) throw new Error(`提案不存在：${proposalId}`);
    const entry = novel.proposals[idx];
    if (entry.status !== 'pending') throw new Error(`提案 ${entry.id} 状态为 ${entry.status}，不可丢弃`);

    entry.status = 'discarded';
    entry.discardedAt = new Date().toISOString();
    novel.updatedAt = new Date().toISOString();
    await io.writeJson(p.meta, novel);
    await writeAudit(io, p, 'propose/discard', { id: entry.id, chapter: entry.chapter }, actor);

    return { book, action: 'discard', id: entry.id, status: 'discarded' };
}

/**
 * 清理已终态（非 pending）提案的索引引用。
 *
 * 宿主 fs 无删除原语（resolve/stat/readText/writeText），真文件无法物理删，
 * 故保留为冷归档（.novel/proposals/*.json 不再被 novel.json.proposals 追踪）。
 */
export async function pruneProposals(io, book, actor = 'user') {
    const { p, novel } = await mustReadBook(io, book);
    const keep = novel.proposals.filter((x) => x.status === 'pending');
    const removed = novel.proposals.length - keep.length;
    if (removed > 0) {
        novel.proposals = keep;
        novel.updatedAt = new Date().toISOString();
        await io.writeJson(p.meta, novel);
        await writeAudit(io, p, 'propose/prune', { removed }, actor);
    }
    return { book, action: 'prune', removed, proposals: novel.proposals.map(proposalView) };
}
