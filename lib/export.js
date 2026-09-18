// lib/export.js — 把章节汇总成可发布的整本正文。
// assembleBookText / bookStats 是纯函数（不碰 io）；collectBookChapters 是
// 「novel.json 章节索引 → assembleBookText 输入」的 io 桥（fsio 传入，便于内存单测）。

import { chapterRelPath } from './store.js';

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

/**
 * 从 novel.json 的章节索引把「当前正文」逐章读出来，整理成 assembleBookText 要的形状。
 * 0.13.1 之前 REST 导出端点调了不存在的 exportLib.assembleBook(fsio, novel, …)
 * （0.5.x 埋的坏调用）→ 导出按钮从上线起就是 500。
 * @param io  有 readText(rel) 的 fsio（createFsio / createServerFsio 均可）
 * @param novel 解析好的 novel.json（读 chapters 索引）
 * @returns [{chapter, title, versions:[{version, content}]}]（按章号升序；读不出正文的章跳过）
 */
export async function collectBookChapters(io, novel) {
    const chapters = novel?.chapters ?? {};
    const nos = Object.keys(chapters).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
    const out = [];
    for (const no of nos) {
        const rec = chapters[String(no)];
        const rel = chapterRelPath(rec);
        if (!rel) continue;
        const content = (await io.readText(rel).catch(() => '')) ?? '';
        out.push({
            chapter: no,
            title: rec?.title ?? `第${no}章`,
            versions: [{ version: rec?.latest ?? 1, content }],
        });
    }
    return out;
}