// lib/fsio.js — 全插件唯一的书稿 io 收口。
//
// 硬性约定（AGENTS.md 不变量 1）：工作区内的一切读写都走 ctx.fs，
// 让宿主的沙箱、审批与 fs 观测策略像内置工具一样生效。本文件是唯一
// 允许出现 ctx.fs 调用的地方（工具层只 import 这里的工厂）。
//
// 路径全部使用工作区相对 POSIX 路径（如 `我的书/账本/facts.json`），
// resolve 时把会话 cwd 交给宿主后端——与 dsh-files 的做法一致。
import path from 'node:path';

/** 会话 cwd（dsh-files 同款解析）；headless 等无 cwd 场景回退进程 cwd。 */
export function sessionCwd(exec) {
    return exec?.agent?.session?.header?.cwd ?? process.cwd();
}

/**
 * 会话 id（`SessionHeader.id`，见 @deepseek-ai/dsh-session 的 SessionHeader）。
 * 工具层用它做「书 → 会话」归属，让面板按会话过滤项目列表；取不到就返回 null。
 */
export function sessionIdOf(exec) {
    const id = exec?.agent?.session?.header?.id;
    return typeof id === 'string' && id !== '' ? id : null;
}

/** 书目目录名合法性：禁路径分隔符与前导点，防穿越。 */
export function assertBookName(book) {
    if (typeof book !== 'string' || book.trim().length === 0) {
        throw new Error('book（书目名）不能为空');
    }
    const name = book.trim();
    if (name.length > 64 || /[\\/]/.test(name) || name.startsWith('.')) {
        throw new Error(`book 名不合法：「${name}」（长度≤64，不含 / \\ 与 . 前缀）`);
    }
    return name;
}

/** 工作区相对路径拼接：book 目录 + 库内相对路径。 */
export function bookPath(cwd, book, ...rest) {
    return path.join(cwd, assertBookName(book), ...rest);
}

/**
 * 会话 scoped 的沙箱策略（与内置 fs 工具同界）。
 *
 * 宿主内置写路径（dsh-tool-fs）会把按 exec 解析出的 sandboxPolicy 作为第 5 参
 * 传给 ctx.fs.writeText；插件此前不传，宿主在 checkedTarget 里兜底
 * `sandboxPolicy.resolve()`——**无 session**，workspaceRoot 回落 web 进程 cwd。
 * 会话工作区 ≠ 进程 cwd 的部署（典型：Windows 上 dsh web 从家目录启动、会话
 * 开在 D:\某目录）会把工作区内的正常写判成越界：FS_SANDBOX_DENIED。
 * 这里把 exec 的 session 显式交给策略服务，让插件的写界与内置工具对齐。
 *
 * 双路探测沿用 engine.js 的 readService 惯例（ctx[prop] 优先、ctx.get 兜底，
 * 未注册即抛——视为缺失）；服务缺失或 resolve 异常一律返回 undefined，
 * 第 5 参缺省 = 宿主自己兜底，与旧行为完全一致，绝不放大故障。
 *
 * REST 面（createServerFsio）没有 exec，fsio 绑定的是所操作书根的 cwd——
 * CodeBuddy 审查（2026-09-20）P2 的同族半边：resolve({}) 无 session → workspaceRoot
 * 回落 web 进程 cwd，「书在非 web-cwd 工作区」的部署下面板写盘仍会被拒。宿主
 * resolve 只认 {session, mode}、无显式 root 入口。曾考虑按绑定 cwd 匹配 live 会话
 * 线程其策略，复核源码后放弃：sessions 服务虽在宿主 base 层装载（dsh-base/
 * cordis.patch.yml L34，SessionStore list() 在 L1562 可调），但 store 由创建 fiber
 * 持有（create() doc L1327）——会话只在 fiber 驻留窗口在册，store 空置期命中≈0；
 * 且把会话的 model 侧 mode 覆盖带进用户面板动作是错误语义，伪造会话壳还会撞
 * sessionProjections.stateOf 对未知会话的抛错。终态：REST 面保持 resolve({})
 * （mode 全权由 resolver 判定），fsio 用绑定的书根**只覆盖 workspaceRoot**——
 * 确定、最小、空闲期同样生效。
 */
