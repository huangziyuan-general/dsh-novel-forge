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

/**
 * 七个字段：中文别名用于解析模型/用户的口语化输入。list=true 的字段是多值。
 * rules 是 0.20.x 的**加法字段**：把「行为规则」（如「不与人争辩第二句」）从 taboo 里分层出来。
 * 老 taboo 内容原样保留，迁移只新增 rules；voiceConsistency 只对可匹配短语做命中判定。
 */
export const VOICE_FIELDS = [
    { key: 'sentence', label: '句长习惯', aliases: ['sentence', '句长', '句子', '句法', '语速'], list: false },
    { key: 'logic', label: '逻辑风格', aliases: ['logic', '逻辑', '思维', '表达顺序'], list: false },
    { key: 'tics', label: '口头禅', aliases: ['tics', '口头禅', '口癖', '习惯语', '高频词'], list: true },
    { key: 'taboo', label: '绝不说', aliases: ['taboo', '禁忌', '禁忌词', '雷区', '不说的'], list: true },
    { key: 'rules', label: '行为规则', aliases: ['rules', 'rule', '行为规则', '行为习惯', '表达规则'], list: true },
    { key: 'gesture', label: '标志性小动作', aliases: ['gesture', '动作', '小动作', '习惯动作'], list: false },
    { key: 'register', label: '语域', aliases: ['register', '语域', '语气', '腔调', '口音'], list: false },
    // 0.20.x 加法字段：长描述（动作/语域的完整原文）没有人物卡可落时的归档位。
    // 不参与写章注入与命中判定——它是给人看的备注，渲染时跳过（避免又塞回上下文）。
    { key: 'notes', label: '补充说明', aliases: ['notes', '备注', '补充说明'], list: true },
];

const LIST_KEYS = VOICE_FIELDS.filter((f) => f.list).map((f) => f.key);

function fieldByAlias(name) {
    const key = String(name ?? '').trim().toLowerCase();
    return VOICE_FIELDS.find((f) => f.key === key || f.aliases.includes(key)) ?? null;
}

