// lib/tools/ledger-tool.js — novel_ledger（事实账本与伏笔台账）。
// 从 quality-tools.js 按工具拆出；schema 与描述原样保留。

import { defineTool } from './define-tool.js';
import { pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { applyFactUpdates, queryFacts, assertLedgerChapter, factsAt, statusTimeline, foreshadowSetup, foreshadowPayoff, openForeshadows, overdueForeshadows } from '../ledger.js';
import { parseCognitionLines, applyCognitionUpdates, cognitionView, cognitionFlatRows } from '../cognition.js';
import { audit, requireBook, parseList, parseFactLines, textBlock, foreshadowView } from './common.js';

export function defineLedgerTool(ctx, config) {
    return defineTool({
        name: 'novel_ledger',
        description: '事实账本与伏笔台账：query 查某实体/键的**当前值**；status_at 查**第 n 章时**的值（时点推演——写新章要回溯旧状态、核对「第 40 章断腿第 50 章还能跑」时用它，不能拿最新值糊）；timeline 看某实体的状态演化线（对账「这个值是哪一章改的」）；update 追加状态变化（多行「实体|键|值[|备注][|状态]」，同章改值=冲突拒绝；状态三态 confirmed/unknown/pending——**设定还没定的写 unknown 并写明原因**，正文不会去补它）；foreshadow_setup 埋伏笔；foreshadow_payoff 收伏笔；list 列出全部伏笔（id/埋设章/预计回收章/是否已收）——payoff 前拿 id 用；cognition 认知账本（不带 updates = 视图：谁知道/不知道什么、读者已知；带 updates = 追加，多行「谁|知道|信息」——写章时随 novel_write_chapter 的 cognition_updates 声明，本动作用于补录与订正）。人物境界/物品/地点状态一律走这里——「百万字不崩设定」的底座。',
        parameters: {
            action: { type: 'string', required: true, enum: ['query', 'status_at', 'timeline', 'update', 'foreshadow_setup', 'foreshadow_payoff', 'list', 'cognition'], description: '八选一。' },
            book: { type: 'string', required: true, description: '书目名。' },
            entity: { type: 'string', description: 'query / status_at：按实体过滤（人物/物品/地点名，可多个用「、」分隔）；timeline：必填，要推演的实体。' },
            key: { type: 'string', description: 'query / status_at / timeline：按键过滤（如 境界/位置/持有）。' },
            since: { type: 'integer', description: 'query：只看第 N 章及以后的变化。' },
            at: { type: 'integer', description: 'status_at 必填：时点章号——第 n 章时各实体/键是什么值（含第 n 章）。' },
            chapter: { type: 'integer', description: 'update / foreshadow_* 必填：发生章号。' },
            updates: { type: 'string', description: 'update 必填：多行「实体|键|值[|备注][|状态]」。状态三态：confirmed（已确认，默认）/ unknown（设定未定，**必须写明原因**，正文不会去补它）/ pending（待复核）。cognition 动作下可选：多行「谁|知道|信息」或「谁|不知道|信息」——给了就追加进认知账本，不给则返回认知视图。' },
            setup: { type: 'string', description: 'foreshadow_setup 必填：伏笔描述。' },
            plan: { type: 'integer', description: 'foreshadow_setup 可选：预计回收章号。briefing 会对超期未回收的伏笔告警。' },
            id: { type: 'string', description: 'foreshadow_* 必填：伏笔 id（setup 可省略自动编号）。' },
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
                    // 认知账本（cognition 动作）：当前视图的行（subject/verb/info/chapter）
                    cognition: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        subject: { type: 'string', required: true },
                        verb: { type: 'string', required: true },
                        info: { type: 'string', required: true }, chapter: { type: 'integer', required: true },
                    } } },
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

            if (args.action === 'list') {
                // W5（真机《深夜订单》监控）：伏笔 id 只在 setup 返回体/简报文本里出现，
                // 事后补收（payoff）拿不到 id——list 给一条稳定的取 id 通道。
                return { book, action: 'list', addedCount: 0, facts: [], foreshadows: foreshadows.map(foreshadowView), timeline: [], cognition: [] };
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
            // foreshadow_payoff
            if (!Number.isInteger(args.chapter)) throw new Error('foreshadow_payoff 需要正整数 chapter');
            foreshadows = foreshadowPayoff(foreshadows, args.id, args.chapter);
            await io.writeJson(p.foreshadows, foreshadows);
            await audit(io, p, 'foreshadow/payoff', { chapter: args.chapter, id: args.id });
            // 同 setup：单条回收不回显全量 facts；changed 带回收后的状态，overdue 带剩余超期
            const changed = foreshadows.find((f) => f.id === args.id);
            const maxWritten = Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
            const overdue = overdueForeshadows(foreshadows, maxWritten).map((f) => f.id);
            return {
                book, action: 'foreshadow_payoff', addedCount: 0, facts: [],
                foreshadows: foreshadows.map(foreshadowView), timeline: [], cognition: [],
                ...(changed ? { changed: foreshadowView(changed) } : {}),
                ...(overdue.length > 0 ? { overdue } : {}),
            };
        },
        render: (args, v) => {
            const open = v.foreshadows.filter((f) => f.payoffChapter == null);
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
