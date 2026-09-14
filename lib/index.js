// lib/index.js — dsh-novel-forge Node 半入口（cordis 插件）。
//
// 装载即做三件事：
//   ① 注册 18 个 novel_* 工具（一致性/门禁/审计的硬约束全在工具层）；
//   ② 注入一段系统提示：写作纪律 + 工具链路（提示词只是补充，不是防线）；
//   ③ 幂等部署 agent 预设到 ~/.dsh/.agent-presets/novel-forge/（可关）。
//
// 宿主契约（与 dsh-files 0.5.x 同款）：export name 与 cordis.patch.yml 行 id 一致；
// Config 走 schemastery；apply 里 fail-fast 校验配置。

import z from '@deepseek-ai/schemastery';
import { defineProjectTool, defineOutlineTool, defineCharacterTool, defineWorldbookTool } from './tools/project-tools.js';
import { defineSceneTool } from './tools/scene-tools.js';
import { defineBriefingTool, defineWriteChapterTool } from './tools/writing-tools.js';
import { defineLedgerTool, defineNoaiScanTool, defineAuditTool, defineStyleTool } from './tools/quality-tools.js';
import { defineProposeTool } from './tools/propose-tools.js';
import { defineImportTool, defineExportTool, defineGlossaryTool, defineCloneTool } from './tools/asset-tools.js';
import { defineDiagnoseTool, definePolishTool } from './tools/review-tools.js';
import { deployPreset } from './preset-deploy.js';
import { registerServerApi } from './server-api.js';

/** Cordis 插件名——必须与 cordis.patch.yml 的行 id 一致。 */
export const name = 'dsh-novel-forge';

/** 依赖的宿主服务：工具注册表、受沙箱的文件系统、系统提示、HTTP 服务。 */
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
    /** 工作区根目录（REST API 用；默认当前目录）。 */
    workspaceRoot: z.string().default(''),
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
            '5. 机审与模型审分离：novel_audit / novel_noai_scan 的数字是证据；修改已存章节走 novel_propose 提案（生成新版本，永不覆盖旧版）。提案的**应用**是用户主权动作——你没有 apply 工具，提完就停，等用户到「锻炉」面板点「应用」，绝不要说「提案已生效」。',
            '6. 人物卡（外在底色/隐性欲望/语言基因卡）用 novel_character save 建档，briefing 会自动注入；对话要过语言基因卡。',
            '7. 埋伏笔时给 plan（预计回收章号）；briefing 会对超期未回收的伏笔告警——超期的伏笔优先安排回收，别让读者忘了。索引与磁盘不一致时用 novel_project repair 对账。',
            '8. 文风漂移用数字说话：续写长篇前先 novel_style build 建全书六维基线（句法/修饰/抽象/动作/不确定/留白，μ±σ 带），交稿前 check 对照——出带维度给出偏离方向即可，不要把数字翻译成写作规则，模仿锚段的「味道」而不是追数字。',
            '9. **节奏铁律（最高优先）：一次只写一章。** 写完一章立刻停下并向用户汇报（这一章写了什么 + 下一章建议），由用户决定是否继续；绝不擅自连写第二章、第三章。「写一本小说」不等于「一口气跑完全书」——用户要的是可控的逐章推进，不是无人值守的自动连载。',
            '10. 承诺与欠账是硬账：开书先用 novel_project promise 写「故事承诺书」（本书承诺什么爽点、绝不做的事）——它每次写章都会注入上下文，写了才有人看。正文违背承诺、或**到期的未回收伏笔在本章零回应却开新钩**，内容门禁会直接拒绝落盘（force 可强行放行但记审计）。写完一批章节用 novel_project check 做全书一致性体检（死人复活/伏笔倒挂/索引缺失，纯本地零 token）。',
            '11. 追读节奏：每 600–900 字给一次微兑现（信息揭示/小反转/情绪落点），章末留钩子——但不许用新悬念掩盖旧欠账。',
            '12. **场景契约管上下文与悬念**：写章前（尤其多人物/有反转要藏时）用 novel_scene save 声明本章场景、出场人物、**隐藏人物**（揭晓前不许露面的人）与禁项。契约在场时 briefing 只注入出场人物的卡（长书写到 30 章后上下文才不会爆），隐藏人物的档案一概不进上下文，**正文出现其名会被内容门禁拦下**——悬念保护不靠模型自觉。',
            '13. **细纲写契约段，指标由代码算**：novel_outline save_chapter 的细纲里用「## 本章必写场景」（条目写「- 标题：描述」）与「## 本章禁止偏离项」（写「不得让X出场」「禁止使用『某词』」）。写章时覆盖率/偏离度/漏写场景/命中禁项由代码计算并落盘到章节索引——命中禁项直接拒绝落盘。这些数字是硬证据，审稿结论必须引用它们。',
            '14. **九阶段状态机**（novel_project phase）：立意→设定→人物→大纲→分卷→细纲→正文→修订→完稿，每阶段有**代码判定**的入场条件，缺什么会直接列出来——「设定没定就想写大纲」「大纲没过就想写正文」在这里被拦住。确要跳过须 force:true 并记审计；旧名 planning/outline/drafting/revising/done 仍兼容。',
            '15. **熔断与否决权**：同一章被连续驳回 3 次（机审/内容门禁/细纲禁项），novel_write_chapter 直接熔断拒写——别换措辞硬压，回去重校准（改细纲或本章场景契约，改完计数自动清零），问题多半在设定不在文字。审稿检出的硬伤有一票否决权，不许拿「大致符合」搪塞过去。',
            '16. **发书前两道体检**：novel_audit platform:qidian|fanqie 按平台口味审稿（起点吃长线结构与章末钩子，番茄吃前 1000 字爽点与完读率，同一章两家结论可能相反）；censor:true 跑敏感自查七类（涉政/色情擦边/未成年/赌博毒品/暴力/封建迷信/现实机构影射）——启发式预筛，不是合规判定，命中项仍须人工复核。',
        ].join('\n'),
    });

    ctx.tools.register(defineProjectTool(ctx, config));
    ctx.tools.register(defineOutlineTool(ctx, config));
    ctx.tools.register(defineCharacterTool(ctx, config));
    ctx.tools.register(defineWorldbookTool(ctx, config));
    ctx.tools.register(defineSceneTool(ctx, config));
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

    // 注册 REST API 路由（抽屉 UI 的数据面）
    registerServerApi(ctx, config);

    if (config.skipPresetDeploy !== true) {
        const result = deployPreset({
            logger: (msg) => ctx.logger?.info?.(`[dsh-novel-forge] ${msg}`),
        });
        ctx.logger?.info?.(`[dsh-novel-forge] 预设部署：${result.deployed ? '完成' : '跳过'}（${result.reason}）→ ${result.target}`);
    }
}
