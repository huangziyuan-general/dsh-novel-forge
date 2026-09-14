// lib/continuity-io.js — 一致性校验的 io 装配层（把磁盘读成纯函数要的输入）。
//
// 为什么要单独一层：`lib/continuity.js` 是纯函数（可单测、零 token），但工具层
// （novel_audit）与 REST 层（面板「一致性」区块）都要喂它同样的数据 —— 装配逻辑
// 只写一处，否则两边迟早漂移（apply 那次踩过的坑）。

import { deathTimeline } from './continuity.js';

/**
 * @param io     createFsio / createServerFsio 实例
 * @param p      pathsFor(book)
 * @param novel  novel.json
 * @param opts.withTexts 是否读正文（死亡再现扫描用；无死亡记录时自动不读）
 * @returns validateContinuity 的入参
 */
export async function loadContinuityInputs(io, p, novel, { withTexts = true } = {}) {
    const facts = (await io.readJson(p.facts)) ?? [];
    const foreshadows = (await io.readJson(p.foreshadows)) ?? [];

    // 只读「最早死亡章之后」的正文 —— 死亡再现不可能出现在死亡之前，省掉全书 IO。
    const deaths = deathTimeline(facts);
    let minDeath = null;
    for (const d of deaths.values()) {
        if (minDeath === null || d.chapter < minDeath) minDeath = d.chapter;
    }

    const nums = Object.keys(novel?.chapters ?? {}).map(Number)
        .filter((n) => Number.isInteger(n) && n >= 1).sort((a, b) => a - b);

    const texts = {};
    const outlines = {};
    const existingFiles = new Set();
    const castCards = {};

    for (const n of nums) {
        const rec = novel.chapters[String(n)];
        if (typeof rec?.path === 'string' && rec.path !== '') {
            const st = await io.stat(rec.path);
            if (st !== null && st.info?.type === 'file') existingFiles.add(rec.path);
        }
        if (withTexts && minDeath !== null && n > minDeath) {
            const t = await io.readText(rec.path);
            if (t !== null) texts[n] = t;
        }
        // 闪回豁免判定需要细纲（没有细纲时 continuity 会回退看正文开头窗口）
        const o = await io.readText(p.chapterOutline(n));
        if (o !== null) outlines[n] = o;
    }

    for (const name of novel?.cast ?? []) {
        if (typeof name !== 'string' || name.trim() === '') continue;
        const st = await io.stat(p.character(name));
        castCards[name] = st !== null && st.info?.type === 'file';
    }

    return { novel, facts, foreshadows, texts, outlines, existingFiles, castCards };
}
