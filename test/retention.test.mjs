// 保留策略（过期清理）：幂等回执与恢复候选的超龄/超量清出。
// 宿主支持 deleteFile 时真删文件；老宿主（peerDependencies 是 `*`）回退为
// status:'pruned' 墓碑（读路径视同不存在）。两条路径外部行为一致：同键/同 id 重跑安全。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runIdempotent, pruneInvocationReceipts } from '../lib/request-idempotency.js';
import { pruneRecoveryCandidates, readRecoveryCandidate, listRecoveryCandidates } from '../lib/recovery.js';
import { PRUNED_INDEX_LIMIT, shouldSweep } from '../lib/retention.js';
import { pathsFor } from '../lib/store.js';

/**
 * 内存替身。`deletable: true` 时提供 deleteFile（模拟新宿主）；缺省不提供
 * （模拟老宿主，走墓碑回退）。版本号按写次数单调递增，与真机「读时捕获版本」
 * 的语义一致——删除/守卫写版本不符一律 FS_STALE_VERSION。
 */
function memIo({ deletable = false } = {}) {
    const files = new Map();
    const versions = new Map();
    let seq = 0;
    const bump = (path) => { seq += 1; versions.set(path, `v${seq}`); };
    const stale = (message) => Object.assign(new Error(message), { code: 'FS_STALE_VERSION' });
    const io = {
        files,
        async readJson(path) { return files.has(path) ? JSON.parse(files.get(path)) : null; },
        async readJsonWithVersion(path) {
            return files.has(path)
                ? { value: JSON.parse(files.get(path)), version: versions.get(path) }
                : { value: null, version: null };
        },
        async writeJson(path, value) { files.set(path, JSON.stringify(value)); bump(path); },
        async writeJsonAtVersion(path, value, version) {
            const exists = files.has(path);
            if (version === null || version === undefined) {
                if (exists) throw stale(`${path} 已存在`);
            } else if (!exists || versions.get(path) !== version) {
                throw stale(`${path} 版本不符`);
            }
            files.set(path, JSON.stringify(value));
            bump(path);
        },
        async listNames(dir) {
            const prefix = `${dir}/`;
            return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
        },
    };
    if (deletable) {
        io.deleteFile = async (path, expected) => {
            if (!files.has(path)) throw stale(`${path} 不存在`);
            if (expected?.version !== versions.get(path)) throw stale(`${path} 版本不符`);
            const before = files.get(path);
            files.delete(path);
            versions.delete(path);
            return { before };
        };
    }
    return io;
}

const NOW = new Date('2026-11-10T10:00:00.000Z');
const daysAgo = (n) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

function seedReceipt(io, p, nonce, createdAt) {
    return io.writeJson(p.invocation(nonce), {
        version: 1, nonce, operation: 'test-write', fingerprint: 'f', status: 'done',
        response: { ok: true }, createdAt,
    });
}

test('retention: 幂等回执按龄+按量墓碑化，新回执原地保留', async () => {
    const io = memIo();
    const p = pathsFor('保留书');
    await seedReceipt(io, p, 'receipt-a', NOW.toISOString());
    await seedReceipt(io, p, 'receipt-b', NOW.toISOString());
    await seedReceipt(io, p, 'receipt-c', NOW.toISOString());
    await seedReceipt(io, p, 'receipt-d', daysAgo(10)); // 未超龄：即使超出 keepNewest=3 也按并集保留
    await seedReceipt(io, p, 'receipt-e', daysAgo(40)); // 既超量又超龄
    const sweep = await pruneInvocationReceipts(io, p, { keepNewest: 3, maxAgeDays: 30, now: NOW });
    assert.deepEqual(sweep, { scanned: 5, pruned: 1 });
    for (const nonce of ['receipt-a', 'receipt-b', 'receipt-c', 'receipt-d']) {
        assert.equal(JSON.parse(io.files.get(p.invocation(nonce))).status, 'done');
    }
    const tomb = JSON.parse(io.files.get(p.invocation('receipt-e')));
    assert.equal(tomb.status, 'pruned');
    assert.equal(tomb.nonce, 'receipt-e');
    assert.ok(tomb.prunedAt);
    // 墓碑化的键重跑安全：走全新回执。
    let calls = 0;
    const rerun = await runIdempotent({
        io, p, nonce: 'receipt-e', operation: 'test-write', payload: { chapter: 1 },
        execute: async () => { calls += 1; return { ok: true, version: 2 }; },
    });
    assert.equal(calls, 1);
    assert.equal(rerun.value.version, 2);
    assert.equal(rerun.replayed, false);
});

