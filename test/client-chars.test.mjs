// test/client-chars.test.mjs — 详情卡「每章字数」的控制器行为锁（DH1）。
//
// 真机形态：书卡打开后输入框靠 defaultValue 显示盘上的「2500-3500」，而 state.charsValue
// 恒为 ''。用户什么都没改、直接点「保存」（或点完别的按钮绕回来再点），请求体就是
// chars:'' —— 服务端按「清除自定义」处理，删掉 novel.json.charLimits。没有报错、没有
// 提示，用户以为自己什么都没做，自定义区间却没了（静默破坏，比误报贵）。
//
// 这里直接跑 src 的控制器（不碰产物 lib/client.js：不变量 7），用打桩 fetch 看**实际
// 发出去的 body**，而不是看字符串里有没有某行代码。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createProjectsController } from '../src/client/controllers/projects.js';
import { initialState } from '../src/client/state.js';

/** 装一个控制器：state 用真实初值，跨域动作打桩，fetch 记录请求。 */
function boot(handler) {
    const state = initialState();
    const requests = [];
    globalThis.fetch = (url, init) => {
        requests.push({ url: String(url), init });
        return Promise.resolve({ json: () => Promise.resolve(handler(String(url), init)) });
    };
    const ctx = {
        state,
        notify() {},
        syncSession() {},
        withSession: (p) => p,
        seq: { open: 0, chapter: 0 },
        player: { stop() {} },
        loadProposals: async () => {},
        loadChapter: async () => {},
    };
    const ctrl = createProjectsController(ctx);
    return { state, requests, ctrl, ctx };
}

const ok = (value) => ({ ok: true, value });

test('DH1：打开书后字数输入框用服务端现值初始化（不再恒为空串）', async () => {
    const detail = { name: '甲书', charView: { charMin: 2500, charMax: 3500, charSource: 'custom', charLimits: '2500-3500' } };
    const { state, ctrl } = boot((url) => {
        if (url.includes('/chapters')) return ok([]);
        if (url.includes('/elements')) return ok({});
        return ok(detail);
    });
    state.sessionId = null;
    await ctrl.openProject('甲书');
    assert.equal(state.charsValue, '2500-3500',
        '★ 输入框初值必须是盘上的真值——空串会在用户点「保存」时把自定义区间清掉');
});

test('DH1：没编辑过就保存 = 原样保存，绝不退化成清除', async () => {
    const { state, requests, ctrl } = boot(() => ok({ charLimits: '2500-3500', charMin: 2500, charMax: 3500, charSource: 'custom' }));
    state.selected = '甲书';
    state.charsValue = undefined;                                   // 从未编辑
    state.detail = { charView: { charLimits: '2500-3500', charSource: 'custom' } };
    await ctrl.saveBookChars(undefined);
    const body = JSON.parse(requests.at(-1).init.body);
    assert.equal(body.chars, '2500-3500',
        '★ undefined（未编辑/详情没拿到）必须按服务端现值原样保存，不能发空串清除');
});

test('DH1：显式空串仍然是清除（清除按钮不能被兜底吃掉）', async () => {
    const { state, requests, ctrl } = boot(() => ok({ charLimits: '', charMin: 2000, charMax: 3000, charSource: 'platform' }));
    state.selected = '甲书';
    state.charsValue = '';
    state.detail = { charView: { charLimits: '2500-3500', charSource: 'custom' } };
    await ctrl.saveBookChars('');
    const body = JSON.parse(requests.at(-1).init.body);
    assert.equal(body.chars, '', '★ 显式空串＝清除自定义，兜底只兜 undefined');
});

test('DH1：详情没拿到 charView 时保存也不清除（undefined 兜底到空，但不假装用户点了清除）', async () => {
    const { state, requests, ctrl } = boot(() => ok({ charLimits: null, charMin: 2000, charMax: 3000, charSource: 'config' }));
    state.selected = '甲书';
    state.charsValue = undefined;
    state.detail = null;
    await ctrl.saveBookChars(undefined);
    const body = JSON.parse(requests.at(-1).init.body);
    assert.equal(body.chars, '', '详情缺失时按「无自定义」保存，与盘上现状一致');
});

test('DH1：保存成功后 state 同步为服务端真值（下次保存不会把旧值写回去）', async () => {
    const { state, ctrl } = boot(() => ok({ charLimits: '3000-4000', charMin: 3000, charMax: 4000, charSource: 'custom' }));
    state.selected = '甲书';
    state.charsValue = '2500-3500';
    state.detail = { charView: { charLimits: '2500-3500', charSource: 'custom' } };
    await ctrl.saveBookChars('3000-4000');
    assert.equal(state.charsValue, '3000-4000', '★ 回包真值必须写回 state，否则输入框与 state 会分家');
    assert.equal(state.detail.charView.charLimits, '3000-4000');
});
