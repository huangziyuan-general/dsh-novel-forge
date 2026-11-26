// lib/tools/worldbook-tool.js — novel_worldbook（世界书增删改查 / 导入导出）。
// 从 project-tools.js 按工具拆出；schema 与描述原样保留。

import { defineTool } from './define-tool.js';
import { normalizeWorldEntry, pathsFor, resolveWorldTrigger, sameEntryId, chapterRelPath } from '../store.js';
import { assertBookName, createFsio, sessionCwd, updateJson } from '../fsio.js';
import { audit, requireBook, parseList, textBlock } from './common.js';
import { serializeWorldbook, parseWorldbookImport } from '../worldbook-io.js';
import { parseWorldRulesText, reconcileWorldRules, worldRuleScan, forbiddenWordsScan, validWorldRuleRow, RULE_PRIORITIES } from '../world-rules.js';

/**
 * 本书已知实体名池（纯 io 拼装，交给 store.resolveWorldTrigger 做判定）：
 * cast ∪ 账本实体 ∪ 术语表 ∪ 已有条目的触发词。读不到的一律跳过，不阻断固化设定。
 */
async function candidateNames(io, p, novel, entries) {
    const names = [...(novel?.cast ?? [])];
    try { for (const f of (await io.readJson(p.facts)) ?? []) names.push(f?.entity); } catch { /* 无账本 */ }
    try { for (const t of (await io.readJson(p.glossary)) ?? []) names.push(t?.term); } catch { /* 无术语表 */ }
    for (const e of entries ?? []) names.push(...(Array.isArray(e?.keywords) ? e.keywords : []));
    return names.filter((n) => typeof n === 'string' && n.trim() !== '');
}

