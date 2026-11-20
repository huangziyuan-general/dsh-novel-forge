// test/ledger-extract.test.mjs — P2 强方案：批量起草后的账本自动抽取（lib/ledger-extract.js）。
//
// 覆盖面：
//   · parseLedgerExtract（纯函数）：行形状 / 无原句拒收 / 封顶
//   · groundLedgerRows（纯函数）：证据双校验（值⊂原句 且 原句⊂正文），幻觉行整行拒收
//   · extractAndLandFacts（io 编排）：成功落 pending 行 / 引擎不可用 / 证据全拒
//   · reconcileLedgerDebt（债对账）：成功换 ledger-pending / 无状态变化清债 / 失败保留 / 幂等
//   · fireLedgerExtract：按书串行链（N 章连续触发不漏章、不并发打限流）

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    LEDGER_EXTRACT_SYSTEM, buildLedgerExtractPrompt,
    parseLedgerExtract, groundLedgerRows,
    extractAndLandFacts, reconcileLedgerDebt, fireLedgerExtract, pendingLedgerExtract,
} from '../lib/ledger-extract.js';
import { pathsFor } from '../lib/store.js';
import { debtLevelOf, makeDebt } from '../lib/quality-debt.js';

// ── 最小假 io（与 batch5.memIo 同口径：版本来自读的那一刻，写时不符即冲突）────────
function memIo(initial = {}) {
    const files = new Map(Object.entries(initial));
    const api = {
        cwd: '/mem',
        files,
        async stat(p) {
            return files.has(p) ? { target: p, info: { type: 'file', version: String(files.get(p)).length } } : null;
        },
        async abs(p) { return `/mem/${p}`; },
        async readText(p) { return files.has(p) ? files.get(p) : null; },
        async readJson(p) {
            const t = await api.readText(p);
            return t === null ? null : JSON.parse(t);
        },
        async writeText(p, text, mode) {
            if (mode === 'create' && files.has(p)) {
                const error = new Error(`FS_NOT_OBSERVED: ${p} 已存在`);
                error.code = 'FS_NOT_OBSERVED';
                throw error;
            }
            files.set(p, text);
            return { version: String(text).length };
        },
        async writeJson(p, value) { return api.writeText(p, `${JSON.stringify(value, null, 2)}\n`); },
        async readTextWithVersion(p) {
            return files.has(p) ? { text: files.get(p), version: String(files.get(p)).length }
                : { text: null, version: null };
        },
        async readJsonWithVersion(p) {
            const { text, version } = await api.readTextWithVersion(p);
            return { value: text === null ? null : JSON.parse(text), version };
        },
        async writeTextAtVersion(p, text, version) {
            if (version === null || version === undefined) return api.writeText(p, text, 'create');
            if (!files.has(p) || String(files.get(p)).length !== version) {
                const error = new Error(`FS_STALE_VERSION: ${p}`);
                error.code = 'FS_STALE_VERSION';
                throw error;
            }
            files.set(p, text);
            return { version: String(text).length };
        },
        async writeJsonAtVersion(p, value, version) {
            return api.writeTextAtVersion(p, `${JSON.stringify(value, null, 2)}\n`, version);
        },
        async appendLine(p, line) { return api.writeText(p, `${files.get(p) ?? ''}${line}\n`); },
        async listNames() { return []; },
    };
    return api;
}

/** 假引擎：按通道回预设文本。isAvailable 可开关。 */
function fakeEngine(byChannel = {}, { available = true } = {}) {
    const calls = [];
    return {
        calls,
        isAvailable: () => available,
        async run(channel, { prompt }) {
            calls.push(channel);
            const preset = byChannel[channel];
            if (preset === undefined || preset?.ok === false) {
                return { ok: false, attempts: 1, route: { provider: 'p', model: 'm' }, text: '', error: preset?.error ?? { code: 'ENGINE_FAILURE', message: '假引擎默认失败' } };
            }
            return { ok: true, attempts: 1, route: { provider: 'p', model: 'm' }, text: preset?.text ?? '' };
        },
    };
}

