// lib/chapter-io.js — 书稿章节全文的只读收口。
//
// outline align 与创作驾驶舱都要回答“这些规划词是否已进正文”，但书稿读写必须走
// fsio，且 rec.path 是数据文件里的路径：这里集中处理越书路径拒读和缺文件跳过。

import { chapterRelPath } from './store.js';

/**
 * 读取已写章节的 {n, text}。beforeN 表示“只看当前章之前”，用于细纲生成前判断。
 * @param {object} io fsio 通道
 * @param {string} bookId 书目录名
 * @param {object} novel novel.json
 * @param {number|undefined} beforeN exclusive 上界；undefined 表示全部
 */
export async function readChapterTexts(io, bookId, novel, beforeN = undefined) {
    const out = [];
    const entries = Object.entries(novel?.chapters ?? {})
        .filter(([k]) => Number.isInteger(Number(k)) && Number(k) >= 1)
        .filter(([k]) => beforeN === undefined || Number(k) < beforeN)
        .sort(([a], [b]) => Number(a) - Number(b));
    for (const [k, rec] of entries) {
        const rel = chapterRelPath(rec, bookId);
        if (rel === null) continue;
        const text = await io.readText(rel);
        if (text !== null) out.push({ n: Number(k), text });
    }
    return out;
}
