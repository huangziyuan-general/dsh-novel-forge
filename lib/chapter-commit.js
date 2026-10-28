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
import { bannedTermsOf, dashEndingNote } from './gate-metrics.js';
import { applyFactUpdates, assertLedgerChapter } from './ledger.js';
import { scanAiFlavor } from './noai.js';
import { crossChapterFlavor } from './noai-cross.js';
import { sessionFatigue } from './health.js';
import {
    computeAudit, auditVerdict, paragraphCharProfile, chapterCharTarget,
    nonDraftFloorChars, nonDraftRejection,
} from './audit.js';
import { contentGate } from './content-gate.js';
import { normalizeQuotes } from './punctuation.js';
import { contractFor } from './scene-contract.js';
import { computeGateMetrics } from './gate-metrics.js';
import { breakerState, recordRejection, recordSuccess } from './circuit-breaker.js';
import { audit, readBasisRecord } from './tools/common.js';
import { updateJson } from './fsio.js';
import { indexChapters } from './index-store.js';
import { autoAnnotateChapter } from './engine-tasks.js';
import { computeBasis, diffBasis, SOURCE_LABELS } from './basis.js';
import { analyzePacing } from './pacing.js';
import { makeDebt, worstLevelOf } from './quality-debt.js';

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
        if (latest === undefined) throw new GateRejectionError(`书目不存在（提交中途被删？）：${p.meta}`);
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
        // 跨章节奏状态（②）：按章号覆盖本章那一条（不可变记录，无计数算术）。
        // 驳回路径上 novel.pacing.chapters[n] 还没写（它只在成功落盘后写），所以这里
        // 不会把被驳的章算进冷却——被驳的稿不该消耗节奏额度。
        const paceRec = novel.pacing?.chapters?.[String(n)];
        if (paceRec !== undefined && paceRec !== null) {
            latest.pacing = { ...(latest.pacing ?? {}) };
            latest.pacing.chapters = { ...(latest.pacing?.chapters ?? {}), [String(n)]: paceRec };
        }
        // 质量债（⑦）：按章号覆盖本章那一条（不可变条目，无计数算术）。
        // 驳回路径上 novel.quality.debts[n] 还没写（它只在成功落盘后写），所以
        // 被驳的稿不欠债——它压根没进书。
        const debtItems = novel.quality?.debts?.[String(n)];
        if (Array.isArray(debtItems)) {
            latest.quality = { ...(latest.quality ?? {}) };
            latest.quality.debts = { ...(latest.quality?.debts ?? {}), [String(n)]: debtItems };
        }
        latest.updatedAt = new Date().toISOString();
        return { value: latest, result: latest };
    });
}

/**
 * 提交链上「门禁拒绝」类错误的识别（REST 面按它区分 409 与 500）。
 * 单一真相：门禁类 throw 一律用 GateRejectionError（带 code 标记），文案随便改——
 * 此前按**文案开头**识别（GATE_REJECT_RE），改文案就静默劣化成 500（面板把内容问题
 * 显示成服务故障）；体检轮把它改成显式标记，回归钉在 logic.test.mjs「门禁拒绝分类认 code」。
 * 正则只作历史兜底：兜住 1.0.3 前已构造好的错误对象与插件外的同名前缀抛点；
 * 确认无外部抛点后可整体删除（server-api.test.mjs 的 409 用例是删除前的护栏）。
 */
export class GateRejectionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'GateRejectionError';
        this.code = 'GATE_REJECT';
    }
}
const GATE_REJECT_RE = /^(阶段门禁未通过|书目不存在|第\d+章细纲文件缺失|熔断：|机审未通过|账本冲突|内容门禁未通过|细纲禁项被违反)/;
export function isGateRejection(error) {
    return error?.code === 'GATE_REJECT' || GATE_REJECT_RE.test(String(error?.message ?? error ?? ''));
}

/**
 * E15「同回合重发锚定」的净增阈值（字）：上一次被驳稿与本次被驳稿的字数差低于它，
 * 判定为「同回合逐段修补已经不长个儿」，驳回文案追加换回合硬指引。
 * 真机标定（40 章监控日志）：第 27 章 8 发 1613→1906（累计仅 +293）、两发 1982 同文
 * （+0）、旧案十次才挪 1905 末次只 +20——停滞态的逐次净增都在百字内；而有效的推进
 * 例（1609→1840→2095，+230/+255）明显高于本阈值，不会被误报成锚定。
 */
export const E15_ANCHOR_MIN_DELTA = 100;

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
 * @returns 判定段的全部中间产物（content=引号规范化后的正文（落盘以此为准）/
 *   quoteConverted=直角引号转换数/gate/outline/terms/auditResult/verdict/facts/
 *   nextFacts/added/cgate/gmetrics/softWarnings/prevRecord/prevCount/pacing），
 *   交给写段消费。
 */
