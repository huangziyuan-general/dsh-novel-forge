// lib/tools/propose-tools.js — novel_propose：修改提案制（propose / list / apply）。
// 「Agent 不会绕过工作台偷偷覆盖正文」：对已存章节的任何修改，先落提案文件，
// 用户确认后 apply 才生成新版本（旧版永远保留）。

import { defineTool } from './define-tool.js';
import { pathsFor, chapterRecord } from '../store.js';
import { nextVersion } from '../versioning.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { advanceStage } from '../gate.js';
import { audit, requireBook, saveBook, textBlock } from './common.js';
import { computeAudit, auditVerdict } from '../audit.js';

export function defineProposeTool(ctx, config) {
    return defineTool({
        name: 'novel_propose',
        description: '修改提案制：propose 对已存章节提交修订稿（生成提案 id，不改正文）；list 列出；apply 由用户确认后把提案变成新版本（第N章-标题-vK+1，旧版保留）；prune 清理已终态（非 pending）提案的索引引用。禁止直接重写已存章节。',
        parameters: {
            action: { type: 'string', required: true, enum: ['propose', 'list', 'apply', 'prune'], description: 'propose 提交提案；list 列出；apply 应用提案（需用户确认过）；prune 清理已终态提案索引。' },
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', description: 'propose 必填：要修订的章号。' },
            content: { type: 'string', description: 'propose 必填：修订后的整章正文。' },
            reason: { type: 'string', description: 'propose：修订原因（进入审计）。' },
            proposal_id: { type: 'string', description: 'apply 必填：提案 id。' },
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
                    path: { type: 'string' },
                    version: { type: 'integer' },
                    chars: { type: 'integer' },
                    warnings: { type: 'array', items: { type: 'string' } },
                    removed: { type: 'integer' },
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
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            novel.proposals = novel.proposals ?? [];

            if (args.action === 'propose') {
                if (!Number.isInteger(args.chapter)) throw new Error('propose 需要正整数 chapter');
                const rec = novel.chapters?.[String(args.chapter)];
                if (rec === undefined) throw new Error(`第${args.chapter}章尚未保存——初稿直接走 novel_write_chapter，无需提案`);
                if (typeof args.content !== 'string' || args.content.trim() === '') throw new Error('propose 需要 content（修订后的整章正文）');
                const a = computeAudit({ content: args.content, previous: [], terms: [] });
                if (a.chars < config.minChapterChars || a.chars > config.maxChapterChars) {
                    throw new Error(`修订稿 ${a.chars} 字超出上下限（${config.minChapterChars}-${config.maxChapterChars}），未生成提案`);
                }
                const id = `P${args.chapter}-${Date.now().toString(36)}`;
                const proposal = {
                    id, book, chapter: args.chapter, reason: args.reason ?? '',
                    status: 'pending', createdAt: new Date().toISOString(), content: args.content.trimEnd(),
                };
                await io.writeJson(p.proposal(id), proposal, 'create');
                novel.proposals.push({ id, chapter: args.chapter, status: 'pending', createdAt: proposal.createdAt });
                await saveBook(io, p, novel);
                await audit(io, p, 'propose/create', { id, chapter: args.chapter, reason: proposal.reason });
                return { book, action: 'propose', id, chapter: args.chapter, status: 'pending' };
            }

            if (args.action === 'list') {
                return {
                    book, action: 'list',
                    proposals: novel.proposals.map((x) => ({ id: x.id, chapter: x.chapter, status: x.status, createdAt: x.createdAt })),
                };
            }

            // prune —— 清理已终态（非 pending）提案的索引引用。
            // 宿主 fs 无删除原语（resolve/stat/readText/writeText），真文件无法物理删，
            // 故保留为冷归档（.novel/proposals/*.json 不再被 novel.json.proposals 追踪）。
            if (args.action === 'prune') {
                const keep = novel.proposals.filter((x) => x.status === 'pending');
                const removed = novel.proposals.length - keep.length;
                if (removed > 0) {
                    novel.proposals = keep;
                    await saveBook(io, p, novel);
                    await audit(io, p, 'propose/prune', { removed });
                }
                return {
                    book, action: 'prune', removed,
                    proposals: novel.proposals.map((x) => ({ id: x.id, chapter: x.chapter, status: x.status, createdAt: x.createdAt })),
                };
            }

            // apply —— 用户确认后的版本升级
            const idx = novel.proposals.findIndex((x) => x.id === args.proposal_id);
            if (idx === -1) throw new Error(`提案不存在：${args.proposal_id}（novel_propose list 查看）`);
            const entry = novel.proposals[idx];
            if (entry.status !== 'pending') throw new Error(`提案 ${entry.id} 状态为 ${entry.status}，不可再次应用`);
            const proposal = await io.readJson(p.proposal(entry.id));
            if (proposal === null) throw new Error(`提案文件缺失：${p.proposal(entry.id)}`);

            const n = proposal.chapter;
            const rec = novel.chapters?.[String(n)];
            if (rec === undefined) throw new Error(`第${n}章记录缺失，提案失效`);
            const names = (rec.files ?? []).map((f) => f.file.split('/').pop() ?? '');
            const version = nextVersion(names, n);
            const rel = p.chapterFile(n, rec.title, version);
            await io.writeText(rel, `${proposal.content.trimEnd()}\n`, 'create');

            novel.chapters[String(n)] = chapterRecord(
                { title: rec.title, versions: rec.versions, files: rec.files },
                { title: rec.title, version, file: rel, chars: proposal.content.replace(/\s/g, '').length, summary: rec.summary }
            );
            entry.status = 'applied';
            advanceStage(novel, 'revising');
            await saveBook(io, p, novel);
            await audit(io, p, 'propose/apply', { id: entry.id, chapter: n, version, file: rel });

            // 应用提案后跑一次机审，给 warnings 不拦截（修订通常针对具体问题）。
            const window = Number.isInteger(config.repetitionWindow) && config.repetitionWindow >= 1 ? config.repetitionWindow : 10;
            const auditChapterKeys = Object.keys(novel.chapters ?? {}).map(Number).filter((k) => k < n).sort((a, b) => b - a).slice(0, window);
            const auditPrevious = [];
            for (const k of auditChapterKeys) {
                const prevRec = novel.chapters[String(k)];
                if (prevRec?.path === undefined) continue;
                const text = await io.readText(prevRec.path);
                if (text !== null) auditPrevious.push({ chapter: k, content: text });
            }
            const a = computeAudit({ content: proposal.content, previous: auditPrevious, terms: [] });
            const verdict = auditVerdict(a, config);
            return {
                book, action: 'apply', id: entry.id, chapter: n, status: 'applied',
                path: rel, version, chars: a.chars, warnings: verdict.warnings,
            };
        },
        render: (_args, v) => textBlock(
            v.action === 'propose' ? `提案已登记：${v.id}（第${v.chapter}章，pending）——等待用户确认后 novel_propose apply`
            : v.action === 'list' ? `提案 ${v.proposals.length} 条：${v.proposals.map((x) => `${x.id}(${x.status})`).join('、') || '无'}`
            : `提案 ${v.id} 已应用：第${v.chapter}章 v${v.version} → ${v.path}${(v.warnings ?? []).length > 0 ? `\n警告：${v.warnings.join('；')}` : ''}`
        ),
    });
}
