// lib/retention.js — 保留策略的共同逻辑。
//
// 宿主**有** deleteFile（带版本守卫与沙箱围栏，见 @deepseek-ai/dsh-fs 的
// FileSystem 契约）；它没有的是公开的 mkdir / deleteDir。老宿主可能缺 deleteFile
// （peerDependencies 是 `*`），所以清理优先真删、探测不到就回退成墓碑
// （status:'pruned' 的小记录，读路径视同不存在）。
//
// 本模块只决定「保留哪些 / 清出哪些」以及「这次要不要扫」；列目录、读写文件、
// 落盘一律由调用方（幂等回执 / 恢复候选）完成，本模块不碰 io。

// 保留常量只此一份：幂等回执与恢复候选各引用同一组值，不再各写一套。
export const MAX_AGE_DAYS = 30;
export const KEEP_NEWEST = Object.freeze({ invocations: 200, recovery: 20 });
// 恢复候选「已清理 id」索引的上限：只用于把 404 区分成「已清理」与「从未存在」，
// 超出按 prunedAt 淘汰最旧的——索引自身不能无界。
export const PRUNED_INDEX_LIMIT = 200;

/**
 * 真删能力探测的唯一入口：fsio 只在宿主提供 deleteFile 时才挂同名方法。
 * 两个调用方（幂等回执 / 恢复候选）都用它，不各写一份 typeof 判断。
 */
export function canHardDelete(io) {
    return typeof io?.deleteFile === 'function';
}

/** 删除撞版本冲突（期间同键重跑写回了新文件）——必须跳过，绝不能删有效数据。 */
export function isStaleVersion(error) {
    return String(error?.code ?? '') === 'FS_STALE_VERSION'
        || /^FS_STALE_VERSION\b/.test(String(error?.message ?? error ?? ''));
}

export const RETENTION_POLICY = Object.freeze({
    invocations: Object.freeze({ keepNewest: KEEP_NEWEST.invocations, maxAgeDays: MAX_AGE_DAYS }),
    recovery: Object.freeze({ keepNewest: KEEP_NEWEST.recovery, maxAgeDays: MAX_AGE_DAYS }),
});

/**
 * 计算保留 / 清出名单。
 *
 * 保留语义是**并集**：最近 keepNewest 条**或**未超龄（不早于 now - maxAgeDays）
 * 的都保留；只有「既超出条数又超龄」才清出。这样「30 天内可回放」是可预期的，
 * 代价是 30 天内可能多于 keepNewest 条（文件数短期偏高）。
 *
 * 时间戳无法解析的条目按「超龄」处理——不能证明它未超龄，就只能靠条数保护，
 * 避免损坏记录永久占位。
 *
 * @param {Array<{key: string, at: string}>} rows 已剔除墓碑与非法名的条目
 * @param {{keepNewest: number, maxAgeDays: number, now?: Date}} policy
 * @returns {{keep: string[], prune: string[]}}
 */
export function planRetention(rows, { keepNewest, maxAgeDays, now = new Date() }) {
    const cutoff = now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000;
    const sorted = [...rows].sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')));
    const keep = [];
    const prune = [];
    for (const [index, row] of sorted.entries()) {
        const ts = Date.parse(String(row.at ?? ''));
        if (index < keepNewest || (!Number.isNaN(ts) && ts >= cutoff)) keep.push(row.key);
        else prune.push(row.key);
    }
    return { keep, prune };
}

// 扫描节流：每个 bucket 每 20 次写入或每 60 秒至多全量扫一次目录。
// 选值理由：幂等回执按人工节奏的 REST 写请求产生，恢复候选按章终态产生（一批 20
// 章约 20 次）；60 秒把目录扫描压到每分钟至多一次，20 次写又保证快速批次至少扫一次。
// 闸门是进程内状态：进程重启后 lastAt 归零 ⇒ 重启后第一次写立刻扫描，所以重启只会
// 让清理更频繁，不会导致长期不清理；若进程常年只做少量写入，时间闸门到点后的下一次
// 写仍会扫——不存在「永不扫描」的路径。
const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_EVERY_WRITES = 20;
const sweepGates = new Map();

export function shouldSweep(bucket, { intervalMs = SWEEP_INTERVAL_MS, everyWrites = SWEEP_EVERY_WRITES, now = Date.now() } = {}) {
    const gate = sweepGates.get(bucket) ?? { lastAt: 0, writes: 0 };
    gate.writes += 1;
    const due = gate.lastAt === 0 || gate.writes >= everyWrites || now - gate.lastAt >= intervalMs;
    if (due) {
        gate.lastAt = now;
        gate.writes = 0;
    }
    sweepGates.set(bucket, gate);
    return due;
}

// 清理是便利设施：失败只告警、不拦主路。每个 bucket 本进程只报一次，
// 避免批量生成期逐章刷同一条 warn。
const warnedBuckets = new Set();

export function warnRetentionFailure(bucket, error) {
    if (warnedBuckets.has(bucket)) return;
    warnedBuckets.add(bucket);
    console.warn(`[novel-forge] ${bucket} 保留清理失败（不影响主流程，同类告警本进程只报一次）: ${error?.message ?? error}`);
}
