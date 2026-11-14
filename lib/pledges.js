// lib/pledges.js — 叙事契约账本（纯函数，零 token，AGENTS.md 不变量 2 纯函数名单成员）。
//
// 来源：竞品（天命 v2.8.7 的 Pledge/Deadline/SecretReveal + 火宝的逻辑审计 schema）。
// **适配**为本插件能代码判定的三类「作者向读者/向剧情立下的承诺」：
//
//   pledge   承诺——某人立下了某事，后续章节若违背应自动告警。
//   deadline 截止——「三天后报仇」「月底前交货」等**带期限约束**的事件，
//            系统记录到第几章必须兑现；到期未兑现即超期。
//   secret   秘密——「假死真相」「身世秘密」在第 N 章埋下，到某章前不能露馅；
//            到期未揭晓 = 秘密泄露风险（读者已经忘了 / 被别的线索提前拆穿）。
//
// 数据形状（账本/pledges.json，append-only 行日志，与 facts / relations / arcs 同构）：
//   { id, kind, subject, statement, chapter, deadlineChapter, status, note, ts }
//   · kind：pledge / deadline / secret（**唯一**三类，代码不判词义——模型自由登记）
//   · subject：承诺主体（人物/势力/事件名；字符串，可空）
//   · statement：一句话陈述（模型填，代码不解析——只作展示与关键词匹配用）
//   · chapter：立下/埋设章号（必有；append-only 日志的时点锚）
//   · deadlineChapter：到期章号（pledge/deadline 必填、secret 可选）
//   · status：open / kept / broken / revealed / expired
//     · open      仍待兑现
//     · kept      pledge 被遵守（显式登记，不自动判）
//     · broken    pledge 被违背（显式登记，**内容门禁据此阻断后续相关章节**）
//     · revealed  secret 被揭晓（显式登记，secret 的终态）
//     · expired   到期未兑现（**代码判定**：maxWritten >= deadlineChapter 且仍 open）
//
// 设计取舍（对齐 AGENTS.md「代码强制 > 提示词自觉」）：
//   · 是否**兑现**是语义层，代码不假装能判——kept / broken / revealed 只能由模型
//     显式登记（novel_ledger pledge_keep / pledge_break / secret_reveal），
//     登记本身是「我判断过」的留痕，比「模型自觉记住」强一档；
//   · 是否**到期**是纯算术（maxWritten vs deadlineChapter），代码硬判——
//     超期未兑现 = warning，到期后仍写新钩子 = 复用 content-gate 的欠账机制。
//
// 审计 schema（对齐火宝的五类逻辑审计 + 定位到实体/章节）：
//   pledgeAudit() 返回 [{ id, kind, subject, chapter, deadlineChapter, status,
//     severity, code, where, message, nodeIds, edgeIds, chapters }]
//   · nodeIds：该契约涉及的实体名（subject + statement 关键词）——面板可点跳；
//   · chapters：[立下章, 到期章, 揭晓章（若已 reveal）]——面板可定位章节区间；
//   · severity：error / warning / info（与 continuity 同档）。

import { nextSuffixedId } from './versioning.js';

/** 契约种类（唯一三类，代码不判词义）。 */
export const PLEDGE_KINDS = ['pledge', 'deadline', 'secret'];

/** 契约状态。 */
export const PLEDGE_STATUS = ['open', 'kept', 'broken', 'revealed', 'expired'];

/** 改期上限：改期是「重新规划」的合法通道，但不能变成「无限延期」把到期告警永久静音。 */
export const MAX_PLEDGE_REPLANS = 3;

/**
 * 行守卫：畸形行不参与时间线与判定（与 facts/relations/arcs 同纪律——
 * 账本家族的三条保护：标签保留 / 越书路径 / 全量才清，这里只读行级形状）。
 */
export function validPledgeRow(r) {
    return r !== null && typeof r === 'object'
        && typeof r.id === 'string' && r.id !== ''
        && PLEDGE_KINDS.includes(r.kind)
        && Number.isInteger(r.chapter) && r.chapter >= 1
        && PLEDGE_STATUS.includes(r.status);
}

/**
 * 契约追加（append-only）。
 * @param list 现有契约数组
 * @param entry { kind, subject, statement, chapter, deadlineChapter?, note?, id? }
 * @returns 新数组
 */
