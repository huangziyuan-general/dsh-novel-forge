// lib/tools/common.js — 工具层共享的小助手（io 收口在 ../fsio.js）。

import { pathsFor, addBookSession, migrateNovel, SCHEMA_VERSION } from '../store.js';
import { auditLine, updateJson } from '../fsio.js';

export async function loadBook(io, book) {
    const p = pathsFor(book);
    const novel = await io.readJson(p.meta);
    return { novel, p };
}

/**
 * 会话归属补录：把当前会话记进 `novel.sessions`，让面板按会话列出「本会话的书」。
 *
 * 为什么放在 requireBook：全部工具的入口都收在这里，一处接线即覆盖
 * 「创建 / 写章 / 审计 / 导出」等所有会碰书的动作 —— 会话中创建了几本书，
 * 面板就看得见几本。（刻意不写工具数：注册数会随版本变，写死必漂移。）
 *
 * 静默语义：归属只是 UI 层的账，读不到会话 id 或写盘被沙箱拒绝都**不阻断**
 * 工具主流程 —— 宁可少一条归属，也不能让写作挂掉。
 * @returns {Promise<boolean>} 是否真的补录了
 */
export async function rememberSession(io, p, novel) {
    try {
        const sessionId = io?.sessionId;
        if (!sessionId) return false;
        // ★ 只重放「补一条归属」这个增量，绝不拿调用方手上的旧快照整体回写：
        // 这一步每个工具入口都会走（含 isConcurrencySafe 的读工具），与面板的
        // apply/润色并发时，旧快照一旦落盘就把别人刚写好的索引/提案整体抹掉。
        // 认领前这本书属于哪些会话（跨会话访问的可追溯证据；在增量写入前捕获）
        let claimedFrom = null;
        const { written } = await updateJson(io, p.meta, (fresh) => {
            if (fresh === undefined) return undefined;              // 期间被删：不插手
            if (Array.isArray(fresh.sessions) && fresh.sessions.length > 0 && !fresh.sessions.includes(sessionId)) {
                claimedFrom = [...fresh.sessions];
            }
            if (!addBookSession(fresh, sessionId)) return undefined; // 已归属：不写盘
            return { value: fresh };
        });
        // 调用方手上的对象也要同步上这条归属，否则它随后 saveBook 会把归属又写丢
        if (novel && !novel.sessions?.includes(sessionId)) addBookSession(novel, sessionId);
        // 跨会话认领审计（**可见不阻断**）：工具层此前对「别的会话的书」只静默补录，
        // 面板却按会话过滤——这条不对称现在可追溯。每 (书, 会话) 至多记一次
        // （addBookSession 把它并成共有后，后续调用不再命中 claimedFrom）。
        if (claimedFrom !== null && written === true) {
            try { await audit(io, p, 'session-claimed', { from: claimedFrom, to: sessionId }); }
            catch { /* 审计是旁证，写不进也不能阻断写作 */ }
        }
        return written === true;
    } catch {
        return false;   // 静默语义不变：宁可少一条归属，也不能让写作挂掉
    }
}

export async function requireBook(io, book) {
    const { novel, p } = await loadBook(io, book);
    if (novel === null) throw new Error(`书目不存在：「${book}」。先用 novel_project action=init 创建。`);
    // 数据格式迁移（方向3）：旧书读到即升级到当前 schemaVersion 并落盘。
    // 幂等（已迁移的书 changed=false 不写盘）；**迁移失败绝不阻断写作**——它只补结构，
    // 补不了也照常让书能读能写（宁可少个版本锚点，不能让作者卡住）。
    try {
        const { changed, from, notes } = migrateNovel(novel);
        if (changed) {
            await saveBook(io, p, novel);
            try { await audit(io, p, 'schema/migrate', { from, to: SCHEMA_VERSION, notes }); }
            catch { /* 审计是旁证，写不进也不阻断 */ }
        }
    } catch { /* 迁移纯函数不抛；这里兜住落盘异常，绝不阻断主流程 */ }
    await rememberSession(io, p, novel);
    return { novel, p };
}

export async function saveBook(io, p, novel) {
    novel.updatedAt = new Date().toISOString();
    await io.writeJson(p.meta, novel);
}

/**
 * 写审计行。
 * @param actor 触发方：'agent'（模型调工具，默认）/ 'user'（面板 REST）/ 'system'。
 *   记录 actor 是为了事后能回答「这条动作是谁做的」——尤其是批准类动作。
 */
export async function audit(io, p, action, detail = {}, actor = 'agent') {
    // 带 session 标记（会话疲劳检测的数据源）；REST 面（serverFsio）无 sessionId，自然缺省
    await io.appendLine(p.audit, auditLine(action, detail, actor, io?.sessionId ?? undefined));
}

/** "a, b、c" → ["a","b","c"]（逗号/顿号/空白分隔）。 */
export function parseList(s) {
    if (typeof s !== 'string' || s.trim() === '') return [];
    return s.split(/[,，、\n]+/).map((x) => x.trim()).filter((x) => x !== '');
}

/**
 * 多行 "实体|键|值[|备注][|状态]" → [{entity,key,value,note,status}]。
 *
 * 状态字段的位置（第 4 段是状态、第 5 段是状态，两种都认）：
 *   实体|键|值                      → 状态 confirmed（默认）
 *   实体|键|值|unknown              → 状态 unknown
 *   实体|键|值|为什么还不知道        → 备注「为什么还不知道」，状态 confirmed
 *   实体|键|值|为什么还不知道|unknown → 备注 + 状态 unknown
 *
 * 判据：第 4 段**恰好**是状态词就当状态，否则当备注；备注之后还有一段时，
 * 那段是状态。状态词写全（confirmed/unknown/pending），别写中文缩写——中文「未知」
 * 既可能是备注也可能是作者随手写的说明，判不准就不猜。
 *
 * ⚠️ 状态必须显式写全称，且只认这三个词（ledger.js 的 FACT_STATUS）：
 * 写错的状态词会被 ledger 层归一成 confirmed——那等于白写。
 */
