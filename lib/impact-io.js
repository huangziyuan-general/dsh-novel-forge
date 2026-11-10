// lib/impact-io.js — 章节影响分析的书稿 IO 适配层。

import { computeBasis, sha256 } from './basis.js';
import { contractFor } from './scene-contract.js';
import { chapterRelPath } from './store.js';
import { buildImpactReport, captureSourceRefs } from './impact.js';

export async function chapterSourceRefs(io, p, book, novel, chapter, content, snapshots = {}) {
    const facts = snapshots.facts ?? ((await io.readJson(p.facts)) ?? []);
    const foreshadows = snapshots.foreshadows ?? ((await io.readJson(p.foreshadows)) ?? []);
    let basis = snapshots.basis ?? null;
    if (basis === null) {
        const outline = (await io.readText(p.chapterOutline(chapter))) ?? '';
        const worldbook = (await io.readJson(p.worldbook)) ?? [];
        const contracts = (await io.readJson(p.sceneContracts)) ?? {};
        basis = computeBasis({ outline, contract: contractFor(contracts, chapter), worldbook, facts });
    }
    const previousRecord = novel.chapters?.[String(chapter - 1)] ?? null;
    let previous = null;
    if (previousRecord) {
        const rel = chapterRelPath(previousRecord, book);
        const previousContent = rel === null ? null : await io.readText(rel);
        previous = { chapter: chapter - 1, version: previousRecord.latest, content: previousContent };
    }
    return captureSourceRefs({ basis, facts, foreshadows, previous, content });
}

export async function chapterImpactReport(io, p, book, novel, chapter) {
    const contentHashes = {};
    const outlines = {};
    const later = Object.keys(novel.chapters ?? {}).map(Number)
        .filter((n) => Number.isInteger(n) && n >= chapter).sort((a, b) => a - b);
    for (const n of later) {
        const rec = novel.chapters[String(n)];
        const rel = chapterRelPath(rec, book);
        const text = rel === null ? null : await io.readText(rel).catch(() => null);
        if (text !== null) contentHashes[String(n)] = sha256(text);
        const outline = await io.readText(p.chapterOutline(n)).catch(() => null);
        outlines[String(n)] = { exists: outline !== null, hash: outline === null ? null : sha256(outline) };
    }
    return buildImpactReport(novel, chapter, { contentHashes, outlines });
}
