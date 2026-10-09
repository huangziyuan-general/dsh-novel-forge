// lib/docx.js — 纯函数：.docx（OOXML ZIP）→ Markdown 文本抽取，供 novel_import 导入 Word 稿。
// 不碰 io：输入字节输出字符串；取源（ctx.fs.readBytes）在工具层。
// ZIP 读取按规格手写（只支持 STORED/DEFLATE、不支持 zip64）——docx 是 Word 导出的标准
// 形态，这两类压缩覆盖全部真实文件；畸形/截断一律带明确原因报错，不静默产出半截正文。

import { inflateRawSync } from 'node:zlib';

/** 解压后尺寸上限：防解压炸弹（docx 正文远小于此；超限直接拒绝，不猜）。 */
const MAX_INFLATED = 48 * 1024 * 1024;

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/**
 * 在 ZIP 字节里找指定条目并解出内容；找不到返回 null。
 * 走中央目录（入口尺寸以中央目录为准——local header 里的尺寸在流式生成的包里可能是 0）。
 * @param {Uint8Array} bytes 整个 zip
 * @param {string} entryName 条目名（如 'word/document.xml'）
 * @returns {Buffer|null}
 */
export function unzipEntry(bytes, entryName) {
    const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    // EOCD 在文件尾、注释最长 65535：从末尾最多回扫 66000 字节找签名 PK\x05\x06。
    const scanFrom = Math.max(0, b.length - 66000);
    let eocd = -1;
    for (let i = b.length - 22; i >= scanFrom; i -= 1) {
        if (u32(b, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) throw new Error('不是有效的 .docx/.zip：找不到中央目录结尾记录（文件被截断或不是 ZIP）');
    const total = u16(b, eocd + 10);
    const cdOffset = u32(b, eocd + 16);
    if (cdOffset >= b.length) throw new Error('不是有效的 .docx/.zip：中央目录偏移越界');

    let p = cdOffset;
    for (let i = 0; i < total; i += 1) {
        if (u32(b, p) !== 0x02014b50) throw new Error('不是有效的 .docx/.zip：中央目录记录签名损坏');
        const method = u16(b, p + 10);
        const compSize = u32(b, p + 20);
        const uncompSize = u32(b, p + 24);
        const nameLen = u16(b, p + 28);
        const extraLen = u16(b, p + 30);
        const commentLen = u16(b, p + 32);
        const localOfs = u32(b, p + 42);
        const name = b.subarray(p + 46, p + 46 + nameLen).toString('utf8');
        p += 46 + nameLen + extraLen + commentLen;

        if (name !== entryName) continue;
        if (compSize === 0xffffffff || uncompSize === 0xffffffff) {
            throw new Error(`.docx 条目 ${entryName} 是 zip64，暂不支持`);
        }
        if (uncompSize > MAX_INFLATED) throw new Error(`.docx 条目 ${entryName} 解压后 ${uncompSize} 字节，超过 ${MAX_INFLATED} 上限，拒绝处理`);
        if (u32(b, localOfs) !== 0x04034b50) throw new Error(`.docx 条目 ${entryName} 的 local header 签名损坏`);
        const lNameLen = u16(b, localOfs + 26);
        const lExtraLen = u16(b, localOfs + 28);
        const dataOfs = localOfs + 30 + lNameLen + lExtraLen;
        const raw = b.subarray(dataOfs, dataOfs + compSize);
        if (raw.length < compSize) throw new Error('.docx/.zip 被截断：条目数据不完整');
        if (method === 0) return Buffer.from(raw);
        if (method === 8) {
            try {
                return inflateRawSync(raw, { maxOutputLength: MAX_INFLATED });
            } catch (e) {
                throw new Error(`.docx 条目 ${entryName} 解压失败：${e.message}`);
            }
        }
        throw new Error(`.docx 条目 ${entryName} 用了不支持的压缩方法 ${method}（仅 STORED/DEFLATE）`);
    }
    return null;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeEntities(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            // 码点越界（&#x110000; 等）fromCodePoint 会抛 RangeError——畸形/敌意文档
            // 要的是「原样保留」，不是难看的崩溃。负数被正则 [0-9a-fA-F]+ 天然挡住。
            return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
        }
        return XML_ENTITIES[body] ?? m;
    });
}

/** 段落是否是 Word 标题样式（Heading1-9 / 1-9 / 标题N——中英文 Word 的常见取值）。 */
function isHeadingStyle(val) {
    return /^(?:[Hh]eading|标题)[1-9]$/.test(val) || /^[1-9]$/.test(val);
}

/** OOXML 段落 XML → Markdown 行（标题样式 → `# ` 前缀，交给 splitIntoChapters 的既有规则）。 */
export function documentXmlToMarkdown(xml) {
    const body = xml.replace(/^[\s\S]*?<w:body>/, '<w:body>').replace(/<\/w:document>[\s\S]*$/, '');
    const out = [];
    const paraRe = /<w:p[\s>][\s\S]*?<\/w:p>|<w:p\/>/g;
    for (const para of body.match(paraRe) ?? []) {
        const style = para.match(/<w:pStyle\s+(?:w:)?val="([^"]*)"/)?.[1] ?? '';
        // 按出现顺序抽 text/tab/br——tab/br 在 w:t 之外，先替换再只取 w:t 会把它们丢掉。
        const parts = [];
        const runRe = /<w:tab[^>]*\/>|<w:br[^>]*\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
        for (let m = runRe.exec(para); m !== null; m = runRe.exec(para)) {
            // 顺序敏感：`<w:tab` 也以 `<w:t` 开头，先判 tab/br 再落 text。
            if (m[0].startsWith('<w:tab')) parts.push('\t');
            else if (m[0].startsWith('<w:br')) parts.push('\n');
            else parts.push(decodeEntities(m[1]));
        }
        // w:t 里可能自带换行（xml:space preserve），段内 run 按顺序拼接。
        const line = parts.join('').replace(/\r\n?/g, '\n');
        if (line.trim() === '') { out.push(''); continue; }
        out.push(isHeadingStyle(style) ? `# ${line.trim()}` : line);
    }
    return out.join('\n');
}

/**
 * .docx 字节 → Markdown 文本（章标题识别交给 lib/import.js 的既有切分规则）。
 * 找不到 word/document.xml（.doc 或改后缀假 docx）→ 明确报错，不静默返回空。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function docxToMarkdown(bytes) {
    const xmlBuf = unzipEntry(bytes, 'word/document.xml');
    if (xmlBuf === null) {
        throw new Error('不是有效的 .docx：压缩包里没有 word/document.xml（.doc 旧格式或改后缀的文件请先用 Word 另存为 .docx，或改用 content/file 传 .txt/.md）');
    }
    return documentXmlToMarkdown(xmlBuf.toString('utf8'));
}
