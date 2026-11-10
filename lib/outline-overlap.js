// 细纲照搬检测（纯函数，零 token）。只提供复核证据，不替作者判断文字好坏。

import { SCENE_HEADINGS, parseScenes, sectionOf } from './gate-metrics.js';

export const OUTLINE_OVERLAP_HEADINGS = [
    '允许逐字引用', '原样引用', '原文引用', '原话引用', '逐字引用', '允许照搬',
];

const HAN_RE = /\p{Script=Han}/u;
const WORD_RE = /[\p{Letter}\p{Number}]/u;

function normalized(text) {
    const chars = [];
    const starts = [];
    const ends = [];
    let hanChars = 0;
    let offset = 0;
    for (const char of String(text ?? '')) {
        if (WORD_RE.test(char)) {
            chars.push(char.toLocaleLowerCase('zh-CN'));
            starts.push(offset);
            ends.push(offset + char.length);
            if (HAN_RE.test(char)) hanChars += 1;
        }
        offset += char.length;
    }
    return { text: chars.join(''), starts, ends, hanChars };
}

function cleanExemption(line) {
    let text = String(line ?? '').trim();
    text = text.replace(/^(?:[-*+>]\s+|\d+[.、)）]\s*)/, '').trim();
    text = text.replace(/^(?:原话|原文|誓词|系统面板|案卷原话|引用)\s*[:：]\s*/, '').trim();
    const pairs = [['「', '」'], ['『', '』'], ['“', '”'], ['‘', '’'], ['"', '"']];
    for (const [open, close] of pairs) {
        if (text.startsWith(open) && text.endsWith(close)) return text.slice(open.length, -close.length).trim();
    }
    return text.replace(/^>\s?/, '').trim();
}

export function outlineOverlapExemptions(outline) {
    const sceneSection = sectionOf(outline, SCENE_HEADINGS);
    const scenes = sceneSection === null ? [] : parseScenes(sceneSection);
    const excerpts = [];
    for (const heading of OUTLINE_OVERLAP_HEADINGS) {
        const section = sectionOf(outline, [heading]);
        if (section === null) continue;
        for (const line of section.split('\n')) {
            const excerpt = cleanExemption(line);
            if (excerpt !== '') excerpts.push(excerpt);
        }
    }
    return [...new Set([
        ...scenes.flatMap((scene) => [scene.title, ...scene.aliases]),
        ...excerpts,
    ].map((item) => String(item ?? '').trim()).filter((item) => item !== ''))];
}

function rawExcerpt(source, map, start, end) {
    const from = map.starts[start] ?? 0;
    const to = map.ends[end - 1] ?? from;
    const excerpt = source.slice(from, to).replace(/\s+/g, ' ').trim();
    return excerpt.length > 120 ? `${excerpt.slice(0, 117)}…` : excerpt;
}

function rawMatches(source, map, candidates) {
    const out = [];
    for (let start = 0; start < map.text.length; start += 1) {
        const row = [];
        for (const candidate of candidates) {
            const end = start + candidate.text.length;
            if (end <= map.text.length && map.text.slice(start, end) === candidate.text) {
                row.push({ start, end, text: candidate.text });
            }
        }
        out.push(...row);
    }
    return out;
}

function subtractRanges(start, end, ranges) {
    let pieces = [[start, end]];
    for (const range of ranges) {
        const next = [];
        for (const [from, to] of pieces) {
            if (range.end <= from || range.start >= to) {
                next.push([from, to]);
                continue;
            }
            if (from < range.start) next.push([from, Math.min(range.start, to)]);
            if (to > range.end) next.push([Math.max(range.end, from), to]);
        }
        pieces = next;
    }
    return pieces;
}