// ── 列表切分（引号/括号感知）────────────────────────────────────────────────
//
// 旧实现直接 String.split(/[,，、;；/]+/)：**引号内的逗号也会被切开**——真机数据里
// 引号口头禅在逗号处被拦腰切开的残片就是这么来的（原句一旦被切碎就再也拼不回去）。
// 新口径：只在**括号/引号深度为 0**时认分隔符；引号或括号里的分隔符属于内容。
//   成对： 「」『』“”‘’（）()【】《》[] {} 以及 ASCII 双引号（成对开合）
//   嵌套： 用栈，内层先闭合；不配平的残片按普通字符处理（不吞掉后文）
//   并列： 「呵」「行吧」这类紧邻的两个引号项在闭合符后直接断项（无分隔符也认）
//   收尾： 每项剥两端标点/引号/空白，空项丢弃、完全相同的项去重（旧行为保留）
const SEPARATOR_RE = /[,，、;；/]/;
const PAIR_CLOSE = {
    '「': '」', '『': '』', '“': '”', '‘': '’',
    '（': '）', '(': ')', '【': '】', '《': '》', '[': ']', '{': '}', '｛': '｝',
};
/** 两端要剥掉的标点（中文标点 + 常见英文标点 + 引号括号）。只剥两端，不动中间。 */
const EDGE_PUNCT_RE = /[\s，,、；;：:。．.！!？?…·—－\-~～"'“”‘’「」『』（）()【】《》[\]{}]/;
/** 引号/括号字符：写入口头禅时一律禁止（残片判定另用 hasUnbalancedBrackets，配对的引文不算坏）。 */
const BRACKET_CHAR_RE = /[「」『』“”‘’"'（）()【】《》[\]{}]/;
/** 收尾符 → 开符（判断「这个右括号是不是内容的一部分」）。 */
const PAIR_OPEN = Object.fromEntries(Object.entries(PAIR_CLOSE).map(([o, c]) => [c, o]));

function countAsciiQuotes(s) {
    let n = 0;
    for (const ch of s) if (ch === '"') n += 1;
    return n;
}

/**
 * 剥两端标点，但**不剥内容里的成对括号**：
 *   「甲（乙，丙）」 → 甲（乙，丙）  （外层引号剥掉，内层括号是内容）
 *   叫他「哥」       → 叫他「哥」    （右引号有配对开引号，保留）
 *   「呵」           → 呵
 * keepTerminal=true（存量修复用）：句末标点（。！？…）留在值里，只剥分隔用的引号/括号。
 * 为什么存量修复要保留句末标点：「哦。」剥成「哦」后，voiceConsistency 的 includes
 * 命中面从「整句」放大到「任意一个哦」——统计会失真。结构分层（taboo→rules）不受影响。
 */
function stripEdges(s, { keepTerminal = false } = {}) {
    let t = String(s ?? '').trim();
    // ① 整项被同一对引号/括号包住时，逐层剥外层
    for (;;) {
        const first = t[0];
        const last = t[t.length - 1];
        if (t.length < 2) break;
        if (PAIR_CLOSE[first] !== undefined && PAIR_CLOSE[first] === last) {
            t = t.slice(1, -1).trim();
            continue;
        }
        if (first === '"' && last === '"' && countAsciiQuotes(t) % 2 === 0) {
            t = t.slice(1, -1).trim();
            continue;
        }
        break;
    }
    // ② 两端残余普通标点：右括号只有在找不到配对开符时才剥
    // keepTerminal（存量修复）只做外层成对引号/括号的剥离，**不再剥任何残余边标点**——
    // 「小烬啊——」这种尾巴也是原文，剥掉就不是"只修切分"了。
    if (keepTerminal) return t;
    while (t !== '') {
        const ch = t[0];
        if (!EDGE_PUNCT_RE.test(ch)) break;
        if (PAIR_CLOSE[ch] !== undefined && t.includes(PAIR_CLOSE[ch])) break;
        t = t.slice(1).trimStart();
    }
    while (t !== '') {
        const ch = t[t.length - 1];
        if (!EDGE_PUNCT_RE.test(ch)) break;
        if (PAIR_OPEN[ch] !== undefined && t.includes(PAIR_OPEN[ch])) break;
        t = t.slice(0, -1).trimEnd();
    }
    return t;
}

/** 把一段文本按「深度 0 的逗号/顿号/分号/斜杠」切成条目。 */
function splitListText(text, opts = {}) {
    const out = [];
    let buf = '';
    const stack = [];
    let prevWasClose = false;
    const commit = () => {
        const item = stripEdges(buf, opts);
        if (item !== '' && !out.includes(item)) out.push(item);
        buf = '';
    };
    for (const ch of String(text ?? '')) {
        const top = stack[stack.length - 1];
        // 栈顶的收尾符：配对出栈；不配对的收尾符按普通字符（残片不再连累后文）
        if (top !== undefined && ch === top) {
            stack.pop();
            buf += ch;
            prevWasClose = true;
            continue;
        }
        // ASCII 双引号按开合轮换（中文引号已由 PAIR_CLOSE 处理）
        if (ch === '"') {
            if (top === '"') stack.pop(); else stack.push('"');
            buf += ch;
            prevWasClose = false;
            continue;
        }
        if (PAIR_CLOSE[ch] !== undefined) {
            // 紧跟在闭合符后面又开一个新引号/括号 = 并列的两项（「呵」「行吧」）
            if (stack.length === 0 && prevWasClose && buf !== '') commit();
            stack.push(PAIR_CLOSE[ch]);
            buf += ch;
            prevWasClose = false;
            continue;
        }
        if (stack.length === 0 && SEPARATOR_RE.test(ch)) {
            commit();
            prevWasClose = false;
            continue;
        }
        buf += ch;
        prevWasClose = false;
    }
    commit();
    return out;
}

function splitList(v, opts = {}) {
    const chunks = Array.isArray(v) ? v : [v];
    const out = [];
    for (const chunk of chunks) {
        if (chunk === undefined || chunk === null) continue;
        for (const item of splitListText(chunk, opts)) {
            if (!out.includes(item)) out.push(item);
        }
    }
    return out;
}

/** 行为规则 ≠ 可匹配短语：后者能在正文里被 includes 命中，前者描述「怎么做」。 */
const RULE_PREFIX_RE = /^(?:从不|绝不|从来不|永远不|始终不|一律|必须|务必|禁止|严禁|不许|不准|不|别|勿|莫|只|仅)/;
const RULE_MARK_RE = /(?:争辩|反驳|解释|自称|抢话|插话|第二句|第三句|一句话|一个字)/;

/**
 * 这条 taboo/tics 是不是「行为规则」而不是可匹配短语？
 * 经验判据（保守优先，误判只影响统计口径，不影响正文）：
 *   ① 明确的规则词（从不/绝不/必须/禁止/不许/不准…）
 *   ② 以否定/限定词开头且 ≥6 字（如「不与人争辩第二句」「只自称“我”」）
 *   ③ 含行为动词（争辩/反驳/解释/自称…）
 * 长度 <5 的短条目一律按可匹配短语（「绝不」这种残片可能只是没写完的禁用词，
 * 不能因为带规则词就把它从命中统计里踢掉）。
 */
export function isBehaviorRule(s) {
    const t = String(s ?? '').trim();
    const len = [...t].length;
    if (len < 5) return false;
    if (/^(?:从不|绝不|从来不|永远不|始终不|一律|必须|务必|禁止|严禁|不许|不准)/.test(t)) return true;
    if (len >= 6 && RULE_PREFIX_RE.test(t)) return true;
    return RULE_MARK_RE.test(t);
}

/** 引号/括号是否不配平（配对的内嵌引文不算残片，只有缺一边才是）。 */
function hasUnbalancedBrackets(s) {
    const stack = [];
    for (const ch of String(s ?? '')) {
        if (ch === '"') {
            if (stack[stack.length - 1] === '"') stack.pop(); else stack.push('"');
            continue;
        }
        if (PAIR_CLOSE[ch] !== undefined) {
            stack.push(PAIR_CLOSE[ch]);
            continue;
        }
        if (PAIR_OPEN[ch] !== undefined) {
            if (stack[stack.length - 1] === ch) stack.pop(); else return true;
        }
    }
    return stack.length > 0;
}

/** 可参与正文命中判定的条目（排除行为规则与引号/括号残片）。 */
export function matchableEntries(list) {
    return (Array.isArray(list) ? list : [])
        .map((x) => String(x ?? '').trim())
        .filter((x) => x !== '' && !hasUnbalancedBrackets(x) && !isBehaviorRule(x));
}

/**
 * 归一化语言基因卡。
 * @param input 对象 {sentence, logic, tics, taboo, rules, gesture, register}（键可用中文别名），
 *              或多行字符串「句长|短句为主」「口头禅|呵,行吧」
 */
export function normalizeVoice(input, opts = {}) {
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
            const list = splitList(raw[f.key], opts);
            if (list.length > 0) out[f.key] = list;
        } else {
            const s = String(raw[f.key]).trim();
            if (s !== '') out[f.key] = s;
        }
    }
    return out;
}

