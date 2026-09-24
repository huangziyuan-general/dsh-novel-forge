// test/smoke.test.mjs — 用宿主真实 SDK（@deepseek-ai/dsh-tools / schemastery）装载体，
// fs 用覆盖临时目录的假实现，端到端跑通插件主链路并验证全部硬约束真的会拦人。
// 运行前先 npm run setup-dev（test/skip 兜底见文件底部）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFsio, auditLine } from '../lib/fsio.js';
import * as proposals from '../lib/proposals.js';

const hasSdk = fs.existsSync(path.join(import.meta.dirname, '..', 'node_modules', '@deepseek-ai', 'dsh-tools'));

/** 插件配置（apply 与「服务端通道」直测共用，避免两处漂移）。 */
const CFG = {
    minChapterChars: 300,
    maxChapterChars: 5000,
    contextBudgetChars: 4000,
    scanTopK: 8,
    repetitionWindow: 10,
    skipPresetDeploy: true, // 测试绝不碰 ~/.dsh
};

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
    const effects = [];
    ctx = {
        fs: backend,
        emit() {},
        logger: { info() {} },
        tools: { register: (t) => registered.push(t) },
        systemPrompt: { section: (s) => sections.push(s) },
        inject: (deps, fn) => { fn(ctx); },
        effect: (fn) => { effects.push(fn); fn(); },
        webServer: { register: () => () => {} },
        _registered: registered,
        _sections: sections,
        _effects: effects,
    };
    // 会话身份：工具层用它做「书 → 会话」归属（面板按会话过滤项目列表）
    exec = { signal: new AbortController().signal, agent: { session: { header: { cwd: root, id: 'sess-A' } } } };

    apply(ctx, CFG);
});

