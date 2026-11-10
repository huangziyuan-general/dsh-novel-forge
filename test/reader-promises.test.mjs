import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    genrePromiseTemplate, selectPromiseChapters, buildPromiseReviewPrompt, parsePromiseReview,
} from '../lib/reader-promises.js';
import { defineProjectTool } from '../lib/tools/project-tool.js';
import { createNodeFsBackend } from '../lib/mcp-standalone.js';

const chapters = [
    { n: 1, title: '第一章', content: '他翻开案卷，发现第一页缺了一角。' },
    { n: 2, title: '第二章', content: '墙灰下露出半枚旧印，他把印记抄进笔记。' },
    { n: 3, title: '第三章', content: '她按旧印找到库房，门锁却刚被人换过。' },
    { n: 4, title: '第四章', content: '证人改口之前，先把同一张车票推到了桌上。' },
];

test('读者承诺：按题材生成固定清单，不调用模型', () => {
    const general = genrePromiseTemplate('未分类');
    const suspense = genrePromiseTemplate('悬疑推理');
    assert.equal(general.genre, 'general');
    assert.equal(suspense.genre, 'suspense');
    assert.equal(suspense.items.length, 4);
    assert.match(suspense.markdown, /关键真相有前置线索/);
    assert.notEqual(suspense.items[0].id, general.items[0].id);
});

test('读者承诺：默认最近三章，缺章与超范围响亮拒绝', () => {
    assert.deepEqual(selectPromiseChapters(chapters).map((chapter) => chapter.n), [2, 3, 4]);
    assert.deepEqual(selectPromiseChapters(chapters, { from: 1, to: 2 }).map((chapter) => chapter.n), [1, 2]);
    assert.throws(() => selectPromiseChapters([chapters[0], chapters[2]], { from: 1, to: 3 }), /未保存章节/);
    assert.doesNotThrow(() => selectPromiseChapters(chapters, { from: 1, to: 4 }), '四章并未超过上限');
    assert.throws(() => selectPromiseChapters(chapters, { from: 1, to: 6 }), /未保存章节/);
});

test('读者承诺：逐项返回且非 uncertain 必须有原文证据', () => {
    const template = genrePromiseTemplate('悬疑');
    const selected = [chapters[0]];
    const raw = JSON.stringify({ items: template.items.map((item, index) => ({
        id: item.id, status: index === 0 ? 'fulfilled' : 'uncertain',
        chapter: index === 0 ? 1 : null, quote: index === 0 ? '发现第一页缺了一角' : '', advice: '继续核对线索',
    })) });
    const parsed = parsePromiseReview(raw, { template, chapters: selected });
    assert.equal(parsed[0].chapter, 1);
    assert.equal(parsed[1].chapter, null);
    const withMissingNullableFields = JSON.parse(raw);
    delete withMissingNullableFields.items[1].chapter;
    withMissingNullableFields.items[1].status = 'uncertain';
    assert.equal(parsePromiseReview(JSON.stringify(withMissingNullableFields), { template, chapters: selected })[1].chapter, null);
    assert.match(buildPromiseReviewPrompt({ template, chapters: selected }), /原文|正文/);
    assert.throws(() => parsePromiseReview(JSON.stringify({ items: [{ id: 'clues', status: 'fulfilled', chapter: 1, quote: '编造的证据' }] }), { template, chapters: selected }), /逐项返回/);
    const fake = JSON.parse(raw);
    fake.items[0].quote = '不存在的密室证词';
    assert.throws(() => parsePromiseReview(JSON.stringify(fake), { template, chapters: selected }), /原文核验/);
});

async function fixture(engine) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nf-reader-promises-'));
    const ctx = { fs: createNodeFsBackend(root), emit() {}, logger: { info() {} } };
    const exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: root, id: 'promise-test' } } } };
    const tool = defineProjectTool(ctx, {}, { engine });
    await tool.execute({ action: 'init', book: '承诺测试书', title: '承诺测试书', genre: '悬疑' }, exec);
    const metaPath = path.join(root, '承诺测试书', 'novel.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.chapters = {};
    for (const chapter of chapters.slice(0, 2)) {
        const rel = `承诺测试书/正文/第${chapter.n}章-${chapter.title}-v1.md`;
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), chapter.content);
        meta.chapters[String(chapter.n)] = {
            title: chapter.title, versions: [1], latest: 1, path: rel,
            files: [{ version: 1, file: rel }], chars: chapter.content.length, summary: '',
        };
    }
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    return { root, tool, exec };
}

test('读者承诺：模板落盘、覆盖需确认、annotate 复核只返回建议', async () => {
    const calls = [];
    const template = genrePromiseTemplate('悬疑');
    const engine = { run: async (channel, request) => {
        calls.push({ channel, request });
        return { ok: true, text: JSON.stringify({ items: template.items.map((item, index) => ({
            id: item.id, status: index === 0 ? 'partial' : 'uncertain', chapter: index === 0 ? 2 : null,
            quote: index === 0 ? '墙灰下露出半枚旧印' : '', advice: index === 0 ? '让线索影响下一步选择' : '暂不下结论',
        })) }) };
    } };
    const { root, tool, exec } = await fixture(engine);
    try {
        const created = await tool.execute({ action: 'promise_template', book: '承诺测试书' }, exec);
        assert.equal(created.promiseTemplate.genre, 'suspense');
        assert.equal(created.hasPromise, true);
        const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
        assert.deepEqual(validateJsonSchemaValue(tool.output.schema, created), []);
        await assert.rejects(() => tool.execute({ action: 'promise_template', book: '承诺测试书' }, exec), /force:true/);
        const reviewed = await tool.execute({ action: 'promise_review', book: '承诺测试书' }, exec);
        assert.equal(reviewed.advisory, true);
        assert.deepEqual(reviewed.reviewedChapters, [1, 2]);
        assert.equal(reviewed.promiseReview[0].status, 'partial');
        assert.equal(reviewed.promiseReview[0].chapter, 2);
        assert.equal('chapter' in reviewed.promiseReview[1], false);
        assert.equal(calls[0].channel, 'annotate');
        assert.match(calls[0].request.prompt, /墙灰下露出半枚旧印/);
        assert.deepEqual(validateJsonSchemaValue(tool.output.schema, reviewed), []);
        assert.match(tool.output.render({}, reviewed)[0].text, /不影响门禁/);
        const manual = await tool.execute({ action: 'promise', book: '承诺测试书', promise: '手工写下的故事承诺' }, exec);
        assert.equal(manual.hasPromise, true);
        assert.deepEqual(validateJsonSchemaValue(tool.output.schema, manual), []);
        const stored = JSON.parse(fs.readFileSync(path.join(root, '承诺测试书', '.novel', 'reader-promises.json'), 'utf8'));
        assert.deepEqual(stored.items, []);
        await assert.rejects(() => tool.execute({ action: 'promise_review', book: '承诺测试书' }, exec), /手工承诺书/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('读者承诺：模型伪造引文时整次复核拒绝', async () => {
    const template = genrePromiseTemplate('悬疑');
    const engine = { run: async () => ({ ok: true, text: JSON.stringify({ items: template.items.map((item) => ({
        id: item.id, status: 'fulfilled', chapter: 1, quote: '不存在的原文', advice: '',
    })) }) }) };
    const { root, tool, exec } = await fixture(engine);
    try {
        await tool.execute({ action: 'promise_template', book: '承诺测试书' }, exec);
        await assert.rejects(() => tool.execute({ action: 'promise_review', book: '承诺测试书' }, exec), /原文核验/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
