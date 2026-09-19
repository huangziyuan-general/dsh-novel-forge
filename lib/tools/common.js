// lib/tools/common.js — 工具层共享的小助手（io 收口在 ../fsio.js）。

import { pathsFor, addBookSession } from '../store.js';
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
        const { written } = await updateJson(io, p.meta, (fresh) => {
            if (fresh === undefined) return undefined;              // 期间被删：不插手
            if (!addBookSession(fresh, sessionId)) return undefined; // 已归属：不写盘
            return { value: fresh };
        });
        // 调用方手上的对象也要同步上这条归属，否则它随后 saveBook 会把归属又写丢
        if (novel && !novel.sessions?.includes(sessionId)) addBookSession(novel, sessionId);
        return written === true;
    } catch {
        return false;   // 静默语义不变：宁可少一条归属，也不能让写作挂掉
    }
}

export async function requireBook(io, book) {
    const { novel, p } = await loadBook(io, book);
    if (novel === null) throw new Error(`书目不存在：「${book}」。先用 novel_project action=init 创建。`);
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
    await io.appendLine(p.audit, auditLine(action, detail, actor));
}

/** "a, b、c" → ["a","b","c"]（逗号/顿号/空白分隔）。 */
export function parseList(s) {
    if (typeof s !== 'string' || s.trim() === '') return [];
    return s.split(/[,，、\n]+/).map((x) => x.trim()).filter((x) => x !== '');
}

/** 多行 "实体|键|值[|备注]" → [{entity,key,value,note}]。 */
export function parseFactLines(s) {
    if (typeof s !== 'string' || s.trim() === '') return [];
    return s.split('\n').map((l) => l.trim()).filter((l) => l !== '').map((l) => {
        const parts = l.split('|').map((x) => x.trim());
        if (parts.length < 3) throw new Error(`facts_updates 行格式错误（需要 实体|键|值[|备注]）：${l}`);
        if (!parts[0]) throw new Error(`facts_updates 实体名不能为空：${l}`);
        if (!parts[1]) throw new Error(`facts_updates 键名不能为空：${l}`);
        return { entity: parts[0], key: parts[1], value: parts[2], note: parts.slice(3).join('|') };
    });
}

/** ContentBlock 文本块（工具 render 用）。 */
export function textBlock(text) {
    return [{ type: 'text', text }];
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