function sandboxPolicyOf(ctx, exec, rootOverride) {
    // cordis 对未在顶层 inject 声明的 ctx 属性，直接访问会抛
    // "cannot get property X without inject"（可选链防不住 getter 内部 throw），
    // 与下方 ctx.get 未注册抛错同语义 —— 一律视为缺失。
    let svc;
    try {
        svc = ctx?.sandboxPolicy;
    } catch { /* 视为缺失，走 ctx.get 双路探测 */ }
    if (svc === undefined || svc === null) {
        try {
            if (typeof ctx?.get === 'function') svc = ctx.get('sandboxPolicy');
        } catch { /* cordis：未注册服务的获取会抛 —— 视为缺失 */ }
    }
    if (svc === undefined || svc === null || typeof svc.resolve !== 'function') return undefined;
    const session = exec?.agent?.session;
    try {
        const policy = svc.resolve(session === undefined ? {} : { session });
        // 只覆无 session 形态的根：有 session 时 workspaceRoot 已是会话自己的 header.cwd，
        // 插件不得擅改 resolver 判出的写界；覆根同样只在 rootOverride 给准时生效。
        if (session === undefined && typeof rootOverride === 'string' && rootOverride !== '') {
            return { ...policy, workspaceRoot: path.resolve(rootOverride) };
        }
        return policy;
    } catch {
        return undefined;
    }
}

/**
 * 带策略线程的守卫写：policy 存在时作为第 5 参传给宿主（与 dsh-tool-fs 同参位，
 * 沙箱后端 `writeText(target, content, expected, signal, sandboxPolicy)`）；
 * 裸后端对多余的第 5 参视而不见，无回归。rootOverride = REST 面绑定的书工作区根
 * （无 exec 时覆盖策略的 workspaceRoot，见 sandboxPolicyOf）。FS_SANDBOX_DENIED 在此改写为
 * 可行动提示（保留宿主原文），其余错误原样上抛。宿主拒绝错误是 FsError 带 code
 * （dsh-fs-sandbox L157/164），识别优先匹配 code、文案包含只作旧宿主兜底——
 * 宿主文案一改不至于让提示静默失效（CodeBuddy P3）。
 *
 * 提示分三段（评审 2026-09-20：同一文案两场合用，REST 场景「切会话策略」治标不治本）：
 * - policy 未线程成功（服务缺席/resolve 抛错）：宿主兜底 resolve() 无 session——mode=部署默认、
 *   根=web 启动目录，此时**连工具面**切会话策略也无效；只能动部署默认 mode 或换启动目录。
 * - policy 线程成功 + 有会话：resolve({session}) 认会话级 mode 覆盖，切 danger-full-access 有效。
 * - policy 线程成功 + 无会话（REST）：mode 取部署默认（宿主判定链 request.mode ?? 会话覆盖 ??
 *   默认，session 缺席时连 overrideOf 都不问）——切会话策略无效，该动部署默认；mode 从宿主
 *   文案解析（read-only = mode 级拒绝；workspace-write 还拒 = 意外态，请反馈）。
 */