export function pledgeSetup(list, { kind, subject = '', statement, chapter, deadlineChapter = null, note = '', id = null, now = '' }) {
    if (!PLEDGE_KINDS.includes(kind)) {
        throw new Error(`契约 kind 必须是 ${PLEDGE_KINDS.join('/')} 之一（收到：${kind}）`);
    }
    if (typeof statement !== 'string' || statement.trim() === '') {
        throw new Error('契约 statement 不能为空——一句话写清「承诺了什么」');
    }
    if (!Number.isInteger(chapter) || chapter < 1) {
        throw new Error('契约 chapter 必须是正整数（立下/埋设章号）');
    }
    // deadline / secret：到期章是判超期的依据，pledge 可省（无硬期限的承诺不催）。
    const dl = Number.isInteger(deadlineChapter) && deadlineChapter >= 1 ? deadlineChapter : null;
    if ((kind === 'deadline' || kind === 'secret') && dl === null) {
        throw new Error(`${kind} 必须给 deadlineChapter（到期章号）——超期判定全靠它`);
    }
    if (dl !== null && dl < chapter) {
        throw new Error(`契约到期章（第${dl}章）早于立下章（第${chapter}章）——时间线倒挂`);
    }
    const pid = id ?? nextSuffixedId(list.map((x) => x.id), 'P');
    if (list.some((x) => x.id === pid)) {
        throw new Error(`契约 id「${pid}」已存在——id 必须唯一，改期请走 pledgeReplan`);
    }
    return [...list, {
        id: pid,
        kind,
        subject: String(subject ?? '').trim(),
        statement: statement.trim(),
        chapter,
        deadlineChapter: dl,
        status: 'open',
        note: String(note ?? '').trim(),
        ts: String(now ?? ''),
    }];
}

/**
 * 改期（同 id 且仍 open 才允许；已兑现/已泄露/已超期的不能再改期——
 * 与 foreshadowSetup 的改期语义同构：终态锁定）。
 */
export function pledgeReplan(list, id, { deadlineChapter, now = '' }) {
    const p = list.find((x) => x.id === id);
    if (p === undefined) throw new Error(`契约不存在：${id}`);
    if (p.status !== 'open') {
        throw new Error(`契约 ${id} 已是 ${p.status} 态，不能再改期（终态锁定）`);
    }
    if (!Number.isInteger(deadlineChapter) || deadlineChapter < 1) {
        throw new Error('改期必须给正整数 deadlineChapter');
    }
    if (deadlineChapter < p.chapter) {
        throw new Error(`改期章（第${deadlineChapter}章）早于立下章（第${p.chapter}章）`);
    }
    // 改期次数上限：不然「永久延期」可以把到期告警无限静音（每次写章都点名，模型改一次期就
    // 免一次），账本里看起来一切正常。超上限只能兑现/违背/揭晓，或新建契约重新规划。
    const replans = Number.isInteger(p.replans) ? p.replans : 0;
    if (replans >= MAX_PLEDGE_REPLANS) {
        throw new Error(`契约 ${id} 已改期 ${replans} 次（上限 ${MAX_PLEDGE_REPLANS}）——不能无限延期：到期前请登记兑现/违背/揭晓（pledge_resolve），确需重排就新建契约`);
    }
    return list.map((x) => (x.id === id
        ? { ...x, deadlineChapter, replans: replans + 1, ts: String(now ?? x.ts ?? '') }
        : x));
}

/**
 * 登记终态：kept（承诺遵守）/ broken（承诺违背）/ revealed（秘密揭晓）。
 * 只有 open 的契约能进终态；终态不可逆（与 foreshadowPayoff 同纪律）。
 *
 * expired 不在合法终态里：它是**代码判定的派生态**（到期且仍 open，由 detectExpiredPledges /
 * pledgeAudit 算出「已逾期」），不是作者的手工结论。允许手工登记 expired 等于给「假装这
 * 件事已经过去了」开一道门——真没兑现就登记 broken，还在还就 kept（或按上限改期）。
 */
export function pledgeResolve(list, id, { status, note = '', now = '' }) {
    const p = list.find((x) => x.id === id);
    if (p === undefined) throw new Error(`契约不存在：${id}`);
    if (p.status !== 'open') {
        throw new Error(`契约 ${id} 已是 ${p.status} 态，不能再登记终态`);
    }
    const legal = p.kind === 'secret'
        ? ['revealed']
        : ['kept', 'broken'];
    if (status === 'expired') {
        throw new Error(`契约 ${id} 不能手工登记为 expired——「到期未兑现」是代码算出来的派生态（每次写章/体检会自动点名），终态只能登记 kept/broken${p.kind === 'secret' ? '/revealed' : ''}`);
    }
    if (!legal.includes(status)) {
        throw new Error(`契约 ${id}（kind=${p.kind}）不能登记为 ${status}——legal=${legal.join('/')}`);
    }
    return list.map((x) => (x.id === id ? { ...x, status, note: String(note ?? ''), ts: String(now ?? x.ts ?? '') } : x));
}

