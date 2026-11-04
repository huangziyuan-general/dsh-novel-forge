// lib/tools/character-tool.js — novel_character（人物卡 + 语言基因卡）。
// 从 project-tools.js 按工具拆出；schema 与描述原样保留。

import { defineTool } from './define-tool.js';
import { pathsFor } from '../store.js';
import { assertBookName, createFsio, sessionCwd } from '../fsio.js';
import { audit, requireBook, saveBook, textBlock } from './common.js';
import { normalizeVoice, normalizeVoiceStored, isEmptyVoice, validateVoice, repairVoiceCard, VOICE_FIELDS } from '../voice.js';

export function defineCharacterTool(ctx, config) {
    return defineTool({
        name: 'novel_character',
        description: '人物卡：save 保存/更新「人物/<名>.md」（外在底色、隐性欲望——写章时自动注入上下文包）；'
            + '可选 voice 参数建**语言基因卡**（句长习惯/逻辑风格/口头禅/绝不说/标志性小动作/语域，单独结构化存储，写章时单独注入成醒目区块）：'
            + '多角色同台时防「千人一腔」的关键——口癖与禁忌词是代码可查的，novel_audit voice:true 会核对。list 列出已建人物。'
            + 'voice_repair 对存量语言基因卡做一次性的重切/归一化（默认 dry-run，apply:true 才落盘）。',
        parameters: {
            action: { type: 'string', required: true, enum: ['save', 'list', 'voice_repair'], description: 'save 保存人物卡；list 列出；voice_repair 修复存量语言基因卡（默认 dry-run）。' },
            book: { type: 'string', required: true, description: '书目名。' },
            name: { type: 'string', description: 'save 必填：人物名。voice_repair 可选：只修这一人（缺省修全部）。' },
            card: { type: 'string', description: 'save 必填：人物卡 Markdown 正文（外在底色/隐性欲望/心理阈值/关系网）。' },
            voice: { type: 'string', description: 'save 可选：语言基因卡，多行「键|值」，如「句长|短句为主，很少超10字」「口头禅|呵,行吧」「禁忌|人家,小女子」「行为规则|不与人争辩第二句」「动作|摸左耳」。可用键：句长/逻辑/口头禅/禁忌/行为规则/动作/语域。口头禅须 ≤12 字且不含引号括号，超限会报错而非静默丢弃。' },
            apply: { type: 'boolean', description: 'voice_repair 可选：true 才把修复结果写回「设定/语言基因.json」；缺省 false = 只出差异报告，不落盘。' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    book: { type: 'string', required: true },
                    action: { type: 'string', required: true },
                    name: { type: 'string' },
                    path: { type: 'string' },
                    cast: { type: 'array', items: { type: 'string' } },
                    voiceFields: { type: 'array', items: { type: 'string' } },
                    voiced: { type: 'array', items: { type: 'string' } },
                    voiceWarnings: { type: 'array', items: { type: 'string' } },
                    repair: { type: 'array', items: {
                        type: 'object', additionalProperties: false, properties: {
                            name: { type: 'string', required: true },
                            changed: { type: 'boolean', required: true },
                            applied: { type: 'boolean', required: true },
                            changes: { type: 'array', required: true, items: {
                                type: 'object', additionalProperties: false, properties: {
                                    field: { type: 'string', required: true },
                                    kind: { type: 'string', required: true },
                                    before: { type: 'string', required: true },
                                    after: { type: 'string', required: true },
                                },
                            } },
                            issues: { type: 'array', required: true, items: {
                                type: 'object', additionalProperties: false, properties: {
                                    severity: { type: 'string', required: true },
                                    code: { type: 'string', required: true },
                                    field: { type: 'string', required: true },
                                    item: { type: 'string', required: true },
                                    message: { type: 'string', required: true },
                                },
                            } },
                        },
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
            novel.cast = novel.cast ?? [];

            if (args.action === 'list') {
                const voices = (await io.readJson(p.voices)) ?? {};
                const voiced = novel.cast.filter((nm) => !isEmptyVoice(normalizeVoiceStored(voices[nm])));
                return { book, action: 'list', cast: [...novel.cast], voiceFields: [], voiced };
            }
            if (args.action === 'voice_repair') {
                const voices = (await io.readJson(p.voices)) ?? {};
                const wanted = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : null;
                if (wanted !== null && !Object.hasOwn(voices, wanted)) {
                    throw new Error(`「${wanted}」没有语言基因卡；已有：${Object.keys(voices).join('、') || '（无）'}`);
                }
                const names = wanted !== null ? [wanted] : Object.keys(voices);
                const repair = [];
                for (const nm of names) {
                    const r = repairVoiceCard(voices[nm]);
                    const applied = args.apply === true && r.changed;
                    if (applied) voices[nm] = r.voice;
                    repair.push({ name: nm, changed: r.changed, applied, changes: r.changes, issues: r.issues });
                }
                if (repair.some((r) => r.applied)) {
                    await io.writeJson(p.voices, voices);
                    await audit(io, p, 'character/voice-repair', { characters: repair.filter((r) => r.applied).length });
                }
                return { book, action: 'voice_repair', repair, cast: [...novel.cast] };
            }
            if (!args.name || !args.card || args.card.trim() === '') throw new Error('save 需要 name 与 card 正文');
            const name = args.name.trim();
            // L10 修复：纯空白名此前会溜过去（'  ' 非空 → trim 后空串 → 写出「人物/.md」幽灵文件）；
            // 名字里带路径分隔符会越出「人物/」目录，一并拒掉
            if (name === '') throw new Error('人物名不能为空白');
            if (/[\\/]/.test(name) || name.startsWith('.')) throw new Error(`人物名不合法：「${name}」（不含 / \\ 与 . 前缀）`);
            // 语言基因卡先解析校验（解析不出就整单失败，避免只写半张卡）
            const voice = args.voice === undefined ? null : normalizeVoice(args.voice);
            if (voice !== null && isEmptyVoice(voice)) {
                throw new Error(`voice 解析不出任何字段——请用「键|值」行；可用键：${VOICE_FIELDS.map((f) => f.label).join('、')}`);
            }
            // 写入侧硬校验（不变量 11：超限/含引号不许静默丢弃——报错，让调用方改输入）
            const check = voice === null ? { errors: [], warnings: [] } : validateVoice(voice);
            if (check.errors.length > 0) {
                throw new Error(`语言基因卡校验未通过：\n${check.errors.map((e) => `- ${e.message}`).join('\n')}`);
            }
            const rel = p.character(args.name);
            await io.writeText(rel, `${args.card.trim()}\n`, 'auto');
            if (!novel.cast.includes(name)) novel.cast.push(name);
            await saveBook(io, p, novel);
            await audit(io, p, 'character/save', { name, chars: args.card.length });
            let voiceFields = [];
            if (voice !== null) {
                const voices = (await io.readJson(p.voices)) ?? {};
                voices[name] = voice;
                await io.writeJson(p.voices, voices);
                voiceFields = Object.keys(voice);
                await audit(io, p, 'character/voice', { name, fields: voiceFields });
            }
            return {
                book, action: 'save', name, path: rel, cast: [...novel.cast], voiceFields,
                ...(check.warnings.length > 0 ? { voiceWarnings: check.warnings.map((w) => w.message) } : {}),
            };
        },
        render: (_args, v) => textBlock(v.action === 'list'
            ? `已建人物 ${v.cast.length}：${v.cast.length === 0 ? '（无）' : v.cast.join('、')}`
                + `\n有语言基因卡：${v.voiced.length === 0 ? '（无——多角色同台建议补）' : v.voiced.join('、')}`
            : v.action === 'voice_repair'
                ? `语言基因卡修复（${v.repair.filter((r) => r.changed).length} 张有差异 / 共 ${v.repair.length} 张）`
                    + v.repair.map((r) => `\n· ${r.name}：${r.changed ? `差异 ${r.changes.length} 处${r.applied ? '（已落盘）' : '（dry-run，未落盘）'}` : '无差异'}`
                        + (r.issues.length > 0 ? `；待人工处理 ${r.issues.length} 项` : '')).join('')
                : `人物卡已保存：${v.path}；当前 cast ${v.cast.length} 人`
                    + (v.voiceFields.length > 0
                        ? `；语言基因卡已建 ${v.voiceFields.length} 个字段（写章时会单独注入）`
                        : '（未建语言基因卡——novel_character voice 可补，防千人一腔）')
                    + (v.voiceWarnings?.length > 0 ? `\n⚠ ${v.voiceWarnings.join('\n⚠ ')}` : '')),
    });
}
