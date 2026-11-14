// lib/tools/ledger-tool.js — novel_ledger（事实账本与伏笔台账）。
// 从 quality-tools.js 按工具拆出；schema 与描述原样保留。

import { defineTool } from './define-tool.js';
import { pathsFor, chapterRelPath } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { applyFactUpdates, queryFacts, assertLedgerChapter, factsAt, statusTimeline, foreshadowSetup, foreshadowPayoff, foreshadowPayoffVerified, openForeshadows, overdueForeshadows } from '../ledger.js';
import { PLEDGE_KINDS, PLEDGE_STATUS, pledgeSetup, pledgeReplan, pledgeResolve, pledgeAudit } from '../pledges.js';
import { sampleAdd, sampleAllow, sampleRevoke, sampleRemove, samplePool, SAMPLE_LIMITS, SAMPLE_SCENE_TYPES, SAMPLE_SOURCE_KINDS, SAMPLE_SCOPES, renderSamplesPrompt } from '../samples.js';

function pledgeView(p) {
    return {
        id: p.id, kind: p.kind, subject: p.subject ?? '', statement: p.statement ?? '',
        chapter: p.chapter, deadlineChapter: p.deadlineChapter ?? null,
        status: p.status, note: p.note ?? '',
    };
}
import { parseCognitionLines, applyCognitionUpdates, cognitionView, cognitionFlatRows } from '../cognition.js';
import { audit, requireBook, parseList, parseFactLines, textBlock, foreshadowView } from './common.js';