/**
 * 读取**落盘卡**时用：保留句末标点（存量卡已按此口径修过，读时再剥等于白修——
 * 「哦。」会退化成「哦」，命中面被放大）。写入侧 normalizeVoice 仍旧剥边标点。
 */
export function normalizeVoiceStored(input) {
    return normalizeVoice(input, { keepTerminal: true });
}

/** 写入侧校验：errors 必须拒绝写入；warnings 允许写入但要在工具输出里可见提示。 */
export function validateVoice(voice) {
    const v = voice ?? {};
    const errors = [];
    const warnings = [];
    const tics = Array.isArray(v.tics) ? v.tics : [];
    for (const raw of tics) {
        const t = String(raw ?? '').trim();
        if (t === '') continue;
        const len = [...t].length;
        if (len > 12) {
            errors.push({ field: 'tics', code: 'tic-too-long', item: t, message: `口头禅「${t}」有 ${len} 字，超过 12 字上限——口头禅要能反复出现，长句请拆成多条或挪到「句长习惯/行为规则」` });
        }
        if (BRACKET_CHAR_RE.test(t)) {
            errors.push({ field: 'tics', code: 'tic-bracket', item: t, message: `口头禅「${t}」里残留引号/括号——多半是分隔符切坏的碎片；请只保留短句本身（引号不必写进值里）` });
        }
    }
    for (const raw of Array.isArray(v.taboo) ? v.taboo : []) {
        const t = String(raw ?? '').trim();
        const migrated = Array.isArray(v.rules) && v.rules.includes(t);
        if (isBehaviorRule(t) && !migrated) {
            warnings.push({ field: 'taboo', code: 'taboo-rule', item: t, message: `禁忌项「${t}」是行为规则而不是可匹配短语（正文永远 includes 不到）；它不参与命中统计，建议迁到「行为规则」字段` });
        }
    }
    if (tics.length > 0 && matchableEntries(tics).length === 0) {
        warnings.push({ field: 'tics', code: 'card-unusable', item: '', message: '口头禅没有一条能参与命中判定（全是行为规则或引号残片）——「有台词无口头禅」的核对会形同虚设' });
    }
    return { ok: errors.length === 0, errors, warnings };
}

/**
 * 迁移语言基因卡（纯函数，加法式）：把 taboo 里的**行为规则**复制进 rules。
 * 老数据一字不丢：taboo 原数组完全保留，只新增 rules 字段并去重。
 */
