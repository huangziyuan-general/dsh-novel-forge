// lib/voice.js — 语言基因卡（纯函数，零 token）。
//
// 来源：多核协同的「灵魂四维 + 语言基因卡」——句长习惯 / 逻辑风格 / 口头禅 / 禁忌词 /
// 标志性小动作 / 语域。核的理念是**拒绝贴标签**（好人/坏人/高冷一律不用），
// 人物靠「怎么说话」立起来，而不是靠形容词。
//
// 本插件适配：语言基因卡从「人物卡里的一句话」升级为**结构化实体**
// （`设定/语言基因.json`，键 = 人物名），原因是：
//   ① 结构化才能在写章时单独注入成醒目区块（现在只混在人物卡正文里，模型容易滑过去）
//   ② 结构化才能跑 `voiceConsistency`：有台词却没一句口头禅、说了自己的禁忌词——这些能算
//
// 判定边界：禁忌词命中是**硬事实**（用户声明的「绝不说」）；口头禅缺失只算**提示**
// （口头禅是习惯不是义务，一章不说也正常）。不给模型扣「OOC」的帽子，只报事实。

/** 六个字段：中文别名用于解析模型/用户的口语化输入。list=true 的字段是多值。 */
export const VOICE_FIELDS = [
    { key: 'sentence', label: '句长习惯', aliases: ['sentence', '句长', '句子', '句法', '语速'], list: false },
    { key: 'logic', label: '逻辑风格', aliases: ['logic', '逻辑', '思维', '表达顺序'], list: false },
    { key: 'tics', label: '口头禅', aliases: ['tics', '口头禅', '口癖', '习惯语', '高频词'], list: true },
    { key: 'taboo', label: '绝不说', aliases: ['taboo', '禁忌', '禁忌词', '雷区', '不说的'], list: true },
    { key: 'gesture', label: '标志性小动作', aliases: ['gesture', '动作', '小动作', '习惯动作'], list: false },
    { key: 'register', label: '语域', aliases: ['register', '语域', '语气', '腔调', '口音'], list: false },
];

const LIST_KEYS = VOICE_FIELDS.filter((f) => f.list).map((f) => f.key);

function fieldByAlias(name) {
    const key = String(name ?? '').trim().toLowerCase();
    return VOICE_FIELDS.find((f) => f.key === key || f.aliases.includes(key)) ?? null;
}

/** 剥掉值两端的中文/英文引号与书名号（口头禅常写成「呵」）。 */
function stripQuotes(s) {
    return String(s ?? '').trim().replace(/^[「『“"'《【(（]+/, '').replace(/[」』”"'》】)）]+$/, '').trim();
}

function splitList(v) {
    const arr = Array.isArray(v) ? v : String(v ?? '').split(/[,，、;；/]+/);
    const out = [];
    for (const raw of arr) {
        const s = stripQuotes(raw);
        if (s !== '' && !out.includes(s)) out.push(s);
    }
    return out;
}

/**
 * 归一化语言基因卡。
 * @param input 对象 {sentence, logic, tics, taboo, gesture, register}（键可用中文别名），
 *              或多行字符串「句长|短句为主」「口头禅|呵,行吧」
 */
export function normalizeVoice(input) {
    const raw = {};
    if (typeof input === 'string') {
        for (const line of input.split('\n')) {
            const m = line.match(/^\s*([^|:：]+?)\s*[|:：]\s*(.+?)\s*$/);
            if (m === null) continue;
            const f = fieldByAlias(m[1]);
            if (f !== null) raw[f.key] = m[2];
        }
    } else if (input !== null && typeof input === 'object') {
        for (const [k, v] of Object.entries(input)) {
            const f = fieldByAlias(k);
            if (f !== null && v !== undefined && v !== null && String(v).trim() !== '') raw[f.key] = v;
        }
    }
    const out = {};
    for (const f of VOICE_FIELDS) {
        if (raw[f.key] === undefined) continue;
        if (f.list) {
            const list = splitList(raw[f.key]);
            if (list.length > 0) out[f.key] = list;
        } else {
            const s = String(raw[f.key]).trim();
            if (s !== '') out[f.key] = s;
        }
    }
    return out;
}

/** 是否为空卡（六个字段一个都没填）。 */
export function isEmptyVoice(voice) {
    return VOICE_FIELDS.every((f) => voice?.[f.key] === undefined);
}

/**
 * 渲染成注入区块（写章时与人物卡并列，但更醒目——它管的是「怎么说话」）。
 * 空卡返回 ''（不占预算）。
 */
export function renderVoiceCard(name, voice) {
    const v = voice ?? {};
    const lines = [];
    for (const f of VOICE_FIELDS) {
        const val = v[f.key];
        if (val === undefined) continue;
        const text = Array.isArray(val) ? val.map((x) => `「${x}」`).join(' ') : val;
        lines.push(`${f.label}：${text}`);
    }
    if (lines.length === 0) return '';
    return `【${name}·说话方式】\n${lines.join('\n')}`;
}

/** 对话标记（判断「这个角色本章有没有开口」）。 */
const SPEECH_MARK = /[「『“"]/;

/**
 * 语言一致性巡检（纯函数）。
 *
 * @param inputs { content, voices:[{name, voice}] }
 * @returns { checked, items:[{name, spoken, ticsHit, tabooHits}], issues, stats }
 */
export function voiceConsistency({ content, voices = [] } = {}) {
    const text = String(content ?? '');
    const lines = text.split('\n');
    const items = [];
    const issues = [];

    for (const entry of voices ?? []) {
        const name = String(entry?.name ?? '').trim();
        const voice = entry?.voice ?? {};
        if (name === '' || isEmptyVoice(voice)) continue;
        // 本章该角色是否有台词：含其名的行里出现对话标记（近似——名字与引号同行即算）
        const spoken = lines.some((l) => l.includes(name) && SPEECH_MARK.test(l));
        const tics = voice.tics ?? [];
        const ticsHit = tics.filter((t) => t !== '' && text.includes(t));
        const tabooHits = (voice.taboo ?? []).filter((t) => t !== '' && text.includes(t));

        items.push({ name, spoken, ticsHit, tabooHits });

        for (const t of tabooHits) {
            issues.push({
                severity: 'error',
                code: 'voice-taboo',
                name,
                message: `「${name}」的禁忌词「${t}」出现在本章正文——这是声明过的「绝不说」，除非人物弧光刻意翻转，否则属于说错话`,
            });
        }
        if (spoken && tics.length > 0 && ticsHit.length === 0) {
            issues.push({
                severity: 'warning',
                code: 'voice-tics-missing',
                name,
                message: `「${name}」本章有台词，但没有一句口头禅（${tics.map((t) => `「${t}」`).join('、')}）——多角色同台时最容易「千人一腔」，建议给一句`,
            });
        }
    }

    return {
        checked: items.length,
        items,
        issues,
        stats: { errors: issues.filter((i) => i.severity === 'error').length, warnings: issues.filter((i) => i.severity === 'warning').length },
    };
}
