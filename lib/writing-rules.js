// lib/writing-rules.js — 书级写法规则台账（纯函数，零 token）。
//
// 八维判据词库是**全局静态**的——作者没法给「自己的书」定写法规矩（「本书绝不用
// 『嘴角勾起』」「鼓励短句节奏」这类书级纪律没有落点）。本模块补这个缺口：每本书
// 一份规则台账（设定/写法规则.json，与 facts 同构），作者登记「禁止/风险/鼓励」三类
// 规则；检测面是**确定性计数**（规则自带检测词，纯本地，口径同八维——不进八维分，
// 不产生质量债，report-only），注入面把规则的修正方向进写章简报当「写法规则（本书纪律）」段。
//
// 纪律（与 style-whitelist 同源）：
//   · 台账按书隔离（不跨书继承），逐字匹配（检测词不模糊）；
//   · 命中只报不拦——拦的语义仍归内容门禁，这里是证据面；
//   · 规则行是结构化的（名称|类型|严重度|检测词|修正方向），不是自由文本——
//     解析失败响亮报错，不静默吞行。

import { nextSuffixedId } from './versioning.js';

/** 规则三态：禁止（命中即报）/ 风险（成片才报）/ 鼓励（只计数与注入，不罚缺失）。 */
export const RULE_TYPES = Object.freeze(['forbidden', 'risk', 'encourage']);

/** 严重度（报告口径排序用；不改拦不拦——拦截语义永远归门禁）。 */
export const RULE_SEVERITIES = Object.freeze(['low', 'medium', 'high']);

/** 台账行形状（落盘 JSON 数组元素）。id 自增 R1/R2…；name 是唯一业务键。 */
export function validRuleRow(r) {
    return r !== null && typeof r === 'object'
        && typeof r.id === 'string' && r.id !== ''
        && typeof r.name === 'string' && r.name.trim() !== ''
        && RULE_TYPES.includes(r.type)
        && RULE_SEVERITIES.includes(r.severity)
        && Array.isArray(r.patterns);
}

/**
 * 解析多行规则文本（rules_add 的 text 参数）。
 * 行式：`名称|类型|严重度|检测词1,检测词2|修正方向`——竖线分五段，检测词逗号/顿号分隔，
 * 后两段可缺省（类型默认 risk、严重度默认 medium、修正方向默认空）。
 * 检测词：forbidden/risk 必须至少一个（确定性计数靠它）；encourage 可不填（鼓励类
 * 是纯文字纪律，只走注入面不罚命中，缺检测词合法）。
 * @returns {{ rules: object[], errors: string[] }}（逐行校验，坏行进 errors 不炸整批）
 */
export function parseWritingRulesText(raw) {
    const lines = String(raw ?? '').split(/\r?\n/).map((l) => l.trim());
    const rules = [];
    const errors = [];
    lines.forEach((line, i) => {
        if (line === '' || line.startsWith('#')) return;
        const parts = line.split('|').map((s) => s.trim());
        const [name, typeRaw, severityRaw, patternsRaw, instruction] = parts;
        if (!name) { errors.push(`第${i + 1}行缺名称：${line.slice(0, 40)}`); return; }
        const type = typeRaw || 'risk';
        if (!RULE_TYPES.includes(type)) { errors.push(`第${i + 1}行类型「${typeRaw}」无效（限 ${RULE_TYPES.join('/')}）`); return; }
        const severity = severityRaw || 'medium';
        if (!RULE_SEVERITIES.includes(severity)) { errors.push(`第${i + 1}行严重度「${severityRaw}」无效（限 ${RULE_SEVERITIES.join('/')}）`); return; }
        const patterns = String(patternsRaw ?? '')
            .split(/[,，、]/).map((s) => s.trim()).filter((s) => s !== '');
        if (type !== 'encourage' && patterns.length === 0) {
            errors.push(`第${i + 1}行「${name}」（${type}）没给检测词——确定性检测需要至少一个词`);
            return;
        }
        rules.push({
            name, type, severity, patterns,
            instruction: String(instruction ?? '').trim(),
        });
    });
    return { rules, errors };
}

