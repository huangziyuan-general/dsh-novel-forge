// lib/recovery.js — 生成失败候选的持久化与读取。
//
// 恢复稿只是候选：任何读取/列表接口都不会写正文。真正落章仍须经过面板保存
// 与 chapter-commit 的完整门禁。

import {
    PRUNED_INDEX_LIMIT, RETENTION_POLICY, canHardDelete, isStaleVersion, planRetention, shouldSweep, warnRetentionFailure,
} from './retention.js';
import { updateJson } from './fsio.js';

const RECOVERY_ID_RE = /^[A-Za-z0-9_-]{1,96}$/;

/**
 * 恢复候选保留策略：与幂等回执共用 lib/retention.js 的保留口径。
 * 已提交候选（status:'committed'，partialText 已清空）本身无恢复价值，扫描时
 * **直接清出**——否则 committed() 刷新的 updatedAt 会让它恒占保留名额，把更早、
 * 未取回的 failed 候选挤掉（用户点「载入编辑器」会拿到 404）。
 *
 * 宿主支持 deleteFile 时真删文件；真删后 404 无法再靠墓碑区分「已清理」与
 * 「从未存在」，所以先把本轮清出的 id 记进有界索引（`.novel/recovery-pruned.json`，
 * 上限 PRUNED_INDEX_LIMIT 条，按时间淘汰最旧的）**再**删——索引写失败就不删，
 * 保住区分。老宿主没有 deleteFile 时回退成墓碑（status:'pruned'），行为不变。
 */
export async function pruneRecoveryCandidates(io, p, {
    keepNewest = RETENTION_POLICY.recovery.keepNewest,
    maxAgeDays = RETENTION_POLICY.recovery.maxAgeDays,
    now = new Date(),
} = {}) {
    const hardDelete = canHardDelete(io);
    const names = await io.listNames(p.recoveryDir);
    const rows = [];
    const prune = [];
    const versions = new Map();
    let scanned = 0;
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        if (!validRecoveryId(id)) continue;
        let candidate;
        try {
            if (hardDelete) {
                const current = await io.readJsonWithVersion(p.recoveryCandidate(id));
                candidate = current.value;
                if (current.version !== null) versions.set(id, current.version);
            } else {
                candidate = await io.readJson(p.recoveryCandidate(id));
            }
        } catch { continue; }
        if (candidate === null || candidate?.status === 'pruned') continue;
        scanned += 1;
        if (candidate.status === 'committed') { prune.push(id); continue; }
        rows.push({ key: id, at: String(candidate?.updatedAt ?? '') });
    }
    prune.push(...planRetention(rows, { keepNewest, maxAgeDays, now }).prune);
    if (prune.length === 0) return { scanned, pruned: 0 };

    if (hardDelete) {
        // 先写索引再删：索引落盘失败就一个都不删（下次扫描重试）——宁可少清，
        // 也不能让用户看到「从未存在」这种错误结论。
        try {
            await recordPruned(io, p, prune, now);
        } catch {
            return { scanned, pruned: 0 };
        }
        let pruned = 0;
        for (const id of prune) {
            try {
                const version = versions.get(id);
                if (version === undefined || version === null) continue;
                await io.deleteFile(p.recoveryCandidate(id), { version });
                pruned += 1;
            } catch (error) {
                if (isStaleVersion(error)) continue; // 期间同 id 被写回了新候选：跳过
                /* 下次扫描重试 */
            }
        }
        return { scanned, pruned };
    }

    let pruned = 0;
    for (const id of prune) {
        try {
            await io.writeJson(p.recoveryCandidate(id), { version: 1, id, status: 'pruned', prunedAt: now.toISOString() }, 'auto');
            pruned += 1;
        } catch { /* 下次扫描重试 */ }
    }
    return { scanned, pruned };
}

/**
 * 把本轮清出的 id 记进有界索引（最新在前，同 id 去重，超出上限按时间淘汰最旧的）。
 * 走 updateJson 的 CAS 重放：两个扫描并发时两边的记录都留得下来。
 */
async function recordPruned(io, p, ids, now) {
    const prunedAt = now.toISOString();
    const fresh = ids.filter((id) => typeof id === 'string' && id !== '');
    if (fresh.length === 0) return;
    await updateJson(io, p.recoveryPruned, (current) => {
        const items = Array.isArray(current?.items) ? current.items : [];
        const kept = items.filter((row) => row && typeof row.id === 'string' && !fresh.includes(row.id));
        return {
            value: {
                version: 1,
                items: [...fresh.map((id) => ({ id, prunedAt })), ...kept].slice(0, PRUNED_INDEX_LIMIT),
            },
            result: true,
        };
    });
}

/** 该 id 是否在「最近清理」索引里（损坏/缺失索引一律按未清理处理）。 */
async function wasPruned(io, p, id) {
    try {
        const doc = await io.readJson(p.recoveryPruned);
        return Array.isArray(doc?.items) && doc.items.some((row) => row?.id === id);
    } catch {
        return false;
    }
}

export function validRecoveryId(id) {
    return typeof id === 'string' && RECOVERY_ID_RE.test(id);
}

