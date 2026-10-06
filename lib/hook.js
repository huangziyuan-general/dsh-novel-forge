// lib/hook.js — 纯函数：章末钩子检测（共享逻辑，消除 audit/diagnose/polish 三处重复）。
// 返回 null（无钩子）或 kind 字符串。

const SUSPENSE_WORDS = /(突然|忽然|竟然|却不知|就在这时|下一瞬|还没等|紧接着|可就在|来不及|转眼间)/;

/**
 * 章末钩子检测（看最后 160 字）。
 * 先剥 markdown 强调标记（**粗体** / __下划线__）：真机「**三个！**」的 `**` 挡住结尾正则，
 * 检测器对明明存在的钩子报「未检出」，模型随即整章重写提修复提案（真机连犯 16 例「同型吞检」，
 * 每例一轮 propose+人工应用）——钩子存在性判定不该被排版标记绑架。
 * @returns null | 'question' | 'ellipsis' | 'suspense' | 'exclaim'
 */
export function detectHookKind(text) {
    const tail = String(text ?? '').replace(/[*_]+/g, '').trim().slice(-160);
    if (tail === '') return null;
    if (/[「"][^」”]*[？?][」”]?\s*$/.test(tail) || /[？?]\s*[」”]?\s*$/.test(tail)) return 'question';
    if (/(……|—{2,})\s*$/.test(tail)) return 'ellipsis';
    if (SUSPENSE_WORDS.test(tail)) return 'suspense';
    if (/[！!]\s*[」”]?\s*$/.test(tail)) return 'exclaim';
    return null;
}
