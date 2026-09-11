// lib/export.js — 纯函数：把章节汇总成可发布的整本正文。
// 不碰 io：给有序章节列表，返回拼接好的 Markdown/纯文本。

/**
 * 拼接整本书正文。
 * @param chapters [{chapter?, title, versions:[{version, content}]}]（按章号升序）
 * @param mode 'md' | 'txt'（txt 时去掉 markdown 章节符）
 * @returns string
 */
export function assembleBookText(chapters, mode = 'md') {
    const blocks = [];
    chapters.forEach((c, i) => {
        if (!c) return;
        const latest = [...(c.versions ?? [])].sort((a, b) => b.version - a.version)[0];
        const content = latest?.content?.trim() ?? '';
        if (content === '') return;
        // 用真实章号（c.chapter）；跳章/删章后的洞不会让导出重编号
        const n = Number.isInteger(c.chapter) ? c.chapter : i + 1;
        const title = c.title?.trim() || `第${n}章`;
        const heading = mode === 'md' ? `## 第${n}章 ${title}` : `第${n}章 ${title}`;
        blocks.push(`${heading}\n\n${content}`);
    });
    return blocks.join('\n\n\n');
}

/** 统计可发布正文的概览（章节数/总字数/平均每章）。与 assembleBookText 同口径：空内容章节不计。 */
export function bookStats(chapters) {
    const rows = [];
    for (const c of chapters ?? []) {
        const latest = [...(c.versions ?? [])].sort((a, b) => b.version - a.version)[0];
        const content = latest?.content ?? '';
        if (content.trim() === '') continue;
        rows.push(content.replace(/\s/g, '').length);
    }
    const total = rows.reduce((a, b) => a + b, 0);
    return {
        chapters: rows.length,
        totalChars: total,
        avgChapterChars: rows.length === 0 ? 0 : Math.round(total / rows.length),
    };
}