export function migrateVoiceCard(voice) {
    const src = voice !== null && typeof voice === 'object' ? voice : {};
    const out = {};
    for (const f of VOICE_FIELDS) {
        if (src[f.key] === undefined) continue;
        out[f.key] = Array.isArray(src[f.key]) ? [...src[f.key]] : src[f.key];
    }
    const moved = [];
    const rules = Array.isArray(src.rules) ? [...src.rules] : [];
    for (const raw of Array.isArray(src.taboo) ? src.taboo : []) {
        const t = String(raw ?? '').trim();
        if (t !== '' && isBehaviorRule(t) && !rules.includes(t)) {
            rules.push(t);
            moved.push({ from: 'taboo', item: t });
        }
    }
    if (rules.length > 0) out.rules = rules;
    return { voice: out, moved, changed: moved.length > 0 };
}

const renderList = (v) => (Array.isArray(v) ? v.join(' / ') : String(v ?? ''));

/**
 * 存量卡一次性修复（纯函数，dry-run 用）：
 *   ① 按新规则重切列表（引号/括号内的分隔符不再切）
 *   ② 迁移行为规则（taboo → rules，原 taboo 保留）
 *   ③ 产出逐字段差异与无法自动修复的问题清单
 * 不猜测被旧实现切碎的原句——残片只报问题，等人工确认。
 *
 * 口径（0.20.x 取舍）：**只做结构性重切，不剥句末标点**。「哦。」保留句号——
 * 剥掉会把 includes 命中面从整句放宽到「任意一个哦」，统计噪声陡增；而句末标点
 * 本身不影响「哪张卡缺口头禅」的判定。若某条确实需要纯净短语，由人工改卡。
 */
export function repairVoiceCard(voice) {
    const before = voice !== null && typeof voice === 'object' ? voice : {};
    const normalized = normalizeVoiceStored(before);
    const migrated = migrateVoiceCard(normalized);
    const after = migrated.voice;
    const changes = [];
    for (const f of VOICE_FIELDS) {
        // rules 的增量由下面的迁移条目逐条登记，避免同一处改两遍
        if (f.key === 'rules' && migrated.moved.length > 0) continue;
        const b = before[f.key];
        const a = after[f.key];
        if (b === undefined && a === undefined) continue;
        if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue;
        changes.push({ field: f.key, kind: 'resplit', before: renderList(b), after: renderList(a) });
    }
    for (const mv of migrated.moved) {
        changes.push({ field: 'rules', kind: 'migrate', before: '', after: mv.item });
    }
    const issues = [];
    const check = validateVoice(after);
    for (const e of check.errors) issues.push({ severity: 'error', ...e });
    for (const w of check.warnings) issues.push({ severity: 'warning', ...w });
    for (const raw of Array.isArray(after.taboo) ? after.taboo : []) {
        const t = String(raw ?? '').trim();
        if (t === '' || !hasUnbalancedBrackets(t)) continue;
        issues.push({
            severity: 'error', field: 'taboo', code: 'entry-corrupt', item: t,
            message: `「绝不说」里的「${t}」含不配平的引号/括号，是旧切分留下的残片——原句已无法自动还原，请人工确认后改写`,
        });
    }
    return { voice: after, changes, moved: migrated.moved, issues, changed: changes.length > 0 };
}

/** 是否为空卡（七个字段一个都没填）。 */
export function isEmptyVoice(voice) {
    return VOICE_FIELDS.every((f) => voice?.[f.key] === undefined);
}

