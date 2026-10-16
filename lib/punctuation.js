// lib/punctuation.js — 引号规范化（GB/T 15834—2011《标点符号用法》）纯函数。
//
// 为什么收口在一个模块：模型在 RLHF 阶段养成了直角引号（「」『』）偏好，而中国大陆
// 横排文稿的国标引号是弯引号“”‘’。约束分两层——
//   ① 代码强制（本模块）：所有正文入库口（写章提交链 / 面板人工保存 / 修订提案 /
//      润色提案）落盘前把直角引号规范成弯引号——转换幂等、零信息损失，
//      杜绝而不熔断（引号不是内容问题，熔断式拒绝只会逼模型换措辞硬压）；
//   ② 模型约束（简报纪律段 + 工具描述 + SKILL）：先写对，转换只是兜底。
// 转换必须可见：converted 计数随判定段返回，进 warnings 与审计——不许静默改稿
// （与本仓库「UI 失败必须可见」同一条哲学：隐式行为都会变成排不出来的真机悬案）。
//
// 纯函数（AGENTS.md 架构不变量②）：输入输出皆数据，node --test 直测，不做任何 io。

const OPEN = '「『';
const CLOSE = '」』';
// 国标嵌套层级：一层 “”，二层 ‘’（三层起循环回 “”）。GB/T 15834 示例：
// 「“他问：‘几点了？’」类嵌套在横排里写作 “他说：‘几点了？’”。
const CURLY_OPEN = ['“', '‘'];
const CURLY_CLOSE = ['”', '’'];

/** 直角引号总数（检测用，不做转换）。 */
export function countCornerQuotes(text) {
    const s = String(text ?? '');
    let n = 0;
    for (const ch of s) {
        if (OPEN.includes(ch) || CLOSE.includes(ch)) n += 1;
    }
    return n;
}

/**
 * 直角引号 → 弯引号（栈式配对，嵌套按层级：一层 “”，二层 ‘’）。
 *
 * 容错规则（残稿也要转成合法弯引号，绝不留直角）：
 *   · 闭引号无未闭合层可配 → 按一层闭（”）收——模型漏写开引号的孤闭也转；
 *   · 嵌套超过两层 → 层级对 2 取模循环（“ ‘ “ ‘ …）——与国标「引号里再用引号时
 *     双线单线交替」的示例一致；
 *   · 混搭开闭（「…』）→ 按栈顶层级配对转换，类型差异不回退为直角。
 *
 * @returns {{ text: string, converted: number }} converted = 被转换的直角引号个数
 */
export function normalizeQuotes(text) {
    const s = String(text ?? '');
    if (!/[「」『』]/.test(s)) return { text: s, converted: 0 };
    const stack = [];
    let out = '';
    let converted = 0;
    for (const ch of s) {
        if (OPEN.includes(ch)) {
            stack.push(stack.length % 2);
            out += CURLY_OPEN[(stack.length - 1) % 2];
            converted += 1;
        } else if (CLOSE.includes(ch)) {
            const lvl = stack.length > 0 ? stack.pop() : 0;
            out += CURLY_CLOSE[lvl % 2];
            converted += 1;
        } else {
            out += ch;
        }
    }
    return { text: out, converted };
}
