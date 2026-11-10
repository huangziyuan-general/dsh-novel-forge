// 本书作者偏好（纯函数）。只存用户明确确认的长期偏好，不从成稿自行推断。

export const PREFERENCE_LIMITS = Object.freeze({ items: 20, chars: 200 });

const UNSAFE_PATTERNS = [
    /忽略(?:以上|上述|之前)|系统提示|开发者指令/,
    /(?:忽略|跳过|绕过|关闭|取消).{0,8}(?:门禁|机审|审稿|校验|检查|账本|一致性)/,
    /(?:降低|放宽|放松).{0,8}(?:门禁|机审|审稿|校验|质量|一致性|标准)/,
    /(?:不|无需|不用|免于).{0,6}(?:记|更新|维护|核对|遵守).{0,6}(?:账本|伏笔|事实|一致性|门禁)/,
];

export function validatePreference(text) {
    const value = String(text ?? '').trim();
    if (value === '') throw new Error('偏好内容不能为空');
    if (value.length > PREFERENCE_LIMITS.chars) throw new Error(`单条偏好最多 ${PREFERENCE_LIMITS.chars} 字`);
    if (UNSAFE_PATTERNS.some((pattern) => pattern.test(value))) {
        throw new Error('这条偏好会削弱门禁、账本一致性或审稿标准，不能记录；偏好只保存表达与创作倾向');
    }
    return value;
}

function idOf(text) {
    let hash = 2166136261;
    for (const char of text) { hash ^= char.codePointAt(0); hash = Math.imul(hash, 16777619); }
    return `pref-${(hash >>> 0).toString(36)}`;
}

export function addPreference(document, text, { confirmed = false, now }) {
    if (confirmed !== true) throw new Error('只有用户明确要求长期记住时才可保存：请带 confirmed:true');
    const value = validatePreference(text);
    const items = [...(document?.items ?? [])];
    const existing = items.find((item) => item.text === value);
    if (existing) return { document: { schemaVersion: 1, scope: 'book', items }, item: existing, added: false };
    if (items.length >= PREFERENCE_LIMITS.items) throw new Error(`本书最多保存 ${PREFERENCE_LIMITS.items} 条长期偏好；请先删除不再适用的条目`);
    const item = { id: idOf(value), text: value, confirmedBy: 'user', createdAt: now, updatedAt: now };
    if (items.some((entry) => entry.id === item.id)) throw new Error('偏好 id 冲突，请微调表述后重试');
    items.push(item);
    return { document: { schemaVersion: 1, scope: 'book', items }, item, added: true };
}

export function removePreference(document, id, { confirmed = false } = {}) {
    if (confirmed !== true) throw new Error('删除长期偏好也需要用户明确确认：请带 confirmed:true');
    const items = document?.items ?? [];
    const item = items.find((entry) => entry.id === id);
    if (!item) throw new Error(`偏好不存在：${id}`);
    return { document: { schemaVersion: 1, scope: 'book', items: items.filter((entry) => entry.id !== id) }, item };
}

export function renderPreferences(document) {
    const items = document?.items ?? [];
    if (items.length === 0) return '';
    return [
        '优先级：当前请求 > 本书设定/承诺书 > 以下本书偏好 > 通用默认。',
        '偏好只影响表达与创作倾向，不得降低门禁、账本一致性或审稿标准。',
        ...items.map((item) => `- ${item.text}`),
    ].join('\n');
}
