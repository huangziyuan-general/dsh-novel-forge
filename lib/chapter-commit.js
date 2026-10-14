// lib/chapter-commit.js — 章节提交链（一次「把稿子变成正式章节」的全部硬约束）。
//
// 为什么单独一层：这条链现在有**三个入口**——
//   ① 模型/用户在聊天里调 novel_write_chapter（一次一章）；
//   ② D2 并发批量起草（并发生成裸稿 → **逐章串行提交**）；
//   ③ 面板「💾 保存」（REST POST /projects/:id/chapters/:no，stageGate:false）。
// 三者必须走**同一套内容级门禁**，否则批量起草/面板就成了绕过机审/内容门禁/账本冲突的后门。
// ③ 唯一多出来的豁免是**流程门禁**（该章细纲是否已批准）——那是管模型的，不该拦人改自己的稿子。
//
// 顺序是有讲究的（每一处移动都对应一个真 bug）：
//   阶段门禁 → 细纲存在性 → 熔断 → 机审(确定性指标) → 账本冲突 → **内容门禁(硬伤)**
//   → 细纲契约指标(写偏) → 版本落盘 → 索引/账本/审计
// 内容门禁必须**先于**契约指标：否则「隐藏人物泄露」永远轮不到触发（写偏的禁项先抛了）。
//
// 任何一环不过就是 throw；驳回路径一律先合入增量再抛——熔断计数只活在内存里就永远数不满。

import { chapterRecord, chapterRelPath } from './store.js';
import { nextVersion } from './versioning.js';
import { gateChapterWrite, advanceStage } from './gate.js';
import { matchWorldEntries, declaredCoverageTerms } from './contextpack.js';
import { applyFactUpdates, assertLedgerChapter } from './ledger.js';
import { scanAiFlavor } from './noai.js';
import { sessionFatigue } from './health.js';
import { computeAudit, auditVerdict, paragraphCharProfile } from './audit.js';
import { contentGate } from './content-gate.js';
import { contractFor } from './scene-contract.js';
import { computeGateMetrics } from './gate-metrics.js';
import { breakerState, recordRejection, recordSuccess } from './circuit-breaker.js';
import { audit } from './tools/common.js';
import { updateJson } from './fsio.js';
import { indexChapters } from './index-store.js';

/**
 * 提交路径的落盘收口（CodeBuddy 审计 2026-10-09，高危③）。
 *
 * 为什么不用 saveBook：批量起草从计划到 N 章提交可达几十分钟，期间 novel.json 会被
 * 面板（改名/提案应用走 updateJson）与其它章的驳回计数并发更新——拿启动时快照整体
 * 回写会把那些更新**整份抹掉**（熔断计数清零、提案索引回退成幽灵提案）。
 * 这里改成 updateJson 版本重放：在**最新**文档上只合入本次提交的三类增量：
 *   · gateFailures 的本章两条键——**计数键走增量合入**（快照值 - prevCount = 本次
 *     递增，加到 latest 现值上），别章的计数与并发期间同章的递增都原样保留；
 *     `:last` 是纯信息键，按快照值覆盖即可；成功路径两键均删（recordSuccess 已从
 *     快照删键 → 走 delete 分支 → 计数归零语义不变）；
 *   · chapters[n]——仅当本次真的改写了该章记录（成功落盘）时合入；
 *   · stage——advanceStage「只前进」语义在最新文档上重放。
 * @param prevRecord 提交开始时的 chapters[n] 引用（身份比较判断本次是否改写了该章）
 * @param prevCount  提交开始时的本章熔断计数（增量合入的基线）
 */
