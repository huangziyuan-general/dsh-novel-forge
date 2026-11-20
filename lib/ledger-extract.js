// lib/ledger-extract.js — 批量起草后的账本自动抽取（ledgerExtract.enabled 强方案）。
//
// 批量提交走 commitChapter 时传 updates:[]（模型声明通道只在单章写章链上），本章状态变化
// 不进事实账本。本模块在每章落盘后异步补一道账本行抽取：
//   · 独立 ledger 通道小调用（不与正文生成同调用——正文协议禁 Markdown 围栏、
//     extractChapterText 取最长围栏当正文，两条红线互斥）；
//   · 抽出的行一律 status=pending（不进内容门禁硬判：unknown-fact-filled 只认 unknown；
//     pending 行简报显示「待复核」，novel_ledger 可见可改 confirmed）；
//   · 证据双校验：值 ⊂ 原句、原句逐字（忽略空白）⊂ 本章正文（复用 ledger.validateFactEvidence）；
//     证据不足整行拒收；行数封顶 maxLines（默认 8），超限不收；
//   · 抽取用生成原文（d.content），不用落盘规范化文——normalizeQuotes 的引号改写会让
//     逐字证据校验整批失败；
//   · 在 commitChapter 成功落盘**之后**异步跑（fire-and-forget，不阻塞成稿、不进
//     checkpoint、不碰提交链）：抽取往 facts.json 写行，若在提交前跑、提交被驳回，
//     会留下指向未落盘章的孤儿行；
//   · 债对账（reconcileLedgerDebt）：成功落账把本章 batch-no-ledger major 债换成
//     ledger-pending minor；确认无状态变化（0 行）清债；失败保留 major 债并写审计。
//     只动 batch-no-ledger 这一条，同章其它债原样保留；updateJson 版本重放，幂等。
//   · 默认关：enabled=false 不进本模块（零模型成本，只有 batch-no-ledger 债）。
//
// 纯函数（system/prompt/parse/ground）与 io 编排（extractAndLandFacts）分离。

import { updateJson } from './fsio.js';
import { applyFactUpdates, validateFactEvidence } from './ledger.js';
import { makeDebt } from './quality-debt.js';
import { audit } from './tools/common.js';

/** 账本抽取系统提示（纯函数）。只出账本行，不要句子。 */
export const LEDGER_EXTRACT_SYSTEM = [
    '你是小说事实账本的抽取员。读一章正文，把正文里**确实发生**的、影响后续章节的状态变化，抽成账本行。',
    '硬要求：',
    '1. 每行格式：实体|键|值|正文原句。竖线分隔，前 3 段（实体/键/值）必填，第 4 段起是原句（原句里若含竖线，整段归原句，不再切分）；',
    '2. 「正文原句」必须**逐字摘自本章正文**（可忽略首尾空格，不许改写、缩写、转述、补全）——抽不出原句就不写这一行；',
    '3. 值要能落成「某实体在某章变成某状态」的一句陈述（如「主角|境界|筑基三层」），且值本身必须出现在原句里；',
    '4. 只抽「世界是什么样」的状态（境界/位置/持有/关系/生死等），不抽「谁知道了什么」（那是认知账本）；',
    '5. 最多输出 8 行；正文里没有状态变化就一行都不写（只输出空，不要解释、不要 Markdown）。',
].join('\n');

/**
 * 账本抽取提示词（纯函数）。
 * @param content 本章生成原文（d.content，不是落盘后的规范化文本——见模块头取舍）
 */
export function buildLedgerExtractPrompt(content) {
    return `本章正文：\n${String(content ?? '')}\n\n请抽出正文里确实发生的状态变化（账本行，实体|键|值|正文原句），没有就只输出空。`;
}

/**
 * 解析模型输出的账本行（纯函数）。
 *
 * 行格式：`实体|键|值|正文原句`。前 3 段必填、第 4 段（原句）之后不再切（原句可含竖线，
 * 与 parseFactEvidence 同口径）。任一段为空 → 整行丢弃（容忍模型输出，不抛）。
 *
 * @param raw      模型原始输出
 * @param maxLines 行数封顶（超过的整行不收——防一次性灌爆账本）
 * @returns {rows, dropped}  rows=通过形状校验的行；dropped=被封顶丢弃的行数
 */