const BOOK = '账本抽取书';
const P = pathsFor(BOOK);
// 正文里「确实发生」的状态变化（原句必须逐字出自正文）
const CHAPTER = '沈诀把最后一枚铜钱推过桌面。他已彻底解决旧案，境界升至筑基三层，刀换成了新打的寒铁。';

// ── parseLedgerExtract ─────────────────────────────────────────────────────

test('parseLedgerExtract：四段行正常解析，原句含竖线整段归原句', () => {
    const raw = '主角|境界|筑基三层|境界升至筑基三层\n老陈|持有|寒铁刀|刀换成了新打的寒铁\n坏行\n甲|乙|丙';
    const { rows, dropped } = parseLedgerExtract(raw, { maxLines: 8 });
    assert.deepEqual(rows, [
        { entity: '主角', key: '境界', value: '筑基三层', evidence: '境界升至筑基三层' },
        { entity: '老陈', key: '持有', value: '寒铁刀', evidence: '刀换成了新打的寒铁' },
    ], '缺段的行（坏行 / 甲|乙|丙）整行丢弃，不抛');
    assert.equal(dropped, 0);
});

test('★ parseLedgerExtract 封顶：超过 maxLines 的行不收（防灌爆账本）', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `实体${i}|键${i}|值${i}|正文原句${i}`).join('\n');
    const { rows, dropped } = parseLedgerExtract(lines, { maxLines: 8 });
    assert.equal(rows.length, 8, '只收前 8 行');
    assert.equal(dropped, 2, '多出的 2 行被封顶丢弃');
});

test('parseLedgerExtract：无原句/空值/空行一律拒收', () => {
    const { rows } = parseLedgerExtract('甲|键|\n乙|键|值\n丙|键|值|原句\n\n', { maxLines: 8 });
    assert.deepEqual(rows, [{ entity: '丙', key: '键', value: '值', evidence: '原句' }]);
});

// ── groundLedgerRows（证据双校验）──────────────────────────────────────────

test('★ groundLedgerRows：值⊂原句 且 原句⊂正文 才落账（status 恒为 pending）', () => {
    const rows = [{ entity: '沈诀', key: '境界', value: '筑基三层', evidence: '境界升至筑基三层' }];
    const { landable, rejected } = groundLedgerRows(rows, CHAPTER);
    assert.equal(rejected.length, 0);
    assert.equal(landable.length, 1);
    assert.equal(landable[0].status, 'pending', '落账一律 pending——不进内容门禁硬判');
    assert.equal(landable[0].evidence, '境界升至筑基三层');
});

test('★ groundLedgerRows：幻觉行全拒——值不在原句 / 原句不在正文 / 太短', () => {
    const rows = [
        // 值「金丹一层」不在原句里（原句只有筑基三层）——模型编了个正文没写的值
        { entity: '沈诀', key: '境界', value: '金丹一层', evidence: '境界升至筑基三层' },
        // 原句在正文里逐字找不到（正文没有这句话）——转述/补全
        { entity: '沈诀', key: '持有', value: '寒铁', evidence: '他握着一把寒铁刀' },
    ];
    const { landable, rejected } = groundLedgerRows(rows, CHAPTER);
    assert.equal(landable.length, 0, '证据不足一行都不落（不伪造落账）');
    assert.equal(rejected.length, 2);
    assert.match(rejected[0].reason, /不在原句/);
    assert.match(rejected[1].reason, /逐字|找不到/, '原句不在正文 → 走 validateFactEvidence 同一文案');
});

test('groundLedgerRows：忽略空白差异（原句跨空格仍在）', () => {
    const body = '他 把 刀 换 成了 新 打的 寒 铁 。';
    const { landable } = groundLedgerRows(
        [{ entity: '他', key: '持有', value: '寒铁', evidence: '把刀换成了新打的寒铁' }],
        body,
    );
    assert.equal(landable.length, 1, '去空白后原句是正文子串 → 通过');
});

// ── 同章同键改值冲突：显形不覆盖 ─────────────────────────────────────────

