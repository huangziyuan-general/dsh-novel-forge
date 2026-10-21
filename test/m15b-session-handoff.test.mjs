// test/m15b-session-handoff.test.mjs
// M15 回归钉（服务端半）：详情响应必须同时给 **id（novel.json 内部 id）** 与
// **bookId（目录名）**，并带上服务端算好的字数口径视图 charView。
//
// 真机实证（某连载本）：「创建新会话并交接」拿 detail.id 当 book 传 → locateBook 与
// 认领双双失效（新会话建好了、claimed:false、面板 0 本书）。
// 客户端那半的行为（真发出去的 body.book 是目录名、书作用域请求统一带 session）
// 在 test/client.test.mjs 里**驱动真控制器**验证——不放这里：读源码字符串的断言
// 守不住真 bug（AGENTS.md「客户端行为测试要真跑」那条，本项目付过三次学费）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../lib/server-routes/projects.js';

const detail = async (session, novelJson) => {
    let got = null;
    const api = {
        trusted: () => true,
        fail: (res, status, code, message) => { got = { status, code, message }; },
        writeJson: (res, status, payload) => { got = { status, payload }; },
        parseQuery: (u) => new URLSearchParams(String(u).split('?')[1] ?? ''),
        safeDecode: (s) => decodeURIComponent(s),
        validBookId: () => true,
        store: {
            pathsFor: () => ({ batchCheckpoint: 'x/batch-checkpoint.json' }),
            // 判定链用真实现（口径派生只有一份实现，测试不抄第二份）
            ...await import('../lib/store.js'),
        },
        config: { minChapterChars: 2000, maxChapterChars: 4000 },
        locateBook: async (bookId, opts = {}) => ({
            root: '/ws',
            session: opts.session,
            fsio: { readText: async () => '', readJson: async () => null },
            text: JSON.stringify(novelJson),
        }),
    };
    const handled = await handle(
        { method: 'GET', url: '/projects/某书' + (session ? '?session=' + session : ''), headers: {} },
        {}, ['projects', '某书'], api,
    );
    assert.equal(handled, true, '详情路由必须被处理');
    return { value: got.payload.value, api };
};

test('★ 详情响应同时带内部 id 与目录名 bookId（交接/认领靠后者）', async () => {
    const { value } = await detail('session-abc', { id: 'nb_internal', title: '某书' });
    assert.equal(value.id, 'nb_internal', 'id 保持 novel.json 内部 id（旧契约不动）');
    assert.equal(value.bookId, '某书', 'bookId 必须是目录名—— locateBook/requireBook/认领认的都是它');
    assert.equal(value.title, '某书');
});

test('★ 详情带服务端算好的字数口径视图：未设任何档位＝插件默认，且原样透传自定义区间', async () => {
    const plain = (await detail('s', { id: 'nb_1', title: '某书' })).value;
    assert.equal(plain.charView.charMin, 2000, '未设平台未自定义 → 回落插件配置');
    assert.equal(plain.charView.charMax, 4000);
    assert.equal(plain.charView.charSource, 'config', '出处要如实标出来（面板按它渲染文案）');
    assert.equal('charLimits' in plain.charView, false, '没有自定义时不带该键（不送 null）');

    const custom = (await detail('s', { id: 'nb_1', title: '某书', platform: 'fanqie', charLimits: { min: 2500, max: 3500 } })).value;
    assert.deepEqual(custom.charView, { charLimits: '2500-3500', charMin: 2500, charMax: 3500, charSource: 'custom' },
        '★ 自定义区间优先于平台口径——面板只显示这一个数，不自己重算优先级');
});
