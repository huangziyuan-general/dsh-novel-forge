// lib/tools/audit-tool.js — novel_audit（确定性章节机审 + 可选一致性/平台/敏感/语言核对）。
// 从 quality-tools.js 按工具拆出；schema 与描述原样保留。

import { defineTool } from './define-tool.js';
import { pathsFor, chapterRelPath, effectiveCharConfig, platformOf } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { computeAudit, auditVerdict, chapterCharTarget } from '../audit.js';
import { validateContinuity } from '../continuity.js';
import { loadContinuityInputs } from '../continuity-io.js';
import { computeGateMetrics } from '../gate-metrics.js';
import { reviewForPlatform } from '../platform-review.js';
import { scanSensitive } from '../censor.js';
import { normalizeVoice, isEmptyVoice, voiceConsistency } from '../voice.js';
import { matchWorldEntries, declaredCoverageTerms } from '../contextpack.js';
import { bannedTermsOf } from '../gate-metrics.js';
import { contractFor } from '../scene-contract.js';
import { audit, requireBook, parseList, textBlock } from './common.js';

export function defineAuditTool(ctx, config) {
    return defineTool({
        name: 'novel_audit',
        description: '确定性章节审计（机审）：字数/段落/对话占比/章末钩子/与前文重复率（8字shingle Jaccard）/细纲要素覆盖率。'
            + '**契约指标**（细纲写了「本章必写场景」「本章禁止偏离项」段时）：场景覆盖率/偏离度/漏写场景/命中禁项——代码算，零 token。'
            + '数字是证据——模型审稿的结论必须引用这些数字，不许和稀泥。'
            + 'continuity:true 附带全书一致性校验（死人复活/伏笔倒挂/索引缺失）；voice:true 附带语言基因卡核对（角色说了禁忌词 / 有台词却无一句口头禅）。'
            + 'platform 附带平台审稿（qidian 起点 / fanqie 番茄 / jjwxc 晋江 / qimao 七猫——口味各表，同一章两家结论可能相反）；censor:true 附带敏感自查（涉政/色情擦边/未成年/赌博毒品/暴力/封建迷信/现实机构影射七类，发书前必跑）。',
        parameters: {
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', required: true, description: '要审计的章号（取最新版本）。' },
            continuity: { type: 'boolean', description: 'true=额外跑全书一致性校验（跨章节硬伤：死人复活/伏笔倒挂/索引缺失）。改稿与收尾前建议开。' },
            voice: { type: 'boolean', description: 'true=额外核对语言基因卡：角色说了自己声明过的禁忌词（硬伤）、有台词却没有一句口头禅（提示）。' },
            platform: { type: 'string', description: '平台审稿：qidian（起点）/ fanqie（番茄）/ jjwxc（晋江）/ qimao（七猫）。口味不同：起点看结构与章末钩子，番茄看前 1000 字爽点与完读率，晋江吃字数足额与开篇忌虐，七猫吃强情绪快节奏与章末钩子。' },
            censor: { type: 'boolean', description: 'true=跑敏感自查七类（涉政/色情擦边/未成年红线/赌博毒品/暴力血腥/封建迷信/现实机构影射）。发布前必跑；玄幻等题材可用 exempt 豁免封建迷信类。' },
            exempt: { type: 'string', description: 'censor 的豁免分类，逗号分隔（如「feudal」跳过封建迷信词）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    chapter: { type: 'integer', required: true },
                    path: { type: 'string', required: true },
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
                    verdict: { type: 'object', required: true, additionalProperties: false, properties: {
                        ok: { type: 'boolean', required: true },
                        problems: { type: 'array', items: { type: 'string' }, required: true },
                        warnings: { type: 'array', items: { type: 'string' }, required: true },
                    } },
                    continuityResult: { type: 'object', additionalProperties: false, properties: {
                        ok: { type: 'boolean', required: true },
                        errors: { type: 'integer', required: true },
                        warnings: { type: 'integer', required: true },
                        issues: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                            severity: { type: 'string', required: true },
                            code: { type: 'string', required: true },
                            where: { type: 'string', required: true },
                            message: { type: 'string', required: true },
                        } } },
                    } },
                    gate: { type: 'object', additionalProperties: false, properties: {
                        available: { type: 'boolean', required: true },
                        coverage: { type: 'number' },
                        drift: { type: 'number' },
                        missedScenes: { type: 'array', items: { type: 'string' }, required: true },
                        bannedHits: { type: 'array', items: { type: 'string' }, required: true },
                        requirements: { type: 'array', items: { type: 'string' }, required: true },
                        conditional: { type: 'array', items: { type: 'string' }, required: true },
                        passed: { type: 'boolean' },
                        note: { type: 'string' },
                    } },
                    platformReview: { type: 'object', additionalProperties: false, properties: {
                        platform: { type: 'string', required: true },
                        name: { type: 'string', required: true },
                        score: { type: 'integer', required: true },
                        passed: { type: 'boolean', required: true },
                        errorCount: { type: 'integer', required: true },
                        warningCount: { type: 'integer', required: true },
                        checks: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                            key: { type: 'string', required: true }, label: { type: 'string', required: true },
                            ok: { type: 'boolean', required: true }, value: { type: 'string', required: true },
                            target: { type: 'string', required: true }, level: { type: 'string', required: true },
                            advice: { type: 'string', required: true },
                        } } },
                    } },
                    censorResult: { type: 'object', additionalProperties: false, properties: {
                        level: { type: 'string', required: true },
                        chars: { type: 'integer', required: true },
                        note: { type: 'string', required: true },
                        errorCount: { type: 'integer', required: true },
                        warningCount: { type: 'integer', required: true },
                        categories: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                            key: { type: 'string', required: true }, label: { type: 'string', required: true },
                            severity: { type: 'string', required: true }, count: { type: 'integer', required: true },
                            hint: { type: 'string', required: true },
                            hits: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                                term: { type: 'string', required: true }, count: { type: 'integer', required: true },
                                line: { type: 'integer', required: true }, excerpt: { type: 'string', required: true },
                            } } },
                        } } },
                    } },
                    voiceResult: { type: 'object', additionalProperties: false, properties: {
                        checked: { type: 'integer', required: true },
                        errors: { type: 'integer', required: true },
                        warnings: { type: 'integer', required: true },
                        issues: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                            severity: { type: 'string', required: true },
                            code: { type: 'string', required: true },
                            name: { type: 'string', required: true },
                            message: { type: 'string', required: true },
                        } } },
                    } },
                },
            },
        },
        // 宿主 dsh-tools 的 executionMode() 只有严格 true 才并行调度。基础审计（机审比对）
        // 是纯读，安全；但 platform/censor 路径会 appendLine 写审计行（读-改-写版本守卫），
        // 并发下抛 FS_VERSION_CONFLICT —— 带写路径必须排他。
        isConcurrencySafe: (args) => !args?.platform && !args?.censor,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            if (!Number.isInteger(args.chapter)) throw new Error('chapter 必须是正整数');
            const rec = novel.chapters?.[String(args.chapter)];
            if (rec?.path === undefined) throw new Error(`第${args.chapter}章尚未保存`);
            // 路径收口（跟进项①）：越书路径不读。
            const rel = chapterRelPath(rec, book);
            if (rel === null) throw new Error(`章节路径越出书目录（索引可能被污染，先 novel_project repair 对账）：${String(rec.path).slice(0, 80)}`);
            const content = await io.readText(rel);
            if (content === null) throw new Error(`章节文件缺失：${rel}`);

            const outline = (await io.readText(p.chapterOutline(args.chapter))) ?? '';
            // 1.0.1（真机终章 10 项覆盖率误报）：novel_audit 的覆盖率词表与人物缺失判定，
            // 优先取**本章场景契约**的 participants（契约在场时它才是「本章出场」的真值），
            // 无契约才回退工程 cast 全员——旧口径把全书人物名都算成本章要素，终章回看段
            // 列举的已完结人物全数误报为「要素字面未逐字出现」，机审可信度被稀释。
            const contracts = (await io.readJson(p.sceneContracts)) ?? {};
            const auditContract = contractFor(contracts, args.chapter);
            const chapterCast = auditContract !== null && auditContract.participants.length > 0
                ? auditContract.participants
                : (novel.cast ?? []);
            const entries = (await io.readJson(p.worldbook)) ?? [];
            const worldEntries = matchWorldEntries(entries, [outline, chapterCast.join('、')]);
            // 覆盖率要素收敛：只算细纲真正声明的（见 contextpack.declaredCoverageTerms）；
            // 0.19.1（E2）：契约禁项不进要素表——禁项禁止出现在正文、要素表要求出现，
            // 两套机制对同一个词的要求相反，契约优先。
            // 0.19.1（E4）：computeAudit 拿到 cast 全名——人物名缺失判定放宽为
            // 全名或去姓短称任一出现。
            const terms = declaredCoverageTerms({
                outline,
                castNames: chapterCast,
                worldEntries,
                forbidden: bannedTermsOf(outline),
            });
            const castNames = chapterCast;

            const window = Number.isInteger(config.repetitionWindow) && config.repetitionWindow >= 1 ? config.repetitionWindow : 10;
            const chapterKeys = Object.keys(novel.chapters ?? {}).map(Number).filter((k) => k < args.chapter).sort((a, b) => b - a).slice(0, window);
            const previous = [];
            for (const k of chapterKeys) {
                // 路径收口（跟进项①）：越书路径按缺章跳过，不让审计崩掉。
                const rel = chapterRelPath(novel.chapters[String(k)], book);
                if (rel === null) continue;
                const text = await io.readText(rel);
                if (text !== null) previous.push({ chapter: k, content: text });
            }

            // 已知称谓证据（M15）：与 chapter-commit 同口径——「全名不在正文」的人可能被
            // 刻意用别称称呼（卡标题「周传海（老周）」、正文通篇「老周」）。修前审阅路径不读
            // 证据，于是同一章「写」时判过、「审」时报「周传海 未出现」：同章两处相反结论，
            // 机审的可信度就此打折。只在全名确实缺席时才读卡，读不到一律降级为空证据。
            const aliasProbe = chapterCast.filter((nm) => typeof nm === 'string' && nm !== '' && !content.includes(nm));
            const castAliasSources = {};
            if (aliasProbe.length > 0) {
                for (const nm of aliasProbe) {
                    try {
                        const card = await io.readText(p.character(nm));
                        if (card !== null && card !== undefined) castAliasSources[nm] = [card];
                    } catch { /* 卡读不到：判定回落旧口径 */ }
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

            const a = computeAudit({ content, previous, terms, castNames, castAliasSources });
            // 落库口径之后：审计的字数断言按本书档位算（自定义区间 > 平台 > 插件配置），
            // 与写章门禁同一函数派生——否则同一章在「写」和「审」两处得到相反结论。
            const bookPlatform = platformOf(novel);
            const { config: effConfig, source: effSource } = effectiveCharConfig(config, novel);
            const verdict = auditVerdict(a, effConfig);

            // 可选：全书一致性校验（零 token 纯函数）。IO 装配与面板 REST 共用 continuity-io。
            let continuityResult;
            if (args.continuity === true) {
                const inputs = await loadContinuityInputs(io, p, novel);
                const c = validateContinuity(inputs);
                continuityResult = { ok: c.ok, errors: c.stats.errors, warnings: c.stats.warnings, issues: c.issues };
            }

            // 契约指标（A3/A4）：细纲写了「本章必写场景」/「本章禁止偏离项」段才参与判定。
            // target 与写章门禁同源（本书档位 > 平台 > 插件默认，effConfig 已含优先链）：
            // 漏传时吃 computeGateMetrics 的默认 3000，会让同一章「写」与「审」报出不同的
            // targetRatio（达成率是留痕数字，口径分家就等于没留痕）。
            const gmetrics = computeGateMetrics({
                content,
                outline,
                target: chapterCharTarget({ minChapterChars: effConfig.minChapterChars, maxChapterChars: effConfig.maxChapterChars }),
            });
            const gate = {
                available: gmetrics.available,
                missedScenes: gmetrics.missedScenes,
                bannedHits: gmetrics.bannedHits,
                requirements: gmetrics.requirements,
                conditional: gmetrics.conditional,
                ...(gmetrics.coverage === null ? {} : { coverage: gmetrics.coverage }),
                ...(gmetrics.drift === null ? {} : { drift: gmetrics.drift }),
                ...(gmetrics.passed === null ? {} : { passed: gmetrics.passed }),
                ...(gmetrics.note === null ? {} : { note: gmetrics.note }),
            };

            // 平台审稿（C4）：把「编辑口味」算成条目——起点看结构，番茄看前千字爽点。
            let platformReview;
            // 平台审稿：显式传的优先，否则用本书落库的平台——不再要求每次调用方手传
            // （真机实证：不传就不审，于是「写的时候按起点放行、想审的时候又忘了传番茄」）。
            const platformWanted = (args.platform !== undefined && String(args.platform).trim() !== '')
                ? String(args.platform).trim()
                : bookPlatform;
            if (platformWanted !== '') {
                // 字数条目必须按**本书生效口径**判（自定义 > 平台 > 插件配置），与写章
                // 门禁同一函数派生：否则书设了 3000–6000、平台是番茄，5000 字的正文会在
                // 「写」这边通过、在「审」这边被判 chapter-length error（写审只做了一半）。
                const r = reviewForPlatform({
                    content, chapter: args.chapter, platform: platformWanted,
                    charConfig: effConfig, charSource: effSource,
                });
                platformReview = {
                    platform: r.platform, name: r.name, score: r.score, passed: r.passed,
                    errorCount: r.errorCount, warningCount: r.warningCount, checks: r.checks,
                };
                await audit(io, p, 'audit/platform', { chapter: args.chapter, platform: r.platform, score: r.score });
            }

            // 敏感自查（C5）：发书前的红线扫描（启发式预筛，非合规判定）。
            let censorResult;
            if (args.censor === true) {
                const exempt = args.exempt === undefined ? [] : parseList(args.exempt);
                const s = scanSensitive({ content, exempt });
                censorResult = {
                    level: s.level, chars: s.chars, note: s.note,
                    errorCount: s.stats.errorCount, warningCount: s.stats.warningCount,
                    categories: s.categories,
                };
                if (s.stats.errorCount > 0) {
                    await audit(io, p, 'audit/censor', { chapter: args.chapter, level: s.level, categories: s.categories.map((c) => c.key) });
                }
            }

            // 语言基因卡核对（E3）：禁忌词命中是硬伤；有台词无口头禅是提示。
            let voiceResult;
            if (args.voice === true) {
                const voicesRaw = (await io.readJson(p.voices)) ?? {};
                // 0.19.1（E13）：核对对象用场景契约 participants（有契约时）——全员核对
                // 会把「不在场、只在叙述里被引用」的角色也拉进来报「有台词无口头禅」。
                let voiceCast = novel.cast ?? [];
                try {
                    const raw = (await io.readJson(p.sceneContracts)) ?? {};
                    const contract = contractFor(raw, args.chapter);
                    if (contract !== null && Array.isArray(contract.participants) && contract.participants.length > 0) {
                        voiceCast = contract.participants;
                    }
                } catch { /* 契约读不到时保持全员（尽力而为） */ }
                const voiced = voiceCast
                    .map((nm) => ({ name: nm, voice: normalizeVoice(voicesRaw[nm]) }))
                    .filter((e) => !isEmptyVoice(e.voice));
                const vc = voiceConsistency({ content, voices: voiced });
                voiceResult = { checked: vc.checked, errors: vc.stats.errors, warnings: vc.stats.warnings, issues: vc.issues };
            }

            return {
                book, chapter: args.chapter, path: rec.path,
                chars: a.chars, paragraphCount: a.paragraphCount, avgParagraphChars: a.avgParagraphChars,
                sentenceCount: a.sentenceCount, dialogueRatio: a.dialogueRatio,
                endingHook: { ...a.endingHook },
                repetition: { ...a.repetition },
                coverage: { terms: a.coverage.terms, missing: a.coverage.missing },
                verdict,
                gate,
                ...(continuityResult !== undefined ? { continuityResult } : {}),
                ...(platformReview !== undefined ? { platformReview } : {}),
                ...(censorResult !== undefined ? { censorResult } : {}),
                ...(voiceResult !== undefined ? { voiceResult } : {}),
            };
        },
        render: (_args, v) => textBlock(
            `第${v.chapter}章机审（${v.chars} 字）：段 ${v.paragraphCount}·对话占比 ${v.dialogueRatio}·章末钩子 ${v.endingHook.detected ? v.endingHook.kind : '⚠无'}·与前文最大重合 ${v.repetition.jaccard}${v.repetition.chapter != null ? `（第${v.repetition.chapter}章）` : ''}\n`
            + `判定：${v.verdict.ok ? '通过' : '不通过'}${v.verdict.problems.length > 0 ? `\n问题：${v.verdict.problems.join('；')}` : ''}${v.verdict.warnings.length > 0 ? `\n警告：${v.verdict.warnings.join('；')}` : ''}`
            + (v.gate.available === true
                ? `\n\n—— 细纲契约指标（代码算）——\n覆盖率 ${v.gate.coverage}%${v.gate.drift === undefined ? '' : ` / 偏离度 ${v.gate.drift}%`} / ${v.gate.passed ? '通过 ✓' : '未通过'}`
                    + `${v.gate.missedScenes.length > 0 ? `\n漏写场景：${v.gate.missedScenes.join('、')}` : ''}`
                    + `${v.gate.bannedHits.length > 0 ? `\n命中禁项：${v.gate.bannedHits.join('、')}` : ''}`
                : `\n\n—— 细纲契约指标 ——\n未启用（${v.gate.note ?? '细纲未写必写场景段'}）`)
            + (v.continuityResult !== undefined
                ? `\n\n—— 全书一致性（${v.continuityResult.errors} 错 / ${v.continuityResult.warnings} 警）——\n`
                    + (v.continuityResult.issues.length === 0
                        ? '未发现硬伤 ✓'
                        : v.continuityResult.issues.map((i) => `${i.severity === 'error' ? '✗' : '⚠'} ${i.message}`).join('\n'))
                : '')
            + (v.platformReview !== undefined
                ? `\n\n—— 平台审稿·${v.platformReview.name}（${v.platformReview.score}/100，${v.platformReview.passed ? '通过 ✓' : '需改'}）——\n`
                    + v.platformReview.checks.map((c) => `${c.ok ? '✓' : (c.level === 'error' ? '✗' : '⚠')} ${c.label}：${c.value}${c.ok || c.advice === '' ? '' : `\n    → ${c.advice}`}`).join('\n')
                : '')
            + (v.censorResult !== undefined
                ? `\n\n—— 敏感自查·${v.censorResult.level === 'clean' ? '未检出 ✓' : (v.censorResult.level === 'risky' ? '命中红线词 ⚠' : '注意')}（${v.censorResult.errorCount} 类红线 / ${v.censorResult.warningCount} 类提醒）——\n`
                    + (v.censorResult.categories.length === 0
                        ? '未检出敏感标记词。'
                        : v.censorResult.categories.map((c) => `${c.severity === 'error' ? '✗' : '⚠'} 【${c.label}】${c.count} 处（${c.hits.map((h) => h.term).join('、')}）\n    → ${c.hint}`).join('\n'))
                : '')
            + (v.voiceResult !== undefined
                ? `\n\n—— 语言基因卡核对（${v.voiceResult.checked} 人）——\n`
                    + (v.voiceResult.issues.length === 0
                        ? '未发现问题 ✓'
                        : v.voiceResult.issues.map((i) => `${i.severity === 'error' ? '✗' : '⚠'} ${i.message}`).join('\n'))
                : '')
        ),
    });
}