test('retention: 损坏回执不动（409 响亮兜），listNames 失败不拦正路', async () => {
    const io = memIo();
    const p = pathsFor('保留书');
    await seedReceipt(io, p, 'receipt-ok', NOW.toISOString());
    io.files.set(p.invocation('receipt-bad'), '{not json');
    const sweep = await pruneInvocationReceipts(io, p, { keepNewest: 3, maxAgeDays: 30, now: NOW });
    assert.equal(sweep.scanned, 1);
    assert.equal(sweep.pruned, 0);
    assert.equal(io.files.get(p.invocation('receipt-bad')), '{not json');

    // listNames 抛错：prune 本身响亮上抛，但 runIdempotent 只 warn 不失败。
    const broken = memIo();
    broken.listNames = async () => { throw new Error('no list here'); };
    const result = await runIdempotent({
        io: broken, p: pathsFor('保留书'), nonce: 'nonce-sweep', operation: 'test-write', payload: { chapter: 1 },
        execute: async () => ({ ok: true }),
    });
    assert.equal(result.value.ok, true);
    assert.equal(result.receiptStored, true);
    await assert.rejects(pruneInvocationReceipts(broken, pathsFor('保留书')), /no list here/);
});

test('retention: 恢复候选墓碑化后读取=不存在、列表跳过；committed 优先清出', async () => {
    const io = memIo();
    const p = pathsFor('保留书');
    const seed = (id, updatedAt, extra = {}) => io.writeJson(p.recoveryCandidate(id), {
        version: 1, id, runId: 'D1', attemptId: `${id}-a`, chapter: 1, kind: 'draft',
        status: 'failed', partialText: '候选文本'.repeat(30), sourceHash: 'h',
        createdAt: updatedAt, updatedAt, ...extra,
    });
    await seed('R1', NOW.toISOString());
    await seed('R2', NOW.toISOString());
    await seed('R3', daysAgo(25)); // 未超龄：并集保留，不占 keepNewest=2 也留下
    await seed('R5', daysAgo(20), { status: 'committed', partialText: '' }); // 已提交，无恢复价值
    await seed('R4', daysAgo(40)); // 既超量又超龄
    const sweep = await pruneRecoveryCandidates(io, p, { keepNewest: 2, maxAgeDays: 30, now: NOW });
    assert.deepEqual(sweep, { scanned: 5, pruned: 2 });
    assert.equal(JSON.parse(io.files.get(p.recoveryCandidate('R1'))).status, 'failed');
    assert.equal(JSON.parse(io.files.get(p.recoveryCandidate('R3'))).status, 'failed');
    // committed 候选即便在 30 天内也优先清出；未取回的 failed 候选保留优先级更高。
    for (const id of ['R4', 'R5']) {
        assert.equal(JSON.parse(io.files.get(p.recoveryCandidate(id))).status, 'pruned');
    }
    const kept = await readRecoveryCandidate(io, p, 'R3');
    assert.equal(kept.pruned, false);
    assert.equal(kept.candidate.id, 'R3');
    const gone = await readRecoveryCandidate(io, p, 'R4');
    assert.deepEqual(gone, { candidate: null, pruned: true });
    const listed = await listRecoveryCandidates(io, p);
    assert.deepEqual(listed.map((row) => row.id).sort(), ['R1', 'R2', 'R3']);
});

