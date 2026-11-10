import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThreeWayMerge, mergedText } from '../lib/paragraph-merge.js';

test('三路合并：单方修改可选，双方同改自动一致，冲突默认保留当前稿', () => {
    const base = '标题\n\n甲\n\n乙\n\n丙';
    const proposal = '标题\n\n甲改\n\n乙\n\n丙';
    const current = '标题\n\n甲\n\n乙\n\n丙改';
    const merged = buildThreeWayMerge(base, proposal, current);
    assert.equal(merged.conflicts, 0);
    assert.equal(mergedText(merged.rows), '标题\n\n甲改\n\n乙\n\n丙改');

    const conflict = buildThreeWayMerge('甲\n\n乙', '甲一\n\n乙', '甲二\n\n乙');
    assert.equal(conflict.conflicts, 1);
    assert.equal(mergedText(conflict.rows), '甲二\n\n乙', '冲突不能默认拿提案覆盖当前稿');
    const row = conflict.rows.find((x) => x.conflict);
    assert.equal(mergedText(conflict.rows, { [row.id]: 'proposal' }), '甲一\n\n乙');
});

test('三路合并：共有段落作锚点，插入与删除不串到后续段', () => {
    const base = '开头\n\n不动\n\n结尾';
    const proposal = '开头\n\n新增\n\n不动\n\n结尾';
    const current = '开头\n\n不动\n\n结尾改';
    const merged = buildThreeWayMerge(base, proposal, current);
    assert.equal(mergedText(merged.rows), '开头\n\n新增\n\n不动\n\n结尾改');
    assert.equal(merged.conflicts, 0);
});

test('三路合并：无锚点的等长多段替换仍按段选择', () => {
    const merged = buildThreeWayMerge('甲\n\n乙', '甲提案\n\n乙', '甲当前\n\n乙当前');
    assert.equal(merged.rows.length, 2);
    assert.equal(merged.conflicts, 1);
    const conflict = merged.rows.find((row) => row.conflict);
    assert.equal(mergedText(merged.rows, { [conflict.id]: 'proposal' }), '甲提案\n\n乙当前');
});
