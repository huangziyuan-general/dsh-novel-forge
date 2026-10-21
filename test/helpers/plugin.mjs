// test/helpers/plugin.mjs — 装插件的共用载体（假宿主 fs + 注册表 + exec 会话）。
//
// 为什么抽出来：boot 一套 apply(ctx, config) 的替身要 60 行，抄第三份起就会开始漂移
// （AGENTS.md「同一实现只留一份」）。smoke / platform-persist 里的既有副本先不动
// ——它们已经跑绿几百轮，为了 DRY 去改它们不值当冒回归的险。
//
// 替身纪律：这里镜像的是**真宿主**的语义（resolve/stat/readText/writeText 的 intent
// 与 version 形状），不是我们自己实现的样子。别往这里加宽松行为——替身比真机宽松，
// 绿灯就是假的。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFsio, sessionCwd } from '../../lib/fsio.js';

/** 与 lib/index.js 的 fail-fast 校验兼容的最小配置（skipPresetDeploy：测试绝不碰 ~/.dsh）。 */
export function testConfig(over = {}) {
    return {
        minChapterChars: 2000,
        maxChapterChars: 4000,
        contextBudgetChars: 4000,
        scanTopK: 8,
        repetitionWindow: 10,
        skipPresetDeploy: true,
        ...over,
    };
}

function makeBackend(root) {
    const absOf = (target) => target.targetKey.slice(4);
    return {
        async resolve(p, opts) {
            const abs = path.isAbsolute(p) ? p : path.join(opts?.cwd ?? root, p);
            return { targetKey: 'key:' + abs, displayPath: path.relative(root, abs) };
        },
        async stat(target) {
            const abs = absOf(target);
            try {
                const s = fs.statSync(abs);
                return { version: 'v:' + abs, type: s.isDirectory() ? 'directory' : (s.isFile() ? 'file' : 'other'), size: s.size };
            } catch {
                return undefined;
            }
        },
        async readText(target) { return fs.readFileSync(absOf(target), 'utf8'); },
        async readBytes(target, _signal, maxBytes) {
            const buf = fs.readFileSync(absOf(target));
            if (maxBytes !== undefined && buf.length > maxBytes) {
                const error = new Error('FS_TOO_LARGE');
                error.code = 'FS_TOO_LARGE';
                throw error;
            }
            return new Uint8Array(buf);
        },
        async listDir(target) {
            const abs = absOf(target);
            return fs.readdirSync(abs, { withFileTypes: true }).map((d) => ({
                name: d.name,
                type: d.isDirectory() ? 'directory' : (d.isFile() ? 'file' : 'other'),
                target: { targetKey: 'key:' + path.join(abs, d.name) },
            }));
        },
        async writeText(target, text, intent) {
            const abs = absOf(target);
            const exists = fs.existsSync(abs);
            if (intent?.kind === 'createIfAbsent' && exists) {
                const error = new Error('FS_NOT_OBSERVED: ' + abs);
                error.code = 'FS_NOT_OBSERVED';
                throw error;
            }
            fs.mkdirSync(path.dirname(abs), { recursive: true });
            const before = exists ? fs.readFileSync(abs, 'utf8') : null;
            fs.writeFileSync(abs, text);
            return { operation: exists ? 'update' : 'create', version: 'v:' + abs + ':2', before, after: text };
        },
    };
}

/**
 * 装一次插件：返回工具取用器、exec（会话工作区）、根目录与清理。
 * @param {{ config?: object, sessionId?: string }} opts
 */
export async function bootPlugin(opts = {}) {
    const { apply } = await import('../../lib/index.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-forge-plugin-'));
    const registered = [];
    const sections = [];
    const ctx = {
        fs: makeBackend(root),
        emit() {},
        logger: { info() {} },
        tools: { register: (t) => registered.push(t) },
        systemPrompt: { section: (s) => sections.push(s) },
        inject: (deps, fn) => fn(ctx),
        effect: (fn) => { const cleanup = fn(); return typeof cleanup === 'function' ? cleanup : () => {}; },
        webServer: { register: () => () => {} },
    };
    apply(ctx, testConfig(opts.config));
    const exec = {
        signal: new AbortController().signal,
        agent: { session: { header: { cwd: root, id: opts.sessionId ?? 'sess-T' } } },
    };
    return {
        root,
        ctx,
        exec,
        sections,
        /** 直连 lib 层函数（apply/discard 这些**不进工具面**的用户主权动作）要用的 io。 */
        io: () => createFsio(ctx, exec, sessionCwd(exec)),
        tool: (name) => {
            const t = registered.find((x) => x.name === name);
            if (t === undefined) throw new Error('工具未注册：' + name);
            return t;
        },
        read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'),
        readJson: (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')),
        exists: (rel) => fs.existsSync(path.join(root, rel)),
        /** 直接改盘上的 novel.json（造「手工改坏的数据」这类现场）。 */
        writeJson: (rel, obj) => fs.writeFileSync(path.join(root, rel), JSON.stringify(obj, null, 2) + '\n'),
        cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    };
}

/** 造一篇**机器口径**约 n 字的正文（去空白后计数）：多段 + 隔段对白，无直角引号/无外文字符。 */
export function chapterOf(n) {
    const narration = '他把灯芯又捻短了一截，屋子里亮了一些，也还是照着同一张桌子、同一摞纸、同一道没解开的题。';
    const dialogue = '“这不是一晚上能做完的事。”她说，“但你今晚必须做完。”';
    const tail = '门外忽然传来三声叩击，不轻不重，像是敲门的人在等里面先出声？';
    const paras = [];
    let chars = tail.length;
    let i = 0;
    while (chars < n) {
        const block = i % 2 === 0 ? narration : dialogue;
        const take = block.slice(0, Math.min(block.length, n - chars));
        if (take === '') break;
        paras.push(take);
        chars += take.length;
        i += 1;
    }
    return [...paras, tail].join('\n\n');
}