test('retention: 宿主有 deleteFile 时真删过期回执，外部行为与墓碑回退一致', async () => {
    const seedAll = async (io) => {
        const p = pathsFor('保留书');
        await seedReceipt(io, p, 'receipt-a', NOW.toISOString());
        await seedReceipt(io, p, 'receipt-b', NOW.toISOString());
        await seedReceipt(io, p, 'receipt-c', NOW.toISOString());
        await seedReceipt(io, p, 'receipt-d', daysAgo(10)); // 未超龄：并集保留
        await seedReceipt(io, p, 'receipt-e', daysAgo(40)); // 既超量又超龄
        return p;
    };
    const runAgain = async (io, p) => {
        let calls = 0;
        const run = await runIdempotent({
            io, p, nonce: 'receipt-e', operation: 'test-write', payload: { chapter: 1 },
            execute: async () => { calls += 1; return { ok: true, version: 2 }; },
        });
        return { calls, run };
    };

    // 新宿主：真删。
    const hard = memIo({ deletable: true });
    const pHard = await seedAll(hard);
    const hardSweep = await pruneInvocationReceipts(hard, pHard, { keepNewest: 3, maxAgeDays: 30, now: NOW });
    assert.deepEqual(hardSweep, { scanned: 5, pruned: 1 });
    assert.equal(hard.files.has(pHard.invocation('receipt-e')), false, '真删后文件必须消失');
    for (const nonce of ['receipt-a', 'receipt-b', 'receipt-c', 'receipt-d']) {
        assert.equal(JSON.parse(hard.files.get(pHard.invocation(nonce))).status, 'done');
    }

    // 老宿主：回退成墓碑（文件仍在，读路径视同不存在）。
    const soft = memIo();
    const pSoft = await seedAll(soft);
    const softSweep = await pruneInvocationReceipts(soft, pSoft, { keepNewest: 3, maxAgeDays: 30, now: NOW });
    assert.deepEqual(softSweep, { scanned: 5, pruned: 1 });
    assert.equal(JSON.parse(soft.files.get(pSoft.invocation('receipt-e'))).status, 'pruned');

    // 两条路径的外部行为逐字一致：同键重跑都只执行一次、都拿到全新结果。
    assert.deepEqual(await runAgain(hard, pHard), await runAgain(soft, pSoft));
    assert.equal(JSON.parse(hard.files.get(pHard.invocation('receipt-e'))).status, 'done', '重跑写回的全新回执');
});

test('retention: 删除撞 FS_STALE_VERSION 跳过，绝不删有效数据', async () => {
    const io = memIo({ deletable: true });
    const p = pathsFor('保留书');
    await seedReceipt(io, p, 'receipt-a', NOW.toISOString());
    await seedReceipt(io, p, 'receipt-e', daysAgo(40));
    // 模拟竞态：扫描读到旧版本后、删除前，同键重跑写回了新回执 → 宿主报 stale。
    io.deleteFile = async () => { throw Object.assign(new Error('FS_STALE_VERSION: 并发写回'), { code: 'FS_STALE_VERSION' }); };
    const sweep = await pruneInvocationReceipts(io, p, { keepNewest: 1, maxAgeDays: 30, now: NOW });
    assert.deepEqual(sweep, { scanned: 2, pruned: 0 });
    assert.equal(JSON.parse(io.files.get(p.invocation('receipt-e'))).status, 'done', '有效回执不得被删');
});

test('retention: 恢复候选真删后靠有界索引维持「已清理 / 从未存在」区分', async () => {
    const io = memIo({ deletable: true });
    const p = pathsFor('保留书');
    const seed = (id, updatedAt, extra = {}) => io.writeJson(p.recoveryCandidate(id), {
        version: 1, id, runId: 'D1', attemptId: `${id}-a`, chapter: 1, kind: 'draft',
        status: 'failed', partialText: '候选文本'.repeat(30), sourceHash: 'h',
        createdAt: updatedAt, updatedAt, ...extra,
    });
    await seed('R1', NOW.toISOString());
    await seed('R2', NOW.toISOString());
    await seed('R3', daysAgo(25));
    await seed('R5', daysAgo(20), { status: 'committed', partialText: '' });
    await seed('R4', daysAgo(40));
    const sweep = await pruneRecoveryCandidates(io, p, { keepNewest: 2, maxAgeDays: 30, now: NOW });
    assert.deepEqual(sweep, { scanned: 5, pruned: 2 });
    for (const id of ['R4', 'R5']) {
        assert.equal(io.files.has(p.recoveryCandidate(id)), false, `${id} 必须真删`);
    }
    // 索引只记被清出的 id 与时间
    const index = JSON.parse(io.files.get(p.recoveryPruned));
    assert.deepEqual(index.items.map((row) => row.id).sort(), ['R4', 'R5']);
    assert.ok(index.items.every((row) => row.prunedAt === NOW.toISOString()));
    // 404 区分：已清理 vs 从未存在 vs 仍在
    assert.deepEqual(await readRecoveryCandidate(io, p, 'R4'), { candidate: null, pruned: true });
    assert.deepEqual(await readRecoveryCandidate(io, p, 'R9'), { candidate: null, pruned: false });
    assert.equal((await readRecoveryCandidate(io, p, 'R3')).candidate.id, 'R3');
    const listed = await listRecoveryCandidates(io, p);
    assert.deepEqual(listed.map((row) => row.id).sort(), ['R1', 'R2', 'R3']);
});

