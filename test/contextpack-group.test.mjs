// test/contextpack-group.test.mjs — 上下文冲突组消解 + 丢弃次序声明（lib/contextpack-group.js）。
//
// 补的是 `lib/contextpack.js` 的结构性短板：它有成熟的硬预算与保留额，但
// **`push()` 是纯顺序填充**——同一主题有两块讲得不一样的东西时，谁挤掉谁靠的
// 是遍历顺序，不是显式规则。世界书里同一个角色散在好几条条目里各写各的、
// 人物卡又另有一份描述时，改造前只能碰运气。
//
// 这组测试钉住三件事：
//   ① 冲突组按**权威性**裁决：人物卡（专用描述）压世界书条目（泛设定）；
//      人物卡缺失时世界书照常进包；没有人物卡时两条世界书按 priority 决胜负。
//   ② 牺牲优先级（dropOrder）：预算不够时被踢的必须是**更不值钱**的那块；
//      没声明 dropOrder 的块（硬需求）**永远不会被牺牲**。
//   ③ 既有行为一字不变：没冲突、预算够时，包的构成与改造前一致。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildContextPack } from '../lib/contextpack.js';
import {
    AUTHORITY, entrySubjects, groupFor, pickVictim, resolveConflicts,
    resolveEntityConflicts, sacrificePriority,
} from '../lib/contextpack-group.js';

// ── 主题判定 ────────────────────────────────────────────────────────────────

test('主题判定：世界书条目讲的是谁（内容或关键词命中即算）', () => {
    assert.deepEqual(entrySubjects({ content: '张三出身青州。', keywords: [] }, ['张三']), ['张三']);
    assert.deepEqual(entrySubjects({ content: '设定正文', keywords: ['李四'] }, ['李四']), ['李四']);
    assert.deepEqual(entrySubjects({ content: '与人物无关的地理设定', keywords: ['地理'] }, ['张三']), []);
});

test('主题判定：长名优先（「张三丰」不该被「张三」抢走）', () => {
    assert.deepEqual(entrySubjects({ content: '张三丰是掌门。', keywords: [] }, ['张三', '张三丰']), ['张三丰']);
});

// ── 冲突组裁决 ──────────────────────────────────────────────────────────────

test('★ 冲突组：人物卡 vs 讲同一人的世界书条目 → 留人物卡（专用压泛设定）', () => {
    const r = resolveEntityConflicts({
        castCards: [{ name: '张三', card: '张三：青州人，寡言。' }],
        worldEntries: [{ id: 'W1', content: '张三其实是流亡的皇子。', keywords: ['张三'], priority: 90 }],
    });
    assert.deepEqual(r.excludedWorld, ['W1'], '世界书条目应被裁决出局（它讲法与人物卡冲突）');
    assert.equal(r.conflicts.length, 1);
    assert.equal(r.conflicts[0].winner, '人物卡·张三');
    assert.equal(r.conflicts[0].loser, '世界书·W1');
    assert.match(r.conflicts[0].reason, /权威性/, '理由要点明为什么留这一份');
});

test('★ 裁决理由：方向不许反（v1.2.1 修）——败者侧不得印出假的不等式', () => {
    const r = resolveEntityConflicts({
        castCards: [{ name: '张三', card: '张三：青州人，寡言。' }],
        worldEntries: [{ id: 'W1', content: '张三其实是流亡的皇子。', keywords: ['张三'], priority: 90 }],
    });
    const reason = r.conflicts[0].reason;
    // 人物卡权威性 100 > 世界书 50；败者侧必须说「低于」而不是拿 > 当分隔符
    assert.match(reason, /权威性 100 高于对方 50/, '胜者侧要说清高在哪');
    assert.match(reason, /权威性 50 低于对方 100/, '败者侧不得印出「50 > 100」这种假不等式');
    assert.doesNotMatch(reason, /权威性 \d+ > \d+/, '不得用 > 当「对」的分隔符');
    // 只说决定胜负的那一个键：人物卡赢在权威性，优先级它反而更低，不该并列出来
    assert.doesNotMatch(reason, /优先级/, '优先级不是决定胜负的键，不该出现在理由里');
});

test('裁决理由：权威性相同但新鲜度不同时，说新鲜度', () => {
    const r = resolveConflicts([
        { key: 'a', name: '甲', group: 'g', authority: 50, freshness: 10, priority: 50, required: false, order: 0 },
        { key: 'b', name: '乙', group: 'g', authority: 50, freshness: 90, priority: 50, required: false, order: 1 },
    ]);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0].name, '乙');
    assert.match(r.dropped[0].reason, /同样权威，但新鲜度 10 低于对方 90/);
});

test('冲突组：人物卡缺失时世界书条目照常进包（没冲突就不裁决）', () => {
    const r = resolveEntityConflicts({
        castCards: [],
        worldEntries: [{ id: 'W1', content: '张三其实是流亡的皇子。', keywords: ['张三'] }],
    });
    assert.deepEqual(r.excludedWorld, [], '没有人物卡就没有冲突，不该白白丢掉一条设定');
});

