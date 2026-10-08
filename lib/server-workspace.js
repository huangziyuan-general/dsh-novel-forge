// lib/server-workspace.js — REST 面的多工作区扫描：会话工作区根推导 + 锻炉书扫描。
//
// 从 server-api.js 抽出（无宿主依赖差异，纯搬移）。书由 AI 工具创建，落在「会话
// workspace」（ctx.fs 以会话 cwd 为根）；而 REST 进程只有一个 cwd。dsh 可以有多个工作区，
// 只扫进程 cwd 就会漏掉其它工作区里的书 —— 面板永远「本会话没有项目」。
//
// 本模块导出两样东西：
//   · 4 个纯函数（parseProjcacheRoots / parseProjcacheSessionFile / unescapeTildeHex /
//     decodeSessionDirRoots）——供单测直测（server-api.js 会原样 re-export，导出面不变）；
//   · createWorkspaceIndex({ ctx, config, deps })——带缓存的多源扫描根推导 + 书目扫描。

import { createServerFsio } from './fsio.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// —— 会话工作区根候选来源（统一经 statSync 验证后采用，失败即跳过）——
// ⓪ live sessions（ctx.sessions）：**dsh 0.1.5-rc.2 源码核过两件事**——
//    a. 服务在：base 层装载 `@deepseek-ai/dsh-session`（dsh-base/cordis.patch.yml L34），
//       SessionStore 注册名 "sessions"（`super(ctx, "sessions")`）、`list()` 可调（安装包里在
//       L1562：创建序、返回新数组；header.cwd 是 create() 校验过的绝对路径）。浏览器半的
//       `ctx.sessions`（dsh-api-session-controller/client.js → 网关 RemoteSnapshot）是**另一套**，
//       别混为一谈；宿主 REST 看到的是前者。
//    b. 但 store 是**内存态、由创建 fiber 持有**（create() doc L1327：a session owned by the
//       calling fiber，disposing that fiber 即停通知并从 store 移除）→ 在册窗口 = agent fiber
//       驻留期（含轮运行中；跨轮 fiber 是否常驻以真机诊断行为准）
//       ⇒ live 的命中窗口 = 「拥有该工作区的会话正在跑」（典型：agent 刚把
//       书建进新工作区，运行中面板刷新立即可见）；**store 空置期（fiber 已释放）新会话工作区
//       进场的真机路径是源①目录态落盘**——所以持久层缓存必须带内容签名失效（见 persistentSig）。
//       live 每次现算零成本。
// ① projcache（持久层，覆盖非活跃会话）：宿主有**两代落盘形态，都要读**——
//    a. 单文件 `session_projcache.json`：`tables.sessions.*.identity.cwd`；
//    b. 目录态 `session_projcache/sessions/*.json`：每份 `record.identity.cwd`（dsh 0.1.5 起）。
//    Windows 真机实测单文件形态已不存在（只剩目录态）；只读 a 会让本源静默归零（面板空根因之一）。
// ② ~/.dsh/sessions 目录名反推：POSIX 兜底。**旧实现在 Windows 必然全军覆没**——`D:\X` 反推成
//    `/D/…X`，statSync 失败被跳过；aea7149 起补 ~XXXX escape + 盘符形态，中文工作区可反解回
//    `D:\新建文件夹 (4)`，但真实目录名含 `-`（如 tt-ai）仍有歧义，靠上层 statSync 兜。

/** 纯函数：projcache JSON 文本 → cwd 候选（tables.sessions.*.identity.cwd）。 */
export const parseProjcacheRoots = (text) => {
    try {
        const sessions = JSON.parse(String(text ?? '{}'))?.tables?.sessions ?? {};
        return Object.values(sessions)
            .map((s) => s?.identity?.cwd)
            .filter((c) => typeof c === 'string' && c.length > 0);
    } catch { return []; }
};

/**
 * 纯函数：单个分会话 projcache 文件文本 → cwd 候选。dsh 0.1.5 起宿主把每个会话拆成
 * `session_projcache/sessions/<id>.json`，cwd 落在 `record.identity.cwd`（旧宿主可能记成顶层
 * `identity.cwd`）——与单文件的 `tables.sessions.*.identity.cwd` 不同一层。解析失败/无 cwd → []
 * （不抛，让上层 continue 到下一个文件）。
 */
