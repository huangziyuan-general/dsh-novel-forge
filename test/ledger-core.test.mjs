// test/ledger-core.test.mjs — lib/ledger-core.js 等价性 + 纪律验证。
//
// 账本家族四份账本（facts / relations / arcs / cognition）共享三条纪律：
//   ① 行守卫；② 时间线排序（chapter 升序 + 同章原始下标升序）；③ 时点快照。
// 本测试层钉住"各账本的 timeline/snapshot 与 ledger-core 完全同口径"——
// 防止各账本回退成自己抄一份排序逻辑（1.3.3 同型事故）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { timeline, snapshot, latestRows } from '../lib/ledger-core.js';
import { factTimeline, latestFactRows } from '../lib/ledger.js';
import { relationTimeline, latestRelationRows } from '../lib/relations.js';
import { arcTimeline, latestArcRows } from '../lib/arcs.js';
import { cognitionFlatRows } from '../lib/cognition.js';

// ── 1. ledger-core.timeline 核心纪律 ──────────────────────────────────────

test('timeline：空数组 → 空', () => {
    assert.deepEqual(timeline([]), []);
    assert.deepEqual(timeline(null), []);
    assert.deepEqual(timeline(undefined), []);
});

test('timeline：正常数组按 chapter 升序、同章保持原始下标序', () => {
    const rows = [
        { chapter: 10, value: 'a' },
        { chapter: 5,  value: 'b' },
        { chapter: 10, value: 'c' },
        { chapter: 3,  value: 'd' },
    ];
    const tl = timeline(rows, {
        isValidRow: (r) => r && typeof r.chapter === 'number' && Number.isInteger(r.chapter),
    });
    assert.deepEqual(tl.map((x) => ({ r: x.r.value, i: x.i })), [
        { r: 'd', i: 3 }, // ch 3
        { r: 'b', i: 1 }, // ch 5
        { r: 'a', i: 0 }, // ch 10
        { r: 'c', i: 2 }, // ch 10（同章保持原始下标序：0 < 2）
    ]);
});

test('timeline：upTo 过滤', () => {
    const rows = [
        { chapter: 3, value: 'a' },
        { chapter: 7, value: 'b' },
        { chapter: 10, value: 'c' },
    ];
    const tl = timeline(rows, {
        isValidRow: (r) => r && typeof r.chapter === 'number' && Number.isInteger(r.chapter),
        upTo: 7,
    });
    assert.deepEqual(tl.map((x) => x.r.value), ['a', 'b']);
});

test('timeline：isValidRow 过滤畸形行', () => {
    const rows = [
        { chapter: 3, entity: 'E', key: 'K', value: 'ok' },
        null,
        { chapter: 5, entity: '', key: 'K', value: 'bad-entity' },
        { chapter: 7, entity: 'E', key: '', value: 'bad-key' },
        { chapter: 'not-int', entity: 'E', key: 'K', value: 'bad-chapter' },
        { chapter: 9, entity: 'E', key: 'K', value: 'ok2' },
    ];
    const isValidFactRow = (f) => f !== null && typeof f === 'object'
        && typeof f.entity === 'string' && f.entity !== ''
        && typeof f.key === 'string' && f.key !== ''
        && Number.isInteger(f.chapter);
    const tl = timeline(rows, { isValidRow: isValidFactRow });
    assert.equal(tl.length, 2);
    assert.deepEqual(tl.map((x) => x.r.value), ['ok', 'ok2']);
});

