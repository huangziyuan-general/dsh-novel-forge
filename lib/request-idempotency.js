// lib/request-idempotency.js — REST 写请求的持久化幂等回执。

import { createHash } from 'node:crypto';
import { stableStringify } from './basis.js';
import { HttpRequestError } from './server-http.js';
import {
    RETENTION_POLICY, canHardDelete, isStaleVersion, planRetention, shouldSweep, warnRetentionFailure,
} from './retention.js';

const NONCE_RE = /^[A-Za-z0-9_-]{8,128}$/;
const inFlight = new Map();

// 回执保留策略：宿主**有** deleteFile（带版本守卫与沙箱围栏），扫描时真删过期回执；
// 老宿主（peerDependencies 是 `*`，能力可能缺席）回退成墓碑（status:'pruned' 的小记录，
// 读路径视同不存在）。两条路径的**外部行为一致**：被清掉的 nonce 都可安全重跑，重跑写
// 一枚全新回执。保留语义、常量、能力探测与扫描节流统一在 lib/retention.js。
let warnedReceiptWrite = false;

export function validInvocationNonce(nonce) {
    return typeof nonce === 'string' && NONCE_RE.test(nonce);
}

export function invocationFingerprint(operation, payload) {
    return createHash('sha256').update(stableStringify({ operation, payload })).digest('hex');
}

/**
 * 回执保留扫描：把「既超出最近 keepNewest 条、又超龄」的回执清出（并集保留，
 * 见 lib/retention.js）。宿主支持 deleteFile 时真删，否则改写为墓碑。单个清理
 * 失败不拖垮整体，下次扫描重试。损坏回执（readJson 抛错）不动——409
 * IDEMPOTENCY_CORRUPT 会响亮兜住，比静默改写/删除安全。
 *
 * 防删错有效数据：删除带读时捕获的 `{version}`；撞 FS_STALE_VERSION 一律跳过——
 * 说明这期间同键重跑已经写回了新回执，删掉就是删掉有效数据。拿不到基线版本
 * （读与列目录之间文件消失）同样不删。
 */
export async function pruneInvocationReceipts(io, p, {
    keepNewest = RETENTION_POLICY.invocations.keepNewest,
    maxAgeDays = RETENTION_POLICY.invocations.maxAgeDays,
    now = new Date(),
} = {}) {
    const hardDelete = canHardDelete(io);
    const names = await io.listNames(p.invocationsDir);
    const rows = [];
    const versions = new Map();
    for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const nonce = name.slice(0, -5);
        if (!validInvocationNonce(nonce)) continue;
        let receipt;
        try {
            if (hardDelete) {
                const current = await io.readJsonWithVersion(p.invocation(nonce));
                receipt = current.value;
                if (current.version !== null) versions.set(nonce, current.version);
            } else {
                receipt = await io.readJson(p.invocation(nonce));
            }
        } catch { continue; }
        if (receipt === null || receipt?.status === 'pruned') continue;
        rows.push({ key: nonce, at: String(receipt?.createdAt ?? '') });
    }
    const { prune } = planRetention(rows, { keepNewest, maxAgeDays, now });
    let pruned = 0;
    for (const nonce of prune) {
        try {
            if (hardDelete) {
                const version = versions.get(nonce);
                if (version === undefined || version === null) continue;
                await io.deleteFile(p.invocation(nonce), { version });
            } else {
                await io.writeJson(p.invocation(nonce), { version: 1, nonce, status: 'pruned', prunedAt: now.toISOString() }, 'auto');
            }
            pruned += 1;
        } catch (error) {
            if (isStaleVersion(error)) continue; // 期间同键重跑写回了新回执：跳过，绝不删有效数据
            /* 下次扫描重试 */
        }
    }
    return { scanned: rows.length, pruned };
}

/**
 * 同一 nonce 的并发调用共享一个 Promise；成功结果落盘后可跨重启回放。
 * shouldCache 默认只缓存业务成功（value.ok !== false），瞬时失败允许同键重试。
 */
