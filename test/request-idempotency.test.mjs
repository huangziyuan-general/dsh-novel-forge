import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runIdempotent } from '../lib/request-idempotency.js';
import { pathsFor } from '../lib/store.js';

function memIo() {
    const files = new Map();
    return {
        files,
        async readJson(path) { return files.has(path) ? JSON.parse(files.get(path)) : null; },
        async writeJson(path, value) { files.set(path, JSON.stringify(value)); },
        async listNames(dir) {
            const prefix = `${dir}/`;
            return [...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length));
        },
    };
}

const base = (io, nonce = 'nonce-0001') => ({
    io, p: pathsFor('幂等书'), nonce, operation: 'test-write', payload: { chapter: 1 },
});

test('idempotency: 顺序与并发重放都只执行一次，成功回执持久化', async () => {
    const io = memIo();
    let calls = 0;
    let release;
    const execute = async () => {
        calls += 1;
        await new Promise((resolve) => { release = resolve; });
        return { ok: true, proposalId: 'P1-fixed' };
    };
    const first = runIdempotent({ ...base(io), execute });
    const concurrent = runIdempotent({ ...base(io), execute });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    assert.deepEqual(await first, { value: { ok: true, proposalId: 'P1-fixed' }, replayed: false, receiptStored: true });
    assert.deepEqual(await concurrent, { value: { ok: true, proposalId: 'P1-fixed' }, replayed: true, receiptStored: true });
    const replay = await runIdempotent({ ...base(io), execute });
    assert.equal(replay.replayed, true);
    assert.equal(replay.value.proposalId, 'P1-fixed');
    assert.equal(calls, 1);
    assert.ok(io.files.has(pathsFor('幂等书').invocation('nonce-0001')));
});

test('idempotency: 同键不同请求响亮冲突，失败结果不阻塞同键重试', async () => {
    const io = memIo();
    await runIdempotent({ ...base(io), execute: async () => ({ ok: true, version: 1 }) });
    await assert.rejects(runIdempotent({
        ...base(io), payload: { chapter: 2 }, execute: async () => ({ ok: true }),
    }), (error) => error.httpStatus === 409 && error.errorCode === 'IDEMPOTENCY_CONFLICT');

    let calls = 0;
    const retryBase = { ...base(io, 'nonce-retry'), operation: 'transient' };
    const first = await runIdempotent({
        ...retryBase,
        shouldCache: (value) => value.ok,
        execute: async () => { calls += 1; return { ok: false, error: { code: 'RATE_LIMIT' } }; },
    });
    assert.equal(first.receiptStored, false);
    const second = await runIdempotent({
        ...retryBase,
        shouldCache: (value) => value.ok,
        execute: async () => { calls += 1; return { ok: true, version: 2 }; },
    });
    assert.equal(second.value.ok, true);
    assert.equal(calls, 2);
});

test('idempotency: 并发中的同键不同请求也冲突，不共享错误 Promise', async () => {
    const io = memIo();
    let calls = 0;
    let release;
    const first = runIdempotent({
        ...base(io), execute: async () => {
            calls += 1;
            await new Promise((resolve) => { release = resolve; });
            return { ok: true, chapter: 1 };
        },
    });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(runIdempotent({
        ...base(io), payload: { chapter: 2 }, execute: async () => {
            calls += 1;
            return { ok: true, chapter: 2 };
        },
    }), (error) => error.httpStatus === 409 && error.errorCode === 'IDEMPOTENCY_CONFLICT');
    release();
    assert.equal((await first).value.chapter, 1);
    assert.equal(calls, 1);
});

test('idempotency: 回执写入失败不抛错，receiptStored:false 且同键可重跑', async () => {
    const io = memIo();
    io.writeJson = async () => { throw new Error('disk full'); };
    let calls = 0;
    const first = await runIdempotent({
        ...base(io), execute: async () => { calls += 1; return { ok: true, version: 1 }; },
    });
    assert.equal(first.value.version, 1);
    assert.equal(first.replayed, false);
    assert.equal(first.receiptStored, false);
    // 无回执 ⇒ 同键重试重新执行（结果不受影响，代价只是重复执行一次）。
    const second = await runIdempotent({
        ...base(io), execute: async () => { calls += 1; return { ok: true, version: 2 }; },
    });
    assert.equal(second.value.version, 2);
    assert.equal(second.replayed, false);
    assert.equal(calls, 2);
});

test('idempotency: 墓碑回执视同不存在，同键安全重跑', async () => {
    const io = memIo();
    const p = pathsFor('幂等书');
    await io.writeJson(p.invocation('nonce-tomb'), {
        version: 1, nonce: 'nonce-tomb', operation: 'test-write',
        fingerprint: 'stale', status: 'pruned', prunedAt: new Date().toISOString(),
    });
    let calls = 0;
    const rerun = await runIdempotent({
        ...base(io, 'nonce-tomb'),
        execute: async () => { calls += 1; return { ok: true, version: 9 }; },
    });
    assert.equal(calls, 1);
    assert.equal(rerun.value.version, 9);
    assert.equal(rerun.replayed, false);
    assert.equal(rerun.receiptStored, true);
    // 重跑写的是全新回执（fingerprint 覆盖墓碑），再跑一次正常回放。
    const replay = await runIdempotent({ ...base(io, 'nonce-tomb'), execute: async () => { calls += 1; return { ok: true }; } });
    assert.equal(replay.replayed, true);
    assert.equal(replay.value.version, 9);
    assert.equal(calls, 1);
});
