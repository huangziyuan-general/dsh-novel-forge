import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    relationPair, relationTimeline, latestRelationRows, relationsAt,
    relationTimelineOf, applyRelationUpdates, detectStaleRelations,
} from '../lib/relations.js';
import {
    diagnoseArcStall, applyArcUpdates, arcsAt, arcLastMove, ARC_STALL_CHAPTERS,
} from '../lib/arcs.js';
import { validateReviewQuotes, MIN_QUOTE_CHARS } from '../lib/polish.js';
import { fullscanThreads } from '../lib/continuity.js';

const now = '2026-11-01T00:00:00Z';

// ── relations ──────────────────────────────────────────────────────────────
test('relationPair: symmetric', () => {
    assert.deepEqual(relationPair('A', 'B'), relationPair('B', 'A'));
    assert.equal(relationPair('A', 'B').a, 'A');
    assert.equal(relationPair('A', 'B').b, 'B');
    assert.throws(() => relationPair('', 'B'));
    assert.throws(() => relationPair('A', 'A'));
});

test('applyRelationUpdates: same-chapter conflict', () => {
    const r1 = applyRelationUpdates([], [{ a: 'A', b: 'B', relation: '关系', value: '盟友' }], { chapter: 10, now }).relations;
    const r2 = applyRelationUpdates(r1, [{ a: 'A', b: 'B', relation: '关系', value: '仇敌' }], { chapter: 10, now });
    assert.equal(r2.conflicts.length, 1);
    assert.equal(r2.added.length, 0);
    // cross-chapter OK
    const r3 = applyRelationUpdates(r1, [{ a: 'A', b: 'B', relation: '关系', value: '仇敌' }], { chapter: 45, now });
    assert.equal(r3.added.length, 1);
});

test('applyRelationUpdates: same-chapter same-value idempotent skip', () => {
    const r1 = applyRelationUpdates([], [{ a: 'A', b: 'B', relation: '关系', value: '盟友' }], { chapter: 10, now }).relations;
    // same chapter + same value → skip (no new row)
    const r2 = applyRelationUpdates(r1, [{ a: 'A', b: 'B', relation: '关系', value: '盟友' }], { chapter: 10, now });
    assert.equal(r2.added.length, 0);
    assert.equal(r2.relations.length, 1);
    // cross-chapter same value → new row (a valid state-confirmation event)
    const r3 = applyRelationUpdates(r1, [{ a: 'A', b: 'B', relation: '关系', value: '盟友' }], { chapter: 12, now });
    assert.equal(r3.added.length, 1);
    assert.equal(r3.relations.length, 2);
});

test('relationsAt: point-in-time', () => {
    let rels = applyRelationUpdates([], [{ a: 'A', b: 'B', relation: '立场', value: '盟友' }], { chapter: 10, now }).relations;
    rels = applyRelationUpdates(rels, [{ a: 'A', b: 'B', relation: '立场', value: '仇敌' }], { chapter: 45, now }).relations;
    assert.equal(relationsAt(rels, 44, {})[0].value, '盟友');
    assert.equal(relationsAt(rels, 45, {})[0].value, '仇敌');
    assert.equal(relationsAt(rels, 44, {})[0].chapter, 10);
});

test('relationTimelineOf: single-dimension evolution', () => {
    let rels = applyRelationUpdates([], [{ a: 'A', b: 'B', relation: '立场', value: '盟友' }], { chapter: 5, now }).relations;
    rels = applyRelationUpdates(rels, [{ a: 'A', b: 'B', relation: '立场', value: '仇敌' }], { chapter: 20, now }).relations;
    const line = relationTimelineOf('B', 'A', '立场', rels);
    assert.deepEqual(line, [
        { chapter: 5, value: '盟友', note: '' },
        { chapter: 20, value: '仇敌', note: '' },
    ]);
});

test('detectStaleRelations: warns when body uses old value', () => {
    let rels = applyRelationUpdates([], [{ a: 'A', b: 'B', relation: '立场', value: '盟友' }], { chapter: 5, now }).relations;
    rels = applyRelationUpdates(rels, [{ a: 'A', b: 'B', relation: '立场', value: '仇敌' }], { chapter: 45, now }).relations;
    const hits = detectStaleRelations({ content: 'A 与 B 仍是盟友', relations: rels, chapter: 46 });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].now, '仇敌');
    assert.equal(hits[0].old, '盟友');
    // no hit when body uses current value
    const ok = detectStaleRelations({ content: 'A 与 B 已是仇敌', relations: rels, chapter: 46 });
    assert.equal(ok.length, 0);
});

// ── arcs ────────────────────────────────────────────────────────────────────
test('arcLastMove: last chapter for (char,dim)', () => {
    const arcs = [
        { character: 'X', dimension: 'd', value: 'v1', chapter: 5 },
        { character: 'X', dimension: 'd', value: 'v2', chapter: 12 },
        { character: 'X', dimension: 'e', value: 'v3', chapter: 9 },
    ];
    assert.equal(arcLastMove(arcs, 'X', 'd'), 12);
    assert.equal(arcLastMove(arcs, 'X', 'e'), 9);
    assert.equal(arcLastMove(arcs, 'Y', 'd'), null);
});

