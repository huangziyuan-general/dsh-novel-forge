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

    const versionOf = (p) => {
        try {
            const s = fs.statSync(p);
            return `v:${s.mtimeMs.toFixed(3)}:${s.size}`;
        } catch {
            return undefined;
        }
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
            await fsp.writeFile(p, content, 'utf8');
            return { operation: exists ? 'update' : 'create', version: versionOf(p), before, after: content };
        },
    };
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
        minChapterChars: 500,
        maxChapterChars: 12000,
        contextBudgetChars: 6000,
        scanTopK: 8,
        repetitionWindow: 10,
        skipPresetDeploy: true, // MCP 通道绝不碰 ~/.dsh
    });
    const exec = { agent: { session: { header: { cwd: workspace } } } };

    // 输出契约校验与宿主通道同标准：返回值违反 output.schema 一律拒绝。
    // dsh-tools 是 peerDependency，MCP 通道运行时必然已装；防御性动态导入兜底。
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
