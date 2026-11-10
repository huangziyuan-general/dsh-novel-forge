// 批注落盘收口：所有书稿 IO 走 fsio，定位与合并逻辑只在 annotations.js。

import { updateJson } from './fsio.js';
import { reconcileAnnotations, reanchorAnnotation, updateAnnotationStatus } from './annotations.js';

function chaptersOf(value) {
    return value?.chapters && typeof value.chapters === 'object' && !Array.isArray(value.chapters) ? value.chapters : {};
}

export async function reviewAnnotations(io, p, { chapter, version, content, freshIssues }) {
    const now = new Date().toISOString();
    let result = [];
    await updateJson(io, p.annotations, (current) => {
        const existing = chaptersOf(current)[String(chapter)] ?? [];
        const records = reconcileAnnotations(existing, freshIssues, content, { chapter, version, now });
        result = records;
        const before = JSON.stringify(existing);
        if (before === JSON.stringify(records)) return undefined;
        return { value: { schemaVersion: 1, chapters: { ...chaptersOf(current), [String(chapter)]: records } } };
    });
    return result;
}

export async function reanchorChapterAnnotations(io, p, { chapter, version, content }) {
    const now = new Date().toISOString();
    let result = [];
    const write = await updateJson(io, p.annotations, (current) => {
        const existing = chaptersOf(current)[String(chapter)];
        if (!Array.isArray(existing) || existing.length === 0) { result = []; return undefined; }
        const records = existing.map((record) => reanchorAnnotation(record, content, { version, now }));
        result = records;
        if (JSON.stringify(existing) === JSON.stringify(records)) return undefined;
        return { value: { schemaVersion: 1, chapters: { ...chaptersOf(current), [String(chapter)]: records } } };
    });
    return { annotations: result, written: write.written };
}

export async function setAnnotationStatus(io, p, { chapter, id, status }) {
    const now = new Date().toISOString();
    let annotation = null;
    await updateJson(io, p.annotations, (current) => {
        const existing = chaptersOf(current)[String(chapter)] ?? [];
        // 状态没变就不写盘：POST 重复点同一种状态不应刷新 updatedAt。
        const before = existing.find((record) => record.id === id);
        if (before && before.status === status) { annotation = before; return undefined; }
        const records = updateAnnotationStatus(existing, id, status, now);
        annotation = records.find((record) => record.id === id) ?? null;
        return { value: { schemaVersion: 1, chapters: { ...chaptersOf(current), [String(chapter)]: records } } };
    });
    return annotation;
}

export async function tryReanchorChapterAnnotations(io, p, args) {
    try {
        return await reanchorChapterAnnotations(io, p, args);
    } catch (error) {
        console.warn(`[novel-forge] 第 ${args.chapter} 章批注重定位失败（正文已保存）: ${error?.message ?? error}`);
        return { annotations: [], written: false, error: String(error?.message ?? error) };
    }
}
