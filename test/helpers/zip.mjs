// test/helpers/zip.mjs — 内存拼最小 ZIP（STORED/DEFLATE），测试专用；不落盘不依赖三方。

import { deflateRawSync } from 'node:zlib';

function crc32(buf) {
    let c;
    const table = crc32.table ?? (crc32.table = (() => {
        const t = new Int32Array(256);
        for (let n = 0; n < 256; n += 1) {
            c = n;
            for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            t[n] = c;
        }
        return t;
    })());
    c = -1;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

/** entries: [{name, data: Buffer, deflate?: boolean}] → 完整 ZIP 字节 */
export function buildZip(entries) {
    const chunks = [];
    const centrals = [];
    let offset = 0;
    for (const e of entries) {
        const nameBytes = Buffer.from(e.name, 'utf8');
        const raw = Buffer.from(e.data);
        const body = e.deflate ? deflateRawSync(raw) : raw;
        const method = e.deflate ? 8 : 0;
        const crc = crc32(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(body.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        local.writeUInt16LE(0, 28);
        chunks.push(local, nameBytes, body);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(body.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(Buffer.concat([central, nameBytes]));
        offset += local.length + nameBytes.length + body.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...chunks, cd, eocd]);
}
