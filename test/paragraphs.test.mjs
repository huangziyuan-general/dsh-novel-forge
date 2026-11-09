// lib/paragraphs.js 的唯一口径：单换行/空行同权 + 剔标题行。
// 这条口径同时喂 noai structure、audit 段数门禁、content-gate 人称连续段等八处调用点，
// 任何一处回退到 split(/\n\s*\n/) 都会让 docx 导入稿（lib/docx.js 用 join('\n')）整章算 1 段。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { splitParagraphs, isHeadingLine } from '../lib/paragraphs.js';
import { scanAiFlavor } from '../lib/noai.js';
import { computeAudit, auditVerdict } from '../lib/audit.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/noai/${name}.txt`, import.meta.url), 'utf8');

test('splitParagraphs: 单换行与空行同权（docx 导入形态不再整章算 1 段）', () => {
    assert.deepEqual(splitParagraphs('第一段。\n第二段。\n第三段。'), ['第一段。', '第二段。', '第三段。']);
    assert.deepEqual(
        splitParagraphs('第一段。\n\n第二段。\n\n\n第三段。'),
        ['第一段。', '第二段。', '第三段。'],
        '空行/连续空行不产生空段',
    );
    assert.deepEqual(splitParagraphs('甲。\n   \n乙。'), ['甲。', '乙。'], '只含空白的行被滤掉');
    assert.deepEqual(splitParagraphs(''), []);
});

test('splitParagraphs: 标题行剔除——Markdown 标题与 30 字以内的「第N章」行', () => {
    assert.deepEqual(splitParagraphs('# 第7章 夜雨\n\n甲。\n乙。'), ['甲。', '乙。']);
    assert.equal(isHeadingLine('第7章 夜雨'), true);
    assert.equal(isHeadingLine('第十八章 夜里来的人'), true);
    assert.equal(isHeadingLine('## 卷一'), true);
    // 正文里以「第一章」起头的长段落不是标题（与 noai 旧口径一致：30 字以内才算）
    assert.equal(isHeadingLine('第一章的故事从他离家那一年讲起，那天下着很大的雨。'), true, '30 字以内仍按标题剔除');
    const longPara = '第一章的故事从他离家那一年讲起，那天下着很大的雨，村口的石桥被水漫过，一直漫到坡上。';
    assert.equal(isHeadingLine(longPara), false, '超过 30 字的正文段不是标题');
    assert.equal(splitParagraphs(longPara).length, 1);
});

test('splitParagraphs: 双换行正文（无标题行）与旧空行口径完全一致', () => {
    const text = '甲段第一句。甲段第二句。\n\n乙段。\n\n丙段第一句。丙段第二句。丙段第三句。';
    const old = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
    assert.deepEqual(splitParagraphs(text), old);
});

test('★ 单换行章节样本：段数正确、structure 维不被打满（回归守卫）', () => {
    const text = fixture('single-newline-chapter');
    const paras = splitParagraphs(text);
    assert.ok(paras.length >= 12, `单换行章节应切出多段，实际 ${paras.length}`);
    assert.ok(paras.every((p) => !p.includes('\n')), '一段内部不应残留换行');
    assert.equal(paras.some((p) => p.startsWith('第7章')), false, '章标题行必须剔除');

    const scan = scanAiFlavor(text);
    assert.equal(scan.categories.structure.paraCount, paras.length, 'structure 必须用同一份段落口径');
    assert.ok(scan.categories.structure.paraCv > 0, '多段文本的段落变异系数不应是 0（0 = 整章被当成一段）');
    assert.ok(scan.categories.structure.score < 40, `structure 不应被打满，实际 ${scan.categories.structure.score}`);
});

test('★ 单换行章节样本：机审段数不是 1，段数门禁不误拦', () => {
    const text = fixture('single-newline-chapter');
    const audit = computeAudit({ content: text });
    assert.ok(audit.paragraphCount >= 12, `机审段数应正确，实际 ${audit.paragraphCount}`);
    // 用较小的下限让图片章节（约 1400 字）进入段数门禁的判定区间
    const verdict = auditVerdict(audit, { minChapterChars: 1000, maxChapterChars: 5000 });
    assert.equal(
        verdict.problems.some((p) => p.includes('段落数')),
        false,
        `单换行正文不应被「段落数过少」驳回：${verdict.problems.join('；')}`,
    );
});
