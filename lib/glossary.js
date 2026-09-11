// lib/glossary.js — 纯函数：术语表存储逻辑。
// 术语表是 Worldbook 的轻量补充：多是一个词条一句话，写章时随上下文包注入，防专有名词乱译。

/** 校验归一化一条术语。 */
export function normalizeTerm({ term, definition }) {
    if (typeof term !== 'string' || term.trim() === '') throw new Error('术语 term 不能为空');
    if (typeof definition !== 'string' || definition.trim() === '') throw new Error('术语 definition 不能为空');
    return { term: term.trim(), definition: definition.trim() };
}

/** 追加/覆盖（同名覆盖）。返回新列表。 */
export function upsertTerm(list, t) {
    const n = normalizeTerm(t);
    const i = (list ?? []).findIndex((x) => x.term === n.term);
    if (i === -1) return [...(list ?? []), n];
    const next = [...(list ?? [])];
    next[i] = n;
    return next;
}

export function removeTerm(list, term) {
    return (list ?? []).filter((x) => x.term !== term);
}

export function termsDigest(list, limit = 40) {
    return (list ?? []).slice(0, limit).map((t) => `${t.term}：${t.definition}`);
}