// lib/world-rules.js — 世界规则台账（设定域 × 冲突优先级，纯函数，零 IO、零模型调用）。
//
// 架空/历史题材书里最阴的一致性事故：「这条设定到底算史实还是架空，冲突时哪边算数」
// 没有落点——正文一跑偏（史实域写进架空改造、或架空域当成史实），门禁查不出来（门禁
// 管死人复活/泄底/欠账，不管设定域口径）。本台账把「设定域」当一等纪律位：每个域记
// 「史实锚点 / 架空改造 / 冲突时哪边优先」，登记走 novel_worldbook 的 rules_* 动作
// （台账 设定/世界规则.json，按书隔离），消费走写前简报追加段「世界设定纪律」（注入
// 口径，写前预防）+ rules_check 的确定性扫描（史实优先域的架空改造成语出现在正文里
// → report-only 点名，拦不拦由作者定）。
//
// 行式（与写法规则同一档纪律）：`域|子类|史实锚点|架空改造|冲突优先级`
//   · 域必填；后四段可省（省=该域只声明存在、没填口径）；
//   · 冲突优先级取 史实优先/架空优先/均衡（缺省 均衡；英文 historical/fictional/balanced 同认）；
//   · 坏行进 errors 不炸整批。
// 合并（reconcile）：按「域·子类」upsert；删除按名——给「域」删该域全部子行、
// 给「域·子类」删单行。

export const RULE_PRIORITIES = ['historical', 'fictional', 'balanced'];
const PRIORITY_TOKENS = {
    historical: '史实优先',
    fictional: '架空优先',
    balanced: '均衡',
};
const PRIORITY_FROM_CN = { '史实优先': 'historical', '架空优先': 'fictional', '均衡': 'balanced' };

function normalizePriority(raw) {
    const t = String(raw ?? '').trim();
    if (t === '') return 'balanced';
    const lower = t.toLowerCase();
    if (RULE_PRIORITIES.includes(lower)) return lower;
    if (PRIORITY_FROM_CN[t] !== undefined) return PRIORITY_FROM_CN[t];
    return null;
}

/** 一行是否有效（域非空 + 各格皆字符串 + 优先级合法；畸形行滤出不炸消费面）。 */
export function validWorldRuleRow(r) {
    if (r === null || typeof r !== 'object') return false;
    if (typeof r.domain !== 'string' || r.domain.trim() === '') return false;
    const sub = r.subdomain;
    if (sub !== undefined && typeof sub !== 'string') return false;
    for (const f of ['historicalAnchors', 'fictionalAdaptations']) {
        if (r[f] !== undefined && typeof r[f] !== 'string') return false;
    }
    if (r.priority !== undefined && !RULE_PRIORITIES.includes(r.priority)) return false;
    return true;
}

/** 解析多行台账文本 → { rules, errors }。域重名（同 域·子类）以**后行为准**并进 errors
 *  提示（静默覆盖=作者以为两条都在，其实只剩一条）。 */
export function parseWorldRulesText(raw) {
    const rules = [];
    const errors = [];
    const byKey = new Map(); // 域·子类 → 行（后行覆盖前行，首见序保留）
    for (const line of String(raw ?? '').split(/\r?\n/)) {
        const t = line.trim();
        if (t === '' || t.startsWith('#')) continue;
        const cells = t.split('|').map((c) => c.trim());
        const domain = cells[0] ?? '';
        if (domain === '') {
            errors.push(`缺域名（「${t.slice(0, 16)}…」）——行式「域|子类|史实锚点|架空改造|冲突优先级」`);
            continue;
        }
        const priority = normalizePriority(cells[4]);
        if (priority === null) {
            errors.push(`域「${domain}」冲突优先级「${(cells[4] ?? '').trim()}」无效——取 史实优先/架空优先/均衡（缺省 均衡）`);
            continue;
        }
        const key = worldRuleKey(domain, cells[1] ?? '');
        if (byKey.has(key)) errors.push(`域「${key}」重复登记——后行覆盖前行`);
        byKey.set(key, {
            domain,
            subdomain: cells[1] ?? '',
            historicalAnchors: cells[2] ?? '',
            fictionalAdaptations: cells[3] ?? '',
            priority,
        });
    }
    return { rules: [...byKey.values()], errors };
}

/** 行的稳定键（reconcile upsert / remove 用）。 */
export function worldRuleKey(domain, subdomain = '') {
    return subdomain ? `${String(domain).trim()}·${String(subdomain).trim()}` : String(domain).trim();
}

/**
 * 台账合并：existing + add 行 + remove 名 → 新数组。add 按「域·子类」upsert（同行覆盖：
 * 改口径就该改那条）；remove 按名——名等于某行的 域·子类 删该行；名等于某行的**域**
 * 删该域主行与全部子行（域级删除总是整域，不区分该域有无子行）。
 * @returns { rules: object[], added: string[], removed: string[] }
 */
