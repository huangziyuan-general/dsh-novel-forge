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
            const out = await ctx.fs.writeText(target, text, intent, signal);
            ctx.emit('fs/observed', target, { kind: 'present', version: out.version }, exec);
            return out;
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
            await ctx.fs.writeText(
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
            return ctx.fs.writeText(target, text, intent);
        },
        async writeJson(p, value, mode = 'auto') {
            return api.writeText(p, `${JSON.stringify(value, null, 2)}\n`, mode);
        },
        /** 版本守卫写：stat 到 version 就 replaceIfVersion，防并发互相覆盖（REST 认领/写章记录用）。
         *  目标不存在则普通新建——与 createFsio 的 'auto' 模式同构。 */
        async writeTextIfVersion(p, text) {
            const f = await api.stat(p);
            const target = await resolvePath(p);
            const intent = f === null ? undefined : { kind: 'replaceIfVersion', version: f.info.version };
            return ctx.fs.writeText(target, text, intent);
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
            await ctx.fs.writeText(
                target,
                `${base}${line}\n`,
                { kind: 'replaceIfVersion', version: f.info.version }
            );
        },
    };
    return api;
}
