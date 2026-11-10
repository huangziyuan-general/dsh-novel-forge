// lib/quotes.js — 引号区间与对白剥离（纯函数）。
//
// 内容门禁（成稿缺陷四连）的共用实现：
// 判据都只该看**叙述**——角色台词里的「我无法完成」「细纲」是合法用法，
// 拿整段原文判必然误伤。多个判据共用一份剥离实现，「未闭合引号要不要剥」
// 这类边界只写一遍，不会漂移。

const QUOTE_OPEN = new Set(['“', '‘', '「', '『']);
const QUOTE_CLOSE = new Map([['”', '“'], ['’', '‘'], ['」', '「'], ['』', '『']]);

/**
 * 成对的引号区间。只认**有闭合**的引号：未闭合的引号不剥，
 * 否则半截稿会把自己的结尾也遮住，截断检测直接失效。
 * 支持嵌套（「『…』」）与直引号 "…"。
 * @returns {Array<[number, number]>} [start, end) 区间
 */
export function quotedRanges(text) {
    const s = String(text ?? '');
    const ranges = [];
    const stack = [];
    for (let i = 0; i < s.length; i += 1) {
        const ch = s[i];
        if (QUOTE_OPEN.has(ch)) {
            stack.push({ ch, i });
        } else if (ch === '"') {
            const top = stack[stack.length - 1];
            if (top !== undefined && top.ch === '"') {
                stack.pop();
                ranges.push([top.i, i + 1]);
            } else {
                stack.push({ ch: '"', i });
            }
        } else if (QUOTE_CLOSE.has(ch)) {
            const top = stack[stack.length - 1];
            if (top !== undefined && top.ch === QUOTE_CLOSE.get(ch)) {
                stack.pop();
                ranges.push([top.i, i + 1]);
            }
        }
    }
    ranges.sort((a, b) => a[0] - b[0]);
    return ranges;
}

/** 把引号内文本替换为空格（保留换行，行号不变）。 */
export function maskQuotedText(text) {
    const s = String(text ?? '');
    const ranges = quotedRanges(s);
    if (ranges.length === 0) return s;
    let out = '';
    let cursor = 0;
    for (const [a, b] of ranges) {
        if (a < cursor) {
            if (b <= cursor) continue;
            out += s.slice(cursor, b).replace(/[^\n]/g, ' ');
            cursor = b;
            continue;
        }
        out += s.slice(cursor, a);
        out += s.slice(a, b).replace(/[^\n]/g, ' ');
        cursor = b;
    }
    return out + s.slice(cursor);
}