test('diagnoseArcStall: stalled vs no-move vs clean', () => {
    const arcs = [
        // stalled: TWO entries, last at ch 10, now 50 → gap 40 ≥ 15, count=2
        { character: 'A', dimension: 'growth', value: 'v1', chapter: 5 },
        { character: 'A', dimension: 'growth', value: 'v2', chapter: 10 },
        // no-move: single entry at ch 5, now 50 → gap 45 ≥ 20, count=1
        { character: 'B', dimension: 'trust', value: 'v', chapter: 5 },
        // clean: single entry at ch 45, now 50 → gap 5 < 20
        { character: 'C', dimension: 'growth', value: 'v', chapter: 45 },
    ];
    const out = diagnoseArcStall(arcs, 50);
    // A: 2 entries (count=2), lastMove=10, gap=40 >= 15 → stalled
    // B: 1 entry,  lastMove=5,  gap=45 >= 20 → no-move (count===1 branch checked first)
    // C: 1 entry,  lastMove=45, gap=5  <  20 → clean
    const kinds = out.map((o) => `${o.character}:${o.kind}`).sort();
    assert.deepEqual(kinds, ['A:stalled', 'B:no-move']);
    // short book: no stalls reported
    assert.deepEqual(diagnoseArcStall(arcs, 15), []);
});

test('applyArcUpdates: idempotent same-chapter same-value skip', () => {
    let arcs = applyArcUpdates([], [{ character: 'X', dimension: 'd', value: 'v1' }], { chapter: 5, now }).arcs;
    const r2 = applyArcUpdates(arcs, [{ character: 'X', dimension: 'd', value: 'v1' }], { chapter: 5, now });
    assert.equal(r2.added.length, 0);
    assert.deepEqual(r2.skipped, [{ character: 'X', dimension: 'd' }]);
    assert.equal(r2.arcs.length, 1);
});

test('arcsAt: point-in-time snapshot', () => {
    let arcs = applyArcUpdates([], [{ character: 'X', dimension: 'd', value: 'low' }], { chapter: 5, now }).arcs;
    arcs = applyArcUpdates(arcs, [{ character: 'X', dimension: 'd', value: 'high' }], { chapter: 20, now }).arcs;
    assert.equal(arcsAt(arcs, 10, { character: 'X' })[0].value, 'low');
    assert.equal(arcsAt(arcs, 20, { character: 'X' })[0].value, 'high');
});

// ── review quotes grounding ─────────────────────────────────────────────────
test('validateReviewQuotes: verbatim substring', () => {
    const text = '他把刀递出去，手在抖。对面的门没有开。';
    // passes
    assert.deepEqual(validateReviewQuotes([{ label: '段1', quote: '他把刀递出去，手在抖' }], text), []);
    // fails: not in text
    const bad = validateReviewQuotes([{ label: '段1', quote: '他把手递出去' }], text);
    assert.equal(bad.length, 1);
    assert.match(bad[0].reason, /逐字找不到/);
});

test('validateReviewQuotes: too short', () => {
    const text = '他把刀递出去，手在抖。';
    const bad = validateReviewQuotes([{ label: '段1', quote: '刀' }], text);
    assert.equal(bad.length, 1);
    assert.match(bad[0].reason, /太短/);
});

test('validateReviewQuotes: no quotes = no violations', () => {
    assert.deepEqual(validateReviewQuotes([], 'any'), []);
    assert.deepEqual(validateReviewQuotes(undefined, 'any'), []);
});

// ── fullscanThreads ─────────────────────────────────────────────────────────
test('fullscanThreads: all four detectors', () => {
    const relations = [
        // stalled: last move ch 5, now 60 → gap 55 ≥ 20
        { a: 'A', b: 'B', relation: '立场', value: '盟友', chapter: 5 },
    ];
    const arcs = [
        // stalled: moved at ch 10, now 60 → gap 50 ≥ 15
        { character: 'C', dimension: 'growth', value: 'v', chapter: 10 },
    ];
    const foreshadows = [{ id: 'F1', setup: 'x', chapter: 3, plan: null, payoffChapter: null }];
    const debts = {
        12: [{ code: 'content-gate-forced', level: 'hard', message: 'force', chapter: 12, ts: '' }],
    };
    const issues = fullscanThreads({ relations, arcs, foreshadows, debts, maxWritten: 60 });
    const codes = issues.map((i) => i.code).sort();
    assert.ok(codes.includes('relation-stalled'));
    assert.ok(codes.includes('arc-no-move')); // single-entry arc at ch 10, now 60 → no-move
    assert.ok(codes.includes('hard-debt-uncleared'));
    assert.ok(codes.includes('foreshadow-no-plan'));
    // clean case
    const clean = fullscanThreads({ relations: [], arcs: [], foreshadows: [], debts: {}, maxWritten: 5 });
    assert.equal(clean.length, 0);
});
