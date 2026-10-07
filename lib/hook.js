// lib/hook.js — 纯函数：章末钩子检测（共享逻辑，消除 audit/diagnose/polish 三处重复）。
// 返回 null（无钩子）或 kind 字符串。

const SUSPENSE_WORDS = /(突然|忽然|竟然|却不知|就在这时|下一瞬|还没等|紧接着|可就在|来不及|转眼间)/;

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
 * @returns null | 'question' | 'ellipsis' | 'suspense' | 'exclaim'
 */
export function detectHookKind(text) {
    const tail = stripEmphasis(text).trim().slice(-160);
    if (tail === '') return null;
    if (/[「"][^」”]*[？?][」”]?\s*$/.test(tail) || /[？?]\s*[」”]?\s*$/.test(tail)) return 'question';
    if (/(……|—{2,})\s*$/.test(tail)) return 'ellipsis';
    if (SUSPENSE_WORDS.test(tail)) return 'suspense';
    if (/[！!]\s*[」”]?\s*$/.test(tail)) return 'exclaim';
    return null;
}
