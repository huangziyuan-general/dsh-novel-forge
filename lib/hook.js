// lib/hook.js — 纯函数：章末钩子检测（共享逻辑，消除 audit/diagnose/polish 三处重复）。
// 返回 null（无钩子）或 kind 字符串。

const SUSPENSE_WORDS = /(突然|忽然|竟然|却不知|就在这时|下一瞬|还没等|紧接着|可就在|来不及|转眼间)/;
// 倒计时式宣告与打断式收尾——真机导入书两处教科书级 cliffhanger，旧四模式全检不出。
// 模式取窄：只认明确的倒计时/打断措辞，宽松化会制造假阳性驱动无谓改稿。
const CLOCK_RE = /(最多(还)?能?(再)?活|最多(还)?剩|只剩(下)?最后|大限(将至|只剩)|数到第[一二三四五六七八九十百两0-9]{1,5}(下|声|次|个))/;
const INTERRUPT_RE = /(话音未落|话没说完|门被敲响|敲门声(突然)?响|电话(铃)?(突然)?响(了|起)|骤然(响起|炸响|传来)|戛然而止)/;

/**
 * 剥掉 markdown 强调标记（**粗体** / __下划线__ / *斜体* / _斜体_）。
 * 两个消费者必须共用这一个口径，否则数字与判定会互相矛盾：
 *   · detectHookKind —— 钩子存在性不该被排版标记绑架（真机「**三个！**」的 `**` 挡住结尾正则）；
 *   · audit 字数 —— `**` 是排版不是正文，真机一章 188 个 `*` 被算成 188 字，
 *     门禁报「正文 1905 字」而读者实际只看到 1717 字（差 95 是假的，真实差 283）。
 * 纯函数。
 */
export function stripEmphasis(text) {
    return String(text ?? '').replace(/[*_]+/g, '');
}

/**
 * 章末钩子检测（看最后 160 字）。
 * 先剥 markdown 强调标记：真机「**三个！**」的 `**` 挡住结尾正则，
 * 检测器对明明存在的钩子报「未检出」，模型随即整章重写提修复提案（真机连犯 16 例「同型吞检」，
 * 每例一轮 propose+人工应用）——钩子存在性判定不该被排版标记绑架。
 * 0.19.0：**纯感叹收尾不再算钩子**。《开局觉醒加特林》105 章审校实证：exclaim 是五类里
 * 成本最低的一档——模型收尾打个「它，还醒着！」既满足 hook 检测、又满足 content-gate 的
 * 「开新钩」判定（欠账未还禁开新钩也被一个叹号绕过），100+ 章「一句宣言+叹号」同构率
 * 近乎 100%，是可检测的生成痕迹。语义钩（问句/悬念/省略/倒计时/打断）保留。
 * @returns null | 'question' | 'ellipsis' | 'suspense' | 'countdown' | 'interrupt'
 */
export function detectHookKind(text) {
    const tail = stripEmphasis(text).trim().slice(-160);
    if (tail === '') return null;
    if (/[「"][^」”]*[？?][」”]?\s*$/.test(tail) || /[？?]\s*[」”]?\s*$/.test(tail)) return 'question';
    if (/(……|—{2,})\s*$/.test(tail)) return 'ellipsis';
    if (SUSPENSE_WORDS.test(tail)) return 'suspense';
    if (CLOCK_RE.test(tail)) return 'countdown';
    if (INTERRUPT_RE.test(tail)) return 'interrupt';
    // 纯感叹收尾不返回任何 kind——它是断章公式（noai.formula 维）的检测对象，不是钩子。
    return null;
}