export function defineWorldbookTool(ctx, config) {
    return defineTool({
        name: 'novel_worldbook',
        description: '世界书（lorebook）：add 固化一条设定（关键词触发 / selective 双键门槛 / always 常驻，写章时按细纲与出场人物自动注入）；list 列出；remove 按 id 删除。设定崩坏的解药——设定只认这里。没给 keywords 时不会报错：先按内容自动取本书已知实体名当触发词，取不到则转常驻注入，并在返回里说明走了哪条兜底。另管**世界规则台账**（架空/历史书的一致性纪律位）：rules_add 登记设定域「域|子类|史实锚点|架空改造|冲突优先级」；rules 列出；rules_remove 按域/域·子类删；rules_check 对某章正文确定性扫描（史实优先域的架空改造成语出现在正文→report-only 点名，拦不拦由作者定）。世界规则按书隔离、只报不拦（拦的语义归内容门禁），修正口径进写章简报当「世界设定纪律」位。',
        parameters: {
            action: { type: 'string', required: true, enum: ['add', 'update', 'list', 'remove', 'import', 'export', 'rules_add', 'rules', 'rules_remove', 'rules_check'], description: '世界书六动作 + 世界规则台账四动作（rules_add 登记设定域行 / rules 列出 / rules_remove 按域删 / rules_check 对某章正文确定性扫描，report-only）。' },
            book: { type: 'string', required: true, description: '书目名。' },
            id: { type: 'string', description: 'add 可自定义 id；update / remove 必填。' },
            keywords: { type: 'string', description: 'add/update：主触发关键词，逗号/顿号分隔（如「灵潮,溯回者」）。省略时由代码兜底（自动取词→转常驻），不会报错。' },
            secondaryKeywords: { type: 'string', description: 'add/update：次级关键词，逗号/顿号分隔。与 selective:true 配套——主键与次级键**同时**命中才激活本条（双键门槛，压掉大设定整串泛词的单词误激活：只有「主设定词+场景词」都在场才注入）。' },
            selective: { type: 'boolean', description: 'add/update：true = 双键门槛（须同时给 secondaryKeywords；缺次级键会被拒——主键命中但次级键缺失的条目会静默永不生效）。不设保持原「任一主关键词命中即激活」。' },
            priority: { type: 'integer', description: 'add/update：注入优先级 0-100（默认 50）。预算不足时高优先级条目先入上下文。' },
            content: { type: 'string', description: 'add 必填；update 可选：设定内容（是什么+为什么+对故事的影响）。' },
            always: { type: 'boolean', description: 'add/update：true = 常驻注入（仅限全书级核心设定，省预算；常驻不受双键门槛约束）。' },
            payload: { type: 'string', description: 'import 必填：批量导入内容。rules_add 必填：多行世界规则，行式「域|子类|史实锚点|架空改造|冲突优先级」（冲突优先级取 史实优先/架空优先/均衡，后四段可省；坏行进回执 errors 不炸整批）。rules_remove：多行规则名（「域」删该域全部子行、「域·子类」删单行，一行一个）。' },
            chapter: { type: 'integer', description: 'rules_check 必填：要扫描的章号（取该章最新版本正文）。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    removed: { type: 'string' },
                    count: { type: 'integer', required: true },
                    entries: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                        id: { type: 'string', required: true }, keywords: { type: 'array', items: { type: 'string' }, required: true },
                        // 双键门槛（可选）：旧书条目没有这些键——list/export 直接回传盘上数据，
                        // required 会让老书撞宿主 lossless 校验。缺省 = 普通「任一主关键词命中」。
                        secondaryKeywords: { type: 'array', items: { type: 'string' } },
                        selective: { type: 'boolean' },
                        always: { type: 'boolean', required: true }, priority: { type: 'integer', required: true },
                        content: { type: 'string', required: true },
                    } } },
                    entry: { type: 'object', additionalProperties: false, properties: {
                        id: { type: 'string', required: true }, keywords: { type: 'array', items: { type: 'string' }, required: true },
                        secondaryKeywords: { type: 'array', items: { type: 'string' } },
                        selective: { type: 'boolean' },
                        always: { type: 'boolean', required: true }, priority: { type: 'integer', required: true },
                        content: { type: 'string', required: true },
                    } },
                    payload: { type: 'string' },
                    errors: { type: 'array', items: { type: 'string' } },
                    // 世界规则台账（rules_* 动作）：只写 设定/世界规则.json（updateJson 版本重放）
                    rules: { type: 'object', additionalProperties: false, properties: {
                        count: { type: 'integer', required: true },
                        items: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
                            domain: { type: 'string', required: true },
                            subdomain: { type: 'string', required: true },
                            historicalAnchors: { type: 'string', required: true },
                            fictionalAdaptations: { type: 'string', required: true },
                            priority: { type: 'string', required: true },
                            // 词汇禁区行（P4，kind 标记）：旧行没有这些键——可选，lossless 兼容
                            kind: { type: 'string' },
                            forbiddenWords: { type: 'array', items: { type: 'string' } },
                        } } },
                        changed: { type: 'boolean', required: true },
                        added: { type: 'array', items: { type: 'string' }, required: true },
                        removed: { type: 'array', items: { type: 'string' }, required: true },
                        // 坏行（缺域/优先级非法/重复域）留痕——同写法规则台账的 errors 纪律
                        errors: { type: 'array', items: { type: 'string' } },
                        note: { type: 'string', required: true },
                    } },
                    ruleCheck: { type: 'object', additionalProperties: false, properties: {
                        chapter: { type: 'integer', required: true },
                        issues: { type: 'array', items: { type: 'string' }, required: true },
                        counts: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
                            domain: { type: 'string', required: true },
                            hits: { type: 'integer', required: true },
                        } }, required: true },
                    } },
                    // 兜底说明（缺触发词时走了哪条路）——降级必须可见，禁止静默
                    warnings: { type: 'array', items: { type: 'string' } },
                },
            },
        },
        isConcurrencySafe: () => false,
        async execute(args, exec) {
            const book = assertBookName(args.book);
            const io = createFsio(ctx, exec, sessionCwd(exec));
            const p = pathsFor(book);
            const { novel } = await requireBook(io, book);
            const entries = (await io.readJson(p.worldbook)) ?? [];

            if (args.action === 'add') {
                const given = parseList(args.keywords);
                const secondary = parseList(args.secondaryKeywords);
                const selective = args.selective === true;
                // 双键门槛要成对给：selective:true 缺主键或次级键 = 条目永不激活（静默失效），
                // 比不落条目更糟——前置拒，不让它滑进「缺词兜底转 always」把门槛悄悄抹掉。
                if (selective && (given.length === 0 || secondary.length === 0)) {
                    throw new Error('selective:true（双键门槛）须同时给 keywords 与 secondaryKeywords——主键命中且次级键命中才注入；缺任一组会被拒（永不激活的条目没有保留价值）');
                }
                const names = given.length > 0 || args.always === true ? [] : await candidateNames(io, p, novel, entries);
                const trigger = resolveWorldTrigger({ keywords: given, always: args.always === true, content: args.content, names });
                const entry = normalizeWorldEntry({
                    id: args.id, keywords: trigger.keywords, secondaryKeywords: secondary,
                    selective, content: args.content,
                    always: trigger.always, priority: args.priority,
                }, entries);
                entries.push(entry);
                await io.writeJson(p.worldbook, entries);
                await audit(io, p, 'worldbook/add', { id: entry.id, derived: trigger.warning !== '' });
                return {
                    book, action: 'add', entry, count: entries.length,
                    ...(trigger.warning === '' ? {} : { warnings: [trigger.warning] }),
                };
            }
            if (args.action === 'list') {
                return { book, action: 'list', entries, count: entries.length };
            }
            if (args.action === 'update') {
                const idx = entries.findIndex((e) => sameEntryId(e.id, args.id));
                if (idx === -1) throw new Error(`世界书条目不存在：${args.id}`);
                const old = entries[idx];
                if (args.content === undefined && args.keywords === undefined && args.always === undefined
                    && args.priority === undefined && args.selective === undefined && args.secondaryKeywords === undefined) {
                    throw new Error('update 至少需要 content / keywords / priority / always / selective / secondaryKeywords 之一');
                }
                const nextContent = args.content !== undefined ? args.content.trim() : old.content;
                const nextAlways = args.always !== undefined ? args.always === true : old.always;
                const given = args.keywords !== undefined ? parseList(args.keywords) : (old.keywords ?? []);
                const secondary = args.secondaryKeywords !== undefined
                    ? parseList(args.secondaryKeywords) : (Array.isArray(old.secondaryKeywords) ? old.secondaryKeywords : []);
                const selective = args.selective !== undefined ? args.selective === true : old.selective === true;
                // 与 add 同一道前置闸：selective 生效但两组键缺一 → 条目永不激活，拒而不是静默落盘
                if (selective && !nextAlways && (given.length === 0 || secondary.length === 0)) {
                    throw new Error('selective:true（双键门槛）须同时保留 keywords 与 secondaryKeywords——当前缺主键或缺次级键，条目会永不激活；补齐或改回普通触发（selective:false）');
                }
                const names = given.length > 0 || nextAlways ? [] : await candidateNames(io, p, novel, entries.filter((e) => e !== old));
                const trigger = resolveWorldTrigger({ keywords: given, always: nextAlways, content: nextContent, names });
                const merged = normalizeWorldEntry({
                    id: args.id,
                    keywords: trigger.keywords,
                    secondaryKeywords: secondary,
                    selective,
                    content: nextContent,
                    always: trigger.always,
                    priority: args.priority !== undefined ? args.priority : old.priority,
                }, entries.filter((e) => !sameEntryId(e.id, args.id)));
                entries[idx] = merged;
                await io.writeJson(p.worldbook, entries);
                await audit(io, p, 'worldbook/update', { id: args.id, derived: trigger.warning !== '' });
                return {
                    book, action: 'update', entry: merged, count: entries.length,
                    ...(trigger.warning === '' ? {} : { warnings: [trigger.warning] }),
                };
            }
            if (args.action === 'export') {
                return { book, action: 'export', entries, count: entries.length, payload: serializeWorldbook(entries) };
            }
            if (args.action === 'import') {
                if (!args.payload || String(args.payload).trim() === '') throw new Error('import 需要 payload');
                const parsed = parseWorldbookImport(args.payload, entries);
                let next = entries;
                for (const e of parsed.entries) {
                    const i = next.findIndex((x) => sameEntryId(x.id, e.id));
                    if (i === -1) next.push(e); else next[i] = e;
                }
                await io.writeJson(p.worldbook, next);
                await audit(io, p, 'worldbook/import', { accepted: parsed.entries.length, errors: parsed.errors.length });
                return { book, action: 'import', count: next.length, entries: next, errors: parsed.errors };
            }
            // ── 世界规则台账（rules_add / rules / rules_remove / rules_check）────
            // 台账落 设定/世界规则.json（机器状态 JSON，与 写法规则.json 同构，updateJson
            // 版本重放防并发写冲突）；坏行不炸整批，进回执 errors 留痕（同写法规则纪律）。
            const ruleView = (r) => (r?.kind === 'forbiddenWords'
                ? {
                    domain: r.domain, subdomain: '', historicalAnchors: '', fictionalAdaptations: '',
                    priority: 'balanced', kind: 'forbiddenWords',
                    forbiddenWords: Array.isArray(r.forbiddenWords) ? r.forbiddenWords : [],
                }
                : {
                    domain: r.domain, subdomain: r.subdomain ?? '',
                    historicalAnchors: r.historicalAnchors ?? '', fictionalAdaptations: r.fictionalAdaptations ?? '',
                    priority: r.priority ?? 'balanced',
                });
            if (args.action === 'rules' || args.action === 'rules_add' || args.action === 'rules_remove' || args.action === 'rules_check') {
                const existing = (await io.readJson(p.worldRules)) ?? [];
                const base = (Array.isArray(existing) ? existing : []).filter(validWorldRuleRow);
                if (args.action === 'rules') {
                    return {
                        book, action: 'rules', count: base.length, entries: [],
                        rules: {
                            count: base.length, items: base.map(ruleView), changed: false,
                            added: [], removed: [],
                            note: `世界规则：${base.length} 个设定域口径（优先级取 史实优先/架空优先/均衡，缺省 均衡）——写前简报带「世界设定纪律」段，rules_check 对正文确定性点名（report-only 不拦）`,
                        },
                    };
                }
                if (args.action === 'rules_check') {
                    if (!Number.isInteger(args.chapter)) throw new Error('rules_check 需要正整数 chapter（要扫描的章号）');
                    const rec = novel.chapters?.[String(args.chapter)];
                    if (rec?.path === undefined) throw new Error(`第${args.chapter}章尚未保存`);
                    // 路径收口（同 noai 扫描）：越书路径不读。
                    const rel = chapterRelPath(rec, book);
                    if (rel === null) throw new Error(`章节路径越出书目录（索引可能被污染，先 novel_project repair 对账）：${String(rec.path).slice(0, 80)}`);
                    const content = await io.readText(rel);
                    if (content === null) throw new Error(`章节文件缺失：${rel}`);
                    // report-only 双扫（P4 对称面）：史实优先域的架空改造成语 + 词汇禁区的异域词。
                    // 拦不拦由作者定（拦的语义归内容门禁——写章链 ⑪ 维与本扫描同源同判据）。
                    const scan = worldRuleScan(content, base);
                    const forbidden = forbiddenWordsScan(content, base);
                    const issues = [...scan.issues, ...forbidden.issues];
                    const counts = [...scan.counts, ...forbidden.counts];
                    return {
                        book, action: 'rules_check', count: base.length, entries: [],
                        ruleCheck: { chapter: args.chapter, issues, counts },
                    };
                }
                const addText = args.action === 'rules_add' ? (typeof args.payload === 'string' ? args.payload : '') : '';
                const removeText = args.action === 'rules_remove' ? (typeof args.payload === 'string' ? args.payload : '') : '';
                if (args.action === 'rules_add' && addText.trim() === '') throw new Error('rules_add 需要 payload（多行规则，行式「域|子类|史实锚点|架空改造|冲突优先级」）');
                if (args.action === 'rules_remove' && removeText.trim() === '') throw new Error('rules_remove 需要 payload（多行规则名：「域」删该域全部、「域·子类」删单行，一行一个）');
                const parsed = parseWorldRulesText(addText);
                const removeNames = String(removeText).split(/\r?\n/)
                    .map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
                const { rules: next, added, removed } = reconcileWorldRules(base, parsed.rules, removeNames);
                const changed = next.length !== base.length || JSON.stringify(next) !== JSON.stringify(base);
                await updateJson(io, p.worldRules, () => ({ value: next, result: next }));
                await audit(io, p, 'worldrules/reconcile', { added: added.length, removed: removed.length, errors: parsed.errors.length });
                return {
                    book, action: args.action, count: next.length, entries: [],
                    rules: {
                        count: next.length, items: next.map(ruleView), changed, added, removed,
                        errors: parsed.errors,
                        note: parsed.errors.length > 0
                            ? `${parsed.errors.length} 行未登记（见 errors）：${parsed.errors[0]}${parsed.errors.length > 1 ? '…' : ''}`
                            : (changed
                                ? `世界规则更新：${added.length} 域新增/更新、${removed.length} 域移除`
                                : '世界规则无变化（这批行已在/不在台账里，去重后原样）'),
                    },
                };
            }
            // remove 兜底（rules_* 全部 return，掉到这里的只剩世界书动作）
            const rest = entries.filter((e) => !sameEntryId(e.id, args.id));
            if (rest.length === entries.length) throw new Error(`世界书条目不存在：${args.id}`);
            await io.writeJson(p.worldbook, rest);
            await audit(io, p, 'worldbook/remove', { id: args.id });
            return { book, action: 'remove', removed: args.id, count: rest.length };
        },
        render: (_args, v) => textBlock(
            // 世界规则动作：只出台账清单/回执/扫描点名，不走世界书渲染（返回体没有 entry）
            (v.rules !== undefined || v.ruleCheck !== undefined)
                ? [
                    v.ruleCheck !== undefined
                        ? `第${v.ruleCheck.chapter}章 世界规则扫描：${v.ruleCheck.issues.length > 0 ? v.ruleCheck.issues.join('\n') : '未检出（史实优先域的架空改造成语、词汇禁区的异域词都没出现在正文里，或该书无此类口径）'}`
                        : null,
                    v.rules !== undefined
                        ? `世界规则 ${v.rules.count} 域：\n  ${v.rules.items.map((r) => r.kind === 'forbiddenWords'
                            ? `【${r.domain}】词汇禁区：${r.forbiddenWords.join('、')}`
                            : `【${r.domain}${r.subdomain ? '·' + r.subdomain : ''}】${r.priority === 'historical' ? '史实优先' : r.priority === 'fictional' ? '架空优先' : '均衡'}${(r.historicalAnchors || r.fictionalAdaptations) ? `（${[r.historicalAnchors && '史实 ' + r.historicalAnchors, r.fictionalAdaptations && '架空 ' + r.fictionalAdaptations].filter(Boolean).join('；')}）` : ''}`).join('\n  ') || '（空）'}\n${v.rules.note}`
                        : null,
                    v.rules?.errors?.length ? `⚠ 未登记行：${v.rules.errors.join('；')}` : null,
                ].filter((s) => s !== null).join('\n')
                : (v.action === 'list' || v.action === 'import' || v.action === 'export'
                ? `世界书 ${v.count} 条${v.action === 'export' ? '\n' + v.payload : ''}${v.action === 'import' && v.errors?.length ? `（${v.errors.length} 行跳过）` : ''}`
                : v.action === 'add' ? `已固化设定 ${v.entry.id}（${v.entry.selective === true
                        ? `双键门槛：${v.entry.keywords.join('、')} 且 ${v.entry.secondaryKeywords.join('、')} 同时在场才注入`
                        : `触发词：${v.entry.keywords.join('、') || '常驻'}`
                    }）；世界书共 ${v.count} 条`
                : v.action === 'update' ? `已更新 ${v.entry.id}；世界书 ${v.count} 条`
                : `已删除 ${v.removed}；剩余 ${v.count} 条`)
            // 兜底必须可见：走了自动取词/转常驻，模型要把这条转述给用户，不能当成静默成功
            + (v.warnings?.length ? `\n⚠ ${v.warnings.join('\n⚠ ')}` : '')),
    });
}
