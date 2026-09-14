// lib/tools/writing-tools.js — novel_briefing / novel_write_chapter。
// 写作主链路：briefing 组装上下文包（一致性供给侧）；write_chapter 是全插件
// 硬约束最集中的地方——阶段门禁 → 细纲存在性 → 机审判定（字数/重复/覆盖）
// → 账本冲突检查 → 版本化落盘 → 审计，任何一环不过就是 throw。

import { defineTool } from './define-tool.js';
import { pathsFor, chapterRecord } from '../store.js';
import { nextVersion } from '../versioning.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { gateChapterWrite, advanceStage } from '../gate.js';
import { extractAnchors, styleFingerprintLine } from '../style.js';
import { buildContextPack, matchWorldEntries, renderPack } from '../contextpack.js';
import { applyFactUpdates, factsDigest, assertLedgerChapter, foreshadowDigest, overdueForeshadows } from '../ledger.js';
import { termsDigest } from '../glossary.js';
import { scanAiFlavor } from '../noai.js';
import { computeAudit, auditVerdict } from '../audit.js';
import { contentGate } from '../content-gate.js';
import { contractFor, resolveSceneCast, renderContractSection, contractDigest, scrubHiddenNames } from '../scene-contract.js';
import { normalizeVoice, renderVoiceCard } from '../voice.js';
import { computeGateMetrics, gateMetricsDigest } from '../gate-metrics.js';
import { breakerState, recordRejection, recordSuccess } from '../circuit-breaker.js';
import { audit, requireBook, saveBook, parseList, parseFactLines, textBlock } from './common.js';

