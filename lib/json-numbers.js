// lib/json-numbers.js — 数值进工具输出前的**统一铸造点**。
// 宿主 lossless-JSON 校验拒收一切非有限数与 -0（"must be a finite JSON number" /
// "value is not lossless JSON"），整条工具输出一起被拒。这个类在真机上咬过三次，
// 三处各自为战写了三个本地变体——本模块把它们收编，之后**不再新增本地版本**：
//   style.js normalizeZero（Math.round 负区间产 -0，真机 69 章间歇性失败）
//   retrieval.js finiteOr（bm25 极小负分 toFixed(3) 得 "-0"；NaN/±Infinity 同罪）
//   library.js round（有 finite 守卫、没 -0 归一——半颗雷）
// 规矩：所有要进工具输出的数值，铸造时过 finiteOr；审计/测试用 jsonSafeIssues 兜底。

/**
 * 数值收敛：非有限（NaN/±Infinity）收 0；toFixed 后的 **-0 归一为 0**。
 * 注意 -0 的两个骗人相：String(-0)==='0'、Number.isFinite(-0)===true——
 * 判 -0 只能用 Object.is。digits 省略时不取整（调用方已自行取整的场景）。
 */
export function finiteOr(value, digits) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const r = digits === undefined ? n : Number(n.toFixed(digits));
    return Object.is(r, -0) ? 0 : r;
}

/**
 * 递归找出一个「待输出对象」里所有 JSON 不安全的数（NaN/±Infinity/-0/undefined）。
 * 返回路径列表（'$' 根）；空数组 = 安全。测试与审计兜底用——类风险靠它钉住，
 * 而不是等宿主整次拒收后回来逐个排雷。
 */
export function jsonSafeIssues(value, path = '$') {
    if (value === undefined) return [`${path}: undefined`];
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return [`${path}: ${String(value)}`];
        if (Object.is(value, -0)) return [`${path}: -0`];
        return [];
    }
    if (Array.isArray(value)) {
        return value.flatMap((v, i) => jsonSafeIssues(v, `${path}[${i}]`));
    }
    if (value !== null && typeof value === 'object') {
        return Object.entries(value).flatMap(([k, v]) => jsonSafeIssues(v, `${path}.${k}`));
    }
    return [];
}