export function reconcileWorldRules(existing, addRules = [], removeNames = []) {
    const current = (Array.isArray(existing) ? existing : []).filter(validWorldRuleRow);
    const rows = current.map((r) => ({ ...r, subdomain: r.subdomain ?? '' }));
    const byKey = new Map(rows.map((r) => [worldRuleKey(r.domain, r.subdomain), r]));
    const added = [];
    for (const r of addRules ?? []) {
        const key = worldRuleKey(r.domain, r.subdomain ?? '');
        const prev = byKey.get(key);
        byKey.set(key, {
            domain: r.domain, subdomain: r.subdomain ?? '',
            historicalAnchors: r.historicalAnchors ?? '', fictionalAdaptations: r.fictionalAdaptations ?? '',
            priority: RULE_PRIORITIES.includes(r.priority) ? r.priority : 'balanced',
        });
        added.push(prev ? `${key}（更新）` : key);
    }
    const removed = [];
    for (const name of removeNames ?? []) {
        const n = String(name).trim();
        if (n === '') continue;
        let hit = false;
        for (const [key] of [...byKey]) {
            if (key === n || key.startsWith(`${n}·`)) {
                byKey.delete(key);
                hit = true;
            }
        }
        if (hit) removed.push(n);
    }
    return { rules: [...byKey.values()], added, removed };
}

/**
 * 确定性扫描（report-only）：对正文扫「史实优先域的架空改造成语」——4 字滑窗取
 * fictionalAdaptations 的成文片段，命中即点名（「史实域『x』的架空设定『…』出现在正文
 * 里——史实优先域，核对是否越出架空边界」）。只在 priority==='historical' 且改造
 * 非空时扫（均衡/架空优先域写进架空是正常行为，不报）。宁漏勿刷屏：每域每章
 * 命中上限 3 条。
 * @returns {{ issues: string[], counts: Array<{domain, hits}> }}
 */
export function worldRuleScan(text, rules, { perDomainHits = 3 } = {}) {
    const issues = [];
    const counts = [];
    const hay = String(text ?? '');
    if (hay.trim() === '') return { issues, counts };
    for (const r of (rules ?? []).filter(validWorldRuleRow)) {
        if (r.priority !== 'historical') continue;
        const adaptations = String(r.fictionalAdaptations ?? '').trim();
        if (adaptations.length < 4) continue; // 太短的改造句 4 字滑窗全是噪声
        const shingles = new Set();
        for (let i = 0; i + 4 <= adaptations.length; i += 2) shingles.add(adaptations.slice(i, i + 4));
        const hits = [...shingles].filter((s) => hay.includes(s));
        if (hits.length === 0) continue;
        const key = worldRuleKey(r.domain, r.subdomain);
        counts.push({ domain: key, hits: hits.length });
        issues.push(`史实优先域「${key}」的架空设定成语文（${hits.slice(0, perDomainHits).join('、')}${hits.length > perDomainHits ? '…' : ''}）出现在正文——史实优先口径下核对是否越出架空边界（report-only，是否改由作者定）`);
    }
    return { issues, counts };
}

/**
 * 简报追加段渲染（纯函数）：空台账返回 ''（调用方整段省略）；有则按域分组列
 * 「史实锚点 / 架空改造 / 冲突优先级」，封顶 12 域 × 每格 60 字（追加段不吃 pack 预算须自封顶）。
 * @param {object[]} rules 台账行
 * @returns string
 */
export function renderWorldRulesSection(rules, { maxDomains = 12, perCell = 60 } = {}) {
    const valid = (Array.isArray(rules) ? rules : []).filter(validWorldRuleRow);
    if (valid.length === 0) return '';
    const clip = (s) => {
        const t = String(s ?? '').trim();
        return t.length > perCell ? `${t.slice(0, perCell - 1)}…` : t;
    };
    const byDomain = new Map();
    for (const r of valid) {
        const d = String(r.domain).trim();
        if (!byDomain.has(d)) byDomain.set(d, []);
        byDomain.get(d).push(r);
    }
    const lines = [];
    let n = 0;
    for (const [domain, rows] of byDomain) {
        if (n >= maxDomains) break;
        n += 1;
        const main = rows.find((r) => !r.subdomain) ?? rows[0];
        const prio = PRIORITY_TOKENS[main.priority] ?? main.priority;
        const sub = rows.filter((r) => r.subdomain).map((r) => {
            const cells = [];
            if (r.historicalAnchors.trim() !== '') cells.push(`史实 ${clip(r.historicalAnchors)}`);
            if (r.fictionalAdaptations.trim() !== '') cells.push(`架空 ${clip(r.fictionalAdaptations)}`);
            return `  - ${r.subdomain}${cells.length > 0 ? `（${cells.join('；')}）` : ''}`;
        });
        const mainCells = [];
        if (main.historicalAnchors.trim() !== '') mainCells.push(`史实 ${clip(main.historicalAnchors)}`);
        if (main.fictionalAdaptations.trim() !== '') mainCells.push(`架空 ${clip(main.fictionalAdaptations)}`);
        lines.push(`- 【${domain}】冲突口径：${prio}${mainCells.length > 0 ? `——${mainCells.join('；')}` : ''}`);
        lines.push(...sub.slice(0, 6));
    }
    return lines.join('\n') + '\n——以上是本书设定域纪律：写涉及这些域的场景前，按冲突口径定「哪边算数」；架空改造成语出现在史实优先域时先核对边界（rules_check 会确定性点名）。';
}
