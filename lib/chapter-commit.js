// lib/chapter-commit.js — 章节提交链（一次「把稿子变成正式章节」的全部硬约束）。
//
// 为什么单独一层：这条链现在有**两个入口**——
//   ① 模型/用户在聊天里调 novel_write_chapter（一次一章）；
//   ② D2 并发批量起草（并发生成裸稿 → **逐章串行提交**）。
// 两者必须走**同一套门禁**，否则批量起草就成了绕过机审/内容门禁/账本冲突的后门。
//
// 顺序是有讲究的（每一处移动都对应一个真 bug）：
//   阶段门禁 → 细纲存在性 → 熔断 → 机审(确定性指标) → 账本冲突 → **内容门禁(硬伤)**
//   → 细纲契约指标(写偏) → 版本落盘 → 索引/账本/审计
// 内容门禁必须**先于**契约指标：否则「隐藏人物泄露」永远轮不到触发（写偏的禁项先抛了）。
//
// 任何一环不过就是 throw；驳回路径一律先 saveBook 再抛——熔断计数只活在内存里就永远数不满。

import { chapterRecord } from './store.js';
import { nextVersion } from './versioning.js';
import { gateChapterWrite, advanceStage } from './gate.js';
import { matchWorldEntries } from './contextpack.js';
import { applyFactUpdates, assertLedgerChapter } from './ledger.js';
import { scanAiFlavor } from './noai.js';
import { computeAudit, auditVerdict } from './audit.js';
import { contentGate } from './content-gate.js';
import { contractFor } from './scene-contract.js';
import { computeGateMetrics } from './gate-metrics.js';
import { breakerState, recordRejection, recordSuccess } from './circuit-breaker.js';
import { audit, saveBook } from './tools/common.js';

/**
 * 提交一章正文（全部硬约束在此）。
 *
 * @param config     插件配置（minChapterChars / maxChapterChars / repetitionWindow / scanTopK）
 * @param io         fsio
 * @param p          pathsFor(book)
 * @param book       书目名
 * @param novel      novel.json 对象（会被就地修改并落盘）
 * @param n          章号
 * @param title      标题
 * @param content    正文
 * @param summary    一句话梗概
 * @param castNames  出场人物名数组
 * @param updates    账本更新 [{entity,key,value,note}]
 * @param force      显式放行未批准细纲 / 内容门禁 / 细纲禁项（记审计）
 * @returns 工具输出体（path/version/chars/audit/noai/contentGate/gate/warnings/reminders/addedFacts/forced）
 */
export async function commitChapter({
    config, io, p, book, novel, n, title, content, summary,
    castNames = [], updates = [], force = false, committedBy = 'agent',
}) {
    // ① 阶段门禁（代码强制）
    const gate = gateChapterWrite(novel, n, { force });
    if (!gate.ok) throw new Error(gate.reason);

    // ② 细纲存在性（批准了但文件被删也算异常）
    const outline = await io.readText(p.chapterOutline(n));
    if (outline === null && !gate.forced) {
        throw new Error(`第${n}章细纲文件缺失（novel.json 标记已批准但文件不在）——请重新 save_chapter`);
    }

    // ①.5 熔断（E2）：同一章连续被驳回 ≥3 次，说明问题多半不在文字而在设定——
    // 此时拒绝再写，逼回去改细纲/场景契约，而不是硬压着改文字。
    const br = breakerState(novel, n);
    if (br.tripped && force !== true) {
        await audit(io, p, 'write_chapter/breaker_tripped', { chapter: n, count: br.count });
        throw new Error(br.reason);
    }

    // ③ 覆盖率要素与重复检测基线
    const entries = (await io.readJson(p.worldbook)) ?? [];
    const worldEntries = matchWorldEntries(entries, [outline ?? '', castNames.join('、')]);
    const terms = [...castNames, ...worldEntries.flatMap((e) => (e.keywords ?? []))];

    const window = Number.isInteger(config.repetitionWindow) && config.repetitionWindow >= 1 ? config.repetitionWindow : 10;
    const chapterKeys = Object.keys(novel.chapters ?? {}).map(Number).filter((k) => k < n).sort((a, b) => b - a).slice(0, window);
    const previous = [];
    for (const k of chapterKeys) {
        const rec = novel.chapters[String(k)];
        if (rec?.path === undefined) continue;
        const text = await io.readText(rec.path);
        if (text !== null) previous.push({ chapter: k, content: text });
    }

    // ④ 机审判定（确定性指标，不是模型口味）
    const auditResult = computeAudit({ content, previous, terms });
    const verdict = auditVerdict(auditResult, config);
    if (!verdict.ok) {
        recordRejection(novel, n, { code: 'audit', detail: verdict.problems.join('；') });
        await saveBook(io, p, novel); // 驳回计数要落盘，否则熔断永远数不满
        await audit(io, p, 'write_chapter/rejected', { chapter: n, problems: verdict.problems, breaker: novel.gateFailures[String(n)], by: committedBy });
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
        recordRejection(novel, n, { code: 'ledger-conflict', detail: conflicts.map((c) => c.reason).join('；') });
        await saveBook(io, p, novel); // 驳回计数要落盘（0.13.6：账本冲突此前不计入熔断）
        await audit(io, p, 'write_chapter/rejected', { chapter: n, conflicts, breaker: novel.gateFailures[String(n)], by: committedBy });
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
        await saveBook(io, p, novel);
        await audit(io, p, 'write_chapter/rejected', { chapter: n, contentGate: cgate.blocking.map((b) => b.code), breaker: novel.gateFailures[String(n)], by: committedBy });
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
            await saveBook(io, p, novel);
            await audit(io, p, 'write_chapter/rejected', { chapter: n, bannedHits: gmetrics.bannedHits, breaker: novel.gateFailures[String(n)], by: committedBy });
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
    await saveBook(io, p, novel);

    // 去 AI 味只扫一次，审计日志与返回值复用同一结果
    const noai = scanAiFlavor(content, { topK: config.scanTopK });
    await audit(io, p, 'write_chapter/saved', {
        chapter: n, version, file: rel, chars: auditResult.chars, forced: gate.forced,
        noaiScore: noai.score, by: committedBy,
    });

    return {
        path: rel, version, chars: auditResult.chars, forced: gate.forced,
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
