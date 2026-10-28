// lib/basis.js — 写前简报的「依据指纹」（纯函数，零 IO）。
//
// 要消灭的故障（此前**全程无告警**）：
//   novel_briefing 生成上下文包 → 用户在面板改了场景契约 → 模型按**旧简报**写完一章
//   → 落盘。文件里的契约已经是新的，正文却是旧契约的产物——**契约与正文对不上，没有任何提示**。
//
// 做法（对齐 A 的 CandidateBasisV1 / E 的 captureGenerationKnowledge）：
//   生成时对「本章的写作依据」取内容哈希 → 落一份 basis 记录；
//   写章提交时**服务端重算**同一组哈希并比对 → 漂移即告警。
//   比对由服务端做，不靠模型自觉把指纹带回来——模型忘了带，服务器照样查得出来。
//
// 什么算「写作依据」（进 digest）：
//   outline    本章细纲      —— 定义这章写什么
//   contract   本章场景契约  —— 定义谁出场、什么不许出现
//   worldbook  世界书        —— 定义设定事实
//
// 什么**不算**进 digest：账本（facts）。
//   账本随故事推进**必然**变化（每提交一章就多几条），把它算进「陈旧」判定，
//   批量起草路径会**每章都误报**（批量先给所有章建简报，再逐章提交，账本一路在变）。
//   账本的真实风险是「有人改写了已有条目」——那由 factsSig 精确比对单独兜：
//   新增条目静默（正常推进），改写/删除才报。
//
// 纯函数（AGENTS.md 不变量 2）：本模块不碰 io、不取钟。

import { createHash } from 'node:crypto';
import { contractFingerprint } from './scene-contract.js';

/** 指纹格式版本——判据变了就 +1（老记录按版本分别处理，不静默套用新口径）。 */
export const BASIS_VERSION = 1;

/** 内容哈希（sha256 前 16 位，够用且短——要贴进审计行与工具输出）。 */
export function sha256(text) {
    return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16);
}

/**
 * 稳定序列化：对象键**排序**后拼接。
 * 为什么排序：JSON.stringify 的键序取决于写入顺序，同一份数据换个键序就换了哈希——
 * 那不是「依据变了」，是序列化噪声。数组保序（数组的顺序本身就是语义）。
 */
export function stableStringify(value) {
    if (value === null || value === undefined) return 'null';
    if (typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * 账本当前态签名：每个「实体|键」取**最新值**（按章号，同章取后写入的）。
 * 输出为 "实体|键=值" 的行数组——可存可逐项比对。
 * 为什么只取最新值：账本是追加式历史，「改写」表现为同一键出现新值；
 * 只看最新值才能把「改写」与「新增」分开（新增要静默，改写要报）。
 */
export function factsEntries(facts) {
    const latest = new Map();
    (facts ?? []).forEach((f, i) => {
        if (f === null || typeof f !== 'object') return;
        const entity = String(f.entity ?? '');
        const key = String(f.key ?? '');
        if (entity === '' || key === '') return;
        const id = `${entity}|${key}`;
        const chapter = Number.isInteger(f.chapter) ? f.chapter : 0;
        const cur = latest.get(id);
        if (cur === undefined || chapter >= cur.chapter) {
            const status = String(f.status ?? 'confirmed').trim().toLowerCase();
            // 兼容旧签名：confirmed 不加后缀；unknown/pending 是终态的一部分，必须进比对。
            const statusSuffix = status === 'unknown' || status === 'pending' ? `|${status}` : '';
            latest.set(id, { chapter, value: String(f.value ?? ''), statusSuffix, i });
        }
    });
    return [...latest.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([id, v]) => `${id}=${v.value}${v.statusSuffix}`);
}

/**
 * 计算简报依据指纹。
 * @param outline   本章细纲正文（原文）
 * @param contract  本章场景契约（已归一）或 null
 * @param worldbook 世界书条目数组
 * @param facts     账本事实数组（只进 factsSig，不进 digest）
 * @returns {{version, digest, sources:[{type,hash}], factsSig:string[]}}
 */
export function computeBasis({ outline = '', contract = null, worldbook = [], facts = [] } = {}) {
    const sources = [
        { type: 'outline', hash: sha256(String(outline ?? '')) },
        // 契约用**语义指纹**（不含 updatedAt）——否则「原样重存」也会被判成有变化，
        // 变更检测就变成了永远在报警的哑铃。
        { type: 'contract', hash: sha256(contractFingerprint(contract) ?? 'none') },
        { type: 'worldbook', hash: sha256(stableStringify(worldbook)) },
    ];
    const digest = sha256(sources.map((s) => `${s.type}:${s.hash}`).join('|'));
    return { version: BASIS_VERSION, digest, sources, factsSig: factsEntries(facts) };
}

/** 账本签名比对：新增（静默）/ 改写（报）/ 删除（报）。 */
export function diffFacts(expected = [], actual = []) {
    const parse = (arr) => {
        const m = new Map();
        for (const line of arr ?? []) {
            const at = String(line).indexOf('=');
            if (at <= 0) continue;
            m.set(String(line).slice(0, at), String(line).slice(at + 1));
        }
        return m;
    };
    const e = parse(expected);
    const a = parse(actual);
    const added = [];
    const removed = [];
    const modified = [];
    for (const [k, v] of a) {
        if (!e.has(k)) added.push(k);
        else if (e.get(k) !== v) modified.push(k);
    }
    for (const k of e.keys()) if (!a.has(k)) removed.push(k);
    return { added, removed, modified };
}

/**
 * 比对两份 basis。
 * @returns {{stale:string[], changed:boolean, facts:{added,removed,modified}}}
 *   stale  —— digest 覆盖的来源里变了哪些（outline/contract/worldbook）
 *   facts  —— 账本条目的增删改
 */
export function diffBasis(expected, actual) {
    if (expected === null || expected === undefined || actual === null || actual === undefined) {
        return { stale: [], changed: false, facts: { added: [], removed: [], modified: [] } };
    }
    const e = new Map((expected.sources ?? []).map((s) => [s.type, s.hash]));
    const stale = (actual.sources ?? [])
        .filter((s) => e.get(s.type) !== s.hash)
        .map((s) => s.type);
    return { stale, changed: stale.length > 0, facts: diffFacts(expected.factsSig ?? [], actual.factsSig ?? []) };
}

/** 来源类型的人读名（提示文案用）。 */
export const SOURCE_LABELS = {
    outline: '本章细纲',
    contract: '场景契约',
    worldbook: '世界书',
};