export function newRunId(prefix = 'D') {
    return `${prefix}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function recoveryView(candidate, { stale = false } = {}) {
    const text = String(candidate?.partialText ?? '');
    return {
        id: candidate.id, runId: candidate.runId, attemptId: candidate.attemptId,
        chapter: candidate.chapter, kind: candidate.kind, status: candidate.status,
        chars: text.length, preview: text.replace(/\s+/g, ' ').trim().slice(0, 160),
        sourceHash: candidate.sourceHash, createdAt: candidate.createdAt, updatedAt: candidate.updatedAt,
        error: candidate.error ?? null, stale,
    };
}

/**
 * 读取一枚恢复候选。
 * 返回 `{ candidate, pruned }`：`candidate === null` 时用 `pruned` 区分
 * 「已被保留策略清理」与「从未存在」，路由据此给出不同 404 文案。
 * 老宿主回退形态看墓碑（status:'pruned'）；真删形态看有界「已清理 id」索引。
 */
export async function readRecoveryCandidate(io, p, id) {
    if (!validRecoveryId(id)) throw new Error('恢复候选 id 不合式');
    const candidate = await io.readJson(p.recoveryCandidate(id));
    if (candidate?.status === 'pruned') return { candidate: null, pruned: true };
    if (candidate === null && await wasPruned(io, p, id)) return { candidate: null, pruned: true };
    return { candidate, pruned: false };
}

export async function listRecoveryCandidates(io, p, novel = null) {
    const names = await io.listNames(p.recoveryDir);
    const rows = [];
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        if (!validRecoveryId(id)) continue;
        try {
            const candidate = await io.readJson(p.recoveryCandidate(id));
            if (candidate === null || candidate.status === 'pruned') continue;
            if (String(candidate.partialText ?? '').trim() === '') continue;
            if (!['failed', 'rejected', 'generated'].includes(candidate.status)) continue;
            const stale = candidate.kind === 'draft' && novel?.chapters?.[String(candidate.chapter)] !== undefined;
            rows.push(recoveryView(candidate, { stale }));
        } catch { /* 单个损坏候选不拖垮整个列表 */ }
    }
    return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

async function saveBestEffort(io, p, candidate, warned) {
    try {
        await io.writeJson(p.recoveryCandidate(candidate.id), candidate, 'auto');
    } catch (error) {
        if (!warned.value) {
            warned.value = true;
            console.warn(`[novel-forge] 恢复候选写入失败（不影响正文流程）: ${error?.message ?? error}`);
        }
    }
}

/** 一章一次生成调用的记录器；onDelta 由引擎 await，保证节流落盘不竞写。 */
export function createRecoveryRecorder({ io, p, book, runId, chapter, sourceHash, kind = 'draft' }) {
    const attemptId = `${runId}-C${chapter}`;
    const now = new Date().toISOString();
    const candidate = {
        version: 1, id: `R${attemptId}`, book, runId, attemptId, chapter, kind,
        status: 'running', partialText: '', sourceHash, createdAt: now, updatedAt: now,
        engineAttempt: 0, contextRetry: 0,
    };
    const warned = { value: false };
    let lastSavedAt = 0;
    let lastSavedChars = 0;

    const save = async (force = false) => {
        candidate.updatedAt = new Date().toISOString();
        candidate.chars = candidate.partialText.length;
        const timestamp = Date.now();
        if (!force && lastSavedAt !== 0 && candidate.partialText.length - lastSavedChars < 1000 && timestamp - lastSavedAt < 2000) return;
        await saveBestEffort(io, p, candidate, warned);
        lastSavedAt = timestamp;
        lastSavedChars = candidate.partialText.length;
    };

    return {
        candidate,
        start: () => save(true),
        resetForContextRetry: async (contextRetry) => {
            candidate.contextRetry = contextRetry;
            candidate.partialText = '';
            candidate.status = 'running';
            lastSavedChars = 0;
            await save(true);
        },
        onDelta: async (chunk, info = {}) => {
            if (chunk?.type !== 'text-delta') return;
            if (Number.isInteger(info.attempt)) candidate.engineAttempt = info.attempt;
            if (typeof info.text === 'string') candidate.partialText = info.text;
            else candidate.partialText += String(chunk.text ?? '');
            await save(false);
        },
        finish: async (result, { status = null, content = null, error = null } = {}) => {
            if (typeof result?.partialText === 'string' && content === null) candidate.partialText = result.partialText;
            if (typeof content === 'string') candidate.partialText = content;
            if (Number.isInteger(result?.attempts)) candidate.engineAttempt = result.attempts;
            candidate.status = status ?? (result?.ok ? 'generated' : 'failed');
            if (error !== null || result?.error) {
                const failure = error ?? result.error;
                candidate.error = { code: String(failure?.code ?? 'GENERATION_FAILED'), message: String(failure?.message ?? failure) };
            }
            await save(true);
            // 终态是「这枚候选再也不会被写」的时点——顺手做保留清理（失败只告警，不拦正路）。
            if (shouldSweep(`${p.meta}\0recovery`)) {
                try {
                    const sweep = await pruneRecoveryCandidates(io, p);
                    if (sweep.pruned > 0) {
                        console.info(`[novel-forge] 恢复候选保留策略：清理 ${sweep.pruned} 个过期候选（保留最近 ${RETENTION_POLICY.recovery.keepNewest} 个或 ${RETENTION_POLICY.recovery.maxAgeDays} 天内）`);
                    }
                } catch (error) {
                    warnRetentionFailure('恢复候选', error);
                }
            }
            return recoveryView(candidate);
        },
        committed: async (commit = {}) => {
            candidate.status = 'committed';
            candidate.committedVersion = commit.version;
            candidate.partialText = '';
            delete candidate.error;
            await save(true);
        },
    };
}