/**
 * 代码判定的超期：maxWritten >= deadlineChapter 且仍 open → 标记 expired（**不改原数组**，
 * 返回 { list, expiredIds }；调用方决定是否落盘——与 content-gate 的「只报不写」纪律一致）。
 *
 * 为什么不让 pledgeResolve 自动判：登记动作是**留痕**（「我核对过」），自动改状态
 * 等于让代码替作者做语义判断——违背 AGENTS.md「代码强制 > 提示词自觉」的分寸：
 * 代码强制的是**到期这件事的可见性**（每次写章/体检都点名），不是替作者判「到底兑现没」。
 */
export function detectExpiredPledges(list, maxWritten) {
    if (!Number.isInteger(maxWritten) || maxWritten < 1) return { list, expiredIds: [] };
    const expiredIds = [];
    const out = list.map((p) => {
        if (p.status === 'open' && p.deadlineChapter !== null && p.deadlineChapter !== undefined
            && Number.isInteger(p.deadlineChapter) && maxWritten >= p.deadlineChapter) {
            expiredIds.push(p.id);
            return { ...p, status: 'expired' };
        }
        return p;
    });
    return { list: out, expiredIds };
}

/**
 * 结构化审计（对齐火宝五类逻辑审计 + 定位到实体/章节）。
 *
 * 返回 issues 数组，每条 {
 *   severity, code, where, message,
 *   nodeIds,     // 该契约涉及的实体名（subject + 关键词）——面板点跳
 *   edgeIds: [], // 契约账本暂无关系边，留位与火宝 schema 对齐
 *   chapters     // [立下章, 到期章?, 终态章?]——面板定位章节区间
 * }
 *
 * 检查三类（保守：宁漏勿误，只报能代码判定的）：
 *   1. pledge-expired      deadline 到期未兑现（warning；secret 同档报 secret-overdue）
 *   2. pledge-broken-later broken 契约之后仍开新钩/新线（error——欠账未还）
 *   3. secret-overdue      secret 到期未揭晓（warning）
 * 「secret 提前揭晓」**有意不查**：revealed 是显式登记动作，早于期限的揭晓本身合法
 *   （提前揭底是作者的自由）；倒挂（revealed 章早于立下章）只意味着登记章号填错，
 *   靠 pledge-duplicate-id 与人工复核兜底，不值得为它加一条会误伤正常提前揭晓的规则。
 */
export function pledgeAudit(list, { maxWritten = 0, dueDebts = [] } = {}) {
    const issues = [];
    const rows = (list ?? []).filter(validPledgeRow);
    const max = Number.isInteger(maxWritten) && maxWritten > 0 ? maxWritten : 0;
    for (const p of rows) {
        const nodeIds = [p.subject].filter((x) => typeof x === 'string' && x.trim() !== '');
        const base = { nodeIds, edgeIds: [], chapters: [p.chapter, ...(p.deadlineChapter ? [p.deadlineChapter] : [])] };

        // 1/3 到期未兑现
        if (p.status === 'open' && p.deadlineChapter !== null && p.deadlineChapter !== undefined
            && Number.isInteger(p.deadlineChapter) && max >= p.deadlineChapter) {
            const isSecret = p.kind === 'secret';
            issues.push({
                severity: 'warning',
                code: isSecret ? 'secret-overdue' : 'pledge-expired',
                where: `${p.id}·${p.subject || p.kind}`,
                message: isSecret
                    ? `秘密「${p.id}」（${p.statement}）预计第${p.deadlineChapter}章揭晓，已写到第${max}章仍未 reveal——秘密拖太久读者会忘，或已被别的线索提前拆穿；安排揭晓或 novel_ledger pledge_replan 改期`
                    : `契约「${p.id}」（${p.statement}）到期第${p.deadlineChapter}章未兑现，已写到第${max}章——欠账未还，先兑现（登记 pledge_keep）或明确放弃（登记 pledge_break）`,
                ...base,
            });
        }

        // 2 broken 契约仍开新钩（复用 content-gate 的欠账机制：dueDebts 非空 = 本章已到期未还）
        if (p.status === 'broken' && dueDebts.length > 0) {
            issues.push({
                severity: 'error',
                code: 'pledge-broken-later',
                where: `${p.id}·${p.subject || p.kind}`,
                message: `契约「${p.id}」已登记为 broken（${p.statement}），同时有 ${dueDebts.length} 条到期未还伏笔——欠账未还禁开新线，先还旧账（兑现承诺或安排回收）`,
                ...base,
            });
        }
        // （第 4 类「secret-revealed-early」有意不查——见上方 JSDoc 的取舍说明。）
    }
    // 同 id 重复登记（历史遗留）
    const seen = new Map();
    for (const p of rows) {
        if (seen.has(p.id)) {
            issues.push({
                severity: 'error', code: 'pledge-duplicate-id', where: `契约 ${p.id}`,
                message: `契约 id「${p.id}」重复登记——id 必须唯一，否则改期/终态登记会打到错误条目`,
                nodeIds: [p.subject].filter((x) => typeof x === 'string' && x.trim() !== ''),
                edgeIds: [], chapters: [p.chapter],
            });
        }
        seen.set(p.id, p);
    }
    return issues;
}

