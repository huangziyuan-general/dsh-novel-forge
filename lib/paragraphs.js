// lib/paragraphs.js — 段落切分的**唯一口径**（纯函数，零 io）。
//
// 为什么必须只有一份：docx 导入路径（lib/docx.js `out.join('\n')`）把 Word 段落
// 写成**单换行**，而正文合流/手写稿多用空行分段。若各模块各自 `split(/\n\s*\n/)`，
// 导入书的整章会被算成 1 段：
//   · noai structure 维 paraCv=0 → 该维虚高（实测 60 vs 21 章真值 11.5）；
//   · audit 段数门禁「<3 段」直接驳回所有导入书章节（111/111 章实测）；
//   · content-gate「连续 ≥3 段句首他/她」在单换行文本上永远不触发（漏检）。
// 因此统一为：**按换行切段（单换行与空行都算段边界）**，并剔除标题行。
//
// 标题行口径复用 lib/import.js 的 isChapterHeading（全项目唯一的「第N章」识别），
// 加 30 字上限——与 noai 一句一段判据此前的私有规则一致（短线标题才是标题，
// 正文里长段落偶然以「第一章」起头不算）。

import { isChapterHeading } from './import.js';

/** 标题行：Markdown 标题（`#` + 空白/行尾），或 30 字以内的「第N章」行。 */
export function isHeadingLine(line) {
    const t = String(line ?? '').trim();
    if (t === '') return false;
    if (/^#{1,6}(?:\s|$)/.test(t)) return true;
    return isChapterHeading(t)
        && t.replace(/^#+\s*/, '').replace(/\s/g, '').length <= 30;
}

/**
 * 正文 → 段落数组（trim 后非空、去标题行）。
 * 换行一律视为段边界：`\n` 与 `\n\n` 同权，连续空行不产生空段。
 * @param text 正文
 * @returns {string[]}
 */
export function splitParagraphs(text) {
    return String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .split(/\n+/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0 && !isHeadingLine(p));
}
