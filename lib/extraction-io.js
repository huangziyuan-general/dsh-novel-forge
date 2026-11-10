// 抽取提案落盘与人工应用。模型只能调 submit；apply 仅由 REST 用户动作调用。

import { sha256 } from './basis.js';
import { updateJson, auditLine } from './fsio.js';
import { normalizeWorldEntry, pathsFor, sameEntryId } from './store.js';
import { mergeCharacterCard } from './extraction.js';

const hash = (value) => sha256(typeof value === 'string' ? value : JSON.stringify(value));

export async function captureExtractionTargets(io, p, items) {
    const worldbook = (await io.readJson(p.worldbook)) ?? [];
    const out = [];
    for (const item of items) {
        if (item.kind === 'character') {
            const path = p.character(item.name);
            const base = await io.readText(path);
            out.push({ ...item, target: { path, baseName: item.name, hash: base === null ? null : hash(base), base } });
        } else {
            const base = worldbook.find((entry) => (entry.keywords ?? []).includes(item.name)) ?? null;
            out.push({ ...item, target: { id: base?.id ?? null, hash: base === null ? null : hash(base), base } });
        }
    }
    return out;
}

export async function submitExtractionProposal(io, p, { items, from, to, actor = 'agent' }) {
    const now = new Date().toISOString();
    const proposal = {
        id: `E${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        status: 'pending', from, to, createdAt: now, updatedAt: now, items,
    };
    await updateJson(io, p.extractionProposals, (current) => ({
        value: { schemaVersion: 1, proposals: [...(current?.proposals ?? []), proposal] },
    }));
    await io.appendLine(p.audit, auditLine('extraction/submit', { id: proposal.id, items: items.length, from, to }, actor));
    return proposal;
}

export async function listExtractionProposals(io, p) {
    return (await io.readJson(p.extractionProposals))?.proposals ?? [];
}

function editedItem(original, edit) {
    if (edit === undefined) return original;
    if (edit.id !== original.id) throw new Error('候选项 id 与提案不符');
    const name = typeof edit.name === 'string' ? edit.name.trim() : original.name;
    const content = typeof edit.content === 'string' ? edit.content.trim() : original.content;
    const aliases = Array.isArray(edit.aliases) ? edit.aliases : original.aliases;
    const keywords = Array.isArray(edit.keywords) ? edit.keywords : original.keywords;
    if (name === '' || name.length > 40 || /[\\/]/.test(name) || name.startsWith('.')) throw new Error(`候选「${original.id}」名称不合式`);
    if (content === '' || content.length > 2000) throw new Error(`候选「${name}」内容为空或超过 2000 字`);
    if (![...aliases, ...keywords].every((value) => typeof value === 'string')) throw new Error(`候选「${name}」别名/关键词必须是字符串数组`);
    return {
        ...original, name, content,
        aliases: [...new Set(aliases.map((value) => value.trim()).filter(Boolean))].slice(0, 8),
        keywords: original.kind === 'worldbook' ? [...new Set([name, ...aliases, ...keywords.map((value) => value.trim()).filter(Boolean)])].slice(0, 12) : [],
        always: original.kind === 'worldbook' && typeof edit.always === 'boolean' ? edit.always : original.always,
        priority: Number.isInteger(edit.priority) ? Math.max(0, Math.min(100, edit.priority)) : original.priority,
    };
}

async function markApplied(io, p, proposalId, itemId, now) {
    await updateJson(io, p.extractionProposals, (current) => {
        const proposals = (current?.proposals ?? []).map((proposal) => {
            if (proposal.id !== proposalId) return proposal;
            const items = proposal.items.map((item) => item.id === itemId ? { ...item, status: 'applied', appliedAt: now } : item);
            const pending = items.some((item) => item.status === 'pending');
            return { ...proposal, items, status: pending ? 'partial' : 'applied', updatedAt: now };
        });
        return { value: { schemaVersion: 1, proposals } };
    });
}

async function applyCharacter(io, p, item) {
    if (item.target.base !== null && item.name !== item.target.baseName && item.target.baseName !== undefined) throw new Error('已有档案的候选不能改名；请保留原名或另建新候选');
    const path = item.target.base === null ? p.character(item.name) : item.target.path;
    const current = await io.readTextWithVersion(path);
    const next = mergeCharacterCard(item.target.base, item);
    const unchangedBase = (current.text === null ? null : hash(current.text)) === item.target.hash;
    if (!unchangedBase && current.text !== next) throw new Error(`人物「${item.name}」的档案在抽取后已变化，未覆盖；请重新抽取或手工合并`);
    if (current.text !== next) await io.writeTextAtVersion(path, next, current.version);
    const book = p.bookName;
    const result = { id: item.id, kind: item.kind, name: item.name, path };
    try {
        await updateJson(io, p.meta, (novel) => {
            if (novel === undefined) throw new Error(`书目不存在：${book}`);
            if ((novel.cast ?? []).includes(item.name)) return undefined;
            return { value: { ...novel, cast: [...(novel.cast ?? []), item.name] } };
        });
    } catch (error) {
        if (error && typeof error === 'object') error.extractionUnconfirmed = { result, stage: '人物卡内容已落盘，但书目人物索引与提案状态未确认' };
        throw error;
    }
    return result;
}

async function applyWorldbook(io, p, item) {
    const expected = normalizeWorldEntry({
        id: item.target.base?.id ?? undefined,
        keywords: [...new Set([...(item.target.base?.keywords ?? []), ...item.keywords])],
        content: item.target.base === null ? item.content : `${item.target.base.content.trim()}\n${item.content.trim()}`,
        always: item.always, priority: item.priority,
    }, []);
    let nextEntry = expected;
    await updateJson(io, p.worldbook, (currentValue) => {
        const entries = currentValue ?? [];
        const index = item.target.id === null ? -1 : entries.findIndex((entry) => sameEntryId(entry.id, item.target.id));
        const base = index >= 0 ? entries[index] : null;
        const baseHash = base === null ? null : hash(base);
        if (item.target.id === null && item.target.hash === null) {
            const already = entries.find((entry) => (entry.keywords ?? []).includes(item.name) && entry.content === item.content);
            if (already) { nextEntry = already; return undefined; }
        }
        if (baseHash !== item.target.hash) {
            if (base !== null && JSON.stringify(base) === JSON.stringify(expected)) { nextEntry = base; return undefined; }
            throw new Error(`世界书条目「${item.name}」在抽取后已变化，未覆盖；请重新抽取或手工合并`);
        }
        if (base === null && entries.some((entry) => (entry.keywords ?? []).includes(item.name))) {
            throw new Error(`世界书已出现「${item.name}」相关条目，未重复新增；请重新抽取`);
        }
        const normalized = normalizeWorldEntry({
            id: base?.id ?? undefined,
            keywords: [...new Set([...(base?.keywords ?? []), ...item.keywords])],
            content: base === null ? item.content : `${base.content.trim()}\n${item.content.trim()}`,
            always: item.always, priority: item.priority,
        }, base === null ? entries : entries.filter((_, at) => at !== index));
        nextEntry = normalized;
        const next = [...entries];
        if (index < 0) next.push(normalized); else next[index] = normalized;
        return { value: next };
    });
    return { id: item.id, kind: item.kind, name: item.name, entry: nextEntry };
}

export async function applyExtractionProposal(io, book, proposalId, edits = []) {
    const p = pathsFor(book);
    const proposals = await listExtractionProposals(io, p);
    const proposal = proposals.find((entry) => entry.id === proposalId);
    if (!proposal) throw new Error(`抽取提案不存在：${proposalId}`);
    const editMap = new Map(edits.map((edit) => [edit?.id, edit]));
    if (editMap.size === 0) throw new Error('至少选择一项候选');
    const selected = proposal.items.filter((item) => editMap.has(item.id));
    if (selected.length !== editMap.size) throw new Error('所选候选不属于这条提案');
    if (selected.some((item) => item.status !== 'pending')) throw new Error('所选候选含已处理项，请刷新提案；本次尚未应用任何一项');
    const applied = [];
    for (const original of selected) {
        let result = null;
        try {
            const item = editedItem(original, editMap.get(original.id));
            result = item.kind === 'character' ? await applyCharacter(io, p, item) : await applyWorldbook(io, p, item);
            const now = new Date().toISOString();
            await markApplied(io, p, proposalId, original.id, now);
            applied.push(result);
        } catch (error) {
            // 逐项应用不是原子的：失败时把「已应用 N 项 + 项标识」写进错误文案，
            // 否则用户会以为整批没落盘，重试时又对已应用项困惑。
            const ids = applied.map((item) => item.id);
            const unconfirmed = result ?? error?.extractionUnconfirmed?.result ?? null;
            const stage = result !== null
                ? '档案已写入，但提案状态未更新'
                : error?.extractionUnconfirmed?.stage ?? '';
            if (ids.length > 0 || unconfirmed !== null) {
                await io.appendLine(p.audit, auditLine('extraction/apply', {
                    id: proposalId, items: ids,
                    ...(unconfirmed === null ? {} : { unconfirmed: unconfirmed.id }),
                    partial: true,
                }, 'user')).catch(() => {});
            }
            const currentNote = unconfirmed === null ? '' : `；第 ${original.id} 项${stage}`;
            throw new Error(`应用第 ${original.id} 项失败：${String(error?.message ?? error)}；已应用 ${ids.length} 项${ids.length > 0 ? `（${ids.join('、')}）` : ''}${currentNote}。请刷新提案后重试剩余项。`);
        }
    }
    await io.appendLine(p.audit, auditLine('extraction/apply', { id: proposalId, items: applied.map((item) => item.id) }, 'user'));
    return { id: proposalId, applied, count: applied.length };
}
