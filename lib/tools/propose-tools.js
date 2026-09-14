// lib/tools/propose-tools.js — novel_propose：修改提案制（propose / list）。
//
// 门禁设计（第一批融合 · A1）：**工具面只有 propose 与 list**。
//   · 模型能做的：提提案、看提案列表；
//   · 模型**不能**做的：apply（应用）/ discard（丢弃）/ prune（清理）。
// apply 一类是用户主权动作，只从 REST 端点（锻炉面板按钮）进入——
// 见 lib/proposals.js 与 lib/server-api.js 的 /proposals 路由。
//
// 于是「模型无法自己批准自己的提案」成为**工具层保证**，不再依赖 persona 自觉：
// 想改已存章节，模型只能出提案，用户点「应用」才生成新版本。

import { defineTool } from './define-tool.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { requireBook, textBlock } from './common.js';
import { proposeRevision, listProposals } from '../proposals.js';

export function defineProposeTool(ctx, config) {
    return defineTool({
        name: 'novel_propose',
        description: '修改提案制：propose 对已存章节提交修订稿（生成提案 id，不改正文）；list 列出提案。禁止直接重写已存章节。注意：应用提案（apply）是**用户主权动作**，你没有这个工具——提完提案后请明确告知用户「到锻炉面板点应用」，不要声称提案已生效。',
        parameters: {
            action: { type: 'string', required: true, enum: ['propose', 'list'], description: 'propose 提交修订提案；list 列出已有提案。apply/discard/prune 由用户在面板操作，工具面不提供。' },
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', description: 'propose 必填：要修订的章号。' },
            content: { type: 'string', description: 'propose 必填：修订后的整章正文。' },
            reason: { type: 'string', description: 'propose：修订原因（进入审计）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    id: { type: 'string' },
                    chapter: { type: 'integer' },
                    status: { type: 'string' },
                    proposals: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        id: { type: 'string', required: true }, chapter: { type: 'integer', required: true },
                        status: { type: 'string', required: true }, createdAt: { type: 'string', required: true },
                    } } },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            // requireBook 负责「书存在」校验 + 会话归属补录（面板按会话列书靠它）。
            await requireBook(io, book);

            if (args.action === 'list') return listProposals(io, book);
            return proposeRevision(io, book, args, config);
        },
        render: (_args, v) => textBlock(
            v.action === 'propose'
                ? `提案已登记：${v.id}（第${v.chapter}章，pending）——**尚未改动正文**。请到「锻炉」面板点「应用」才会生成新版本。`
                : `提案 ${v.proposals.length} 条：${v.proposals.map((x) => `${x.id}(${x.status})`).join('、') || '无'}`
        ),
    });
}