export function defineLedgerTool(ctx, config) {
    return defineTool({
        name: 'novel_ledger',
        description: '事实账本与伏笔台账与**叙事契约**与**写作样稿库**：query 查某实体/键的**当前值**；status_at 查**第 n 章时**的值（时点推演——写新章要回溯旧状态、核对「第 40 章断腿第 50 章还能跑」时用它，不能拿最新值糊）；timeline 看某实体的状态演化线（对账「这个值是哪一章改的」）；update 追加状态变化（多行「实体|键|值[|备注][|状态]」，同章改值=冲突拒绝；状态三态 confirmed/unknown/pending——**设定还没定的写 unknown 并写明原因**，正文不会去补它）；foreshadow_setup 埋伏笔；foreshadow_payoff 收伏笔（回收证据硬校验：回收章**必须是已写章节**，正文须出现该伏笔≥3 字关键词（或≥2 个不同 2 字关键词），证据不足拒绝，force 可豁免并记审计）；list 列出全部伏笔（id/埋设章/预计回收章/是否已收）——payoff 前拿 id 用；cognition 认知账本（不带 updates = 视图：谁知道/不知道什么、读者已知；带 updates = 追加，多行「谁|知道|信息」——写章时随 novel_write_chapter 的 cognition_updates 声明，本动作用于补录与订正）；**pledge_setup 登记叙事契约**（pledge/deadline/secret 三类：承诺/截止/秘密，带到期章号——到期未兑现每次写章被点名，内容门禁第⑨维据此告警）；pledge_replan 改期；pledge_resolve 登记终态（kept/broken/revealed——**是否兑现由你判断，登记是留痕**）；pledge_list 列出全部契约；**sample_add 登记认可样稿**（40–2000 字好段落，scope/sceneType/sourceKind，默认不注入）；sample_allow 批准进入注入候选池（写章/润色时注入成「学视角/句法/节奏」的校准位，受边界纪律约束——样稿不得串入他人人名/地名/剧情）；sample_revoke 撤销；sample_remove 删除；sample_list 列出；sample_prompt 渲染注入资料块（prose/revise 两种边界）。人物境界/物品/地点状态一律走这里——「百万字不崩设定」的底座。',
        parameters: {
            action: { type: 'string', required: true, enum: ['query', 'status_at', 'timeline', 'update', 'foreshadow_setup', 'foreshadow_payoff', 'list', 'cognition', 'pledge_setup', 'pledge_replan', 'pledge_resolve', 'pledge_list', 'sample_add', 'sample_allow', 'sample_revoke', 'sample_remove', 'sample_list', 'sample_prompt'], description: '十八选一。' },
            book: { type: 'string', required: true, description: '书目名。' },
            entity: { type: 'string', description: 'query / status_at：按实体过滤（人物/物品/地点名，可多个用「、」分隔）；timeline：必填，要推演的实体。' },
            key: { type: 'string', description: 'query / status_at / timeline：按键过滤（如 境界/位置/持有）。' },
            since: { type: 'integer', description: 'query：只看第 N 章及以后的变化。' },
            at: { type: 'integer', description: 'status_at 必填：时点章号——第 n 章时各实体/键是什么值（含第 n 章）。' },
            chapter: { type: 'integer', description: 'update / foreshadow_* 必填：发生章号。' },
            updates: { type: 'string', description: 'update 必填：多行「实体|键|值[|备注][|状态]」。状态三态：confirmed（已确认，默认）/ unknown（设定未定，**必须写明原因**，正文不会去补它）/ pending（待复核）。cognition 动作下可选：多行「谁|知道|信息」或「谁|不知道|信息」——给了就追加进认知账本，不给则返回认知视图。' },
            setup: { type: 'string', description: 'foreshadow_setup 必填：伏笔描述。' },
            plan: { type: 'integer', description: 'foreshadow_setup 可选：预计回收章号。briefing 会对超期未回收的伏笔告警。' },
            id: { type: 'string', description: 'foreshadow_* 必填：伏笔 id（setup 可省略自动编号）；pledge_* 可选：契约 id（省略自动编号 P1、P2…）。⚠️ 契约 id 与伏笔 id 是两套编号，别把 F 前缀的伏笔 id 传给 pledge_*。' },
            force: { type: 'boolean', description: 'foreshadow_payoff：回收证据硬校验（回收章正文须含该伏笔≥3 字关键词，或≥2 个不同 2 字关键词）不通过时，确要强行登记传 force:true（记审计）。回收章必须在已写章节里；该章正文文件缺失/被清空同样要 force——不提供静默豁免。' },
            // 叙事契约（pledge_*）
            kind: { type: 'string', description: `pledge_setup 必填：契约种类，${PLEDGE_KINDS.join('/')} 之一。pledge=承诺（某人立誓做某事）；deadline=截止（「三天后报仇」类带期限事件）；secret=秘密（「假死真相」类埋设后到某章前不能露馅）。` },
            subject: { type: 'string', description: 'pledge_setup 可选：契约主体（人物/势力/事件名）。' },
            statement: { type: 'string', description: 'pledge_setup 必填：一句话写清「承诺了什么」——只作展示与关键词匹配，代码不解析词义。' },
            deadlineChapter: { type: 'integer', description: 'pledge_setup：到期章号（deadline/secret 必填、pledge 可省）。改期走 pledge_replan。' },
            status: { type: 'string', description: `pledge_resolve 必填：终态，${PLEDGE_STATUS.filter((s) => s !== 'open' && s !== 'expired').join('/')} 之一。secret 只能 revealed；pledge/deadline 可 kept/broken。expired 是代码判定态（到期且仍 open），不靠手工登记。是否兑现由你判断，登记是留痕。` },
            // 写作样稿库（sample_*）
            sampleContent: { type: 'string', description: `sample_add 必填：认可样稿正文（${SAMPLE_LIMITS.contentMinChars}–${SAMPLE_LIMITS.contentMaxChars} 字的好段落）。` },
            sampleTitle: { type: 'string', description: 'sample_add 可选：样稿标题。' },
            sampleNotes: { type: 'string', description: 'sample_add 可选：备注（为什么认可这段）。' },
            sampleScope: { type: 'string', description: `sample_add 可选：适用范围，${SAMPLE_SCOPES.join('/')} 之一，缺省 novel；sample_prompt 也可用：只渲染该范围（+ novel 通用）的样稿。` },
            sampleSceneType: { type: 'string', description: `sample_add 可选：用途标签，${SAMPLE_SCENE_TYPES.join('/')} 之一，缺省 other。` },
            sampleSourceKind: { type: 'string', description: `sample_add 可选：来源，${SAMPLE_SOURCE_KINDS.join('/')} 之一（own_text=自己的旧文 / human_edit=人工改写 / authorized_reference=授权参考），缺省 own_text。` },
            sampleId: { type: 'string', description: 'sample_allow / sample_revoke / sample_remove / sample_prompt 用：样稿 id（sample_add 可省略自动编号）。' },
            samplePurpose: { type: 'string', description: 'sample_prompt 用：prose（写新正文）/ revise（修订现有文本），缺省 prose。' },
            note: { type: 'string', description: 'pledge_setup / pledge_resolve 可选：备注（setup 说明承诺背景；resolve 说明兑现/违背/揭晓的情况）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    addedCount: { type: 'integer', required: true },
                    facts: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        entity: { type: 'string', required: true }, key: { type: 'string', required: true },
                        value: { type: 'string', required: true }, chapter: { type: 'integer', required: true },
                        status: { type: 'string', required: true },
                        note: { type: 'string' },
                    } } },
                    foreshadows: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        id: { type: 'string', required: true }, setup: { type: 'string', required: true },
                        chapter: { type: 'integer', required: true }, plan: { type: 'integer' },
                        payoffChapter: { type: 'integer' },
                    } } },
                    timeline: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        chapter: { type: 'integer', required: true }, key: { type: 'string', required: true },
                        value: { type: 'string', required: true }, status: { type: 'string', required: true },
                        note: { type: 'string' },
                    } } },
                    // 0.19.1（E6）：setup/payoff 的单条确认与超期提醒（可选，仅 setup/payoff 带）
                    changed: { type: 'object', additionalProperties: false, properties: {
                        id: { type: 'string', required: true }, setup: { type: 'string', required: true },
                        chapter: { type: 'integer', required: true }, plan: { type: 'integer' },
                        payoffChapter: { type: 'integer' },
                    } },
                    overdue: { type: 'array', items: { type: 'string' } },
                    // 叙事契约（pledge_* 动作）
                    pledges: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        id: { type: 'string', required: true },
                        kind: { type: 'string', required: true },
                        subject: { type: 'string', required: true },
                        statement: { type: 'string', required: true },
                        chapter: { type: 'integer', required: true },
                        deadlineChapter: { type: 'integer' },
                        status: { type: 'string', required: true },
                        note: { type: 'string' },
                    } } },
                    pledgeChanged: { type: 'object', additionalProperties: false, properties: {
                        id: { type: 'string', required: true },
                        kind: { type: 'string', required: true },
                        subject: { type: 'string', required: true },
                        statement: { type: 'string', required: true },
                        chapter: { type: 'integer', required: true },
                        deadlineChapter: { type: 'integer' },
                        status: { type: 'string', required: true },
                        note: { type: 'string' },
                    } },
                    pledgeIssues: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        severity: { type: 'string', required: true },
                        code: { type: 'string', required: true },
                        where: { type: 'string', required: true },
                        message: { type: 'string', required: true },
                    } } },
                    // 认知账本（cognition 动作）：当前视图的行（subject/verb/info/chapter）
                    cognition: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        subject: { type: 'string', required: true },
                        verb: { type: 'string', required: true },
                        info: { type: 'string', required: true }, chapter: { type: 'integer', required: true },
                    } } },
                    // 写作样稿库（sample_* 动作）
                    samples: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        id: { type: 'string', required: true },
                        content: { type: 'string', required: true },
                        title: { type: 'string' },
                        notes: { type: 'string' },
                        scope: { type: 'string' },
                        sceneType: { type: 'string' },
                        sourceKind: { type: 'string' },
                        allowedForModelInput: { type: 'boolean' },
                    } } },
                    samplePrompt: { type: 'string' },
                    samplePoolCount: { type: 'integer' },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            let facts = (await io.readJson(p.facts)) ?? [];
            let foreshadows = (await io.readJson(p.foreshadows)) ?? [];
            let pledges = (await io.readJson(p.pledges)) ?? [];

            if (args.action === 'list') {
                // W5（真机《深夜订单》监控）：伏笔 id 只在 setup 返回体/简报文本里出现，
                // 事后补收（payoff）拿不到 id——list 给一条稳定的取 id 通道。
                // 顺带回显契约（不读正文、零 token）——让模型一眼看到「有哪些承诺还没兑现」。
                return { book, action: 'list', addedCount: 0, facts: [], foreshadows: foreshadows.map(foreshadowView), pledges: pledges.map(pledgeView), timeline: [], cognition: [] };
            }

            if (args.action === 'query') {
                // 实体支持「、」多值（与 status_at 的 parseList 对齐；0.13.6 修正——
                // 工具描述承诺了多实体，实现却把整串当单实体名过滤）
                const entities = parseList(args.entity);
                const base = { key: args.key, sinceChapter: Number.isInteger(args.since) ? args.since : undefined };
                const rows = entities.length === 0
                    ? queryFacts(facts, base)
                    : entities.flatMap((e) => queryFacts(facts, { ...base, entity: e }));
                return { book, action: 'query', addedCount: 0, facts: rows.map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, status: f.status, note: f.note ?? '' })), foreshadows: foreshadows.map(foreshadowView), timeline: [], cognition: [] };
            }
            if (args.action === 'status_at') {
                if (!Number.isInteger(args.at)) throw new Error('status_at 需要正整数 at（时点章号）');
                const rows = factsAt(facts, args.at, { entities: parseList(args.entity), keys: parseList(args.key) });
                return { book, action: 'status_at', addedCount: 0, facts: rows, foreshadows: foreshadows.map(foreshadowView), timeline: [], cognition: [] };
            }
            if (args.action === 'timeline') {
                if (typeof args.entity !== 'string' || args.entity.trim() === '') throw new Error('timeline 需要 entity（要推演的实体名）');
                const rows = statusTimeline(facts, args.entity.trim(), { keys: parseList(args.key) });
                return { book, action: 'timeline', addedCount: 0, facts: [], foreshadows: foreshadows.map(foreshadowView), timeline: rows, cognition: [] };
            }
            if (args.action === 'update') {
                if (!Number.isInteger(args.chapter)) throw new Error('update 需要正整数 chapter');
                const maxWritten = Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
                assertLedgerChapter(args.chapter, maxWritten);
                const updates = parseFactLines(args.updates);
                if (updates.length === 0) throw new Error('update 需要 updates（多行 实体|键|值[|备注]）');
                const { facts: nextFacts, added, conflicts } = applyFactUpdates(facts, updates, { chapter: args.chapter, now: new Date().toISOString() });
                if (conflicts.length > 0) throw new Error(`账本冲突，未写入：${conflicts.map((c) => c.reason).join('；')}`);
                facts = nextFacts;
                await io.writeJson(p.facts, facts);
                await audit(io, p, 'ledger/update', { chapter: args.chapter, added: added.length });
                // 0.19.1（E6）：update 是每章必调的高频操作——只返回本次新增条目
                // （added 现成于 applyFactUpdates），不再把全量账本灌回模型上下文
                // （真机 198 条 ≈ 12k token/次 × 每章 2-3 次）。added 带 ts 字段
                // （schema 外），按 facts.items 形状映射剥掉。想看全量走 query。
                return { book, action: 'update', addedCount: added.length, facts: added.map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, status: f.status, note: f.note ?? '' })), foreshadows: foreshadows.map(foreshadowView), timeline: [], cognition: [] };
            }
            // 认知账本（QMAI 信息差维）：双模式——带 updates 追加（补录/订正通道），
            // 不带则返回当前视图（扁平行，每行带 chapter 供对账）。
            if (args.action === 'cognition') {
                let cogRows = (await io.readJson(p.cognition)) ?? [];
                let cogAdded = 0;
                if (typeof args.updates === 'string' && args.updates.trim() !== '') {
                    if (!Number.isInteger(args.chapter)) throw new Error('cognition 追加需要正整数 chapter');
                    const maxWritten = Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
                    assertLedgerChapter(args.chapter, maxWritten);
                    const parsed = parseCognitionLines(args.updates);
                    if (parsed.length === 0) throw new Error('cognition 需要 updates（多行 谁|知道|信息）');
                    const { rows: nextRows, added } = applyCognitionUpdates(cogRows, parsed, { chapter: args.chapter, now: new Date().toISOString() });
                    await io.writeJson(p.cognition, nextRows);
                    await audit(io, p, 'ledger/cognition', { chapter: args.chapter, added: added.length });
                    cogAdded = added.length;
                    cogRows = nextRows;
                }
                // entity 为空 = 不过滤（全量视图）；点名则只看这些人（读者维不受过滤）
                const cogSubjects = parseList(args.entity);
                const viewRows = cognitionFlatRows(cogRows, { subjects: cogSubjects.length > 0 ? cogSubjects : null });
                return {
                    book, action: 'cognition', addedCount: cogAdded, facts: [],
                    foreshadows: foreshadows.map(foreshadowView), timeline: [], cognition: viewRows,
                };
            }
            if (args.action === 'foreshadow_setup') {
                if (!Number.isInteger(args.chapter)) throw new Error('foreshadow_setup 需要正整数 chapter');
                const wasExisting = foreshadows.some((f) => f.id === args.id);
                foreshadows = foreshadowSetup(foreshadows, { id: args.id, setup: args.setup, chapter: args.chapter, plan: args.plan });
                await io.writeJson(p.foreshadows, foreshadows);
                await audit(io, p, wasExisting ? 'foreshadow/replan' : 'foreshadow/setup', { chapter: args.chapter, id: args.id ?? 'auto', setup: args.setup });
                // 0.19.1（E6）：单条增删改不回显全量 facts（28 条账本每次 setup 都重放是纯噪声）；
                // facts 置空、changed 点出本条、overdue 带超期伏笔 id（复用 overdueForeshadows，
                // 以全书已写最大章为参照）。「在册 N 条」由 render 从 foreshadows 现算，不再靠恒 0 的 addedCount。
                const changedId = wasExisting ? args.id : foreshadows[foreshadows.length - 1].id;
                const changed = foreshadows.find((f) => f.id === changedId);
                const maxWritten = Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
                const overdue = overdueForeshadows(foreshadows, maxWritten).map((f) => f.id);
                return {
                    book, action: 'foreshadow_setup', addedCount: 0, facts: [],
                    foreshadows: foreshadows.map(foreshadowView), timeline: [], cognition: [],
                    ...(changed ? { changed: foreshadowView(changed) } : {}),
                    ...(overdue.length > 0 ? { overdue } : {}),
                };
            }
            // foreshadow_payoff（回收证据硬校验：回收章必须是**已写章节**且正文出现该伏笔
            // ≥3 字关键词，零命中 = 读者收不到这个回收，拒绝登记。纯补录/暗回收传 force:true）。
            // ⚠️ 整个分支必须包在 action 判断里：v1.7.1 曾漏了这层 if，导致后面 pledge_* /
            // sample_* 全部成为不可达死代码，且任何未知 action 都会掉进回收逻辑。
            if (args.action === 'foreshadow_payoff') {
                if (!Number.isInteger(args.chapter)) throw new Error('foreshadow_payoff 需要正整数 chapter');
                const maxWrittenNow = Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
                // 章号闸：回收必须落在已写章节。指向未写章节 = 没有正文可核对，
                // 证据校验会整体失效（模型写「第 99 章回收」就能绕过整道闸）。
                if (args.chapter > maxWrittenNow) {
                    throw new Error(`伏笔回收章第${args.chapter}章尚未写（全书已写到第${maxWrittenNow}章）——回收必须落在已经有正文的章节：先写这一章，再登记回收（纯补录旧章请写到对应章号）`);
                }
                // 读回收章正文（路径收口：越书路径按缺章处理 → content 为 null）。
                const rec = novel.chapters?.[String(args.chapter)];
                const rel = rec ? chapterRelPath(rec, book) : null;
                const payoffContent = rel !== null ? await io.readText(rel) : null;
                if (args.force !== true) {
                    // 索引里有章但正文文件缺失/被清空 → 不静默豁免（静默豁免 = 又一条绕过路径）。
                    if (payoffContent === null || String(payoffContent).trim() === '') {
                        throw new Error(`第${args.chapter}章在索引里但没有正文（文件缺失或被清空）——回收证据无法核对。补齐正文，或确认这是纯补录并传 force:true（放行并记审计）`);
                    }
                    foreshadows = foreshadowPayoffVerified(foreshadows, args.id, args.chapter, payoffContent);
                    await io.writeJson(p.foreshadows, foreshadows);
                    await audit(io, p, 'foreshadow/payoff', { chapter: args.chapter, id: args.id });
                } else {
                    foreshadows = foreshadowPayoff(foreshadows, args.id, args.chapter);
                    await io.writeJson(p.foreshadows, foreshadows);
                    await audit(io, p, 'foreshadow/payoff_forced', { chapter: args.chapter, id: args.id });
                }
                // 同 setup：单条回收不回显全量 facts；changed 带回收后的状态，overdue 带剩余超期
                const changed = foreshadows.find((f) => f.id === args.id);
                const overdue = overdueForeshadows(foreshadows, maxWrittenNow).map((f) => f.id);
                return {
                    book, action: 'foreshadow_payoff', addedCount: 0, facts: [],
                    foreshadows: foreshadows.map(foreshadowView), timeline: [], cognition: [],
                    ...(changed ? { changed: foreshadowView(changed) } : {}),
                    ...(overdue.length > 0 ? { overdue } : {}),
                };
            }

            // ── 叙事契约（pledge/deadline/secret 三类）──────────────────────────
            // 是否兑现是语义层，代码不判——登记是留痕（「我判断过」），
            // 代码强制的是「到期这件事每次写章/体检都被点名」，不是替作者判「到底兑现没」。
            const maxWrittenNow = Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
            if (args.action === 'pledge_setup') {
                if (!Number.isInteger(args.chapter)) throw new Error('pledge_setup 需要正整数 chapter');
                assertLedgerChapter(args.chapter, maxWrittenNow);
                const prevCount = pledges.length;
                pledges = pledgeSetup(pledges, {
                    kind: args.kind, subject: args.subject, statement: args.statement,
                    chapter: args.chapter, deadlineChapter: args.deadlineChapter,
                    note: args.note, id: args.id, now: new Date().toISOString(),
                });
                await io.writeJson(p.pledges, pledges);
                await audit(io, p, 'pledge/setup', { chapter: args.chapter, id: pledges[pledges.length - 1].id, kind: args.kind, deadlineChapter: args.deadlineChapter ?? null });
                const changed = pledges[pledges.length - 1];
                return {
                    book, action: 'pledge_setup', addedCount: 1, facts: [], foreshadows: foreshadows.map(foreshadowView),
                    pledges: pledges.map(pledgeView), timeline: [], cognition: [],
                    pledgeChanged: pledgeView(changed),
                };
            }
            if (args.action === 'pledge_replan') {
                if (!Number.isInteger(args.deadlineChapter)) throw new Error('pledge_replan 需要正整数 deadlineChapter');
                pledges = pledgeReplan(pledges, args.id, { deadlineChapter: args.deadlineChapter, now: new Date().toISOString() });
                await io.writeJson(p.pledges, pledges);
                await audit(io, p, 'pledge/replan', { id: args.id, deadlineChapter: args.deadlineChapter });
                const changed = pledges.find((x) => x.id === args.id);
                return {
                    book, action: 'pledge_replan', addedCount: 0, facts: [], foreshadows: foreshadows.map(foreshadowView),
                    pledges: pledges.map(pledgeView), timeline: [], cognition: [],
                    ...(changed ? { pledgeChanged: pledgeView(changed) } : {}),
                };
            }
            if (args.action === 'pledge_resolve') {
                if (typeof args.status !== 'string') throw new Error('pledge_resolve 需要 status（终态）');
                pledges = pledgeResolve(pledges, args.id, { status: args.status, note: args.note ?? '', now: new Date().toISOString() });
                await io.writeJson(p.pledges, pledges);
                await audit(io, p, 'pledge/resolve', { id: args.id, status: args.status });
                const changed = pledges.find((x) => x.id === args.id);
                return {
                    book, action: 'pledge_resolve', addedCount: 0, facts: [], foreshadows: foreshadows.map(foreshadowView),
                    pledges: pledges.map(pledgeView), timeline: [], cognition: [],
                    ...(changed ? { pledgeChanged: pledgeView(changed) } : {}),
                };
            }
            if (args.action === 'pledge_list') {
                // 列出全部契约 + 到期未兑现告警（复用 pledgeAudit，零 token）
                const dueDebts = []; // 本动作不做「开新钩」判断，dueDebts 传空
                const issues = pledgeAudit(pledges, { maxWritten: maxWrittenNow, dueDebts });
                return {
                    book, action: 'pledge_list', addedCount: 0, facts: [], foreshadows: foreshadows.map(foreshadowView),
                    pledges: pledges.map(pledgeView), timeline: [], cognition: [],
                    ...(issues.length > 0 ? { pledgeIssues: issues.map((i) => ({ severity: i.severity, code: i.code, where: i.where, message: i.message })) } : {}),
                };
            }

            // ── 写作样稿库（sample_*）────────────────────────────────────────
            // 样稿库是本书的「我认可的味道」候选池（账本/样稿.json，与 facts 同构）。
            // 候选池入口唯一：samplePool 只认 approved + allowedForModelInput——
            // 草稿与撤销样稿永远查不出来（与 MirrorNovel 的 allowedForModelInput 同纪律）。
            const sampleView = (s) => ({
                id: s.id, content: s.content, title: s.title ?? '',
                notes: s.notes ?? '', scope: s.scope, sceneType: s.sceneType,
                sourceKind: s.sourceKind, allowedForModelInput: s.allowedForModelInput === true,
            });
            let samples = (await io.readJson(p.samples)) ?? [];
            if (args.action === 'sample_add') {
                samples = sampleAdd(samples, {
                    content: args.sampleContent, title: args.sampleTitle, notes: args.sampleNotes,
                    scope: args.sampleScope, sceneType: args.sampleSceneType, sourceKind: args.sampleSourceKind,
                    id: args.sampleId, now: new Date().toISOString(),
                });
                await io.writeJson(p.samples, samples);
                await audit(io, p, 'sample/add', { id: samples[samples.length - 1].id, chars: samples[samples.length - 1].content.length });
                const changed = samples[samples.length - 1];
                return {
                    book, action: 'sample_add', addedCount: 1, facts: [], foreshadows: foreshadows.map(foreshadowView),
                    samples: samples.map(sampleView), timeline: [], cognition: [],
                };
            }
            if (args.action === 'sample_allow') {
                samples = sampleAllow(samples, args.sampleId);
                await io.writeJson(p.samples, samples);
                await audit(io, p, 'sample/allow', { id: args.sampleId });
                return { book, action: 'sample_allow', addedCount: 0, facts: [], foreshadows: foreshadows.map(foreshadowView), samples: samples.map(sampleView), timeline: [], cognition: [] };
            }
            if (args.action === 'sample_revoke') {
                samples = sampleRevoke(samples, args.sampleId);
                await io.writeJson(p.samples, samples);
                await audit(io, p, 'sample/revoke', { id: args.sampleId });
                return { book, action: 'sample_revoke', addedCount: 0, facts: [], foreshadows: foreshadows.map(foreshadowView), samples: samples.map(sampleView), timeline: [], cognition: [] };
            }
            if (args.action === 'sample_remove') {
                samples = sampleRemove(samples, args.sampleId);
                await io.writeJson(p.samples, samples);
                await audit(io, p, 'sample/remove', { id: args.sampleId });
                return { book, action: 'sample_remove', addedCount: 0, facts: [], foreshadows: foreshadows.map(foreshadowView), samples: samples.map(sampleView), timeline: [], cognition: [] };
            }
            if (args.action === 'sample_list') {
                return {
                    book, action: 'sample_list', addedCount: 0, facts: [], foreshadows: foreshadows.map(foreshadowView),
                    samples: samples.map(sampleView), timeline: [], cognition: [],
                };
            }
            if (args.action === 'sample_prompt') {
                // 渲染注入资料块（纯函数，零 token）：只取候选池（approved + allowedForModelInput），
                // 带 prose/revise 边界纪律。写章/润色的提示词组装（briefing / polish analyze）
                // 会调用同一份渲染，本动作是给模型「想当场看一眼」用的显式通道。
                const purpose = args.samplePurpose === 'revise' ? 'revise' : 'prose';
                // scope 必须落到候选池：否则 screenplay 样稿永远查不出来（死参数）。
                const scope = args.sampleScope === 'screenplay' ? 'screenplay' : 'novel';
                const prompt = renderSamplesPrompt(samples, { purpose, scope });
                const pool = samplePool(samples, { scope });
                return {
                    book, action: 'sample_prompt', addedCount: 0, facts: [], foreshadows: foreshadows.map(foreshadowView),
                    samples: samples.map(sampleView), timeline: [], cognition: [],
                    ...(prompt !== '' ? { samplePrompt: prompt, samplePoolCount: pool.length } : {}),
                };
            }
            // 兜底：未知 action 绝不能掉进某个分支（v1.7.1 的死代码事故就是被这条缺口放大）。
            throw new Error(`novel_ledger 未实现的 action：${String(args.action)}`);
        },
        render: (args, v) => {
            const open = v.foreshadows.filter((f) => f.payoffChapter == null);
            // 叙事契约（pledge_* 动作）
            if (v.action === 'pledge_setup' || v.action === 'pledge_replan' || v.action === 'pledge_resolve') {
                const c = v.pledgeChanged;
                const label = v.action === 'pledge_setup' ? '已登记' : v.action === 'pledge_replan' ? '已改期' : `已登记为 ${c.status}`;
                const line = `${c.id}（${c.kind}·${c.subject || '全局'}）${label}：${c.statement}${c.deadlineChapter != null ? `·到期第${c.deadlineChapter}章` : ''}`;
                return textBlock(line);
            }
            if (v.action === 'pledge_list') {
                const lines = v.pledges.map((x) => `${x.id}（${x.kind}·${x.subject || '全局'}·第${x.chapter}章${x.deadlineChapter != null ? `·到期第${x.deadlineChapter}章` : ''}·${x.status}）：${x.statement}`);
                const issues = (v.pledgeIssues ?? []).map((i) => `${i.severity === 'error' ? '✗' : '⚠'} [${i.code}] ${i.message}`);
                return textBlock(`叙事契约 ${v.pledges.length} 条：\n${lines.join('\n') || '（空）'}\n${issues.length > 0 ? '到期告警：\n' + issues.join('\n') : '无到期未兑现 ✓'}`);
            }
            if (v.action === 'list') {
                const pLines = v.pledges.map((x) => `${x.id}（${x.kind}·${x.subject || '全局'}·第${x.chapter}章${x.deadlineChapter != null ? `·到期第${x.deadlineChapter}章` : ''}·${x.status}）：${x.statement}`);
                return textBlock(`伏笔 ${v.foreshadows.length} 条（未回收 ${open.length}）·叙事契约 ${v.pledges.length} 条\n${pLines.join('\n') || '（契约空）'}`);
            }
            // 写作样稿库（sample_* 动作）
            if (v.action === 'sample_add') {
                const s = v.samples[v.samples.length - 1];
                return textBlock(`样稿 ${s.id} 已登记（${s.content.length} 字·${s.scope}·${s.sceneType}·${s.sourceKind}）——默认不注入；认可进候选池用 sample_allow`);
            }
            if (v.action === 'sample_allow' || v.action === 'sample_revoke' || v.action === 'sample_remove') {
                const label = v.action === 'sample_allow' ? '已批准注入' : v.action === 'sample_revoke' ? '已撤销批准' : '已删除';
                const s = v.samples.find((x) => x.id === args.sampleId);
                return textBlock(`样稿 ${args.sampleId} ${label}；样稿库现存 ${v.samples.length} 条`);
            }
            if (v.action === 'sample_list') {
                const sLines = v.samples.map((x) => `${x.id}（${x.allowedForModelInput ? '已批准注入' : '未注入'}·${x.scope}·${x.sceneType}）${x.title ? `·${x.title}` : ''}：${x.content.slice(0, 40)}…`);
                return textBlock(`样稿库 ${v.samples.length} 条：\n${sLines.join('\n') || '（空）'}`);
            }
            if (v.action === 'sample_prompt') {
                if (!v.samplePrompt) return textBlock('样稿候选池为空（无已批准注入的样稿）——先 sample_add + sample_allow，或确认样稿已允许模型输入');
                return textBlock(`已生成 ${v.samplePoolCount} 段样稿的资料注入块（${args.samplePurpose === 'revise' ? '修订' : '新正文'}边界）；把 samplePrompt 拼进写章/润色提示词即可。样稿是资料而非指令——不得串入他人人名/地名/剧情。`);
            }
            if (v.action === 'timeline') {
                const rows = v.timeline.map((r) => `第${r.chapter}章  ${r.key}: ${r.value}${r.note ? `（${r.note}）` : ''}`);
                return textBlock(`「${args.entity}」状态演化线 ${v.timeline.length} 步：\n${rows.join('\n') || '（该实体暂无账本记录）'}`);
            }
            if (v.action === 'cognition') {
                const lines = v.cognition.map((r) => `${r.subject}${r.verb === 'knows' ? '知道' : '不知道'}「${r.info}」（第${r.chapter}章起）`);
                return textBlock(`${v.addedCount > 0 ? `认知追加 ${v.addedCount} 条；` : ''}认知账本 ${v.cognition.length} 条：\n${lines.join('\n') || '（暂无认知记录——写章时随 cognition_updates 声明，或本动作补录）'}`);
            }
            // 0.19.1（E6）：setup/payoff 给**增量确认**（changed + 在册数 + 超期清单），
            // 不再回显全量 facts 与恒 0 的「新增 0」（那两样是噪声 + 误读源）。
            if (v.action === 'foreshadow_setup' || v.action === 'foreshadow_payoff') {
                const c = v.changed;
                const state = v.action === 'foreshadow_setup'
                    ? `${c?.id ?? args.id ?? '?'} 已登记（第${c?.chapter}章${c?.plan != null ? `·预计第${c.plan}章回收` : ''}）`
                    : `${c?.id ?? args.id} 已在第${c?.payoffChapter ?? args.chapter}章回收`;
                const overdueLine = v.overdue?.length
                    ? `\n超期未回收 ${v.overdue.length} 条：${v.overdue.join('、')}——优先安排回收，别让读者忘了` : '';
                return textBlock(`${state}；未回收伏笔 ${open.length} 条：${open.map((f) => f.id).join('、') || '无'}${overdueLine}`);
            }
            const head = v.action === 'status_at'
                ? `第${args.at}章时点快照：${v.facts.length} 项`
                : `${v.action} 完成（新增 ${v.addedCount}）`;
            const lines = v.facts.slice(0, 20).map((f) => {
                // 三态在回执里必须显形：模型看不见「这条是未知的」，就会在正文里替它编一个值
                const st = f.status === 'unknown' ? '·未知' : (f.status === 'pending' ? '·待复核' : '');
                const why = f.status === 'unknown' && f.note ? `·原因：${f.note}` : '';
                return `${f.entity}·${f.key}: ${f.value}（第${f.chapter}章起${st}${why}）`;
            });
            return textBlock(`${head}\n${lines.join('\n')}\n未回收伏笔 ${open.length} 条：${open.map((f) => f.id).join('、') || '无'}`);
        },
    });
}