export async function runIdempotent({ io, p, nonce, operation, payload, execute, shouldCache = null }) {
    if (nonce === undefined || nonce === null || nonce === '') {
        return { value: await execute(), replayed: false, receiptStored: false };
    }
    if (!validInvocationNonce(nonce)) throw new HttpRequestError(400, 'INVALID_NONCE', 'invocationNonce 须为 8–128 位字母、数字、下划线或连字符');
    const fingerprint = invocationFingerprint(operation, payload);
    const key = `${p.meta}\0${nonce}`;
    const pending = inFlight.get(key);
    if (pending !== undefined) {
        if (pending.fingerprint !== fingerprint) {
            throw new HttpRequestError(409, 'IDEMPOTENCY_CONFLICT', '同一 invocationNonce 不得用于不同请求内容');
        }
        return { ...(await pending.task), replayed: true };
    }

    // 必须在第一次 await 之前登记；否则两个请求会一起读不到回执、各自执行一次。
    const task = (async () => {
        let existing;
        try { existing = await io.readJson(p.invocation(nonce)); }
        catch { throw new HttpRequestError(409, 'IDEMPOTENCY_CORRUPT', '该 invocationNonce 的回执无法读取，请换一个新键'); }
        if (existing !== null && existing.status !== 'pruned') {
            if (existing.operation !== operation || existing.fingerprint !== fingerprint) {
                throw new HttpRequestError(409, 'IDEMPOTENCY_CONFLICT', '同一 invocationNonce 不得用于不同请求内容');
            }
            if (existing.status === 'done') return { value: existing.response, replayed: true, receiptStored: true };
            throw new HttpRequestError(409, 'IDEMPOTENCY_CORRUPT', '该 invocationNonce 的回执尚未完成，请换一个新键');
        }
        // 墓碑（status:'pruned'，老宿主回退形态）与真删后的不存在回执同义：保留策略
        // 已把它判为过期，同键重跑是安全且符合语义的——重跑会写一枚全新回执。
        const value = await execute();
        const cache = shouldCache === null ? value?.ok !== false : shouldCache(value) === true;
        let stored = false;
        if (cache) {
            const receipt = {
                version: 1, nonce, operation, fingerprint, status: 'done',
                response: value, createdAt: new Date().toISOString(),
            };
            try {
                await io.writeJson(p.invocation(nonce), receipt, 'auto');
                stored = true;
            } catch (error) {
                // 回执写失败绝不能把已成功的执行变成 500：结果照常返回（receiptStored:false
                // 由路由透出警示），代价只是同键重试会重新执行一次。把结果丢掉才是真损失。
                if (!warnedReceiptWrite) {
                    warnedReceiptWrite = true;
                    console.warn(`[novel-forge] 幂等回执写入失败（本次请求照常返回，同键重试将重新执行）: ${error?.message ?? error}`);
                }
            }
        }
        if (stored) {
            // 节流：不是每次落盘都全量扫目录（闸门与选值理由见 lib/retention.js）。
            if (shouldSweep(`${p.meta}\0invocations`)) {
                try {
                    const sweep = await pruneInvocationReceipts(io, p);
                    if (sweep.pruned > 0) {
                        console.info(`[novel-forge] 幂等回执保留策略：清理 ${sweep.pruned} 条过期回执（保留最近 ${RETENTION_POLICY.invocations.keepNewest} 条或 ${RETENTION_POLICY.invocations.maxAgeDays} 天内）`);
                    }
                } catch (error) {
                    // 清理是便利设施：listNames 缺席（测试替身）或目录异常都不拦正路。
                    warnRetentionFailure('幂等回执', error);
                }
            }
        }
        return { value, replayed: false, receiptStored: stored };
    })();
    inFlight.set(key, { fingerprint, task });
    try { return await task; }
    finally { inFlight.delete(key); }
}
