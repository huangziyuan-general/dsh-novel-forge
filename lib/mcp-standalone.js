// lib/mcp-standalone.js — 插件在宿主之外（MCP stdio）的独立运行时。
//
// 目标：同一份工具实现，两种通道——
//   ① dsh 宿主内：ctx.fs 走宿主沙箱（fsio.js 是唯一收口）；
//   ② 宿主外：这里提供一个语义对齐的 node:fs 后端（含工作区 containment 与
//      版本守卫），让 Claude Desktop / Cursor 等任意 MCP 客户端也能用 novel_* 工具。
//
// 与宿主后端对齐的关键语义（fsio.js 依赖的三件事）：
//   - resolve：工作区相对路径 → target 对象；越界（穿越/绝对路径逃逸）拒绝；
//   - stat：返回 { type, version, size }，version 用 mtimeMs+size 构造；
//   - writeText：createIfAbsent / replaceIfVersion 守卫，冲突抛 FS_NOT_OBSERVED。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** node:fs 版宿主后端。root 为工作区绝对路径（containment 根）。 */
export function createNodeFsBackend(root) {
    const abs = (p) => path.resolve(p);

    // root 本身可能是符号链接：统一到真实路径再做相对比较。
    const safeRealpath = (p) => {
        try { return fs.realpathSync(p); } catch { return null; }
    };
    const ROOT_REAL = safeRealpath(abs(root)) ?? abs(root);

    /**
     * 追符号链接的 containment 校验（比 path.resolve 的词法检查更严）：
     * 路径存在 → realpath 后必须在 ROOT_REAL 内（工作区里的软链指向区外即拒绝）；
     * 路径不存在（待创建新文件）→ 对最近的存在祖先 realpath，再拼回剩余段
     * （剩余段将创建在真实目录之内，不经过任何链接）。
     */
    function realWithin(p) {
        let cur = p;
        const miss = [];
        for (;;) {
            const real = safeRealpath(cur);
            if (real !== null) {
                const rel = path.relative(ROOT_REAL, real);
                // rel === '' 仅当目标路径恰为 root 本身时拒绝；
                // 祖先回溯走到 root（rel === '' 且有 miss 段）是新建文件的正路，放行。
                if (rel.startsWith('..') || path.isAbsolute(rel) || (rel === '' && miss.length === 0)) {
                    const error = new Error(`FS_SANDBOX_DENIED: ${p}（符号链接解析后）越出工作区 ${ROOT_REAL}`);
                    error.code = 'FS_SANDBOX_DENIED';
                    throw error;
                }
                return miss.length === 0 ? real : path.join(real, ...miss);
            }
            const parent = path.dirname(cur);
            if (parent === cur) {
                const error = new Error(`FS_SANDBOX_DENIED: ${p} 越出工作区 ${ROOT_REAL}`);
                error.code = 'FS_SANDBOX_DENIED';
                throw error;
            }
            miss.unshift(path.basename(cur));
            cur = parent;
        }
    }

    function contained(target) {
        return realWithin(abs(target.targetKey));
    }

    // L5 修复：mtimeMs+size 构造的版本在「同一毫秒内写两次、长度恰好相同」时
    // 完全相同——replaceIfVersion 检测不到并发覆盖。补进程内单调写序号 + 进程
    // 存活期 nonce：同进程内每次写版本必变；进程重启后旧版本一律失效。
    const writeSeq = new Map();
    const BOOT_NONCE = Math.random().toString(36).slice(2, 8);
    const versionOf = (p) => {
        try {
            const s = fs.statSync(p);
            return `v:${BOOT_NONCE}:${s.mtimeMs.toFixed(3)}:${s.size}:${writeSeq.get(p) ?? 0}`;
        } catch {
            return undefined;
        }
    };

    // 同路径写互斥（真机竞态实证 2026-10-14）：REST 面板双开并发保存同一章时，两个
    // writeText 的「校验版本 → writeFile」交错，重放循环 3 次内互抢耗尽 → 500；且
    // writeFile 的 O_TRUNC 中间态会被并发 readText 读到 → novel.json「不是合法 JSON」
    // 误报。进程内把同路径的写串行化（校验+写+递增 seq 成为原子段），读侧配合下面的
    // tmp+rename 原子替换，两个窗口一起关死；跨进程的兜底仍是 fsio.updateJson 的
    // 冲突重放。不同路径照常并行，无行为变化。
    const writeLocks = new Map();
    const withPathLock = (p, fn) => {
        const prev = writeLocks.get(p) ?? Promise.resolve();
        const next = prev.catch(() => {}).then(fn);
        writeLocks.set(p, next);
        // 清理链必须吞掉 rejection：next 原样返回给调用方（由它 catch/重放），
        // 泄漏的 finally 链会以 unhandledRejection 的形式炸测试（真机实证 2026-10-14）。
        next.catch(() => {}).then(() => { if (writeLocks.get(p) === next) writeLocks.delete(p); });
        return next;
    };

    return {
        async resolve(p, opts) {
            const full = path.isAbsolute(p) ? p : path.join(opts?.cwd ?? root, p);
            const norm = path.resolve(full);
            const rel = path.relative(root, norm);
            if (rel.startsWith('..') || path.isAbsolute(rel)) {
                const error = new Error(`FS_SANDBOX_DENIED: ${p} 越出工作区 ${root}`);
                error.code = 'FS_SANDBOX_DENIED';
                throw error;
            }
            realWithin(norm); // 追符号链接的权威校验（工作区软链指向区外即拒绝）
            return { targetKey: norm, displayPath: rel };
        },

        async stat(target) {
            const p = contained(target);
            try {
                const s = fs.statSync(p);
                return {
                    version: versionOf(p),
                    type: s.isDirectory() ? 'directory' : (s.isFile() ? 'file' : 'other'),
                    size: s.size,
                };
            } catch {
                return undefined;
            }
        },

        async readText(target) {
            return fsp.readFile(contained(target), 'utf8');
        },

        // 与宿主 dsh-fs 契约同语义（AGENTS 不变量 1）：readBytes 要求 maxBytes、
        // 超限 FS_TOO_LARGE 拒绝而非截断——先 stat 校大小，绝不无界缓冲。
        // docx 这类二进制导入源用（文本通道会把二进制解坏）。
        async readBytes(target, _signal, maxBytes) {
            if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes < 1) {
                const error = new Error('FS_TOO_LARGE: readBytes 必须传 maxBytes（宿主契约）');
                error.code = 'FS_TOO_LARGE';
                throw error;
            }
            const p = contained(target);
            const s = await fsp.stat(p);
            if (s.size > maxBytes) {
                const error = new Error(`FS_TOO_LARGE: ${p} 共 ${s.size} 字节，超过 maxBytes ${maxBytes}，拒绝读取`);
                error.code = 'FS_TOO_LARGE';
                throw error;
            }
            return fsp.readFile(p);
        },

        async appendLine(target, line) {
            // 原生追加（真机竞态实证 2026-10-14）：fsio 适配器的「stat→不存在 create /
            // 存在 read+replace」在并发下两请求都 stat 到 null → 后者撞 FS_NOT_OBSERVED；
            // 「存在 read+replace」两请求读到同一版本 → 后者 FS_STALE_VERSION。同路径写
            // 锁内做读-拼-原子替换，追加语义就是进程内原子的；fsio 适配器检测到本方法
            // 存在即委托（宿主后端没有它，走原逻辑不受影响）。
            // 入参兼容两种形态：fsio 适配器传逻辑相对路径字符串（相对 root），
            // 本 backend 的 stat/listDir 链路传 { targetKey }（绝对）——统一归一。
            const key = typeof target === 'string' ? target : target?.targetKey;
            if (typeof key !== 'string' || key === '') {
                const error = new Error(`FS_INVALID_TARGET: appendLine 入参既不是路径字符串也不是 { targetKey }`);
                error.code = 'FS_INVALID_TARGET';
                throw error;
            }
            const p = realWithin(path.resolve(path.isAbsolute(key) ? key : path.join(root, key)));
            return withPathLock(p, async () => {
                let cur = null;
                try { cur = fs.readFileSync(p, 'utf8'); } catch { cur = null; }
                const exists = cur !== null;
                const base = cur === null || cur === '' || cur.endsWith('\n') ? (cur ?? '') : `${cur}\n`;
                await fsp.mkdir(path.dirname(p), { recursive: true });
                const tmp = `${p}.nf-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
                try {
                    await fsp.writeFile(tmp, `${base}${line}\n`, 'utf8');
                    await fsp.rename(tmp, p);
                } catch (error) {
                    await fsp.unlink(tmp).catch(() => {});
                    throw error;
                }
                writeSeq.set(p, (writeSeq.get(p) ?? 0) + 1);
                return { operation: exists ? 'update' : 'create', version: versionOf(p) };
            });
        },

        async listDir(target) {
            const p = contained(target);
            return fs.readdirSync(p, { withFileTypes: true }).map((d) => ({
                name: d.name,
                type: d.isDirectory() ? 'directory' : (d.isFile() ? 'file' : 'other'),
                target: { targetKey: path.join(p, d.name), displayPath: d.name },
            }));
        },

        async writeText(target, content, intent) {
            const p = contained(target);
            return withPathLock(p, async () => {
                const exists = fs.existsSync(p);
                if (intent?.kind === 'createIfAbsent' && exists) {
                    const error = new Error(`FS_NOT_OBSERVED: ${p} 已存在`);
                    error.code = 'FS_NOT_OBSERVED';
                    throw error;
                }
                if (intent?.kind === 'replaceIfVersion') {
                    const cur = versionOf(p);
                    if (cur !== intent.version) {
                        const error = new Error(`FS_VERSION_CONFLICT: ${p} 已被并发修改（期望 ${intent.version}，实际 ${cur}）`);
                        error.code = 'FS_VERSION_CONFLICT';
                        throw error;
                    }
                }
                await fsp.mkdir(path.dirname(p), { recursive: true });
                const before = exists ? fs.readFileSync(p, 'utf8') : null;
                // 原子替换：先写同目录临时文件再 rename——并发 readText 永远看到
                // 完整旧版或完整新版，不再有 TRUNC 中间态（rename 同目录同文件系统，原子）。
                const tmp = `${p}.nf-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
                try {
                    await fsp.writeFile(tmp, content, 'utf8');
                    await fsp.rename(tmp, p);
                } catch (error) {
                    await fsp.unlink(tmp).catch(() => {});   // 失败清理，不留垃圾临时件
                    throw error;
                }
                writeSeq.set(p, (writeSeq.get(p) ?? 0) + 1);
                return { operation: exists ? 'update' : 'create', version: versionOf(p), before, after: content };
            });
        },
    };
}