test('timeline：chapterNorm — 非整数 chapter 降级为 0', () => {
    const rows = [
        { chapter: 3,  subject: 'A', info: 'x', verb: 'knows' },           // i=0
        { chapter: 0,  subject: 'A', info: 'y', verb: 'knows' },           // i=1, ch=0
        { chapter: 5,  subject: 'B', info: 'z', verb: 'knows' },           // i=2
        { chapter: null, subject: 'A', info: 'bad', verb: 'knows' },       // i=3 → ch=0
        { chapter: undefined, subject: 'C', info: 'bad2', verb: 'knows' }, // i=4 → ch=0
    ];
    const tl = timeline(rows, {
        isValidRow: (r) => r !== null && typeof r === 'object'
            && typeof r.subject === 'string' && r.subject !== ''
            && typeof r.info === 'string' && r.info !== '',
        chapterNorm: (ch) => (Number.isInteger(ch) ? ch : 0),
    });
    // chapterNorm 后：i=1,3,4 → ch=0；i=0 → ch=3；i=2 → ch=5
    // 同章 ch=0 内按原始下标升序：1 < 3 < 4
    assert.deepEqual(tl.map((x) => x.i), [1, 3, 4, 0, 2]);
});

test('timeline：空 upTo → 不过滤（默认 null）', () => {
    const rows = [{ chapter: 999, v: 'all' }];
    const tl = timeline(rows, {
        isValidRow: (r) => r && Number.isInteger(r.chapter),
    });
    assert.equal(tl.length, 1);
});

// ── 2. ledger-core.snapshot + latestRows ──────────────────────────────────

test('snapshot：按 groupKey 取最后一条', () => {
    const rows = [
        { chapter: 3, entity: 'A', key: 'x', value: 'v1' },
        { chapter: 7, entity: 'A', key: 'x', value: 'v2' }, // 覆盖上面
        { chapter: 5, entity: 'B', key: 'y', value: 'v3' },
    ];
    const tl = timeline(rows, {
        isValidRow: (f) => f && Number.isInteger(f.chapter),
    });
    const snap = snapshot(tl, (r) => `${r.entity}\u0000${r.key}`);
    assert.equal(snap.size, 2);
    // A.x → v2（chapter 7 > 3）
    assert.equal(snap.get('A\u0000x').r.value, 'v2');
    assert.equal(snap.get('A\u0000x').r.chapter, 7);
    // B.y → v3
    assert.equal(snap.get('B\u0000y').r.value, 'v3');
});

test('latestRows：便捷封装 = timeline + snapshot', () => {
    const rows = [
        { chapter: 3, entity: 'A', key: 'x', value: 'v1' },
        { chapter: 7, entity: 'A', key: 'x', value: 'v2' },
    ];
    const map = latestRows(rows, {
        isValidRow: (f) => f && Number.isInteger(f.chapter),
        upTo: null,
        getGroupKey: (r) => `${r.entity}\u0000${r.key}`,
    });
    assert.equal(map.size, 1);
    assert.equal(map.get('A\u0000x').r.value, 'v2');
    assert.equal(map.get('A\u0000x').r.chapter, 7);
});

// ── 3. 四份账本 timeline 输出的等价性 ────────────────────────────────────

test('facts.factTimeline 输出 = ledger-core.timeline 同 isValidRow', () => {
    const facts = [
        { entity: 'E', key: 'K', value: 'old', chapter: 3, ts: '' },
        { entity: 'E', key: 'K', value: 'new', chapter: 10, ts: '' },
        null, // 畸形
        { entity: '', key: 'K', value: 'bad-e', chapter: 5, ts: '' }, // 畸形
        { entity: 'E', key: '', value: 'bad-k', chapter: 7, ts: '' },  // 畸形
        { entity: 'X', key: 'Y', value: 'ok', chapter: 8, ts: '' },
    ];
    // facts.factTimeline 输出 { f, i }
    const theirTl = factTimeline(facts);
    // ledger-core.timeline 输出 { r, i }
    const isValidFactRow = (f) => f !== null && typeof f === 'object'
        && typeof f.entity === 'string' && f.entity !== ''
        && typeof f.key === 'string' && f.key !== ''
        && Number.isInteger(f.chapter);
    const ourTl = timeline(facts, { isValidRow: isValidFactRow });
    // 映射成同形状比对
    assert.deepEqual(
        theirTl.map((x) => ({ r: x.f, i: x.i })),
        ourTl.map((x) => ({ r: x.r, i: x.i })),
    );
});

