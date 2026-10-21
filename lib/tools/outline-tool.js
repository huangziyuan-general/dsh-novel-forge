// lib/tools/outline-tool.js — novel_outline（全书大纲 / 分章细纲 / 细纲批准门禁）。
// 从 project-tools.js 按工具拆出；schema 与描述原样保留。

import { defineTool } from './define-tool.js';
import { pathsFor, platformLimitsText, effectiveCharConfig, charConfigSourceLabel } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { audit, requireBook, saveBook, textBlock } from './common.js';
import { clearBreaker, breakerState } from '../circuit-breaker.js';
import { createHash } from 'node:crypto';
import { outlineCapacityEstimate, sceneCharBudget, outlineContractCheck, SCENE_BASE_CHARS, SCENE_BEAT_CHARS } from '../gate-metrics.js';
import { volumeSection, outlineDivergence } from '../gate.js';
import { chapterCharTarget } from '../audit.js';
import { contractFor } from '../scene-contract.js';

export function defineOutlineTool(ctx, config) {
    // 字数目标由 config 现算（单一真相：细纲 / 写前简报 / 批量起草共用 chapterCharTarget）。
    const charsTarget = chapterCharTarget(config);
    return defineTool({
        name: 'novel_outline',
        description: `大纲与细纲：save_book 存全书大纲；save_chapter 保存第N章细纲；approve 批准该章细纲——未批准的章节 novel_write_chapter 会直接拒绝（阶段门禁）。`
            + `本章字数默认 ${config.minChapterChars}–${config.maxChapterChars} 字、目标 ${charsTarget} 字左右——细纲里请照写这个数字，不要自己另定（自定的目标与机审下限打架时以机审为准）；**本书若设了自定义区间或投放平台，以 save_chapter 回执「本章字数」行给的数字为准**（它按「本书自定义 > 平台口径 > 插件默认」现算，与写章门禁同源）。`
            + `字数区间的来源：用户在锻炉面板或 novel_project action=chars 设的每章字数（最优先）；没设则用 novel_project action=platform 选的平台（${platformLimitsText()}）；都没设才是上面的默认值。建议落在区间中段、别贴顶线（超顶线是完读率杀手，会被打回）。`
            + `细纲要写得够：只给少量场景会锁死全章字数上限（单场景约 480 字），场景数连下限都撑不到时 save_chapter 会直接驳回并要求拆场景。`
            + `新建的书默认 outlineContract=strict：细纲必须含「## 本章必写场景」段（行式「- 标题：描述」，每场景 3–5 个拍；**描述必须是正文里逐字出现的短语**——「（拍：…）」括号内不参与场景匹配，细节写拍里、摘要写「正文里就有」的句子），缺段/有段无条目直接驳回；存量旧书 warn 档不拒稿但会留痕提示补段。`,
        parameters: {
            action: { type: 'string', required: true, enum: ['save_book', 'save_chapter', 'approve'], description: 'save_book 存全书大纲；save_chapter 存第N章细纲；approve 批准第N章细纲。' },
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', description: 'save_chapter / approve 必填：章号。' },
            outline: { type: 'string', description: 'save_book / save_chapter 必填：Markdown 正文。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    chapter: { type: 'integer' },
                    path: { type: 'string' },
                    approved: { type: 'boolean' },
                    note: { type: 'string' },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            // L11 修复：save_book / save_chapter 此前不查书是否存在——对不存在的书
            // 调用会静默写出幽灵目录。requireBook 先行（approve 本来就有）。
            const { novel } = await requireBook(io, book);
            // 本章字数区间按本书档位现算（自定义 > 平台 > 插件默认）：容量门禁与逐场景预算
            // 必须和写章链用同一个数字，否则细纲会照默认 2000 下限被要求拆场景，
            // 而实际门禁下限是 1500（或用户自定的值）——两处相反结论的另一张脸。
            const { config: effCfg, source: effSource } = effectiveCharConfig(config, novel);
            const effTarget = chapterCharTarget(effCfg);

            if (args.action === 'save_book') {
                if (!args.outline || args.outline.trim() === '') throw new Error('save_book 需要 outline 正文');
                const rel = p.bookOutline;
                await io.writeText(rel, `${args.outline.trim()}\n`, 'auto');
                await audit(io, p, 'outline/save_book', { chars: args.outline.length });
                return { book, action: 'save_book', path: rel };
            }
            if (!Number.isInteger(args.chapter) || args.chapter < 1) throw new Error('save_chapter / approve 需要正整数 chapter');
            if (args.action === 'save_chapter') {
                if (!args.outline || args.outline.trim() === '') throw new Error('save_chapter 需要 outline 正文（含本章出场人物与必须覆盖的情节点）');
                // 字数门禁前移（0.18.0 重标口径）：按**声明量**（场景数 + 拍数）估算本章
                // 首稿能写多少字，撑不到下限就驳回，并点名「哪个场景只有一拍」。
                // 为什么换口径：旧判据「场景数×480」在真机 7 本 151 章上误驳率 63%
                // （拦 35 章、22 章实际首稿 ≥2000），而且药方打错靶子——场景数对首稿字数
                // 的解释力 R²=0.033，4 场景的细纲实测 median 2087 字。换成
                // 「场景数×300 + 拍×160」后精确率 87%（拦 15 误驳 2）。
                const est = outlineCapacityEstimate({ outline: args.outline, minChars: effCfg.minChapterChars });
                if (est !== null && est.estimated < effCfg.minChapterChars) {
                    await audit(io, p, 'outline/rejected_capacity', { chapter: args.chapter, estimated: est.estimated, beats: est.beats });
                    throw new Error(
                        `第${args.chapter}章细纲的声明量撑不到机审下限：${est.sceneCount} 个必写场景、共 ${est.beats} 拍，`
                        + `按每场景约 ${SCENE_BASE_CHARS} 字 + 每拍约 ${SCENE_BEAT_CHARS} 字估算只有约 ${est.estimated} 字`
                        + `（下限 ${effCfg.minChapterChars}、本章目标 ${effTarget}，区间出处：${charConfigSourceLabel(effSource, novel)}）。还差约 ${est.neededBeats} 拍——`
                        + '**加拍比加场景有用**：'
                        + (est.thinScenes.length > 0
                            ? `这些场景只有一拍，先把它们写透：${est.thinScenes.map((s) => `第${s.no}个「${s.title}」`).join('、')}。`
                            : '现有场景都偏薄，逐个补到 3–5 拍（动作、环境、对话各写一条）。')
                        + '补完再 save_chapter。',
                    );
                }
                // 「## 本章必写场景」契约段的书级策略：容量门禁与契约指标（场景覆盖率/
                // 禁项拒绝）全部「有段才算」——无段细纲此前是**静默旁路**（真机连载本
                // 实证：972 字细纲、4 个场景，结构性写不到 2000 还能被批准）。
                // 按书级 outlineContract 分档：strict（init/import/clone 新建的书默认）
                // 无段或有段无条目直接驳回并教格式；warn（存量书缺省）不拒稿但 note
                // 指路 + 审计留痕——旁路从静默变显式，留痕出现率决定存量书要不要升 strict。
                const contract = outlineContractCheck(args.outline);
                const contractMode = novel.outlineContract === 'strict' ? 'strict' : 'warn';
                let contractNote;
                if (!contract.present) {
                    if (contractMode === 'strict') {
                        await audit(io, p, 'outline/rejected_contract', { chapter: args.chapter, reason: 'no_section' });
                        throw new Error(
                            `本书 outlineContract=strict：细纲必须带「## 本章必写场景」段——每行一条「- 标题：描述」，每场景给足 3–5 个拍（动作/环境/对话要点）。`
                            + `没有这段，容量门禁与场景覆盖率/禁项指标对本章全部失效（本章字数会在结构上失控）。补上后重新 save_chapter。`,
                        );
                    }
                    await audit(io, p, 'outline/no_contract_section', { chapter: args.chapter });
                    contractNote = `细纲没有「## 本章必写场景」段（本书 outlineContract=warn，不拒稿但留痕）：容量门禁与场景覆盖率/禁项指标对本章不生效。建议补一段（每行「- 标题：描述」，每场景 3–5 拍）。`;
                } else if (contract.sceneCount === 0) {
                    if (contractMode === 'strict') {
                        await audit(io, p, 'outline/rejected_contract', { chapter: args.chapter, reason: 'unparsed' });
                        throw new Error(
                            `本书 outlineContract=strict：「本章必写场景」段存在但解析不出条目——每行要写成「- 标题：描述」的列表项，整段散文不算。修好格式后重新 save_chapter。`,
                        );
                    }
                    await audit(io, p, 'outline/contract_unparsed', { chapter: args.chapter });
                    contractNote = `「本章必写场景」段存在但解析不出条目（本书 outlineContract=warn，不拒稿但留痕）：每行要「- 标题：描述」列表项，契约指标才生效。`;
                }
                const rel = p.chapterOutline(args.chapter);
                await io.writeText(rel, `${args.outline.trim()}\n`, 'auto');
                await audit(io, p, 'outline/save_chapter', { chapter: args.chapter, chars: args.outline.length });
                // P2-2（真机导入书监控）：场景契约按章独立——上一章的禁项/隐藏人物到本章
                // 需要「延续则重申、解除则放行」的显式决定，不提醒就退回模型自觉记（违背
                // 「代码强制 > 提示词自觉」主线）。save_chapter 时把上一章契约带出来；
                // 没有上一章契约（第 1 章 / 未声明）则不打扰。
                const notes = [];
                if (args.chapter > 1) {
                    const raw = (await io.readJson(p.sceneContracts)) ?? {};
                    const prev = contractFor(raw, args.chapter - 1);
                    if (prev !== null && (prev.forbidden.length > 0 || prev.hidden.length > 0)) {
                        notes.push(`上一章（第${args.chapter - 1}章）场景契约——禁项：${prev.forbidden.join('、') || '（无）'}；隐藏人物：${prev.hidden.join('、') || '（无）'}。`
                            + '契约按章独立，不会自动延续：仍有效就在本次细纲/场景契约里重申，已解除则无需处理。');
                    }
                }
                if (contractNote !== undefined) notes.push(contractNote);
                // 本章实际生效的字数区间回显一句：描述里的数字只是插件默认（工具注册期
                // 不知道是哪本书），这一行才是「照写进细纲」的那个数——用户改了区间，
                // 模型下一次 save_chapter 就能看到新数字，不必回头翻设置。
                notes.push(`本章字数区间：${effCfg.minChapterChars}–${effCfg.maxChapterChars} 字（目标约 ${effTarget} 字），出处：${charConfigSourceLabel(effSource, novel)}。`
                    + (effSource === 'config' ? '用户可在锻炉面板「本章字数」或 novel_project action=chars 指定本书区间。' : ''));
                // 估算够下限但离目标还远：给**逐场景字数预算**（把「本章 3000 字」翻译成
                // 「这一场写 500 字、约 4 段」）。真机一次过率只有 79%，失败的那 21% 全部
                // 是整章重写 2–3 轮补字数——预算表在细纲阶段就给，比机审驳回后再补省两轮。
                if (est !== null && est.estimated < effTarget) {
                    const budget = sceneCharBudget({ outline: args.outline, target: effTarget, minChars: effCfg.minChapterChars });
                    if (budget !== null) {
                        notes.push(`按声明量估算本章约 ${est.estimated} 字（下限 ${effCfg.minChapterChars} 已过，本章目标 ${effTarget}）——每场景建议字数：`
                            + `${budget.map((b) => `${b.no}「${b.title}」${b.suggested} 字`).join('、')}。写前简报里会再带一次这张表。`);
                    }
                }
                // 0.19.0 大纲一致性：细纲与全书大纲本章所在卷的规划段 2-gram 重合度过低
                // → 可见性警告（不阻断——拐线可能是合理的创作演化）。真机实证：大纲漂移
                // 80 章无人察觉，且「全书大纲开书后从未 save_book 更新」——警告同时提醒
                // 把大纲一起更新（过时的大纲会把写前简报和后续章节继续带偏）。
                try {
                    const bookOutline = await io.readText(p.bookOutline);
                    if (bookOutline !== null) {
                        const vol = volumeSection(bookOutline, args.chapter);
                        if (vol !== null) {
                            const { jaccard, termHitRate } = outlineDivergence(vol, args.outline);
                            // 0.19.1 双判据：2-gram 重合度对「概括 vs 细化」粒度差天然低分
                            // （真机 42 章 12+ 次全误报）——词级命中率（termHitRate）低才说明
                            // 细纲真的没在用本卷的概念词；双低才警告，只报确定异常。
                            if (jaccard < 0.15 && termHitRate < 0.02) {
                                await audit(io, p, 'outline/divergence_warned', { chapter: args.chapter, jaccard, termHitRate });
                                notes.push(`⚠️ 第${args.chapter}章细纲与全书大纲本卷规划的重合度只有 ${jaccard}（词命中率 ${termHitRate}）——确认这是不是主动拐线：`
                                    + `若是有意换线，请用 novel_outline save_book 更新全书大纲（大纲是写前简报的基准，过时的大纲会把后续章节继续带偏）；`
                                    + `若无意拐线，回头对照大纲的卷规划重写细纲。`);
                            }
                        }
                    }
                } catch { /* 大纲一致性是尽力而为的提醒：读不到大纲不打扰主流程 */ }
                return notes.length > 0
                    ? { book, action: 'save_chapter', chapter: args.chapter, path: rel, note: notes.join('\n') }
                    : { book, action: 'save_chapter', chapter: args.chapter, path: rel };
            }
            // approve
            const rel = p.chapterOutline(args.chapter);
            const outlineText = await io.readText(rel);
            if (outlineText === null) throw new Error(`第${args.chapter}章细纲文件不存在：先 save_chapter 再 approve`);
            // 防御：旧版 clone 产物或手工编辑过的 novel.json 可能缺 approvals.outline
            novel.approvals = novel.approvals ?? { outline: {} };
            novel.approvals.outline = novel.approvals.outline ?? {};
            novel.approvals.outline[String(args.chapter)] = true;
            // 熔断解除通道之一：细纲重批＝重新校准设定。⚠️ 校准必须是**真的改了细纲**：
            // 「真的改了」＝与上次 approve 的内容指纹不同（真机连载本实证：微调几个字
            // 的 outline + approve + scene/save 三连，每 3 次驳回刷一次续命，第 91 章
            // 12 驳 6 轮）。没有上次批准记录（首次批准）**同样不算重新校准**——否则
            // 「存一版细纲 → 熔断后补一次 approve」就是一次免费解锁。
            const print = createHash('sha1').update(outlineText, 'utf8').digest('hex');
            novel.approvals.outlinePrints = novel.approvals.outlinePrints ?? {};
            // 0.19.0：批准通道归属——工具链批准恒为 'tool'（面板人工通道写 'panel'）。
            // 看板按它统计「自批占比」：批准人=作者本人是《开局觉醒加特林》大纲漂移的
            // 第一道缺口（168/168 自批），先可见，面板通道后续补。
            novel.approvals.outlineVia = novel.approvals.outlineVia ?? {};
            novel.approvals.outlineVia[String(args.chapter)] = 'tool';
            const prevPrint = novel.approvals.outlinePrints[String(args.chapter)] ?? null;
            const changed = prevPrint !== null && prevPrint !== print;
            const wasTripped = breakerState(novel, args.chapter).tripped;
            let note;
            // 0.19.0 大纲一致性：approve 是细纲拿到合法身份的最后关口——同样的重合度警告
            // 在这里再给一次（save_chapter 时模型可能没理会，approve 后就进写章门禁了）。
            let divergenceNote;
            try {
                const bookOutline = await io.readText(p.bookOutline);
                if (bookOutline !== null) {
                    const vol = volumeSection(bookOutline, args.chapter);
                    if (vol !== null) {
                        const { jaccard, termHitRate } = outlineDivergence(vol, outlineText);
                        if (jaccard < 0.15 && termHitRate < 0.02) {
                            await audit(io, p, 'outline/divergence_warned', { chapter: args.chapter, jaccard, termHitRate, at: 'approve' });
                            divergenceNote = `⚠️ 第${args.chapter}章细纲与全书大纲本卷规划的重合度只有 ${jaccard}（词命中率 ${termHitRate}）——若是有意拐线，请同步 novel_outline save_book 更新大纲；若无意拐线，重写细纲后再批准。`;
                        }
                    }
                }
            } catch { /* 尽力而为的提醒 */ }
            // 指纹无论如何都更新为本次批准的基线：tripped 下首次 approve 不解锁，
            // 但从这次起「与上次批准是否相同」就有据可查了。
            novel.approvals.outlinePrints[String(args.chapter)] = print;
            if (changed) {
                if (wasTripped) await audit(io, p, 'breaker/released_via_outline_approve', { chapter: args.chapter });
                clearBreaker(novel, args.chapter);
            } else if (wasTripped) {
                note = prevPrint === null
                    ? `首次批准不构成重新校准——熔断未解除（第${args.chapter}章仍被拒写）。解除要真的改细纲：save_chapter 提交修改稿后再 approve。`
                    : `细纲与上次 approve 时完全相同——熔断未解除（第${args.chapter}章仍被拒写）。解除要真的改细纲：save_chapter 提交修改稿后再 approve。`;
                await audit(io, p, 'breaker/unchanged_approve', { chapter: args.chapter });
            }
            await saveBook(io, p, novel);
            await audit(io, p, 'outline/approve', { chapter: args.chapter, changed });
            const merged = [note, divergenceNote].filter((s) => typeof s === 'string').join('\n') || undefined;
            return { book, action: 'approve', chapter: args.chapter, approved: true, ...(merged !== undefined ? { note: merged } : {}) };
        },
        render: (_args, v) => textBlock(
            (v.action === 'approve'
                ? `第${v.chapter}章细纲已批准，可以 novel_write_chapter。`
                : `已保存：${v.path}`) + (typeof v.note === 'string' ? `\n${v.note}` : '')
        ),
    });
}
