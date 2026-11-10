// novel_extract：旧稿 → 人物/世界书候选提案。只能创建，应用钥匙留在 REST 用户面。

import { defineTool } from './define-tool.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { requireBook, textBlock } from './common.js';
import { buildExtractionPrompt, EXTRACTION_SYSTEM, parseExtractionDetails, selectExtractionChapters } from '../extraction.js';
import { readChapterTexts } from '../chapter-io.js';
import { captureExtractionTargets, submitExtractionProposal } from '../extraction-io.js';

export function defineExtractionTool(ctx, config, { engine } = {}) {
    return defineTool({
        name: 'novel_extract',
        description: '从本书已存旧稿抽取人物卡、别名与世界书候选。复用 annotate 模型通道；每条必须有经代码逐字核验的章节原文证据。结果只落待批提案，绝不直接改人物或世界书；用户在锻炉面板逐项编辑、选择并应用。',
        parameters: {
            book: { type: 'string', required: true, description: '书目名。' },
            from: { type: 'integer', description: '起始章号，缺省为本书首章。' },
            to: { type: 'integer', description: '结束章号，缺省为起始章起最多 3 章；单次最多 5 章。' },
            kind: { type: 'string', enum: ['all', 'character', 'worldbook'], description: '抽取类型，缺省 all。' },
        },
        output: {
            schema: {
                type: 'object', additionalProperties: false, properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    proposalId: { type: 'string', required: true },
                    count: { type: 'integer', required: true },
                    from: { type: 'integer', required: true },
                    to: { type: 'integer', required: true },
                    syntaxRepaired: { type: 'boolean', required: true },
                    items: { type: 'array', required: true, items: {
                        type: 'object', additionalProperties: false, properties: {
                            id: { type: 'string', required: true }, kind: { type: 'string', required: true },
                            name: { type: 'string', required: true }, chapter: { type: 'integer', required: true },
                            quote: { type: 'string', required: true },
                        },
                    } },
                    rejected: { type: 'array', required: true, items: {
                        type: 'object', additionalProperties: false, properties: {
                            index: { type: 'integer', required: true },
                            name: { type: 'string', required: true },
                            reason: { type: 'string', required: true },
                        },
                    } },
                    note: { type: 'string', required: true },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            if (engine === null || engine === undefined) throw new Error('档案抽取需要模型引擎；当前环境不可用');
            const book = assertBookName(args.book);
            const kind = args.kind ?? 'all';
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const { novel, p } = await requireBook(io, book);
            // 复用 chapter-io 的唯一读全书实现（dashboard/insights 同源），不再手拼
            // chapterRelPath + readText 的第二份循环——两份实现迟早会漂移。
            // readChapterTexts 只回 { n, text }，标题仍从 novel.json 取。
            const titleByN = new Map(Object.entries(novel.chapters ?? {})
                .map(([k, rec]) => [Number(k), rec?.title ?? `第${Number(k)}章`]));
            const chapters = (await readChapterTexts(io, book, novel))
                .map((row) => ({ n: row.n, title: titleByN.get(row.n) ?? `第${row.n}章`, content: row.text }));
            const selected = selectExtractionChapters(chapters, { from: args.from, to: args.to });
            const result = await engine.run('annotate', {
                system: EXTRACTION_SYSTEM,
                prompt: buildExtractionPrompt({ title: novel.title ?? book, chapters: selected, kind }),
                maxTokens: 4096, timeoutMs: 180000, signal: exec?.signal,
            });
            if (!result.ok) {
                const failure = result.error ?? {};
                throw new Error(`档案抽取模型调用失败（${failure.code ?? 'ENGINE_FAILURE'}）：${failure.message ?? '未知错误'}${failure.advice ? `；${failure.advice}` : ''}`);
            }
            const parsed = parseExtractionDetails(result.text, { chapters: selected, kind });
            if (parsed.items.length === 0) throw new Error('模型没有找到有充分原文证据的候选，未创建空提案');
            const items = await captureExtractionTargets(io, p, parsed.items);
            const from = selected[0].n;
            const to = selected[selected.length - 1].n;
            const proposal = await submitExtractionProposal(io, p, { items, from, to, actor: 'agent' });
            return {
                book, action: 'extract', proposalId: proposal.id, count: items.length, from, to,
                syntaxRepaired: parsed.syntaxRepaired,
                items: items.map((item) => ({ id: item.id, kind: item.kind, name: item.name, chapter: item.chapter, quote: item.quote })),
                rejected: parsed.rejected ?? [],
                note: `已创建档案抽取提案 ${proposal.id}（${items.length} 条${parsed.rejected?.length ? `；另有 ${parsed.rejected.length} 条未通过校验被跳过` : ''}）。正式人物卡与世界书尚未修改；请在锻炉面板逐项核对、编辑并应用。`,
            };
        },
        render: (_args, value) => textBlock(`${value.note}\n${value.items.map((item) => `- ${item.id} ${item.kind === 'character' ? '人物' : '设定'}「${item.name}」：第 ${item.chapter} 章「${item.quote}」`).join('\n')}`),
    });
}
