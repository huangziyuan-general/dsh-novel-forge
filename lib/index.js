// lib/index.js — dsh-novel-forge Node 半入口（cordis 插件）。
//
// 装载即做三件事：
//   ① 注册 17 个 novel_* 工具（一致性/门禁/审计的硬约束全在工具层）；
//   ② 注入一段系统提示：写作纪律 + 工具链路（提示词只是补充，不是防线）；
//   ③ 幂等部署 agent 预设到 ~/.dsh/.agent-presets/novel-forge/（可关）。
//
// 宿主契约（与 dsh-files 0.5.x 同款）：export name 与 cordis.patch.yml 行 id 一致；
// Config 走 schemastery；apply 里 fail-fast 校验配置。

import z from '@deepseek-ai/schemastery';
import { defineProjectTool, defineOutlineTool, defineCharacterTool, defineWorldbookTool } from './tools/project-tools.js';
import { defineBriefingTool, defineWriteChapterTool } from './tools/writing-tools.js';
import { defineLedgerTool, defineNoaiScanTool, defineAuditTool, defineStyleTool } from './tools/quality-tools.js';
import { defineProposeTool } from './tools/propose-tools.js';
import { defineImportTool, defineExportTool, defineGlossaryTool, defineCloneTool } from './tools/asset-tools.js';
import { defineDiagnoseTool, definePolishTool } from './tools/review-tools.js';
import { deployPreset } from './preset-deploy.js';

/** Cordis 插件名——必须与 cordis.patch.yml 的行 id 一致。 */
export const name = 'dsh-novel-forge';

/** 依赖的宿主服务：工具注册表、受沙箱的文件系统、系统提示。 */
export const inject = ['tools', 'fs', 'systemPrompt'];

export const Config = z.object({
    /** 单章字数下限（机审拒绝线）。 */
    minChapterChars: z.number().default(500),
    /** 单章字数上限（超过提示拆章）。 */
    maxChapterChars: z.number().default(12000),
    /** 写前简报上下文包预算（字符）。 */
    contextBudgetChars: z.number().default(6000),
    /** 扫描报告每维最多列出的问题条数。 */
    scanTopK: z.number().default(8),
    /** 跨章重复检测的滑动窗口（与前 N 章比对）。 */
    repetitionWindow: z.number().default(10),
    /** 跳过预设部署。 */
    skipPresetDeploy: z.boolean().default(false),
});

function assertPositiveInt(label, value) {
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`dsh-novel-forge: ${label} 必须是正整数（当前 ${value}）`);
    }
}

export function apply(ctx, config) {
    assertPositiveInt('minChapterChars', config.minChapterChars);
    assertPositiveInt('maxChapterChars', config.maxChapterChars);
    if (config.maxChapterChars <= config.minChapterChars) {
        throw new Error('dsh-novel-forge: maxChapterChars 必须大于 minChapterChars');
    }
    assertPositiveInt('contextBudgetChars', config.contextBudgetChars);
    assertPositiveInt('scanTopK', config.scanTopK);
    assertPositiveInt('repetitionWindow', config.repetitionWindow);

    ctx.systemPrompt.section({
        name: 'tool:novel-forge',
        order: 110,
        text: [
            'dsh-novel-forge（小说锻炉）工作流纪律——这些约束由工具强制，绕不过去：',
            '1. 长篇一致性不靠记忆靠工程：写章前必调 novel_briefing 拿上下文包；正文里的一切人物状态变化（境界/位置/持有/关系）写完立即通过 novel_write_chapter 的 facts_updates 或 novel_ledger update 落账；账本同章改值会拒绝保存。',
            '2. 设定只认世界书：世界观规则、专有名词解释用 novel_worldbook add 固化（关键词触发或 always），不要指望模型记住第一版设定。',
            '3. 阶段门禁：novel_write_chapter 要求该章细纲已被 novel_outline approve；没批就是没批，force 只在用户明确要求时使用。',
            '4. 落笔即防：写正文时先想画面再动笔；情绪用动作/环境/留白暗示，不直写；写完一段扫一段；不使用模板句与库存词（扫描器会抓）。',
            '5. 机审与模型审分离：novel_audit / novel_noai_scan 的数字是证据；修改已存章节走 novel_propose 提案（生成新版本，永不覆盖旧版）。',
            '6. 人物卡（外在底色/隐性欲望/语言基因卡）用 novel_character save 建档，briefing 会自动注入；对话要过语言基因卡。',
            '7. 埋伏笔时给 plan（预计回收章号）；briefing 会对超期未回收的伏笔告警——超期的伏笔优先安排回收，别让读者忘了。索引与磁盘不一致时用 novel_project repair 对账。',
            '8. 文风漂移用数字说话：续写长篇前先 novel_style build 建全书六维基线（句法/修饰/抽象/动作/不确定/留白，μ±σ 带），交稿前 check 对照——出带维度给出偏离方向即可，不要把数字翻译成写作规则，模仿锚段的「味道」而不是追数字。',
        ].join('\n'),
    });

    ctx.tools.register(defineProjectTool(ctx, config));
    ctx.tools.register(defineOutlineTool(ctx, config));
    ctx.tools.register(defineCharacterTool(ctx, config));
    ctx.tools.register(defineWorldbookTool(ctx, config));
    ctx.tools.register(defineBriefingTool(ctx, config));
    ctx.tools.register(defineWriteChapterTool(ctx, config));
    ctx.tools.register(defineLedgerTool(ctx, config));
    ctx.tools.register(defineNoaiScanTool(ctx, config));
    ctx.tools.register(defineAuditTool(ctx, config));
    ctx.tools.register(defineStyleTool(ctx, config));
    ctx.tools.register(defineProposeTool(ctx, config));
    ctx.tools.register(defineImportTool(ctx, config));
    ctx.tools.register(defineExportTool(ctx, config));
    ctx.tools.register(defineGlossaryTool(ctx, config));
    ctx.tools.register(defineCloneTool(ctx, config));
    ctx.tools.register(defineDiagnoseTool(ctx, config));
    ctx.tools.register(definePolishTool(ctx, config));

    if (config.skipPresetDeploy !== true) {
        const result = deployPreset({
            logger: (msg) => ctx.logger?.info?.(`[dsh-novel-forge] ${msg}`),
        });
        ctx.logger?.info?.(`[dsh-novel-forge] 预设部署：${result.deployed ? '完成' : '跳过'}（${result.reason}）→ ${result.target}`);
    }
}
