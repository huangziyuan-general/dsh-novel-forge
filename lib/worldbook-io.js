// lib/worldbook-io.js — 纯函数：世界书导入/导出的格式转换（JSON round-trip + 宽松文本）。
// 只做数据转换与校验；不碰 io。

import { normalizeWorldEntry } from './store.js';

/** 序列化成紧凑 JSON 文本（供导出）。 */
export function serializeWorldbook(entries) {
    return JSON.stringify(entries ?? [], null, 2);
}

/**
 * 解析世界书导入文本，返回已归一化条目 + 错误。
 * 接受三种形态：
 *  - JSON 数组：[{id?, keywords[], content, always?, priority?}]
 *  - SillyTavern 简化形：{keywords:[...], content:...} 或 {keyword/comment}（尽力规约）
 *  - 纯文本行：`关键词1,关键词2 | 设定内容`（每行一条，| 前为触发词）
 * @param text 原样导入文本
 * @param existing 已存在条目（用于 id 去重/续号）
 * @returns { entries, errors }  entries 已通过 normalizeWorldEntry 校验
 */
export function parseWorldbookImport(text, existing = []) {
    const source = String(text ?? '');
    const entries = [];
    const errors = [];
    if (source.trim() === '') return { entries, errors: ['导入文本为空'] };

    const pushRaw = (raw, lineNo) => {
        try {
            // SillyTavern 完整格式：{uid, key, content, constant, selective, ...}
            // 统一规约到 normalizeWorldEntry 的参数形态
            const kw = Array.isArray(raw.keywords)
                ? raw.keywords.map(String)
                : typeof raw.keywords === 'string' ? raw.keywords.split(/[,，、]/)
                : typeof raw.key === 'string' ? raw.key.split(/[,，、]/)
                : raw.keyword ? [String(raw.keyword)]
                : undefined;
            entries.push(normalizeWorldEntry({
                id: raw.id ?? (raw.uid != null ? `W${raw.uid}` : undefined),
                keywords: kw,
                content: raw.content ?? raw.comment ?? '',
                always: raw.always === true || raw.constant === true,
                priority: raw.priority,
            }, [...existing, ...entries]));
        } catch (error) {
            errors.push(`第${lineNo ?? '?'}条跳过：${error.message}`);
        }
    };

    const trimmed = source.trim();
    if (trimmed.startsWith('[')) {
        let arr;
        try { arr = JSON.parse(trimmed); }
        catch (error) { return { entries, errors: [`JSON 解析失败：${error.message}`] }; }
        if (!Array.isArray(arr)) return { entries, errors: ['导入 JSON 应为数组'] };
        arr.forEach((raw, i) => pushRaw(raw, i + 1));
        return { entries, errors };
    }
    // 每行一条：`关键词... | 内容`
    source.split(/\r?\n/).forEach((line, i) => {
        const l = line.trim();
        if (l === '' || l.startsWith('#')) return;
        const sep = l.indexOf('|');
        if (sep === -1) { errors.push(`第${i + 1}行忽略（缺「|」分隔）：${l.slice(0, 30)}`); return; }
        const keys = l.slice(0, sep).trim();
        const content = l.slice(sep + 1).trim();
        pushRaw({ keywords: keys ? keys.split(/[,，、]/) : undefined, content }, i + 1);
    });
    return { entries, errors };
}