export function parseFactLines(s) {
    if (typeof s !== 'string' || s.trim() === '') return [];
    const isStatus = (x) => x === 'confirmed' || x === 'unknown' || x === 'pending';
    return s.split('\n').map((l) => l.trim()).filter((l) => l !== '').map((l) => {
        const parts = l.split('|').map((x) => x.trim());
        if (parts.length < 3) throw new Error(`facts_updates 行格式错误（需要 实体|键|值[|备注][|状态]）：${l}`);
        if (!parts[0]) throw new Error(`facts_updates 实体名不能为空：${l}`);
        if (!parts[1]) throw new Error(`facts_updates 键名不能为空：${l}`);
        const rest = parts.slice(3);
        let status = 'confirmed';
        let note = '';
        if (rest.length > 0 && isStatus(rest[0])) {
            status = rest[0];
            note = rest.slice(1).join('|');
        } else if (rest.length > 1 && isStatus(rest[rest.length - 1])) {
            // 状态在第 5 段：备注是它**前面**那些段（状态词不能漏进备注里——
            // 备注会进账本事实行，也会进简报摘要，带着一个 pending 很难看）。
            status = rest[rest.length - 1];
            note = rest.slice(0, -1).join('|');
        } else {
            note = rest.join('|');
        }
        return { entity: parts[0], key: parts[1], value: parts[2], note, status };
    });
}

/**
 * facts_evidence 解析：多行「实体|键|正文原句」。
 * 证据原句里可能出现竖线（引语/分行），所以第 3 段之后**全部**归证据，不按段再切。
 * 纯格式解析，不做任何正文比对（那是 ledger.validateFactEvidence 的事）。
 */
export function parseFactEvidence(s) {
    if (s === undefined || s === null) return [];
    if (typeof s !== 'string') throw new Error('facts_evidence 必须是多行文本「实体|键|正文原句」');
    if (s.trim() === '') return [];
    return s.split('\n').map((l) => l.trim()).filter((l) => l !== '').map((l) => {
        const parts = l.split('|').map((x) => x.trim());
        if (parts.length < 3) throw new Error(`facts_evidence 行格式错误（需要 实体|键|正文原句）：${l}`);
        if (!parts[0]) throw new Error(`facts_evidence 实体名不能为空：${l}`);
        if (!parts[1]) throw new Error(`facts_evidence 键名不能为空：${l}`);
        const evidence = parts.slice(2).join('|');
        if (evidence === '') throw new Error(`facts_evidence 证据原句不能为空：${l}`);
        return { entity: parts[0], key: parts[1], evidence };
    });
}

/** ContentBlock 文本块（工具 render 用）。 */
export function textBlock(text) {
    return [{ type: 'text', text }];
}

/**
 * 简报依据指纹的落盘（写前简报 → 写章提交之间的「陈旧检测」锚点）。
 *
 * 为什么落盘而不是让模型把指纹带回来：模型带回来的指纹是**自觉**——忘了带、
 * 带错了、带的是上一章的，服务器就无从查起。落一份服务端自己的记录，写章时
 * 由服务端重算并比对，模型参不参与都能查（AGENTS.md 主线：代码强制 > 提示词自觉）。
 *
 * 只保留最近 30 章（按章号倒序）——文件是机器状态，长书不能让它无限长。
 * 写失败**静默降级**：这份记录只是陈旧检测的旁证，写不进不该阻断简报。
 */
export async function recordBasis(io, p, chapter, basis) {
    if (basis === null || basis === undefined) return false;
    try {
        const at = new Date().toISOString();
        const { written } = await updateJson(io, p.basis, (fresh) => {
            const cur = (fresh !== undefined && fresh !== null && typeof fresh === 'object' && !Array.isArray(fresh)) ? fresh : {};
            const next = {
                ...cur,
                [String(chapter)]: {
                    version: basis.version,
                    digest: basis.digest,
                    at,
                    sources: basis.sources ?? [],
                    factsSig: basis.factsSig ?? [],
                },
            };
            const keep = Object.keys(next)
                .map((k) => Number(k))
                .filter((k) => Number.isInteger(k))
                .sort((a, b) => b - a)
                .slice(0, 30);
            const trimmed = {};
            for (const k of keep) trimmed[String(k)] = next[String(k)];
            return { value: trimmed };
        });
        return written === true;
    } catch {
        return false; // 旁证写不进：不阻断简报
    }
}

/**
 * 读某章的简报依据记录（没有 → null）。
 * 读不到/坏文件一律当「没有记录」——陈旧检测是旁证，不该因为旁证缺失而卡住写作。
 */
export async function readBasisRecord(io, p, chapter) {
    try {
        const raw = await io.readJson(p.basis);
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const rec = raw[String(chapter)];
        return rec !== null && typeof rec === 'object' ? rec : null;
    } catch {
        return null;
    }
}

/** 伏笔条目的工具输出形态：plan/payoffChapter 缺省时必须省略键——
 * null/undefined 值都会被宿主判 INVALID_TOOL_OUTPUT（可选字段只能缺键，不能给空值）。 */
export function foreshadowView(f) {
    return {
        id: f.id, setup: f.setup, chapter: f.chapter,
        ...(f.plan != null ? { plan: f.plan } : {}),
        ...(f.payoffChapter != null ? { payoffChapter: f.payoffChapter } : {}),
    };
}
