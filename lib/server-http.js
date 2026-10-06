// lib/server-http.js — REST 面共享的 HTTP 基元与路径工具。
//
// 从 server-api.js 抽出（路由按域拆分后，http-errors 与各 server-routes/* 都要用同一套
// 语义）：常量、响应封装、请求体解析、fence 校验、URL 解析、书目名校验。
// 行为与抽取前逐字一致 —— 这是纯搬移，不是重写。

const FENCE_HEADER = 'x-dsh-novel-forge';
const PREFIX = '/api/novel-forge';

/** 写 JSON 响应。 */
export const writeJson = (res, status, value) => {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(value));
};

/** 读请求体并解析 JSON（空体 → {}）。上限 4MB，防手滑/防恶意灌内存。 */
export const readJsonBody = (req) => new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
        size += chunk.length;
        // L4：请求体上限 4MB——正文批量导入远远够用，防手滑/防恶意灌内存
        if (size > 4 * 1024 * 1024) {
            req.destroy();
            reject(new Error('请求体超过 4MB 上限'));
            return;
        }
        data += String(chunk);
    });
    req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); }
        catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
});

/** fence header 校验（防跨域调用）：只有带 `x-dsh-novel-forge: 1` 的请求才放行。 */
export const trusted = (req) => req.headers[FENCE_HEADER] === '1';

/** 统一失败响应。 */
export const fail = (res, status, code, message) => {
    writeJson(res, status, { ok: false, error: { code, message } });
};

/** 从请求 URL 解析路径段（去掉 PREFIX 前缀）。 */
export const parsePath = (url) => {
    const pathname = new URL(url ?? '/', 'http://localhost').pathname;
    const rest = pathname.slice(PREFIX.length);
    return rest.split('/').filter(Boolean);
};

/** 书目录名校验：拒绝空、`.`、`..` 与带路径分隔符的段。
 *  bookId 来自 URL 路径段、之后会拼进文件路径（`${bookId}/novel.json`），
 *  虽然 ctx.fs.resolve 有工作区边界兜底，但仍是「未校验入路径」——防御性收口。 */
export const validBookId = (id) => typeof id === 'string' && id !== ''
    && id !== '.' && id !== '..' && !/[\\/]/.test(id);

/** URL 路径段先回解成真名再拼路径（`new URL().pathname` 返回 percent-encoded）——
 *  不解码的话中文书名 `%E6%98%9F...` 会被当成真实目录名，读盘全部失败。 */
export const safeDecode = (s) => {
    try { return decodeURIComponent(String(s ?? '')); }
    catch { return ''; }
};

/** 从请求 URL 解析查询参数。 */
export const parseQuery = (url) => new URL(url ?? '/', 'http://localhost').searchParams;

export { PREFIX, FENCE_HEADER };