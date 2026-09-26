// lib/skill-registration.js — 把插件携带的 novel skill 注册进宿主技能目录。
//
// 0.1.7-rc.1 真机排障结论（2026-09-24）：宿主【没有】「插件包内 skills/ 目录自动
// 发现」这回事——技能目录只来自三类来源：
//   ① 各包自注册的 provider（dsh-skill-office / dsh-skill-filesystem / badge…）；
//   ② 项目根 <projectRoot>/.dsh/skills 与 .agents/skills（filesystem provider 扫描）；
//   ③ 用户级 ~/.dsh/skills 与 ~/.agents/skills（同上，带 watcher 热更新）。
// 文件放对位置但没人扫 = 静默不可见——本插件的 skills/novel/SKILL.md 就这样躺了
// 三天（目录快照里从未出现 novel）。正确集成姿势是 ctx.skills.register()（运行时
// 注册，与 dsh-skill 的 runtime 层同款，宿主 audit/缓存/去重全走既有机制）。
//
// 兼容性关键：注册放在**嵌套子插件**里并声明 ['skills']。cordis 的数组 inject 没有
// 可选语义（Inject.resolve 一律 name→null），直接声明在主插件上会让没有 skills
// 服务的老宿主把整个 novel-forge 挂成 pending（20 个工具 + 面板全灭）；嵌套 fiber
// 独立 pending，父插件与其他功能不受牵连。全部路径 try/catch 降级：skill 注册
// 失败只 warn，绝不阻断插件 mount。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const SKILL_DIR = fileURLToPath(new URL('../skills/novel/', import.meta.url));
const SKILL_PATH = join(SKILL_DIR, 'SKILL.md');

/**
 * 极简 frontmatter 解析：只取 name / description 两个标量行，正文原样返回。
 * 刻意不引 YAML 依赖——skill frontmatter 的这两个字段由本插件自己写、格式自控；
 * 宿主侧的完整 YAML 解析只在 filesystem provider 里发生，与运行时注册无关。
 * @param {string} raw SKILL.md 全文
 * @returns {{ attrs: Record<string,string>, body: string }}
 */
export function parseSkillFrontmatter(raw) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
    if (!match) return { attrs: {}, body: raw };
    const attrs = {};
    for (const line of match[1].split(/\r?\n/)) {
        const m = /^([\w][\w-]*):\s*(.*)$/.exec(line.trim());
        if (m) attrs[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
    return { attrs, body: raw.slice(match[0].length).replace(/^\r?\n/, '') };
}

/**
 * 从插件包内 skills/novel/SKILL.md 组装运行时注册定义。
 * 字段形状对齐 dsh-skill validateDefinition：name(kebab)/description(非空)/
 * content(正文)/source/path；invocation 省略由宿主补默认（model+user 双可调）。
 * @returns {{ name: string, description: string, content: string, source: string, path: string }}
 */
export function novelSkillDefinition() {
    const raw = readFileSync(SKILL_PATH, 'utf8');
    const { attrs, body } = parseSkillFrontmatter(raw);
    const description = (attrs.description ?? '小说锻炉工作流指令包：写书/续写/细纲/大纲/世界观/伏笔的全流程纪律。').slice(0, 300);
    return {
        name: attrs.name ?? 'novel',
        description,
        content: body,
        source: 'plugin:dsh-novel-forge',
        path: SKILL_PATH,
    };
}

/**
 * 向 ctx.skills 注册 novel skill。skills 服务缺席（老宿主）或注册抛错时返回
 * false 并 warn——调用方（嵌套子插件 pending / 主 apply）都不因此中断。
 * @param {object} ctx cordis 插件 ctx
 * @returns {boolean} 是否注册成功
 */
export function registerNovelSkill(ctx) {
    try {
        const skills = ctx?.skills;
        if (typeof skills?.register !== 'function') return false;
        skills.register(novelSkillDefinition());
        return true;
    } catch (error) {
        const warn = ctx?.logger?.warn ?? console.warn;
        warn('[novel-forge] novel skill 注册失败（不影响工具与面板）：', error?.message ?? error);
        return false;
    }
}

/** 嵌套子插件：独立声明 ['skills']，老宿主上最多自身 pending，不拖累主插件。 */
export const NovelSkillPlugin = {
    name: 'dsh-novel-forge-skill',
    inject: ['skills'],
    apply(ctx) {
        registerNovelSkill(ctx);
    },
};