async function saveBookMerged(io, p, novel, n, prevRecord, prevCount) {
    await updateJson(io, p.meta, (latest) => {
        if (latest === undefined) throw new Error(`书目不存在（提交中途被删？）：${p.meta}`);
        const gf = { ...(latest.gateFailures ?? {}) };
        const countKey = String(n);
        const lastKey = `${n}:last`;
        const srcGf = novel.gateFailures;
        if (srcGf !== undefined && srcGf !== null && countKey in srcGf) {
            const delta = (Number(srcGf[countKey]) || 0) - prevCount;
            gf[countKey] = Math.max(0, (Number(gf[countKey]) || 0) + delta);
        } else {
            delete gf[countKey];
        }
        if (srcGf !== undefined && srcGf !== null && lastKey in srcGf) gf[lastKey] = srcGf[lastKey];
        else delete gf[lastKey];
        latest.gateFailures = gf;
        const cur = novel.chapters?.[String(n)];
        if (cur !== undefined && cur !== prevRecord) {
            latest.chapters = { ...(latest.chapters ?? {}), [String(n)]: cur };
            // 阶段推进与落盘绑定：驳回路径绝不推 stage（E2 回归实锤——被驳的章把
            // topic 推成了 writing）。advanceStage「只前进」，在最新文档上重放幂等。
            advanceStage(latest, 'writing');
        }
        latest.updatedAt = new Date().toISOString();
        return { value: latest, result: latest };
    });
}

/**
 * 提交链上「门禁拒绝」类错误的识别（REST 面按它区分 409 与 500）。
 * 单一真相：新增一道门禁就要加进来，否则它的拒绝会被 REST 报成 IO_FAILURE，
 * 面板只给一句「IO_FAILURE: Error: ...」——用户看不出这是内容问题还是服务故障。
 * 判据是**错误文案的开头**（下面各 throw 站点的第一句），不是异常类型。
 */
const GATE_REJECT_RE = /^(阶段门禁未通过|书目不存在|第\d+章细纲文件缺失|熔断：|机审未通过|账本冲突|内容门禁未通过|细纲禁项被违反)/;
export function isGateRejection(error) {
    return GATE_REJECT_RE.test(String(error?.message ?? error ?? ''));
}

/**
 * 提交链的**判定段**（①→⑤.6）：阶段门禁 → 细纲存在性 → 熔断 → 机审(确定性指标)
 * → 账本冲突 → 内容门禁(硬伤) → 细纲契约指标(写偏)。任何一环不过就是「先合入驳回
 * 计数再抛」——熔断计数只活在内存里就永远数不满。
 *
 * 为什么单独导出：面板的人工保存（REST POST /chapters/:no）必须共用**同一套判定**。
 * 那条路自己负责版本落盘（版本号要在 updateJson 的冲突重放里算，两个面板同时存
 * 同一章不能撞车），但「什么算不合格」绝不允许有两份实现——按本项目的老规矩，
 * 抄出来的那份一定在保护条款上漂移。判定段只此一份。
 *
 * @param config     插件配置（minChapterChars / maxChapterChars / repetitionWindow）
 * @param stageGate  false = 跳过**流程**门禁（细纲必须已批准 + 细纲文件存在），
 *                   内容级判定（机审/账本/内容门禁/禁项/熔断）一条不让。
 *                   只给面板人工保存用——人改自己的稿子不该被「先写细纲」拦住；
 *                   模型面与批量起草恒为 true（默认值），旁路不向它们开放。
 * @returns 判定段的全部中间产物（gate/outline/terms/auditResult/verdict/facts/
 *   nextFacts/added/cgate/gmetrics/softWarnings/prevRecord/prevCount），交给写段消费。
 */
