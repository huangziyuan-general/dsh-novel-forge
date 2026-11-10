// lib/retention.js — 保留策略的共同逻辑。
//
// 宿主**有** deleteFile（带版本守卫与沙箱围栏，见 @deepseek-ai/dsh-fs 的
// FileSystem 契约）；它没有的是公开的 mkdir / deleteDir。老宿主可能缺 deleteFile
// （peerDependencies 是 `*`），所以清理优先真删、探测不到就回退成墓碑
// （status:'pruned' 的小记录，读路径视同不存在）。
//
// 本模块只决定「保留哪些 / 清出哪些」；扫描节流与日志在 retention-runtime.js，
// 列目录、读写文件、落盘由调用方（幂等回执 / 恢复候选）完成。

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
export function planRetention(rows, { keepNewest, maxAgeDays, now }) {
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