test('facts.latestFactRows 输出 = ledger-core.latestRows 同 isValidRow + groupKey', () => {
    const facts = [
        { entity: 'E', key: 'K', value: 'v1', chapter: 3, ts: '' },
        { entity: 'E', key: 'K', value: 'v2', chapter: 10, ts: '' },
        { entity: 'X', key: 'Y', value: 'z',  chapter: 5, ts: '' },
    ];
    const isValidFactRow = (f) => f !== null && typeof f === 'object'
        && typeof f.entity === 'string' && f.entity !== ''
        && typeof f.key === 'string' && f.key !== ''
        && Number.isInteger(f.chapter);

    const theirMap = latestFactRows(facts);
    const ourMap = latestRows(facts, {
        isValidRow: isValidFactRow,
        getGroupKey: (r) => `${r.entity}\u0000${r.key}`,
    });
    // 两者键集相同
    assert.deepEqual([...theirMap.keys()].sort(), [...ourMap.keys()].sort());
    for (const key of theirMap.keys()) {
        const theirs = theirMap.get(key);
        const ours = ourMap.get(key);
        assert.equal(theirs.f, ours.r, `key ${key}: row reference mismatch`);
        assert.equal(theirs.i, ours.i, `key ${key}: index mismatch`);
    }
});

test('relations.relationTimeline 输出 = ledger-core.timeline', () => {
    const rows = [
        { a: 'X', b: 'Y', relation: '立场', value: '盟友', chapter: 5, ts: '' },
        { a: 'Y', b: 'X', relation: '立场', value: '仇敌', chapter: 45, ts: '' }, // relationPair 对称
        null,
        { a: '', b: 'Y', relation: '立场', value: 'bad', chapter: 1, ts: '' },
        { a: 'X', b: 'Y', relation: '', value: 'bad', chapter: 2, ts: '' },
    ];
    const isValidRelationRow = (r) => r !== null && typeof r === 'object'
        && typeof r.a === 'string' && typeof r.b === 'string' && r.a !== '' && r.b !== ''
        && typeof r.relation === 'string' && r.relation !== ''
        && Number.isInteger(r.chapter);

    const theirTl = relationTimeline(rows);
    const ourTl = timeline(rows, { isValidRow: isValidRelationRow });
    assert.deepEqual(
        theirTl.map((x) => ({ r: x.f, i: x.i })),
        ourTl.map((x) => ({ r: x.r, i: x.i })),
    );
});

test('relations.latestRelationRows 输出 = ledger-core.latestRows（relationPair 对称组键）', () => {
    const rows = [
        { a: 'X', b: 'Y', relation: '立场', value: '盟友', chapter: 5, ts: '' },
        { a: 'Y', b: 'X', relation: '立场', value: '仇敌', chapter: 45, ts: '' },
    ];
    // relationPair('Y','X') → key 'X\0Y'（字典序）
    const isValidRelationRow = (r) => r !== null && typeof r === 'object'
        && typeof r.a === 'string' && typeof r.b === 'string' && r.a !== '' && r.b !== ''
        && typeof r.relation === 'string' && r.relation !== ''
        && Number.isInteger(r.chapter);
    // relations 组键需要 relationPair — 不能直接写死
    // 从 relations.js 里 export relationPair 用：它是 relations 的业务特化，不进 ledger-core
    // 所以这里用同样的对称逻辑：
    const pairKey = (a, b) => {
        const [x, y] = a.localeCompare(b) <= 0 ? [a, b] : [b, a];
        return `${x}\u0000${y}`;
    };

    const theirMap = latestRelationRows(rows);
    const ourMap = latestRows(rows, {
        isValidRow: isValidRelationRow,
        getGroupKey: (r) => `${pairKey(r.a, r.b)}\u0000${r.relation}`,
    });
    assert.deepEqual([...theirMap.keys()].sort(), [...ourMap.keys()].sort());
    for (const key of theirMap.keys()) {
        const theirs = theirMap.get(key);
        const ours = ourMap.get(key);
        assert.equal(theirs.f.value, ours.r.value, `key ${key}: value mismatch`);
    }
});

