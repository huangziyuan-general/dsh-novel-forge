// lib/tools/arc-tool.js — novel_arc（人物弧线账本：成长/信任度/嫌疑度等维度值随章推进）。
//
// 主线1（v1.4.0）：长篇最容易烂的不是「设定错」，是「人物弧光停走」。弧线账本把
// 「某维度第几章推进到 N」落成可代码判定的账；停走诊断（lib/arcs.js，纯函数）是
// 零 token 的硬信号，写章链命中「停走」落 major 质量债（「需重规划」档）。
// 纯逻辑在 lib/arcs.js；本工具只做 io 装配与回执裁剪（与 relation-tool 同纪律）。

import { defineTool } from './define-tool.js';
import { pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { applyArcUpdates, arcsAt, arcLastMove, diagnoseArcStall } from '../arcs.js';
import { audit, requireBook, textBlock } from './common.js';

export function defineArcTool(ctx, config) {
    return defineTool({
        name: 'novel_arc',
        description: '人物弧线账本（成长/信任度/嫌疑度/立场…维度值随章推进，区别于事实账本的「实体状态」）：'
            + 'update 登记弧线推进（多行「人物|维度|值[|趋势][|备注]」，如「主角|无畏|半信半疑地站了出来|up|关键事件」）；'
            + 'query 查**当前**各弧线读数；status_at 查**第 n 章时**的读数（时点推演，不拿最新值糊）；'
            + 'diagnose 跑全书弧线停走诊断（≥15 章未推进=stalled / 全书≥20章只推进过一次=no-move，零 token 纯函数）——'
            + '写章链命中停走会自动落 major 质量债（「需重规划」档），本工具给**人看的全书诊断**，不进每章门禁。'
            + '弧线与事实账本别混：境界/位置/持有走 novel_ledger，人物弧光维度走这里，人物**间关系**走 novel_relation。',
        parameters: {
            action: { type: 'string', required: true, enum: ['update', 'query', 'status_at', 'diagnose'], description: '四选一。' },
            book: { type: 'string', required: true, description: '书目名。' },
            updates: { type: 'string', description: 'update 必填：多行「人物|维度|值[|趋势][|备注]」。趋势可选（up/down/flat…，只透传不判定，代码不猜方向）。' },
            character: { type: 'string', description: 'query/status_at：按人物过滤（可多个用「、」分隔；省略=全书）。' },
            dimension: { type: 'string', description: 'query/status_at：按维度过滤（可多个用「、」分隔；省略=全部维度）。' },
            at: { type: 'integer', description: 'status_at 必填：时点章号——第 n 章时各弧线读数（含第 n 章）。' },
            chapter: { type: 'integer', description: 'update 必填：推进章号。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    addedCount: { type: 'integer', required: true },
                    snapshotChapter: { type: 'integer' },
                    forwardRows: { type: 'integer' },
                    arcs: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        character: { type: 'string', required: true },
                        dimension: { type: 'string', required: true },
                        value: { type: 'string', required: true },
                        chapter: { type: 'integer', required: true },
                        trend: { type: 'string' },
                        note: { type: 'string' },
                    } } },
                    stalled: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        character: { type: 'string', required: true },
                        dimension: { type: 'string', required: true },
                        lastMove: { type: 'integer', required: true },
                        gap: { type: 'integer', required: true },
                        kind: { type: 'string', required: true },
                        message: { type: 'string', required: true },
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
            let arcs = (await io.readJson(p.arcs)) ?? [];

            const view = (r) => ({
                character: r.character, dimension: r.dimension, value: String(r.value ?? ''),
                chapter: r.chapter,
                ...(r.trend !== undefined ? { trend: String(r.trend) } : {}),
                note: String(r.note ?? ''),
            });

            const parseChars = () => String(args.character ?? '').split(/[,，、\n]+/).map((x) => x.trim()).filter((x) => x !== '');
            const parseDims = () => String(args.dimension ?? '').split(/[,，、\n]+/).map((x) => x.trim()).filter((x) => x !== '');

            if (args.action === 'query' || args.action === 'status_at') {
                if (args.action === 'status_at' && !Number.isInteger(args.at)) throw new Error('status_at 需要正整数 at（时点章号）');
                const n = args.action === 'status_at' ? args.at
                    : Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
                // 多人物查询：character 过滤统一走外层——快照层只传首个人物会把其余人物静默丢掉
                // （查「张三、李四」只回张三），arcsAt 不带 character，过滤交给 includes 全集。
                const chars = parseChars();
                const snapshot = n > 0 ? n : 1;
                const rows = arcsAt(arcs, snapshot, {
                    dimensions: parseDims().length > 0 ? parseDims() : undefined,
                });
                const filtered = chars.length > 0 ? rows.filter((r) => chars.includes(r.character)) : rows;
                // 前瞻可见性：update 允许登记到 maxWritten+1（未写章新书不设限），登记在快照之后的行
                // 在快照语义下不可见——不报出来，用户只会以为「登记丢了」。快照语义本身保留
                // （正文问「现在」时，未来值不该生效）；forwardRows 只做提示，仍按 chars 过滤同口径。
                const forwardRows = arcs.filter((r) => (chars.length === 0 || chars.includes(r.character))
                    && (!Number.isInteger(r.chapter) || r.chapter > snapshot)).length;
                return {
                    book, action: args.action, addedCount: 0, arcs: filtered.map(view), stalled: [],
                    snapshotChapter: snapshot, forwardRows,
                };
            }

            if (args.action === 'diagnose') {
                const maxWritten = Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
                const stalled = diagnoseArcStall(arcs, maxWritten);
                return { book, action: 'diagnose', addedCount: 0, arcs: [], stalled: stalled.map((s) => ({
                    character: s.character, dimension: s.dimension, lastMove: s.lastMove, gap: s.gap, kind: s.kind, message: s.message,
                })) };
            }

            // update
            if (!Number.isInteger(args.chapter)) throw new Error('update 需要正整数 chapter');
            const maxWritten = Object.keys(novel.chapters ?? {}).reduce((m, k) => Math.max(m, Number(k) || 0), 0);
            if (maxWritten >= 1 && args.chapter > maxWritten + 1) {
                throw new Error(`chapter 超前：全书已写到第${maxWritten}章，弧线更新章号不得超过 ${maxWritten + 1}。写章时的弧线推进应随正文落账。`);
            }
            const lines = String(args.updates ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
            if (lines.length === 0) throw new Error('update 需要 updates（多行 人物|维度|值[|趋势][|备注]）');
            const updates = lines.map((l) => {
                const parts = l.split('|').map((x) => x.trim());
                if (parts.length < 3) throw new Error(`arc_updates 行格式错误（需要 人物|维度|值[|趋势][|备注]）：${l}`);
                if (parts[0] === '' || parts[1] === '' || parts[2] === '') throw new Error(`arc_updates 行的 人物/维度/值 都不能为空：${l}`);
                return { character: parts[0], dimension: parts[1], value: parts[2], ...(parts[3] !== '' ? { trend: parts[3] } : {}), note: parts.slice(4).join('|') };
            });
            const { arcs: nextArcs, added, skipped } = applyArcUpdates(arcs, updates, { chapter: args.chapter, now: new Date().toISOString() });
            arcs = nextArcs;
            await io.writeJson(p.arcs, arcs);
            await audit(io, p, 'arc/update', { chapter: args.chapter, added: added.length, skipped: skipped.length });
            return { book, action: 'update', addedCount: added.length, arcs: added.map(view), stalled: [] };
        },
        render: (_args, v) => {
            if (v.action === 'update') {
                const rows = v.arcs.map((r) => `${r.character}·${r.dimension}: ${r.value}（第${r.chapter}章${r.trend ? `·${r.trend}` : ''}${r.note ? `·${r.note}` : ''}）`);
                return textBlock(`弧线推进 ${v.addedCount} 条：\n${rows.join('\n') || '（无新增——同章同值幂等跳过）'}`);
            }
            if (v.action === 'diagnose') {
                if (v.stalled.length === 0) return textBlock('弧线诊断：未发现停走 ✓');
                return textBlock(`弧线停走 ${v.stalled.length} 项：\n${v.stalled.map((s) => s.message).join('\n')}`);
            }
            const rows = v.arcs.map((r) => `${r.character}·${r.dimension}: ${r.value}（第${r.chapter}章${r.trend ? `·${r.trend}` : ''}${r.note ? `·${r.note}` : ''}）`);
            // 前瞻提示：登记在快照之后的行不在本快照里（status_at 的快照=at；query 的快照=已写章号）。
            const fwd = v.forwardRows !== undefined && v.forwardRows > 0
                ? (v.action === 'status_at'
                    ? `（另有 ${v.forwardRows} 条登记在第${v.snapshotChapter}章之后、尚未生效）`
                    : `（快照：第 ${v.snapshotChapter} 章；另有 ${v.forwardRows} 条已登记未生效）`)
                : '';
            const head = (v.action === 'status_at' ? `第${_args.at}章时点弧线快照：${v.arcs.length} 项` : `当前弧线：${v.arcs.length} 项`) + (fwd ? ' ' + fwd : '');
            return textBlock(head + '\n' + (rows.join('\n') || '（该人物暂无弧线记录——novel_arc update 登记）'));
        },
    });
}

export { arcLastMove as _arcLastMove };