export async function runChapterGates({
    config, io, p, book, novel, n, content,
    castNames = [], updates = [], force = false, committedBy = 'agent', stageGate = true,
    skipBreaker = false, basisDigest = null,
}) {
    // ⓪ 引号规范（GB/T 15834—2011，代码强制）：直角引号「」『』落盘前一律转成
    // 国标弯引号“”‘’——三个入口（写章工具/批量起草/面板人工保存）都过这里，判定
    // 与落盘从此只见弯引号。转换幂等、零信息损失，杜绝而不熔断；计数进 softWarnings
    // 与返回值（quoteConverted），转换不许静默。真实入参不改写，只改本地绑定。
    const quoteNorm = normalizeQuotes(content);
    content = quoteNorm.text;

    // ① 阶段门禁（代码强制）
    const gate = stageGate
        ? gateChapterWrite(novel, n, { force })
        : { ok: true, forced: force === true, reason: '人工保存：跳过流程门禁（细纲批准），内容级门禁照跑', rules: [] };
    if (!gate.ok) throw new GateRejectionError(gate.reason);

    // ② 细纲存在性（批准了但文件被删也算异常；人工保存没有细纲这一说）
    const outline = await io.readText(p.chapterOutline(n));
    if (outline === null && !gate.forced && stageGate) {
        throw new GateRejectionError(`第${n}章细纲文件缺失（novel.json 标记已批准但文件不在）——请重新 save_chapter`);
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
    // 不推进计数（下方四处 recordRejection：机审 / 账本冲突 / 内容门禁 / 细纲禁项）、不受 tripped 拦截；模型/批量路径默认
    // false 行为一字不变；审计行照记（write_chapter/rejected by:user，痕迹不丢）。
    const br = skipBreaker ? { tripped: false, count: 0, reason: '' } : breakerState(novel, n);
    if (br.tripped) {
        await audit(io, p, 'write_chapter/breaker_tripped', { chapter: n, count: br.count });
        throw new GateRejectionError(br.reason);
    }
    const prevRecord = novel.chapters?.[String(n)];
    const prevCount = Number(novel.gateFailures?.[String(n)] ?? 0) || 0; // 增量合入基线（跟进项③）

    // ③ 覆盖率要素与重复检测基线
    const entries = (await io.readJson(p.worldbook)) ?? [];
    const worldEntries = matchWorldEntries(entries, [outline ?? '', castNames.join('、')]);
    // 覆盖率要素收敛：只算细纲真正声明的（cast + 细纲里出现过的世界书关键词），
    // 否则一条世界书的几十个泛词会全变成「未出现」噪声。
    // 0.19.1（E2）：契约禁项不进要素表（禁项禁止出现 vs 要素表要求出现，契约优先）；
    // 0.19.1（E4）：cast 全名传给机审——人物名缺失判定放宽为全名或去姓短称。
    const terms = declaredCoverageTerms({ outline: outline ?? '', castNames, worldEntries, forbidden: bannedTermsOf(outline ?? '') });

    const window = Number.isInteger(config.repetitionWindow) && config.repetitionWindow >= 1 ? config.repetitionWindow : 10;
    // 跨章频次判据（⑥）要看更长的一段历史：noai 的八维全是「本章内」判据，
    // 「同一动作全书 ≤8 次」「重复桥段全书 ≤2 次」这类**跨章**病它一条都看不见。
    // 这里多读一段历史（默认 20 章）喂给跨章判据；**机审的重复检测口径不变**
    // （仍只看最近 window 章）——别把两条判据的口径混成一条。
    const crossWindow = Number.isInteger(config.noaiCrossWindow) && config.noaiCrossWindow >= 1 ? config.noaiCrossWindow : 20;
    const readWindow = Math.max(window, crossWindow);
    const chapterKeys = Object.keys(novel.chapters ?? {}).map(Number).filter((k) => k < n).sort((a, b) => b - a).slice(0, readWindow);
    const history = [];
    for (const k of chapterKeys) {
        // 路径收口（跟进项①）：越书路径按缺章跳过，不把污染路径交给 readText。
        const rel = chapterRelPath(novel.chapters[String(k)], book);
        if (rel === null) continue;
        const text = await io.readText(rel);
        if (text !== null) history.push({ chapter: k, content: text });
    }
    // 机审口径一字不变：只看**最近 window 章**（按章号取前 window 个，与旧实现同序同集）。
    const auditKeys = new Set(chapterKeys.slice(0, window));
    const previous = history.filter((h) => auditKeys.has(h.chapter));

    // ③.5 已知称谓证据（T4a）：覆盖率判定里，「全名不在正文」的人可能是被刻意不用全名
    // 称呼的（人物卡标题写「周传海（老周）」、语言基因卡写「从不叫别人全名」，正文通篇
    // 只有「老周」）。证据取自人物卡正文 + 语言基因卡，只在**该名字确实没出现在正文里**
    // 时才去读（命中全名的章一次 io 都不多花）；读不到一律降级为空证据，绝不阻断提交链。
    const aliasProbe = castNames.filter((nm) => typeof nm === 'string' && nm !== '' && !content.includes(nm));
    const castAliasSources = {};
    if (aliasProbe.length > 0) {
        for (const nm of aliasProbe) {
            try {
                const card = await io.readText(p.character(nm));
                if (card !== null && card !== undefined) castAliasSources[nm] = [card];
            } catch { /* 卡读不到：不并入证据，判定回落到旧口径 */ }
        }
        try {
            const voices = (await io.readJson(p.voices)) ?? {};
            for (const nm of aliasProbe) {
                const voice = voices[nm];
                if (voice === undefined || voice === null) continue;
                castAliasSources[nm] = [...(castAliasSources[nm] ?? []), JSON.stringify(voice)];
            }
        } catch { /* 语言基因卡读不到：同上 */ }
    }

    // ④ 机审判定（确定性指标，不是模型口味）
    const auditResult = computeAudit({ content, previous, terms, castNames, castAliasSources });

    // ④.1 非成稿判定（T1/T3）：字数低于机审下限的四分之一 = 不是没写够，是根本没写
    // （工具语义探针 / 半成品）。这一类**照旧驳回**（判定与文案规则不变），但不计入熔断，
    // 驳回文案也换成「这不是一章」并把机审已解析到的元信息回显出来。
    // 阈值从 config.minChapterChars 派生（真机 2000 → 500），不引入新魔法常数。
    const nonDraftFloor = nonDraftFloorChars(config);
    const nonDraft = nonDraftFloor > 0 && auditResult.chars < nonDraftFloor;
    // 字数驳回文案带段落级分布：模型定向加厚，不再整章重发（真机三章靠 2–3 版重试过线，烧穿单轮输出预算）。
    const verdict = auditVerdict(auditResult, config, { paragraphChars: paragraphCharProfile(content) });
    if (!verdict.ok) {
        // 非成稿提交（T1/T3）：不计熔断（探针不该烧掉熔断额度），驳回文案换成「这不是一章」
        // + 已解析元信息；成稿提交（含真写砸）走原判定与原文案，行为一字不差。
        const reason = nonDraft ? nonDraftRejection(auditResult, { floor: nonDraftFloor }) : verdict.problems.join('；');
        if (!skipBreaker && !nonDraft) {
            // E15「同回合重发锚定」：读**本次之前**的 `:last`（recordRejection 尚未覆盖）。
            // 上一驳也是机审、本次仍卡下限、两次净增不足 E15_ANCHOR_MIN_DELTA → 本回合的
            // 逐段修补已停滞（真机第 27 章 8 发累计 +293、两发同文实证），文案追加换回合
            // 硬指引——这是「对策只活在监控日志 persona 里」到「工具层代码强制」的前移。
            let anchorNote = '';
            const prevLast = novel.gateFailures?.[`${n}:last`];
            const prevChars = typeof prevLast?.chars === 'number' ? prevLast.chars : null;
            const delta = prevChars === null ? null : auditResult.chars - prevChars;
            if (prevLast?.code === 'audit'
                && delta !== null
                && auditResult.chars < config.minChapterChars
                && delta < E15_ANCHOR_MIN_DELTA) {
                anchorNote = `\n⚠ 同回合重发锚定：本稿 ${auditResult.chars} 字，${delta >= 0 ? `比上次驳回稿（${prevChars} 字）只多 ${delta}` : `比上次驳回稿（${prevChars} 字）反而少了 ${-delta}`} 字`
                    + '——同一回合里逐段修补已经不长个儿（真机同款 8 发才 +293 字）。停止在本回合继续修补：'
                    + '**换一个新回合，把整章当全新文本一次写足**；或先 novel_outline save_chapter 真实改动细纲、approve 重批后再写。';
            }
            recordRejection(novel, n, { code: 'audit', detail: verdict.problems.join('；'), chars: auditResult.chars });
            await saveBookMerged(io, p, novel, n, prevRecord, prevCount); // 驳回计数要落盘，否则熔断永远数不满
            // chars 显式入审计（E5）：首稿字数此前靠 reason 正则「正文 N 字」反提，
            // 文案一改口径就静默失灵；显式字段优先，正则只作历史行兜底。
            await audit(io, p, 'write_chapter/rejected', {
                chapter: n, kind: 'audit', reason, chars: auditResult.chars,
                breaker: novel.gateFailures?.[String(n)] ?? 0, by: committedBy,
                ...(anchorNote !== '' ? { anchorStalled: true } : {}),
            });
            throw new GateRejectionError(`机审未通过，未保存：${reason}${anchorNote}`);
        }
        await audit(io, p, 'write_chapter/rejected', {
            chapter: n, kind: 'audit', reason, chars: auditResult.chars,
            breaker: novel.gateFailures?.[String(n)] ?? 0,
            ...(nonDraft ? { nonDraft: true, nonDraftFloor } : {}), by: committedBy,
        });
        throw new GateRejectionError(`机审未通过，未保存：${reason}`);
    }

    // ⑤ 账本：同章改值冲突 → 拒绝保存；章号超前（force 场景）也拒
    const facts = (await io.readJson(p.facts)) ?? [];
    if (updates.length > 0) {
        const maxWritten = Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
        assertLedgerChapter(n, maxWritten);
    }
    // 同一个时间戳贯穿本次提交：账本落账与质量债记账用同一刻，取两次钟会让
    // 「本章什么时候写的」出现两个答案。
    const now = new Date().toISOString();
    const { facts: nextFacts, added, conflicts } = applyFactUpdates(facts, updates, { chapter: n, now });
    // ⚠️ ⑤ 之后的所有拒绝分支都**不可能**是 nonDraft：nonDraft 的提交在 ④ 就被
    // auditVerdict 驳回抛出了（chars < min/4 < min ⇒ verdict 必不 ok）。故这里不再有
    // nonDraft 判据与文案分支——曾经写着的 `!nonDraft` 守卫与 `breakerNote` 都是死代码。
    if (conflicts.length > 0) {
        const reason = conflicts.map((c) => c.reason).join('；');
        if (!skipBreaker) {
            recordRejection(novel, n, { code: 'ledger-conflict', detail: reason, chars: auditResult.chars });
            await saveBookMerged(io, p, novel, n, prevRecord, prevCount); // 驳回计数要落盘（0.13.6：账本冲突此前不计入熔断）
        }
        await audit(io, p, 'write_chapter/rejected', {
            chapter: n, kind: 'ledger-conflict', reason, breaker: novel.gateFailures?.[String(n)] ?? 0, by: committedBy,
        });
        throw new GateRejectionError(`账本冲突，未保存：${reason}`);
    }

    const softWarnings = [];
    // 质量债（⑦）：每个警告项同时落成一条**结构化的债**（有级别、有来源代码）。
    // softWarnings 保持字符串数组不变（下游与工具 schema 一字不动），债另走一条
    // 通道落进 novel.json.quality.debts —— 本章的提示是「即时回执」，书级的账
    // 是「这本书欠了多少」，两者不能互相替代。
    const debts = [];
    const warn = (code, message) => {
        softWarnings.push(message);
        debts.push(makeDebt({ code, message, chapter: n, ts: now }));
    };
    if (quoteNorm.converted > 0) {
        warn('quote-normalized', `直角引号 ${quoteNorm.converted} 处已自动转为弯引号（GB/T 15834—2011 横排文稿标准；下笔请直接用“”‘’，转换只是兜底）`);
    }

    // ⑤.5 内容门禁（六维硬关卡，零 token）：死人复活 / 过期状态 / 欠账未还却开新钩 /
    // 未完成稿 / 人称混用 / 隐藏人物泄底（场景契约）
    const foreshadows = (await io.readJson(p.foreshadows)) ?? [];
    const contracts = (await io.readJson(p.sceneContracts)) ?? {};
    const contract = contractFor(contracts, n);
    if (contract !== null && contract.participants.length > 0) {
        const extra = castNames.filter((nm) => !contract.participants.includes(nm) && !contract.hidden.includes(nm));
        if (extra.length > 0) {
            warn('cast-not-in-contract', `本章 cast 里有契约未声明的人物：${extra.join('、')}——要么 novel_scene save 更新契约，要么从 cast 去掉`);
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
        const reason = cgate.blocking.map((b) => b.message).join('；');
        // 守卫同 L217（机审）/L240（账本冲突）：面板路径 skipBreaker=true，
        // 不推进熔断也不受 tripped 锁死。audit 行照记在守卫外——审计是不可绕过的留痕契约。
        if (!skipBreaker) {
            recordRejection(novel, n, { code: cgate.blocking.map((b) => b.code).join(','), detail: reason, chars: auditResult.chars });
            await saveBookMerged(io, p, novel, n, prevRecord, prevCount);
        }
        await audit(io, p, 'write_chapter/rejected', {
            chapter: n, kind: 'content-gate', reason, breaker: novel.gateFailures?.[String(n)] ?? 0, by: committedBy,
        });
        throw new GateRejectionError(
            `内容门禁未通过，未保存：\n${cgate.blocking.map((b) => `- ${b.message}`).join('\n')}`
            + '\n（确要强行写入用 force:true，将记入审计）',
        );
    }
    if (!cgate.ok && force) {
        await audit(io, p, 'write_chapter/content_gate_forced', { chapter: n, blocked: cgate.blocking.map((b) => b.code) });
        // 硬门禁被 force 放行 = 人为越过了硬约束，**必须记成 hard 级债**：
        // 它不是瑕疵（minor），攒不得。softWarnings 不动（回执形状一个字不改）——
        // 质量债走书级账本，本章回执仍旧只报它原来报的东西。
        debts.push(makeDebt({
            code: 'content-gate-forced',
            message: `内容门禁被 force 放行：${cgate.blocking.map((b) => b.message).join('；')}`,
            chapter: n,
            ts: now,
        }));
    }

    // ⑤.6 细纲契约指标（A3/A4，纯函数零 token）：必写场景覆盖率 + 禁项偏离度
    // target 从机审同一配置推（min/max 中值取整）——达成率与机审的「目标 N 字」口径一致
    const gmetrics = computeGateMetrics({
        content,
        outline: outline ?? '',
        target: chapterCharTarget({ minChapterChars: config.minChapterChars, maxChapterChars: config.maxChapterChars }),
    });
    if (gmetrics.available === true && gmetrics.bannedHits.length > 0) {
        if (!force) {
            const reason = `命中细纲禁项：${gmetrics.bannedHits.join('、')}`;
            // 守卫同 L217/L240/L276：面板路径 skipBreaker=true 豁免熔断推进。
            if (!skipBreaker) {
                recordRejection(novel, n, { code: 'outline-banned', detail: gmetrics.bannedHits.join('、'), chars: auditResult.chars });
                await saveBookMerged(io, p, novel, n, prevRecord, prevCount);
            }
            await audit(io, p, 'write_chapter/rejected', {
                chapter: n, kind: 'outline-banned', reason, breaker: novel.gateFailures?.[String(n)] ?? 0, by: committedBy,
            });
            // 驳回文案自带定位（bannedHitsDetail，纯内部字段）：声明句 + 正文行号片段——
            // 只给「命中禁项：X」模型要猜去哪改（真机实证：三轮才自愈）。
            throw new GateRejectionError(
                `细纲禁项被违反，未保存：\n`
                + gmetrics.bannedHitsDetail.map((d) => {
                    const decl = d.declared !== null ? `——细纲声明：「${d.declared.slice(0, 60)}${d.declared.length > 60 ? '…' : ''}」` : '';
                    const loc = d.lineNo !== null ? `；正文第 ${d.lineNo} 行「${d.excerpt}」` : '';
                    return `- 禁项「${d.term}」${decl}${loc}`;
                }).join('\n')
                + '\n（禁项出自细纲「本章禁止偏离项」段；确要保留用 force:true，将记入审计）',
            );
        }
        await audit(io, p, 'write_chapter/gate_forced', { chapter: n, bannedHits: gmetrics.bannedHits });
        warn('outline-banned-forced', `已 force 放行细纲禁项：${gmetrics.bannedHits.join('、')}`);
    }
    if (gmetrics.available === true && gmetrics.missedScenes.length > 0) {
        // 覆盖率按**场景**算（拍行已由 parseScenes 归巢进 beatLines，不再灌水分母）。
        // 文案必须把「什么要逐字、什么不要」说死——真机实证：旧文案列一串
        // 「拍：xxx 未覆盖——补写」，模型按字面去逐字复现拍短语，覆盖率 20%→15.8% 越追越低。
        warn('scene-not-covered', `细纲必写场景未覆盖：${gmetrics.missedScenes.join('、')}（覆盖率 ${gmetrics.coverage}%）`
            + '——需要逐字（跨标点）出现在正文的是场景条目「：」前的**摘要短语**，不是拍；拍只是节拍提示，写意即可。'
            + '补写未覆盖的场景，或确认不写后从细纲删掉该条目');
    }

    // ⑤.7 跨章节奏体检（②）：反向刹车 / 事件冷却 / 节奏档位
    //
    // 放在内容门禁**之后**——死人复活、占位符那种硬伤比「节奏不对」更该先报；
    // 也放在所有门禁**之后**——被驳的稿不必再花这份算力。
    //
    // 这一段治的是本项目最贵的那类病：单章都合格，连着三十章全是同一个腔调、
    // 或者第十章就把主线解决了。noai 八维只看本章、看不到这些；此前跨章约束
    // 靠 contextpack 注入的一段纯文本（RHYTHM_CONSTRAINT）——靠模型自觉，
    // 正是 AGENTS.md 开篇反对的那类约束。
    const pacingCfg = config.pacing ?? {};
    const pacingOn = pacingCfg.enabled !== false;
    const pacingOpts = {};
    if (Number.isInteger(pacingCfg.brakeGroups)) pacingOpts.brakeGroups = pacingCfg.brakeGroups;
    if (Number.isInteger(pacingCfg.maxConsecutiveFast)) pacingOpts.maxConsecutiveFast = pacingCfg.maxConsecutiveFast;
    if (Number.isInteger(pacingCfg.maxFastPerVolume)) pacingOpts.maxFastPerVolume = pacingCfg.maxFastPerVolume;
    if (Number.isInteger(pacingCfg.volumeChapters)) pacingOpts.volumeChapters = pacingCfg.volumeChapters;
    if (Number.isInteger(pacingCfg.slowWindow)) pacingOpts.slowWindow = pacingCfg.slowWindow;
    if (Number.isInteger(pacingCfg.maxSlowPerWindow)) pacingOpts.maxSlowPerWindow = pacingCfg.maxSlowPerWindow;
    const pacing = pacingOn
        ? analyzePacing({
            content,
            chapter: n,
            outline: outline ?? '',
            pacing: novel.pacing,
            options: pacingOpts,
        })
        : { issues: [], metrics: {}, record: null, brake: { triggered: false, words: [], groups: [], message: '' } };

    // 反向刹车：**可阻断**（force 可放行），治「AI 爱当救世主，一口气把主线解决了」
    // ——这种塌陷一旦发生，后面几十章无事可写，事后润色救不回来。
    // 冷却与档位只报不拦（证据不是判决，与 noai 同一档）。
    const brakeMode = pacingCfg.brake ?? 'blocking';
    if (pacing.brake.triggered && brakeMode === 'blocking' && !force) {
        const reason = pacing.brake.message;
        if (!skipBreaker) {
            recordRejection(novel, n, { code: 'pacing-brake', detail: reason, chars: auditResult.chars });
            await saveBookMerged(io, p, novel, n, prevRecord, prevCount);
        }
        await audit(io, p, 'write_chapter/rejected', {
            chapter: n, kind: 'pacing-brake', reason, breaker: novel.gateFailures?.[String(n)] ?? 0, by: committedBy,
        });
        throw new GateRejectionError(
            `节奏刹车未通过，未保存：\n- ${reason}\n`
            + '修法：把「解决」拆到后面几章——本章只推进一步，格局/关系/秘密里挑一样动。'
            + '若这条线确实该在本书后段收，先改细纲把它挪到后面几章再 approve 重批；'
            + '确要强写用 force:true，将记入审计。',
        );
    }
    if (pacing.brake.triggered && brakeMode === 'blocking' && force) {
        try {
            await audit(io, p, 'write_chapter/pacing_forced', { chapter: n, groups: pacing.brake.groups.map((g) => g.id) });
        } catch { /* 审计是旁证，写不进不阻断落盘 */ }
        warn('pacing-brake-forced', `已 force 放行反向刹车：${pacing.brake.message}`);
    } else if (pacing.brake.triggered && brakeMode === 'warning') {
        warn('pacing-brake-warn', `节奏刹车（只提示）：${pacing.brake.message}`);
    }
    if (pacing.issues.length > 0) {
        for (const x of pacing.issues) warn('pacing-check', `节奏体检：${x}`);
    }

    // ④.7 简报陈旧检测（basis 指纹）
    //
    // 要消灭的静默故障：简报生成后用户改了细纲/契约/世界书 → 模型按**旧简报**写完落盘
    // → 文件里的契约已经是新的，正文却是旧契约的产物，全程没有任何告警。
    //
    // 服务端重算同一组哈希并比对，两条来源互为交叉：
    //   ① 与服务端自己留的简报记录比（不靠模型自觉把指纹带回来）；
    //   ② 与模型带回来的 basis.digest 比（带了才比，不带不报错）。
    //
    // 只报不拦：依据漂移不等于正文一定写错（用户可能就是改了细纲却要按旧稿写），
    // 硬拦会误伤。面板人工保存路径（stageGate=false）不跑这条——那条路没有简报。
    const basisNow = computeBasis({
        outline: outline ?? '',
        contract,
        worldbook: entries,
        facts,
    });
    const basisIssues = [];
    if (stageGate) {
        const recorded = await readBasisRecord(io, p, n);
        if (recorded !== null && typeof recorded.digest === 'string') {
            const drift = diffBasis(recorded, basisNow);
            if (drift.stale.length > 0) {
                basisIssues.push(
                    `简报已过期：${drift.stale.map((t) => SOURCE_LABELS[t] ?? t).join('、')}在简报生成之后被改动过`
                    + '——本章是按**旧依据**写的，正文可能与当前设定对不上。建议重新 novel_briefing 后再写本章。',
                );
            }
            const ledgerChanged = [...drift.facts.modified, ...drift.facts.removed];
            if (ledgerChanged.length > 0) {
                basisIssues.push(
                    `账本在简报之后被改写（${ledgerChanged.slice(0, 5).join('、')}）——本章用的是改写前的账本快照；`
                    + '若新值与本章相关，请重新 briefing。',
                );
            }
        }
    }
    if (basisDigest !== null && basisDigest !== basisNow.digest) {
        basisIssues.push(
            '本次提交的简报指纹与当前设定对不上——你用的那份简报已经过期（设定在此期间被改过）。'
            + '请重新 novel_briefing 后再写本章。',
        );
    }
    if (basisIssues.length > 0) {
        for (const x of basisIssues) warn('basis-stale', x);
        try {
            await audit(io, p, 'write_chapter/basis_drift', {
                chapter: n, digest: basisNow.digest, issues: basisIssues.length,
            });
        } catch { /* 审计是旁证，写不进不阻断落盘 */ }
    }

    // 跨章 AI 味频次判据（⑥）：放在所有门禁**之后**——被驳的稿不必再花这份算力。
    // 只报不拦（与 noai 同一档：证据不是判决），结论进 warnings 让模型看得见。
    const cross = crossChapterFlavor({
        content,
        chapter: n,
        history,
        options: { totalChapters: Object.keys(novel.chapters ?? {}).length },
    });
    if (cross.issues.length > 0) {
        for (const x of cross.issues) warn('cross-check', `跨章体检：${x}`);
    }

    return { content, quoteConverted: quoteNorm.converted, gate, outline, terms, auditResult, verdict, facts, nextFacts, added, cgate, gmetrics, softWarnings, debts, prevRecord, prevCount, foreshadows, basis: basisNow, cross, pacing };
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
    engine = null, basisDigest = null,
}) {
    const {
        content: normContent, quoteConverted,
        gate, outline, auditResult, verdict, nextFacts, added, cgate, gmetrics,
        softWarnings, debts, prevRecord, prevCount, foreshadows, cross, pacing,
    } = await runChapterGates({
        config, io, p, book, novel, n, content, castNames, updates, force, committedBy, basisDigest,
    });

    // ⑥ 版本化落盘（永不覆盖旧版）——版本号统一走 versioning.nextVersion
    const names = (novel.chapters?.[String(n)]?.files ?? []).map((f) => f.file.split('/').pop() ?? '');
    const version = nextVersion(names, n);
    const rel = p.chapterFile(n, title, version);
    await io.writeText(rel, `${normContent.trimEnd()}\n`, 'create');

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
            // 0.20.0：目标字数达成率留痕（非阻断）——「长期贴下限」有数字可查
            chars: gmetrics.chars,
            targetRatio: gmetrics.targetRatio,
        }
        : null;
    const record = chapterRecord(novel.chapters?.[String(n)], {
        title: title.trim(), version, file: rel, chars: auditResult.chars, summary: summary.trim(),
        gate: gateRecord,
    });
    novel.chapters[String(n)] = record;
    // 跨章节奏状态（②）：本章归到哪类事件、属于哪个节奏档位——落进 novel.json.pacing。
    // 形状是「章号 → 记录」，不是计数器：每章一条不可变记录，合并时按章号覆盖即可，
    // 不像计数键要做增量算术（并发写同书时计数键最容易算错，见 saveBookMerged 注释）。
    if (pacing?.record !== null && pacing?.record !== undefined) {
        if (!novel.pacing || typeof novel.pacing !== 'object') novel.pacing = {};
        if (!novel.pacing.chapters || typeof novel.pacing.chapters !== 'object') novel.pacing.chapters = {};
        novel.pacing.chapters[String(n)] = pacing.record;
    }
    // 质量债（⑦）：本章欠的账落进 novel.json.quality.debts，形状同样是「章号 → 条目」
    // （不可变条目，合并按章号覆盖，没有计数算术）。空债也要覆盖：重写干净了，旧账必须清零。
    // ⚠️ noai 扣分**不进债表**：noai 是在落盘之后扫的（提前扫会把「扫描抛错」从
    // 假阴性变成整章不落盘，那是行为倒退），而且它是每章独立的评语、没有累积
    // 语义——质量债要记的是能欠着、能跨章累积的东西。
    if (Array.isArray(debts)) {
        if (!novel.quality || typeof novel.quality !== 'object') novel.quality = {};
        if (!novel.quality.debts || typeof novel.quality.debts !== 'object') novel.quality.debts = {};
        novel.quality.debts[String(n)] = debts;
    }
    advanceStage(novel, 'writing');
    recordSuccess(novel, n); // 本章已落盘 → 熔断计数清零
    await saveBookMerged(io, p, novel, n, prevRecord, prevCount);

    // 去 AI 味只扫一次，审计日志与返回值复用同一结果
    const noai = scanAiFlavor(normContent, { topK: config.scanTopK });
    // 跨章判据的结论并进 topIssues（模型读回执时与八维问题一处看，不另开一条通道）。
    // 分数不动：跨章频次不进八维加权（WEIGHTS 恒为 1 是被测试钉死的红线）。
    if (cross?.issues?.length > 0) {
        noai.topIssues = [...noai.topIssues, ...cross.issues.map((x) => `跨章：${x}`)];
    }
    // ⚠️ 到这里**正文、账本、索引都已成功落盘**：这条审计行写失败（并发 appendLine
    // 版本冲突等）不能把整章报成失败——那会让调用方（含批量起草）重试出重复版本。
    // 宁可少一条审计，也不能假阴性。与 rememberSession 同一条静默降级语义。
    try {
        await audit(io, p, 'write_chapter/saved', {
            chapter: n, version, file: rel, chars: auditResult.chars, forced: gate.forced,
            noaiScore: noai.score, quoteConverted, by: committedBy,
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

    // ── 自动打标（G1 语义层收尾）────────────────────────────────────────────
    // 索引续建只收正文块，语义标签仍要模型来贴——annotate 是纯手动动作，真机上大多
    // 数块永远没标签，标签增强检索就形同虚设。落盘后对**本章**新块后台补标（封顶
    // 4 块、连续失败即停，config.search.autoAnnotate=false 可整体关）。
    // fire-and-forget：绝不阻塞成稿返回，也绝不把失败抛回提交链（引擎不可用、
    // sqlite 缺席都只是「没打上标」，与索引续建同一降级档）。
    let autoAnnotate = null;
    // isAvailable 是**调用时**探测（装配期不可信，见 engine.js 注释）——提交发生在运行时，
    // 这里探测是准的；MCP 独立模式（无模型服务）由此静默跳过，indexNote 不谎报「已排队」。
    if (engine !== null && engine.isAvailable?.() !== false && config?.search?.autoAnnotate !== false) {
        autoAnnotate = fireAutoAnnotate({ io, p, book, chapter: n, engine });
        if (autoAnnotate !== null) indexNote += '；新块的语义标签正在后台补标（自动打标已排队）';
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
            // 简报包体量传真实配置值（体量估算的第二大项；缺省与 config 默认一致）
            const fatigue = sessionFatigue(await io.readText(p.audit), io.sessionId, {
                briefingChars: config.contextBudgetChars,
            });
            if (fatigue.sessionFirstAvg !== null) {
                progress.session = {
                    chapters: fatigue.sessionChapters,
                    firstAvg: fatigue.sessionFirstAvg,
                    firstSeries: fatigue.sessionFirstSeries,
                    bookFirstAvg: fatigue.bookFirstAvg ?? 0,
                    referenceChapters: fatigue.referenceChapters,
                    ...(fatigue.warn ? { warn: fatigue.warn, level: fatigue.level } : {}),
                    ...(fatigue.contextEst ? { contextEst: fatigue.contextEst } : {}),
                };
            }
        } catch { /* 旁证缺失不阻断 */ }
    }

    // 细纲的格式硬要求（末段断在破折号上）没进任何机审判定——这里补一条纯文本提醒。
    const dashNote = dashEndingNote(outline ?? '', content);

    return {
        path: rel, version, chars: auditResult.chars, forced: gate.forced,
        progress,
        indexNote,
        // 引号规范实况（GB/T 15834—2011）：quoteConverted = 本次落盘前自动转换的直角
        // 引号数；audit.cornerQuotes = 机审文本上的残留数（入口已转换 → 恒 0，保留字段
        // 兼容 0.19.2 的机审判定配置 quoteStyle——它只在文本绕过入口直进机审时才可能非零）。
        quoteConverted,
        addedFacts: added.map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, status: f.status ?? 'confirmed', note: f.note ?? '' })),
        audit: {
            chars: auditResult.chars, paragraphCount: auditResult.paragraphCount,
            avgParagraphChars: auditResult.avgParagraphChars, sentenceCount: auditResult.sentenceCount,
            dialogueRatio: auditResult.dialogueRatio,
            endingHook: { ...auditResult.endingHook },
            repetition: { ...auditResult.repetition },
            coverage: { terms: auditResult.coverage.terms, missing: auditResult.coverage.missing },
            latinRuns: auditResult.latinRuns ?? [],
            cornerQuotes: auditResult.cornerQuotes ?? 0,
        },
        noai: { score: noai.score, level: noai.level, topIssues: noai.topIssues },
        // 质量债（⑦）：本章欠的账——有级别、有来源代码。level 是本章最重的一档
        // （none/minor/major/hard），一眼能懂；items 是明细。
        // 回执里的 warnings 仍是**逐条人话**（模型读那个），这里是**可核算的状态**
        // （工具与书级视图读那个）——两者同源，不各记一份。
        qualityDebt: {
            level: worstLevelOf(debts),
            items: debts.map((d) => ({ code: d.code, level: d.level, message: d.message })),
        },
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
            ...(dashNote === null ? [] : [dashNote]),
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

// ── 自动打标的 fire-and-forget 封装 ──────────────────────────────────────────
//
// 每本书同时只跑一个任务：批量起草多章串行提交会连续触发，上一轮没跑完时本轮
// 直接跳过（返回 null，indexNote 也就不加「已排队」），剩余未标块等下一次落盘再补。
// promise 挂在模块级 Map 上，测试经 pendingAutoAnnotate(book) 等它落定；任务自身
// 吞掉一切异常（console.warn 留痕）——**裸 rejection 在宿主进程是 fatal**
//（engine.js「裸 rejection 是 unhandled」同一条纪律），这里绝不让它飞出去。

const autoAnnotateInFlight = new Map();

function fireAutoAnnotate({ io, p, book, chapter, engine }) {
    if (autoAnnotateInFlight.has(book)) return null; // 上一轮还在跑：本轮跳过
    const task = (async () => {
        try {
            const r = await autoAnnotateChapter({ io, p, book, chapter, engine });
            if (r.annotated > 0) {
                try {
                    await audit(io, p, 'search/auto-annotate', { chapter, annotated: r.annotated, remaining: r.remaining });
                } catch { /* 审计失败不影响打标成果 */ }
            }
            return r;
        } catch (error) {
            console.warn(`[novel-forge] 第 ${chapter} 章自动打标失败（不影响成稿）：${error?.message ?? error}`);
            return { ok: false, annotated: 0, remaining: null, reason: String(error?.message ?? error) };
        } finally {
            autoAnnotateInFlight.delete(book);
        }
    })();
    autoAnnotateInFlight.set(book, task);
    return task;
}

/** 测试/诊断：本书自动打标任务的在飞 promise（没有则 null）。 */
export function pendingAutoAnnotate(book) {
    return autoAnnotateInFlight.get(book) ?? null;
}