export function defineBriefingTool(ctx, config) {
    return defineTool({
        name: 'novel_briefing',
        description: '写前简报：为第N章组装上下文包（细纲→出场人物卡→账本摘要→未回收伏笔→命中的世界书条目→上一章结尾→原著锚段→前文摘要→全书大纲，按预算裁剪）。锚段是从最近章节挑的味道样本——模仿其语感节奏，勿抄词句；有基线时附文风指纹。写章前必调；模型「看不见前文」的问题由它兜底。',
        parameters: {
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', required: true, description: '章号。' },
            cast: { type: 'string', description: '本章出场人物（逗号分隔）；省略则用工程 cast 全员。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    chapter: { type: 'integer', required: true },
                    totalChars: { type: 'integer', required: true },
                    dropped: { type: 'array', items: { type: 'string' }, required: true },
                    rendered: { type: 'string', required: true },
                    sections: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        name: { type: 'string', required: true }, content: { type: 'string', required: true },
                    } } },
                    warnings: { type: 'array', items: { type: 'string' }, required: true },
                },
            },
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            const n = args.chapter;
            if (!Number.isInteger(n) || n < 1) throw new Error('chapter 必须是正整数');

            const warnings = [];
            const chapterOutline = (await io.readText(p.chapterOutline(n))) ?? '';
            if (chapterOutline === '') warnings.push(`第${n}章细纲不存在——写章会被门禁拦下，先 novel_outline save_chapter`);
            const bookOutline = (await io.readText(p.bookOutline)) ?? '';
            if (bookOutline === '') warnings.push('全书大纲不存在（novel_outline save_book）');

            // 场景契约（B3）：有契约时只注入出场人物、按白名单挑世界书条目。
            const contracts = (await io.readJson(p.sceneContracts)) ?? {};
            const contract = contractFor(contracts, n);
            const requestedCast = args.cast !== undefined ? parseList(args.cast) : (novel.cast ?? []).slice(0, 8);
            const sceneCast = resolveSceneCast({ contract, cast: requestedCast });
            const castNames = sceneCast.inject;
            if (sceneCast.contradictions.length > 0) {
                warnings.push(`场景契约里「${sceneCast.contradictions.join('、')}」同时是出场与隐藏——按隐藏优先处理，本章不注入`);
            }
            if (contract !== null && sceneCast.dropped.length > 0) {
                warnings.push(`场景契约生效：只注入 ${castNames.length} 人的卡（未注入：${sceneCast.dropped.join('、')}）——需要谁出场就 novel_scene save 更新契约`);
            }
            if (castNames.length === 0) warnings.push('未指定出场人物且工程 cast 为空——人物卡不会被注入');
            const castCards = [];
            for (const name of castNames) {
                const card = await io.readText(p.character(name));
                if (card === null) warnings.push(`人物卡缺失：${name}（novel_character save）——该人物将以无卡状态写章`);
                else castCards.push({ name, card });
            }

            // 语言基因卡（E3）：防「千人一腔」的供给侧——有卡就结构化注入，没建的不强求。
            const voicesRaw = (await io.readJson(p.voices)) ?? {};
            const voiceCards = [];
            for (const name of castNames) {
                const card = renderVoiceCard(name, normalizeVoice(voicesRaw[name]));
                if (card !== '') voiceCards.push({ name, card });
            }
            if (voiceCards.length === 0 && castNames.length >= 2) {
                warnings.push(`本章 ${castNames.length} 人同台，但没有语言基因卡——多角色对话容易「千人一腔」（novel_character voice 建卡）`);
            }

            const entries = (await io.readJson(p.worldbook)) ?? [];
            let worldEntries;
            if (contract !== null && contract.settings.length > 0) {
                // 契约白名单：只注入点名的条目（省预算、防无关设定干扰）
                const missing = contract.settings.filter((id) => !entries.some((e) => e.id === id));
                if (missing.length > 0) warnings.push(`契约世界书白名单里的 ${missing.join('、')} 不存在（novel_worldbook list 查 id）`);
                worldEntries = entries.filter((e) => contract.settings.includes(e.id));
            } else {
                worldEntries = matchWorldEntries(entries, [chapterOutline, castNames.join('、'), novel.logline ?? '']);
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
                factsDigest: factsDigest(facts, castNames),
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
            const sections = scrubbed.sections;
            if (scrubbed.scrubbed > 0) {
                warnings.push(`悬念保护：已屏蔽 ${scrubbed.scrubbed} 行涉及未登场人物的上下文（档案/账本/摘要中的痕迹一并擦除）`);
            }
            const totalChars = sections.reduce((n, sec) => n + sec.content.length + sec.name.length + 4, 0);

            return {
                book, chapter: n,
                sections, totalChars, dropped: pack.dropped,
                rendered: renderPack({ sections }), warnings,
                ...(contract === null ? {} : {
                    contractDigest: contractDigest(contract),
                    hiddenCount: contract.hidden.length,
                }),
                ...(sceneCast.dropped.length === 0 ? {} : { droppedCast: sceneCast.dropped }),
                voiceCount: voiceCards.length,
            };
        },
        render: (_args, v) => textBlock(
            `第${v.chapter}章写前简报（${v.totalChars} 字${v.dropped.length > 0 ? `，因预算丢弃：${v.dropped.join('、')}` : ''}）`
            + (v.contractDigest !== undefined ? `\n场景契约：${v.contractDigest}${v.hiddenCount > 0 ? `（隐藏 ${v.hiddenCount} 人·档案未注入、正文也不许出现其名）` : ''}` : '')
            + `\n\n${v.rendered}`
            + (v.warnings.length > 0 ? `\n\n⚠ ${v.warnings.join('\n⚠ ')}` : '')
        ),
    });
}

