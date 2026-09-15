// lib/briefing.js — 写前上下文包的组装（供给侧）。
//
// 从 novel_briefing 工具里抽出来，因为现在有**第二个消费者**：D2 并发批量起草。
// 批量起草的每一章都要一份上下文包，若各写一份，场景契约裁剪（B3）、语言基因卡（E3）、
// 悬念洗白这些保护就会在批量路径上悄悄失效 —— 那正是并发最危险的地方。
//
// 一句话：**上下文包的组装只有一个实现**。

import { pathsFor } from './store.js';
import { buildContextPack, matchWorldEntries, renderPack } from './contextpack.js';
import { factsDigest, foreshadowDigest, overdueForeshadows } from './ledger.js';
import { termsDigest } from './glossary.js';
import { extractAnchors, styleFingerprintLine } from './style.js';
import { contractFor, resolveSceneCast, renderContractSection, contractDigest, scrubHiddenNames } from './scene-contract.js';
import { normalizeVoice, renderVoiceCard } from './voice.js';

/**
 * 组装第 n 章的写前上下文包。
 *
 * @param config.scanTopK / config.contextBudgetChars 生效
 * @param io     fsio
 * @param p      pathsFor(book)（缺省时按 book 现算）
 * @param novel  novel.json
 * @param n      章号
 * @param castNames 显式指定出场人物；缺省用工程 cast 前 8
 * @returns {chapter, sections, totalChars, dropped, rendered, warnings, contract, hiddenCount, droppedCast, voiceCount, contractDigest}
 */
