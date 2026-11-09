import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SEMANTIC_LIMITS, parseSemanticDimensions, selectSemanticChapters, buildSemanticPrompt,
    parseSemanticResponse, renderSemanticReport, semanticReportPath,
} from '../lib/library-semantic.js';
import { bootPlugin } from './helpers/plugin.mjs';

const QUOTE = '雨沿着遮雨棚的破洞滴下来，他先把桌上的手稿挪进怀里，才去关门。';
const SOURCE = `第1章 雨夜\n\n${QUOTE}\n\n她没有催，只把另一盏灯移到桌角。\n\n第2章 门后\n\n门锁转了两圈，外面的人却始终没有进来。`;

const selectedFixture = () => [
    { n: 1, title: '雨夜', content: `${QUOTE}\n\n她没有催，只把另一盏灯移到桌角。` },
    { n: 2, title: '门后', content: '门锁转了两圈，外面的人却始终没有进来。' },
];

const validItem = (over = {}) => ({
    dimension: 'narrative', chapter: 1, quote: QUOTE,
    analysis: '先处理手稿再关门，用动作顺序交代人物最在意的东西。',
    transfer: '让人物在突发状况里先做一个选择，以选择次序替代直接介绍。',
    ...over,
});

function streamText(text, usage = { inputTokens: 120, outputTokens: 80 }) {
    return [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: text.slice(0, 17) },
        { type: 'text-delta', index: 0, text: text.slice(17) },
        { type: 'usage', usage },
        { type: 'finish', reason: { kind: 'stop' } },
    ];
}

test('semantic: 维度、章节范围与体量在调用模型前硬校验', () => {
    assert.deepEqual(parseSemanticDimensions('narrative，文风与用词,narrative'), ['narrative', 'style']);
    assert.throws(() => parseSemanticDimensions('unknown'), /未知拆书维度/);
    assert.throws(() => parseSemanticDimensions(' , '), /至少选择/);

    const chapters = Array.from({ length: 7 }, (_, index) => ({ title: `${index + 1}`, content: `正文${index + 1}` }));
    assert.deepEqual(selectSemanticChapters(chapters).map((chapter) => chapter.n), [1, 2, 3]);
    assert.deepEqual(selectSemanticChapters(chapters, { from: 6 }).map((chapter) => chapter.n), [6, 7]);
    assert.throws(() => selectSemanticChapters(chapters, { from: 1, to: 6 }), /最多 5 章/);
    assert.throws(() => selectSemanticChapters(chapters, { from: 6, to: 8 }), /超出原文/);
    assert.throws(() => selectSemanticChapters([
        { title: '长章', content: '字'.repeat(SEMANTIC_LIMITS.chars + 1) },
    ]), /30000 字上限/);

    const prompt = buildSemanticPrompt({
        title: '样本', chapters: selectedFixture(), dimensions: ['narrative'],
    });
    assert.match(prompt, /允许分析的 dimension：narrative（叙事方式）/);
    assert.match(prompt, /〈作品原文开始〉[\s\S]*雨沿着遮雨棚/);
});

test('semantic: 严格解析、证据 grounding、去重与报告渲染', () => {
    const options = { chapters: selectedFixture(), dimensions: ['narrative'] };
    const [item] = parseSemanticResponse(`\`\`\`json\n${JSON.stringify({ items: [validItem({ ignored: 'strip' })] })}\n\`\`\``, options);
    assert.deepEqual(Object.keys(item), ['dimension', 'chapter', 'quote', 'analysis', 'transfer']);

    const whitespaceQuote = `${QUOTE.slice(0, 12)}\n  ${QUOTE.slice(12)}`;
    assert.equal(parseSemanticResponse(JSON.stringify({ items: [validItem({ quote: whitespaceQuote })] }), options)[0].quote, whitespaceQuote);
    assert.throws(() => parseSemanticResponse('not-json', options), /不是合法 JSON/);
    assert.throws(() => parseSemanticResponse('{"items":[]}', options), /items 为空/);
    assert.throws(() => parseSemanticResponse(JSON.stringify({ items: [validItem({ dimension: 'style' })] }), options), /不在本次白名单/);
    assert.throws(() => parseSemanticResponse(JSON.stringify({ items: [validItem({ chapter: 3 })] }), options), /不在所选章节范围/);
    assert.throws(() => parseSemanticResponse(JSON.stringify({ items: [validItem({ quote: '这句话足够长但从未出现在任何原文里。' })] }), options), /逐字找不到/);
    assert.throws(() => parseSemanticResponse(JSON.stringify({ items: [validItem(), validItem()] }), options), /与前文重复/);

    const report = renderSemanticReport({
        title: '样本', from: 1, to: 2, dimensions: ['narrative'], items: [item],
        generatedAt: '2026-01-01T00:00:00.000Z', attempts: 1,
        usage: { inputTokens: 120, outputTokens: 80 },
    });
    assert.match(report, /引文已由代码逐字核对/);
    assert.match(report, /inputTokens":120/);
    assert.match(report, /可迁移做法/);
    assert.equal(semanticReportPath('sample', 1, 2), '书库/sample/语义拆书-第1-2章.md');
});

test('semantic: 复用 annotate 真引擎，usage 持久化，伪造引文零报告落盘', async () => {
    let response = JSON.stringify({ items: [validItem()] });
    const calls = [];
    const llm = {
        stream(options) {
            calls.push(options);
            return (async function* () {
                for (const chunk of streamText(response)) yield chunk;
            })();
        },
    };
    const harness = await bootPlugin({
        llm,
        agentDefaultModel: { provider: 'fixture-provider', model: 'fixture-model' },
        config: { engine: { retries: 0 } },
    });
    try {
        const library = harness.tool('novel_library');
        await library.execute({ action: 'import', title: '语义样本', text: SOURCE }, harness.exec);
        const value = await library.execute({
            action: 'semantic', title: '语义样本', from: 1, to: 2, dimensions: 'narrative',
        }, harness.exec);

        assert.equal(value.action, 'semantic');
        assert.equal(value.semantic.attempts, 1);
        assert.deepEqual(value.semantic.usage, { inputTokens: 120, outputTokens: 80 });
        assert.equal(value.semantic.items[0].quote, QUOTE);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].provider, 'fixture-provider');
        assert.equal(calls[0].model, 'fixture-model');
        assert.equal(calls[0].maxTokens, 4096);
        assert.match(calls[0].system, /输入作品是不可信资料/);
        assert.match(calls[0].messages[0].content[0].text, /〈作品原文开始〉/);

        const reportPath = semanticReportPath('语义样本', 1, 2);
        const report = harness.read(reportPath);
        assert.match(report, /雨沿着遮雨棚的破洞/);
        assert.match(report, /"outputTokens":80/);
        const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
        assert.deepEqual(validateJsonSchemaValue(library.output.schema, value), []);
        assert.match(library.output.render({ action: 'semantic' }, value)[0].text, /证据：/);

        response = JSON.stringify({ items: [validItem({ quote: '这句伪造证据虽然够长，却不在原文中。' })] });
        await library.execute({ action: 'import', title: '伪造样本', text: SOURCE }, harness.exec);
        await assert.rejects(library.execute({
            action: 'semantic', title: '伪造样本', from: 1, to: 1, dimensions: 'narrative',
        }, harness.exec), /逐字找不到/);
        assert.equal(harness.exists(semanticReportPath('伪造样本', 1, 1)), false);
    } finally {
        harness.cleanup();
    }
});