async function writeGuarded(ctx, exec, target, text, intent, sig, rootOverride) {
    const policy = sandboxPolicyOf(ctx, exec, rootOverride);
    try {
        return policy === undefined
            ? await ctx.fs.writeText(target, text, intent, sig)
            : await ctx.fs.writeText(target, text, intent, sig, policy);
    } catch (error) {
        if (error?.code === 'FS_SANDBOX_DENIED' || (error instanceof Error && error.message.includes('file access denied under'))) {
            const mode = /file access denied under (\S+) mode/.exec(error?.message ?? '')?.[1];
            const hint = policy === undefined
                ? (mode === 'read-only'
                    ? '宿主策略服务未命中，写界回落宿主兜底（mode=部署默认、根=web 启动目录），切会话策略无效——解法：①把部署默认文件策略（sandboxPolicy.mode 配置）调成 workspace-write；②从书/会话所在工作区目录启动 dsh web。）'
                    : '沙箱写界回落 web 启动目录（宿主策略服务未命中），把工作区内的写判了越界——解法：从书/会话所在工作区目录启动 dsh web，或更新宿主/插件恢复策略线程。）')
                : exec?.agent?.session !== undefined
                    ? '会话路径解法任选：①把该会话的文件策略切到 danger-full-access；②更新本插件（写盘调用已线程会话策略）。）'
                    : (mode === 'read-only'
                        ? '面板路径 mode 取的是部署默认（不读会话级覆盖——把该会话切 danger-full-access 无效），把部署默认文件策略（sandboxPolicy.mode 配置）调成 workspace-write。）'
                        : '面板路径写界已线程到书工作区仍被拒——请更新宿主/插件，若仍复现请带此文案反馈。）');
            throw new Error(`${error.message}（dsh-novel-forge：这是文件沙箱策略拒绝，不是磁盘权限问题。${hint}`);
        }
        throw error;
    }
}

/**
 * 一次工具执行内的 io 适配器。所有方法接受「工作区相对」路径。
 * mode 语义：
 *   'create'  → createIfAbsent（目标已存在则 FS_NOT_OBSERVED）——版本文件用，永不覆盖；
 *   'replace' → 无条件 create-or-overwrite；
 *   'auto'    → stat 出 version 就 replaceIfVersion 守卫写，否则新建——状态文件用。
 */