function commonRanges(content, outline) {
    if (content.text === '' || outline.text === '') return [];
    const states = [{ length: 0, link: -1, firstEnd: -1, next: new Map() }];
    let last = 0;
    for (let index = 0; index < outline.text.length; index += 1) {
        const char = outline.text[index];
        const current = states.length;
        states.push({ length: states[last].length + 1, link: 0, firstEnd: index + 1, next: new Map() });
        let cursor = last;
        while (cursor >= 0 && !states[cursor].next.has(char)) {
            states[cursor].next.set(char, current);
            cursor = states[cursor].link;
        }
        if (cursor < 0) states[current].link = 0;
        else {
            const target = states[cursor].next.get(char);
            if (states[cursor].length + 1 === states[target].length) states[current].link = target;
            else {
                const clone = states.length;
                states.push({
                    length: states[cursor].length + 1, link: states[target].link,
                    firstEnd: states[target].firstEnd, next: new Map(states[target].next),
                });
                while (cursor >= 0 && states[cursor].next.get(char) === target) {
                    states[cursor].next.set(char, clone);
                    cursor = states[cursor].link;
                }
                states[current].link = clone;
                states[target].link = clone;
            }
        }
        last = current;
    }

    const ranges = [];
    let state = 0;
    let length = 0;
    for (let index = 0; index < content.text.length; index += 1) {
        const char = content.text[index];
        while (state !== 0 && !states[state].next.has(char)) {
            state = states[state].link;
            length = states[state].length;
        }
        if (states[state].next.has(char)) {
            state = states[state].next.get(char);
            length += 1;
        } else {
            state = 0;
            length = 0;
        }
        if (length === 0) continue;
        const outlineEnd = states[state].firstEnd;
        ranges.push({
            contentStart: index + 1 - length, contentEnd: index + 1,
            outlineStart: outlineEnd - length, outlineEnd,
        });
    }
    ranges.sort((a, b) => a.contentStart - b.contentStart || b.contentEnd - a.contentEnd);
    const maximal = [];
    let coveredUntil = -1;
    for (const range of ranges) {
        if (range.contentEnd <= coveredUntil) continue;
        maximal.push(range);
        coveredUntil = range.contentEnd;
    }
    return maximal;
}

function unionHanChars(ranges, map) {
    const sorted = [...ranges].sort((a, b) => a.contentStart - b.contentStart || a.contentEnd - b.contentEnd);
    const union = [];
    for (const range of sorted) {
        const previous = union[union.length - 1];
        if (previous !== undefined && range.contentStart <= previous.contentEnd) {
            previous.contentEnd = Math.max(previous.contentEnd, range.contentEnd);
        } else union.push({ contentStart: range.contentStart, contentEnd: range.contentEnd });
    }
    return union.reduce((sum, range) => sum
        + [...map.text.slice(range.contentStart, range.contentEnd)].filter((char) => HAN_RE.test(char)).length, 0);
}

export function detectOutlineOverlap({ content, outline, minHanChars = 32, maxHits = 5 } = {}) {
    const threshold = Number.isInteger(minHanChars) && minHanChars >= 4 ? minHanChars : 32;
    const source = String(content ?? '');
    const plan = String(outline ?? '');
    const contentMap = normalized(source);
    const outlineMap = normalized(plan);
    const exemptions = outlineOverlapExemptions(plan)
        .map((text) => ({ text, ...normalized(text) }))
        .filter((item) => item.hanChars >= 2);
    const contentAllowed = rawMatches(source, contentMap, exemptions);
    const outlineAllowed = rawMatches(plan, outlineMap, exemptions);
    const hits = [];
    let exempted = 0;
    for (const range of commonRanges(contentMap, outlineMap)) {
        const contentPieces = subtractRanges(range.contentStart, range.contentEnd, contentAllowed);
        const outlinePieces = subtractRanges(range.outlineStart, range.outlineEnd, outlineAllowed);
        const contentCovered = range.contentEnd - range.contentStart - contentPieces.reduce((sum, [from, to]) => sum + to - from, 0);
        const outlineCovered = range.outlineEnd - range.outlineStart - outlinePieces.reduce((sum, [from, to]) => sum + to - from, 0);
        const sharedLength = Math.min(range.contentEnd - range.contentStart, range.outlineEnd - range.outlineStart);
        if (contentCovered > 0 || outlineCovered > 0) {
            if (contentCovered >= sharedLength && outlineCovered >= sharedLength) exempted += 1;
        }
        for (const [from, to] of contentPieces) {
            const piece = contentMap.text.slice(from, to);
            const hanChars = [...piece].filter((char) => HAN_RE.test(char)).length;
            if (hanChars < threshold) continue;
            if (hits.some((hit) => from >= hit.contentStart && to <= hit.contentEnd)) continue;
            const excerpt = rawExcerpt(source, contentMap, from, to);
            hits.push({ excerpt, hanChars, contentStart: from, contentEnd: to });
        }
    }

    const overlappedHanChars = unionHanChars(hits, contentMap);
    hits.sort((a, b) => b.hanChars - a.hanChars || a.contentStart - b.contentStart);
    const publicHits = hits.slice(0, Math.max(1, maxHits)).map(({ excerpt, hanChars }) => ({ excerpt, hanChars }));
    return {
        hit: publicHits.length > 0,
        hits: publicHits,
        hitCount: hits.length,
        exempted,
        overlappedHanChars,
        contentHanChars: contentMap.hanChars,
        ratio: contentMap.hanChars === 0 ? 0 : Math.round((overlappedHanChars / contentMap.hanChars) * 1000) / 10,
    };
}