test('冲突组：两条世界书讲同一人（无人物卡）→ priority 高的留', () => {
    const r = resolveEntityConflicts({
        castCards: [],
        worldEntries: [
            { id: 'W1', content: '张三的来历。', keywords: ['张三'], priority: 90 },
            { id: 'W2', content: '张三的身世。', keywords: ['张三'], priority: 30 },
        ],
    });
    assert.deepEqual(r.excludedWorld, ['W2'], 'priority 低的那条出局');
    assert.equal(r.conflicts[0].winner, '世界书·W1');
});

test('冲突组：讲的是不同的人 → 不冲突（各留各的）', () => {
    const r = resolveEntityConflicts({
        castCards: [{ name: '张三', card: '卡' }],
        worldEntries: [{ id: 'W1', content: '李四的来历。', keywords: ['李四'] }],
    });
    assert.deepEqual(r.excludedWorld, []);
    assert.equal(r.conflicts.length, 0);
});

test('冲突组：一条世界书提到多人 → 任一组落选就整条出局（半个设定比整条出局更糟）', () => {
    const r = resolveEntityConflicts({
        castCards: [{ name: '张三', card: '卡' }],
        worldEntries: [{ id: 'W1', content: '张三与李四是同门师兄弟。', keywords: ['张三', '李四'] }],
    });
    assert.deepEqual(r.excludedWorld, ['W1'], '它与张三的卡冲突 → 整条出局，不许只带一半进包');
});

test('冲突组：组键按主题实体分，不按区块种类分', () => {
    assert.equal(groupFor({ kind: 'character', subject: '张三' }), 'entity:张三');
    assert.equal(groupFor({ kind: 'world', subject: '张三' }), 'entity:张三');
    assert.equal(groupFor({ kind: 'voice', subject: '张三' }), 'voice:张三');
    assert.equal(groupFor({ kind: 'world' }), null, '讲的是谁不明 → 不参与组内竞争');
});

// ── 裁决键顺序 ──────────────────────────────────────────────────────────────

const cand = (over) => ({
    key: 'k', name: 'n', group: 'g', authority: 0, freshness: 0, priority: 0, required: false, order: 0, ...over,
});

test('裁决键：权威性 > 新鲜度 > 优先级 > 硬需求 > 声明顺序', () => {
    const a = cand({ authority: 100, freshness: 0, name: 'A' });
    const b = cand({ authority: 50, freshness: 999, name: 'B' });
    const r = resolveConflicts([a, b]);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0].name, 'A', '权威性排第一：专用描述压泛设定，哪怕后者更新');
});

test('裁决键：权威性相同时比新鲜度', () => {
    const a = cand({ authority: 50, freshness: 1, name: '旧' });
    const b = cand({ authority: 50, freshness: 2, name: '新' });
    assert.equal(resolveConflicts([a, b]).kept[0].name, '新');
});

test('裁决键：再同则比优先级', () => {
    const a = cand({ authority: 50, freshness: 1, priority: 10, name: '低' });
    const b = cand({ authority: 50, freshness: 1, priority: 90, name: '高' });
    assert.equal(resolveConflicts([a, b]).kept[0].name, '高');
});

test('裁决键：再同则硬需求优先于非硬需求', () => {
    const a = cand({ authority: 50, freshness: 1, priority: 10, required: false, name: '软' });
    const b = cand({ authority: 50, freshness: 1, priority: 10, required: true, name: '硬' });
    assert.equal(resolveConflicts([a, b]).kept[0].name, '硬');
});

test('裁决键：全同级时按声明顺序（先声明的留）', () => {
    const a = cand({ order: 1, name: '先' });
    const b = cand({ order: 2, name: '后' });
    assert.equal(resolveConflicts([a, b]).kept[0].name, '先');
});

test('★ 裁决键完全相同 → 平权都留（不替用户做主）', () => {
    // 两条世界书 priority 都是默认 50 → 讲得同样权威，替用户挑一条留下就是
    // 凭空替他做主，还可能裁掉一条完全正常的设定。只有明确标了不同 priority
    // （或一方是专用描述/硬需求）时才裁决。
    const a = cand({ name: '甲', priority: 50 });
    const b = cand({ name: '乙', priority: 50 });
    const r = resolveConflicts([a, b]);
    assert.equal(r.kept.length, 2, '平权的两块都要留');
    assert.equal(r.dropped.length, 0, '不该有任何一块被裁');
});

// ── 牺牲优先级（dropOrder）──────────────────────────────────────────────────

test('牺牲优先级：没声明的块永不牺牲（缺省 -Infinity）', () => {
    assert.equal(sacrificePriority({}), Number.NEGATIVE_INFINITY);
    assert.equal(sacrificePriority({ dropOrder: 40 }), 40);
});

