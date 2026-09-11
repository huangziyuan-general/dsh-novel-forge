// lib/tools/common.js — 工具层共享的小助手（io 收口在 ../fsio.js）。

import { pathsFor } from '../store.js';
import { auditLine } from '../fsio.js';

export async function loadBook(io, book) {
    const p = pathsFor(book);
    const novel = await io.readJson(p.meta);
    return { novel, p };
}

export async function requireBook(io, book) {
    const { novel, p } = await loadBook(io, book);
    if (novel === null) throw new Error(`书目不存在：「${book}」。先用 novel_project action=init 创建。`);
    return { novel, p };
}

export async function saveBook(io, p, novel) {
    novel.updatedAt = new Date().toISOString();
    await io.writeJson(p.meta, novel);
}

export async function audit(io, p, action, detail = {}) {
    await io.appendLine(p.audit, auditLine(action, detail));
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
