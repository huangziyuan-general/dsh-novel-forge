// lib/tools/relation-tool.js — novel_relation（关系账本：人物/组织间的关系状态线）。
//
// 主线1（v1.4.0）：事实账本记「实体的状态」，关系账本记「两个实体之间的关系」。
// 纯逻辑在 lib/relations.js（纯函数名单成员）；本工具只做 io 装配与回执裁剪
// （单条增删改不回显全量——与 ledger-tool 的 E6 纪律同口径，省 token）。

import { defineTool } from './define-tool.js';
import { pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { applyRelationUpdates, relationsAt, relationTimelineOf, latestRelationRows } from '../relations.js';
import { audit, requireBook, parseList, textBlock } from './common.js';

export function defineRelationTool(ctx, config) {
    return defineTool({
        name: 'novel_relation',
        description: '关系账本（人物/组织间的关系状态线，事实账本管「实体状态」、本工具管「实体间关系」）：'
            + 'update 登记关系推进（多行「A|B|维度|值[|备注]」，同章同对同维度改值=冲突拒绝，(A,B) 与 (B,A) 是同一对自动归一）；'
            + 'query 查某对/全书的**当前**关系；status_at 查**第 n 章时**的关系（时点推演——写新章回溯旧关系不能拿最新值糊）；'
            + 'timeline 看某对某维度的演化线（对账「哪一章翻的脸」）。'
            + '关系矛盾（正文仍按旧值写）由内容门禁每章 warning 点名；长线关系停走（≥20 章未推进）由全书深扫 warning。'
            + '人物境界/位置走事实账本（novel_ledger），人物**弧光维度**走弧线账本（novel_arc），三者别混。',
        parameters: {
            action: { type: 'string', required: true, enum: ['update', 'query', 'status_at', 'timeline'], description: '四选一。' },
            book: { type: 'string', required: true, description: '书目名。' },
            updates: { type: 'string', description: 'update 必填：多行「A|B|维度|值[|备注]」，如「秦岚|陆征|立场|盟友|第45章翻脸前夜」。' },
            a: { type: 'string', description: 'query/status_at/timeline：实体 A（可与 B 互换——(A,B) 与 (B,A) 自动归一同一对）。' },
            b: { type: 'string', description: 'query/status_at/timeline：实体 B。' },
            dimension: { type: 'string', description: 'query/status_at/timeline：关系维度（盟友/仇敌/师徒/信任度…，可多个用「、」分隔；省略=全部维度）。' },
            at: { type: 'integer', description: 'status_at 必填：时点章号——第 n 章时各对/维度是什么值（含第 n 章）。' },
            chapter: { type: 'integer', description: 'update 必填：发生章号。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    addedCount: { type: 'integer', required: true },
                    relations: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        a: { type: 'string', required: true }, b: { type: 'string', required: true },
                        relation: { type: 'string', required: true }, value: { type: 'string', required: true },
                        chapter: { type: 'integer', required: true }, note: { type: 'string' },
                    } } },
                    timeline: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        chapter: { type: 'integer', required: true }, value: { type: 'string', required: true }, note: { type: 'string' },
                    } } },
                    changed: { type: 'object', additionalProperties: false, properties: {
                        a: { type: 'string', required: true }, b: { type: 'string', required: true },
                        relation: { type: 'string', required: true }, value: { type: 'string', required: true },
                        chapter: { type: 'integer', required: true }, note: { type: 'string' },
                    } },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            let relations = (await io.readJson(p.relations)) ?? [];

            const view = (r) => ({
                a: r.a, b: r.b, relation: r.relation, value: String(r.value ?? ''),
                chapter: r.chapter, note: String(r.note ?? ''),
            });

            if (args.action === 'query' || args.action === 'status_at') {
                if (args.action === 'status_at' && !Number.isInteger(args.at)) {
                    throw new Error('status_at 需要正整数 at（时点章号）');
                }
                const n = args.action === 'status_at' ? args.at : Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
                // 成对 guard：只给 a 或只给 b 会落到 relationPair 报「实体名不能为空」——响亮但费解，这里前置说清。
                if ((args.a !== undefined) !== (args.b !== undefined)) {
                    throw new Error('query/status_at 需要 a 与 b 成对给出（都不给 = 查全书关系；单条关系的演化线用 timeline）');
                }
                const pair = (args.a !== undefined) ? [args.a, args.b] : null;
                const rows = relationsAt(relations, n > 0 ? n : 1, {
                    pair, relations: parseList(args.dimension).length > 0 ? parseList(args.dimension) : undefined,
                });
                return { book, action: args.action, addedCount: 0, relations: rows.map(view), timeline: [] };
            }

            if (args.action === 'timeline') {
                if (typeof args.a !== 'string' || typeof args.b !== 'string' || args.a.trim() === '' || args.b.trim() === '') {
                    throw new Error('timeline 需要 a 与 b（要推演的关系对）');
                }
                const dims = parseList(args.dimension);
                if (dims.length === 0) throw new Error('timeline 需要 dimension（关系维度）');
                const rows = relationTimelineOf(args.a.trim(), args.b.trim(), dims[0], relations);
                return { book, action: 'timeline', addedCount: 0, relations: [], timeline: rows.map((r) => ({ chapter: r.chapter, value: r.value, note: r.note })) };
            }

            // update
            if (!Number.isInteger(args.chapter)) throw new Error('update 需要正整数 chapter');
            const maxWritten = Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
            if (maxWritten >= 1 && args.chapter > maxWritten + 1) {
                throw new Error(`chapter 超前：全书已写到第${maxWritten}章，关系更新章号不得超过 ${maxWritten + 1}。写章时的关系变化应随正文落账。`);
            }
            const lines = String(args.updates ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
            if (lines.length === 0) throw new Error('update 需要 updates（多行 A|B|维度|值[|备注]）');
            const updates = lines.map((l) => {
                const parts = l.split('|').map((x) => x.trim());
                if (parts.length < 4) throw new Error(`relation_updates 行格式错误（需要 A|B|维度|值[|备注]）：${l}`);
                if (parts[0] === '' || parts[1] === '' || parts[2] === '' || parts[3] === '') {
                    throw new Error(`relation_updates 行的 A/B/维度/值 都不能为空：${l}`);
                }
                return { a: parts[0], b: parts[1], relation: parts[2], value: parts[3], note: parts.slice(4).join('|') };
            });
            const { relations: nextRels, added, conflicts } = applyRelationUpdates(relations, updates, { chapter: args.chapter, now: new Date().toISOString() });
            if (conflicts.length > 0) throw new Error(`关系账本冲突，未写入：${conflicts.map((c) => c.reason).join('；')}`);
            relations = nextRels;
            await io.writeJson(p.relations, relations);
            await audit(io, p, 'relation/update', { chapter: args.chapter, added: added.length });
            // E6 同款纪律：单条回执不回显全量（全量走 query）
            return { book, action: 'update', addedCount: added.length, relations: added.map(view), timeline: [] };
        },
        render: (_args, v) => {
            if (v.action === 'update') {
                return textBlock(`关系落账 ${v.addedCount} 条：\n${v.relations.map((r) => `${r.a}↔${r.b}·${r.relation}: ${r.value}（第${r.chapter}章起${r.note ? `·${r.note}` : ''}）`).join('\n') || '（无新增——同值幂等跳过）'}`);
            }
            if (v.action === 'timeline') {
                const rows = v.timeline.map((r) => `第${r.chapter}章  ${r.value}${r.note ? `（${r.note}）` : ''}`);
                return textBlock(`「${_args.a}↔${_args.b}·${_args.dimension}」演化线 ${v.timeline.length} 步：\n${rows.join('\n') || '（该维度暂无记录）'}`);
            }
            const rows = v.relations.map((r) => `${r.a}↔${r.b}·${r.relation}: ${r.value}（第${r.chapter}章起${r.note ? `·${r.note}` : ''}）`);
            return textBlock(`${v.action === 'status_at' ? `第${_args.at}章时点关系快照：${v.relations.length} 项` : `当前关系：${v.relations.length} 项`}\n${rows.join('\n') || '（该对暂无关系记录）'}`);
        },
    });
}

export { latestRelationRows as _latestRelationRows };