export async function buildBriefing({ config, io, book, novel, n, castNames = null, p = pathsFor(book) }) {
    if (!Number.isInteger(n) || n < 1) throw new Error('chapter 必须是正整数');
    const warnings = [];

    const chapterOutline = (await io.readText(p.chapterOutline(n))) ?? '';
    if (chapterOutline === '') warnings.push(`第${n}章细纲不存在——写章会被门禁拦下，先 novel_outline save_chapter`);
    const bookOutline = (await io.readText(p.bookOutline)) ?? '';
    if (bookOutline === '') warnings.push('全书大纲不存在（novel_outline save_book）');

    // 场景契约（B3）：有契约时只注入出场人物、按白名单挑世界书条目。
    const contracts = (await io.readJson(p.sceneContracts)) ?? {};
    const contract = contractFor(contracts, n);
    const requestedCast = castNames !== null ? castNames : (novel.cast ?? []).slice(0, 8);
    const sceneCast = resolveSceneCast({ contract, cast: requestedCast });
    const names = sceneCast.inject;
    if (sceneCast.contradictions.length > 0) {
        warnings.push(`场景契约里「${sceneCast.contradictions.join('、')}」同时是出场与隐藏——按隐藏优先处理，本章不注入`);
    }
    if (contract !== null && sceneCast.dropped.length > 0) {
        warnings.push(`场景契约生效：只注入 ${names.length} 人的卡（未注入：${sceneCast.dropped.join('、')}）——需要谁出场就 novel_scene save 更新契约`);
    }
    if (names.length === 0) warnings.push('未指定出场人物且工程 cast 为空——人物卡不会被注入');
    const castCards = [];
    for (const name of names) {
        const card = await io.readText(p.character(name));
        if (card === null) warnings.push(`人物卡缺失：${name}（novel_character save）——该人物将以无卡状态写章`);
        else castCards.push({ name, card });
    }

    // 语言基因卡（E3）：防「千人一腔」的供给侧——有卡就结构化注入，没建的不强求。
    const voicesRaw = (await io.readJson(p.voices)) ?? {};
    const voiceCards = [];
    for (const name of names) {
        const card = renderVoiceCard(name, normalizeVoice(voicesRaw[name]));
        if (card !== '') voiceCards.push({ name, card });
    }
    if (voiceCards.length === 0 && names.length >= 2) {
        warnings.push(`本章 ${names.length} 人同台，但没有语言基因卡——多角色对话容易「千人一腔」（novel_character voice 建卡）`);
    }

    const entries = (await io.readJson(p.worldbook)) ?? [];
    let worldEntries;
    if (contract !== null && contract.settings.length > 0) {
        // 契约白名单：只注入点名的条目（省预算、防无关设定干扰）
        const missing = contract.settings.filter((id) => !entries.some((e) => e.id === id));
        if (missing.length > 0) warnings.push(`契约世界书白名单里的 ${missing.join('、')} 不存在（novel_worldbook list 查 id）`);
        worldEntries = entries.filter((e) => contract.settings.includes(e.id));
    } else {
        worldEntries = matchWorldEntries(entries, [chapterOutline, names.join('、'), novel.logline ?? '']);
    }
    const facts = (await io.readJson(p.facts)) ?? [];
    const glossaries = (await io.readJson(p.glossary)) ?? [];
    const foreshadows = (await io.readJson(p.foreshadows)) ?? [];

    const prev = novel.chapters?.[String(n - 1)];
    let prevTail = '';
    if (prev?.path !== undefined) {
        const prevText = await io.readText(prev.path);
        if (prevText !== null) prevTail = prevText.trimEnd().slice(-600);
    } else if (n > 1) {
        warnings.push(`第${n - 1}章尚未写——没有上一章结尾可衔接`);
    }

    // 锚包：从最近已写的 3 章里挑味道样本（对话段/叙述段各一），有基线再附指纹行。
    let anchors = [];
    let fingerprint = '';
    if (n > 1) {
        const recentTexts = [];
        for (let k = n - 1; k >= Math.max(1, n - 3) && recentTexts.length < 3; k -= 1) {
            const rec = novel.chapters?.[String(k)];
            if (rec?.path === undefined) continue;
            const t = await io.readText(rec.path);
            if (t !== null) recentTexts.push(t);
        }
        anchors = extractAnchors(recentTexts);
        const baselineRaw = await io.readJson(p.styleBaseline);
        if (baselineRaw?.baseline !== undefined) fingerprint = styleFingerprintLine(baselineRaw.baseline);
    }

    const summaries = Object.entries(novel.chapters ?? {})
        .filter(([k]) => Number(k) < n)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([k, c]) => `第${k}章《${c.title}》：${c.summary ?? ''}`);

    const overdue = overdueForeshadows(foreshadows, n);
    if (overdue.length > 0) {
        warnings.push(`伏笔超期未回收：${overdue.map((f) => `${f.id}（预计第${f.plan}章收，第${f.chapter}章埋）`).join('、')}——考虑本章或近期回收，别让读者忘了`);
    }

    const promise = (await io.readText(p.promise)) ?? '';

    const pack = buildContextPack({
        chapter: n,
        chapterOutline,
        bookOutline,
        promise,
        sceneContract: renderContractSection(contract),
        castCards,
        voiceCards,
        worldEntries,
        factsDigest: factsDigest(facts, names),
        glossaryDigest: termsDigest(glossaries, 40),
        foreshadowDigest: foreshadowDigest(foreshadows, 8, n),
        prevTail,
        anchors,
        fingerprint,
        summaries,
        budget: config.contextBudgetChars,
    });
    // 派生泄漏兜底：账本摘要/伏笔台账/前文摘要里也可能躺着隐藏人物的痕迹（实测踩过——
    // 契约的 notes 里写「X 的身份本章不揭」就等于把名字送进上下文）。
    const scrubbed = scrubHiddenNames(pack.sections, sceneCast.hidden);
    if (scrubbed.scrubbed > 0) {
        warnings.push(`悬念保护：已屏蔽 ${scrubbed.scrubbed} 行涉及未登场人物的上下文（档案/账本/摘要中的痕迹一并擦除）`);
    }
    const sections = scrubbed.sections;
    // 章节字数标准（网文连载常规）：模型天然爱写短，目标必须明说——
    // 机审下限只是拒绝线，这段才是「照着写」的目标。放在预算统计之前，让 totalChars 如实。
    sections.push({
        name: '本章字数目标',
        content: `单章 ${config.minChapterChars}–${config.maxChapterChars} 字，目标 ${Math.round((config.minChapterChars + config.maxChapterChars) / 2 / 100) * 100} 字左右（正常网络小说连载单章的篇幅）。不足下限会被机审直接退稿；字数不够就把细纲里的场景写细写透（动作、环境、对话拉满），不要注水凑字；超过上限主动收在章末钩子处。`,
    });
    const totalChars = sections.reduce((acc, sec) => acc + sec.content.length + sec.name.length + 4, 0);

    return {
        chapter: n,
        sections,
        totalChars,
        dropped: pack.dropped,
        rendered: renderPack({ sections }),
        warnings,
        chapterOutline,
        contract,
        hiddenCount: contract === null ? 0 : contract.hidden.length,
        contractDigest: contract === null ? null : contractDigest(contract),
        droppedCast: sceneCast.dropped,
        voiceCount: voiceCards.length,
        castNames: names,
    };
}
