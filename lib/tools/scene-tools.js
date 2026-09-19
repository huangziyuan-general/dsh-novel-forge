// lib/tools/scene-tools.js — novel_scene：场景契约的读写入口。
//
// 契约决定「本章该注入什么上下文」：
//   · participants 只喂出场人物（省 token：30 章后不必再灌全书人物卡）
//   · hidden 里的人物**档案不进上下文**，且正文一旦出现其名即被内容门禁拦下（悬念保护）
//   · settings 是世界书白名单（给了就只注入这些条目）
//
// 契约由用户/模型显式声明，本工具只负责读写——判定逻辑全在 lib/scene-contract.js（纯函数）。

import { defineTool } from './define-tool.js';
import { pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { audit, requireBook, saveBook, parseList, textBlock } from './common.js';
import { clearBreaker } from '../circuit-breaker.js';
import {
    normalizeContract, setContract, removeContract, contractFor, contractDigest,
} from '../scene-contract.js';

export function defineSceneTool(ctx, config) {
    return defineTool({
        name: 'novel_scene',
        description: '场景契约（按章）：save 声明第N章的场景/出场人物/隐藏人物/世界书白名单/禁项；get 查；list 列；delete 删。'
            + '两个硬作用：① 出场人物只注入这些人的卡（写长书时省上下文，避免 30 章后上下文爆炸）；'
            + '② 隐藏人物**档案不入上下文、正文也不许出现其名**（揭晓前不泄底，内容门禁会拦）。'
            + '长篇连载里「这个角色第几章才揭晓」靠它保证，不要只靠记忆。',
        parameters: {
            action: { type: 'string', required: true, enum: ['save', 'get', 'list', 'delete'], description: 'save 保存/覆盖；get 查某章；list 列出全部；delete 删除。' },
            book: { type: 'string', required: true, description: '书目名。' },
            chapter: { type: 'integer', description: 'save/get/delete 必填：章号。' },
            scene: { type: 'string', description: 'save：本章场景一句话（进上下文，帮助聚焦）。' },
            participants: { type: 'string', description: 'save：本章出场人物，逗号分隔。给了它，本章只注入这些人的卡；省略则退回工程 cast 全员。' },
            hidden: { type: 'string', description: 'save：本章必须隐藏的人物，逗号分隔——档案不注入，正文出现其名即被门禁拦下。' },
            settings: { type: 'string', description: 'save：世界书白名单（条目 id），逗号分隔。给了就只注入这些条目；省略则按关键词自动匹配。' },
            forbidden: { type: 'string', description: 'save：本章禁项，逗号分隔（如「储物戒指,现代词汇」）。' },
            notes: { type: 'string', description: 'save：补充说明（情绪基调、视角、必须避开的桥段等）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    chapter: { type: 'integer' },
                    count: { type: 'integer', required: true },
                    removed: { type: 'boolean' },
                    contract: { type: 'object', additionalProperties: false, properties: {
                        chapter: { type: 'integer', required: true },
                        scene: { type: 'string', required: true },
                        participants: { type: 'array', items: { type: 'string' }, required: true },
                        hidden: { type: 'array', items: { type: 'string' }, required: true },
                        settings: { type: 'array', items: { type: 'string' }, required: true },
                        forbidden: { type: 'array', items: { type: 'string' }, required: true },
                        notes: { type: 'string', required: true },
                        updatedAt: { type: 'string', required: true },
                    } },
                    contracts: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        chapter: { type: 'integer', required: true },
                        scene: { type: 'string', required: true },
                        participants: { type: 'array', items: { type: 'string' }, required: true },
                        hidden: { type: 'array', items: { type: 'string' }, required: true },
                        settings: { type: 'array', items: { type: 'string' }, required: true },
                        forbidden: { type: 'array', items: { type: 'string' }, required: true },
                        notes: { type: 'string', required: true },
                        updatedAt: { type: 'string', required: true },
                    } } },
                    digest: { type: 'string' },
                    warnings: { type: 'array', items: { type: 'string' }, required: true },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            const raw = (await io.readJson(p.sceneContracts)) ?? {};
            const warnings = [];
            // 输出盖章：存量数据可能没有 updatedAt（normalizeContract 会给 null），
            // 而 output schema 声明 string——出口统一补齐，杜绝宿主 strict 校验拒收。
            const stamp = (c) => (c === null ? c : { ...c, updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : '' });

            if (args.action === 'list') {
                const contracts = Object.keys(raw).map(Number).filter(Number.isInteger).sort((a, b) => a - b)
                    .map((n) => stamp(contractFor(raw, n)));
                return { book, action: 'list', count: contracts.length, contracts, warnings };
            }

            if (!Number.isInteger(args.chapter) || args.chapter < 1) throw new Error(`${args.action} 需要正整数 chapter`);

            if (args.action === 'get') {
                const c = stamp(contractFor(raw, args.chapter));
                return {
                    book, action: 'get', chapter: args.chapter, count: c === null ? 0 : 1,
                    ...(c === null ? {} : { contract: c }),
                    digest: contractDigest(c), warnings,
                };
            }

            if (args.action === 'delete') {
                const had = contractFor(raw, args.chapter) !== null;
                await io.writeJson(p.sceneContracts, removeContract(raw, args.chapter));
                await audit(io, p, 'scene/delete', { chapter: args.chapter, had });
                return { book, action: 'delete', chapter: args.chapter, count: 0, removed: had, warnings };
            }

            // save
            const contract = normalizeContract({
                chapter: args.chapter,
                scene: args.scene,
                participants: args.participants === undefined ? [] : parseList(args.participants),
                hidden: args.hidden === undefined ? [] : parseList(args.hidden),
                settings: args.settings === undefined ? [] : parseList(args.settings),
                forbidden: args.forbidden === undefined ? [] : parseList(args.forbidden),
                notes: args.notes,
            });
            if (contract.participants.length === 0 && contract.hidden.length === 0
                && contract.scene === '' && contract.forbidden.length === 0) {
                throw new Error('save 至少要给 scene / participants / hidden / forbidden 之一');
            }
            const contradictions = contract.participants.filter((n) => contract.hidden.includes(n));
            if (contradictions.length > 0) {
                warnings.push(`「${contradictions.join('、')}」同时被声明为出场与隐藏——按「隐藏优先」处理，本章不会注入其档案`);
            }
            const next = setContract(raw, contract);
            await io.writeJson(p.sceneContracts, next);
            // 熔断解除通道之二：重写本章场景契约＝重新校准设定
            clearBreaker(novel, args.chapter);
            await saveBook(io, p, novel);
            await audit(io, p, 'scene/save', {
                chapter: args.chapter, participants: contract.participants.length,
                hidden: contract.hidden.length, settings: contract.settings.length,
            });
            const saved = stamp(contractFor(next, args.chapter));
            return {
                book, action: 'save', chapter: args.chapter, count: Object.keys(next).length,
                contract: saved, digest: contractDigest(saved), warnings,
            };
        },
        render: (_args, v) => {
            if (v.action === 'list') {
                return textBlock(v.count === 0
                    ? '尚无场景契约（写章按工程 cast 全员注入）'
                    : `场景契约 ${v.count} 章：\n${v.contracts.map((c) => `第${c.chapter}章 — ${contractDigest(c)}`).join('\n')}`);
            }
            if (v.action === 'get') {
                return textBlock(v.count === 0 ? `第${v.chapter}章无场景契约` : `第${v.chapter}章场景契约：${v.digest}`);
            }
            if (v.action === 'delete') {
                return textBlock(v.removed ? `第${v.chapter}章场景契约已删除` : `第${v.chapter}章本就没有契约`);
            }
            return textBlock(`第${v.chapter}章场景契约已保存：${v.digest}`
                + (v.warnings.length > 0 ? `\n⚠ ${v.warnings.join('\n⚠ ')}` : '')
                + `\n（共 ${v.count} 章有契约；写章时 novel_briefing 会自动按它裁剪上下文）`);
        },
    });
}
