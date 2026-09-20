// lib/clone.js — 「克隆为模板」的共享核心（工具面与 REST 面板各接一头）。
//
// 为什么抽出来：novel_clone_project 的克隆逻辑原本长在工具 execute 里，
// 面板要做「⧉ 克隆」按钮就得走 REST——同一套复制规则不能抄两份
// （抄两份的下场是「工具漏了场景契约、面板漏了语言基因」这种各自漂移）。
//
// io 契约（createFsio 与 createServerFsio 都满足，克隆跨两界复用）：
//   readJson / readText / writeText / writeJson / listNames / appendLine
//   sessionId（可选；工具面自带，REST 面显式传 session 参数）。
//
// 语义（与 0.12.0 工具版一致，别改）：
//   · 章节按版本复制，重建干净的 index 记录（不复用旧记录的脏字段）；
//   · 大纲/细纲按目录实列复制（「已保存未批准」的细纲不在 novel.json 任何索引里）；
//   · 人物卡、世界书、账本、伏笔、术语表、场景契约、语言基因全带走
//     （场景契约与语言基因是「设定」而非「正文」，漏了新书就丢悬念保护与人物口吻）；
//   · 阶段重置 topic、提案清空、熔断计数清空、approvals.outline 置空
//     （必须带 outline 子对象，否则新书 approve 写 novel.approvals.outline[n] 直接 TypeError）；
//   · 归属：显式 session 优先，否则跟 io.sessionId（克隆出的是当前会话的新书）；
//   · 源书不动；审计落**新书**的 audit.jsonl。

import { pathsFor } from './store.js';
import { assertBookName, auditLine } from './fsio.js';

/**
 * 克隆一本书为模板。
 * @returns {{book, from_book, action:'clone', chapters, missing, new_stage, next}}
 *   字段与 novel_clone_project 的 output schema 对齐（additionalProperties:false，别加字段）。
 */
export async function cloneProject(io, { fromBook, newBook, title, session = null, actor = 'agent' } = {}) {
    const from = assertBookName(fromBook);
    const to = assertBookName(newBook);
    if (from === to) throw new Error('源与目标书目不能相同');
    const sp = pathsFor(from);
    const dp = pathsFor(to);
    if ((await io.readJson(dp.meta)) !== null) throw new Error(`目标书目已存在：「${to}」`);
    const src = await io.readJson(sp.meta);
    if (src === null) throw new Error(`源书目不存在：「${from}」`);

    let missing = 0; let chapters = 0;

    // 章节文件（按版本）——重建干净的 index 记录
    const newChapters = {};
    for (const [k, rec] of Object.entries(src.chapters ?? {})) {
        const files = [];
        for (const f of rec.files ?? []) {
            if (!f.file.startsWith(`${from}/`)) { missing += 1; continue; }
            const content = await io.readText(f.file);
            if (content === null) { missing += 1; continue; }
            const toPath = f.file.replace(`${from}/`, `${to}/`);
            await io.writeText(toPath, `${String(content).trimEnd()}\n`, 'create');
            files.push({ version: f.version, file: toPath });
            chapters += 1;
        }
        if (files.length > 0) {
            const byDesc = [...files].sort((a, b) => b.version - a.version);
            const latestFile = byDesc[0].file;
            const content = await io.readText(latestFile);
            newChapters[k] = {
                title: rec.title,
                versions: files.map((f) => f.version).sort((a, b) => a - b),
                files,
                latest: byDesc[0].version,
                path: latestFile,
                chars: content === null ? 0 : content.replace(/\s/g, '').length,
                // summary 缺省补 ''：源书若是 REST 面板存过章的（summary 键缺失），
                // 这里原样透传会克隆出一本同样缺 summary 的新书 → 下次 status/repair
                // 输出 summary:undefined，宿主 lossless JSON 拒收整次调用（真机已复现）
                summary: rec.summary ?? '',
                updatedAt: new Date().toISOString(),
            };
        }
    }

    const novel = {
        title: title || to,
        genre: src.genre ?? '未分类',
        logline: src.logline ?? '',
        // 克隆出的是**当前会话的新书**：归属跟会话走，不跟着源书走。
        sessions: [session ?? io.sessionId ?? null].filter(Boolean),
        stage: 'topic',       // 九阶段起点（lib/phases.js）
        phases: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        approvals: { outline: {} },
        chapters: newChapters,
        cast: [...(src.cast ?? [])],
        proposals: [],
        gateFailures: {},
    };

    // 大纲
    const bookOutline = await io.readText(sp.bookOutline);
    if (bookOutline !== null) await io.writeText(dp.bookOutline, bookOutline, 'create');
    // 细纲按目录实列复制（listDir）：「已保存未批准」的细纲不在 novel.json 任何索引里，
    // 靠 meta 反推会漏；目录才是 ground truth。
    for (const name of await io.listNames(sp.outlineDir)) {
        const c = await io.readText(`${sp.outlineDir}/${name}`);
        if (c !== null) await io.writeText(`${dp.outlineDir}/${name}`, c, 'create');
    }
    // 人物卡
    for (const name of src.cast ?? []) {
        const card = await io.readText(sp.character(name));
        if (card !== null) await io.writeText(dp.character(name), card, 'create');
    }
    // 世界书/账本/伏笔/术语表 + 场景契约/语言基因
    for (const [fromPath, toPath] of [
        [sp.worldbook, dp.worldbook], [sp.facts, dp.facts], [sp.foreshadows, dp.foreshadows], [sp.glossary, dp.glossary],
        [sp.sceneContracts, dp.sceneContracts], [sp.voices, dp.voices],
    ]) {
        const content = await io.readText(fromPath);
        if (content !== null) await io.writeText(toPath, content, 'create');
    }
    await io.writeJson(dp.meta, novel, 'create');
    // 审计落新书的 audit.jsonl：这是「谁克隆的」唯一证据（工具=agent，面板=user）。
    try {
        await io.appendLine(dp.audit, auditLine('project/clone', { from, to, chapters }, actor));
    } catch { /* 审计失败不阻断克隆本体（旧书可能没有 .novel 目录且 io 无 mkdir 能力） */ }
    return { book: to, from_book: from, action: 'clone', chapters, missing, new_stage: 'topic', next: `克隆完成：《${novel.title}》已就绪（阶段重置 topic，提案与熔断计数已清空）` };
}