test('★ extractAndLandFacts：账本已有同章同键不同值 → 冲突行不落、显形不覆盖（applyFactUpdates 纪律）', async () => {
    // 既有行：沈诀|境界|筑基（第12章，confirmed）；抽出的行：沈诀|境界|筑基三层——
    // 同章同键不同值。证据「境界升至筑基三层」逐字在 CHAPTER 里、值也在原句里（双校验过），
    // 但落账时撞上 applyFactUpdates 的同章改值冲突 → 不落、显形。
    const io = memIo({
        [P.meta]: JSON.stringify({ title: BOOK, chapters: {}, cast: [] }),
        [P.facts]: JSON.stringify([{ entity: '沈诀', key: '境界', value: '筑基', chapter: 12, status: 'confirmed' }]),
    });
    const engine = fakeEngine({
        ledger: { text: '沈诀|境界|筑基三层|境界升至筑基三层' },
    });
    const out = await extractAndLandFacts({ io, p: P, book: BOOK, chapter: 12, content: CHAPTER, engine });
    assert.equal(out.ok, true);
    assert.equal(out.landed, 0, '冲突行没落');
    assert.equal(out.conflicts, 1, '★ 冲突显形（reason 点名，不假装落进去了）');
    assert.match(out.reason, /同章冲突/);
    const facts = JSON.parse(io.files.get(P.facts));
    assert.equal(facts.length, 1, '既有行未被覆盖（同章改值=拒绝，账本冲突纪律）');
    assert.equal(facts[0].value, '筑基');
});

// ── extractAndLandFacts（io 编排 + 假引擎）────────────────────────────────

test('★ extractAndLandFacts：成功路径——pending 行经 updateJson 落进 p.facts（新书记从零起步）', async () => {
    const io = memIo({ [P.meta]: JSON.stringify({ title: BOOK, chapters: {}, cast: [] }) });
    const engine = fakeEngine({ ledger: { text: '沈诀|境界|筑基三层|境界升至筑基三层' } });
    const out = await extractAndLandFacts({ io, p: P, book: BOOK, chapter: 12, content: CHAPTER, engine });
    assert.equal(out.ok, true);
    assert.equal(out.landed, 1);
    const facts = io.files.get(P.facts);
    assert.ok(facts !== undefined, 'facts.json 已落盘');
    const parsed = JSON.parse(facts);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].status, 'pending');
    assert.equal(parsed[0].chapter, 12);
    assert.equal(parsed[0].entity, '沈诀');
    assert.equal(parsed[0].evidence, '境界升至筑基三层');
    assert.deepEqual(engine.calls, ['ledger']);
});

test('★ extractAndLandFacts：幂等——重跑同章同批不写重（applyFactUpdates 同值同章跳过）', async () => {
    const io = memIo({ [P.meta]: JSON.stringify({ title: BOOK, chapters: {}, cast: [] }) });
    const engine = fakeEngine({ ledger: { text: '沈诀|境界|筑基三层|境界升至筑基三层' } });
    await extractAndLandFacts({ io, p: P, book: BOOK, chapter: 12, content: CHAPTER, engine });
    const out2 = await extractAndLandFacts({ io, p: P, book: BOOK, chapter: 12, content: CHAPTER, engine });
    assert.equal(out2.landed, 0, '同值同章第二次是幂等跳过（不加新行）');
    assert.equal(JSON.parse(io.files.get(P.facts)).length, 1, '盘上仍只有一行');
});

test('extractAndLedgerFacts：引擎不可用 → 干净降级（MCP 独立模式静默跳过，不伪造）', async () => {
    const io = memIo({ [P.meta]: JSON.stringify({ title: BOOK }) });
    const out = await extractAndLandFacts({ io, p: P, book: BOOK, chapter: 12, content: CHAPTER, engine: fakeEngine({}, { available: false }) });
    assert.equal(out.ok, false);
    assert.match(out.reason, /引擎不可用/);
    assert.equal(io.files.has(P.facts), false, '没往 facts 写任何东西');
});