/**
 * 台账合并（reconcile）：existing 数组 + add 行 + remove 名称集 → 新数组。
 * add 按 name 去重 upsert（同名覆盖：改检测词/修正方向就该改那条，不并影子行）；
 * 新行 id 走 nextSuffixedId 取**现存**最大序号 +1（gap 位置可重用——规则 id 只在台账内
 * 唯一、无跨文档引用，删掉 R2 后新行拿回 R2 无历史包袱）；remove 按 name 删。
 * @returns { rules: object[], added: string[], removed: string[] }
 */
export function reconcileWritingRules(existing, addRules = [], removeNames = []) {
    const current = (Array.isArray(existing) ? existing : []).filter(validRuleRow);
    const byName = new Map(current.map((r) => [r.name, r]));
    const nextId = () => nextSuffixedId([...byName.values()].map((r) => r.id), 'R');
    const added = [];
    for (const r of addRules ?? []) {
        const prev = byName.get(r.name);
        byName.set(r.name, {
            id: prev?.id ?? nextId(),
            name: r.name, type: r.type, severity: r.severity,
            patterns: [...r.patterns], instruction: r.instruction ?? '',
        });
        added.push(prev ? `${r.name}（更新）` : r.name);
    }
    const removed = [];
    for (const n of removeNames ?? []) {
        if (byName.delete(n)) removed.push(n);
    }
    return { rules: [...byName.values()], added, removed };
}

/** 数一个子串在文本里出现的总次数（逐字、大小写敏感——与八维的逐字口径一致）。 */
function countOccurrences(text, needle) {
    if (typeof needle !== 'string' || needle === '') return 0;
    let count = 0;
    let from = 0;
    while ((from = text.indexOf(needle, from)) !== -1) { count += 1; from += needle.length; }
    return count;
}

/**
 * 确定性检测（report-only）：逐规则数检测词命中。
 * 报告阈值：forbidden 命中 ≥1 即报；risk ≥2 成片才报（单词正常，成片才是风格信号）；
 * encourage 只计数不报（鼓励项不罚缺失，命中多少都是好事）。
 * @returns {{ counts: Array<{name, type, severity, hits}>, issues: string[] }}
 */
export function scanWritingRules(text, rules) {
    const src = String(text ?? '');
    const rows = (Array.isArray(rules) ? rules : []).filter(validRuleRow);
    const counts = [];
    const issues = [];
    for (const r of rows) {
        const hits = r.patterns.reduce((sum, p) => sum + countOccurrences(src, p), 0);
        counts.push({ name: r.name, type: r.type, severity: r.severity, hits });
        const fix = r.instruction !== '' ? `——${r.instruction}` : '';
        if (r.type === 'forbidden' && hits > 0) {
            issues.push(`本书禁用「${r.patterns.join('、')}」（规则 ${r.name}）出现 ${hits} 次${fix}`);
        } else if (r.type === 'risk' && hits >= 2) {
            issues.push(`本书风险写法「${r.patterns.join('、')}」（规则 ${r.name}）成片出现 ${hits} 次${fix}`);
        }
    }
    return { counts, issues };
}

/**
 * 简报注入段（写法规则=本书写作纪律位）：禁止/风险给修正方向，鼓励给推荐。
 * 追加段不吃 pack 预算，须自封顶（同样稿段先例）：最多 12 条、单条 200 字。
 * @returns string（无规则返回 ''，调用方跳过该段）
 */
export function renderWritingRulesSection(rules, { maxRules = 12, perRuleChars = 200 } = {}) {
    const rows = (Array.isArray(rules) ? rules : []).filter(validRuleRow).slice(0, maxRules);
    if (rows.length === 0) return '';
    const clip = (s) => (s.length > perRuleChars ? `${s.slice(0, perRuleChars - 1)}…` : s);
    const lines = rows.map((r) => {
        const body = r.instruction !== ''
            ? clip(r.instruction)
            : clip(`检测词：${r.patterns.join('、')}`);
        switch (r.type) {
            case 'forbidden': return `- 【禁用】${r.name}：${body}`;
            case 'encourage': return `- 【推荐】${r.name}：${body}`;
            default: return `- 【留意】${r.name}：${body}`;
        }
    });
    const capNote = (Array.isArray(rules) ? rules : []).filter(validRuleRow).length > maxRules
        ? `\n（仅列前 ${maxRules} 条）` : '';
    return '本书写法规则（作者定，正文按此执行；命中判定是报告不是门禁）：\n' + lines.join('\n') + capNote;
}