export async function runChapterGates({
    config, io, p, book, novel, n, content,
    castNames = [], updates = [], force = false, committedBy = 'agent', stageGate = true,
    skipBreaker = false,
}) {
    // ① 阶段门禁（代码强制）
    const gate = stageGate
        ? gateChapterWrite(novel, n, { force })
        : { ok: true, forced: force === true, reason: '人工保存：跳过流程门禁（细纲批准），内容级门禁照跑', rules: [] };
    if (!gate.ok) throw new Error(gate.reason);

    // ② 细纲存在性（批准了但文件被删也算异常；人工保存没有细纲这一说）
    const outline = await io.readText(p.chapterOutline(n));
    if (outline === null && !gate.forced && stageGate) {
        throw new Error(`第${n}章细纲文件缺失（novel.json 标记已批准但文件不在）——请重新 save_chapter`);
    }

    // ①.5 熔断（E2）：同一章连续被驳回 ≥3 次，说明问题多半不在文字而在设定——
    // 此时拒绝再写，逼回去改细纲/场景契约，而不是硬压着改文字。
    // 熔断独立于 force：force 只 override 内容判定（细纲门禁/内容门禁/细纲禁项），
    // 不放开熔断——否则「连续驳回→硬压改写」的死循环会在 force 下一模一样重演
    // （真机完结本实证：force:true 反复绕过熔断，同一章被机审循环驳回多次）。
    // 解锁通道只有两条，且已在各自工具里调 clearBreaker 清零：
    //   · novel_outline save_chapter 后 approve（细纲重批）
    //   · novel_scene save（场景契约更新）
    // skipBreaker（人工保存通道，rest/chapter_save 面板路径专用）：熔断是给**模型执笔
    // 流程**的闸——防「无意识循环硬压」，而面板保存是人有意识的编辑行为；其解锁条件
    // （聊天里 approve 细纲）对人工编辑不可达也无意义（面板本就不要求细纲批准），
    // force 又顶不开熔断——不豁免的话连点 3 次保存就被锁死且无自救路径。豁免面：
    // 不推进计数（下方两处 recordRejection）、不受 tripped 拦截；模型/批量路径默认
    // false 行为一字不变；审计行照记（write_chapter/rejected by:user，痕迹不丢）。
    const br = skipBreaker ? { tripped: false, count: 0, reason: '' } : breakerState(novel, n);
    if (br.tripped) {
        await audit(io, p, 'write_chapter/breaker_tripped', { chapter: n, count: br.count });
        throw new Error(br.reason);
    }
    const prevRecord = novel.chapters?.[String(n)];
    const prevCount = Number(novel.gateFailures?.[String(n)] ?? 0) || 0; // 增量合入基线（跟进项③）

    // ③ 覆盖率要素与重复检测基线
    const entries = (await io.readJson(p.worldbook)) ?? [];
    const worldEntries = matchWorldEntries(entries, [outline ?? '', castNames.join('、')]);
    // 覆盖率要素收敛：只算细纲真正声明的（cast + 细纲里出现过的世界书关键词），
    // 否则一条世界书的几十个泛词会全变成「未出现」噪声。
    const terms = declaredCoverageTerms({ outline: outline ?? '', castNames, worldEntries });

    const window = Number.isInteger(config.repetitionWindow) && config.repetitionWindow >= 1 ? config.repetitionWindow : 10;
    const chapterKeys = Object.keys(novel.chapters ?? {}).map(Number).filter((k) => k < n).sort((a, b) => b - a).slice(0, window);
    const previous = [];
    for (const k of chapterKeys) {
        // 路径收口（跟进项①）：越书路径按缺章跳过，不把污染路径交给 readText。
        const rel = chapterRelPath(novel.chapters[String(k)], book);
        if (rel === null) continue;
        const text = await io.readText(rel);
        if (text !== null) previous.push({ chapter: k, content: text });
    }

    // ④ 机审判定（确定性指标，不是模型口味）
    const auditResult = computeAudit({ content, previous, terms });
    // 字数驳回文案带段落级分布：模型定向加厚，不再整章重发（真机三章靠 2–3 版重试过线，烧穿单轮输出预算）。
    const verdict = auditVerdict(auditResult, config, { paragraphChars: paragraphCharProfile(content) });
    if (!verdict.ok) {
        if (!skipBreaker) {
            recordRejection(novel, n, { code: 'audit', detail: verdict.problems.join('；') });
            await saveBookMerged(io, p, novel, n, prevRecord, prevCount); // 驳回计数要落盘，否则熔断永远数不满
        }
        await audit(io, p, 'write_chapter/rejected', { chapter: n, kind: 'audit', reason: verdict.problems.join('；'), breaker: novel.gateFailures[String(n)], by: committedBy });
        throw new Error(`机审未通过，未保存：${verdict.problems.join('；')}`);
    }

    // ⑤ 账本：同章改值冲突 → 拒绝保存；章号超前（force 场景）也拒
    const facts = (await io.readJson(p.facts)) ?? [];
    if (updates.length > 0) {
        const maxWritten = Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
        assertLedgerChapter(n, maxWritten);
    }
    const { facts: nextFacts, added, conflicts } = applyFactUpdates(facts, updates, { chapter: n, now: new Date().toISOString() });
    if (conflicts.length > 0) {
        if (!skipBreaker) {
            recordRejection(novel, n, { code: 'ledger-conflict', detail: conflicts.map((c) => c.reason).join('；') });
            await saveBookMerged(io, p, novel, n, prevRecord, prevCount); // 驳回计数要落盘（0.13.6：账本冲突此前不计入熔断）
        }
        await audit(io, p, 'write_chapter/rejected', { chapter: n, kind: 'ledger-conflict', reason: conflicts.map((c) => c.reason).join('；'), breaker: novel.gateFailures[String(n)], by: committedBy });
        throw new Error(`账本冲突，未保存：${conflicts.map((c) => c.reason).join('；')}`);
    }

    const softWarnings = [];

    // ⑤.5 内容门禁（六维硬关卡，零 token）：死人复活 / 过期状态 / 欠账未还却开新钩 /
    // 未完成稿 / 人称混用 / 隐藏人物泄底（场景契约）
    const foreshadows = (await io.readJson(p.foreshadows)) ?? [];
    const contracts = (await io.readJson(p.sceneContracts)) ?? {};
    const contract = contractFor(contracts, n);
    if (contract !== null && contract.participants.length > 0) {
        const extra = castNames.filter((nm) => !contract.participants.includes(nm) && !contract.hidden.includes(nm));
        if (extra.length > 0) {
            softWarnings.push(`本章 cast 里有契约未声明的人物：${extra.join('、')}——要么 novel_scene save 更新契约，要么从 cast 去掉`);
        }
    }
    await audit(io, p, 'write_chapter/scene_contract', { chapter: n, has: contract !== null, hidden: contract === null ? [] : contract.hidden });
    const cgate = contentGate({
        content,
        chapter: n,
        facts,
        foreshadows,
        cast: castNames,
        actorNames: [...(novel.cast ?? []), ...facts.map((f) => f.entity)],
        contract,
    });

    if (!cgate.ok && !force) {
        recordRejection(novel, n, { code: cgate.blocking.map((b) => b.code).join(','), detail: cgate.blocking.map((b) => b.message).join('；') });
        await saveBookMerged(io, p, novel, n, prevRecord, prevCount);
        await audit(io, p, 'write_chapter/rejected', { chapter: n, kind: 'content-gate', reason: cgate.blocking.map((b) => b.message).join('；'), breaker: novel.gateFailures[String(n)], by: committedBy });
        throw new Error(
            `内容门禁未通过，未保存：\n${cgate.blocking.map((b) => `- ${b.message}`).join('\n')}`
            + '\n（确要强行写入用 force:true，将记入审计）',
        );
    }
    if (!cgate.ok && force) {
        await audit(io, p, 'write_chapter/content_gate_forced', { chapter: n, blocked: cgate.blocking.map((b) => b.code) });
    }

    // ⑤.6 细纲契约指标（A3/A4，纯函数零 token）：必写场景覆盖率 + 禁项偏离度
    const gmetrics = computeGateMetrics({ content, outline: outline ?? '' });
    if (gmetrics.available === true && gmetrics.bannedHits.length > 0) {
        if (!force) {
            recordRejection(novel, n, { code: 'outline-banned', detail: gmetrics.bannedHits.join('、') });
            await saveBookMerged(io, p, novel, n, prevRecord, prevCount);
            await audit(io, p, 'write_chapter/rejected', { chapter: n, kind: 'outline-banned', reason: `命中细纲禁项：${gmetrics.bannedHits.join('、')}`, breaker: novel.gateFailures[String(n)], by: committedBy });
            throw new Error(
                `细纲禁项被违反，未保存：\n- 命中禁项：${gmetrics.bannedHits.join('、')}\n`
                + '（细纲「本章禁止偏离项」声明了这些内容不许出现；确要保留用 force:true，将记入审计）',
            );
        }
        await audit(io, p, 'write_chapter/gate_forced', { chapter: n, bannedHits: gmetrics.bannedHits });
        softWarnings.push(`已 force 放行细纲禁项：${gmetrics.bannedHits.join('、')}`);
    }
    if (gmetrics.available === true && gmetrics.missedScenes.length > 0) {
        softWarnings.push(`细纲必写场景未覆盖：${gmetrics.missedScenes.join('、')}（覆盖率 ${gmetrics.coverage}%）——补写，或确认不写后从细纲删掉该场景`);
    }

    return { gate, outline, terms, auditResult, verdict, facts, nextFacts, added, cgate, gmetrics, softWarnings, prevRecord, prevCount, foreshadows };
}