test('牺牲品挑选：选牺牲优先级最高的那个', () => {
    const packed = [
        { name: '人物卡', content: 'a' },
        { name: '世界书', content: 'b' },
        { name: '锚段', content: 'c' },
    ];
    const pr = (x) => ({ 人物卡: 10, 世界书: 40, 锚段: 50 }[x.name]);
    const v = pickVictim(packed, { dropOrder: -1 }, pr);
    assert.equal(v.name, '锚段', '最不值钱的先牺牲');
});

test('牺牲品挑选：没当前块该牺牲的就不动它', () => {
    const packed = [{ name: '人物卡', content: 'a' }];
    const pr = () => 10;
    assert.equal(pickVictim(packed, { dropOrder: 10 }, pr), null, '同级不该互相牺牲');
    assert.equal(pickVictim(packed, { dropOrder: 50 }, pr), null, '当前块更该牺牲时不该踢别人');
});

test('★ 牺牲品挑选：未声明 dropOrder 的块永不被选（硬需求不许为弹性块腾地方）', () => {
    // 这条钉的是一次真实事故：查询回调对「没声明」的块返回 undefined，
    // 而 undefined <= -Infinity 恒为 false —— 硬需求块（细纲）被当成了牺牲品踢掉。
    const packed = [{ name: '本章细纲', content: 'a' }];
    const pr = (x) => (x.name === '本章细纲' ? undefined : 40);
    assert.equal(pickVictim(packed, {}, pr), null, '细纲是硬需求，绝不能被牺牲');
    assert.equal(pickVictim(packed, { dropOrder: -1 }, pr), null, '哪怕当前块要牺牲，也不能动细纲');
});

// ── 端到端（上下文包组装）───────────────────────────────────────────────────

test('★ 端到端：人物卡与讲同一人的世界书条目冲突 → 世界书不进包，裁决有据', () => {
    const pack = buildContextPack({
        chapter: 3,
        chapterOutline: '本章细纲：写张三审问犯人。',
        castCards: [{ name: '张三', card: '张三：青州人，寡言，右手有旧伤。' }],
        worldEntries: [{ id: 'W1', content: '张三其实是流亡的皇子，门第极高。', keywords: ['张三'], priority: 90 }],
        budget: 3000,
    });
    const names = pack.sections.map((s) => s.name);
    assert.ok(names.some((n) => n.includes('人物卡·张三')), '人物卡必须在包里');
    assert.ok(!names.some((n) => n.includes('世界书·W1')), '★ 冲突的那条世界书不该进包');
    assert.equal(pack.conflicts.length, 1, '裁决必须留痕');
    assert.equal(pack.conflicts[0].loser, '世界书·W1');
    assert.ok(!pack.dropped.includes('世界书·W1'), '它是「讲法冲突」不是「预算装不下」，两回事');
});

test('端到端：没有冲突时世界书照常进包（默认行为不变）', () => {
    const pack = buildContextPack({
        chapter: 3,
        chapterOutline: '本章细纲：写张三审问犯人。',
        castCards: [{ name: '张三', card: '张三：青州人，寡言。' }],
        worldEntries: [{ id: 'W1', content: '城中的地理设定，与人物无关。', keywords: ['地理'] }],
        budget: 3000,
    });
    const names = pack.sections.map((s) => s.name);
    assert.ok(names.some((n) => n.includes('世界书·W1')), '不相关的设定不该被误裁');
    assert.equal(pack.conflicts.length, 0);
});

test('端到端：硬需求装不下时牺牲弹性块（dropOrder 真的生效）', () => {
    // 预算卡在「人物卡占着位、账本进不来」的位置：修前账本整块被丢，
    // 修后踢掉人物卡（弹性、可再得）把账本（硬需求）换进来。
    const pack = buildContextPack({
        chapter: 3,
        chapterOutline: '细纲。'.padEnd(100, 'A'),
        castCards: [{ name: '张三', card: '卡'.repeat(300) }],
        factsDigest: ['事实'.repeat(900)],
        budget: 1300,
    });
    const names = pack.sections.map((s) => s.name);
    assert.ok(names.some((n) => n.includes('事实账本')),
        `★ 账本是硬需求，不该为了留人物卡被丢掉：dropped=${pack.dropped.join(',')}`);
    assert.ok(!names.some((n) => n.includes('人物卡')), '人物卡是弹性块，被牺牲是对的');
    assert.ok(pack.dropped.some((d) => d.includes('人物卡')), '被牺牲的块要如实登记');
});

test('端到端：预算极紧时硬需求块也不许被牺牲（它们永不被踢）', () => {
    const pack = buildContextPack({
        chapter: 3,
        chapterOutline: '细纲。'.padEnd(100, 'A'),
        castCards: [{ name: '张三', card: '卡'.repeat(300) }],
        factsDigest: ['事实'.repeat(900)],
        budget: 200,   // 连硬需求都装不下
    });
    const names = pack.sections.map((s) => s.name);
    assert.ok(names.some((n) => n.includes('本章细纲')), '细纲永远在包里');
});
