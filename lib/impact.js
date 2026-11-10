// lib/impact.js — 章节来源指纹与前章影响分析（纯函数，零 IO）。

import { factsEntries, sha256, stableStringify } from './basis.js';

export const SOURCE_REFS_VERSION = 1;

function cleanBasis(basis) {
    if (!basis || typeof basis !== 'object') return null;
    return {
        version: Number.isInteger(basis.version) ? basis.version : null,
        digest: typeof basis.digest === 'string' ? basis.digest : null,
        sources: Array.isArray(basis.sources)
            ? basis.sources.filter((s) => typeof s?.type === 'string' && typeof s?.hash === 'string')
                .map((s) => ({ type: s.type, hash: s.hash }))
            : [],
    };
}

/** 记录本章落盘时实际使用的来源；缺输入就留 null，不伪造确定结论。 */
export function captureSourceRefs({ basis = null, facts = null, foreshadows = null, previous = null, content = '' } = {}) {
    const previousContent = previous && typeof previous.content === 'string' ? previous.content : null;
    return {
        version: SOURCE_REFS_VERSION,
        basis: cleanBasis(basis),
        factsSig: Array.isArray(facts) ? factsEntries(facts) : null,
        foreshadowsHash: Array.isArray(foreshadows) ? sha256(stableStringify(foreshadows)) : null,
        previousChapter: previous && Number.isInteger(previous.chapter)
            ? {
                chapter: previous.chapter,
                version: Number.isInteger(previous.version) ? previous.version : null,
                contentHash: previousContent === null ? null : sha256(previousContent),
            }
            : null,
        contentHash: sha256(content),
    };
}

function dependencyChanged(ref, previousRecord, contentHashes) {
    if (!ref || !previousRecord) return { changed: false, reasons: [] };
    const reasons = [];
    if (Number.isInteger(ref.version) && ref.version !== previousRecord.latest) {
        reasons.push(`所据前章为 v${ref.version}，现在是 v${previousRecord.latest ?? '?'}`);
    }
    const actualHash = contentHashes?.[String(ref.chapter)] ?? previousRecord.sourceRefs?.contentHash ?? null;
    if (typeof ref.contentHash === 'string' && typeof actualHash === 'string' && ref.contentHash !== actualHash) {
        reasons.push('所据前章正文哈希已变化');
    }
    return { changed: reasons.length > 0, reasons };
}

/**
 * 分析修改 chapter 后，哪些已落后章仍引用旧前章。
 * direct = 直接引用被修改章；transitive = 引用链更下游。缺 refs 的章进 unknown。
 */
export function buildImpactReport(novel, chapter, { contentHashes = {}, outlines = {} } = {}) {
    const affected = [];
    const unknown = [];
    const affectedSet = new Set();
    const unknownSet = new Set();
    const records = novel?.chapters ?? {};
    const later = Object.keys(records).map(Number)
        .filter((n) => Number.isInteger(n) && n > chapter).sort((a, b) => a - b);
    for (const n of later) {
        const rec = records[String(n)];
        const refs = rec?.sourceRefs;
        const previousRef = refs?.previousChapter;
        if (!previousRef || !Number.isInteger(previousRef.chapter)) {
            unknownSet.add(n);
            unknown.push({ chapter: n, title: rec?.title ?? `第 ${n} 章`, reason: '本章没有前章来源记录，无法判定是否受影响' });
            continue;
        }
        const previousRecord = records[String(previousRef.chapter)];
        const drift = dependencyChanged(previousRef, previousRecord, contentHashes);
        const inherited = affectedSet.has(previousRef.chapter);
        const inheritedUnknown = unknownSet.has(previousRef.chapter);
        if (!previousRecord && !inherited) {
            unknownSet.add(n);
            unknown.push({ chapter: n, title: rec?.title ?? `第 ${n} 章`, reason: `来源记录指向的第 ${previousRef.chapter} 章不存在，无法判定是否受影响` });
            continue;
        }
        if (!drift.changed && !inherited && inheritedUnknown) {
            unknownSet.add(n);
            unknown.push({ chapter: n, title: rec?.title ?? `第 ${n} 章`, reason: `依赖链经过无法判定的第 ${previousRef.chapter} 章，本章也无法判定是否受影响` });
            continue;
        }
        if (!drift.changed && !inherited) continue;
        const kind = previousRef.chapter === chapter ? 'direct' : 'transitive';
        const reasons = [...drift.reasons];
        if (inherited) reasons.push(`依赖链经过已受影响的第 ${previousRef.chapter} 章`);
        affectedSet.add(n);
        affected.push({
            chapter: n,
            title: rec?.title ?? `第 ${n} 章`,
            kind,
            via: previousRef.chapter,
            reasons,
            outline: outlines[String(n)] ?? { exists: null, hash: null },
        });
    }
    // unknown 不是「没影响」：存量章的 sourceRefs 是本版本起才在保存时写入的。
    // 返回结构不改（affected/unknown/checked/notice），但 notice 必须把这一点说死，
    // 否则用户会把「无从判定」读成「没影响」。
    const notice = later.length === 0
        ? '未发现后章，无需判定。'
        : unknown.length > 0
            ? (affected.length > 0
                ? `影响判定只覆盖带来源记录的章（来源记录自本版本起在保存章节时写入）。另有 ${unknown.length} 章缺少来源记录或依赖链不可判定——不代表没有影响。`
                : `本次没有可确认的受影响章；但有 ${unknown.length} 章缺少来源记录或依赖链不可判定（多为本版本之前保存的章）——不能视为「没影响」。`)
            : (affected.length > 0
                ? '影响清单只提示复核，不会自动重写或定稿后章。'
                : `已核对 ${later.length} 个后章，未发现受影响章。`);
    return {
        chapter,
        affected,
        unknown,
        checked: later.length,
        notice,
    };
}
