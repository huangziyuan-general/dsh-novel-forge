// lib/tools/ledger-tool.js — novel_ledger（事实账本与伏笔台账）。
// 从 quality-tools.js 按工具拆出；schema 与描述原样保留。

import { defineTool } from './define-tool.js';
import { pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { applyFactUpdates, queryFacts, assertLedgerChapter, factsAt, statusTimeline, foreshadowSetup, foreshadowPayoff } from '../ledger.js';
import { audit, requireBook, parseList, parseFactLines, textBlock, foreshadowView } from './common.js';

export function defineLedgerTool(ctx, config) {
    return defineTool({
        name: 'novel_ledger',
        description: '事实账本与伏笔台账：query 查某实体/键的**当前值**；status_at 查**第 n 章时**的值（时点推演——写新章要回溯旧状态、核对「第 40 章断腿第 50 章还能跑」时用它，不能拿最新值糊）；timeline 看某实体的状态演化线（对账「这个值是哪一章改的」）；update 追加状态变化（多行「实体|键|值[|备注]」，同章改值=冲突拒绝）；foreshadow_setup 埋伏笔；foreshadow_payoff 收伏笔。人物境界/物品/地点状态一律走这里——「百万字不崩设定」的底座。',
        parameters: {
            action: { type: 'string', required: true, enum: ['query', 'status_at', 'timeline', 'update', 'foreshadow_setup', 'foreshadow_payoff'], description: '六选一。' },
            book: { type: 'string', required: true, description: '书目名。' },
            entity: { type: 'string', description: 'query / status_at：按实体过滤（人物/物品/地点名，可多个用「、」分隔）；timeline：必填，要推演的实体。' },
            key: { type: 'string', description: 'query / status_at / timeline：按键过滤（如 境界/位置/持有）。' },
            since: { type: 'integer', description: 'query：只看第 N 章及以后的变化。' },
            at: { type: 'integer', description: 'status_at 必填：时点章号——第 n 章时各实体/键是什么值（含第 n 章）。' },
            chapter: { type: 'integer', description: 'update / foreshadow_* 必填：发生章号。' },
            updates: { type: 'string', description: 'update 必填：多行「实体|键|值[|备注]」。' },
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
                        note: { type: 'string' },
                    } } },
                    foreshadows: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        id: { type: 'string', required: true }, setup: { type: 'string', required: true },
                        chapter: { type: 'integer', required: true }, plan: { type: 'integer' },
                        payoffChapter: { type: 'integer' },
                    } } },
                    timeline: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        chapter: { type: 'integer', required: true }, key: { type: 'string', required: true },
                        value: { type: 'string', required: true }, note: { type: 'string' },
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

            if (args.action === 'query') {
                // 实体支持「、」多值（与 status_at 的 parseList 对齐；0.13.6 修正——
                // 工具描述承诺了多实体，实现却把整串当单实体名过滤）
                const entities = parseList(args.entity);
                const base = { key: args.key, sinceChapter: Number.isInteger(args.since) ? args.since : undefined };
                const rows = entities.length === 0
                    ? queryFacts(facts, base)
                    : entities.flatMap((e) => queryFacts(facts, { ...base, entity: e }));
                return { book, action: 'query', addedCount: 0, facts: rows.map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, note: f.note ?? '' })), foreshadows: foreshadows.map(foreshadowView), timeline: [] };
            }
            if (args.action === 'status_at') {
                if (!Number.isInteger(args.at)) throw new Error('status_at 需要正整数 at（时点章号）');
                const rows = factsAt(facts, args.at, { entities: parseList(args.entity), keys: parseList(args.key) });
                return { book, action: 'status_at', addedCount: 0, facts: rows, foreshadows: foreshadows.map(foreshadowView), timeline: [] };
            }
            if (args.action === 'timeline') {
                if (typeof args.entity !== 'string' || args.entity.trim() === '') throw new Error('timeline 需要 entity（要推演的实体名）');
                const rows = statusTimeline(facts, args.entity.trim(), { keys: parseList(args.key) });
                return { book, action: 'timeline', addedCount: 0, facts: [], foreshadows: foreshadows.map(foreshadowView), timeline: rows };
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
                return { book, action: 'update', addedCount: added.length, facts: queryFacts(facts, {}).map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, note: f.note ?? '' })), foreshadows: foreshadows.map(foreshadowView), timeline: [] };
            }
            if (args.action === 'foreshadow_setup') {
                if (!Number.isInteger(args.chapter)) throw new Error('foreshadow_setup 需要正整数 chapter');
                const wasExisting = foreshadows.some((f) => f.id === args.id);
                foreshadows = foreshadowSetup(foreshadows, { id: args.id, setup: args.setup, chapter: args.chapter, plan: args.plan });
                await io.writeJson(p.foreshadows, foreshadows);
                await audit(io, p, wasExisting ? 'foreshadow/replan' : 'foreshadow/setup', { chapter: args.chapter, id: args.id ?? 'auto', setup: args.setup });
                return { book, action: 'foreshadow_setup', addedCount: 0, facts: queryFacts(facts, {}).map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, note: f.note ?? '' })), foreshadows: foreshadows.map(foreshadowView), timeline: [] };
            }
            // foreshadow_payoff
            if (!Number.isInteger(args.chapter)) throw new Error('foreshadow_payoff 需要正整数 chapter');
            foreshadows = foreshadowPayoff(foreshadows, args.id, args.chapter);
            await io.writeJson(p.foreshadows, foreshadows);
            await audit(io, p, 'foreshadow/payoff', { chapter: args.chapter, id: args.id });
            return { book, action: 'foreshadow_payoff', addedCount: 0, facts: queryFacts(facts, {}).map((f) => ({ entity: f.entity, key: f.key, value: f.value, chapter: f.chapter, note: f.note ?? '' })), foreshadows: foreshadows.map(foreshadowView), timeline: [] };
        },
        render: (args, v) => {
            const open = v.foreshadows.filter((f) => f.payoffChapter == null);
            if (v.action === 'timeline') {
                const rows = v.timeline.map((r) => `第${r.chapter}章  ${r.key}: ${r.value}${r.note ? `（${r.note}）` : ''}`);
                return textBlock(`「${args.entity}」状态演化线 ${v.timeline.length} 步：\n${rows.join('\n') || '（该实体暂无账本记录）'}`);
            }
            const head = v.action === 'status_at'
                ? `第${args.at}章时点快照：${v.facts.length} 项`
                : `${v.action} 完成（新增 ${v.addedCount}）`;
            const lines = v.facts.slice(0, 20).map((f) => `${f.entity}·${f.key}: ${f.value}（第${f.chapter}章起）`);
            return textBlock(`${head}\n${lines.join('\n')}\n未回收伏笔 ${open.length} 条：${open.map((f) => f.id).join('、') || '无'}`);
        },
    });
}