// ── 长描述压缩（0.20.x 第 5 步）──────────────────────────────────────────────
//
// 「动作/语域」要能机检：值必须是 ≤8 字的可匹配短语。存量卡里的长描述不能丢——
// 迁移到人物卡的「语言与外化习惯」节；没有人物卡时落进 notes 字段。
// 选短语的口径是**数据驱动**的：从原描述切出候选（自然分句 + 分句内 ≤8 字连续片段），
// 优先选在本章/全书正文里真实出现过的片段（命中数可验），没有命中才退回最长分句。
const PHRASE_SEP_RE = /[\s，,、；;。！？…：:（）()「」『』“”"'【】《》[\]{}\/|—\-~～·]+/;
const PHRASE_BAD_RE = /[\s，,、；;。！？…：:（）()「」『』“”"'【】《》[\]{}\/|—\-~～·]/;
/** 二级切分：的/地/得、常见连接词与「这类/这种」，能把长描述拆成可用的短语。 */
const PHRASE_SUB_RE = /[的地得与和混带夹而用]|这类|这种|那种/g;
/** 以功能词开头/收尾的碎片（「人的」「一个」「一点」「出来的」「不上」）不像人物特征，不选。 */
const PHRASE_BAD_START_RE = /^(?:的|了|是|那|这|就|也|还|又|不|没|有|在|把|被|让|给|对|从|而|但|可|却|才|只|都|一个|一下|一句|一点|出来|见了|人的|不上|是一个|偶尔|这类|这种|前世|从前|当年|以前|当时)/;
const PHRASE_BAD_END_RE = /(?:的|了|是|个|下|上|出|先|两|三|四|五|第)$/;

function countHits(hay, needle) {
    if (needle === '' || hay === '') return 0;
    return hay.split(needle).length - 1;
}

function usablePhrase(s) {
    const chars = [...s];
    return chars.length >= 3 && chars.length <= 8
        && !PHRASE_BAD_RE.test(s) && !PHRASE_BAD_START_RE.test(s) && !PHRASE_BAD_END_RE.test(s);
}

/**
 * 从长描述生成候选：自然分句/二级分句（语义顺），以及 4..8 字连续片段（给命中用）。
 * start=0 表示从分句开头起算——评分时给一点优先，避免「食指第二节」压过「拇指摩挲」。
 */
function phraseCandidates(text, max) {
    const clauses = String(text ?? '').split(PHRASE_SEP_RE).map((s) => s.trim()).filter((s) => s !== '');
    const natural = [];
    const grams = [];
    for (const clause of clauses) {
        if (usablePhrase(clause)) natural.push({ p: clause, start: 0, natural: true });
        for (const sub of clause.split(PHRASE_SUB_RE).map((s) => s.trim()).filter((s) => s !== '')) {
            if (usablePhrase(sub)) natural.push({ p: sub, start: 1, natural: true });
        }
        const chars = [...clause];
        for (let len = 4; len <= Math.min(max, chars.length); len += 1) {
            for (let i = 0; i + len <= chars.length; i += 1) {
                const g = chars.slice(i, i + len).join('');
                if (!PHRASE_BAD_RE.test(g)) grams.push({ p: g, start: i, natural: false });
            }
        }
    }
    return { clauses, natural, grams };
}

/**
 * 把一条长描述压成 ≤max 字的可匹配短语（纯函数）。
 * 选法：长度 + 句首加成 + 「正文出现过」小加成。命中只加分不封顶主导——
 * 「落盏声」命中再多也不该压过完整的「落盏声当停顿」；同时保留「真的会命中」这个信号。
 * @param text 原描述
 * @param corpus 用于命中验证的正文（章节文本拼接；可空）
 * @returns { phrase, hits, changed, source: 'short'|'corpus'|'fallback' }
 */
export function compactPhrase(text, corpus = '', { max = 8 } = {}) {
    const t = String(text ?? '').trim();
    if (t === '') return { phrase: '', hits: 0, changed: false, source: 'short' };
    if ([...t].length <= max) return { phrase: t, hits: countHits(String(corpus ?? ''), t), changed: false, source: 'short' };
    const { natural, grams } = phraseCandidates(t, max);
    const hay = String(corpus ?? '');
    let best = null;
    for (const c of [...natural, ...grams]) {
        const len = [...c.p].length;
        if (len < 4 || len > max || !usablePhrase(c.p)) continue;
        const hits = countHits(hay, c.p);
        // 机器片段（分句内任意连续 4..8 字）只在正文真的出现过时才参评：
        // 否则会出现「攥/按贴胸口的铁」这种按长度取胜的半截话。
        if (!c.natural && hits === 0) continue;
        // 自然分句按长度取胜（语义完整优先）；机器片段只给半权重，只有句首片段有加成，
        // 避免「扣扳机扣出来的习」这种长残片压过「拇指摩挲」。
        const score = c.natural
            ? len + 2 + (hits > 0 ? 2 : 0)
            : len / 2 + (c.start === 0 ? 3 : 0) + (hits > 0 ? 2 : 0);
        if (best === null || score > best.score || (score === best.score && len > best.len)) {
            best = { phrase: c.p, len, hits, score };
        }
    }
    if (best !== null) {
        return { phrase: best.phrase, hits: best.hits, changed: true, source: best.hits > 0 ? 'corpus' : 'fallback' };
    }
    const phrase = [...t].slice(0, max).join('');
    return { phrase, hits: 0, changed: true, source: 'fallback' };
}

/**
 * 语言卡压缩（纯函数）：只动 gesture/register 两个长描述字段。
 * 返回的 migrated 列表供调用方落人物卡（或没有人物卡时写 notes），原文一字不丢。
 */
export function compactVoiceCard(voice, corpus = '', opts = {}) {
    const normalized = normalizeVoiceStored(voice);
    const out = JSON.parse(JSON.stringify(normalized));
    const changes = [];
    const migrated = [];
    for (const key of ['gesture', 'register']) {
        const before = typeof normalized[key] === 'string' ? normalized[key] : '';
        if ([...before].length <= (opts.max ?? 8)) continue;
        const r = compactPhrase(before, corpus, opts);
        out[key] = r.phrase;
        changes.push({ field: key, before, after: r.phrase, hits: r.hits, source: r.source });
        migrated.push({ field: key, text: before, phrase: r.phrase });
    }
    return { voice: out, changes, migrated, changed: changes.length > 0 };
}

/** 人物卡里承接长描述的固定小节名（迁移落点，可重复执行不重复写）。 */
export const VOICE_SECTION = '## 语言与外化习惯';

/**
 * 把长描述追加进人物卡的「语言与外化习惯」节（纯函数）。
 * 已有同文条目就跳过（幂等）；没有该节就新建在文末；有该节就插在它后面、
 * 下一个 `## ` 之前——不会把条目挂到别的小节名下。
 * @returns { text, added } added = 本次新增的条目数
 */
export function appendVoiceNotes(cardText, entries = []) {
    const base = String(cardText ?? '');
    const fields = { gesture: '动作', register: '语域' };
    const fresh = (Array.isArray(entries) ? entries : [])
        .filter((e) => e && String(e.text ?? '').trim() !== '' && !base.includes(String(e.text)));
    if (fresh.length === 0) return { text: base, added: 0 };
    const block = fresh.map((e) => `- ${fields[e.field] ?? e.field}：${e.text}`).join('\n');
    const idx = base.indexOf(VOICE_SECTION);
    if (idx === -1) {
        const sep = base === '' || base.endsWith('\n') ? '' : '\n';
        return { text: `${base}${sep}\n${VOICE_SECTION}\n\n${block}\n`, added: fresh.length };
    }
    const next = base.indexOf('\n## ', idx + VOICE_SECTION.length);
    const at = next === -1 ? base.length : next;
    const head = base.slice(0, at).replace(/\n*$/, '\n');
    const tail = base.slice(at);
    return { text: `${head}${block}\n${tail}`, added: fresh.length };
}

/**
 * 渲染成注入区块（写章时与人物卡并列，但更醒目——它管的是「怎么说话」）。
 * 空卡返回 ''（不占预算）。
 * 已迁移的卡（有 rules）里，taboo 中的行为规则不再重复渲染（它们在 rules 行出现）。
 */
export function renderVoiceCard(name, voice) {
    const v = voice ?? {};
    const lines = [];
    for (const f of VOICE_FIELDS) {
        // notes 是长描述归档位（人物卡缺席时的落点），不进注入区块——否则压缩就白做了。
        if (f.key === 'notes') continue;
        let val = v[f.key];
        if (val === undefined) continue;
        if (f.key === 'taboo' && Array.isArray(v.rules) && Array.isArray(val)) {
            const phrases = val.filter((x) => !isBehaviorRule(x));
            if (phrases.length === 0) continue;
            val = phrases;
        }
        const text = Array.isArray(val) ? val.map((x) => `「${x}」`).join(' ') : val;
        lines.push(`${f.label}：${text}`);
    }
    if (lines.length === 0) return '';
    return `【${name}·说话方式】\n${lines.join('\n')}`;
}

/** 对话标记（判断「这个角色本章有没有开口」）。 */
const SPEECH_MARK = /[「『“"]/;
/** 说话动词归属（0.19.1，E19）：「名字 + 说/道/问/答…」或「名字：」才算台词归属——
 * 旧版「名字与引号同行即算」会把叙述句里的人名引用（叙述里提到「白老师」、同句又
 * 恰好有引号）误判成「他有台词」，报出「有台词无口头禅」的假提示（真机实证）。 */
const SPEAK_ATTR_RE = /^\s*(?:说|道|问|答|喊|念|应|开口|接话|低声|轻声|反问|追问|忽然|摇头|点头|冷冷|沉声|顿了顿)\s*(?:[：:]|[「『“"])/;
const SPEAK_COLON_RE = /^\s*[：:]/;
/** 转义正则特殊字符（人名一般不含，但防御性处理）。 */
function escapeRe(s) {
    return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function speechAttributed(lines, name) {
    for (let i = 0; i < lines.length; i += 1) {
        const l = lines[i];
        if (!SPEECH_MARK.test(l)) continue;
        const idx = l.indexOf(name);
        if (idx >= 0) {
            const after = l.slice(idx + name.length);
            if (SPEAK_ATTR_RE.test(after) || SPEAK_COLON_RE.test(after)) return true;
        }
        // 跨行归属：对话行（引号开头）的下一行「名字说：」
        if (/^\s*[「『“"]/.test(l)) {
            const nxt = lines[i + 1] ?? '';
            if (new RegExp(`^\\s*${escapeRe(name)}\\s*(?:说|道|问|答|喊|念|应|开口)`).test(nxt)) return true;
        }
    }
    return false;
}

/**
 * 主角 / 视角人物的数据驱动判定（纯函数）。
 * 优先读 novel.json 里已有的字段（protagonist / pov / lead / mainCharacter，允许字符串、
 * 数组或 {name}）；都拿不到返回 null，由调用方退回出场统计——**绝不写死名字或下标**。
 */
export function protagonistNameOf(novel) {
    const pick = (v) => {
        if (typeof v === 'string') return v.trim();
        if (Array.isArray(v)) {
            for (const x of v) {
                const s = pick(x);
                if (s !== '') return s;
            }
            return '';
        }
        if (v !== null && typeof v === 'object' && typeof v.name === 'string') return v.name.trim();
        return '';
    };
    for (const key of ['protagonist', 'pov', 'lead', 'mainCharacter']) {
        const s = pick(novel?.[key]);
        if (s !== '') return s;
    }
    return null;
}

/**
 * 叙事权重：角色名在给定文本（章节标题+摘要）里的出现次数。
 * 用途是「没写主角字段时的数据驱动替代」与「非主角卡的排序」——不是精确统计，
 * 只求比 names 顺序更接近真实戏份。纯函数。
 */
export function narrativeWeights({ texts = [], names = [] } = {}) {
    const hay = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? '')).join('\n');
    const out = {};
    for (const raw of Array.isArray(names) ? names : []) {
        const n = String(raw ?? '').trim();
        if (n === '') continue;
        out[n] = hay === '' ? 0 : hay.split(n).length - 1;
    }
    return out;
}

/**
 * 语言卡排序：主角/视角卡排第一（独立配额），其余按叙事权重降序；
 * 权重相同才退回传入顺序（cast 顺序），不再按 names 顺序均摊。
 */
export function rankVoiceNames({ names = [], weights = {}, lead = null } = {}) {
    const list = (Array.isArray(names) ? names : []).map((n) => String(n ?? '').trim()).filter((n) => n !== '');
    const order = new Map(list.map((n, i) => [n, i]));
    return [...list].sort((a, b) => {
        if (a === lead && b !== lead) return -1;
        if (b === lead && a !== lead) return 1;
        const dw = (Number(weights[b]) || 0) - (Number(weights[a]) || 0);
        if (dw !== 0) return dw;
        return (order.get(a) ?? 0) - (order.get(b) ?? 0);
    });
}

/**
 * 把 voiceConsistency 的 issues 压成写章回执里的警告行（纯函数）。
 * 噪音预算：每章最多 max 条；超出时保留前 max-1 条，末条合并为「另有 N 项」——
 * 与 auditVerdict 的合并口径一致，避免语言基因提示把既有 warnings 淹掉。
 */
export function voiceGateWarnings(consistency, { max = 3 } = {}) {
    const issues = Array.isArray(consistency?.issues) ? consistency.issues : [];
    if (issues.length === 0) return [];
    const cap = Number.isInteger(max) && max >= 1 ? max : 3;
    if (cap === 1) return [`语言基因体检有 ${issues.length} 项问题（novel_audit voice:true 查看全部）`];
    if (issues.length <= cap) return issues.map((i) => i.message);
    const keep = cap - 1;
    const rest = issues.length - keep;
    return [
        ...issues.slice(0, keep).map((i) => i.message),
        `另有 ${rest} 项语言基因问题未展开（novel_audit voice:true 查看全部）`,
    ];
}

/**
 * 场景契约里有台词、但没有语言基因卡的角色（纯函数，第 4 步）。
 * 只点名「本章真的开口」的人：没卡又没台词的人不该被催建卡。
 * @param inputs { content, names:[角色名], voiced:[已有卡的角色名] }
 * @returns 缺少卡的角色名数组（保持 names 顺序）
 */
export function missingVoiceCards({ content, names = [], voiced = [] } = {}) {
    const text = String(content ?? '');
    const lines = text.split('\n');
    const has = new Set((Array.isArray(voiced) ? voiced : []).map((x) => String(x ?? '')));
    return (Array.isArray(names) ? names : [])
        .map((n) => String(n ?? '').trim())
        .filter((n) => n !== '' && !has.has(n) && speechAttributed(lines, n));
}

/**
 * 禁忌短语的**边界感知命中**（纯函数）。
 *
 * 旧口径 `text.includes(t)` 是裸子串匹配：短词嵌在更长的 CJK 词流里必然误报——
 * 真机实例：禁忌词「在下」命中了叙述里「坐在下手」的词内嵌（前一字是汉字）。
 *
 * 新口径（只用于 taboo，不用于口头禅，见 voiceConsistency 里的注释）：
 *   ① 引号台词内：任意出现都算（人物确实开口说了这个词）；
 *   ② 台词外（叙述）：只认**子句起点**——短语前一个字符是空/标点/引号/换行，
 *      或短语就在文首。嵌在「坐在下手」这类更长词流中间的命中不算。
 * 净效果是**只收窄不放宽**：台词侧行为与旧口径完全一致，叙述侧去掉词内嵌误报。
 * 反例代价：叙述里「他自称在下」这种前面紧贴动词的写法会漏（不引词典就分不出
 * 「在下」是词还是更长词的一部分，宁可漏一次提示，也不误报一次「说错话」）。
 */
const DIALOGUE_OPEN = new Set(['「', '『', '“', '‘']);
const DIALOGUE_CLOSE = new Set(['」', '』', '”', '’']);

/**
 * @param text   本章正文
 * @param phrase 禁忌短语
 * @returns [{ index, quoted, atClauseStart }]（空数组 = 没有有效命中）
 */
export function clauseHits(text, phrase) {
    const s = String(text ?? '');
    const p = String(phrase ?? '');
    if (s === '' || p === '') return [];
    // 逐字符标记「这个位置是否在引号台词内」（支持跨行台词；ASCII 双引号按开合轮换）
    const inDialogue = new Uint8Array(s.length);
    let depth = 0;
    for (let i = 0; i < s.length; i += 1) {
        const ch = s[i];
        let inside = depth > 0;
        if (ch === '"') {
            depth = depth > 0 ? depth - 1 : depth + 1;
            inside = depth > 0;
        } else if (DIALOGUE_OPEN.has(ch)) {
            depth += 1;
            inside = true;
        } else if (DIALOGUE_CLOSE.has(ch)) {
            depth = Math.max(0, depth - 1);
            inside = depth > 0;
        }
        inDialogue[i] = inside ? 1 : 0;
    }
    const out = [];
    let from = 0;
    for (;;) {
        const idx = s.indexOf(p, from);
        if (idx < 0) break;
        const before = idx === 0 ? '' : s[idx - 1];
        const quoted = inDialogue[idx] === 1;
        const atClauseStart = idx === 0 || EDGE_PUNCT_RE.test(before);
        if (quoted || atClauseStart) out.push({ index: idx, quoted, atClauseStart });
        from = idx + 1;
    }
    return out;
}

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
        // 本章该角色是否有台词（0.19.1，E19）：按说话动词归属判定——名字与引号
        // 同行不再是充分条件（叙述引用会误判「在场」）
        const spoken = speechAttributed(lines, name);
        // 只对「可匹配短语」做命中判定：行为规则（不与人争辩第二句）与引号残片
        // 永远 includes 不到，进统计只会制造噪音；rules 字段本身不参与命中。
        const ticsAll = Array.isArray(voice.tics) ? voice.tics : [];
        const tics = matchableEntries(ticsAll);
        const taboo = matchableEntries(voice.taboo);
        // 口头禅保持裸 includes：它只是「有台词却没口头禅」的提示，收窄会制造更多
        // 缺口语噪音；禁忌词是「说错话」的指控，必须精确 → 走边界判定。
        const ticsHit = tics.filter((t) => text.includes(t));
        const tabooHits = taboo.filter((t) => clauseHits(text, t).length > 0);

        items.push({ name, spoken, ticsHit, tabooHits });

        if (ticsAll.length > 0 && tics.length === 0) {
            issues.push({
                severity: 'warning',
                code: 'voice-card-unusable',
                name,
                message: `「${name}」的口头禅没有一条能参与命中判定（都是行为规则或引号残片）——请修卡（novel_character voice_repair）后再靠它核对`,
            });
        }
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
