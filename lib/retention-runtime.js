// lib/retention-runtime.js — 保留清理的进程内节流与告警状态。

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

const warnedBuckets = new Set();

export function warnRetentionFailure(bucket, error) {
    if (warnedBuckets.has(bucket)) return;
    warnedBuckets.add(bucket);
    console.warn(`[novel-forge] ${bucket} 保留清理失败（不影响主流程，同类告警本进程只报一次）: ${error?.message ?? error}`);
}