test('extractAndLandFacts：调用失败 / 证据全拒 / 正文无状态变化 三条分支', async () => {
    const io = memIo({ [P.meta]: JSON.stringify({ title: BOOK }) });
    // ① 引擎调用失败
    let out = await extractAndLandFacts({ io, p: P, book: BOOK, chapter: 12, content: CHAPTER, engine: fakeEngine({ ledger: { ok: false, error: { code: 'ENGINE_FAILURE', message: 'x' } } }) });
    assert.equal(out.ok, false);
    assert.match(out.reason, /调用失败/);
    // ② 抽出的行证据全部不足
    out = await extractAndLandFacts({ io, p: P, book: BOOK, chapter: 12, content: CHAPTER, engine: fakeEngine({ ledger: { text: '沈诀|境界|金丹一层|境界升至筑基三层' } }) });
    assert.equal(out.ok, false, '证据不足 = 盲区仍在（调用方保留 major 债）');
    assert.equal(out.rejected.length, 1);
    // ③ 模型一行都没抽（本章没有状态变化）→ 合法空结果，盲区关闭
    out = await extractAndLandFacts({ io, p: P, book: BOOK, chapter: 12, content: CHAPTER, engine: fakeEngine({ ledger: { text: '' } }) });
    assert.equal(out.ok, true);
    assert.equal(out.landed, 0);
    assert.equal(io.files.has(P.facts), false, '没状态变化就不建 facts.json');
});

// ── reconcileLedgerDebt（债对账）──────────────────────────────────────────

function novelWithBatchDebt() {
    const novel = {
        title: BOOK, chapters: { 12: { title: 'x', latest: 1 } }, cast: [],
        quality: { debts: { 12: [makeDebt({ code: 'batch-no-ledger', message: 'm', chapter: 12, ts: 't' })] } },
    };
    return JSON.stringify(novel);
}

test('★ reconcileLedgerDebt：抽取成功落账 → batch-no-ledger major 换成 ledger-pending minor', async () => {
    const io = memIo({ [P.meta]: novelWithBatchDebt() });
    const r = await reconcileLedgerDebt({ io, p: P, book: BOOK, chapter: 12, outcome: { ok: true, landed: 2 } });
    assert.equal(r.swapped, true);
    const debts = JSON.parse(io.files.get(P.meta)).quality.debts['12'];
    assert.equal(debts.length, 1, '旧债被替换不是追加');
    assert.equal(debts[0].code, 'ledger-pending');
    assert.equal(debtLevelOf(debts[0].code), 'minor');
    assert.match(debts[0].message, /2 行/, '换上的债要带落账行数（人话可见）');
});

test('★ reconcileLedgerDebt：确认无状态变化（landed=0）→ 清掉 batch-no-ledger 债', async () => {
    const io = memIo({ [P.meta]: novelWithBatchDebt() });
    await reconcileLedgerDebt({ io, p: P, book: BOOK, chapter: 12, outcome: { ok: true, landed: 0 } });
    const debts = JSON.parse(io.files.get(P.meta)).quality.debts['12'];
    assert.deepEqual(debts, [], '盲区确认可关闭 → 本章无债');
});

test('★ reconcileLedgerDebt：抽取失败 → major 债原样保留（盲区仍开）', async () => {
    const io = memIo({ [P.meta]: novelWithBatchDebt() });
    const r = await reconcileLedgerDebt({ io, p: P, book: BOOK, chapter: 12, outcome: { ok: false, landed: 0, reason: 'x' } });
    assert.equal(r.swapped, false);
    const debts = JSON.parse(io.files.get(P.meta)).quality.debts['12'];
    assert.equal(debts.length, 1);
    assert.equal(debts[0].code, 'batch-no-ledger', '失败不改债——major 继续可见');
});

test('★ reconcileLedgerDebt：同章其它债保留；无 batch-no-ledger 可换则幂等不动盘', async () => {
    // ① 同章有 hard 债 → 换债时它必须原样存活
    const io1 = memIo({ [P.meta]: JSON.stringify({
        title: BOOK, chapters: {}, cast: [],
        quality: { debts: { 12: [
            makeDebt({ code: 'batch-no-ledger', message: 'm', chapter: 12, ts: 't' }),
            makeDebt({ code: 'content-gate-forced', message: 'h', chapter: 12, ts: 't' }),
        ] } },
    }) });
    await reconcileLedgerDebt({ io: io1, p: P, book: BOOK, chapter: 12, outcome: { ok: true, landed: 1 } });
    const debts1 = JSON.parse(io1.files.get(P.meta)).quality.debts['12'].map((d) => d.code);
    assert.deepEqual(debts1.sort(), ['content-gate-forced', 'ledger-pending'], 'hard 债不许被换债抹掉');
    // ② 没有 batch-no-ledger（P2-lite 未记 / 已换过）→ 不动盘（幂等）
    const io2 = memIo({ [P.meta]: JSON.stringify({ title: BOOK, chapters: {}, cast: [], quality: { debts: {} } }) });
    const before = io2.files.get(P.meta);
    const r = await reconcileLedgerDebt({ io: io2, p: P, book: BOOK, chapter: 12, outcome: { ok: true, landed: 1 } });
    assert.equal(r.swapped, false);
    assert.equal(io2.files.get(P.meta), before, '无债可换不重写 novel.json（不放大并发写面）');
});

