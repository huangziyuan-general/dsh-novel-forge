// lib/tools/quality-tool.js — novel_quality（书级质量债视图与结清）。
//
// 补的是门禁体系的**书级视角**：门禁只有 blocking/warnings 两档 + 章级熔断。
// 熔断是章级的（同章驳回 3 次锁死）——没问题；但缺书级视角：第 30 章有个
// 非致命瑕疵，不该让作者觉得整本书写不下去了。`noai` 扣分、平台审稿的警告项、
// 被 force 放行的硬门禁，本质上就该是**记着的债**，而不是「必须当场清零的失败」。
//
// 三级口径（与竞品 C 同名同义，但**不改既有落盘口径**——那是门禁的事）：
//   minor 质量债     defer_and_continue —— 局部瑕疵，正文保留，继续写下一章
//   major 需重规划   stop_for_replan    —— 影响后续章节结构，建议停下调整
//   hard  硬门禁放行 hard_gate          —— 本该拒稿、被 force 放行，必须回头核对
//
// 债的来源是写章链（lib/chapter-commit.js）：每个警告项落成一条结构化条目，
// 落在 novel.json.quality.debts[章号]。本工具只**读**与**结清**，不判定——
// 判定永远在写章链里（模型看不到本工具就自己判，等于把门禁交给自觉）。

import { defineTool } from './define-tool.js';
import { pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd, updateJson } from '../fsio.js';
import { requireBook, textBlock, audit } from './common.js';
import { bookQualityView, DEBT_LEVELS } from '../quality-debt.js';

/** worst 只给「哪章 + 哪档」——明细在 chapters 里，不在 worst 里重复一份
 *  （output.schema 是 additionalProperties:false，多带字段会被宿主校验器判违规）。 */
function worstOf(view) {
    const w = view?.worst;
    if (w === null || w === undefined) return undefined;
    return { chapter: w.chapter, level: w.level };
}

export function defineQualityTool(ctx, config) {
    return defineTool({
        name: 'novel_quality',
        description: '书级质量债：view 看这本书欠了多少账、最重的是哪章、现在该不该停下重规划；settle 结清某章的债（改了正文/改了设定就结掉，别让账越积越多）。'
            + '三级口径——minor 质量债（局部瑕疵，可以欠着，继续写下一章）/ major 需重规划（影响后续章节结构，建议停下调整）/ hard 硬门禁放行（本该拒稿、被 force 放行，必须回头核对）。'
            + '**局部瑕疵不等于这本书写不下去了**：view 的 actionable 会直接告诉你能不能继续写。',
        parameters: {
            action: { type: 'string', required: true, enum: ['view', 'settle'], description: '二选一：view 看账；settle 结清某章的债。' },
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', description: 'settle 必填：要结清的章号。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    total: { type: 'integer', required: true },
                    byLevel: { type: 'object', required: true, additionalProperties: false, properties: {
                        minor: { type: 'integer', required: true },
                        major: { type: 'integer', required: true },
                        hard: { type: 'integer', required: true },
                    } },
                    chapters: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        chapter: { type: 'integer', required: true },
                        level: { type: 'string', required: true },
                        items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                            code: { type: 'string', required: true },
                            level: { type: 'string', required: true },
                            message: { type: 'string', required: true },
                            chapter: { type: 'integer', required: true },
                            ts: { type: 'string', required: true },
                        } } },
                    } } },
                    // worst 只给「哪章 + 哪档」——明细在 chapters 里，不重复带一遍
                    worst: { type: 'object', additionalProperties: false, properties: {
                        chapter: { type: 'integer', required: true },
                        level: { type: 'string', required: true },
                    } },
                    actionable: { type: 'string', required: true },
                    settled: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                        chapter: { type: 'integer', required: true },
                        count: { type: 'integer', required: true },
                        at: { type: 'string', required: true },
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

            const settledOf = (n) => {
                const raw = novel?.quality?.settled?.[String(n)];
                const arr = Array.isArray(raw) ? raw : [];
                const last = arr[arr.length - 1];
                return { chapter: n, count: Number(last?.count ?? 0) || 0, at: String(last?.at ?? '') };
            };

            if (args.action === 'settle') {
                const n = args.chapter;
                if (!Number.isInteger(n) || n < 1) throw new Error('settle 需要 chapter（正整数）');
                const items = Array.isArray(novel?.quality?.debts?.[String(n)]) ? novel.quality.debts[String(n)] : [];
                if (items.length === 0) {
                    const view0 = bookQualityView(novel);
                    return {
                        book, action: 'settle', total: view0.total, byLevel: view0.byLevel,
                        chapters: view0.chapters, worst: view0.worst ?? undefined,
                        actionable: `第${n}章没有未结的债，无需结清。`,
                        settled: Object.keys(novel?.quality?.settled ?? {}).map((k) => settledOf(Number(k))).filter((x) => x.chapter > 0),
                    };
                }
                const at = new Date().toISOString();
                const count = items.length;
                // 结清 = 把这章的债移出账本、记一笔结清记录（正文不动，账清）。
                // 增量合入走 updateJson：并发写同书时不拿启动时快照整体回写。
                await updateJson(io, p.meta, (latest) => {
                    if (latest === undefined) throw new Error(`书目不存在（结清中途被删？）：${p.meta}`);
                    const debts = { ...(latest.quality?.debts ?? {}) };
                    const prev = Array.isArray(debts[String(n)]) ? debts[String(n)] : [];
                    debts[String(n)] = [];
                    const settled = { ...(latest.quality?.settled ?? {}) };
                    const log = Array.isArray(settled[String(n)]) ? settled[String(n)] : [];
                    settled[String(n)] = [...log, { at, count: prev.length }];
                    latest.quality = { ...(latest.quality ?? {}), debts, settled };
                    latest.updatedAt = at;
                    return { value: latest, result: latest };
                });
                try {
                    await audit(io, p, 'quality/settled', { chapter: n, count });
                } catch { /* 审计是旁证，写不进不阻断结清 */ }
                const fresh = await io.readJson(p.meta);
                const view = bookQualityView(fresh ?? novel);
                return {
                    book, action: 'settle', total: view.total, byLevel: view.byLevel,
                    chapters: view.chapters, ...(view.worst ? { worst: worstOf(view) } : {}),
                    actionable: `第${n}章的 ${count} 笔债已结清。${view.actionable}`,
                    settled: Object.keys(fresh?.quality?.settled ?? {}).map((k) => settledOf(Number(k))).filter((x) => x.chapter > 0),
                };
            }

            const view = bookQualityView(novel);
            return {
                book, action: 'view', total: view.total, byLevel: view.byLevel,
                chapters: view.chapters, ...(view.worst ? { worst: worstOf(view) } : {}),
                actionable: view.actionable,
                settled: Object.keys(novel?.quality?.settled ?? {}).map((k) => settledOf(Number(k))).filter((x) => x.chapter > 0),
            };
        },
        render: (_args, v) => textBlock(
            `质量债：共 ${v.total} 笔（minor ${v.byLevel.minor} / major ${v.byLevel.major} / hard ${v.byLevel.hard}）`
            + `\n${v.actionable}`
            + (v.chapters.length > 0
                ? `\n\n明细：\n${v.chapters.map((c) => `第${c.chapter}章［${DEBT_LEVELS[c.level]?.name ?? c.level}］${c.items.map((i) => i.message).join('；')}`).join('\n')}`
                : '')
            + (v.settled.length > 0 ? `\n\n已结清：${v.settled.map((s) => `第${s.chapter}章 ${s.count} 笔`).join('、')}` : ''),
        ),
    });
}