export function createFsio(ctx, exec, cwd) {
    const signal = exec.signal;

    async function resolvePath(p) {
        return ctx.fs.resolve(p, { cwd, signal });
    }

    const api = {
        cwd,
        /** 本次执行所属会话（工具层用它补录书目归属；无会话时为 null）。 */
        sessionId: sessionIdOf(exec),

        /** stat；不存在返回 null。 */
        async stat(p) {
            const target = await resolvePath(p);
            const info = await ctx.fs.stat(target, signal);
            return info === undefined ? null : { target, info };
        },

        /** 解析成宿主视角的绝对路径（不 stat，允许目标尚不存在）。
         *  派生索引（sqlite 索引文件）这类需要真实磁盘路径的场景用它。 */
        async abs(p) {
            return resolvePath(p);
        },

        /** 存在且是文件则返回文本，否则 null。 */
        async readText(p) {
            const f = await api.stat(p);
            if (f === null || f.info.type !== 'file') return null;
            return ctx.fs.readText(f.target, signal);
        },

        /** 读文本 + **读取时**的版本（乐观并发的读侧）。不存在 → {text:null, version:null}。 */
        async readTextWithVersion(p) {
            const f = await api.stat(p);
            if (f === null || f.info.type !== 'file') return { text: null, version: null };
            return { text: await ctx.fs.readText(f.target, signal), version: f.info.version };
        },

        /** readJson + 基线版本：`{value, version}`；文件不存在时两者均为 null。 */
        async readJsonWithVersion(p) {
            const { text, version } = await api.readTextWithVersion(p);
            if (text === null) return { value: null, version: null };
            try {
                return { value: JSON.parse(text), version };
            } catch (error) {
                throw new Error(`${p} 不是合法 JSON（可能被手工改坏）：${error.message}`);
            }
        },

        async readJson(p) {
            const text = await api.readText(p);
            if (text === null) return null;
            try {
                return JSON.parse(text);
            } catch (error) {
                throw new Error(`${p} 不是合法 JSON（可能被手工改坏）：${error.message}`);
            }
        },

        async readJsonl(p) {
            const text = await api.readText(p);
            if (text === null) return [];
            return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
        },

        async writeText(p, text, mode = 'auto') {
            const target = await resolvePath(p);
            let intent;
            if (mode === 'create') {
                intent = { kind: 'createIfAbsent' };
            } else if (mode === 'replace') {
                intent = undefined;
            } else {
                const f = await api.stat(p);
                intent = f === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: f.info.version };
            }
            const out = await writeGuarded(ctx, exec, target, text, intent, signal);
            ctx.emit('fs/observed', target, { kind: 'present', version: out.version }, exec);
            return out;
        },

        /**
         * 守卫写（乐观并发的写侧）：按**调用方读取时**捕获的 version 做 replaceIfVersion。
         *
         * 与 'auto' 的差别是这件事的本质：'auto' 是「stat 完立刻写」，守卫窗口只有
         * 毫秒级，对「读→改→写」的竞态形同虚设（H2 的根因）——基线版本必须来自读
         * 的那一刻，冲突才判得出来。version === null = 当时不存在 → createIfAbsent
         * （期间被人建了就该响亮失败，而不是把别人的成果覆盖掉）。
         */
        async writeTextAtVersion(p, text, version) {
            const target = await resolvePath(p);
            const intent = version === null || version === undefined
                ? { kind: 'createIfAbsent' }
                : { kind: 'replaceIfVersion', version };
            const out = await writeGuarded(ctx, exec, target, text, intent, signal);
            ctx.emit('fs/observed', target, { kind: 'present', version: out.version }, exec);
            return out;
        },

        async writeJsonAtVersion(p, value, version) {
            return api.writeTextAtVersion(p, `${JSON.stringify(value, null, 2)}\n`, version);
        },

        async writeJson(p, value, mode = 'auto') {
            return api.writeText(p, `${JSON.stringify(value, null, 2)}\n`, mode);
        },

        /** 列目录内文件名（不存在/非目录返回 []）；listDir 只读元数据不读内容。 */
        async listNames(p) {
            const f = await api.stat(p);
            if (f === null || f.info.type !== 'directory') return [];
            const entries = await ctx.fs.listDir(f.target, signal);
            return entries.filter((e) => e.type === 'file').map((e) => e.name);
        },

        /** 尾部追加（读-改-写 + 版本守卫；audit.jsonl 用）。 */
        async appendLine(p, line) {
            const f = await api.stat(p);
            if (f === null) {
                await api.writeText(p, `${line}\n`, 'create');
                return;
            }
            const cur = await ctx.fs.readText(f.target, signal);
            const base = cur === '' || cur.endsWith('\n') ? cur : `${cur}\n`;
            await writeGuarded(
                ctx,
                exec,
                f.target,
                `${base}${line}\n`,
                { kind: 'replaceIfVersion', version: f.info.version },
                signal
            );
        },
    };

    return api;
}

/**
 * 审计行（append-only）。
 *
 * `actor` 记录**是谁做的这个动作**——这是「批准钥匙在谁手里」的唯一证据：
 *   user   → 用户从面板/REST 触发（如 apply 提案）
 *   agent  → 模型调工具触发（默认）
 *   system → 插件自动推进（如机审、自动归档）
 * 放在展开之后，保证业务 detail 无法覆盖它。
 */
export function auditLine(action, detail, actor = 'agent') {
    return JSON.stringify({ ts: new Date().toISOString(), action, ...detail, actor });
}

/**
 * 轻量级 fsio 适配器——不需要 exec/signal，供 REST API 等无宿主 exec 场景使用。
 *
 * 与 createFsio() **接口同构**（readJson/writeJson/appendLine 一应俱全），
 * 这样「提案应用」「审计写入」这类逻辑可以写一份、工具层与 REST 层共用
 * （见 lib/proposals.js），不必两边各写一遍 JSON 解析与路径拼接。
 *
 * 差异：无 exec，故无 signal 传递；writeText/writeJson 支持 createFsio 的
 * create/replace/auto 三种 mode（0.13.6 起，此前 mode 被静默丢弃）。
 */