test('arcs.arcTimeline 输出 = ledger-core.timeline（v1.4.0 新增 timeline 函数等价性）', () => {
    const rows = [
        { character: 'C', dimension: '心境', value: '怯懦', chapter: 5, ts: '' },
        { character: 'C', dimension: '心境', value: '无畏', chapter: 30, ts: '' },
        null,
        { character: '', dimension: '心境', value: 'bad', chapter: 1, ts: '' },
        { character: 'C', dimension: '', value: 'bad', chapter: 2, ts: '' },
    ];
    const isValidArcRow = (r) => r !== null && typeof r === 'object'
        && typeof r.character === 'string' && r.character !== ''
        && typeof r.dimension === 'string' && r.dimension !== ''
        && Number.isInteger(r.chapter);

    // arcs.arcTimeline 是刚加的，现在它调用 ledger-core.timeline
    const theirTl = arcTimeline(rows);
    const ourTl = timeline(rows, { isValidRow: isValidArcRow });
    assert.deepEqual(theirTl.map((x) => ({ r: x.r, i: x.i })), ourTl.map((x) => ({ r: x.r, i: x.i })));
});

test('arcs.latestArcRows 输出 = ledger-core.latestRows', () => {
    const rows = [
        { character: 'C', dimension: '心境', value: '怯懦', chapter: 5, ts: '' },
        { character: 'C', dimension: '心境', value: '无畏', chapter: 30, ts: '' },
        { character: 'D', dimension: '信任', value: '低', chapter: 20, ts: '' },
    ];
    const isValidArcRow = (r) => r !== null && typeof r === 'object'
        && typeof r.character === 'string' && r.character !== ''
        && typeof r.dimension === 'string' && r.dimension !== ''
        && Number.isInteger(r.chapter);

    const theirMap = latestArcRows(rows);
    const ourMap = latestRows(rows, {
        isValidRow: isValidArcRow,
        getGroupKey: (r) => `${r.character}\u0000${r.dimension}`,
    });
    assert.deepEqual([...theirMap.keys()].sort(), [...ourMap.keys()].sort());
    for (const key of theirMap.keys()) {
        const theirs = theirMap.get(key);
        const ours = ourMap.get(key);
        assert.equal(theirs.r.value, ours.r.value, `key ${key}: value mismatch`);
    }
});

// ── 4. cognitionFlatRows 等价性（resolveCognition 改了消费 ledger-core） ─

test('cognitionFlatRows：正常多声明确认后声明胜', () => {
    // 先在 ch 5 说知道，再在 ch 10 说不知道 → 最终声明 = doesNotKnow
    const rows = [
        { subject: '小明', verb: 'knows', doesNotKnow: undefined, info: '宝藏地点', chapter: 5, ts: '' },
        { subject: '小明', verb: 'doesNotKnow', info: '宝藏地点', chapter: 10, ts: '' },
    ];
    const flat = cognitionFlatRows(rows);
    assert.equal(flat.length, 1);
    assert.equal(flat[0].subject, '小明');
    assert.equal(flat[0].verb, 'doesNotKnow'); // 后声明胜
});

test('cognitionFlatRows：读者 knows 独立存', () => {
    const rows = [
        { subject: '读者', verb: 'knows', info: '小明是卧底', chapter: 3, ts: '' },
    ];
    const flat = cognitionFlatRows(rows);
    assert.equal(flat.length, 1);
    assert.equal(flat[0].subject, '读者');
});