/**
 * 提交一章正文（判定段 + 版本落盘 + 索引/账本/审计/进度卡）——模型面与批量起草走这条。
 *
 * @param novel   novel.json 对象（会被就地修改并落盘）
 * @returns 工具输出体（path/version/chars/audit/noai/contentGate/gate/warnings/reminders/addedFacts/forced）
 */
export async function commitChapter({
    config, io, p, book, novel, n, title, content, summary,
    castNames = [], updates = [], force = false, committedBy = 'agent',
}) {
    const {
        gate, outline, auditResult, verdict, nextFacts, added, cgate, gmetrics,
        softWarnings, prevRecord, prevCount, foreshadows,
    } = await runChapterGates({
        config, io, p, book, novel, n, content, castNames, updates, force, committedBy,
    });

    // ⑥ 版本化落盘（永不覆盖旧版）——版本号统一走 versioning.nextVersion
    const names = (novel.chapters?.[String(n)]?.files ?? []).map((f) => f.file.split('/').pop() ?? '');
    const version = nextVersion(names, n);
    const rel = p.chapterFile(n, title, version);
    await io.writeText(rel, `${content.trimEnd()}\n`, 'create');

    // ⑦ 索引 + 账本持久化 + 审计
    if (nextFacts.length > 0) await io.writeJson(p.facts, nextFacts);
    // 契约指标一并落盘，便于看趋势：第 10 章 coverage 95% → 第 30 章 60%，说明结构松了
    const gateRecord = gmetrics.available === true
        ? {
            at: new Date().toISOString(),
            coverage: gmetrics.coverage,
            drift: gmetrics.drift,
            missedScenes: gmetrics.missedScenes,
            bannedHits: gmetrics.bannedHits,
            requirements: gmetrics.requirements,
            conditional: gmetrics.conditional,
            passed: gmetrics.passed,
        }
        : null;
    const record = chapterRecord(novel.chapters?.[String(n)], {
        title: title.trim(), version, file: rel, chars: auditResult.chars, summary: summary.trim(),
        gate: gateRecord,
    });
    novel.chapters[String(n)] = record;
    advanceStage(novel, 'writing');
    recordSuccess(novel, n); // 本章已落盘 → 熔断计数清零
    await saveBookMerged(io, p, novel, n, prevRecord, prevCount);

    // 去 AI 味只扫一次，审计日志与返回值复用同一结果
    const noai = scanAiFlavor(content, { topK: config.scanTopK });
    // ⚠️ 到这里**正文、账本、索引都已成功落盘**：这条审计行写失败（并发 appendLine
    // 版本冲突等）不能把整章报成失败——那会让调用方（含批量起草）重试出重复版本。
    // 宁可少一条审计，也不能假阴性。与 rememberSession 同一条静默降级语义。
    try {
        await audit(io, p, 'write_chapter/saved', {
            chapter: n, version, file: rel, chars: auditResult.chars, forced: gate.forced,
            noaiScore: noai.score, by: committedBy,
        });
    } catch (error) {
        console.warn(`[novel-forge] 第 ${n} 章已落盘但 saved 审计写入失败（不影响成稿）：${error?.message ?? error}`);
    }

    // ── 检索索引自动续建（把「回溯用摘录」的前提变成代码强制）────────────────
    // 纪律说「回溯前文用 novel_search 摘录，别整章 read」，但这句话只在**索引跟得上**时成立：
    // 索引缺本章 → 召不回 → 模型退回整章读（真机 in_tok 13 万级的来源就是整章捞正文）。
    // 所以落盘后立刻把这一章增量收进索引，让"先记得 build"这个自觉环节从链上消失。
    // 与 saved 审计同一档：索引是派生物，写失败**绝不**把成稿报成失败（假阴性会诱导
    // 调用方重试，批量路径尤其危险——重试出的是重复版本）。
    let indexNote;
    try {
        const idx = await indexChapters({ io, p, book, novel, only: [n] });
        indexNote = idx.ok
            ? `检索索引已续建：第${n}章 ${idx.added + idx.updated} 块（全库 ${idx.indexedChapters} 章 / ${idx.chunks} 块）`
            : `检索索引未更新（${idx.reason}）——回溯前文请先 novel_search build，不要整章 read`;
        if (!idx.ok) console.warn(`[novel-forge] 第 ${n} 章索引续建降级（不影响成稿）：${idx.reason}`);
    } catch (error) {
        indexNote = '检索索引未更新（建索引异常）——需要时手动 novel_search build';
        console.warn(`[novel-forge] 第 ${n} 章索引续建抛错（不影响成稿）：${error?.message ?? error}`);
    }

    // 进度卡（方向1：汇报走代码强制）——总章数 / 账本条数 / 在册伏笔数 / 待批提案数 /
    // 下一章依据，全部由工具在**落盘后**现算。模型章末交付爱「自数自抄」，历史消息里的
    // 旧数字（如已被应用的提案）会一路抄下去（真机：P45/P48/P49 应用两天后第 50–57 章
    // 仍报「三枚待审」）。这些事实由本工具产出，模型只转述，不再自己数。
    const nextChapter = n + 1;
    const nextOutlineText = await io.readText(p.chapterOutline(nextChapter));
    const progress = {
        chapters: Object.keys(novel.chapters ?? {}).length,
        facts: nextFacts.length,
        openForeshadows: foreshadows.filter((f) => f.payoffChapter === null).length,
        pendingProposals: (novel.proposals ?? []).filter((x) => x?.status === 'pending').length,
        nextChapter,
        nextOutlineReady: novel.approvals?.outline?.[String(nextChapter)] === true && nextOutlineText !== null,
    };

    // 会话疲劳（0.18.0 重写判据）：只测**同口径**的首稿信号——会话内逐章变短（主判据）
    // 与本会话首稿 vs 其它会话首稿（水平判据），外加连写章数兜底。旧版拿首稿均值除成稿
    // 基线，门禁越起作用比值越低，真机 183 章实测第 1 章落盘就误报（详见 lib/health.js）。
    // 体检是旁证：读不到审计/无会话 id 一律跳过，绝不阻断写作。
    if (io.sessionId) {
        try {
            const fatigue = sessionFatigue(await io.readText(p.audit), io.sessionId);
            if (fatigue.sessionFirstAvg !== null) {
                progress.session = {
                    chapters: fatigue.sessionChapters,
                    firstAvg: fatigue.sessionFirstAvg,
                    firstSeries: fatigue.sessionFirstSeries,
                    bookFirstAvg: fatigue.bookFirstAvg ?? 0,
                    referenceChapters: fatigue.referenceChapters,
                    ...(fatigue.warn ? { warn: fatigue.warn } : {}),
                };
            }
        } catch { /* 旁证缺失不阻断 */ }
    }

    return {
        path: rel, version, chars: auditResult.chars, forced: gate.forced,
        progress,
        indexNote,
        addedFacts: added.map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, note: f.note ?? '' })),
        audit: {
            chars: auditResult.chars, paragraphCount: auditResult.paragraphCount,
            avgParagraphChars: auditResult.avgParagraphChars, sentenceCount: auditResult.sentenceCount,
            dialogueRatio: auditResult.dialogueRatio,
            endingHook: { ...auditResult.endingHook },
            repetition: { ...auditResult.repetition },
            coverage: { terms: auditResult.coverage.terms, missing: auditResult.coverage.missing },
        },
        noai: { score: noai.score, level: noai.level, topIssues: noai.topIssues },
        contentGate: {
            ok: cgate.ok,
            blocking: cgate.blocking.map((b) => b.message),
            warnings: cgate.warnings.map((w) => w.message),
        },
        ...(gmetrics.available === true ? {
            gate: {
                coverage: gmetrics.coverage,
                ...(gmetrics.drift === null ? {} : { drift: gmetrics.drift }),
                missedScenes: gmetrics.missedScenes,
                bannedHits: gmetrics.bannedHits,
                passed: gmetrics.passed,
            },
        } : {}),
        warnings: [
            ...verdict.warnings,
            ...cgate.warnings.map((w) => w.message),
            ...softWarnings,
            ...(cgate.ok ? [] : cgate.blocking.map((b) => `已 force 放行内容门禁：${b.message}`)),
        ],
        reminders: [
            '章末修订走 novel_propose（提案制，不直接覆盖已存版本）',
            '新设定及时 novel_worldbook add 固化',
            `下一章从 novel_outline save_chapter（第${n + 1}章）开始`,
        ],
    };
}