export function createServerFsio(ctx, cwd) {
    async function resolvePath(p) {
        return ctx.fs.resolve(p, { cwd });
    }
    const api = {
        cwd,
        async stat(p) {
            const target = await resolvePath(p);
            const info = await ctx.fs.stat(target);
            return info === undefined ? null : { target, info };
        },
        /** 解析成宿主视角的绝对路径（不 stat）。派生索引（sqlite 文件）用。 */
        async abs(p) {
            return resolvePath(p);
        },
        async readText(p) {
            const f = await api.stat(p);
            if (f === null || f.info.type !== 'file') return null;
            return ctx.fs.readText(f.target);
        },
        async readJson(p) {
            const text = await api.readText(p);
            if (text === null) return null;
            try {
                return JSON.parse(text);
            } catch (error) {
                throw new Error(`${p} 不是合法 JSON（可能被手工改坏）：${error.message}`);
            }
        },
        async readJsonl(p) {
            const text = await api.readText(p);
            if (text === null) return [];
            return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
        },
        /** 读文本 + **读取时**的版本（与 createFsio 同名同义）。 */
        async readTextWithVersion(p) {
            const f = await api.stat(p);
            if (f === null || f.info.type !== 'file') return { text: null, version: null };
            return { text: await ctx.fs.readText(f.target), version: f.info.version };
        },
        /** readJson + 基线版本：`{value, version}`；文件不存在时两者均为 null。 */
        async readJsonWithVersion(p) {
            const { text, version } = await api.readTextWithVersion(p);
            if (text === null) return { value: null, version: null };
            try {
                return { value: JSON.parse(text), version };
            } catch (error) {
                throw new Error(`${p} 不是合法 JSON（可能被手工改坏）：${error.message}`);
            }
        },
        /** 与 createFsio 的 writeText 同构（H1 修复）：mode 此前被静默丢弃，工具面
         *  'create'（存在即失败）的语义在 REST 路径变成了无条件覆盖。缺省 'auto'
         *  = stat 到版本就 replaceIfVersion 守卫写，否则新建。 */
        async writeText(p, text, mode = 'auto') {
            const target = await resolvePath(p);
            let intent;
            if (mode === 'create') {
                intent = { kind: 'createIfAbsent' };
            } else if (mode === 'replace') {
                intent = undefined;
            } else {
                const f = await api.stat(p);
                intent = f === null ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: f.info.version };
            }
            return writeGuarded(ctx, undefined, target, text, intent, undefined, cwd);
        },
        async writeJson(p, value, mode = 'auto') {
            return api.writeText(p, `${JSON.stringify(value, null, 2)}\n`, mode);
        },
        /**
         * 守卫写：按**调用方读取时**捕获的 version 做 replaceIfVersion（与 createFsio 同名同义）。
         *
         * 取代原先的 writeTextIfVersion —— 那个方法是「写前一刻自己 stat」，版本永远
         * 匹配，对「读→改→写」的竞态毫无约束力（H2 的根因），留着只会给人一种已经
         * 守卫过的错觉。守卫基线必须由调用方从读取那一刻带进来。
         * version === null = 当时不存在 → createIfAbsent（期间被人建了就响亮失败）。
         */
        async writeTextAtVersion(p, text, version) {
            const target = await resolvePath(p);
            const intent = version === null || version === undefined
                ? { kind: 'createIfAbsent' }
                : { kind: 'replaceIfVersion', version };
            return writeGuarded(ctx, undefined, target, text, intent, undefined, cwd);
        },
        async writeJsonAtVersion(p, value, version) {
            return api.writeTextAtVersion(p, `${JSON.stringify(value, null, 2)}\n`, version);
        },
        /** 列目录下子目录名（不存在/非目录返回 []）。scanBooks 按工作区根扫书用。 */
        async listDirs(p) {
            const f = await api.stat(p);
            if (f === null || f.info.type !== 'directory') return [];
            const entries = await ctx.fs.listDir(f.target);
            return entries.filter((e) => e.type === 'directory').map((e) => e.name);
        },
        /** 列目录下全部条目（含文件）——listNames 只回目录，列角色卡等 .md 文件用它。 */
        async listEntries(p) {
            const f = await api.stat(p);
            if (f === null || f.info.type !== 'directory') return [];
            const entries = await ctx.fs.listDir(f.target);
            return entries.map((e) => ({ name: e.name, type: e.type }));
        },
        /** 列目录内**文件名**（不存在/非目录返回 []）——克隆细纲目录用（与 createFsio.listNames 同名同义）。 */
        async listNames(p) {
            const entries = await api.listEntries(p);
            return entries.filter((e) => e.type === 'file').map((e) => e.name);
        },
        /** 尾部追加（读-改-写 + 版本守卫）；audit.jsonl 用。 */
        async appendLine(p, line) {
            const f = await api.stat(p);
            if (f === null) {
                await api.writeText(p, `${line}\n`);
                return;
            }
            const cur = await ctx.fs.readText(f.target);
            const base = cur === '' || cur.endsWith('\n') ? cur : `${cur}\n`;
            const target = await resolvePath(p);
            await writeGuarded(
                ctx,
                undefined,
                target,
                `${base}${line}\n`,
                { kind: 'replaceIfVersion', version: f.info.version },
                undefined,
                cwd            // REST 面审计追加同样覆根——漏了它，存章成功后的 audit 写会最先撞非 cwd 工作区拒绝
            );
        },
    };
    return api;
}

