// test/docx.test.mjs — lib/docx.js 纯函数单测 + novel_import 的 .docx 通路（假 fs 驱动真工具）。
// ZIP 夹具在内存里按规格拼（STORED/DEFLATE 各一），不携带二进制样本文件。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unzipEntry, docxToMarkdown, documentXmlToMarkdown } from '../lib/docx.js';
import { splitIntoChapters, isChapterHeading } from '../lib/import.js';
import { buildZip } from './helpers/zip.mjs';

const docxXml = (paras) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}</w:body></w:document>`;
const p = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

test('docx: STORED 包——标题样式 → md 章标题，正文进 splitIntoChapters', () => {
    const xml = docxXml(
        p('第一章 风起', 'Heading1') + p('山雨欲来，主角推门而出。') + p('第二章 云涌', 'Heading2') + p('敌至，拔刀。'),
    );
    const zip = buildZip([{ name: 'word/document.xml', data: Buffer.from(xml) }]);
    const md = docxToMarkdown(zip);
    assert.match(md, /^# 第一章 风起$/m);
    const chapters = splitIntoChapters(md);
    assert.equal(chapters.length, 2);
    assert.equal(chapters[0].title, '风起');
    assert.match(chapters[1].content, /敌至/);
});

test('docx: DEFLATE 包——inflate 通路解出同样内容', () => {
    const xml = docxXml(p('第三章 夜袭', 'Heading1') + p('火起。'));
    const zip = buildZip([{ name: 'word/document.xml', data: Buffer.from(xml), deflate: true }]);
    assert.match(docxToMarkdown(zip), /^# 第三章 夜袭$/m);
});

test('docx: 无标题样式——「第N章」正文规则仍能切分（中文数字多位）', () => {
    const xml = docxXml(p('第十一章 归乡', '') + p('正文甲。') + p('第十二章 离乡', '') + p('正文乙。'));
    const zip = buildZip([{ name: 'word/document.xml', data: Buffer.from(xml) }]);
    const chapters = splitIntoChapters(docxToMarkdown(zip));
    assert.equal(chapters.length, 2, '第十一/十二章 必须都认出来（中文数字多位）');
    assert.equal(chapters[0].title, '归乡');
});

test('docx: 实体/tab/br——&amp; 还原、制表与软换行保留', () => {
    const xml = docxXml('<w:p><w:r><w:t>A&amp;B</w:t><w:tab/><w:t>C&#x4E2D;</w:t></w:r></w:p>');
    const zip = buildZip([{ name: 'word/document.xml', data: Buffer.from(xml) }]);
    assert.equal(docxToMarkdown(zip).trim(), 'A&B\tC中');
});

test('docx: 没有 word/document.xml（.doc/改后缀）→ 明确报错，不静默空正文', () => {
    const zip = buildZip([{ name: 'word/other.xml', data: Buffer.from('<x/>') }]);
    assert.throws(() => docxToMarkdown(zip), /word\/document\.xml/);
});

test('docx: 截断/非 ZIP → 明确报错', () => {
    assert.throws(() => docxToMarkdown(Buffer.from('PK not really a zip at all........')), /中央目录/);
    const zip = buildZip([{ name: 'word/document.xml', data: Buffer.from(docxXml(p('x'))) }]);
    assert.throws(() => docxToMarkdown(zip.subarray(0, zip.length - 10)), /截断|中央目录|越界|损坏/);
});

test('docx: unzipEntry 找不到条目返回 null；documentXmlToMarkdown 空 body 返回空串', () => {
    const zip = buildZip([{ name: 'a.txt', data: Buffer.from('hi') }]);
    assert.equal(unzipEntry(zip, 'word/document.xml'), null);
    assert.equal(documentXmlToMarkdown('<?xml version="1.0"?><w:document xmlns:w="x"><w:body></w:body></w:document>'), '');
});

test('docx: isChapterHeading 兼容 md 前缀（docx 抽出的 # 标题不被切分器漏判）', () => {
    assert.equal(isChapterHeading('# 第1章 起点'), true);
});