export const parseProjcacheSessionFile = (text) => {
    try {
        const j = JSON.parse(String(text ?? '{}'));
        const cwd = j?.record?.identity?.cwd ?? j?.identity?.cwd;
        return typeof cwd === 'string' && cwd.length > 0 ? [cwd] : [];
    } catch { return []; }
};

/** `~XXXX`（4 位十六进制，escape 的 `%`→`~` 变体，Windows 真机实证：~65B0~5EFA~6587~4EF6~5939 = 新建文件夹）→ 原字符；其余原样。 */
export const unescapeTildeHex = (s) => String(s ?? '').replace(/~([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

/**
 * 纯函数：sessions 目录名 → 反推根候选（有损，靠上层 statSync 验证兜底）。
 * Windows 真机 key 实证（dsh 0.1.5-rc.2）：`--D-~65B0…--`（`D:\X` 的 `:\` 压成一个 `-`，
 * 非 ASCII 走 ~XXXX）与 `--D-Users-…--`。解码出「盘符-其余」形态时给 `盘符:\其余` 候选
 * （其余段内的 `-` 一律当路径分隔符——有损，真实目录名含 `-` 时解错，验证层跳过）；
 * 同时保留 POSIX 形态候选，哪边 statSync 成功用哪边。
 */
export const decodeSessionDirRoots = (names) => (Array.isArray(names) ? names : [])
    .filter((d) => typeof d === 'string' && d.startsWith('--') && d.endsWith('--') && d.length > 4)
    .flatMap((d) => {
        const body = unescapeTildeHex(d.slice(2, -2));
        const drive = body.match(/^([A-Za-z])-(.+)$/);
        const candidates = [];
        if (drive !== null) candidates.push(`${drive[1].toUpperCase()}:\\${drive[2].replace(/-/g, '\\')}`);
        candidates.push(`/${body.replace(/-/g, '/')}`);
        return candidates;
    });

/**
 * 建一个多工作区扫描索引（带缓存）。
 *
 * @param {object} args
 * @param {object} args.ctx - cordis 上下文（读 ctx.sessions / 建 fsio）
 * @param {object} args.config - 插件配置（workspaceRoot）
 * @param {object} args.deps - 可注入依赖（homedir 供测试隔离真实 ~/.dsh）
 * @returns {{ makeFsio, collectRoots, scanAllBooks, locateBook }}
 */
export function createWorkspaceIndex({ ctx, config, deps = {} }) {
    /** 创建 fsio 适配器（绑定到指定根目录）。 */
    const makeFsio = (cwd) => createServerFsio(ctx, cwd);

    // 扫描根推导的「家目录」可注入（deps.homedir）——测试用它指向临时目录，
    // 否则真机 ~/.dsh 的 81 个真实工作区会漏进 /projects 列表断言。
    const home = typeof deps.homedir === 'string' && deps.homedir !== '' ? deps.homedir : homedir();
    const SESSIONS_DIR = join(home, '.dsh', 'sessions');
    const PROJCACHE_FILE = join(home, '.dsh', 'storages', 'session_projcache.json');
    /** 目录态 projcache（dsh 0.1.5 起：每会话一个 JSON，cwd 在 record.identity.cwd）。 */
    const PROJCACHE_DIR = join(home, '.dsh', 'storages', 'session_projcache', 'sessions');

    let _rootsCache = null;
    const _skippedWarned = new Set();
    let _lastRootsKey = null;
    let _persistTs = 0;
    let _persistCache = null;
    let _persistSig = null;
    let _persistDiag = { proj: 0, legacy: 0 };
    const ROOTS_TTL_MS = 60_000;

    /**
     * 持久源内容签名（每请求一次，约 4 个 syscall）：PROJCACHE_DIR 与 SESSIONS_DIR 两个目录的
     * mtime + entry 数。**新会话建立时宿主必然动这两个目录**（写 `session_projcache/sessions/
     * <id>.json`、建 `~/.dsh/sessions/<名>`）——mtime 抓变更，entry 数兜粗粒度文件系统；签名变
     * 即作废持久缓存，新会话工作区在下一个请求就进扫描根（真机进场路径，见头部注释⓪）。
     * 刻意**不含**单文件 mtime：老宿主整文件在每次 checkpoint 全量重写（本机实测 109MB），
     * 计入等于把持久层重 parse 放大到「每个请求」；老宿主的新会话即时性由其目录态/反推目录
     * 或 60s TTL 兜。
     */
    const persistentSig = () => {
        const parts = [];
        for (const d of [PROJCACHE_DIR, SESSIONS_DIR]) {
            try { parts.push(`${statSync(d).mtimeMs}#${readdirSync(d).length}`); }
            catch { parts.push('absent'); }
        }
        return parts.join('|');
    };

    // 持久源（projcache 双形态 + 目录名反推）缓存 = 内容签名 + TTL 双条件：签名变（新会话
    // 落盘）即时失效；TTL 兜「既有记录改了 cwd 但目录签名不动」这类变更（最长 60s）。
    // live 源每次现算不进缓存（前瞻通道真机恒空，见头部注释⓪；宿主服务端物化当天即生效）。
    const decodePersistentRoots = () => {
        const now = Date.now();
        const sig = persistentSig();
        if (_persistCache !== null && sig === _persistSig && now - _persistTs < ROOTS_TTL_MS) return _persistCache;
        // ① projcache：持久层，覆盖非活跃会话。宿主两代落盘形态都读——单文件 tables.* +
        //    目录态 sessions/*.json 的 record.identity.cwd（真机 Windows 只剩后者，只读前者=静默归零）
        let proj = [];
        try { proj = proj.concat(parseProjcacheRoots(readFileSync(PROJCACHE_FILE, 'utf8'))); } catch { /* 无单文件/坏 JSON → 降级 */ }
        try {
            // readdirSync 排序：目录项顺序由文件系统决定，不排序则候选顺序在进程间漂移，
            // 与 scanAllBooks 的「同名书先到者胜」叠加时面板显示哪份拷贝会抖动
            for (const f of readdirSync(PROJCACHE_DIR).sort()) {
                if (!f.endsWith('.json')) continue;
                let txt = null;
                try { txt = readFileSync(join(PROJCACHE_DIR, f), 'utf8'); } catch { continue; }   // 坏文件不阻断其余
                proj = proj.concat(parseProjcacheSessionFile(txt));
            }
        } catch { /* 无目录态（旧宿主/未建）→ 降级 */ }
        proj = [...new Set(proj)];   // 两形态命中同一 cwd 时去重，扫描根诊断行的计数才不骗人
        // ② 目录名反推：POSIX + Windows 盘符形态双候选（~XXXX 反解；真实目录名含 - 仍解错，验证层跳过）
        let legacy = [];
        try { legacy = decodeSessionDirRoots(readdirSync(SESSIONS_DIR).sort()); } catch { /* 无 sessions 目录 → 空 */ }
        _persistCache = [...new Set([...proj, ...legacy])];
        _persistSig = sig;
        _persistDiag = { proj: proj.length, legacy: legacy.length };
        _persistTs = now;
        return _persistCache;
    };
    const decodeWorkspaceRoots = () => {
        // ⓪ live sessions：每次现算、不进任何缓存（服务在 base 层装载，但 store 由 fiber 持有、
        //    空闲期≈空——命中窗口与真机路径见头部注释⓪；不受持久层缓存牵制）
        let live = [];
        let liveHint = '';
        try {
            const raw = ctx.sessions?.list?.() ?? [];
            live = raw
                .map((s) => s?.header?.cwd ?? s?.cwd)
                .filter((c) => typeof c === 'string' && c.length > 0);
            if (ctx.sessions?.list === undefined) liveHint = '（live sessions 未物化——宿主未装载/裁剪了 dsh-session，见 server-api 头部注释⓪）';
            else if (live.length === 0 && raw.length > 0) liveHint = `（live 会话 ${raw.length} 个但均无 cwd 字段）`;
            else if (raw.length === 0) liveHint = '（store 当前为空——会话仅在创建 fiber 驻留期在册，见头部注释⓪）';
        } catch { liveHint = '（live sessions 服务调用抛错）'; }
        const persist = decodePersistentRoots();
        // 验证失败的告警按候选去重（进程级 Set）：候选集是确定性的，不设防的话
        // 同两行会随 ROOTS_TTL_MS 每 60 秒刷屏一次（Windows 真机实录）
        _rootsCache = [...new Set([...live, ...persist])].filter((p) => {
            try { return statSync(p).isDirectory(); } catch {
                if (!_skippedWarned.has(p)) {
                    _skippedWarned.add(p);
                    console.warn(`[novel-forge] 会话工作区候选验证失败，已跳过（含 - 的目录名反推有损，属预期降级；此候选只告警一次）：${p}`);
                }
                return false;
            }
        });
        // 扫描根清单随内容变化打一行（含首次）：真机排查「面板无书」时，这行直接回答
        // 「三源各自命中多少、最终用了哪些工作区」
        const summary = `扫描根（live=${live.length}${liveHint} projcache=${_persistDiag.proj} 反推候选=${_persistDiag.legacy} → 有效 ${_rootsCache.length} 个）`
            + (_rootsCache.length ? `：${_rootsCache.join(' | ')}` : '（全部候选无效或无候选）');
        if (summary !== _lastRootsKey) {
            _lastRootsKey = summary;
            console.info(`[novel-forge] ${summary}`);
        }
        return _rootsCache;
    };

    /** 全部扫描根：进程 cwd（或 config.workspaceRoot）优先，其余会话工作区跟上，去重。 */
    const collectRoots = () => [...new Set([config.workspaceRoot || process.cwd(), ...decodeWorkspaceRoots()])];

    /**
     * 扫描工作区一级目录，挑出「是锻炉书」的目录并解析其 novel.json。
     *
     * 一次扫描喂三个用途：全量列表、按会话过滤、未归属列表 ——
     * 避免每个用途各自再读一遍盘。
     * @returns {Promise<Array<{name:string, text:string, novel:object}>>}
     */
    const scanBooks = async (fsio) => {
        const names = await fsio.listDirs('.');
        const books = [];
        for (const name of names) {
            try {
                const text = await fsio.readText(`${name}/novel.json`);
                if (!text) continue;                       // 不是锻炉书，跳过
                const novel = JSON.parse(text);
                books.push({ name, text, novel });
            } catch (e) { console.warn(`[novel-forge] scanBooks: 跳过 ${name}（${e?.message ?? '非法 JSON'}）`); }
        }
        return books;
    };

    /**
     * 扫描所有工作区根下的锻炉书。同名书以 cwd 根优先（roots[0]）。
     * @returns {Promise<Array<{name, text, novel, fsio}>>} fsio 供后续读写该书所在根
     */
    const scanAllBooks = async () => {
        const byName = new Map();
        for (const root of collectRoots()) {
            const fsio = makeFsio(root);
            for (const b of await scanBooks(fsio)) {
                const prev = byName.get(b.name);
                if (prev !== undefined) {
                    // 方向4：同名书在多根下重复——此前静默「先到者胜」，面板显示哪份拷贝随
                    // 扫描根顺序抖动（同名的两份可以完全不同）。这里记下副本数，由列表接口
                    // 显式提示「同名书另有 N 份」，让用户知道自己在看的是哪一份。
                    prev.duplicates = (prev.duplicates ?? 0) + 1;
                    prev.duplicateRoots = [...(prev.duplicateRoots ?? []), root];
                    prev.conflictId = b.novel?.id ?? null;
                    continue;
                }
                byName.set(b.name, { ...b, fsio, root });
            }
        }
        const all = [...byName.values()];
        for (const b of all) {
            if (b.duplicates !== undefined) {
                console.warn(`[novel-forge] 同名书「${b.name}」在 ${b.duplicates + 1} 个工作区根下各有一份：本面板显示 ${b.root} 的那份（cwd 优先）；其余根：${b.duplicateRoots.join(' | ')}`);
            }
        }
        return all;
    };

    /** 在所有根里找一本书，返回其 fsio 与 novel.json 原文；找不到返回 null。 */
    const locateBook = async (bookId) => {
        for (const root of collectRoots()) {
            const fsio = makeFsio(root);
            const text = await fsio.readText(`${bookId}/novel.json`).catch(() => null);
            if (text) return { fsio, text, root };
        }
        return null;
    };

    return { makeFsio, collectRoots, scanAllBooks, locateBook };
}