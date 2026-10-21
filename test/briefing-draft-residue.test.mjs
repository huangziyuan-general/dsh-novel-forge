// test/briefing-draft-residue.test.mjs — 书根 .draft-* 残留告警。
//
// 实证：模型爱先用宿主 write 在书根写 `.draft-ch1.md`，写完再「搬」进
// novel_write_chapter——那一步绕过了门禁、版本记录与账本联动，搬完还常常不删
// （新书《大梁第一讼师》的 .draft-ch1.md 至今还在书根）。
//
// 这条告警的定位是**行为纠正**（别再往书根写），不是让模型去删文件——
// 它手上没有删除工具，让它删只会制造它做不到的动作。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildBriefing } from '../lib/briefing.js';

const CONFIG = { contextBudgetChars: 6000, minChapterChars: 2000, maxChapterChars: 4000 };

/** 内存 io（与 clone 测试同款最小接口子集）。 */
function memIo(files) {
    return {
        async readJson(p) { const t = files.get(p); return t === undefined ? null : JSON.parse(t); },
        async readText(p) { return files.get(p) ?? null; },
        async writeText(p, text) { files.set(p, text); return { version: 1 }; },
        async writeJson(p, v) { files.set(p, JSON.stringify(v, null, 2) + '\n'); return { version: 1 }; },
        async listNames(p) { return [...files.keys()].filter((k) => k.startsWith(`${p}/`)).map((k) => k.slice(p.length + 1)); },
        async appendLine(p, line) { files.set(p, (files.get(p) ?? '') + line + '\n'); },
    };
}

function baseFiles(overrides = []) {
    const files = new Map();
    files.set('书/novel.json', JSON.stringify({
        title: '书', genre: '古言', logline: '一句话',
        chapters: {}, cast: [], proposals: [], sessions: ['sess-1'],
    }, null, 2));
    files.set('书/大纲/细纲/第1章.md', '## 本章必写场景\n- 场景甲\n\n## 本章禁止偏离项\n- 不写乙');
    for (const [k, v] of overrides) files.set(k, v);
    return files;
}

const NOVEL = { title: '书', chapters: {}, cast: [], logline: '一句话' };

test('★ 书根有 .draft 残留 → 简报警告，且措辞指向行为（别再往书根写）', async () => {
    const files = baseFiles([['书/.draft-ch1.md', '草稿正文']]);
    const r = await buildBriefing({
        config: CONFIG, io: memIo(files), book: '书', novel: NOVEL, n: 1, audience: 'session',
    });
    const warn = (r.warnings ?? []).find((w) => w.includes('草稿残留'));
    assert.ok(warn, `必须报草稿残留，实得：${JSON.stringify(r.warnings)}`);
    assert.ok(warn.includes('novel_write_chapter'), '必须指回正确落盘通道，光说「有残留」模型不知道该怎么办');
    assert.ok(warn.includes('宿主 write'), '必须点名错误动作（宿主 write），否则模型不会改习惯');
});

test('书根干净 → 不报（不制造噪音）', async () => {
    const files = baseFiles();
    const r = await buildBriefing({
        config: CONFIG, io: memIo(files), book: '书', novel: NOVEL, n: 1, audience: 'session',
    });
    assert.equal((r.warnings ?? []).filter((w) => w.includes('草稿残留')).length, 0, '干净的书根不许报警');
});

test('只认书根的 .draft 前缀：正文/细纲里的同名文件不算残留', async () => {
    const files = baseFiles([
        ['书/正文/.draft-tmp.md', '正文目录里的临时文件（不该被当成书根残留）'],
    ]);
    const r = await buildBriefing({
        config: CONFIG, io: memIo(files), book: '书', novel: NOVEL, n: 1, audience: 'session',
    });
    assert.equal((r.warnings ?? []).filter((w) => w.includes('草稿残留')).length, 0,
        '扫描范围是书根一层，子目录里的文件不该误报');
});

test('io 没有 listNames（老 io 实现）时不崩、不误报', async () => {
    const io = memIo(baseFiles([['书/.draft-ch1.md', '草稿']]));
    delete io.listNames; // 模拟接口缺失
    const r = await buildBriefing({ config: CONFIG, io, book: '书', novel: NOVEL, n: 1, audience: 'session' });
    assert.ok(r, 'listNames 缺失只影响这条旁证，绝不能拖垮整份简报');
    assert.equal((r.warnings ?? []).filter((w) => w.includes('草稿残留')).length, 0);
});

test('目录列举抛错（权限/沙箱）时不崩', async () => {
    const io = memIo(baseFiles());
    io.listNames = async () => { throw new Error('readdir EACCES'); };
    const r = await buildBriefing({ config: CONFIG, io, book: '书', novel: NOVEL, n: 1, audience: 'session' });
    assert.ok(r, '列举失败一律当没有，旁证缺失不阻断简报');
});

test('★ listNames 存在但同步抛（非 async 实现）时不崩', async () => {
    // 这是旧写法 `?.(book).catch(...)` 唯一真正漏掉的形态：`.catch` 只能兜 async reject，
    // listNames 若**同步 throw**，异常在 `.catch` 挂上之前就冒出来了。try/catch 两种都收。
    const io = memIo(baseFiles());
    io.listNames = () => { throw new Error('sync boom'); };
    const r = await buildBriefing({ config: CONFIG, io, book: '书', novel: NOVEL, n: 1, audience: 'session' });
    assert.ok(r, '同步抛同样只影响这条旁证，不许拖垮简报');
    assert.equal((r.warnings ?? []).filter((w) => w.includes('草稿残留')).length, 0);
});
