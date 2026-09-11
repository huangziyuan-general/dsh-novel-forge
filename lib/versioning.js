// lib/versioning.js — 章节文件版本化（纯函数）。
// 约定：正文/第N章-<标题>-v<k>.md；续写只认 k 最大者；改稿永远新增版本，不覆盖。

const ILLEGAL = /[\\/:*?"<>|\s]+/g;

/** 标题清洗：去非法文件名字符，空则回退「无题」。 */
export function sanitizeTitle(title) {
    const t = String(title ?? '').trim().replace(ILLEGAL, '-').replace(/^-+|-+$/g, '');
    return (t || '无题').slice(0, 40);
}

export function chapterFileName(n, title, v) {
    return `第${n}章-${sanitizeTitle(title)}-v${v}.md`;
}

/** 解析「第N章-标题-vK.md」；不合式返回 null。 */
export function parseChapterFileName(name) {
    const m = /^第(\d+)章-(.+)-v(\d+)\.md$/.exec(name);
    if (m === null) return null;
    return { n: Number(m[1]), title: m[2], v: Number(m[3]) };
}

/** 同章下一版本号（标题可变，版本按章号取最大）。
 * 唯一的版本计算入口：write_chapter / propose apply 都走这里，不再各自内联正则。 */
export function nextVersion(existingNames, n) {
    let max = 0;
    for (const name of existingNames) {
        const p = parseChapterFileName(name);
        if (p !== null && p.n === n && p.v > max) max = p.v;
    }
    return max + 1;
}

/** 自动 id：取现有 id 中 `${prefix}\d+` 的最大编号 + 1（gap 安全，防手工删条目后的碰撞覆盖）。 */
export function nextSuffixedId(ids, prefix, startAt = 1) {
    const re = new RegExp(`^${prefix}(\\d+)$`);
    let max = 0;
    for (const id of ids ?? []) {
        const m = re.exec(String(id));
        if (m !== null) max = Math.max(max, Number(m[1]));
    }
    return `${prefix}${Math.max(startAt, max + 1)}`;
}