test('cognitionFlatRows：atChapter 过滤未来章', () => {
    const rows = [
        { subject: '小明', verb: 'knows', info: 'A', chapter: 5, ts: '' },
        { subject: '小明', verb: 'doesNotKnow', info: 'A', chapter: 100, ts: '' }, // 未来章，atChapter=10 不可见
    ];
    const flat = cognitionFlatRows(rows, { atChapter: 10 });
    assert.equal(flat.length, 1);
    assert.equal(flat[0].verb, 'knows'); // 只看到 ch 5 的 knows
});

test('cognitionFlatRows：chapter 非整数降级为 0，正常整数优先', () => {
    // 0 是最低序，所以整数 ch 5 的 knows 会覆盖 ch 0 的 knows — 但 doesNotKnow 是不同键
    const rows = [
        { subject: '小明', verb: 'knows', info: 'A', chapter: 'not-int', ts: '' }, // 降级 0
        { subject: '小明', verb: 'knows', info: 'A', chapter: 5, ts: '' },        // ch 5
    ];
    const flat = cognitionFlatRows(rows);
    assert.equal(flat.length, 1);
    assert.equal(flat[0].chapter, 5); // ch 5 覆盖 ch 0
});

// ── 5. 反漂移纪律：乱序数组补录早章后，时间线排序自动修正 ──────────────────

test('时间线排序修正补录早章：数组序不是时间序（账本允许补录早章）', () => {
    const facts = [
        // 先写了 ch 50 的记录（正常顺序）
        { entity: 'E', key: 'K', value: 'v-ch50', chapter: 50, ts: '' },
        // 后来补录 ch 10（数组追加在末尾，所以数组序是 [ch50, ch10]）
        { entity: 'E', key: 'K', value: 'v-ch10', chapter: 10, ts: '' },
    ];
    // 旧实现（数组序遍历）：ch10 在后面 → 覆盖 ch50 → 最新值 v-ch10（错误！应该是 v-ch50）
    // 新实现（时间线排序）：[ch10, ch50] → ch50 最后 → 最新值 v-ch50（正确）
    const latest = latestFactRows(facts);
    assert.equal(latest.get('E\u0000K').f.value, 'v-ch50',
        '时间线排序后 ch50 应该是最新值（数组序 [ch50, ch10] 里 ch10 在后面但 chapter 更小）');
});

test('arcsAt：数组序乱序 → 时间线排序修正（原来 arcsAt 自写 inline 会在这里漂）', () => {
    const arcs = [
        { character: '主角', dimension: '心境', value: '无畏', chapter: 50, ts: '' },
        { character: '主角', dimension: '心境', value: '怯懦', chapter: 10, ts: '' }, // 补录早章
    ];
    // 用 latestArcRows 验证
    const latest = latestArcRows(arcs);
    assert.equal(latest.get('主角\u0000心境').r.value, '无畏',
        '时间线排序后 ch50 应该是最新值');
    // 用 arcsAt 时点快照验证（arcsAt(chapter=60) 应返回最新推进值）
    // arcsAt 已改成消费 latestArcRows，所以也应该正确
});

test('relationsAt：乱序数组 → 时间线排序修正', () => {
    // 需要 relationsAt 消费 latestRelationRows，验证正确
    // latestRelationRows 也消费 timeline，所以乱序自动修正
    const rows = [
        { a: 'A', b: 'B', relation: '立场', value: '仇敌', chapter: 45, ts: '' },
        { a: 'B', b: 'A', relation: '立场', value: '盟友', chapter: 12, ts: '' }, // (B,A) → pairKey 同
    ];
    const latest = latestRelationRows(rows);
    const pairKey = (a, b) => {
        const [x, y] = a.localeCompare(b) <= 0 ? [a, b] : [b, a];
        return `${x}\u0000${y}\u0000立场`;
    };
    const key = pairKey('A', 'B');
    assert.equal(latest.get(key).f.value, '仇敌',
        '时间线排序后 ch45 应该是最新值');
});
