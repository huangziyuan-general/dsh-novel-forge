// test/smoke.test.mjs — 用宿主真实 SDK（@deepseek-ai/dsh-tools / schemastery）装载体，
// fs 用覆盖临时目录的假实现，端到端跑通插件主链路并验证全部硬约束真的会拦人。
// 运行前先 npm run setup-dev（test/skip 兜底见文件底部）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hasSdk = fs.existsSync(path.join(import.meta.dirname, '..', 'node_modules', '@deepseek-ai', 'dsh-tools'));

let root;
let ctx;
let exec;
let apply;

before(async () => {
    if (!hasSdk) return;
    ({ apply } = await import('../lib/index.js'));

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-smoke-'));
    const backend = {
        async resolve(p, opts) {
            const abs = path.isAbsolute(p) ? p : path.join(opts?.cwd ?? root, p);
            return { targetKey: `key:${abs}`, displayPath: path.relative(root, abs) };
        },
        async stat(target) {
            const abs = target.targetKey.slice(4);
            try {
                const s = fs.statSync(abs);
                return {
                    version: `v:${abs}`,
                    type: s.isDirectory() ? 'directory' : (s.isFile() ? 'file' : 'other'),
                    size: s.size,
                };
            } catch {
                return undefined;
            }
        },
        async readText(target) {
            const abs = target.targetKey.slice(4);
            return fs.readFileSync(abs, 'utf8');
        },
        async listDir(target) {
            const abs = target.targetKey.slice(4);
            return fs.readdirSync(abs, { withFileTypes: true }).map((d) => ({
                name: d.name,
                type: d.isDirectory() ? 'directory' : (d.isFile() ? 'file' : 'other'),
                target: { targetKey: `key:${path.join(abs, d.name)}` },
            }));
        },
        async writeText(target, content, intent) {
            const abs = target.targetKey.slice(4);
            const exists = fs.existsSync(abs);
            if (intent?.kind === 'createIfAbsent' && exists) {
                const error = new Error(`FS_NOT_OBSERVED: ${abs} 已存在`);
                error.code = 'FS_NOT_OBSERVED';
                throw error;
            }
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            const before = exists ? fs.readFileSync(abs, 'utf8') : null;
            fs.writeFileSync(abs, content);
            return { operation: exists ? 'update' : 'create', version: `v:${abs}:2`, before, after: content };
        },
    };

    const registered = [];
    const sections = [];
    ctx = {
        fs: backend,
        emit() {},
        logger: { info() {} },
        tools: { register: (t) => registered.push(t) },
        systemPrompt: { section: (s) => sections.push(s) },
        _registered: registered,
        _sections: sections,
    };
    exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: root } } } };

    apply(ctx, {
        minChapterChars: 300,
        maxChapterChars: 5000,
        contextBudgetChars: 4000,
        scanTopK: 8,
        repetitionWindow: 10,
        skipPresetDeploy: true, // 测试绝不碰 ~/.dsh
    });
});