export function parseLedgerExtract(raw, { maxLines = 8 } = {}) {
    const lines = String(raw ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
    const rows = [];
    for (const line of lines) {
        const parts = line.split('|').map((x) => x.trim());
        if (parts.length < 4) continue; // 少于 4 段：没有原句，证据不成立，整行拒收
        const [entity, key, value, ...rest] = parts;
        const evidence = rest.join('|').trim();
        if (entity === '' || key === '' || value === '' || evidence === '') continue;
        rows.push({ entity, key, value, evidence });
        if (rows.length >= maxLines) break;
    }
    const dropped = lines.length > maxLines ? lines.length - maxLines : 0;
    return { rows, dropped };
}

/**
 * 证据双校验 + 落账行构造（纯函数，零 io）。
 *
 * 原句判定复用 ledger.validateFactEvidence（忽略空白逐字 ⊂ 正文，单一实现）。
 * 额外要求：**值必须逐字出现在原句里**（忽略空白）——值不在原句中的行整行拒收。
 *
 * @param rows    parseLedgerExtract 的产物
 * @param content 本章正文（唯一事实来源，d.content 生成原文）
 * @returns {landable, rejected}  landable=[{entity,key,value,status:'pending',evidence}]（证据全通过）；
 *   rejected=[{entity,key,reason}]（证据不足，不伪造落账）
 */
export function groundLedgerRows(rows, content) {
    const landable = [];
    const rejected = [];
    for (const r of rows ?? []) {
        if (r === null || typeof r !== 'object') continue;
        const { entity, key, value, evidence } = r;
        const normVal = String(value ?? '').replace(/\s+/g, '');
        const normEv = String(evidence ?? '').replace(/\s+/g, '');
        if (normVal === '') { rejected.push({ entity, key, reason: '值为空' }); continue; }
        if (!normEv.includes(normVal)) {
            rejected.push({ entity, key, reason: `值「${value}」不在原句里（原句：${String(evidence).slice(0, 40)}…）——正文没写这个值，不能落账` });
            continue;
        }
        // 原句必须逐字（忽略空白）在正文里——走 validateFactEvidence 同一算式
        const violations = validateFactEvidence(
            [{ entity, key, value }],
            [{ entity, key, evidence }],
            content,
        );
        if (violations.length > 0) {
            rejected.push({ entity, key, reason: violations[0].reason });
            continue;
        }
        landable.push({ entity, key, value, status: 'pending', evidence });
    }
    return { landable, rejected };
}

/**
 * 跑一次账本抽取 + 落账（io 编排层，由 batch-draft.js 在**提交成功后** fire-and-forget 调用）。
 *
 * 成功：landable 行经 updateJson 版本重放合入 p.facts（与写章链同一目标文件，
 * 乐观并发重放不与面板/REST 的并发写撞车）。返回 {ok:true, landed>0}。
 * 无状态变化（模型一行都没抽）：{ok:true, landed:0}——合法的「本章没有要记的」，非失败。
 * 失败（引擎不可用 / 调用失败 / 证据全部不足 / 写盘异常）：{ok:false, reason}，调用方保留
 * batch-no-ledger 债；不向批量路径抛错（派生物写失败不阻断主流程）。
 *
 * @returns {{ok, landed, rejected, dropped, reason, attempts}}
 *   ok=true   盲区关闭（抽到并落账了，或本章确无状态变化）——调用方不再落 batch-no-ledger 债
 *   ok=false  盲区仍在（抽取/证据/写盘任一失败）——调用方落 batch-no-ledger 债并带 reason
 */
export async function extractAndLandFacts({ io, p, book, chapter, content, engine, maxLines = 8 }) {
    // 引擎不可用（MCP 独立模式 / 无模型服务）：不落账，返回失败让债保留
    if (engine === null || engine.isAvailable?.() === false) {
        return { ok: false, landed: 0, rejected: [], dropped: 0, reason: '模型引擎不可用，未抽取', attempts: 0 };
    }
    let r;
    try {
        r = await engine.run('ledger', {
            system: LEDGER_EXTRACT_SYSTEM,
            prompt: buildLedgerExtractPrompt(content),
        });
    } catch (error) {
        // 引擎 run 抛错（底层炸了）也归一成 ok:false 结果——绝不把异常飞出去
        // （宿主裸 rejection 是 fatal，同一条纪律），让 fireLedgerExtract 走到
        // reconcileLedgerDebt 写审计留痕。
        return {
            ok: false, landed: 0, rejected: [], dropped: 0, attempts: 0,
            reason: `账本抽取调用抛错（${String(error?.message ?? error)}）`,
        };
    }
    const attempts = Number.isInteger(r.attempts) ? r.attempts : 0;
    if (!r.ok) {
        return {
            ok: false, landed: 0, rejected: [], dropped: 0, attempts,
            reason: `账本抽取调用失败（${r.error?.code ?? r.error?.message ?? 'unknown'}）`,
        };
    }
    const { rows, dropped } = parseLedgerExtract(r.text, { maxLines });
    // 正文没有状态变化（或模型一行都没抽）——合法的「本章没有要记的」，盲区关闭，不是失败
    if (rows.length === 0) {
        return { ok: true, landed: 0, rejected: [], dropped, attempts, reason: null };
    }
    const { landable, rejected } = groundLedgerRows(rows, content);
    if (landable.length === 0) {
        return {
            ok: false, landed: 0, rejected, dropped, attempts,
            reason: `抽出的 ${rows.length} 行证据全部不足（值不在原句 / 原句不在正文），一行都没落`,
        };
    }
    // 落账：updateJson 版本重放合入 p.facts（status=pending）。applyFactUpdates 同值幂等跳过；
    // 同章同键不同值进 conflicts（不抛、不覆盖，reason 显形点名）。
    let landed = 0;
    let conflicts = 0;
    let conflictKeys = [];
    try {
        const now = new Date().toISOString();
        const out = await updateJson(io, p.facts, (latest) => {
            const current = Array.isArray(latest) ? latest : []; // 新书记：p.facts 还不存在 → 空数组起步
            const { facts: nextFacts, added, conflicts: c } = applyFactUpdates(current, landable, { chapter, now });
            return { value: nextFacts, result: { landed: added.length, conflicts: c ?? [] } };
        });
        landed = out?.result?.landed ?? 0;
        conflicts = out?.result?.conflicts?.length ?? 0;
        conflictKeys = (out?.result?.conflicts ?? []).map((c) => `${c.entity}·${c.key}`).slice(0, 5);
    } catch (error) {
        return {
            ok: false, landed: 0, rejected, dropped, attempts,
            reason: `账本写入失败（${String(error?.message ?? error)}）——已抽出的 ${landable.length} 行未落，需回头补录`,
        };
    }
    const note = conflicts > 0
        ? `另有 ${conflicts} 行与既有账本同章冲突（${conflictKeys.join('、')}${conflictKeys.length < conflicts ? '…' : ''}）——这些键已有记录，未覆盖` : null;
    return { ok: true, landed, rejected, conflicts, conflictKeys, dropped, attempts, reason: note };
}

/**
 * 债对账：把本章的 batch-no-ledger major 债换成抽取结果对应的债（updateJson 版本重放，
 * 与 saveBookMerged 同一条写 novel.json 的路径）。
 *
 * 三条对账规则（只动 batch-no-ledger 这一条，同章其它债原样保留）：
 *   · 抽取成功落账（landed>0）→ 换成 ledger-pending minor 债：「盲区已关，N 行 pending 待你复核」；
 *   · 抽取确认无状态变化（landed=0 且 ok）→ 直接**清掉**该债：「本章确实没有要记的」，盲区确认可关闭；
 *   · 抽取失败（ok=false）→ **保留** major 债不动（盲区仍开），只把 reason 写进审计留痕。
 * 幂等：本章债表里没有 batch-no-ledger（没记过或已换过）则什么都不做（无债可换，不写盘）。
 */
export async function reconcileLedgerDebt({ io, p, book, chapter, outcome }) {
    const { ok, landed, reason } = outcome ?? {};
    // 审计旁证（写不进不阻断）
    try {
        await audit(io, p, 'ledger/extract', {
            chapter, ok: ok === true, landed: landed ?? 0, reason: reason ?? null,
        });
    } catch { /* 审计是旁证 */ }
    if (ok !== true) {
        // 失败：盲区仍开，major 债原样保留（不回改），只留痕
        return { swapped: false, reason: '抽取失败，batch-no-ledger 债保留' };
    }
    // 成功：换债 / 清债。landed>0 → ledger-pending minor；landed=0 → 清掉 batch-no-ledger 债。
    const replacement = landed > 0
        ? [makeDebt({
            code: 'ledger-pending',
            message: `第${chapter}章批量起草自动抽出 ${landed} 行状态变化（pending 待复核）——`
                + 'novel_ledger query 看这几行、确认无误把 status 改 confirmed；有误就改对或删行',
            chapter,
            ts: new Date().toISOString(),
        })]
        : []; // landed=0：本章确实没有状态变化 → 清掉 batch-no-ledger 债
    try {
        const out = await updateJson(io, p.meta, (latest) => {
            if (latest === undefined || latest === null) return undefined; // 书目被删：不写
            const key = String(chapter);
            const existing = latest.quality?.debts?.[key];
            const isList = Array.isArray(existing);
            if (!isList || !existing.some((d) => d?.code === 'batch-no-ledger')) {
                return undefined; // 无债可换（幂等）——不写盘，避免把整个 novel.json 重放一遍
            }
            // 保留其它债，只替换 batch-no-ledger 这一条
            const kept = existing.filter((d) => d?.code !== 'batch-no-ledger');
            latest.quality = { ...(latest.quality ?? {}), debts: { ...(latest.quality?.debts ?? {}), [key]: [...kept, ...replacement] } };
            return { value: latest, result: { swapped: true } };
        });
        return { swapped: out?.written === true };
    } catch (error) {
        // 换债失败不阻断成稿（账本行已落，债只是可见性问题）——留痕即可
        console.warn(`[novel-forge] 第 ${chapter} 章账本债对账失败（不影响已落的账本行）：${String(error?.message ?? error)}`);
        return { swapped: false, reason: String(error?.message ?? error) };
    }
}

/**
 * fire-and-forget 封装：批量提交成功后异步抽 + 换债，绝不阻塞成稿返回、绝不把失败抛回批量路径。
 *
 * 同一本书的多次抽取排成一条 promise 链依次跑（不并发打限流、不漏章；抽取按章独立，
 * 跳过即缺失，不能像 autoAnnotate 那样在飞跳过）。链上每一环自身吞掉一切异常
 * （console.warn 留痕，裸 rejection 在宿主进程是 fatal）。
 *
 * @returns {Promise<{...outcome, ...reconcile}>} 本章这一环的结果（await 断言；REST 面不 await，
 *   后台跑完自行换债——债表是唯一真相）
 */
const ledgerExtractChains = new Map();

export function fireLedgerExtract({ io, p, book, chapter, content, engine, maxLines = 8 }) {
    // step 是惰性函数（不是 IIFE）：排到 prev 之后才执行，保证同一本书的抽取串行。
    const step = async () => {
        try {
            const outcome = await extractAndLandFacts({ io, p, book, chapter, content, engine, maxLines });
            const reconcile = await reconcileLedgerDebt({ io, p, book, chapter, outcome });
            // reconcile 的失败原因单独命名（reconcileReason）：两个 reason 撞键会把
            // 抽取原因覆盖掉——链结果里两个都得看得见。
            const { reason: reconcileReason, ...rest } = reconcile;
            return { ...outcome, ...rest, ...(reconcileReason !== undefined ? { reconcileReason } : {}) };
        } catch (error) {
            console.warn(`[novel-forge] 第 ${chapter} 章账本抽取失败（不影响成稿）：${String(error?.message ?? error)}`);
            return { ok: false, landed: 0, rejected: [], dropped: 0, reason: String(error?.message ?? error), swapped: false };
        }
    };
    const prev = ledgerExtractChains.get(book);
    const chain = (prev ?? Promise.resolve()).then(() => step());
    // 链尾兜底 catch：调用方不 await chain 时宿主也不收到裸 rejection。
    chain.catch(() => {});
    ledgerExtractChains.set(book, chain);
    return chain;
}

/** 测试/诊断：本书抽取链尾的 promise（队列排空时 resolve；没有则为 null）。 */
export function pendingLedgerExtract(book) {
    return ledgerExtractChains.get(book) ?? null;
}
