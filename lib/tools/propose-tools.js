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
        description: '修改提案制：propose 对已存章节提交修订稿（生成提案 id，**不改正文**）；list 列出提案（含每条基于哪一版、本章现在到哪一版）。**通道边界**：想自己动手改稿就直接用 novel_write_chapter（同章追加新版本，旧版永不覆盖——机审驳回后的重写也走它）；本工具是「把修订登记下来、等用户批准」的那条路。apply（应用）与 discard（丢弃）是**用户主权动作**，工具面不提供：提完提案请明确告知用户「到锻炉面板点应用」，不要声称提案已生效。同一章已有 pending 提案时不要重复提新的——先在面板应用或丢弃。',
        parameters: {
            action: { type: 'string', required: true, enum: ['propose', 'list'], description: 'propose 提交修订提案；list 列出已有提案。apply/discard/prune 由用户在面板操作，工具面不提供。' },
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', description: 'propose 必填：要修订的章号。' },
            content: { type: 'string', description: 'propose 必填：修订后的整章正文（引号一律用弯引号“”‘’，不用直角引号「」『』——登记与应用时自动转换）。' },
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
                    // 基线（T1）：提案基于本章哪一版生成的。schema 是 integer，
                    // 所以 null/undefined 一律不进响应（见 lib/proposals.js 的携带条件）。
                    baseVersion: { type: 'integer' },
                    proposals: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        id: { type: 'string', required: true }, chapter: { type: 'integer', required: true },
                        status: { type: 'string', required: true }, createdAt: { type: 'string', required: true },
                        title: { type: 'string' }, missing: { type: 'boolean' },
                        reason: { type: 'string' }, preview: { type: 'string' },
                        // 这条提案基于 v(baseVersion)，而本章现在是 v(latestVersion)——
                        // 两个数一起给，面板与模型都能自己看出「这条已经陈旧」。
                        baseVersion: { type: 'integer' }, latestVersion: { type: 'integer' },
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
                ? `提案已登记：${v.id}（第${v.chapter}章，pending）——**尚未改动正文**。请到「锻炉」面板点「应用」才会生成新版本；应用后的新版本同样自动送达，无需调用宿主 present。`
                : `提案 ${v.proposals.length} 条：${v.proposals.map((x) => `${x.id}(${x.status})`).join('、') || '无'}`
        ),
    });
}