/**
 * 宿主的「版本守卫写失败」判定。
 *
 * 两种都算冲突：replaceIfVersion 版本不符（FS_STALE_VERSION）、以及读时不存在、
 * 写时被别人先建了（createIfAbsent → FS_NOT_OBSERVED）。宿主把 code 放在
 * `error.code`，非宿主通道（mcp-standalone）报错时带同名前缀，两处都认。
 */
const CONFLICT_CODES = new Set(['FS_STALE_VERSION', 'FS_NOT_OBSERVED', 'FS_VERSION_CONFLICT']);
export function isVersionConflict(error) {
    if (CONFLICT_CODES.has(String(error?.code ?? ''))) return true;
    return /^FS_(STALE_VERSION|NOT_OBSERVED|VERSION_CONFLICT)\b/.test(String(error?.message ?? error ?? ''));
}

/**
 * 乐观并发地更新一个 JSON 文档：**读→捕获基线版本→改→守卫写**，冲突则重读重放。
 *
 * 为什么不是「冲突就报错让用户重试」：面板点「应用提案」与另一端润色登记提案撞车时，
 * 报 500 等于把工程问题丢回给人；而这里的改动（push 一条索引 / 改一个 status）
 * 都是幂等可重放的——重读最新内容再重放，两边的更新都留得下来。
 *
 * 为什么必须「读时捕获版本」：'auto' 是 stat 完立刻写，守卫窗口只有毫秒级，对
 * 读-改-写这种真正的竞态形同虚设 —— 0.13.6 那次「提案全链路版本守卫」就是这么个
 * 看着有、实际拦不住东西（H2 的根因）。
 *
 * @param mutator (current, attempt) => { value, result } | undefined
 *        current = 文档当前内容（文件不存在时为 undefined）；返回 undefined = 不改不写。
 * @returns {Promise<{written: boolean, result: *, attempts: number}>}
 */
export async function updateJson(io, p, mutator, { attempts = 3 } = {}) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        const { value, version } = await io.readJsonWithVersion(p);
        const next = await mutator(value === null ? undefined : value, attempt);
        if (next === undefined || next === null) {
            return { written: false, result: undefined, attempts: attempt + 1 };
        }
        try {
            await io.writeJsonAtVersion(p, next.value, version);
            return { written: true, result: next.result, attempts: attempt + 1 };
        } catch (error) {
            if (!isVersionConflict(error)) throw error;
            lastError = error; // 别人先写了：下一轮重读最新内容再重放本次改动
        }
    }
    throw lastError;
}
