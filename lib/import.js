// lib/import.js — 纯函数：本地书籍导入的前置切分。
// 不碰 io：给一段正文，切出「第N章 + 标题 + 内容」的有序列表，供 novel_import 落盘。

/** 中文数字需 + 匹配多位（「第十一章」「第一百零八章」），否则十章以上会被漏判并入上一章。 */
const CHAPTER_NUM = String.raw`[0-9]+|[零〇一二三四五六七八九十百千万两]+`;

/** 行是否像是章节标题（支持「第2章」「第三章」「第十一章」「# 第4章 题目」）。 */
export function isChapterHeading(line) {
    const t = String(line ?? '').trim().replace(/^#+\s*/, '');
    return new RegExp(`^第\\s*(?:${CHAPTER_NUM})\\s*[章节]`).test(t);
}

/**
 * 把整本正文切成章节。
 * - 有章节标题：按出现次序编 n=1..K（章号连续，标题从标题行取；无标题用「第N章」）；
 *   首个标题前的导言/preamble 丢弃。
 * - 无任何章节标题：整段视为第 1 章。
 * @param text 源文本
 * @returns [{n, title, content}]，空文本返回 []
 */
export function splitIntoChapters(text) {
    const src = String(text ?? '');
    if (src.trim() === '') return [];
    const lines = src.split(/\r?\n/);
    const heads = lines
        .map((l, i) => (isChapterHeading(l) ? i : -1))
        .filter((i) => i !== -1);
    if (heads.length === 0) {
        const body = src.trim();
        return body === '' ? [] : [{ n: 1, title: '第1章', content: body }];
    }
    const out = [];
    heads.forEach((startIdx, k) => {
        const endIdx = k + 1 < heads.length ? heads[k + 1] : lines.length;
        const heading = lines[startIdx].trim().replace(/^#+\s*/, '');
        const m = heading.match(new RegExp(`第\\s*(${CHAPTER_NUM})\\s*[章节]\\s*(.*)$`));
        const title = (m?.[2]?.trim() || '').replace(/[#\s]$/, '') || `第${k + 1}章`;
        const content = lines.slice(startIdx + 1, endIdx).join('\n').trim();
        out.push({ n: k + 1, title, content });
    });
    return out.filter((c) => c.content.length > 0);
}

/** 从正文里猜一句话书名预览（首段首句）；猜不到返回 null。 */
export function inferOpeningPreview(text) {
    const first = String(text ?? '').trim().split(/\r?\n/)[0]?.trim() ?? '';
    return first.length >= 4 ? first.slice(0, 40) : null;
}

/**
 * 从导入章节生成回补粗纲（纯函数，确定性——不调模型）。
 * 供 novel_import backfill 落盘到 大纲/细纲/：让导入旧书回到门禁体系内
 * （已有正文的章有细纲可对齐；续写新章仍走正常 save_chapter + approve）。
 */
export function roughOutline({ n, title, chars, opening, tail, hookKind, cast = [] }) {
    return [
        `# 第${n}章 ${title}（导入回补·粗纲）`,
        '',
        `- 字数：约 ${chars} 字`,
        `- 开场：${opening || '（空）'}`,
        `- 章末：${tail || '（空）'}${hookKind ? `（钩子：${hookKind}）` : '（未检出钩子）'}`,
        `- 出场人物：${cast.length > 0 ? cast.join('、') : '（未识别）'}`,
        '',
        '本细纲由导入正文自动回补，仅供门禁放行与改写对齐；修订本正文走 novel_propose 提案制，续写新章请另写正式细纲后 approve。',
    ].join('\n');
}