after(() => {
    if (root !== undefined) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * 「服务端通道」io —— 与 REST 端点（lib/server-api.js）同款构造。
 *
 * 提案的 apply / discard / prune 是**用户主权动作**，刻意不在工具面暴露
 * （见 lib/proposals.js）。所以测试里它们不走 tool(...)，而走这里 ——
 * 这本身就是门禁设计的体现：模型够不到这些动作。
 */
function serverIo() {
    return createFsio(ctx, exec, root);
}

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

test('装载：20 个工具注册 + 系统提示注入', () => {
    assert.equal(hasSdk, true, '缺宿主 SDK symlink：先 npm run setup-dev');
    assert.equal(ctx._registered.length, 20);
    // 全工具 schema 形状守卫（parameters 已被 define-tool 归一为 JSON Schema）：
    // 新工具最容易漏 output.schema 声明 / additionalProperties:false / required 指向不存在的字段。
    for (const t of ctx._registered) {
        const s = t.output?.schema;
        assert.ok(s && s.type === 'object' && s.additionalProperties === false && s.properties
            && Object.keys(s.properties).length > 0, `工具 ${t.name} 的 output.schema 形状不合规`);
        for (const req of s.required ?? []) {
            assert.ok(Object.hasOwn(s.properties, req), `工具 ${t.name} output.required 声明了不存在的字段 ${req}`);
        }
        const p = t.parameters;
        assert.ok(p?.type === 'object' && p.properties
            && Object.keys(p.properties).length > 0, `工具 ${t.name} 的 parameters 应归一为 JSON Schema`);
        for (const [pname, pspec] of Object.entries(p.properties)) {
            assert.ok(pspec.type !== undefined && pspec.description, `工具 ${t.name} 参数 ${pname} 缺 type/description`);
        }
        for (const req of p.required ?? []) {
            assert.ok(Object.hasOwn(p.properties, req), `工具 ${t.name} required 声明了不存在的参数 ${req}`);
        }
    }
});

test('严格参数：垫片包装 execute 拒绝未知字段（宿主参数 schema 无严格开关）', async () => {
    await assert.rejects(
        () => tool('novel_project').execute({ action: 'status', book: '契约楼', bogus_field: 1 }, exec),
        /无效参数（未知字段）/,
    );
    // 合法参数不受影响（契约楼在第 528 行的契约测试里创建，若先跑本用例则 book 校验在参数校验之后）
    await assert.rejects(
        () => tool('novel_project').execute({ action: 'status', book: '契约楼' }, exec),
        (e) => !/无效参数/.test(e.message),
    );
    assert.deepEqual(
        ctx._registered.map((t) => t.name),
        ['novel_project', 'novel_outline', 'novel_character', 'novel_worldbook', 'novel_scene', 'novel_briefing',
         'novel_write_chapter', 'novel_ledger', 'novel_noai_scan', 'novel_audit', 'novel_style',
         'novel_propose', 'novel_import', 'novel_export', 'novel_glossary', 'novel_clone_project',
         'novel_diagnose', 'novel_polish', 'novel_search', 'novel_library'],
    );
    assert.equal(ctx._sections.length, 1);
    assert.ok(ctx._sections[0].text.includes('代码强制') === false);
    assert.ok(ctx._sections[0].text.includes('novel_briefing'));
});

test('★ 会话归属：init 写入创建会话；其他会话碰到也补录；老书自动认领', async () => {
    assert.equal(hasSdk, true, '缺宿主 SDK symlink：先 npm run setup-dev');
    const project = tool('novel_project');
    const metaPath = path.join(root, '归属测试书', 'novel.json');

    await project.execute({ action: 'init', book: '归属测试书', title: '归属测试书' }, exec);
    let meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.deepEqual(meta.sessions, ['sess-A'],
        '★ init 必须把创建会话写进 sessions —— 这是面板「项目跟会话走」的全部依据');

    // 另一个会话对这本书做只读动作 → 归属集追加（否则在那边写章、面板里却看不见书）
    const execB = { signal: new AbortController().signal, agent: { session: { header: { cwd: root, id: 'sess-B' } } } };
    await project.execute({ action: 'status', book: '归属测试书' }, execB);
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.deepEqual(meta.sessions, ['sess-A', 'sess-B'], '★ 用过工具的会话也要归属（有去无回才是 bug）');

    // 0.5.0 之前建的老书：没有 sessions 字段 → 被工具碰到即补录，否则从此在面板里消失
    fs.mkdirSync(path.join(root, '老书'), { recursive: true });
    fs.writeFileSync(path.join(root, '老书', 'novel.json'),
        JSON.stringify({ title: '老书', stage: 'planning', chapters: {} }, null, 2));
    await project.execute({ action: 'status', book: '老书' }, exec);
    const legacy = JSON.parse(fs.readFileSync(path.join(root, '老书', 'novel.json'), 'utf8'));
    assert.deepEqual(legacy.sessions, ['sess-A'], '★ 老书被工具碰到要自动补录会话戳');

    // 拿不到会话 id（headless 等）不得乱写
    const execNoSession = { signal: new AbortController().signal, agent: { session: { header: { cwd: root } } } };
    await project.execute({ action: 'init', book: '无会话书', title: '无会话书' }, execNoSession);
    const noSession = JSON.parse(fs.readFileSync(path.join(root, '无会话书', 'novel.json'), 'utf8'));
    assert.deepEqual(noSession.sessions, [], '没有会话 id 时不能凭空造归属');
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
    assert.equal(meta.stage, 'writing', '写章后阶段推进到九阶段的 writing');
    assert.equal(meta.gateFailures['1'], undefined, '成功落盘 → 熔断计数清零');
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

test('提案制（融合 A1）：工具面只有 propose/list；apply 是用户动作、审计留痕 actor', async () => {
    // ① 门禁先断言：apply/prune 必须不在工具面 —— 模型无法自己批准自己的提案
    //    parameters 是 JSON Schema（宿主据此校验 enum），故从这里读。
    const actions = tool('novel_propose').parameters.properties.action.enum;
    assert.deepEqual(actions, ['propose', 'list'], '工具面只留 propose/list');
    assert.ok(!actions.includes('apply'), 'apply 必须不在工具面（批准钥匙归用户）');
    assert.ok(!actions.includes('prune'), 'prune 同样不该在工具面');

    // ② 模型侧：只能提提案，不改正文
    const p = await tool('novel_propose').execute({
        action: 'propose', book: '星海拾骨', chapter: 1,
        content: `${GOOD_CHAPTER}\n\n她把那只鞋收进了棺材底下。`,
        reason: '补一个动作收束',
    }, exec);
    assert.equal(p.status, 'pending');
    const metaAfterPropose = JSON.parse(fs.readFileSync(path.join(root, '星海拾骨', 'novel.json'), 'utf8'));
    assert.equal(metaAfterPropose.chapters['1'].latest, 1, 'propose 不得改动正文版本');

    // ③ 用户侧：apply 走服务端通道（REST 端点同款调用），生成 v2 且旧版保留
    const applied = await proposals.applyProposal(serverIo(), '星海拾骨', p.id, CFG, 'user');
    assert.equal(applied.version, 2);
    const v1 = fs.existsSync(path.join(root, '星海拾骨', '正文', '第1章-雨夜来客-v1.md'));
    const v2 = fs.existsSync(path.join(root, '星海拾骨', '正文', '第1章-雨夜来客-v2.md'));
    assert.ok(v1 && v2, '旧版必须保留');

    const meta = JSON.parse(fs.readFileSync(path.join(root, '星海拾骨', 'novel.json'), 'utf8'));
    assert.equal(meta.chapters['1'].latest, 2);
    assert.equal(meta.proposals[0].status, 'applied');

    // 状态回写回归（2026-09-23 真机排障）：提案文件里的 status 不得停留在创建时的 pending——
    // apply 只更新索引会让「文件说 pending、索引说 applied」双源分裂，读文件的诊断全被带偏
    const pfAfterApply = JSON.parse(fs.readFileSync(path.join(root, '星海拾骨', '.novel', 'proposals', `${p.id}.json`), 'utf8'));
    assert.equal(pfAfterApply.status, 'applied', '提案文件 status 必须随 apply 回写');
    assert.ok(typeof pfAfterApply.appliedAt === 'string' && pfAfterApply.appliedAt !== '', 'appliedAt 必须回写');

    // ④ 审计留痕：能分辨「这条是谁做的」——apply 是 user，propose 是 agent
    const auditLog = fs.readFileSync(path.join(root, '星海拾骨', '.novel', 'audit.jsonl'), 'utf8');
    for (const action of ['init', 'outline/save_chapter', 'outline/approve', 'write_chapter/saved', 'write_chapter/rejected', 'propose/create', 'propose/apply']) {
        assert.ok(auditLog.includes(action), `审计缺 ${action}`);
    }
    const rows = auditLog.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rows.every((r) => typeof r.actor === 'string' && r.actor !== ''), '每行审计都必须带 actor');
    assert.equal(rows.find((r) => r.action === 'propose/apply')?.actor, 'user', 'apply 的 actor 必须是 user');
    assert.equal(rows.find((r) => r.action === 'propose/create')?.actor, 'agent', 'propose 的 actor 应是 agent');
});

test('提案丢弃（融合 A1）：discard 只改状态不动正文，且同样只走服务端通道', async () => {
    const p = await tool('novel_propose').execute({
        action: 'propose', book: '星海拾骨', chapter: 1,
        content: `${GOOD_CHAPTER}\n\n再补一句试试丢弃。`, reason: '验证 discard',
    }, exec);
    const beforeMeta = JSON.parse(fs.readFileSync(path.join(root, '星海拾骨', 'novel.json'), 'utf8'));

    const d = await proposals.discardProposal(serverIo(), '星海拾骨', p.id, 'user');
    assert.equal(d.status, 'discarded');

    const afterMeta = JSON.parse(fs.readFileSync(path.join(root, '星海拾骨', 'novel.json'), 'utf8'));
    assert.equal(afterMeta.chapters['1'].latest, beforeMeta.chapters['1'].latest, 'discard 不该动正文版本');
    assert.equal(afterMeta.proposals.find((x) => x.id === p.id).status, 'discarded');
    const pfAfterDiscard = JSON.parse(fs.readFileSync(path.join(root, '星海拾骨', '.novel', 'proposals', `${p.id}.json`), 'utf8'));
    assert.equal(pfAfterDiscard.status, 'discarded', '提案文件 status 必须随 discard 回写');
    // 已丢弃的提案不可再 apply
    await assert.rejects(
        () => proposals.applyProposal(serverIo(), '星海拾骨', p.id, CFG, 'user'),
        /状态为 discarded/,
    );
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
    assert.equal(fwd.stage, 'revision', '旧名 revising 映射到九阶段 revision');
    const back = await tool('novel_project').execute({ action: 'set_stage', book: '星海拾骨', stage: 'drafting' }, exec);
    assert.equal(back.stage, 'writing', 'set_stage 可回退（旧名 drafting → writing）');
    await assert.rejects(
        () => tool('novel_project').execute({ action: 'set_stage', book: '星海拾骨', stage: '不存在的阶段' }, exec),
        /未知阶段/,
    );

    // propose → apply → prune：索引清掉非 pending，真文件留冷归档
    // （prune 与 apply 一样属用户主权动作，工具面不提供，走服务端通道）
    const p = await tool('novel_propose').execute({ action: 'propose', book: '星海拾骨', chapter: 1, content: `${GOOD_CHAPTER}\n\n补一句收束。`, reason: '验证 prune' }, exec);
    await proposals.applyProposal(serverIo(), '星海拾骨', p.id, CFG, 'user');
    const pruned = await proposals.pruneProposals(serverIo(), '星海拾骨', 'user');
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

    // ★ 导出不是自毁通道：file 只许落本书的 导出/，指到机器状态文件（或别的书）必须被拒
    for (const evil of ['拾骨记/novel.json', '拾骨记/账本/facts.json', '拾骨记/.novel/audit.jsonl', '别的书/导出/x.md']) {
        await assert.rejects(
            () => tool('novel_export').execute({ book: '拾骨记', format: 'md', file: evil }, exec),
            /导出目录/,
            `file=${evil} 必须被拒`,
        );
    }
    assert.ok(JSON.parse(fs.readFileSync(path.join(root, '拾骨记', 'novel.json'), 'utf8')).chapters,
        '被拒的导出不得碰坏 novel.json');

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
    assert.equal(cm.stage, 'topic', '克隆重置阶段到九阶段起点');
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

test('client 结构契约：package.json 声明 ./client + dsh.client，产物带 ModuleLoader 标记', () => {
    // 浏览器半无法在假 ctx 挂载验证，这里只守结构契约不漂移：
    // (1) exports["./client"] 指向已落盘的产物；(2) dsh.client 声明存在；
    // (3) lib/client.js 以 __ModuleLoader__.load 开头、以 }); 收尾、load id 等于插件名。
    const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
    assert.equal(pkg.exports['./client'], './lib/client.js', 'exports["./client"] 必须指向 lib/client.js');
    assert.equal(pkg.dsh.client.platform, 'web', 'dsh.client 必须声明 platform=web');
    // dsh.client.inject 是「信息性包名依赖」（打包器 external 解析用，非 Cordis 服务注入）：
    // 组合阶段会按它从插件目录解析包，声明了不存在的包会被整体拒绝。本插件只
    // require react（平台种子表），必须保持 inject 缺省/为空。
    const inject = pkg.dsh.client.inject;
    // inject 是打包器信息性依赖（external 解析用），宿主 peer 包（@deepseek-ai/*）不必存在于本地 node_modules
    const isPeer = (x) => x.startsWith('@deepseek-ai/');
    assert.ok(inject === undefined || (Array.isArray(inject) && inject.every((x) => isPeer(x) || fs.existsSync(path.join('./node_modules', x)))),
        'dsh.client.inject 只能声明本地可达包或 @deepseek-ai/* 宿主 peer 包，或省略');
    const src = fs.readFileSync('./lib/client.js', 'utf8');
    // 产物由 scripts/build-client.mjs 从 src/client/ 生成：头部带 generated 标记。
    // 缺这个标记 = 有人直接改了产物，构建链已被绕过（源码与产物脱钩）。
    assert.match(src, /^\/\/ ⚠️ 自动生成/, 'client.js 必须带 generated 头（证明来自 npm run build，而非手写）');
    assert.match(src, /window\.__ModuleLoader__\.load\(/, 'client.js 必须调用 __ModuleLoader__.load');
    assert.match(src, /id:\s*"dsh-novel-forge"/, 'client.js 的 load id 必须等于插件名');
    // 导出改由 esbuild 的 CJS 装配交回（module.exports = __toCommonJS(index_exports)），
    // 不再有手写的 `exports.apply = apply` —— 断言导出**表内容**，不绑死语句形态。
    assert.match(src, /module\.exports\s*=\s*__toCommonJS\(index_exports\)/, 'client.js 必须以 CJS 语义交回导出表');
    assert.match(src, /apply:\s*\(\)\s*=>\s*apply/, '导出表必须含 apply');
    assert.match(src, /inject:\s*\(\)\s*=>\s*inject/, '导出表必须含 inject');
    assert.ok(!/^\s*(import|export)\s/m.test(src), '产物不得含 ESM 语法——dsh 按经典脚本执行，混入 import/export 会整包 syntax error');
});

test('节奏铁律（融合 F2）：preset 与工具描述都写死「一次只写一章」', () => {
    // 治「一句话就写到章节结束」：persona 层 + 工具描述层 + 系统提示层，三处都有。
    const base = path.join(import.meta.dirname, '..');
    const preset = fs.readFileSync(path.join(base, 'lib', 'preset', 'novel-forge', 'agent.cordis.yml'), 'utf8');
    assert.ok(preset.includes('节奏铁律'), 'preset persona 必须有节奏铁律');
    assert.ok(preset.includes('一次只写一章'), 'preset 必须写明「一次只写一章」');
    assert.ok(preset.includes('绝不擅自连写第二章'), 'preset 必须写明不许连写下一章');

    const wt = fs.readFileSync(path.join(base, 'lib', 'tools', 'writing-tools.js'), 'utf8');
    assert.ok(wt.includes('节奏铁律'), 'novel_write_chapter 工具描述应带节奏铁律');

    const idx = fs.readFileSync(path.join(base, 'lib', 'index.js'), 'utf8');
    assert.ok(idx.includes('节奏铁律'), 'systemPrompt 纪律清单应含节奏铁律');
});

test('审计 actor：默认 agent，用户通道显式传 user', () => {
    // 默认值必须是 agent（工具路径无需逐个改），显式传参要能覆盖。
    const line = auditLine('propose/apply', { id: 'P1-abc' });
    assert.equal(JSON.parse(line).actor, 'agent', '缺省 actor 应为 agent');
    const userLine = auditLine('propose/apply', { id: 'P1-abc' }, 'user');
    assert.equal(JSON.parse(userLine).actor, 'user');
    // detail 不得覆盖 actor（actor 是系统字段，放在展开之后）
    const guarded = auditLine('x', { actor: 'forged' });
    assert.equal(JSON.parse(guarded).actor, 'agent', 'detail 里的 actor 不该覆盖系统字段');
});

// ── 第二批融合：内容门禁 / 一致性校验 / 承诺书 / 追读节奏 ────────────────────

const DEAD_CH1 = [
    '河滩上的雾比往年更重。赵擎单膝跪在碎石里，左手还死死按着那口从来不肯出鞘的刀。',
    '',
    '林晚是循着血腥味找过来的。她拨开芦苇时，看见他背后的血已经把整片鹅卵石染成暗褐色，像谁打翻了一整坛陈年的酒。',
    '',
    '她蹲下去，把他歪着的头扶正，让他能看见天。他的眼睛还睁着，瞳孔里映着一小块铅灰色的云。',
    '',
    '「别说话。」她说。她的手在抖，但声音很稳，稳得像在念一段背了很多年的咒。',
    '',
    '赵擎笑了一下。他喉咙里发出一点漏气的声音，像风穿过破了洞的窗户纸，断断续续，却还听得清字。',
    '',
    '「上游……第三道弯……船底……」他抬起手，指尖指了指雾气最浓的方向，又慢慢落回自己的胸口，按了按。',
    '',
    '「我记下了。」林晚说。她把他那只手握住，掌心很凉，凉得像刚从井里捞出来的石头。',
    '',
    '他的手垂下去。雾慢慢合拢，把河滩上的一切，连同那点微弱的呼吸声，一起吞了进去。',
    '',
    '三天后，林晚回到义庄。她洗净了那口刀上的血，把它端端正正放回供桌，然后点了一炷新香。',
    '',
    '香烧到一半，火苗忽然无风自偏，朝着上游的方向倒了倒。',
].join('\n');

const DEAD_CH2 = [
    '天还没亮，赵擎就敲响了院门。他穿着一件洗得发白的旧棉袍，肩膀上落着雪，雪还没化。',
    '',
    '林晚没有开门。她隔着门板听他咳嗽。这咳嗽声她听过太多次，每一次都意味着一笔新的、让人不太舒服的买卖。',
    '',
    '「义庄又空了。」赵擎说，「这回连尸首都没留下，只剩下三口空棺，棺盖朝天翻着。」',
    '',
    '她把手按在门闩上，指节泛白。三年前他把师父的尸首从河里捞上来时，也是这样站在门外，这样咳嗽。',
    '',
    '门终究还是开了。风卷着雪扑进来，吹得供桌上的纸钱连着翻了两个身，又落回原处。',
    '',
    '赵擎在门槛外站着，没有进来。他低头看着自己的鞋尖，像是在等一句他自己也知道不会有的回答。',
    '',
    '「上游第三道弯。」林晚说。她盯着他，一字一句地问，「你怎么会知道那个地方？」',
    '',
    '赵擎抬起头。雪水顺着他的鬓角往下淌，他张了张嘴，什么也没说出来。',
    '',
    '她忽然觉得，这个人不该还站在这里。',
].join('\n');

test('★ 内容门禁：死人复活阻断落盘；force 放行记审计；check 复查出硬伤', async () => {
    assert.equal(hasSdk, true, '缺宿主 SDK symlink：先 npm run setup-dev');
    const project = tool('novel_project');
    await project.execute({ action: 'init', book: '门禁测试书', title: '门禁测试书' }, exec);

    await tool('novel_outline').execute(
        { action: 'save_chapter', book: '门禁测试书', chapter: 1, outline: '第1章：河滩。赵擎重伤垂死。出场：林晚、赵擎。' }, exec,
    );
    await tool('novel_outline').execute({ action: 'approve', book: '门禁测试书', chapter: 1 }, exec);
    const ch1 = await tool('novel_write_chapter').execute({
        book: '门禁测试书', chapter: 1, title: '河滩', content: DEAD_CH1, summary: '赵擎重伤，指向上游第三道弯后死去。',
        facts_updates: '赵擎|状态|阵亡',
    }, exec);
    assert.equal(ch1.contentGate.ok, true, '第1章本身没有硬伤');

    await tool('novel_outline').execute(
        { action: 'save_chapter', book: '门禁测试书', chapter: 2, outline: '第2章：夜访。来客敲门（悬念）。出场：林晚。' }, exec,
    );
    await tool('novel_outline').execute({ action: 'approve', book: '门禁测试书', chapter: 2 }, exec);

    // ★ 门禁必须拦：赵擎已阵亡，第2章正文却让他出场
    await assert.rejects(
        () => tool('novel_write_chapter').execute({
            book: '门禁测试书', chapter: 2, title: '夜访', content: DEAD_CH2, summary: '来客深夜敲门',
        }, exec),
        /内容门禁未通过|死亡人物复活/,
    );

    // force 放行 → 落盘，但审计里留下 force 记录
    const forced = await tool('novel_write_chapter').execute({
        book: '门禁测试书', chapter: 2, title: '夜访', content: DEAD_CH2, summary: '来客深夜敲门', force: true,
    }, exec);
    assert.equal(forced.contentGate.ok, false, 'force 放行也要如实报告门禁不通过');
    const auditLog = fs.readFileSync(path.join(root, '门禁测试书', '.novel', 'audit.jsonl'), 'utf8');
    assert.ok(auditLog.includes('content_gate_forced'), 'force 放行必须留痕');

    // check：全书一致性校验复查出死人复活
    const chk = await project.execute({ action: 'check', book: '门禁测试书' }, exec);
    assert.equal(chk.continuity.ok, false);
    assert.ok(chk.continuity.issues.some((i) => i.code === 'dead-reappear' && i.severity === 'error'),
        `check 应报 dead-reappear，实报 ${chk.continuity.issues.map((i) => i.code).join(',')}`);

    // audit continuity:true 附带同一套结论（两条通道一份实现）
    const aud = await tool('novel_audit').execute({ book: '门禁测试书', chapter: 2, continuity: true }, exec);
    assert.equal(typeof aud.continuityResult.ok, 'boolean');
    assert.ok(aud.continuityResult.issues.some((i) => i.code === 'dead-reappear'));
});

test('★ 追读铁律：到期伏笔零回应却开新钩 → 内容门禁阻断', async () => {
    const project = tool('novel_project');
    await project.execute({ action: 'init', book: '追读测试书', title: '追读测试书' }, exec);
    // 第1章埋一个「预计第2章回收」的伏笔
    await tool('novel_ledger').execute({
        action: 'foreshadow_setup', book: '追读测试书', chapter: 1, setup: '断刃的下落', plan: 2,
    }, exec);

    await tool('novel_outline').execute(
        { action: 'save_chapter', book: '追读测试书', chapter: 1, outline: '第1章：埋下断刃的线索。出场：林晚。' }, exec,
    );
    await tool('novel_outline').execute({ action: 'approve', book: '追读测试书', chapter: 1 }, exec);
    await tool('novel_write_chapter').execute({
        book: '追读测试书', chapter: 1, title: '断刃', content: DEAD_CH1, summary: '留下断刃的线索。',
    }, exec);

    await tool('novel_outline').execute(
        { action: 'save_chapter', book: '追读测试书', chapter: 2, outline: '第2章：来客（章末留悬念）。出场：林晚。' }, exec,
    );
    await tool('novel_outline').execute({ action: 'approve', book: '追读测试书', chapter: 2 }, exec);

    // 第2章通篇不提断刃，结尾却开新钩 → 阻断
    const noPayoff = DEAD_CH2.replace(/赵擎/g, '来客').replace(/这个人不该还站在这里/, '门外又响起了第三种脚步声');
    await assert.rejects(
        () => tool('novel_write_chapter').execute({
            book: '追读测试书', chapter: 2, title: '来客', content: noPayoff, summary: '来客夜访',
        }, exec),
        /追读铁律|欠账未还/,
    );

    // 正文里回一句旧账 → 放行
    const paid = `${noPayoff}\n\n她这才想起，供桌上那口断刃已经三天没动过了。`;
    const ok = await tool('novel_write_chapter').execute({
        book: '追读测试书', chapter: 2, title: '来客', content: paid, summary: '来客夜访，想起断刃',
    }, exec);
    assert.equal(ok.contentGate.ok, true, '回应了旧账就该放行');
});

test('★ 承诺书：写入后每次写章注入上下文（承诺写了才有人看）', async () => {
    const project = tool('novel_project');
    await project.execute({ action: 'init', book: '承诺测试书', title: '承诺测试书' }, exec);

    const empty = await project.execute({ action: 'promise', book: '承诺测试书' }, exec);
    assert.equal(empty.hasPromise, false, '未写时读回空');

    const saved = await project.execute({
        action: 'promise', book: '承诺测试书',
        promise: '本书向读者承诺：每章至少一个反转；不做无脑虐主；感情线单一不摇摆；绝不烂尾。',
    }, exec);
    assert.equal(saved.hasPromise, true);

    const again = await project.execute({ action: 'promise', book: '承诺测试书' }, exec);
    assert.ok(again.promise.includes('每章至少一个反转'), '承诺书要能读回');

    const brief = await tool('novel_briefing').execute({ book: '承诺测试书', chapter: 1 }, exec);
    assert.ok(brief.rendered.includes('故事承诺书'), '承诺书必须进上下文包');
    assert.ok(brief.rendered.includes('每章至少一个反转'));
    assert.ok(brief.rendered.includes('追读节奏'), '追读节奏硬约束是固定注入项');
});

// ─────────────────────────────────────────────────────────────────────────────
// 融合第三批（上下文工程）：B3 场景契约 / E3 语言基因卡 / A3+A4 细纲契约指标
// ─────────────────────────────────────────────────────────────────────────────

/** 干净正文：第三人称统一、无引号、无钩子、不含既有实体——只为测「禁项」这一条门禁。 */
const CLEAN_CHAPTER = [
    '他在破庙里坐了一整夜。庙顶漏下的雨珠敲着青砖，一声一声，像有人在外面数着数。他把包袱垫在膝上，指尖反复摩着一个缺角。',
    '',
    '天亮前雨停了。他起身把火堆刨开，底下的炭还红着，风一吹就亮起来。他把包袱重新系紧，走出门槛时回头看了一眼那尊倒了半边的泥像，泥像脸上落着水，像哭过，又像笑过。',
    '',
    '山道上的泥是松的，踩下去要拔一下才走得动。走了约莫半个时辰，他停下来，从怀里取出一枚储物戒指，在掌心里掂了掂，又放回衣襟深处。',
    '',
    '林子那边的雾还没散，白得发黏，贴着地面不肯走。他想起许多年前也有人在这种雾里走丢过，后来只在河滩上找到一只鞋。',
    '',
    '风从岔口那边过来，带着潮气和草屑。他把衣领掩紧，继续往前走，鞋底在泥里发出轻微的响声。前面是个岔口，左边通向镇子，右边那条窄路绕进林子。',
].join('\n');

test('★ B3 场景契约：隐藏人物不进上下文，写进正文被内容门禁拦下', async () => {
    const outline = tool('novel_outline');
    const scene = tool('novel_scene');
    const briefing = tool('novel_briefing');
    const write = tool('novel_write_chapter');

    const saved = await scene.execute({
        action: 'save', book: '星海拾骨', chapter: 2,
        scene: '雨夜断刃', participants: '林晚', hidden: '陆寒',
        forbidden: '储物戒指', notes: '陆寒的真实身份本章不揭',
    }, exec);
    assert.deepEqual(saved.contract.participants, ['林晚']);
    assert.deepEqual(saved.contract.hidden, ['陆寒']);
    const cPath = path.join(root, '星海拾骨', '设定', '场景契约.json');
    assert.ok(fs.existsSync(cPath), '契约文件必须落盘');
    assert.ok(fs.readFileSync(cPath, 'utf8').includes('陆寒'), '落盘内容要含声明');

    await outline.execute({
        action: 'save_chapter', book: '星海拾骨', chapter: 2,
        outline: '## 本章必写场景\n1. 断刃现世：断刃从江底浮起\n\n## 本章禁止偏离项\n- 禁止使用「储物戒指」\n',
    }, exec);
    await outline.execute({ action: 'approve', book: '星海拾骨', chapter: 2 }, exec);

    const bf = await briefing.execute({ book: '星海拾骨', chapter: 2 }, exec);
    const leaks = bf.sections.filter((x) => x.content.includes('陆寒')).map((x) => x.name);
    assert.deepEqual(leaks, [], '★ 隐藏人物名不得进上下文（悬念保护：不知道就写不出来）');
    assert.ok(bf.rendered.includes('林晚'), '出场人物要在场');
    assert.equal(bf.hiddenCount, 1, '要报告「有 1 人隐藏」但不给名字');

    // 正文与第1章无重合：否则机审（跨章重复率）会先于内容门禁拦下，测不到悬念保护这条
    const bad = `${CLEAN_CHAPTER}\n\n陆寒从雾里走出来，掌中托着一柄断刃，正是从江底浮起的那一柄。`;
    const dbgLog = fs.readFileSync(path.join(root, '星海拾骨', '.novel', 'audit.jsonl'), 'utf8');
    const cg = (await import('../lib/content-gate.js')).contentGate;
    const r0 = cg({ content: bad, chapter: 2, contract: { hidden: ['陆寒'] } });
    await assert.rejects(
        () => write.execute({ book: '星海拾骨', chapter: 2, title: '雨夜断刃', content: bad, summary: '陆寒现身', cast: '林晚' }, exec),
        /隐藏人物|泄底/,
        '★ 隐藏人物出现在正文必须被拦（不靠模型自觉）',
    );

    const ok = await write.execute({
        book: '星海拾骨', chapter: 2, title: '雨夜断刃', content: bad, summary: '陆寒现身', cast: '林晚', force: true,
    }, exec);
    assert.equal(ok.gate.bannedHits.includes('储物戒指'), true, '命中禁项要落进指标');
    assert.equal(ok.gate.passed, false, '违约的章不该判通过');

    const meta = JSON.parse(fs.readFileSync(path.join(root, '星海拾骨', 'novel.json'), 'utf8'));
    assert.equal(meta.chapters['2'].gate.coverage, 100, '★ 契约指标落盘到章节索引（可看趋势）');
    assert.equal(meta.chapters['2'].gate.passed, false);
    const auditLog = fs.readFileSync(path.join(root, '星海拾骨', '.novel', 'audit.jsonl'), 'utf8');
    assert.ok(auditLog.includes('content_gate_forced'), '内容门禁 force 放行必须留痕');
    assert.ok(auditLog.includes('gate_forced'), '细纲禁项 force 也要留痕');
});

test('★ A3/A4 细纲禁项：命中即拒绝落盘（判定权归代码）', async () => {
    const outline = tool('novel_outline');
    const write = tool('novel_write_chapter');
    await outline.execute({
        action: 'save_chapter', book: '星海拾骨', chapter: 3,
        outline: '## 本章必写场景\n1. 断刃现世：断刃从江底浮起\n\n## 本章禁止偏离项\n- 禁止使用「储物戒指」\n',
    }, exec);
    await outline.execute({ action: 'approve', book: '星海拾骨', chapter: 3 }, exec);

    await assert.rejects(
        () => write.execute({
            book: '星海拾骨', chapter: 3, title: '岔口', cast: '林晚', summary: '选路', content: CLEAN_CHAPTER_B,
        }, exec),
        /细纲禁项/,
        '★ 细纲写死的禁项由代码拦（假阳性风险由 force 出口兜）',
    );
});

test('★ E3 语言基因卡：建卡单独注入；角色说了自己的禁忌词被抓出', async () => {
    const character = tool('novel_character');
    const briefing = tool('novel_briefing');
    const audit = tool('novel_audit');

    const saved = await character.execute({
        action: 'save', book: '星海拾骨', name: '林晚',
        card: '外在：拾骨人，寡言。隐性欲望：查清师父死因。',
        voice: '句长|短句为主，很少超过12字\n逻辑|先做后说\n口头禅|别急\n禁忌|香炉\n动作|敲刀柄',
    }, exec);
    assert.ok(saved.voiceFields.length >= 4, `语言基因卡字段要落盘，实际 ${saved.voiceFields.length}`);

    const bf = await briefing.execute({ book: '星海拾骨', chapter: 2 }, exec);
    assert.ok(bf.rendered.includes('说话方式'), '★ 语言基因卡要单独注入成区块（混在人物卡里会被滑过去）');
    assert.equal(bf.voiceCount, 1, '契约里的出场人物有卡就注入');

    const a = await audit.execute({ book: '星海拾骨', chapter: 1, voice: true }, exec);
    assert.ok(a.voiceResult.errors >= 1, '★ 第1章正文写了「香炉」，而林晚的禁忌词就是香炉——必须抓出');
    assert.equal(a.voiceResult.issues.some((i) => i.code === 'voice-taboo'), true);

    const listed = await character.execute({ action: 'list', book: '星海拾骨' }, exec);
    assert.ok(listed.voiced.includes('林晚'), 'list 要能看到谁建了语言基因卡');
});


/** 第3章专用正文：与 CLEAN_CHAPTER 无重合，含禁词「储物戒指」、无引号、无钩子。 */
const CLEAN_CHAPTER_B = [
    '午后日头偏西，镇口那家米铺已经上了板。他从板缝里往里看了一眼，柜台后没人，只有一只猫趴在算盘上。',
    '',
    '街面上还剩两三个摊子没收。卖炭的老头蹲在墙根下，用火镰敲着石头，火星溅到鞋面上也不在意。他在摊前停下，摸出几枚铜板换了一小袋盐。',
    '',
    '巷子深处传来磨刀的声音，一长一短，很慢。他顺着声音走过去，看见一个瘦高的人坐在小凳上，脚边摆着一只木盆，盆里的水浑得像泥汤。',
    '',
    '那人抬起头笑了一下，嘴唇动了动。他没有听清，只觉得后颈起了一层细密的汗。他摸了摸怀里，那枚储物戒指还在。',
    '',
    '他没有再往前走，转身出了巷子，朝镇外走去。天色还亮着，路上的影子拉得很长。',
    '',
    '镇外的坡上有一片矮松，风过时沙沙响，像有很多人在低声说话。他找了块石头坐下，把盐袋放在脚边，抬头看云。',
    '',
    '云走得慢，一层压着一层。他坐了很久，直到日头完全落到山后，坡下的镇子亮起零星的灯。',
].join('\n');

// ── 第四批：F1 九阶段 / E2 熔断 / C4 平台审稿 / C5 敏感自查 ─────────────────

test('★ F1 九阶段：入场条件由代码判，越级拦得住、force 放行记 skipped', async () => {
    const project = tool('novel_project');
    await project.execute({ action: 'init', book: '阶段测试书', title: '阶段测试书', logline: '一个拾骨人查师父的死因。' }, exec);

    // 看板：新书停在 topic；写作阶段入场条件是代码判的，缺什么要能列出来
    const board0 = await project.execute({ action: 'phase', book: '阶段测试书' }, exec);
    assert.equal(board0.stage, 'topic');
    assert.equal(board0.phases.length, 9);
    const w0 = board0.phases.find((x) => x.phase === 'writing');
    assert.equal(w0.entryOk, false);
    assert.ok(w0.missing.length >= 1, '★ 缺什么必须说出来，不能只回一个 false');

    // 越级进 writing：拦（大纲/细纲/正文全缺）
    await assert.rejects(
        () => project.execute({ action: 'phase', book: '阶段测试书', stage: 'writing' }, exec),
        /入场条件未满足/,
    );

    // force 放行 → 落 stage + 前置阶段记 skipped + PhaseReport 记缺口
    const forced = await project.execute({ action: 'phase', book: '阶段测试书', stage: 'writing', force: true }, exec);
    assert.equal(forced.stage, 'writing');
    assert.equal(forced.forced, true);
    const meta = JSON.parse(fs.readFileSync(path.join(root, '阶段测试书', 'novel.json'), 'utf8'));
    assert.equal(meta.phases.topic.status, 'skipped', '★ 越级时前置阶段记 skipped —— 跳阶段这件事必须可审计');
    assert.equal(meta.phases.writing.status, 'approved');
    assert.ok(meta.phases.writing.report.errorCount >= 1, 'PhaseReport 记下 force 时的缺口数');

    // 补齐设定（世界书条目）→ 条件齐了就不用 force
    await tool('novel_worldbook').execute(
        { action: 'add', book: '阶段测试书', id: 'W1', keywords: '乱葬岗', content: '城西乱葬岗的红泥带石灰。' }, exec,
    );
    const ok = await project.execute({ action: 'phase', book: '阶段测试书', stage: 'setting' }, exec);
    assert.equal(ok.forced, false, '入场条件满足时应直接进入，不该记 forced');
    assert.equal(ok.stage, 'setting');

    // 旧名兼容：set_stage 'planning' → topic
    const legacy = await project.execute({ action: 'set_stage', book: '阶段测试书', stage: 'planning' }, exec);
    assert.equal(legacy.stage, 'topic', '旧五阶段名照旧可用，老数据零迁移');
});

test('★ E2 熔断：同章连续被驳回 3 次即拒写；重批细纲可解除', async () => {
    const project = tool('novel_project');
    const outline = tool('novel_outline');
    const write = tool('novel_write_chapter');
    const metaPath = path.join(root, '熔断测试书', 'novel.json');

    await project.execute({ action: 'init', book: '熔断测试书', title: '熔断测试书', logline: '测试熔断用。' }, exec);
    await outline.execute({
        action: 'save_chapter', book: '熔断测试书', chapter: 1,
        outline: '## 本章必写场景\n- 义庄夜谈：林晚与来客在义庄对谈，揭开空棺一事。\n\n## 本章禁止偏离项\n- 禁止使用「香炉」\n',
    }, exec);
    await outline.execute({ action: 'approve', book: '熔断测试书', chapter: 1 }, exec);

    const args = { book: '熔断测试书', chapter: 1, title: '雨夜来客', content: GOOD_CHAPTER, summary: '林晚夜会来客，得知义庄空棺。' };

    // 连续 3 次被细纲禁项驳回（GOOD_CHAPTER 里写了「香炉」）
    for (let i = 1; i <= 3; i += 1) {
        await assert.rejects(() => write.execute({ ...args }, exec), /细纲禁项被违反/, '第 ' + i + ' 次应被拦');
        const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        assert.equal(m.gateFailures['1'], i, '★ 驳回计数必须落盘（否则熔断永远数不满）');
    }

    // 第 4 次：熔断——连门禁都不跑，直接拒写，并给出解除路径
    await assert.rejects(() => write.execute({ ...args }, exec), /熔断/, '★ 连续 3 次后必须熔断，逼回去改设定');
    const m2 = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(m2.stage, 'topic', '熔断期间阶段没有推进');
    assert.equal(m2.chapters['1'], undefined, '熔断期间没有落盘任何正文');

    // 解除通道：重批细纲（去掉禁项）→ 计数清零 → 写得进去
    await outline.execute({
        action: 'save_chapter', book: '熔断测试书', chapter: 1,
        outline: '## 本章必写场景\n- 义庄夜谈：林晚与来客在义庄对谈，揭开空棺一事。\n',
    }, exec);
    await outline.execute({ action: 'approve', book: '熔断测试书', chapter: 1 }, exec);

    const ok = await write.execute({ ...args }, exec);
    assert.equal(ok.version, 1);
    const m3 = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(m3.gateFailures['1'], undefined, '★ 成功落盘后熔断计数清零');
    assert.equal(m3.stage, 'writing', '写章顺带把阶段推到九阶段的 writing');
});

test('★ C4/C5：平台审稿与敏感自查接进 novel_audit（可选维度，不污染默认输出）', async () => {
    const audit = tool('novel_audit');

    const plain = await audit.execute({ book: '熔断测试书', chapter: 1 }, exec);
    assert.equal(plain.platformReview, undefined, '不传 platform 就不该多算一份');
    assert.equal(plain.censorResult, undefined);

    const q = await audit.execute({ book: '熔断测试书', chapter: 1, platform: 'qidian' }, exec);
    assert.equal(q.platformReview.platform, 'qidian');
    assert.equal(q.platformReview.name, '起点');
    assert.ok(q.platformReview.checks.length >= 5);
    assert.ok(q.platformReview.checks.some((c) => c.key === 'ending-hook'));
    assert.ok(q.platformReview.score > 0 && q.platformReview.score <= 100);

    const f = await audit.execute({ book: '熔断测试书', chapter: 1, platform: 'fanqie' }, exec);
    assert.equal(f.platformReview.name, '番茄');
    assert.ok(f.platformReview.checks.some((c) => c.key === 'first-1k-thrill' || c.key === 'suffering-duration'));

    const c = await audit.execute({ book: '熔断测试书', chapter: 1, censor: true, exempt: 'feudal' }, exec);
    assert.equal(c.censorResult.level, 'clean');
    assert.deepEqual(c.censorResult.categories, []);

    await assert.rejects(
        () => audit.execute({ book: '熔断测试书', chapter: 1, platform: '未知平台' }, exec),
        /未知平台/,
    );
});

// ── G1 长篇检索（第五批）：走真实工具注册，覆盖 build → query → 幂等 → 派生物可重建 ──
// 这条链是「零依赖 + 中文自切分」唯一端到端证据：batch5 单测只覆盖纯函数，
// sqlite/FTS5 那一层（node:sqlite + fts5 + 二元切分入库）只有这里真跑。
test('★ G1 长篇检索：build 建索引 → query 按记忆碎片找回 → 索引可删可重建', async () => {
    const project = tool('novel_project');
    const outline = tool('novel_outline');
    const write = tool('novel_write_chapter');
    const search = tool('novel_search');

    const BOOK = '检索试点书';
    await project.execute({ action: 'init', book: BOOK, title: BOOK }, exec);

    // 两章刻意用**不同**词汇分布，好验证「碎片 → 章」的指向性
    const CH1 = [
        '周砚把斗笠的系带解开，随手搁在码头的石阶上。风灯在桅杆之间摇晃，把江面照成一条条抖动的碎金。他数着远处的更鼓，一声，两声，直到夜风把他的衣角掀起来，又落下。',
        '他等的人没有来。倒是江心有艘乌篷船悄悄靠了岸，船头立着个戴斗笠的身影，一动不动地望了他许久，像是在确认什么。岸上的纤夫收工了，绳索在石桩上勒出细响。',
        '「你是周砚？」那人终于开口。周砚没有应声，只是把袖中的短刃往里收了半寸。脚下的石阶被夜露浸得发滑，他退半步，靴底碾过一粒碎石。',
        '他把斗笠檐往下压了压，遮住半张脸。江风穿过桅杆，带起一阵铁锈味，那是上游船坞里新补的船板在滴桐油。远处有狗吠，吠了两声，很快又停了。',
        '他忽然想起师父临走前那句没头没尾的话，说这一带的水底下埋着不该埋的东西。那时他只当是醉话，如今站在码头上，竟也觉着江风里带着一股散不去的腥气。',
    ].join('\n\n');
    const CH2 = [
        '天亮时雾散了，义庄的后墙塌了个角。周砚蹲在被雨水泡软的泥土里，翻出三口空棺材，棺盖上的漆皮一碰就掉，露出底下发黑的木纹。',
        '棺底刻着同样的记号——一枚被划掉的铜钱。这记号他见过，在三年前师父失踪的那一夜，也在师父留下的那本残卷的最后一页。',
        '他把记号描在纸上，折好塞进衣襟。远处传来更鼓，一声闷响，惊起满树的寒鸦，扑棱棱地掠过青灰的屋顶，落向西边的乱葬岗。',
        '义庄的门框上还挂着去年的白幡，布边烂成流苏。周砚站起身拍了拍膝上的泥，回头望了一眼那三口棺材，心里那点疑惑像水渍一样慢慢洇开。',
        '他把那页纸对着天光又看了一遍。笔迹是他自己的，可他怎么也想不起来是什么时候描下的——昨夜他分明早早睡下了，连窗纸都没揭过，更不曾点灯。',
    ].join('\n\n');

    for (const n of [1, 2]) {
        await outline.execute({ action: 'save_chapter', book: BOOK, chapter: n, outline: `## 本章必写场景\n1. 试点场景${n}\n` }, exec);
        await outline.execute({ action: 'approve', book: BOOK, chapter: n }, exec);
    }
    await write.execute({ book: BOOK, chapter: 1, title: '码头夜会', content: CH1, summary: '周砚夜会神秘人', cast: '周砚' }, exec);
    await write.execute({ book: BOOK, chapter: 2, title: '义庄空棺', content: CH2, summary: '发现空棺与记号', cast: '周砚' }, exec);

    const built = await search.execute({ action: 'build', book: BOOK }, exec);
    if (built.degraded) {
        // 运行时没有 node:sqlite：检索整体退化为关键词匹配（设计红线，不报错）
        const r = await search.execute({ action: 'query', book: BOOK, q: '斗笠' }, exec);
        assert.equal(r.degraded, true);
        assert.equal(r.mode, 'substring');
        assert.ok(r.hits.length >= 1, '降级路径也要能把段落找回来');
        return;
    }

    assert.equal(built.scanned, 2, '两章都应被扫入索引');
    assert.ok(built.chunks >= 2, `两章至少切出两块，实际 ${built.chunks}`);
    assert.equal(built.chapters, 2);

    // ★ 索引必须落在 书/.novel/index.db —— 跟着书走，删书即删索引
    const indexPath = path.join(root, BOOK, '.novel', 'index.db');
    assert.ok(fs.existsSync(indexPath), `索引文件必须落盘在 ${path.relative(root, indexPath)}`);

    // ★ 核心断言：查询是**记忆碎片**「戴斗笠的人」，正文里的原文是「戴斗笠的身影」——
    //   字面不完全重合，靠二元切分才召得回（这正是 FTS5 默认分词器做不到的那件事）
    const r1 = await search.execute({ action: 'query', book: BOOK, q: '戴斗笠的人' }, exec);
    assert.ok(r1.hits.length >= 1, '记忆碎片必须能召回（这是 G1 的全部意义）');
    assert.equal(r1.hits[0].chapter, 1, '「戴斗笠的人」应指向码头夜会那章');
    assert.ok(r1.hits[0].hitRatio >= 0.75, `命中比例应较高，实际 ${r1.hits[0].hitRatio}`);
    assert.equal(r1.degraded, false);

    // 换一个碎片 → 指向第二章
    const r2 = await search.execute({ action: 'query', book: BOOK, q: '义庄空棺材' }, exec);
    assert.ok(r2.hits.some((h) => h.chapter === 2), '「义庄空棺材」应命中第二章');
    assert.ok(r2.hits[0].hitRatio > 0);

    // 没命中不抛错，且给出可操作的召回建议
    const r3 = await search.execute({ action: 'query', book: BOOK, q: '赛博朋克霓虹灯' }, exec);
    assert.equal(r3.hits.length, 0, '无关查询不该硬凑命中');
    assert.ok(r3.notes.some((n) => n.includes('min_hit')), '未命中要提示怎么调召回');

    // ★ 增量：内容没动 → 一块都不重写（指纹判等）
    const again = await search.execute({ action: 'build', book: BOOK }, exec);
    assert.equal(again.added, 0, '未改动的块不得重复入索引');
    assert.equal(again.updated, 0);
    assert.equal(again.chunks, built.chunks);

    // ★ 派生物可重建：直接删掉索引库，重跑 build 应得到一模一样的块数
    const { openIndex, indexStats } = await import('../lib/retrieval.js');
    const opened = await openIndex(indexPath);
    const before = indexStats(opened.db).chunks;
    opened.db.close();
    fs.rmSync(indexPath);
    const rebuilt = await search.execute({ action: 'build', book: BOOK }, exec);
    assert.equal(rebuilt.chunks, before, '索引删了重跑即得——它只是派生物，不是真相来源');

    // status 看得到索引概览
    const st = await search.execute({ action: 'status', book: BOOK }, exec);
    assert.equal(st.degraded, false);
    assert.equal(st.chapters, 2);
    assert.equal(st.chunks, before);
});

// ⚠️ 下面两条依赖前面用例累积的账本状态（「星海拾骨」第1章 城南义庄 → 第2章 城西），
//    所以必须留在文件末尾；在中间插用例会改掉它们的输入。

test('★ B2 账本时点推演：status_at 看「当时的值」，timeline 看演化线', async () => {
    const book = '星海拾骨';
    const at1 = await tool('novel_ledger').execute({ action: 'status_at', book, at: 1 }, exec);
    assert.deepEqual(at1.facts.map((f) => f.entity).sort(), ['布鞋', '林晚'], '第1章快照=当章为止落账的全部实体');
    assert.equal(at1.facts.find((f) => f.key === '位置').value, '城南义庄', '第1章时人在义庄');
    assert.deepEqual(at1.timeline, [], 'status_at 不回 timeline');

    const at2 = await tool('novel_ledger').execute({ action: 'status_at', book, at: 2, entity: '林晚' }, exec);
    assert.equal(at2.facts.length, 1, '实体过滤只留林晚');
    assert.equal(at2.facts[0].value, '城西', '第2章才换到城西');
    assert.equal(at2.facts[0].chapter, 2, '带出该值从哪一章起生效');

    // 核心区别：query 只给「最新值」。写第 80 章时要回溯第 1 章的状态，只有 status_at 做得到
    const q = await tool('novel_ledger').execute({ action: 'query', book, entity: '林晚' }, exec);
    assert.equal(q.facts.find((f) => f.key === '位置').value, '城西');
    assert.equal(at1.facts.find((f) => f.key === '位置').value, '城南义庄', '同一份账本，两个时点两个答案');

    const tl = await tool('novel_ledger').execute({ action: 'timeline', book, entity: '林晚' }, exec);
    assert.deepEqual(tl.timeline.map((r) => r.chapter), [1, 2], '演化线按章升序');
    assert.deepEqual(tl.timeline.map((r) => r.value), ['城南义庄', '城西']);
    assert.deepEqual(tl.facts, [], 'timeline 不回 facts');

    await assert.rejects(() => tool('novel_ledger').execute({ action: 'status_at', book, entity: '林晚' }, exec), /at/);
    await assert.rejects(() => tool('novel_ledger').execute({ action: 'timeline', book }, exec), /entity/);
});

test('★ B2 死后状态变更（账本级）：死亡后的新状态被一致性校验揪出', async () => {
    const book = '星海拾骨';
    await tool('novel_ledger').execute({ action: 'update', book, chapter: 1, updates: '陈九|状态|阵亡' }, exec);
    await tool('novel_ledger').execute({ action: 'update', book, chapter: 2, updates: '陈九|境界|金丹' }, exec);

    const aud = await tool('novel_audit').execute({ book, chapter: 1, continuity: true }, exec);
    const hit = aud.continuityResult.issues.find((i) => i.code === 'posthumous-change');
    assert.ok(hit, '死亡后账本又记新状态 → 必须报出（B1 的名字扫描抓不到这条）');
    assert.equal(hit.severity, 'warning', '可能是遗物/传闻/闪回，故 warning 而非 error');
    assert.ok(hit.where.includes('陈九'));

    // 只有死亡记录、没有任何后续状态变更 → 不误报
    await tool('novel_ledger').execute({ action: 'update', book, chapter: 2, updates: '沈砚|状态|阵亡' }, exec);
    const aud2 = await tool('novel_audit').execute({ book, chapter: 1, continuity: true }, exec);
    assert.ok(
        !aud2.continuityResult.issues.some((i) => i.code === 'posthumous-change' && i.where.includes('沈砚')),
        '同章死亡且无后续变更 → 不误报',
    );
});

test('★ G2 书库：导入饲料 → 拆结构 → 与本书并排 → 只移索引不删原文', async () => {
    const lib = tool('novel_library');
    const FEED = [
        '第一章 雪夜',
        '雪落了一夜。',
        '「你来了。」周砚说。',
        '「来了。」那人答。',
        '青铜古灯在案上跳了一下，火苗歪向门口，像在指路。',
        '',
        '第二章 铜灯',
        '青铜古灯又亮了一次，火苗这次没有歪。',
        '「灯里有东西。」周砚说。',
        '他没有说完。窗外忽然传来一声闷响——',
        '',
        '第三章 长夜',
        '青铜古灯熄了，屋子里只剩呼吸声。他数着自己的心跳，一颗，两颗，三颗。',
        '「谁。」他说。',
        '「我。」门外有人应。',
    ].join('\n');

    assert.deepEqual((await lib.execute({ action: 'list' }, exec)).entries, [], '书库初始为空');

    // 导入（text 通道）；原文必须真的落盘，否则 analyze 无从谈起
    const imported = await lib.execute({ action: 'import', title: '对标样本', text: FEED }, exec);
    assert.equal(imported.entries[0].chapters, 3);
    assert.ok(imported.entries[0].chars > 0);
    assert.equal(fs.existsSync(path.join(root, '书库', '对标样本', '原文.txt')), true);

    assert.deepEqual(
        (await lib.execute({ action: 'list' }, exec)).entries.map((e) => e.title),
        ['对标样本'],
    );
    await assert.rejects(
        () => lib.execute({ action: 'import', title: '对标样本', text: FEED }, exec),
        /已有/,
        '同名不得覆盖——饲料删错了没法找回，宁可让用户显式 delete',
    );

    // analyze：结构画像（零 token，纯本地）
    const an = await lib.execute({ action: 'analyze', id: '对标样本' }, exec);
    assert.equal(an.report.chapters, 3);
    assert.ok(an.report.dialogueRatio > 0, '有对白必须算出对话密度');
    assert.equal(an.report.hookRate, 0.333);
    assert.equal(an.report.topPhrases[0].term, '青铜古灯');
    assert.equal(an.compare, undefined, '没给 compare_book 就不出对比');
    assert.ok(an.note.includes('对标样本'));

    // 与本书并排：这才是「拆书」的用处——数字对着看
    const cmp = await lib.execute({ action: 'analyze', id: '对标样本', compare_book: '星海拾骨' }, exec);
    assert.equal(cmp.compare.length, 9);
    assert.ok(cmp.compare.some((r) => r.label === '章末钩子率'));
    assert.ok(cmp.compare.every((r) => typeof r.mine === 'string' && typeof r.theirs === 'string'));

    // read：分章概览
    const rd = await lib.execute({ action: 'read', id: '对标样本', from: 2, to: 3 }, exec);
    assert.deepEqual(rd.chapters.map((c) => c.n), [2, 3]);
    assert.ok(rd.chapters[0].excerpt.length <= 200);
    await assert.rejects(() => lib.execute({ action: 'read', id: '对标样本', from: 9 }, exec), /读不到/);
    await assert.rejects(() => lib.execute({ action: 'analyze', id: '不存在的书' }, exec), /书库里没有/);

    // delete：宿主 fs 无删除能力 → 只移索引，原文保留（返回里必须说清楚）
    const del = await lib.execute({ action: 'delete', id: '对标样本' }, exec);
    assert.deepEqual(del.entries, []);
    assert.ok(del.note.includes('手工删'), '必须告诉用户原文还在磁盘上');
    assert.equal(fs.existsSync(path.join(root, '书库', '对标样本', '原文.txt')), true, 'delete 不得删原文');
});

// ── 会话「孙宇」真机事故回归：novel_scene 恒 invalid output（13 次全军覆没）──
// 根因：normalizeContract 产出 updatedAt，output schema 没声明 → 宿主
// additionalProperties:false 直接拒收。schema 补字段 + 出口盖章双保险。

test('★ novel_scene 输出 schema 必须声明 updatedAt（contract 与 contracts[] 两处）', () => {
    const scene = tool('novel_scene');
    const contractProps = scene.output.schema.properties.contract.properties;
    assert.ok(contractProps.updatedAt !== undefined, 'contract 的 schema 缺 updatedAt');
    const itemProps = scene.output.schema.properties.contracts.items.properties;
    assert.ok(itemProps.updatedAt !== undefined, 'contracts[] 条目的 schema 缺 updatedAt');
});

test('★ 存量契约缺 updatedAt（旧版数据）：出口盖章成 string，不漏 null', async () => {
    const scene = tool('novel_scene');
    const cPath = path.join(root, '星海拾骨', '设定', '场景契约.json');
    assert.ok(fs.existsSync(cPath), '前置：B3 测试已落盘契约');
    const legacy = JSON.parse(fs.readFileSync(cPath, 'utf8'));
    delete legacy['2'].updatedAt;
    fs.writeFileSync(cPath, JSON.stringify(legacy));

    const got = await scene.execute({ action: 'get', book: '星海拾骨', chapter: 2 }, exec);
    assert.equal(typeof got.contract.updatedAt, 'string', 'get 出口 updatedAt 必须是 string');
    const listed = await scene.execute({ action: 'list', book: '星海拾骨' }, exec);
    for (const c of listed.contracts) assert.equal(typeof c.updatedAt, 'string', 'list 出口同样盖章');
});

// ── 全工具×全 action 输出契约护栏 ──────────────────────────────────────
// 背景（0.13.5 复盘）：scene 的 updatedAt、propose list 的 title/reason/preview、
// project set_stage 的 render 崩溃——三个同类事故全部落在「测试只调 execute、
// 不验 schema/render」的盲区里。本护栏把宿主**真校验器**（validateJsonSchemaValue，
// 与宿主拒收 INVALID_TOOL_OUTPUT 的同一套实现）铺到每个工具的每个 action 上：
// execute 成功返回 → 输出必须过 output.schema → output.render 必须不抛。
// 业务性抛错（缺前置数据等）记为 skip 不算失败——护栏拦的是「成功了但不合法」。

test('★ 全工具×全 action：真校验器验证输出 + render 冒烟', async () => {
    assert.equal(hasSdk, true, '缺宿主 SDK symlink：先 npm run setup-dev');
    const { validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools');

    const A = '输出契约自检书';
    await tool('novel_project').execute({ action: 'init', book: A, genre: '测试', logline: '护栏专用，用后即弃' }, exec);

    // [工具名, action, args]；顺序即状态构建顺序（先建内容，后跑读侧）
    const matrix = [
        ['novel_project', 'status', { action: 'status', book: A }],
        ['novel_project', 'phase', { action: 'phase', book: A }],
        ['novel_project', 'set_stage', { action: 'set_stage', book: A, stage: 'character' }],
        ['novel_project', 'repair', { action: 'repair', book: A }],
        ['novel_project', 'check', { action: 'check', book: A }],
        ['novel_project', 'promise', { action: 'promise', book: A }],
        ['novel_outline', 'save_book', { action: 'save_book', book: A, outline: '# 全书大纲\n自检用大纲' }],
        ['novel_outline', 'save_chapter', { action: 'save_chapter', book: A, chapter: 1, outline: '# 第1章细纲\n- 场景：自检场景' }],
        ['novel_outline', 'approve', { action: 'approve', book: A, chapter: 1 }],
        ['novel_character', 'save', { action: 'save', book: A, name: '测者甲', card: '外在底色：自检用人物卡' }],
        ['novel_character', 'list', { action: 'list', book: A }],
        ['novel_glossary', 'add', { action: 'add', book: A, term: '自检词', definition: '自检定义' }],
        ['novel_glossary', 'list', { action: 'list', book: A }],
        ['novel_glossary', 'remove', { action: 'remove', book: A, term: '自检词' }],
        ['novel_worldbook', 'add', { action: 'add', book: A, id: '自检设定', keywords: '自检', content: '自检世界书条目' }],
        ['novel_worldbook', 'list', { action: 'list', book: A }],
        ['novel_worldbook', 'update', { action: 'update', book: A, id: '自检设定', content: '自检世界书条目（更新）' }],
        ['novel_worldbook', 'export', { action: 'export', book: A }],
        ['novel_worldbook', 'remove', { action: 'remove', book: A, id: '自检设定' }],
        ['novel_scene', 'save', { action: 'save', book: A, chapter: 1, scene: '自检场景', participants: '测者甲' }],
        ['novel_scene', 'get', { action: 'get', book: A, chapter: 1 }],
        ['novel_scene', 'list', { action: 'list', book: A }],
        ['novel_ledger', 'update', { action: 'update', book: A, chapter: 1, updates: '测者甲|境界|练气一层' }],
        ['novel_ledger', 'query', { action: 'query', book: A, entity: '测者甲' }],
        ['novel_ledger', 'status_at', { action: 'status_at', book: A, at: 1 }],
        ['novel_ledger', 'timeline', { action: 'timeline', book: A, entity: '测者甲' }],
        ['novel_ledger', 'foreshadow_setup', { action: 'foreshadow_setup', book: A, chapter: 1, setup: '自检伏笔', plan: 2 }],
        ['novel_write_chapter', null, { book: A, chapter: 1, title: '自检第一章', content: GOOD_CHAPTER, cast: '测者甲', summary: '自检用一章' }],
        ['novel_style', 'build', { action: 'build', book: A }],
        ['novel_style', 'check', { action: 'check', book: A, chapter: 1 }],
        ['novel_search', 'build', { action: 'build', book: A }],
        ['novel_search', 'status', { action: 'status', book: A }],
        ['novel_search', 'query', { action: 'query', book: A, q: '自检' }],
        ['novel_library', 'import', { action: 'import', title: '自检饲料', text: '第一章 试\n\n正文内容。' }],
        ['novel_library', 'list', { action: 'list' }],
        ['novel_library', 'read', { action: 'read', title: '自检饲料' }],
        ['novel_library', 'analyze', { action: 'analyze', title: '自检饲料' }],
        ['novel_library', 'delete', { action: 'delete', title: '自检饲料' }],
        ['novel_import', 'preview', { action: 'preview', book: '自检导入书', title: '自检导入书', text: '第一章 试\n\n正文内容。' }],
        ['novel_audit', null, { book: A, chapter: 1 }],
        ['novel_briefing', null, { book: A, chapter: 1 }],
        ['novel_diagnose', null, { book: A }],
        ['novel_polish', 'analyze', { action: 'analyze', book: A, chapter: 1 }],
        ['novel_propose', 'propose', { action: 'propose', book: A, chapter: 1, content: GOOD_CHAPTER.replace('咳嗽', '咳嗽了两声'), reason: '自检提案' }],
        ['novel_propose', 'list', { action: 'list', book: A }],
        ['novel_export', null, { book: A, format: 'md' }],
    ];

    const validated = [], skipped = [];
    for (const [name, action, args] of matrix) {
        const t = tool(name);
        assert.ok(t.output?.schema, `${name} 缺 output.schema 声明`);
        let value;
        try {
            value = await t.execute(args, exec);
        } catch (error) {
            skipped.push(`${name}${action ? '.' + action : ''}（${String(error.message).slice(0, 60)}）`);
            continue;
        }
        const violations = validateJsonSchemaValue(t.output.schema, value);
        assert.deepEqual(violations, [], `${name}.${action ?? '(单路径)'} 输出违反自身 output.schema：${JSON.stringify(violations).slice(0, 300)}`);
        if (typeof t.output?.render === 'function') {
            // render 的返回契约是「宿主能吃的内容块」（字符串或结构化对象），
            // 护栏只保证不抛——S2（set_stage 读 undefined.length 崩）就死在这一步
            assert.doesNotThrow(() => t.output.render(args, value), `${name}.${action ?? '(单路径)'} render 抛错`);
        }
        validated.push(`${name}.${action ?? '*'}`);
    }
    // 护栏不能静默退化成全 skip：一旦大面积跳过说明夹具坏了，必须当场报出来
    assert.ok(validated.length >= 35, `覆盖塌方：只验证了 ${validated.length} 个 action（skip ${skipped.length}）——检查夹具状态`);
    assert.ok(!skipped.some((s) => s.startsWith('novel_propose.list')), `novel_propose list 不允许 skip——它是 S1 事故的当事 action`);
});

// ── P4a：落盘后的审计写失败不得拖垂整章 ────────────────────────────────

const AUDIT_CHAPTER = [
    '沈砚把族谱摊在长案上，指腹顺着墨迹一行行往下走。祠堂的灯芯爆了个火星，他也没抬头。',
    '',
    '「这一页不对。」他说。',
    '',
    '从曾祖到祖父，名讳、生卒、葬地，笔笔工整。独独第七行下面空出一线毛边，像被人撕走后又被草草粘回。',
    '',
    '守祠的老头提着灯笼进来，看见他手里的册子，脚步在门槛上停了一瞬。',
    '',
    '「少爷，天黑了。」老头把灯搁在案角，灯焰歪了歪，「族谱不是给您对账用的。」',
    '',
    '沈砚笑了一下，把册子合上，压在手掌底下。',
    '',
    '「那它是给谁用的？」',
    '',
    '老头没有答。他袖口沾着新泥，颜色不对——不是后山那种黄的，是河滩上发灰的青泥。',
    '',
    '他把灯芯拨亮，重新把册子从第一行走了一遍。墨色新旧不齐，第七行那处毛边的纤维还发白，撕走的时间不长，也许就在昨夜。',
    '',
    '沈砚盯着那点泥，忽然觉得第七行空出来的位置，正好能写下一个人的名字。',
].join('\n');

test('★ 落盘成功后的 saved 审计写失败：整章不得被报成失败（假阴性会诱导出重复版本）', async () => {
    const B = '审计断链书';
    await tool('novel_project').execute({ action: 'init', book: B, title: B, genre: '悬疑', logline: '族谱少了一行' }, exec);
    await tool('novel_outline').execute({
        action: 'save_chapter', book: B, chapter: 1,
        outline: '第1章：祠堂对账。出场：沈砚。事件：族谱第七行被撕走（伏笔：河滩青泥）。',
    }, exec);
    await tool('novel_outline').execute({ action: 'approve', book: B, chapter: 1 }, exec);

    // 只拦最后一行是 write_chapter/saved 的那一次追加 —— 前面的门禁/账本审计照常落盘
    const realWrite = ctx.fs.writeText.bind(ctx.fs);
    let tripped = 0;
    ctx.fs.writeText = async (target, content, intent) => {
        const lastLine = String(content).trimEnd().split('\n').pop() ?? '';
        if (String(target?.targetKey ?? '').endsWith('audit.jsonl') && lastLine.includes('write_chapter/saved')) {
            tripped += 1;
            const error = new Error('FS_STALE_VERSION: 审计并发冲突（测试注入）');
            error.code = 'FS_STALE_VERSION';
            throw error;
        }
        return realWrite(target, content, intent);
    };
    const warns = [];
    const realWarn = console.warn;
    console.warn = (...args) => { warns.push(args.join(' ')); };
    try {
        const r = await tool('novel_write_chapter').execute({
            book: B, chapter: 1, title: '祠堂对账', content: AUDIT_CHAPTER,
            summary: '沈砚在祠堂发现族谱第七行被撕走，守祠人袖口有河滩青泥。', cast: '沈砚',
        }, exec);
        assert.ok(tripped >= 1, '前置：这一章必须真的撞上 saved 审计写失败');
        assert.equal(r.version, 1,
            '★ 正文/账本/索引都已成功落盘 → 必须返回成功。抛错会让调用方（含批量起草）把已保存的章当失败重试，造出重复版本');
        assert.ok(fs.existsSync(path.join(root, B, '正文', '第1章-祠堂对账-v1.md')), '章节文件必须在盘上');
        assert.ok(warns.some((w) => /审计/.test(w)), '★ 静默降级不等于静默：必须留下可见警告');
    } finally {
        console.warn = realWarn;
        ctx.fs.writeText = realWrite;
    }
});

test('★ 面板 REST 存章不带 summary：novel_project status/repair 不得因 undefined 炸 lossless JSON（真机 0.13.7 复现）', async () => {
    const B = '面板存章书';
    await tool('novel_project').execute({ action: 'init', book: B, title: B, genre: '悬疑' }, exec);
    // 直接落一个「REST 形状」的章记录：面板 POST /chapters/:no 走 chapterRecord 旧版
    // 原样存 summary=undefined，JSON.stringify 落盘后 summary 键整个消失——这就是
    // 面板存过章的盘面状态，novel_project status/repair 一调即 value is not lossless JSON
    fs.mkdirSync(path.join(root, B, '正文'), { recursive: true });
    fs.writeFileSync(path.join(root, B, '正文', '第1章-第一章-v1.md'), '夜色压城，巡夜人把灯笼拧亮了一格。\n\n城门下的影子长了一寸。\n');
    const metaPath = path.join(root, B, 'novel.json');
    const novel = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    novel.chapters = { '1': {
        title: '第一章', versions: [1], files: [{ version: 1, file: `${B}/正文/第1章-第一章-v1.md` }],
        latest: 1, path: `${B}/正文/第1章-第一章-v1.md`, chars: 25, updatedAt: 't',
    } };
    fs.writeFileSync(metaPath, `${JSON.stringify(novel, null, 2)}\n`);
    // 孤儿：盘上有、索引没引用（repair 的发现通道一并验）
    fs.writeFileSync(path.join(root, B, '正文', '第1章-第一章-v9.md'), '重放失败残留。\n');

    const status = await tool('novel_project').execute({ action: 'status', book: B }, exec);
    assert.equal(status.chapters[0].summary, '',
        '★ 输出 summary 必须是字符串——undefined 会让宿主 lossless JSON 拒收整次调用');
    const repair = await tool('novel_project').execute({ action: 'repair', book: B }, exec);
    assert.equal(repair.chapters[0].summary, '', 'repair 同罪同修');
    assert.deepEqual(repair.orphanFiles, ['第1章-第一章-v9.md'], '★ 孤儿通道：盘上有、索引没引用的正文 md 必须列出来');
    assert.ok(fs.existsSync(path.join(root, B, '正文', '第1章-第一章-v9.md')), 'repair 仅报告不删除');
    // 修过的 chapterRecord：REST 再存一版（不传 summary）不得抹掉工具写下的旧 summary
    const { chapterRecord } = await import('../lib/store.js');
    const rec = chapterRecord({ summary: '工具写的梗概' }, { title: '第一章', version: 2, file: `${B}/正文/第1章-第一章-v2.md`, chars: 30 });
    assert.equal(rec.summary, '工具写的梗概', '★ REST 路径不得把旧 summary 冲掉');
    assert.equal(chapterRecord(null, { title: 'x', version: 1, file: 'f', chars: 1 }).summary, '', '全新记录缺省补空串');
});

test('★ repair 的孤儿扫描必须在对账之后：被整条移除的记录留下的正文要报出来', async () => {
    const B = 'path-only 书';
    await tool('novel_project').execute({ action: 'init', book: B, title: B, genre: '悬疑' }, exec);
    fs.mkdirSync(path.join(root, B, '正文'), { recursive: true });
    // 手工把索引改坏成「只有 path、没有 files」——repair 存在的整个前提就是盘被人工动过
    const file = `${B}/正文/第2章-断章-v1.md`;
    fs.writeFileSync(path.join(root, B, '正文', '第2章-断章-v1.md'), '这一章只剩 path 指着它。\n');
    const metaPath = path.join(root, B, 'novel.json');
    const novel = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    novel.chapters = { 2: { title: '断章', latest: 1, path: file, chars: 8, summary: '' } };
    fs.writeFileSync(metaPath, `${JSON.stringify(novel, null, 2)}\n`);

    const repair = await tool('novel_project').execute({ action: 'repair', book: B }, exec);
    assert.equal(repair.chapters.length, 0, 'files 全空的记录按对账规则被移除');
    assert.deepEqual(repair.orphanFiles, ['第2章-断章-v1.md'],
        '★ 扫描跑在对账前面时，这条记录当时还"引用"着该文件 → 漏报；顺序反过来才报得出来');
});

test('★ 孤儿清单：数组给全量，next 只列前 20 且不教用户 rm', async () => {
    const B = '孤儿成灾书';
    await tool('novel_project').execute({ action: 'init', book: B, title: B, genre: '悬疑' }, exec);
    fs.mkdirSync(path.join(root, B, '正文'), { recursive: true });
    for (let i = 1; i <= 25; i += 1) {
        fs.writeFileSync(path.join(root, B, '正文', `第${i}章-残留-v1.md`), '重放失败留下的版本稿。\n');
    }
    const repair = await tool('novel_project').execute({ action: 'repair', book: B }, exec);
    assert.equal(repair.orphanFiles.length, 25, 'orphanFiles 必须给全量（面板/调用方要能数得清）');
    assert.match(repair.next, /发现 25 个/, '文案先给总数');
    assert.match(repair.next, /另有 5 个/, '★ 只列前 20 个，其余折成计数——长书残留上百个时整份塞进返回值既烧 token 也没法读');
    assert.ok(!/\brm\b/.test(repair.next), '★ 本插件对用户文件只报告不删除，文案不得出现 rm 这种删除命令');
    assert.match(repair.next, /回收站|不删除/, '给的是"确认可弃后交给回收站"这类指引');
});
