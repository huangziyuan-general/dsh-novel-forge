import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureSourceRefs, buildImpactReport } from '../lib/impact.js';

const ref = (chapter, version, content) => captureSourceRefs({
    basis: { version: 2, digest: `basis-${chapter}`, sources: [{ type: 'outline', hash: `o${chapter}` }] },
    facts: [], foreshadows: [], content,
    previous: chapter > 1 ? { chapter: chapter - 1, version: version - 1, content: `old-${chapter - 1}` } : null,
});

test('影响清单：直接及传递受影响后章带细纲状态，只提示不重写', () => {
    const novel = { chapters: {
        1: { title: '一', latest: 2, sourceRefs: captureSourceRefs({ content: 'new-1' }) },
        2: { title: '二', latest: 1, sourceRefs: ref(2, 1, 'two') },
        3: { title: '三', latest: 1, sourceRefs: ref(3, 1, 'three') },
    } };
    novel.chapters[2].sourceRefs.previousChapter = { chapter: 1, version: 1, contentHash: 'old-hash' };
    novel.chapters[3].sourceRefs.previousChapter = { chapter: 2, version: 1, contentHash: novel.chapters[2].sourceRefs.contentHash };
    const report = buildImpactReport(novel, 1, { contentHashes: { 1: 'new-hash' }, outlines: { 2: { exists: true, hash: 'o2' } } });
    assert.deepEqual(report.affected.map((x) => [x.chapter, x.kind]), [[2, 'direct'], [3, 'transitive']]);
    assert.equal(report.affected[0].outline.exists, true);
    assert.match(report.notice, /不会自动重写/);
});

test('影响清单：老章节没有 refs 时明确不可判定，不误报无影响', () => {
    const report = buildImpactReport({ chapters: { 1: { latest: 1 }, 2: { title: '旧章', latest: 1 } } }, 1);
    assert.equal(report.affected.length, 0);
    assert.equal(report.unknown.length, 1);
    assert.match(report.unknown[0].reason, /无法判定/);
    // 用户不能把「无从判定」读成「没影响」
    assert.match(report.notice, /不能视为「没影响」/);
    assert.match(report.notice, /缺少来源记录/);
});

test('影响清单：有受影响章但仍有 unknown 时，notice 同时交代两边', () => {
    const report = buildImpactReport({
        chapters: {
            1: { latest: 2, sourceRefs: captureSourceRefs({ content: 'new-1' }) },
            2: { title: '新章', latest: 1, sourceRefs: { ...captureSourceRefs({ content: 'two' }), previousChapter: { chapter: 1, version: 1, contentHash: 'old' } } },
            3: { title: '旧章', latest: 1 },
        },
    }, 1, { contentHashes: { 1: 'new-1' } });
    assert.equal(report.affected.length, 1);
    assert.equal(report.unknown.length, 1);
    assert.match(report.notice, /不代表没有影响/);
});

test('影响清单：不可判定沿来源链传播，指向已删除前章也不能按无影响处理', () => {
    const report = buildImpactReport({ chapters: {
        1: { latest: 2, sourceRefs: captureSourceRefs({ content: 'new-1' }) },
        2: { title: '旧章', latest: 1 },
        3: { title: '依赖旧章', latest: 1, sourceRefs: {
            ...captureSourceRefs({ content: 'three' }),
            previousChapter: { chapter: 2, version: 1, contentHash: 'same-2' },
        } },
        4: { title: '前章已删', latest: 1, sourceRefs: {
            ...captureSourceRefs({ content: 'four' }),
            previousChapter: { chapter: 99, version: 1, contentHash: 'missing' },
        } },
    } }, 1, { contentHashes: { 2: 'same-2' } });
    assert.deepEqual(report.affected, []);
    assert.deepEqual(report.unknown.map((item) => item.chapter), [2, 3, 4]);
    assert.match(report.unknown[1].reason, /依赖链经过无法判定/);
    assert.match(report.unknown[2].reason, /第 99 章不存在/);
});

test('影响清单：有后章但均无影响时如实报告核对数量', () => {
    const report = buildImpactReport({ chapters: {
        1: { latest: 1 },
        2: { latest: 1, sourceRefs: { previousChapter: { chapter: 1, version: 1, contentHash: 'same-1' } } },
    } }, 1, { contentHashes: { 1: 'same-1' } });
    assert.equal(report.checked, 1);
    assert.equal(report.affected.length, 0);
    assert.equal(report.unknown.length, 0);
    assert.match(report.notice, /已核对 1 个后章，未发现受影响章/);
    assert.doesNotMatch(report.notice, /未发现后章/);
});

test('来源指纹：缺前章正文时保留版本但 contentHash 为 null', () => {
    const refs = captureSourceRefs({ content: 'x', previous: { chapter: 1, version: 3, content: null } });
    assert.equal(refs.previousChapter.version, 3);
    assert.equal(refs.previousChapter.contentHash, null);
});