after(() => {
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

function tool(name) {
    const t = ctx._registered.find((x) => x.name === name);
    if (t === undefined) throw new Error(`工具未注册：${name}`);
    return t;
}

const GOOD_CHAPTER = [
    '林晚把最后一枚铜钱按进香炉，灰烬腾起来，呛得她直咳嗽。三日没扫的供桌上，那只缺了口的粗瓷碗还在原处。',
    '',
    '院门吱呀一声开了条缝。她没有回头，只是把刀往膝盖边挪了半寸。刀鞘上凝的露水顺着掌纹滑下去，凉得很。',
    '',
    '「进来吧，别站在风口上。」她说。',
    '',
    '来客没有进门。他在门槛外蹲下来，慢条斯理地重新系了一遍鞋带，像是在给自己留出想开场白的工夫。',
    '',
    '「义庄的后墙，昨夜塌了个角。」他说，「棺材板翻出来三口，都是空的。」',
    '',
    '林晚的手指在刀柄上敲了两下。空棺材不稀奇，稀奇的是塌墙塌得恰到好处，偏偏露出这三口。',
    '',
    '来客把一只湿透的布鞋放在台阶上，鞋尖朝着屋里。灯笼里的蜡油淌到了托盘上，他也不管。',
    '',
    '林晚盯着那只鞋看了两息。鞋底沾的红泥，是城西乱葬岗才有的颜色。',
    '',
    '她忽然吹熄了灯。',
].join('\n');

test('装载：17 个工具注册 + 系统提示注入', () => {
    assert.equal(hasSdk, true, '缺宿主 SDK symlink：先 npm run setup-dev');
    assert.equal(ctx._registered.length, 17);
    assert.deepEqual(
        ctx._registered.map((t) => t.name),
        ['novel_project', 'novel_outline', 'novel_character', 'novel_worldbook', 'novel_briefing',
         'novel_write_chapter', 'novel_ledger', 'novel_noai_scan', 'novel_audit', 'novel_style',
         'novel_propose', 'novel_import', 'novel_export', 'novel_glossary', 'novel_clone_project',
         'novel_diagnose', 'novel_polish'],
    );
    assert.equal(ctx._sections.length, 1);
    assert.ok(ctx._sections[0].text.includes('代码强制') === false);
    assert.ok(ctx._sections[0].text.includes('novel_briefing'));
});

test('链路：init → 大纲 → 人物 → 世界书 → 细纲批准', async () => {
    const r1 = await tool('novel_project').execute(
        { action: 'init', book: '星海拾骨', title: '星海拾骨', genre: '东方玄幻', logline: '捡骨人逆改星图' }, exec,
    );
    assert.equal(r1.action, 'init');
    assert.ok(fs.existsSync(path.join(root, '星海拾骨', 'novel.json')));

    await assert.rejects(
        () => tool('novel_project').execute({ action: 'init', book: '星海拾骨' }, exec),
        /已存在/,
    );

    await tool('novel_outline').execute(
        { action: 'save_book', book: '星海拾骨', outline: '全书三卷：拾骨、逆星、还名。' }, exec,
    );
    const rc = await tool('novel_character').execute(
        { action: 'save', book: '星海拾骨', name: '林晚', card: '外在：拾骨人，寡言。隐性欲望：查清师父死因。语言基因：短句，惯用反问，从不先说结论。' }, exec,
    );
    assert.deepEqual(rc.cast, ['林晚']);

    const rw = await tool('novel_worldbook').execute(
        { action: 'add', book: '星海拾骨', keywords: '乱葬岗,红泥', content: '城西乱葬岗的红泥遇水不散，是识尸标记。' }, exec,
    );
    assert.equal(rw.entry.id, 'W1');

    await tool('novel_outline').execute(
        { action: 'save_chapter', book: '星海拾骨', chapter: 1, outline: '第1章：雨夜来客。出场：林晚。事件：收殓无名的尸体，来客留下湿布鞋（伏笔：城西红泥）。' }, exec,
    );

    // 门禁：批准前写章必须被拒绝
    await assert.rejects(
        () => tool('novel_write_chapter').execute(
            { book: '星海拾骨', chapter: 1, title: '雨夜来客', content: GOOD_CHAPTER, summary: '来客留鞋' }, exec,
        ),
        /细纲尚未批准/,
    );

    const ra = await tool('novel_outline').execute(
        { action: 'approve', book: '星海拾骨', chapter: 1 }, exec,
    );
    assert.equal(ra.approved, true);
});

test('briefing：上下文包按预算组装并带出人物卡与世界书', async () => {
    const r = await tool('novel_briefing').execute({ book: '星海拾骨', chapter: 1 }, exec);
    assert.ok(r.rendered.includes('人物卡·林晚'));
    assert.ok(r.rendered.includes('乱葬岗'), '世界书按细纲关键词命中');
    assert.ok(r.rendered.includes('第1章'));
    assert.deepEqual(r.dropped, []);
});

test('写章：机审通过 → 版本化落盘 → 账本落账 → 门禁放行记录', async () => {
    const r = await tool('novel_write_chapter').execute({
        book: '星海拾骨', chapter: 1, title: '雨夜来客',
        content: GOOD_CHAPTER,
        summary: '林晚雨夜收殓，来客留下乱葬岗红泥布鞋。',
        cast: '林晚',
        facts_updates: '林晚|位置|城南义庄\n布鞋|持有|门槛来客',
    }, exec);
    assert.equal(r.version, 1);
    assert.equal(r.audit.endingHook.detected, true, '章末「吹熄了灯」应判 suspense');
    assert.ok(r.chars >= 300);
    assert.equal(r.addedFacts.length, 2);
    assert.ok(fs.existsSync(path.join(root, '星海拾骨', '正文', '第1章-雨夜来客-v1.md')));

    const meta = JSON.parse(fs.readFileSync(path.join(root, '星海拾骨', 'novel.json'), 'utf8'));
    assert.equal(meta.approvals.outline['1'], true);
    assert.equal(meta.chapters['1'].latest, 1);
    assert.equal(meta.stage, 'drafting');
});

const CH2_CONTENT = [
    '天亮前最黑的那阵，林晚到了城西。乱葬岗的土被雨水泡松了，一脚下去能听见水从草根里挤出来的声音。',
    '',
    '塌墙处果然露出三口棺材。棺盖朝天翻着，内里干干净净，连一点腐味都没有——像是里面的东西自己走了。',
    '',
    '她蹲下去捻了一撮红泥。泥是湿的，可昨夜之后并没有再下过雨。',
    '',
    '红泥在她指间捻开，露出一点极细的骨屑。她把那点骨屑包进帕子，收进袖袋——师父说过，认尸先认土，土不会说谎。',
    '',
    '「所以你半夜跑来，就为了告诉我这个？」身后有人说话。林晚没有回头。她认得这个声音，也认得这个声音里那点刻意压住的得意。',
    '',
    '「我来看看，」她说，「你到底想让我看见什么。」',
    '',
    '回去的路上她绕开了大路。挑担的货郎、赶早市的婆子，都还没醒。只有城门口的乞丐看见她翻墙进去，也没吭声——上个月，她替他收殓了冻死的小孙子。',
].join('\n\n');

test('硬约束：账本同章改值 → 拒绝保存；字数不足 → 拒绝', async () => {
    await assert.rejects(
        () => tool('novel_write_chapter').execute({
            book: '星海拾骨', chapter: 2, title: '试探', force: true,
            content: CH2_CONTENT, summary: 'x',
            facts_updates: '林晚|位置|城北\n林晚|位置|城西',
        }, exec),
        /账本冲突/,
    );
    await assert.rejects(
        () => tool('novel_write_chapter').execute({
            book: '星海拾骨', chapter: 2, title: '太短', force: true,
            content: '短。', summary: 'x',
        }, exec),
        /低于下限|机审/,
    );
    // force 放行但被机审拒绝的调用不应留下任何正文文件
    assert.equal(fs.existsSync(path.join(root, '星海拾骨', '正文', '第2章-太短-v1.md')), false);
});

test('质检：noai 扫描与确定性审计', async () => {
    const s = await tool('novel_noai_scan').execute({ book: '星海拾骨', chapter: 1 }, exec);
    assert.equal(s.source, '星海拾骨/正文/第1章-雨夜来客-v1.md');
    assert.ok(s.score >= 0 && s.score <= 100);

    const a = await tool('novel_audit').execute({ book: '星海拾骨', chapter: 1 }, exec);
    assert.equal(a.verdict.ok, true);
    assert.ok(a.dialogueRatio > 0);
    assert.deepEqual(a.coverage.missing, [], '细纲声明的「林晚」必须出现在正文');

    const q = await tool('novel_ledger').execute(
        { action: 'query', book: '星海拾骨', entity: '林晚' }, exec,
    );
    assert.equal(q.facts[0].value, '城南义庄');
    assert.equal(typeof q.facts[0].note, 'string', '账本查询应带出 note');
});

test('提案制：修订 → apply 生成 v2，v1 保留', async () => {
    const p = await tool('novel_propose').execute({
        action: 'propose', book: '星海拾骨', chapter: 1,
        content: `${GOOD_CHAPTER}\n\n她把那只鞋收进了棺材底下。`,
        reason: '补一个动作收束',
    }, exec);
    assert.equal(p.status, 'pending');

    const applied = await tool('novel_propose').execute(
        { action: 'apply', book: '星海拾骨', proposal_id: p.id }, exec,
    );
    assert.equal(applied.version, 2);
    const v1 = fs.existsSync(path.join(root, '星海拾骨', '正文', '第1章-雨夜来客-v1.md'));
    const v2 = fs.existsSync(path.join(root, '星海拾骨', '正文', '第1章-雨夜来客-v2.md'));
    assert.ok(v1 && v2, '旧版必须保留');

    const meta = JSON.parse(fs.readFileSync(path.join(root, '星海拾骨', 'novel.json'), 'utf8'));
    assert.equal(meta.chapters['1'].latest, 2);
    assert.equal(meta.proposals[0].status, 'applied');

    const auditLog = fs.readFileSync(path.join(root, '星海拾骨', '.novel', 'audit.jsonl'), 'utf8');
    for (const action of ['init', 'outline/save_chapter', 'outline/approve', 'write_chapter/saved', 'write_chapter/rejected', 'propose/create', 'propose/apply']) {
        assert.ok(auditLog.includes(`"action":"${action}"`) || auditLog.includes(action), `审计缺 ${action}`);
    }
});

test('账本护栏：update 章号超前被拒；repair 索引-磁盘对账', async () => {
    // 当前全书已写到第 1 章：chapter=3 超前必须拒绝
    await assert.rejects(
        () => tool('novel_ledger').execute(
            { action: 'update', book: '星海拾骨', chapter: 3, updates: '林晚|位置|城北' }, exec,
        ),
        /超前/,
    );
    // chapter = 已写最大章 + 1 放行
    const r = await tool('novel_ledger').execute(
        { action: 'update', book: '星海拾骨', chapter: 2, updates: '林晚|位置|城西' }, exec,
    );
    assert.equal(r.addedCount, 1);

    // 破坏索引：把第 1 章指向不存在的 v3，再 repair 对账
    const metaPath = path.join(root, '星海拾骨', 'novel.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    meta.chapters['1'].files.push({ version: 3, file: '星海拾骨/正文/第1章-雨夜来客-v3.md' });
    meta.chapters['1'].latest = 3;
    meta.chapters['1'].path = '星海拾骨/正文/第1章-雨夜来客-v3.md';
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const rep = await tool('novel_project').execute({ action: 'repair', book: '星海拾骨' }, exec);
    assert.equal(rep.action, 'repair');
    assert.ok(rep.missing.length >= 1, '应报告失效文件引用');
    const meta2 = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(meta2.chapters['1'].latest, 2, 'latest 应回退到真实存在的 v2');
    assert.ok(!meta2.chapters['1'].files.some((f) => f.version === 3), '失效版本引用应被清理');
    assert.equal(meta2.approvals.outline['1'], true, '细纲仍存在，批准保留');
});

test('写章硬约束：facts_updates 章号超前同样被拒（force 场景也拦）', async () => {
    // chapter=100 远超已写最大章 1：即便 force 放行门禁，账本章号护栏也必须拦
    await assert.rejects(
        () => tool('novel_write_chapter').execute({
            book: '星海拾骨', chapter: 100, title: '穿越', force: true,
            content: CH2_CONTENT, summary: 's',
            facts_updates: '林晚|位置|千里之外',
        }, exec),
        /超前/,
    );
    assert.equal(fs.existsSync(path.join(root, '星海拾骨', '正文', '第100章-穿越-v1.md')), false, '护栏拒绝应不留文件');
});

test('维护通道：世界书 update 保 id / set_stage 可回退 / propose prune', async () => {
    // worldbook update：按 id 合并字段，id 不变
    const u = await tool('novel_worldbook').execute(
        { action: 'update', book: '星海拾骨', id: 'W1', content: '改注：城西乱葬岗的红泥带石灰。' }, exec,
    );
    assert.equal(u.entry.id, 'W1', 'update 保留 id');
    assert.ok(u.entry.content.includes('石灰'));
    assert.deepEqual(u.entry.keywords.sort(), ['乱葬岗', '红泥'].sort(), '未改 keywords 时保留原值');

    // set_stage：可前进、可回退（修复只前进无撤口的缺）
    const fwd = await tool('novel_project').execute({ action: 'set_stage', book: '星海拾骨', stage: 'revising' }, exec);
    assert.equal(fwd.stage, 'revising');
    const back = await tool('novel_project').execute({ action: 'set_stage', book: '星海拾骨', stage: 'drafting' }, exec);
    assert.equal(back.stage, 'drafting', 'set_stage 可回退');
    await assert.rejects(
        () => tool('novel_project').execute({ action: 'set_stage', book: '星海拾骨', stage: '不存在的阶段' }, exec),
        /未知阶段/,
    );

    // propose → apply → prune：const 索引清掉非 pending，真文件留冷归档
    const p = await tool('novel_propose').execute({ action: 'propose', book: '星海拾骨', chapter: 1, content: `${GOOD_CHAPTER}\n\n补一句收束。`, reason: '验证 prune' }, exec);
    await tool('novel_propose').execute({ action: 'apply', book: '星海拾骨', proposal_id: p.id }, exec);
    const pruned = await tool('novel_propose').execute({ action: 'prune', book: '星海拾骨' }, exec);
    assert.ok(pruned.removed >= 1, `应清理已终态提案，实际 ${pruned.removed}`);
    assert.equal(pruned.proposals.length, 0, '清完后不应再引用已终态提案');
    assert.ok(!pruned.proposals.some((x) => x.id === p.id), '被 apply 的提案索引已清');
});

test('资产/评审工具端到端：import → diagnose → export → glossary → polish → clone', async () => {
    const txt = '第1章 降临\n\n林晚在香炉前醒来，灰烬呛得她咳。\n\n第2章 布鞋\n\n门前放着一只湿透的布鞋，鞋尖朝着屋里。';
    const imp = await tool('novel_import').execute({ action: 'import', book: '拾骨记', title: '拾骨记', genre: '玄幻', content: txt }, exec);
    assert.equal(imp.chapters, 2, '应切出 2 章');
    assert.equal(imp.action, 'import');

    // backfill：导入书回补门禁（生成粗纲 + 批准），续写/改写回到门禁体系内
    const bf = await tool('novel_import').execute({ action: 'backfill', book: '拾骨记', approve: true }, exec);
    assert.equal(bf.action, 'backfill');
    assert.deepEqual(bf.backfilled, [1, 2], '两章都应回补粗纲');
    assert.equal(bf.approved, true);
    assert.ok(fs.existsSync(path.join(root, '拾骨记', '大纲', '细纲', '第1章.md')), '粗纲应落盘');
    assert.ok(fs.readFileSync(path.join(root, '拾骨记', '大纲', '细纲', '第2章.md'), 'utf8').includes('导入回补'));
    const im = JSON.parse(fs.readFileSync(path.join(root, '拾骨记', 'novel.json'), 'utf8'));
    assert.equal(im.approvals.outline['1'], true, '回补批准生效');
    assert.equal(im.approvals.outline['2'], true);
    const bf2 = await tool('novel_import').execute({ action: 'backfill', book: '拾骨记' }, exec);
    assert.equal(bf2.backfilled.length, 0, '已有细纲的章不再重复回补');

    const dg = await tool('novel_diagnose').execute({ book: '拾骨记' }, exec);
    assert.equal(dg.perChapter.length, 2);
    assert.equal(typeof dg.overall, 'string');

    const ex = await tool('novel_export').execute({ book: '拾骨记', format: 'md' }, exec);
    assert.ok(fs.existsSync(path.join(root, ex.path)), '导出文件应落盘');
    assert.ok(ex.chapters >= 2);
    assert.ok(ex.stats.totalChars >= 1);

    await tool('novel_glossary').execute({ action: 'add', book: '拾骨记', term: '乱葬岗红泥', definition: '遇水不散，是识尸标记。' }, exec);
    const brief = await tool('novel_briefing').execute({ book: '拾骨记', chapter: 1 }, exec);
    assert.ok(brief.rendered.includes('乱葬岗红泥'), '术语表应进上下文包');
    const gl = await tool('novel_glossary').execute({ action: 'list', book: '拾骨记' }, exec);
    assert.equal(gl.count, 1);

    const ap = await tool('novel_polish').execute({ action: 'analyze', book: '拾骨记', chapter: 1 }, exec);
    assert.ok(Array.isArray(ap.paragraphs));
    const longContent = [
        '林晚在香炉前醒来，灰烬呛得她直咳。她把那只湿布鞋收进棺底，天还没亮。',
        '院门吱呀一声开了条缝。她没有回头，只是把刀往膝盖边挪了半寸。刀鞘上凝的露水顺着掌纹滑下去，凉得很。',
        '「进来吧，别站在风口上。」她说。来客没有进门。他在门槛外蹲下来，慢条斯理地重新系了一遍鞋带。',
    ].join('\n\n').repeat(4);
    const sub = await tool('novel_polish').execute({ action: 'submit', book: '拾骨记', chapter: 1, content: longContent, reason: '润色' }, exec);
    assert.equal(sub.status, 'pending');
    assert.equal(sub.previous_version, 1);

    const cl = await tool('novel_clone_project').execute({ from_book: '拾骨记', new_book: '拾骨记-江南版' }, exec);
    assert.equal(cl.chapters, 2, '克隆应带 2 章文件');
    const cm = JSON.parse(fs.readFileSync(path.join(root, '拾骨记-江南版', 'novel.json'), 'utf8'));
    assert.equal(cm.stage, 'planning', '克隆重置阶段');
    assert.deepEqual(cm.proposals, [], '克隆清空提案');
    assert.equal(Object.keys(cm.chapters).length, 2);
    assert.ok(fs.existsSync(path.join(root, '拾骨记-江南版', '正文', '第1章-降临-v1.md')), '章节文件已复制');
});

test('工具 schema 与返回值一致性抽查（noai/audit 嵌套字段）', async () => {
    // additionalProperties:false 的 schema 声明了 topIssues/categories 等字段，
    // execute 返回里必须真实存在，否则宿主打 INVALID_TOOL_OUTPUT。
    const s = await tool('novel_noai_scan').execute({ text: '夜色如水。' }, exec);
    for (const key of ['source', 'score', 'level', 'chars', 'topIssues', 'categories']) {
        assert.ok(Object.hasOwn(s, key), `noai 缺字段 ${key}`);
    }
    for (const key of ['cliche', 'stock', 'emotion', 'template', 'structure', 'dilution']) {
        assert.ok(Object.hasOwn(s.categories, key), `noai.categories 缺 ${key}`);
    }
});

// 平淡收尾、无钩子词、无？！……结尾的正文（用于触发「缺省字段省略键」路径）
const NO_HOOK_CHAPTER = [
    '天光大亮，义庄里的一切都褪成了灰白色。林晚吹灭昨夜的灯笼，挂回梁上，拿了扫帚，从里间一步一步往外扫。',
    '',
    '三口空棺材停在堂屋正中，棺盖斜靠在墙边。她取出尺子逐一量了尺寸，记进怀里的小本子，又把地上的泥脚印用石灰细细圈了出来。',
    '',
    '来客坐在门槛上喝粥，喝得很慢。他说自己姓杜，在城里替人跑腿送信，昨夜路过此地，只是进来避了一场雨。',
    '',
    '林晚没有多问。她把那只湿布鞋洗净晾上窗台，又煮了一锅姜汤，给每口空棺前都放了满满一碗。灶台里的火熄了，余温还烘着手背。',
    '',
    '日头升到檐角的时候，杜姓来客起身告辞，说午后城里还有两封信要送。林晚送他到巷口，回来插上了院门。',
    '',
    '她又回到堂屋，把三口棺材的棺盖逐一合拢，掸去浮灰，在登记册上写下日期与名目。做完这些，她才坐下喝了自己那碗姜汤。',
].join('\n');

test('输出契约：可选字段缺省时省略键，真校验器对真实返回值零违规', async () => {
    assert.equal(hasSdk, true, '缺宿主 SDK symlink：先 npm run setup-dev');
    const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');
    const check = (name, value) => {
        const violations = validateJsonSchemaValue(tool(name).output.schema, value);
        assert.deepEqual(violations, [], `${name} 输出违反 output.schema：${violations.join('；')}`);
    };

    // 新书第 1 章 + 无钩子正文：同时触发 repetition.chapter 与 endingHook.kind 的缺省路径
    await tool('novel_project').execute({ action: 'init', book: '契约楼', title: '契约楼', genre: '悬疑' }, exec);
    await tool('novel_outline').execute({ action: 'save_chapter', book: '契约楼', chapter: 1, outline: '第1章：白日盘点义庄。出场：林晚。' }, exec);
    await tool('novel_outline').execute({ action: 'approve', book: '契约楼', chapter: 1 }, exec);
    const w = await tool('novel_write_chapter').execute({
        book: '契约楼', chapter: 1, title: '盘点', content: NO_HOOK_CHAPTER, summary: '白日盘点义庄，杜姓来客告辞。', cast: '林晚',
    }, exec);
    assert.equal(w.audit.endingHook.detected, false);
    assert.ok(!Object.hasOwn(w.audit.endingHook, 'kind'), '无钩子时应省略 kind 键');
    assert.ok(!Object.hasOwn(w.audit.repetition, 'chapter'), '无前文时应省略 chapter 键');
    check('novel_write_chapter', w);

    const a = await tool('novel_audit').execute({ book: '契约楼', chapter: 1 }, exec);
    check('novel_audit', a);

    // 无 plan 的伏笔：plan/payoffChapter 必须省略键（此前常态 null 必炸 INVALID_TOOL_OUTPUT）
    await tool('novel_ledger').execute({ action: 'foreshadow_setup', book: '契约楼', chapter: 1, setup: '梁上的铁钉' }, exec);
    const l = await tool('novel_ledger').execute({ action: 'query', book: '契约楼' }, exec);
    assert.ok(l.foreshadows.length >= 1);
    assert.ok(!Object.hasOwn(l.foreshadows[0], 'payoffChapter'), '未回收伏笔应省略 payoffChapter 键');
    assert.ok(!Object.hasOwn(l.foreshadows[0], 'plan'), '无 plan 伏笔应省略 plan 键');
    check('novel_ledger', l);

    const pz = await tool('novel_polish').execute({ action: 'analyze', book: '契约楼', chapter: 1 }, exec);
    assert.ok(!Object.hasOwn(pz, 'chapterHook'), '无钩子时应省略 chapterHook 键');
    check('novel_polish', pz);
});

test('克隆回归：未批准细纲一并复制，新书 approve 不再 TypeError', async () => {
    // 拾骨记：先存一章「只保存未批准」的细纲，再克隆
    await tool('novel_outline').execute({ action: 'save_chapter', book: '拾骨记', chapter: 9, outline: '第9章：尚未批准的细纲。' }, exec);
    await tool('novel_clone_project').execute({ from_book: '拾骨记', new_book: '拾骨记-塞北版' }, exec);
    assert.ok(
        fs.existsSync(path.join(root, '拾骨记-塞北版', '大纲', '细纲', '第9章.md')),
        '未批准细纲必须随克隆复制（按已写∪已批准并集）',
    );
    const cm = JSON.parse(fs.readFileSync(path.join(root, '拾骨记-塞北版', 'novel.json'), 'utf8'));
    assert.deepEqual(cm.approvals, { outline: {} }, '克隆产物的 approvals 必须与 defaultNovel 同形');
    const ra = await tool('novel_outline').execute({ action: 'approve', book: '拾骨记-塞北版', chapter: 9 }, exec);
    assert.equal(ra.approved, true, '克隆出的书必须能正常 approve（不再 TypeError）');
});

test('defineTool 垫片：顶层 render/presentationMeta 归位 output，渲染不再抛 userRender', async () => {
    assert.equal(hasSdk, true, '缺宿主 SDK symlink：先 npm run setup-dev');
    const { defineTool } = await import('../lib/tools/define-tool.js');
    const t = defineTool({
        name: 'shim_render_test',
        description: '垫片归位自测',
        parameters: {},
        output: { schema: { type: 'object', additionalProperties: false, properties: {} } },
        execute: async () => ({}),
        // 刻意放在选项顶层——宿主只读 output.render，垫片必须把它们搬进去
        render: (_a, v) => 'R:' + JSON.stringify(v),
        presentationMeta: (_a, v) => ({ kind: 'x' }),
    });
    assert.equal(typeof t.output.render, 'function', '顶层 render 应被归位为 output.render');
    assert.equal(typeof t.output.presentationMeta, 'function', '顶层 presentationMeta 应被归位为 output.presentationMeta');
    assert.equal(t.output.render({}, {}), 'R:{}', '顶层 render 归位后调用不再抛 userRender is not a function');
    assert.deepEqual(t.output.presentationMeta({}, {}), { kind: 'x' }, '顶层 presentationMeta 归位后可用');
});
