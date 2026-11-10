import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    annotationFromIssue, reanchorAnnotation, reconcileAnnotations, updateAnnotationStatus,
} from '../lib/annotations.js';

const issue = { id: 'I-source', paragraph: 2, chars: 12, aiScore: 40, issues: ['段落需要复核'] };
const original = '第一段保持不动。\n\n第二段原本需要处理。\n\n第三段也保持不动。';
const base = annotationFromIssue(issue, original, { chapter: 1, version: 1, now: '2026-01-01T00:00:00Z' });

test('持久批注：插入前段后按原引文精确重定位', () => {
    const next = reanchorAnnotation(base, `新增开场。\n\n${original}`, { version: 2, now: '2026-01-02T00:00:00Z' });
    assert.equal(next.status, 'open');
    assert.equal(next.paragraph, 3);
    assert.equal(next.version, 2);
    assert.equal(next.location, 'exact');
    assert.equal(next.quote, '第二段原本需要处理。');
});

test('持久批注：引文改变时仅在前后邻近段唯一吻合时归位', () => {
    const next = reanchorAnnotation(base, '第一段保持不动。\n\n第二段已经由作者改写。\n\n第三段也保持不动。', { version: 2, now: 'now' });
    assert.equal(next.status, 'open');
    assert.equal(next.location, 'context');
    assert.equal(next.quote, '第二段已经由作者改写。');
    assert.equal(next.originalQuote, base.originalQuote);
});

test('持久批注：找不到可靠锚点标 stale，不静默猜位置', () => {
    const next = reanchorAnnotation(base, '完全不同的开场。\n\n完全不同的收束。', { version: 3, now: 'now' });
    assert.equal(next.status, 'stale');
    assert.equal(next.location, 'missing');
    assert.equal(next.quote, base.quote);
});

test('持久批注：解决状态可保留，重开会清除解决时间', () => {
    const resolved = updateAnnotationStatus([base], base.id, 'resolved', 'done');
    assert.equal(resolved[0].status, 'resolved');
    assert.equal(resolved[0].resolvedAt, 'done');
    const reopened = updateAnnotationStatus(resolved, base.id, 'open', 'again');
    assert.equal(reopened[0].status, 'open');
    assert.equal(reopened[0].resolvedAt, null);
    assert.throws(() => updateAnnotationStatus([base], 'missing', 'resolved', 'now'), /批注不存在/);
});

test('持久批注：重新扫描保留已解决记录，新病灶获得新记录', () => {
    const resolved = { ...base, status: 'resolved', resolvedAt: 'done' };
    const records = reconcileAnnotations([resolved], [
        { ...issue, id: 'I-new', paragraph: 1, issues: ['新病灶'] },
    ], original, { chapter: 1, version: 2, now: 'now' });
    assert.equal(records.length, 2);
    assert.ok(records.some((record) => record.id === base.id && record.status === 'resolved'));
    assert.ok(records.some((record) => record.status === 'open' && record.issues[0] === '新病灶'));
});