// ── fireLedgerExtract（按书串行链）────────────────────────────────────────

test('★ fireLedgerExtract：同书连续触发串行排队（N 章不漏、不并发）', async () => {
    const io = memIo({ [P.meta]: novelWithBatchDebt() });
    const order = [];
    const engine = {
        isAvailable: () => true,
        calls: [],
        async run(channel, { prompt }) {
            this.calls.push(channel);
            order.push('start');
            // 制造在飞窗口：若链没有串行，第二个 fire 会在第一个跑完前就起
            await new Promise((r) => setTimeout(r, 10));
            order.push('end');
            return { ok: true, attempts: 1, route: null, text: '沈诀|境界|筑基三层|境界升至筑基三层' };
        },
    };
    const p1 = fireLedgerExtract({ io, p: P, book: BOOK, chapter: 12, content: CHAPTER, engine });
    const p2 = fireLedgerExtract({ io, p: P, book: BOOK, chapter: 13, content: CHAPTER, engine });
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    assert.equal(order.filter((x) => x === 'start').length, 2, '两章都抽了（按书串行链不漏章——in-flight 跳过会漏第 13 章）');
    assert.equal(order.join(','), 'start,end,start,end', '★ 串行执行（第二个在第一个 end 后才 start）');
    assert.equal(engine.calls.length, 2);
});

test('fireLedgerExtract：裸 rejection 兜底——链尾 catch 不飞（宿主 fatal 防护）', async () => {
    const io = memIo({ [P.meta]: novelWithBatchDebt() });
    // 引擎 run 直接 reject（模拟底层炸了）——step 内部必须吞掉，不许飞成 unhandledRejection
    const engine = {
        isAvailable: () => true,
        async run() { throw new Error('底层炸了'); },
    };
    const r = await fireLedgerExtract({ io, p: P, book: BOOK, chapter: 12, content: CHAPTER, engine });
    assert.equal(r.ok, false, 'step 内部吞错，链上返回失败结果而不是 reject');
    assert.match(r.reason, /底层炸了/);
    // 审计留痕（ledger/extract 行写进 audit.jsonl）——失败也可见
    assert.match(io.files.get(P.audit) ?? '', /ledger\/extract/);
    // 链尾 promise 留在表里（下一轮 fire 排在这条之后）——没有的是 null
    assert.ok(pendingLedgerExtract(BOOK) instanceof Promise, '本书的抽取链尾仍在表里（幂等可查、不并起第二条链）');
});

// ── 通道注册同步（与 semantic-search 的 expand 同步钉同款）────────────────

test('ledger 通道注册：CHANNEL_NAMES/DEFAULTS/LABELS 同步', async () => {
    const core = await import('../lib/engine-core.js');
    assert.ok(core.CHANNEL_NAMES.includes('ledger'), 'CHANNEL_NAMES 缺 ledger');
    assert.deepEqual(core.CHANNEL_DEFAULTS.ledger, { maxTokens: 512, timeoutMs: 120000 }, '短输出短任务预算');
    assert.match(core.CHANNEL_LABELS.ledger, /账本抽取/);
});

test('★ 提示词纪律：ledger 通道系统提示禁止围栏/解释（与 extractChapterText 红线不互斥）', () => {
    assert.match(LEDGER_EXTRACT_SYSTEM, /不要.*Markdown/);
    assert.match(LEDGER_EXTRACT_SYSTEM, /最多输出 8 行/);
    assert.match(buildLedgerExtractPrompt('正文'), /^本章正文：\n正文\n/);
});
