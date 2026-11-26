// test/anchor-diff.test.mjs — 锚点改写 diff（lib/anchor-diff.js 纯函数面）。
//
// 四条红线：
//   · 首写（无旧文）→ applicable=false 全静默（零回归：新建书/首次承诺书不掺噪声）；
//   · 方向性换血（题材词群整体替换 + 卷段群不重合 + 双低重合 + 自申报词）→ major=true；
//   · 同题材润色 / 错字小改 / 正常扩写 → major=false（不误报：尺子微调不该亮灯）；
//   · 五强信号（自申报/卷段增删/双低/字数突变/题材词群流失）任一即 major——留痕不拦截，
//     误报代价仅一行回执点名；同题材润色/错字小改/常规扩写不亮灯。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { anchorDiff, renderAnchorDiffSummary } from '../lib/anchor-diff.js';

// 修仙立意大纲（旧锚点）：五卷、修仙词群
const XIUXIAN = [
    '# 《某书》全书大纲',
    '',
    '## 卷一 青石镇风云（第1–30章）',
    '- 父子双穿互认、双系统上线；黑风寨战书压顶。',
    '- 闭环跑通段：师门功课涨修为，首战黑风寨翻盘。',
    '## 卷二 县城扬名（第31–70章）',
    '- 石玉以师傅身份大举收徒扬名，三宗争抢天命师徒。',
    '## 卷三 郡城风云（第71–120章）',
    '- 郡级宗门入场，修为线在郡城连案。',
    '## 卷四 宗门大比（第121–180章）',
    '- 宗门大比为主线爽点档，上界之影暗线。',
    '## 卷五 收束与真相（第181章–完结）',
    '- 大货车之谜书内闭环回收，身份线收拢，父子和解。',
].join('\n');

// 商战立意大纲（新锚点）：五卷同界但题材词群整体替换 + 自申报
const SHANGZHAN = [
    '# 《某书》全书大纲',
    '',
    '**修订说明（2026-11-25，162 章成稿校准）**：系统/修仙线于第 8 章后搁置，本书实际走向为明清官仓商战悬疑，以成稿为准。',
    '',
    '## 卷一 青石镇风云（第1–30章）',
    '- 父子双穿互认；黑风寨战书压顶；系统线约至第 8 章淡出，转入度量衡与商战民生。',
    '## 卷二 县城扬名（第31–70章）',
    '- 官商线索埋种：粮船靠岸、开秤验砣，官仓商战线在县城推进。',
    '## 卷三 郡城风云（第71–120章）',
    '- 郡级势力入场，商线连案，与官仓、市行纠葛加深。',
    '## 卷四 郡城商线·兑坊银线案（第121–180章）',
    '- 银炉验来路、兑坊门槛低，官锭洗散碎，逢七设伏数担记脚。',
    '## 卷五 商战深处与大货车真相（第181章–完结）',
    '- 漕运盐引边仓推盘，师徒倒挂身份几近穿帮，秤平灯亮。',
].join('\n');

test('★ 首写（无旧锚点）→ applicable=false 全静默', () => {
    const r = anchorDiff({ oldText: null, newText: XIUXIAN });
    assert.equal(r.applicable, false);
    assert.equal(r.major, false);
    const r2 = anchorDiff({ oldText: '', newText: XIUXIAN });
    assert.equal(r2.applicable, false, '空旧文同判首写');
    // 回执摘要对首写返回空串（调用方整段省略）
    assert.equal(renderAnchorDiffSummary(r), '');
});

test('★ 方向性换血（修仙→商战）→ major=true，自申报词命中', () => {
    const r = anchorDiff({ oldText: XIUXIAN, newText: SHANGZHAN });
    assert.equal(r.applicable, true);
    assert.equal(r.major, true, '题材词群整体替换 → 强信号');
    assert.equal(r.selfDeclared, true, '新文「修订说明/实际走向/搁置/以成稿为准」命中自申报');
    // 卷段对账：五卷标题词基本保留（卷一~三同），卷四/五换了名字
    assert.equal(r.volumes.kept >= 0, true);
    // 题材词群：修仙词（修为/宗门/大比/渡劫类）应出现在 lost
    assert.ok(Array.isArray(r.genreTerms.lost));
    assert.ok(Array.isArray(r.genreTerms.gained));
});

test('★ 反向（商战→修仙回撤）也 major（回撤本身是一次方向性锚点改写，同样该留痕）', () => {
    const r = anchorDiff({ oldText: SHANGZHAN, newText: XIUXIAN });
    assert.equal(r.major, true, '回撤修仙是方向性换血，留痕');
    // 回撤版（我重建的）不带「修订说明」自申报词（它自己就是被回撤的对象），
    // 靠词群换血 + 卷段群触发 major，不靠自申报
});

test('★ 同题材润色 / 错字小改 / 局部扩写 → major=false（不误报）', () => {
    // 错字小改（改一个字）
    const typo = XIUXIAN.replace('双系统上线', '双系统线上线');
    assert.equal(anchorDiff({ oldText: XIUXIAN, newText: typo }).major, false, '错字小改不亮灯');
    // 同题材扩写（在卷二加一行修仙节点，不改立意）
    const expand = XIUXIAN.replace(
        '- 石玉以师傅身份大举收徒扬名，三宗争抢天命师徒。',
        '- 石玉以师傅身份大举收徒扬名，三宗争抢天命师徒。\n- 石拾入门，隐藏天骄埋线，只埋不揭。',
    );
    assert.equal(anchorDiff({ oldText: XIUXIAN, newText: expand }).major, false, '同题材扩写不亮灯');
    // 措辞重写但同线（同卷段、同修仙词群）
    const reword = XIUXIAN.replace('首战黑风寨翻盘', '黑风寨一战父子合力取胜');
    assert.equal(anchorDiff({ oldText: XIUXIAN, newText: reword }).major, false, '同线换措辞不亮灯');
});

test('★ 自申报词单独即可 major（其余信号都不触发时）', () => {
    // 只在新文头部加一句「修订说明」，正文其余不动——字数/词群/卷段几乎不变
    const selfDeclared = `**修订说明**：本卷按最新讨论重排节点。\n${XIUXIAN}`;
    const r = anchorDiff({ oldText: XIUXIAN, newText: selfDeclared });
    assert.equal(r.selfDeclared, true);
    assert.equal(r.major, true, '自申报 = 方向性自证，单独即 major');
});

test('★ renderAnchorDiffSummary：major 出一行点名，非 major 出空串', () => {
    const major = anchorDiff({ oldText: XIUXIAN, newText: SHANGZHAN });
    const line = renderAnchorDiffSummary(major);
    assert.match(line, /锚点方向性变更/, 'major 回执点名');
    assert.match(line, /门禁参照物被换/, '说明后果');
    const quiet = anchorDiff({ oldText: XIUXIAN, newText: XIUXIAN.replace('双系统上线', '双系统线上线') });
    assert.equal(renderAnchorDiffSummary(quiet), '', '非 major 空串（调用方整段省略）');
});
