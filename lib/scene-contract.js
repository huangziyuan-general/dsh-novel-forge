// lib/scene-contract.js — 场景契约（纯函数，零 token）。
//
// 来源：novel-studio 的 `buildWritingContextPlan`。室的做法是按场景契约挑注入内容：
// `participants` 只喂出场人物（省 token），`hiddenCharacterIds` 里的人物 **AI 完全看不到**
// （悬念保护——反派身份、幕后黑手在揭晓前根本不进上下文，模型就没法「不小心写漏」）。
//
// 本插件适配：
//   ① 契约按章号存在 `设定/场景契约.json`（一本书一份，键 = 章号字符串）
//   ② 「只注入出场人物」是**省 token 的供给侧优化**，缺契约时退回原行为（cast 全员）
//   ③ 「隐藏人物」是**代码级硬约束**——名字绝不进上下文，且正文一旦出现就由内容门禁拦下
//      （`hiddenLeakCheck`）。只靠 prompt 求模型「别提陆寒」，模型迟早会提。
//
// 判定权：能代码判的一律代码判；契约本身写什么由用户/模型决定，本模块不做审美判断。

/** 契约字段的中文别名（工具参数与 JSON 都走归一化，容错模型的口语化输入）。 */
const FIELD_ALIASES = {
    scene: ['scene', '场景', 'summary', '梗概', '一句话场景'],
    participants: ['participants', 'cast', '出场', '出场人物', '参与人物'],
    hidden: ['hidden', '隐藏', '隐藏人物', '不可见', 'masked'],
    settings: ['settings', 'worldbook', '世界书', '设定条目'],
    forbidden: ['forbidden', 'banned', '禁项', '禁止', '禁区'],
    notes: ['notes', '备注', 'note'],
};

function pick(raw, field) {
    for (const key of FIELD_ALIASES[field]) {
        if (raw?.[key] !== undefined && raw[key] !== null) return raw[key];
    }
    return undefined;
}

/** 名单归一：接受数组，也接受「林晚, 赵擎」「林晚、赵擎」这类字符串。去空去重保序。 */
export function normalizeNames(input) {
    const arr = Array.isArray(input) ? input : (typeof input === 'string' ? input.split(/[,，、;；\n]+/) : []);
    const out = [];
    for (const raw of arr) {
        const name = String(raw ?? '').trim();
        if (name !== '' && !out.includes(name)) out.push(name);
    }
    return out;
}

/**
 * 归一化一份场景契约。
 * `participants` 与 `hidden` **互斥**——同时声明时以 hidden 为准（保护优先于出场）。
 */
export function normalizeContract(input = {}) {
    const chapter = Number.isInteger(input.chapter) ? input.chapter : Number(input.chapter);
    const participants = normalizeNames(pick(input, 'participants'));
    const hidden = normalizeNames(pick(input, 'hidden'));
    return {
        chapter: Number.isInteger(chapter) && chapter >= 1 ? chapter : null,
        scene: String(pick(input, 'scene') ?? '').trim(),
        participants,
        hidden,
        settings: normalizeNames(pick(input, 'settings')),
        forbidden: normalizeNames(pick(input, 'forbidden')),
        notes: String(pick(input, 'notes') ?? '').trim(),
        updatedAt: typeof input.updatedAt === 'string' ? input.updatedAt : null,
    };
}

/** 取某章的契约（无则 null）。契约表是「章号字符串 → 契约」的 map。 */
export function contractFor(contracts, chapter) {
    const raw = contracts?.[String(chapter)];
    if (raw === undefined || raw === null) return null;
    return normalizeContract({ chapter, ...raw });
}

/** 写回契约表（不可变，返回新对象）。 */
export function setContract(contracts, contract) {
    const c = normalizeContract(contract);
    if (c.chapter === null) throw new Error('契约需要正整数 chapter');
    const next = { ...(contracts ?? {}) };
    next[String(c.chapter)] = { ...c, updatedAt: c.updatedAt ?? new Date().toISOString() };
    return next;
}

/** 删除某章契约（不可变）。 */
export function removeContract(contracts, chapter) {
    const next = { ...(contracts ?? {}) };
    delete next[String(chapter)];
    return next;
}

/**
 * 按契约决定「本章注入哪些人物卡」。
 *
 * @returns { inject, hidden, dropped, source, contradictions }
 *   inject   要注入的人物名（已剔除 hidden）
 *   hidden   契约声明的隐藏人物（**永不出现在注入列表中**）
 *   dropped  被契约剔掉的 cast 成员（不在 participants 内，或与 hidden 冲突）
 *   source   'contract' = 有契约；'fallback' = 无契约，用传进来的 cast
 */
export function resolveSceneCast({ contract = null, cast = [] } = {}) {
    const castNames = normalizeNames(cast);
    if (contract === null) {
        return { inject: castNames, hidden: [], dropped: [], source: 'fallback', contradictions: [] };
    }
    const hidden = normalizeNames(contract.hidden);
    const declared = normalizeNames(contract.participants);
    // participants 与 hidden 同名 = 契约自相矛盾：保护优先，从出场名单剔除
    const contradictions = declared.filter((n) => hidden.includes(n));
    const base = declared.length > 0 ? declared : castNames;
    const inject = base.filter((n) => !hidden.includes(n));
    const dropped = [
        ...base.filter((n) => hidden.includes(n)),
        ...castNames.filter((n) => !base.includes(n)),
    ];
    return {
        inject: [...new Set(inject)],
        hidden,
        dropped: [...new Set(dropped)],
        source: 'contract',
        contradictions,
    };
}