/**
 * 工具参数表 → MCP inputSchema（mcp/server.mjs 的 tools/list 用）。
 * 宿主 defineTool 产出的 parameters **已经是完整 JSON Schema**
 * （{ type:'object', properties, required }）——原样放行，绝不再包一层；
 * 同时兼容「参数名 → spec」的旧形状（宿主包缺席时垫片直通的就是它）。
 * 历史：曾把 JSON Schema 当逐参数映射再包一层，20 个工具的 inputSchema
 * 全部退化成空参数表——脚本侧 JSON-RPC 不校验所以隐形，表单类 MCP 客户端
 * （按 inputSchema 渲染表单）则一个参数都填不了。回归由 test/mcp.test.mjs 钉住。
 */
export function toInputSchema(parameters) {
    if (
        parameters !== null && typeof parameters === 'object' &&
        parameters.type === 'object' &&
        parameters.properties !== null && typeof parameters.properties === 'object' &&
        !Array.isArray(parameters.properties)
    ) {
        return {
            type: 'object',
            properties: parameters.properties,
            required: Array.isArray(parameters.required) ? parameters.required : [],
        };
    }
    const properties = {};
    const required = [];
    for (const [name, spec] of Object.entries(parameters ?? {})) {
        if (spec === null || typeof spec !== 'object') continue;
        const prop = { type: spec.type, description: spec.description };
        if (spec.enum !== undefined) prop.enum = spec.enum;
        properties[name] = prop;
        if (spec.required === true) required.push(name);
    }
    return { type: 'object', properties, required };
}

