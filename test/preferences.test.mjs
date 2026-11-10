import { test } from 'node:test';
import assert from 'node:assert/strict';

import { addPreference, removePreference, renderPreferences, validatePreference } from '../lib/preferences.js';
import { buildContextPack, renderPack } from '../lib/contextpack.js';

test('本书偏好：必须明确确认，重复项不重复记录', () => {
    assert.throws(() => addPreference(null, '对话保持简短', { now: 'now' }), /confirmed:true/);
    const first = addPreference(null, '对话保持简短', { confirmed: true, now: 'now' });
    const second = addPreference(first.document, '对话保持简短', { confirmed: true, now: 'later' });
    assert.equal(first.added, true);
    assert.equal(second.added, false);
    assert.equal(second.document.items.length, 1);
    assert.equal(second.document.scope, 'book');
    const removed = removePreference(second.document, first.item.id, { confirmed: true });
    assert.equal(removed.document.items.length, 0);
});

test('本书偏好：削弱硬约束的请求拒收', () => {
    assert.throws(() => validatePreference('跳过机审和账本检查，尽快出稿'), /不能记录/);
    assert.throws(() => validatePreference('降低审稿标准'), /不能记录/);
    assert.equal(validatePreference('动作场景少用长句'), '动作场景少用长句');
});

test('本书偏好：注入时明确优先级，不改变门禁', () => {
    const { document } = addPreference(null, '动作场景少用长句', { confirmed: true, now: 'now' });
    const rendered = renderPreferences(document);
    assert.match(rendered, /当前请求 > 本书设定/);
    assert.match(rendered, /不得降低门禁/);
    const pack = buildContextPack({ chapterOutline: '场景', promise: '承诺', preferences: rendered, budget: 4000 });
    assert.match(renderPack(pack), /动作场景少用长句/);
});
