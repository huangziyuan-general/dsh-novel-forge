// lib/tag-cache.js — 打标的「内容指纹缓存」（纯函数，零 IO）。
//
// 要消灭的故障（**已复现**，不是理论风险）：
//   给第 2 段正文打了标签「雪夜 决斗」→ 下次 build 之后，**第 1、3、4 段也全带上了
//   「雪夜 决斗」**。检索因此会召回根本不写决斗的段落——标签增强反而在制造误召回。
//
//   根因是三处相乘：
//     ① 标签继承是**章级**的（`SELECT DISTINCT ch, tags` → Map<ch, tags> → 整章共用一份）；
//     ② 块的指纹 `hashChunk(正文\0标签\0语料)` **含标签**——打标这个动作会改掉块的指纹；
//     ③ 增量索引靠「指纹没变」跳过 → 指纹一变整章判为「更新」，于是整章被那份章级标签重写。
//
// 本模块给出的正解（对齐竞品 A 的「节点级缓存指纹」）：
//   **标签是「块文本」的函数，不是「章」或「块序号」的属性。**
//   同一个指纹 → 同一组标签 → 同样的输入不重复调模型。
//
// 为什么这个方向对：
//   · 块的序号会因为正文改写而**移位**（第 2 段变短，第 3 段顶上来）——标签跟着序号走
//     必然张冠李戴；跟着**文本**走则永远对得上。
//   · 标签本来就是模型的输出，同样的输入本就该得到同样的输出——这是「缓存」而非「猜测」。
//   · 重建索引（删库重跑 build）、书里重复的段落、跨章相似的段落，都不再重复调模型。
//
// 纯函数（AGENTS.md 不变量 2）：本模块不碰 io、不取钟（时间戳由调用方传入）。

import { sha256 } from './basis.js';

/** 缓存格式版本——判据变了就 +1（老记录按版本分别处理，不静默套用新口径）。 */
export const TAG_CACHE_VERSION = 1;

/**
 * 标签缓存的指纹：**块文本**的 sha256 前 16 位。
 *
 * 口径与 `lib/basis.js` 的依据指纹一致（同一份哈希实现，不另起炉灶——
 * AGENTS.md「同一实现只留一份」）。
 *
 * 为什么指纹只吃文本、不吃语料种类：标签是「这段文字写的是什么」的描述，与它来自
 * 本书正文还是外部参考素材无关。同样的文字该有同样的标签——这是**语义正确**，不是污染。
 * 语料隔离由 `searchChunks` 的白名单独立执行（不靠标签区分），两件事互不干涉。
 */
export function tagFingerprint(text) {
    return sha256(text);
}

/**
 * 给一批待打标的块排计划。
 *
 * 三种去向：
 *   hits   缓存命中 → 直接写回，**一次模型调用都不花**；
 *   misses 未命中、且这段文本在本批里唯一 → 要调模型；
 *   dupes  未命中、但同样的文本本批里已有代表 → 等代表块打完，**复用它的标签**，
 *          不重复调模型（书里重复的段落、跨章相似段落走这条）。
 *
 * @param rows  [{ ch, seq, text }]
 * @param cache Map<fp, tags>
 * @returns {{hits: Array, misses: Array, dupes: Array}}
 */
export function planAnnotations(rows, cache) {
    const list = Array.isArray(rows) ? rows : [];
    const store = cache instanceof Map ? cache : new Map();
    const hits = [];
    const misses = [];
    const dupes = [];
    const seen = new Set();
    for (const row of list) {
        const fp = tagFingerprint(row?.text ?? '');
        const cached = store.get(fp);
        // 空标签不算命中：宁可多调一次模型，也不要把「有键但没值」当成可用标签。
        if (typeof cached === 'string' && cached !== '') {
            hits.push({ row, fp, tags: cached });
            continue;
        }
        if (seen.has(fp)) {
            dupes.push({ row, fp });
            continue;
        }
        seen.add(fp);
        misses.push({ row, fp });
    }
    return { hits, misses, dupes };
}

/**
 * 按内容指纹给块回填标签（建索引时用）。
 *
 * 为什么建索引也要回填：块的正文一旦改动，重建索引会重写这一块——**标签必须跟着回来**，
 * 否则每次改一个字都要重新打标（几百次模型调用）。回填源是内容指纹缓存，
 * 所以「这段文字 → 这组标签」的绑定在任何重建后都还在。
 *
 * @param chunks [{ seq, text, tags, ... }]
 * @param cache  Map<fp, tags>
 * @returns 新数组（不改动入参）
 */
export function applyCachedTags(chunks, cache) {
    const list = Array.isArray(chunks) ? chunks : [];
    const store = cache instanceof Map ? cache : new Map();
    return list.map((c) => {
        const tags = store.get(tagFingerprint(c?.text ?? ''));
        return (typeof tags === 'string' && tags !== '') ? { ...c, tags } : { ...c };
    });
}

/**
 * 判断一章的旧标签是不是被污染的（**同 tag 集广播**）。
 *
 * 老实现的章级继承会把「一章里某一组标签」盖到该章的**所有**块上——于是重建后
 * 整章的块标签一模一样。这份「整齐」正是污染的签名：正常情况下各块标签各不相同
 * （各段写的是不同的事）。
 *
 * @param rows 该章所有块的 [{ text, tags }]（含未打标的空标签块）
 * @returns { polluted: boolean, tagged: number, distinct: number }
 */
export function legacyPollution(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const tagged = list.filter((r) => typeof r?.tags === 'string' && r.tags !== '');
    const distinct = new Set(tagged.map((r) => r.tags)).size;
    // 整章的块（含没打标的）共享同一组标签 → 那组标签是从别处广播来的，不是这一章的。
    const allSame = list.length > 1 && list.every((r) => String(r?.tags ?? '') === String(list[0]?.tags ?? '')) && String(list[0]?.tags ?? '') !== '';
    return { polluted: allSame, tagged: tagged.length, distinct };
}