/** 一行摘要（供 audit / digest 渲染）。 */
export function pledgeDigest(list, maxWritten = 0) {
    const rows = (list ?? []).filter(validPledgeRow);
    if (rows.length === 0) return '叙事契约账本：空 ✓';
    const open = rows.filter((p) => p.status === 'open').length;
    const broken = rows.filter((p) => p.status === 'broken').length;
    const revealed = rows.filter((p) => p.status === 'revealed').length;
    // expired 是派生态：不在落盘数据里，digest 每次按 maxWritten 现算（只报不写）。
    const { expiredIds } = detectExpiredPledges(rows, maxWritten);
    const issues = pledgeAudit(rows, { maxWritten });
    const head = `叙事契约：${rows.length} 条（open ${open} / broken ${broken} / revealed ${revealed}${expiredIds.length > 0 ? ` / 已到期未结 ${expiredIds.length}（${expiredIds.join('、')}）` : ''}）`;
    if (issues.length === 0) return `${head} —— 无到期未兑现 ✓`;
    return `${head}\n${issues.slice(0, 10).map((i) => `${i.severity === 'error' ? '✗' : '⚠'} [${i.code}] ${i.message}`).join('\n')}`;
}

/**
 * 写章简报用的「契约到期」段（纯函数，零 token）。
 *
 * 为什么简报必须读 pledges：到期告警此前只在 content-gate（写完落盘前）与体检里出现，
 * 都属于「事后」。写作前看不到「本章欠着哪几条契约」，模型只能凭记忆——正是提示词自觉。
 *
 * @param list     契约账本
 * @param chapter  即将写的章号
 * @param limit    未到期契约最多列几条（默认 4）
 * @returns 渲染好的文本段（无 open 契约时返回空串，调用方据此跳过该段）
 */
export function pledgeBriefingSection(list, chapter, { limit = 4 } = {}) {
    const rows = (list ?? []).filter(validPledgeRow).filter((p) => p.status === 'open');
    if (rows.length === 0) return '';
    const ch = Number.isInteger(chapter) && chapter > 0 ? chapter : 0;
    const line = (p) => {
        const who = p.subject ? `·${p.subject}` : '';
        const dueTxt = Number.isInteger(p.deadlineChapter) ? `·到期第${p.deadlineChapter}章` : '';
        return `${p.id}（${p.kind}${who}·第${p.chapter}章立${dueTxt}）：${p.statement}`;
    };
    const due = rows
        .filter((p) => Number.isInteger(p.deadlineChapter) && p.deadlineChapter <= ch)
        .sort((a, b) => a.deadlineChapter - b.deadlineChapter);
    const later = rows
        .filter((p) => !(Number.isInteger(p.deadlineChapter) && p.deadlineChapter <= ch))
        .sort((a, b) => (Number.isInteger(a.deadlineChapter) ? a.deadlineChapter : Infinity)
            - (Number.isInteger(b.deadlineChapter) ? b.deadlineChapter : Infinity))
        .slice(0, limit);
    const parts = [];
    if (due.length > 0) {
        parts.push(`≤本章已到期（必须回应/兑现，否则 novel_ledger pledge_resolve 登记 kept/broken）：\n${due.map(line).join('\n')}`);
    }
    if (later.length > 0) parts.push(`未到期：\n${later.map(line).join('\n')}`);
    return parts.join('\n');
}
