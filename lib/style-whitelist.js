// lib/style-whitelist.js — 本书文风白名单（纯函数，零 io）。
//
// 解掉去 AI 味扫描的一个真实矛盾：「改到没有 AI 味」容易「改成不是我」——
// 作者的标志性写法（某句固定排比、某个口头禅、某个常用比喻）会被判成 AI 痕迹。
// 白名单是作者手登记的「这是我，别拦」字面串：扫描前把这些串掩掉，所有维度
// （八维 + 新句式判据）都不再数它们。
//
// 设计（可解释、可回放复核）：
//   · 存储：`书/.novel/style-whitelist.json` = 字面串数组（机器状态，JSON，不变量 6）；
//   · **按书隔离**：只读本目录这条文件，绝不继承别的书/工作区（串了就是误伤另一本书）；
//   · **逐字匹配**：登记什么掩什么，不做正则/通配/前缀继承——宽了会把「恰好同词」的
//     正常句子也洗成白，失去定位能力；
//   · **等长掩码**：命中处整段替换为 `\u0000`（控制符，正文里不会自然出现）——
//     字数/行号/句位全部不变，下游统计口径（chars、lineOf、句切、bigram）零漂移，
//     只有字面匹配被消掉。掩码是纯文本变换，幂等（已掩的 \u0000 不会被二次命中）。
//   · 白名单**只影响去 AI 味证据面**：不进机审（字数/重复/覆盖率照旧判）、不进内容门禁、
//     不进账本——它是「别数这些」的扫描豁免，不是「这些可以写坏」的豁免。
//
// 纯函数（不变量 2）：不碰 io、不取钟。读写由工具层（novel_style whitelist）走 fsio。

/** 掩码字符：控制符，正常中文正文不会出现；连续多个 = 连续命中（同串重叠）。 */
export const MASK_CHAR = '\u0000';

/**
 * 解析白名单多行文本（工具入参）：每行一条字面串。
 * 去首尾空白；空行与 `#` 注释行丢弃；去重保序。纯函数。
 * @returns {string[]}
 */
export function parseWhitelistLines(raw) {
    const lines = String(raw ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));
    return [...new Set(lines)];
}

/**
 * 从既有数组 + 多行文本算下一份白名单（工具「add/remove」共用，单一实现）。
 * @param existing  现有字面串数组
 * @param addText   多行「要登记的串」（parseWhitelistLines 解析）
 * @param removeText 多行「要删除的串」
 * @returns 归一后的新数组（逐字、去重、长串在前——掩码时先长后短，避免短串把长串的中间吃掉留下残片）
 */
export function reconcileWhitelist(existing = [], addText = '', removeText = '') {
    const keep = (Array.isArray(existing) ? existing : []).map((s) => String(s ?? '').trim()).filter((s) => s !== '');
    const add = parseWhitelistLines(addText);
    const remove = new Set(parseWhitelistLines(removeText));
    const merged = [...new Set([...keep, ...add])].filter((s) => !remove.has(s));
    return merged.sort((a, b) => b.length - a.length);
}

/**
 * 等长掩码：把所有白名单字面串在正文中的出现处替换为等长 MASK_CHAR。
 * 长串优先（已在 reconcileWhitelist 排好序；内部再排一次兜底），短串命中与已掩区
 * 重叠时跳过（已掩区里的字是 MASK_CHAR，不再是白名单字面，天然不会被再命中）。
 * 返回 { text, maskedSpans }——maskedSpans=[{start,length,literal}] 供回执/审计说明掩了什么。
 * @param text     原文
 * @param literals 字面串数组（长度降序；乱序也没关系，内部再排）
 */
export function maskWhitelistSpans(text, literals) {
    const src = String(text ?? '');
    const lit = (Array.isArray(literals) ? literals : [])
        .map((s) => String(s ?? '').trim())
        .filter((s) => s !== '')
        .sort((a, b) => b.length - a.length);
    const masked = new Array(src.length).fill(false); // 逐字「已掩」位图
    const maskedSpans = [];
    for (const w of lit) {
        for (let at = src.indexOf(w); at !== -1; at = src.indexOf(w, at + w.length)) {
            // 与已掩区重叠 → 跳过（被更长串盖住了，不重复记 span）
            let overlapped = false;
            for (let i = at; i < at + w.length; i += 1) if (masked[i]) { overlapped = true; break; }
            if (overlapped) continue;
            for (let i = at; i < at + w.length; i += 1) masked[i] = true;
            maskedSpans.push({ start: at, length: w.length, literal: w });
        }
    }
    let out = '';
    for (let i = 0; i < src.length; i += 1) out += masked[i] ? MASK_CHAR : src[i];
    return { text: out, maskedSpans };
}

/** 统计原文里被掩的总字符数（回执用：「白名单豁免 N 字」）。 */
export function maskedCharCount(maskedText, originalText) {
    let n = 0;
    const len = Math.min(String(maskedText ?? '').length, String(originalText ?? '').length);
    for (let i = 0; i < len; i += 1) if (maskedText[i] === MASK_CHAR) n += 1;
    return n;
}