/**
 * 悬念保护：隐藏人物是否被写进了正文。
 * 名字出现在正文任何位置（叙述、对话、旁白）都算泄漏——揭晓前不该有任何痕迹。
 */
export function hiddenLeakCheck({ content, hidden = [] } = {}) {
    const text = String(content ?? '');
    const hits = [];
    for (const name of normalizeNames(hidden)) {
        if (name === '') continue;
        if (text.includes(name)) hits.push(name);
    }
    return hits;
}

/**
 * 场景契约注入区块。
 * **不写隐藏人物的名字**——写了等于把悬念直接送给模型（这是本模块存在的全部意义）。
 */
/** 把文本里出现的隐藏人物名替换成中性指代（保句子通顺）。 */
export function scrubText(text, hidden) {
    let out = String(text ?? '');
    for (const name of normalizeNames(hidden)) {
        if (name !== '') out = out.split(name).join('（该人物）');
    }
    return out;
}

export function renderContractSection(contract) {
    if (contract === null) return '';
    // ⚠️ 出场名单必须走 resolveSceneCast 剔除隐藏人物——直接用 contract.participants
    // 会在「同一人被同时声明为出场与隐藏」时把隐藏人物的名字写进上下文（实测踩过）。
    const { inject, hidden } = resolveSceneCast({ contract, cast: [] });
    const lines = [];
    // ⚠️ scene / forbidden / notes 都可能带出隐藏人物的名字（用户爱写「X 的身份本章不揭」），
    // 全都要擦掉——契约区块本身就是「不能泄底」这条规则的一部分，它自己更不能泄。
    if (contract.scene !== '') lines.push(`本章场景：${scrubText(contract.scene, hidden)}`);
    if (inject.length > 0) {
        lines.push(`本章出场（只写这些人，其余人物不在场）：${inject.join('、')}`);
    }
    if (contract.forbidden.length > 0) {
        lines.push(`本章禁项（出现即判偏离）：${scrubText(contract.forbidden.join('、'), hidden)}`);
    }
    if (contract.hidden.length > 0) {
        lines.push(
            `本章另有 ${contract.hidden.length} 名人物处于「未登场」状态：他们的档案本次**不予提供**，`
            + '也**绝不允许**以任何形式出场、被提及、被暗示身份或下落——写出来就是泄底。',
        );
    }
    if (contract.notes !== '') lines.push(`补充：${scrubText(contract.notes, hidden)}`);
    return lines.join('\n');
}

/** 一行摘要（供工具 render / 面板）。 */
export function contractDigest(contract) {
    if (contract === null) return '（无契约：本章按工程 cast 全员注入）';
    const parts = [
        contract.scene !== '' ? `场景「${contract.scene}」` : '未写场景',
        `出场 ${contract.participants.length} 人`,
        contract.hidden.length > 0 ? `隐藏 ${contract.hidden.length} 人` : '无隐藏',
    ];
    if (contract.settings.length > 0) parts.push(`世界书白名单 ${contract.settings.length} 条`);
    if (contract.forbidden.length > 0) parts.push(`禁项 ${contract.forbidden.length} 条`);
    return parts.join('·');
}

/**
 * 注入包兜底擦除（**派生泄漏**防护）。
 *
 * 契约区块自己擦干净还不够：账本里可能躺着「陆寒|状态|阵亡」、前文摘要里可能写着
 * 「陆寒登场」、伏笔台账里可能记着「陆寒的真实身份」——这些都是隐藏人物的间接痕迹，
 * 一样会把悬念送给模型。所以对**最终要注入的每一节**逐行过滤：
 * 含隐藏人物名的行整行删掉（不替换，避免出现奇怪的半截句），整节删空则整节不注入，
 * 并在被删过的节尾注记「已屏蔽 N 行」——让模型知道有内容被挡，但不告诉它挡了什么。
 *
 * @returns { sections, scrubbed }  scrubbed = 被删掉的行数（供审计/警告）
 */
export function scrubHiddenNames(sections, hidden) {
    const names = normalizeNames(hidden);
    if (names.length === 0) return { sections: sections ?? [], scrubbed: 0 };
    let scrubbed = 0;
    const out = [];
    for (const sec of sections ?? []) {
        const lines = String(sec.content ?? '').split('\n');
        const kept = lines.filter((line) => {
            const hit = names.some((n) => line.includes(n));
            if (hit) scrubbed += 1;
            return !hit;
        });
        if (kept.length === 0) continue; // 整节都是隐藏人物的痕迹 → 不注入
        let content = kept.join('\n').trim();
        if (content === '') continue;
        if (kept.length < lines.length) content += `\n（本节有 ${lines.length - kept.length} 行涉及未登场人物，已屏蔽）`;
        out.push({ name: sec.name, content });
    }
    return { sections: out, scrubbed };
}