test('retention: 已清理索引有界（上限 200、按时间淘汰最旧、同 id 去重）', async () => {
    const io = memIo({ deletable: true });
    const p = pathsFor('保留书');
    const seed = (id) => io.writeJson(p.recoveryCandidate(id), {
        version: 1, id, runId: 'D1', attemptId: `${id}-a`, chapter: 1, kind: 'draft',
        status: 'committed', partialText: '', sourceHash: 'h', createdAt: daysAgo(1), updatedAt: daysAgo(1),
    });
    const first = [];
    for (let i = 0; i < 150; i += 1) {
        const id = `RA${String(i).padStart(3, '0')}`;
        first.push(id);
        await seed(id);
    }
    await pruneRecoveryCandidates(io, p, { keepNewest: 20, maxAgeDays: 30, now: new Date(daysAgo(1)) });
    assert.equal(JSON.parse(io.files.get(p.recoveryPruned)).items.length, 150);

    const second = [];
    for (let i = 0; i < 100; i += 1) {
        const id = `RB${String(i).padStart(3, '0')}`;
        second.push(id);
        await seed(id);
    }
    await pruneRecoveryCandidates(io, p, { keepNewest: 20, maxAgeDays: 30, now: NOW });
    const items = JSON.parse(io.files.get(p.recoveryPruned)).items;
    assert.equal(items.length, PRUNED_INDEX_LIMIT);
    assert.equal(new Set(items.map((row) => row.id)).size, items.length, '同 id 不得重复');
    for (const id of second) assert.ok(items.some((row) => row.id === id), `${id}（最新一批）必须保留`);
    assert.equal(items.some((row) => row.id === first[0]), true, '较早批次的老记录按时间从尾部淘汰');
    assert.equal(items.some((row) => row.id === first[149]), false, '超出上限的最旧记录必须淘汰');
    // 有界索引的已知代价：被淘汰的 id 只能按「从未存在」返回（不是数据丢失——文件早已被保留策略清出）
    assert.deepEqual(await readRecoveryCandidate(io, p, first[149]), { candidate: null, pruned: false });

    // 同 id 再次被清出时去重，不占额外名额
    await seed(second[0]);
    await pruneRecoveryCandidates(io, p, { keepNewest: 20, maxAgeDays: 30, now: NOW });
    const deduped = JSON.parse(io.files.get(p.recoveryPruned)).items;
    assert.equal(deduped.length, PRUNED_INDEX_LIMIT);
    assert.equal(deduped.filter((row) => row.id === second[0]).length, 1);
});

test('retention: 扫描节流按写入次数与时间触发，进程重启（lastAt=0）立即扫一次', () => {
    const bucket = '节流测试桶';
    const t0 = 1_000_000;
    assert.equal(shouldSweep(bucket, { everyWrites: 3, intervalMs: 1000, now: t0 }), true); // 进程内首次写入
    assert.equal(shouldSweep(bucket, { everyWrites: 3, intervalMs: 1000, now: t0 + 10 }), false);
    assert.equal(shouldSweep(bucket, { everyWrites: 3, intervalMs: 1000, now: t0 + 20 }), false);
    assert.equal(shouldSweep(bucket, { everyWrites: 3, intervalMs: 1000, now: t0 + 30 }), true); // 第 3 次写
    assert.equal(shouldSweep(bucket, { everyWrites: 3, intervalMs: 1000, now: t0 + 40 }), false);
    assert.equal(shouldSweep(bucket, { everyWrites: 3, intervalMs: 2000, now: t0 + 2041 }), true); // 时间到
});