/**
 * 独立运行时：在 root 工作区上装配全部 novel_* 工具。
 * 返回 { tools, call(name, args), root }——call 绑定好 exec。
 */
export async function buildStandaloneTools(root) {
    const workspace = path.resolve(root);
    const { apply } = await import('./index.js');
    const registered = [];
    const ctx = {
        fs: createNodeFsBackend(workspace),
        emit() {},
        logger: { info() {} },
        tools: { register: (t) => registered.push(t) },
        systemPrompt: { section() {} },
        inject: (deps, fn) => { fn(ctx); },
        effect: (fn) => { fn(); },
        webServer: { register: () => () => {} },
    };
    apply(ctx, {
        minChapterChars: 2000,
        maxChapterChars: 4000,
        contextBudgetChars: 6000,
        scanTopK: 8,
        repetitionWindow: 10,
        noaiCrossWindow: 20,
        pacing: {
            enabled: true,
            brake: 'blocking',
            brakeGroups: 2,
            maxConsecutiveFast: 1,
            maxFastPerVolume: 3,
            volumeChapters: 20,
            slowWindow: 4,
            maxSlowPerWindow: 2,
        },
        skipPresetDeploy: true, // MCP 通道绝不碰 ~/.dsh
    });
    const exec = { agent: { session: { header: { cwd: workspace } } } };

    // 输出契约校验与宿主通道同标准：返回值违反 output.schema 一律拒绝。
    // dsh-tools 是 peerDependency，但独立 MCP 通道（Claude Desktop / Cursor 等
    // 无宿主环境的进程）里它可能不存在：动态导入 + 缺席回退——校验不可用时
    // 退化为不校验（工具本体照常工作）。lib/tools/define-tool.js 对同一依赖
    // 走同样的动态导入，**别改回顶层静态 import**——那会在任何兜底执行之前
    // 把进程炸死（ERR_MODULE_NOT_FOUND），tools/list 一个工具都出不来。
    let validateSchema = null;
    try {
        ({ validateJsonSchemaValue: validateSchema } = await import('@deepseek-ai/dsh-tools'));
    } catch { /* 校验不可用时退化为不校验（工具本体照常工作） */ }

    const call = async (name, args) => {
        const t = registered.find((x) => x.name === name);
        if (t === undefined) throw new Error(`未知工具：${name}`);
        const result = await t.execute(args ?? {}, exec);
        if (validateSchema && t.output?.schema) {
            const violations = validateSchema(t.output.schema, result);
            if (violations.length > 0) {
                throw new Error(`INVALID_TOOL_OUTPUT: ${t.name} 违反 output.schema：${violations.join('；')}`);
            }
        }
        return result;
    };
    return { tools: registered, call, root: workspace };
}