export function defineWriteChapterTool(ctx, config) {
    return defineTool({
        name: 'novel_write_chapter',
        description: '写整章并落盘（硬约束链）：先 novel_briefing 拿上下文包，再按细纲成稿后调用本工具。门禁：细纲未批准→拒绝；机审不过（字数上下限/与前文高度重复/要素缺失）→拒绝；账本同章改值冲突→拒绝。通过后版本化保存（永不覆盖旧版）+ 落账 + 审计。**节奏铁律：一次只写一章**——本章落盘后立即停下向用户汇报（本章要点 + 下一章建议），由用户决定是否继续，绝不擅自连写下一章。',
        parameters: {
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', required: true, description: '章号。' },
            title: { type: 'string', required: true, description: '本章标题（进文件名，非法字符自动清洗）。' },
            content: { type: 'string', required: true, description: '本章正文全文（按「落笔即防」规范写干净再交）。' },
            summary: { type: 'string', required: true, description: '本章一句话梗概（进章节索引，供后续写前简报）。' },
            cast: { type: 'string', description: '本章出场人物（逗号分隔），用于覆盖率检查与账本摘要。' },
            facts_updates: { type: 'string', description: '本章状态变化，多行「实体|键|值[|备注]」（如：林晚|境界|筑基三层）。账本冲突会拒绝保存。' },
            force: { type: 'boolean', description: 'true=显式放行未批准细纲（记入审计，慎用）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    chapter: { type: 'integer', required: true },
                    path: { type: 'string', required: true },
                    version: { type: 'integer', required: true },
                    chars: { type: 'integer', required: true },
                    forced: { type: 'boolean', required: true },
                    addedFacts: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        entity: { type: 'string', required: true }, key: { type: 'string', required: true },
                        value: { type: 'string', required: true }, chapter: { type: 'integer', required: true },
                        note: { type: 'string' },
                    } } },
                    audit: { type: 'object', required: true, additionalProperties: false, properties: {
                        chars: { type: 'integer', required: true },
                        paragraphCount: { type: 'integer', required: true },
                        avgParagraphChars: { type: 'integer', required: true },
                        sentenceCount: { type: 'integer', required: true },
                        dialogueRatio: { type: 'number', required: true },
                        endingHook: { type: 'object', required: true, additionalProperties: false, properties: {
                            detected: { type: 'boolean', required: true }, kind: { type: 'string' },
                        } },
                        repetition: { type: 'object', required: true, additionalProperties: false, properties: {
                            chapter: { type: 'integer' }, jaccard: { type: 'number', required: true },
                        } },
                        coverage: { type: 'object', required: true, additionalProperties: false, properties: {
                            terms: { type: 'integer', required: true },
                            missing: { type: 'array', items: { type: 'string' }, required: true },
                        } },
                    } },
                    noai: { type: 'object', required: true, additionalProperties: false, properties: {
                        score: { type: 'integer', required: true }, level: { type: 'string', required: true },
                        topIssues: { type: 'array', items: { type: 'string' }, required: true },
                    } },
                    contentGate: { type: 'object', required: true, additionalProperties: false, properties: {
                        ok: { type: 'boolean', required: true },
                        blocking: { type: 'array', items: { type: 'string' }, required: true },
                        warnings: { type: 'array', items: { type: 'string' }, required: true },
                    } },
                    gate: { type: 'object', additionalProperties: false, properties: {
                        coverage: { type: 'number', required: true },
                        drift: { type: 'number' },
                        missedScenes: { type: 'array', items: { type: 'string' }, required: true },
                        bannedHits: { type: 'array', items: { type: 'string' }, required: true },
                        passed: { type: 'boolean', required: true },
                    } },
                    warnings: { type: 'array', items: { type: 'string' }, required: true },
                    reminders: { type: 'array', items: { type: 'string' }, required: true },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            const n = args.chapter;
            if (!Number.isInteger(n) || n < 1) throw new Error('chapter 必须是正整数');
            if (typeof args.title !== 'string' || args.title.trim() === '') throw new Error('title 不能为空');
            if (typeof args.content !== 'string' || args.content.trim() === '') throw new Error('content 不能为空');
            if (typeof args.summary !== 'string' || args.summary.trim() === '') throw new Error('summary 不能为空（供后续写前简报）');

            // ① 阶段门禁（代码强制）
            const gate = gateChapterWrite(novel, n, { force: args.force === true });
            if (!gate.ok) throw new Error(gate.reason);

            // ② 细纲存在性（批准了但文件被删也算异常）
            const outline = await io.readText(p.chapterOutline(n));
            if (outline === null && !gate.forced) throw new Error(`第${n}章细纲文件缺失（novel.json 标记已批准但文件不在）——请重新 save_chapter`);

            // ①.5 熔断（E2）：同一章连续被驳回 ≥3 次，说明问题多半不在文字而在设定——
            // 此时拒绝再写，逼回去改细纲/场景契约，而不是硬压着改文字。
            const br = breakerState(novel, n);
            if (br.tripped && args.force !== true) {
                await audit(io, p, 'write_chapter/breaker_tripped', { chapter: n, count: br.count });
                throw new Error(br.reason);
            }

            // ③ 覆盖率要素与重复检测基线
            const castNames = args.cast !== undefined ? parseList(args.cast) : [];
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
            const auditResult = computeAudit({ content: args.content, previous, terms });
            const verdict = auditVerdict(auditResult, config);
            if (!verdict.ok) {
                recordRejection(novel, n, { code: 'audit', detail: verdict.problems.join('；') });
                await saveBook(io, p, novel); // 驳回计数要落盘，否则熔断永远数不满
                await audit(io, p, 'write_chapter/rejected', { chapter: n, problems: verdict.problems, breaker: novel.gateFailures[String(n)] });
                throw new Error(`机审未通过，未保存：${verdict.problems.join('；')}`);
            }

            // ⑤ 账本：同章改值冲突 → 拒绝保存；章号超前（force 场景）也拒
            const updates = parseFactLines(args.facts_updates);
            const facts = (await io.readJson(p.facts)) ?? [];
            if (updates.length > 0) {
                const maxWritten = Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
                assertLedgerChapter(n, maxWritten);
            }
            const { facts: nextFacts, added, conflicts } = applyFactUpdates(facts, updates, { chapter: n });
            if (conflicts.length > 0) {
                await audit(io, p, 'write_chapter/rejected', { chapter: n, conflicts });
                throw new Error(`账本冲突，未保存：${conflicts.map((c) => c.reason).join('；')}`);
            }

            // 放行判据用「用户是否显式传了 force」——gate.forced 只表示「细纲未批准也被放行」，
            // 细纲已批准时它恒为 false，拿它判内容门禁会漏掉 force（写章被误拦）。
            const forceRequested = args.force === true;
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
                content: args.content,
                chapter: n,
                facts,
                foreshadows,
                cast: castNames,
                actorNames: [...(novel.cast ?? []), ...facts.map((f) => f.entity)],
                contract,
            });

            if (!cgate.ok && !forceRequested) {
                recordRejection(novel, n, { code: cgate.blocking.map((b) => b.code).join(','), detail: cgate.blocking.map((b) => b.message).join('；') });
                await saveBook(io, p, novel);
                await audit(io, p, 'write_chapter/rejected', { chapter: n, contentGate: cgate.blocking.map((b) => b.code), breaker: novel.gateFailures[String(n)] });
                throw new Error(
                    `内容门禁未通过，未保存：\n${cgate.blocking.map((b) => `- ${b.message}`).join('\n')}`
                    + '\n（确要强行写入用 force:true，将记入审计）',
                );
            }
            if (!cgate.ok && forceRequested) {
                await audit(io, p, 'write_chapter/content_gate_forced', { chapter: n, blocked: cgate.blocking.map((b) => b.code) });
            }

            // ⑤.6 细纲契约指标（A3/A4，纯函数零 token）：必写场景覆盖率 + 禁项偏离度
            const gmetrics = computeGateMetrics({ content: args.content, outline: outline ?? '' });
            if (gmetrics.available === true && gmetrics.bannedHits.length > 0) {
                if (!forceRequested) {
                    recordRejection(novel, n, { code: 'outline-banned', detail: gmetrics.bannedHits.join('、') });
                    await saveBook(io, p, novel);
                    await audit(io, p, 'write_chapter/rejected', { chapter: n, bannedHits: gmetrics.bannedHits, breaker: novel.gateFailures[String(n)] });
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
            const rel = p.chapterFile(n, args.title, version);
            await io.writeText(rel, `${args.content.trimEnd()}\n`, 'create');

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
                title: args.title.trim(), version, file: rel, chars: auditResult.chars, summary: args.summary.trim(),
                gate: gateRecord,
            });
            novel.chapters[String(n)] = record;
            advanceStage(novel, 'writing');
            recordSuccess(novel, n); // 本章已落盘 → 熔断计数清零
            await saveBook(io, p, novel);

            // 去 AI 味只扫一次，审计日志与返回值复用同一结果
            const noai = scanAiFlavor(args.content, { topK: config.scanTopK });
            await audit(io, p, 'write_chapter/saved', {
                chapter: n, version, file: rel, chars: auditResult.chars, forced: gate.forced,
                noaiScore: noai.score,
            });

            return {
                book, chapter: n, path: rel, version, chars: auditResult.chars, forced: gate.forced,
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
        },
        render: (_args, v) => textBlock(
            `已保存 第${v.chapter}章 v${v.version}（${v.chars} 字）→ ${v.path}${v.forced ? '（⚠ force 放行）' : ''}\n`
            + `机审：段 ${v.audit.paragraphCount}·对话占比 ${v.audit.dialogueRatio}·章末钩子 ${v.audit.endingHook.detected ? v.audit.endingHook.kind : '无'}·与前文最大重合 ${v.audit.repetition.jaccard}\n`
            + `去AI味：${v.noai.level}（${v.noai.score}/100）${v.noai.topIssues.length > 0 ? `\n  - ${v.noai.topIssues.join('\n  - ')}` : ''}\n`
            + `内容门禁：${v.contentGate.ok ? '通过 ✓' : '⚠ 有阻断项（force 放行）'}\n`
            + (v.warnings.length > 0 ? `警告：${v.warnings.join('；')}\n` : '')
            + `账本落账 ${v.addedFacts.length} 条`
        ),
    });
}
