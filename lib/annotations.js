// 可重定位持久批注（纯函数）。不模糊猜测位置：精确引文或唯一邻近上下文才可归位。

import { splitParagraphs } from './paragraphs.js';

export const ANNOTATION_STATUSES = ['open', 'resolved', 'stale'];

function hashText(text) {
    let hash = 2166136261;
    for (const char of String(text ?? '')) {
        hash ^= char.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36).padStart(7, '0');
}

function issueSignature(issue) {
    return JSON.stringify(Array.isArray(issue?.issues) ? issue.issues : []);
}

function anchorAt(paragraphs, index) {
    const quote = paragraphs[index] ?? '';
    const before = index > 0 ? paragraphs[index - 1] : '';
    const after = index + 1 < paragraphs.length ? paragraphs[index + 1] : '';
    return {
        paragraphHash: hashText(quote),
        beforeHash: before === '' ? null : hashText(before),
        afterHash: after === '' ? null : hashText(after),
        before: before.slice(0, 120),
        after: after.slice(0, 120),
    };
}

function contextMatches(paragraphs, index, annotation) {
    const anchor = annotation.anchor ?? {};
    const beforeOk = anchor.beforeHash === null || anchor.beforeHash === undefined
        ? index === 0 : index > 0 && hashText(paragraphs[index - 1]) === anchor.beforeHash;
    const afterOk = anchor.afterHash === null || anchor.afterHash === undefined
        ? index === paragraphs.length - 1 : index + 1 < paragraphs.length && hashText(paragraphs[index + 1]) === anchor.afterHash;
    return beforeOk && afterOk;
}

function relocated(record, paragraphs, index, version, now, method) {
    const quote = paragraphs[index];
    const anchor = anchorAt(paragraphs, index);
    const next = {
        ...record,
        paragraph: index + 1,
        chars: quote.replace(/\s/g, '').length,
        quote,
        anchor,
        version,
        status: record.status === 'resolved' ? 'resolved' : 'open',
        location: method,
    };
    // 语义未变（位置/引文/锚点/版本/状态/定位方式都相同）时不刷新 updatedAt。
    // GET review-issues 每次都会重锚一遍；这里若无条件写 now，读接口就会每次改盘。
    const unchanged = record.paragraph === next.paragraph
        && record.chars === next.chars
        && record.quote === next.quote
        && record.version === next.version
        && record.status === next.status
        && record.location === next.location
        && JSON.stringify(record.anchor ?? null) === JSON.stringify(next.anchor);
    if (unchanged) return record;
    return {
        ...next,
        updatedAt: now,
        ...(record.status === 'resolved' ? { resolvedAt: record.resolvedAt ?? now } : { resolvedAt: null }),
    };
}

export function reanchorAnnotation(annotation, content, { version = annotation.version, now = annotation.updatedAt ?? null } = {}) {
    const paragraphs = splitParagraphs(content);
    const record = { ...annotation };
    const exact = [];
    paragraphs.forEach((paragraph, index) => {
        if (hashText(paragraph) === record.anchor?.paragraphHash && paragraph === record.quote) exact.push(index);
    });
    if (exact.length === 1) return relocated(record, paragraphs, exact[0], version, now, 'exact');
    if (exact.length > 1) {
        const nearby = exact.filter((index) => contextMatches(paragraphs, index, record));
        if (nearby.length === 1) return relocated(record, paragraphs, nearby[0], version, now, 'exact-context');
    }

    const nearby = [];
    if (record.anchor?.beforeHash && record.anchor?.afterHash) {
        for (let index = 1; index < paragraphs.length - 1; index += 1) {
            if (contextMatches(paragraphs, index, record)) nearby.push(index);
        }
    }
    if (nearby.length === 1) return relocated(record, paragraphs, nearby[0], version, now, 'context');

    if (record.status === 'stale' && record.location === 'missing' && record.version === version) return record;
    return {
        ...record,
        version,
        status: record.status === 'resolved' ? 'resolved' : 'stale',
        location: 'missing',
        updatedAt: now,
        ...(record.status === 'resolved' ? { resolvedAt: record.resolvedAt ?? now } : { resolvedAt: null }),
    };
}

export function annotationFromIssue(issue, content, { chapter, version, now }) {
    const paragraphs = splitParagraphs(content);
    const index = Math.max(0, Math.min(paragraphs.length - 1, Number(issue.paragraph) - 1));
    const quote = paragraphs[index] ?? '';
    const signature = issueSignature(issue);
    return {
        ...issue,
        sourceId: issue.id,
        id: `A${chapter}-${hashText(`${quote}\0${signature}`)}-${index + 1}`,
        chapter,
        version,
        quote,
        originalQuote: quote,
        anchor: anchorAt(paragraphs, index),
        status: 'open',
        location: 'exact',
        createdAt: now,
        updatedAt: now,
        resolvedAt: null,
    };
}

export function reconcileAnnotations(existing, freshIssues, content, { chapter, version, now }) {
    const paragraphs = splitParagraphs(content);
    const previous = (Array.isArray(existing) ? existing : []).map((record) => reanchorAnnotation(record, content, { version, now }));
    const used = new Set();
    const fresh = [];
    for (const issue of freshIssues) {
        const candidate = annotationFromIssue(issue, content, { chapter, version, now });
        let index = previous.findIndex((record, at) => !used.has(at)
            && record.quote === candidate.quote && issueSignature(record) === issueSignature(candidate));
        if (index < 0) {
            index = previous.findIndex((record, at) => !used.has(at)
                && record.sourceId === candidate.sourceId && record.quote === candidate.quote);
        }
        if (index >= 0) {
            used.add(index);
            const old = previous[index];
            const merged = {
                ...old,
                ...candidate,
                id: old.id,
                status: old.status,
                location: old.location,
                createdAt: old.createdAt,
                resolvedAt: old.resolvedAt ?? null,
            };
            // candidate 的时间戳是本次 now；只有除 updatedAt 外真的变了才认这次刷新，
            // 否则保留旧 updatedAt——GET review-issues 反复对账不得改盘。
            const { updatedAt: _oldAt, ...oldRest } = old;
            const { updatedAt: _mergedAt, ...mergedRest } = merged;
            merged.updatedAt = JSON.stringify(oldRest) === JSON.stringify(mergedRest) ? old.updatedAt : now;
            fresh.push(merged);
        } else {
            const duplicate = fresh.find((record) => record.id === candidate.id);
            if (duplicate) candidate.id = `${candidate.id}-${fresh.length + 1}`;
            fresh.push(candidate);
        }
    }
    const currentKeys = new Set(fresh.map((record) => `${record.quote}\0${issueSignature(record)}`));
    const retained = previous.filter((record, at) => !used.has(at)
        && !currentKeys.has(`${record.quote}\0${issueSignature(record)}`));
    const all = [...fresh, ...retained];
    const rank = { open: 0, stale: 1, resolved: 2 };
    return all.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9)
        || (a.paragraph ?? 0) - (b.paragraph ?? 0) || String(a.id).localeCompare(String(b.id)));
}

export function updateAnnotationStatus(records, id, status, now) {
    if (!ANNOTATION_STATUSES.includes(status)) throw new Error(`不支持的批注状态：${status}`);
    let found = false;
    const next = (Array.isArray(records) ? records : []).map((record) => {
        if (record.id !== id) return record;
        found = true;
        return {
            ...record,
            status,
            updatedAt: now,
            resolvedAt: status === 'resolved' ? now : null,
        };
    });
    if (!found) throw new Error(`批注不存在：${id}`);
    return next;
}
