// lib/hook.js — 纯函数：章末钩子检测（共享逻辑，消除 audit/diagnose/polish 三处重复）。
// 返回 null（无钩子）或 kind 字符串。

const SUSPENSE_WORDS = /(突然|忽然|竟然|却不知|就在这时|下一瞬|还没等|紧接着|可就在|来不及|转眼间)/;

/**
 * 章末钩子检测（看最后 160 字）。
 * @returns null | 'question' | 'ellipsis' | 'suspense' | 'exclaim'
 */
export function detectHookKind(text) {
    const tail = String(text ?? '').trim().slice(-160);
    if (tail === '') return null;
    if (/[「"][^」”]*[？?][」”]?\s*$/.test(tail) || /[？?]\s*[」”]?\s*$/.test(tail)) return 'question';
    if (/(……|—{2,})\s*$/.test(tail)) return 'ellipsis';
    if (SUSPENSE_WORDS.test(tail)) return 'suspense';
    if (/[！!]\s*[」”]?\s*$/.test(tail)) return 'exclaim';
    return null;
}
