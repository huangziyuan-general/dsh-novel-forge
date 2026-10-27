// lib/index.js — dsh-novel-forge Node 半入口（cordis 插件）。
//
// 装载即做三件事：
//   ① 注册 20 个 novel_* 工具（一致性/门禁/审计的硬约束全在工具层）；
//   ② 注入一段系统提示：写作纪律 + 工具链路（提示词只是补充，不是防线）；
//   ③ 幂等部署 agent 预设到 ~/.dsh/.agent-presets/novel-forge/（可关）。
//
// 宿主契约（与 dsh-files 0.5.x 同款）：export name 与 cordis.patch.yml 行 id 一致；
// Config 走 schemastery；apply 里 fail-fast 校验配置。

// 依赖口径（外部缺陷报告修复，勿回退）：schemastery 是 peerDependency，独立
// MCP 通道（无宿主环境）里不存在——顶层静态 import 会炸死进程启动。而 Config
// 只被**宿主装配**评估（lib 内从不调用它，MCP 通道更不会），缺席时用一个
// 「只支持构建、不支持求值」的构造壳顶住模块顶层的 z.object(...) 构建即可；
// 支持的子集 = 本文件实际用到的 API（object/string/number/boolean/const/union/default）。
// 宿主内走真 schemastery，契约不变。
let z;
try {
    z = (await import('@deepseek-ai/schemastery')).default;
} catch {
    const node = () => {
        const n = {};
        n.default = () => n;
        return n;
    };
    z = {
        object: () => node(),
        string: () => node(),
        number: () => node(),
        boolean: () => node(),
        const: () => node(),
        union: () => node(),
    };
}

import { defineProjectTool, defineOutlineTool, defineCharacterTool, defineWorldbookTool } from './tools/project-tools.js';
import { defineSceneTool } from './tools/scene-tools.js';
import { defineBriefingTool, defineWriteChapterTool } from './tools/writing-tools.js';
import { defineLedgerTool, defineNoaiScanTool, defineAuditTool, defineStyleTool } from './tools/quality-tools.js';
import { defineProposeTool } from './tools/propose-tools.js';
import { defineImportTool, defineExportTool, defineGlossaryTool, defineCloneTool } from './tools/asset-tools.js';
import { defineDiagnoseTool, definePolishTool } from './tools/review-tools.js';
import { defineSearchTool } from './tools/search-tools.js';
import { defineLibraryTool } from './tools/library-tools.js';
import { deployPreset } from './preset-deploy.js';
import { registerServerApi } from './server-api.js';
// 宿主会话/工作区控制器的真名（探测契约与这里共用同一组常量，别再各写一份字面量）
import { SESSION_CONTROLLER_NAME, WORKSPACE_CONTROLLER_NAME } from './server-routes/session.js';
import { createEngine } from './engine.js';
import { NovelSkillPlugin } from './skill-registration.js';

/** Cordis 插件名——必须与 cordis.patch.yml 的行 id 一致。 */
export const name = 'dsh-novel-forge';

/** 依赖的宿主服务：工具注册表、受沙箱的文件系统、系统提示、HTTP 服务。
 *  `subagents` 与 `agents` 都必须显式声明：cordis 只把**声明过的**服务物化到插件
 *  ctx 上——不声明的话引擎的 readService 探测永远落空（服务在进程里存在也拿不到，
 *  mnemon 的 inject 同时声明 agents+subagents 是对照组铁证）。
 *  0.13.2 真机复诊：补了 subagents 漏了 agents → get/resume/currentInitiator 三路
 *  全空，面板润色报 NO_PARENT_AGENT。故意**不声明 llm**：web profile 根 fiber 上没有
 *  它，声明了可能让插件 mount 被无限推迟。
 *  `sessions`：REST 面板扫书根要用——live session 的 header.cwd 是会话工作区的
 *  一手来源（Windows 的 D:\ 工作区靠它才能进扫描根；sessions.list() 在服务缺席
 *  时由调用方可选链降级，不会因声明而阻断 mount）。 */
// 宿主会话/工作区控制器的**真名**（typert.host.js 元数据实证 2026-10-08）**不进这里**：
// cordis 的数组 inject 没有可选语义——名字缺席，整个插件就永远 pending。headless profile
// 真机实证（2026-10-12）：`dsh --profile headless` 报
//   warning: 1 entry did not activate
//   dsh-novel-forge: pending (waiting for services: sessionController, workspaceController)
// → 20 个 novel_* 工具 + 面板在 headless 上整块消失。真名改由 apply() 里的数组形式
// `ctx.inject(names, cb)` 取（独立 fiber：服务缺席只有那条回调永不触发，父插件照常 mount），
// 与 'skills' 同一课（详见 skill-registration.js 注释）。
// 'sessions' 留在这里：REST 扫书根要读它的 header.cwd，且它在这些 profile 里确实存在
// （缺席的只是两个控制器）。注意它**不能**当轮换能力——那是浏览器面假体（create 建内存
// session-N，宿主面板可见但磁盘无目录），能力一律走下面的 fiber。
export const inject = ['tools', 'fs', 'systemPrompt', 'subagents', 'agents', 'sessions'];

/** D1 引擎的单通道覆写：provider+model 一起给才生效，否则继承当前会话路由。 */
const EngineChannelConfig = z.object({
    provider: z.string(),
    model: z.string(),
    maxTokens: z.number(),
    timeoutMs: z.number(),
    retries: z.number(),
});

export const Config = z.object({
    /** 单章字数下限（机审拒绝线）。正常网文连载单章 2000 字起步，低于此直接退稿。 */
    minChapterChars: z.number().default(2000),
    /** 单章字数上限（起点标准 2000–4000；超过提示拆章——超长章订阅吃亏且稀释章末钩子）。 */
    maxChapterChars: z.number().default(4000),
    /** 写前简报上下文包预算（字符）。 */
    contextBudgetChars: z.number().default(6000),
    /** 扫描报告每维最多列出的问题条数。 */
    scanTopK: z.number().default(8),
    /** 跨章重复检测的滑动窗口（与前 N 章比对）。 */
    repetitionWindow: z.number().default(10),
    /**
     * 跨章 AI 味频次判据的回看窗口（章）。
     * noai 的八维全是「本章内」判据——「同一动作全书 ≤8 次」「重复桥段全书 ≤2 次」
     * 这类跨章病它一条都看不见。这里多回看 N 章来查这类病（默认 20 章）。
     * 机审的重复检测口径**不受影响**（仍看 repetitionWindow 章）——两条判据分开。
     */
    noaiCrossWindow: z.number().default(20),
    /**
     * 直角引号「『』」判定策略（0.19.2，引号规范）。
     * 横排小说合规引号是中文双引号 “…”；直角引号只用于竖排版，且是很多 AI 检测工具
     * 常用的「生成残留」判据（直角引号出现率），出现了会被判「疑似 AI 创作」。
     * · 'block'（默认）：正文出现直角引号 → 机审阻断（可自救：全局替换成 “” 即过）；
     * · 'warn'：只提示不阻断；
     * · 'off'：不判（存量书确要保留竖排引号时显式关）。
     * apply() 里 fail-fast 校验取值合法。
     */
    quoteStyle: z.union([z.const('block'), z.const('warn'), z.const('off')]).default('block'),
    /** 跳过预设部署。 */
    skipPresetDeploy: z.boolean().default(false),
    /** 工作区根目录（REST API 用；默认当前目录）。 */
    workspaceRoot: z.string().default(''),

    /**
     * D1 旁路直调引擎（面板的「一键润色 / 一键校对」用它，不占主对话）。
     *
     * 通道默认**继承用户当前路由**——保持零配置；想让润色走便宜模型的，在这里给
     * polish 通道显式指定 provider + model 即可。attachSession 默认 false：
     * 带上 sessionId 会让请求出现在会话日志里，那正是 D1 要消灭的污染。
     */
    engine: z.object({
        channels: z.object({
            polish: EngineChannelConfig,
            proofread: EngineChannelConfig,
            annotate: EngineChannelConfig,
            expand: EngineChannelConfig,
            draft: EngineChannelConfig,
        }),
        retries: z.number().default(2),
        attachSession: z.boolean().default(false),
    }).default({}),
    // G1 检索语义层：写章落盘后对新块后台补语义标签（annotate 通道），
    // 让「标签增强检索」不再是纯手动动作。默认开；介意 token 成本的可关
    // （每章封顶 4 块、连续失败即停，成本有个明确的顶）。
    search: z.object({
        autoAnnotate: z.boolean().default(true),
    }).default({}),
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
    // noaiCrossWindow 缺省视为默认（宿主装配时 zod .default 已填；直传部分配置的场景
    // ——测试/MCP 通道/脚本——给 undefined 也按默认放行，与 quoteStyle 同一处置，
    // 不让它误 fail-fast。运行期另有兜底：不是正整数就按 20 章算）。
    if (config.noaiCrossWindow !== undefined) {
        assertPositiveInt('noaiCrossWindow', config.noaiCrossWindow);
    }
    // quoteStyle 缺省视为 'block'（宿主装配时 schemastery .default('block') 已填充；
    // 直传部分配置的场景（测试/MCP 通道）给 undefined 也按默认放行，不让它误 fail-fast）。
    if (config.quoteStyle !== undefined && !['block', 'warn', 'off'].includes(config.quoteStyle)) {
        throw new Error(`dsh-novel-forge: quoteStyle 必须是 block/warn/off（当前 ${config.quoteStyle}）`);
    }

    // 一次性 star 轻提示：装完即用的人从不打开仓库页，靠这行把访问率从 ~14% 往上拉。
    // 仅打印一次（本进程 apply 只调一次），不打断任何工作流。
    // 必须走 stderr：apply 也被 mcp/server.mjs（stdio JSON-RPC）复用，
    // stdout 是协议通道，混进一行人类可读文本就会让对端 JSON.parse 炸掉。
    process.stderr.write('[novel-forge] 用得顺手就到 GitHub 点个 ⭐ 吧：github.com/huangziyuan-general/dsh-novel-forge\n');

    ctx.systemPrompt.section({
        name: 'tool:novel-forge',
        order: 110,
        text: [
            'dsh-novel-forge（小说锻炉）工作流纪律——这些约束由工具强制，绕不过去：',
            '1. 长篇一致性不靠记忆靠工程：写章前必调 novel_briefing 拿上下文包；正文里的一切人物状态变化（境界/位置/持有/关系）写完立即通过 novel_write_chapter 的 facts_updates 或 novel_ledger update 落账；账本同章改值会拒绝保存。**要引用「当时」的状态**（写第 80 章回溯第 12 章的境界、核对「第 40 章断腿第 50 章还能跑」）**用 novel_ledger status_at 做时点推演，不要拿最新值糊**——最新值会说谎；要查某个值是哪一章被改掉的用 timeline。',
            '2. 设定只认世界书：世界观规则、专有名词解释用 novel_worldbook add 固化（关键词触发或 always），不要指望模型记住第一版设定。',
            '3. 阶段门禁：novel_write_chapter 要求该章细纲已被 novel_outline approve；没批就是没批，force 只在用户明确要求时使用。**每章字数是用户的决定，不是你的**：开书（novel_project init）前先问一句「每章写多少字？投哪个平台？」——给了就写 `chars: "2500-3500"`（落库成本书事实），只给平台就写 `platform`，两个都不要就别传（回落插件默认 2000–4000）；绝不替用户挑数字，也别拿上一本书的区间套到这本上。生效优先级「本书自定义 > 平台口径 > 插件配置」，动笔前一律以 novel_briefing 的「本章字数目标」段为准；用户中途要改走 novel_project action=chars（锻炉面板也有这个输入框）。',
            '4. 落笔即防：写正文时先想画面再动笔；情绪用动作/环境/留白暗示，不直写；写完一段扫一段；不使用模板句与库存词（扫描器会抓）。',
            '5. 机审与模型审分离：novel_audit / novel_noai_scan 的数字是证据。**改稿有两条通道，按目的选**：自己动笔改稿（包括机审驳回后重写同一章）→ novel_write_chapter，同章追加新版本、旧版永不覆盖；要把修订登记成「等用户批准」的提案 → novel_propose（只登记，不动正文）。提案的**应用/丢弃**是用户主权动作——你没有 apply 工具，提完就停，等用户到「锻炉」面板点，绝不要说「提案已生效」；同一章已有 pending 提案时不要重复提新的。',
            '6. 人物卡（外在底色/隐性欲望/语言基因卡）用 novel_character save 建档，briefing 会自动注入；对话要过语言基因卡。',
            '7. 埋伏笔时给 plan（预计回收章号）；briefing 会对超期未回收的伏笔告警——超期的伏笔优先安排回收，别让读者忘了。索引与磁盘不一致时用 novel_project repair 对账。',
            '8. 文风漂移用数字说话：续写长篇前先 novel_style build 建全书六维基线（句法/修饰/抽象/动作/不确定/留白，μ±σ 带），交稿前 check 对照——出带维度给出偏离方向即可，不要把数字翻译成写作规则，模仿锚段的「味道」而不是追数字。',
            '9. **节奏铁律（最高优先）：一次只写一章。** 写完一章立刻停下并向用户汇报（这一章写了什么 + 下一章建议），由用户决定是否继续；绝不擅自连写第二章、第三章。「写一本小说」不等于「一口气跑完全书」——用户要的是可控的逐章推进，不是无人值守的自动连载。',
            '10. 承诺与欠账是硬账：开书先用 novel_project promise 写「故事承诺书」（本书承诺什么爽点、绝不做的事）——它每次写章都会注入上下文，写了才有人看。正文违背承诺、或**到期的未回收伏笔在本章零回应却开新钩**，内容门禁会直接拒绝落盘（force 可强行放行但记审计）。写完一批章节用 novel_project check 做全书一致性体检（死人复活/伏笔倒挂/索引缺失，纯本地零 token）。',
            '11. 追读节奏：每 600–900 字给一次微兑现（信息揭示/小反转/情绪落点），章末留钩子——但不许用新悬念掩盖旧欠账。',
            '12. **场景契约管上下文与悬念**：写章前（尤其多人物/有反转要藏时）用 novel_scene save 声明本章场景、出场人物、**隐藏人物**（揭晓前不许露面的人）与禁项。契约在场时 briefing 只注入出场人物的卡（长书写到 30 章后上下文才不会爆），隐藏人物的档案一概不进上下文，**正文出现其名会被内容门禁拦下**——悬念保护不靠模型自觉。',
            '13. **细纲写契约段，指标由代码算**：novel_outline save_chapter 的细纲里用「## 本章必写场景」（条目写「- 标题：描述」，每场景 3–5 个拍）与「## 本章禁止偏离项」（写「不得让X出场」「禁止使用『某词』」）。写章时覆盖率/偏离度/漏写场景/命中禁项由代码计算并落盘到章节索引——命中禁项直接拒绝落盘。这些数字是硬证据，审稿结论必须引用它们。新建的书（init/import/clone）默认 outlineContract=strict：细纲缺「必写场景」段（或有段无条目）save_chapter 直接驳回；存量旧书缺省 warn——不拒稿但留痕并提示补段。',
            '14. **九阶段状态机**（novel_project phase）：立意→设定→人物→大纲→分卷→细纲→正文→修订→完稿，每阶段有**代码判定**的入场条件，缺什么会直接列出来——「设定没定就想写大纲」「大纲没过就想写正文」在这里被拦住。确要跳过须 force:true 并记审计；旧名 planning/outline/drafting/revising/done 仍兼容。',
            '15. **熔断与否决权**：同一章被连续驳回 3 次（机审/内容门禁/细纲禁项），novel_write_chapter 直接熔断拒写——别换措辞硬压，回去重校准（改细纲或本章场景契约，改完计数自动清零），问题多半在设定不在文字。审稿检出的硬伤有一票否决权，不许拿「大致符合」搪塞过去。',
            '16. **发书前两道体检**：novel_audit platform:qidian|fanqie|jjwxc|qimao|feilu 按平台口味审稿（起点吃长线结构与章末钩子，番茄吃前 1000 字爽点与完读率，晋江吃字数足额与开篇忌虐，七猫吃强情绪与章末钩子，飞卢吃极快节奏与金手指前置，同一章各家结论可能相反）；censor:true 跑敏感自查七类（涉政/色情擦边/未成年/赌博毒品/暴力/封建迷信/现实机构影射）——启发式预筛，不是合规判定，命中项仍须人工复核。',
            '17. **面板按钮走旁路引擎，不占主对话**：「一键润色」「一键校对」由 D1 旁路引擎直接调模型，**受约束**——产物一律是提案（用户点「应用」才生效），且过保守编辑守卫（改标题/写错形近字直接拒）；校对档比润色档严得多（几乎不许改结构）。模型引擎不可用时这两条端点回可读错误，不是静默失败。**内部工序（校对/打标这类反复往返的活）不要塞进聊天**——它会烧主额度、污染会话历史、淹没创作主线。',
            '18. **长篇「找回来」用 novel_search，不要靠记忆**：写到几十上百章后，模型记不住细节是必然的。要引用前文具体段落时先 novel_search query 检索（build 建索引、annotate 补语义标签），拿到**章号+摘录**再引用；没命中就换更短的词或调低 min_hit。索引是派生物（书/.novel/index.db），删了重跑 build 即得——**永远不要把它当成事实来源**，正文与 novel.json 才是真相。',
            '19. **批量起草是加速器，不是绕过门禁的后门**：面板的「批量起草」并发生成、**串行提交**——每一章都过与单章写完全相同的硬约束链（机审/账本冲突/内容门禁/细纲契约指标），失败不整批回滚。并发默认 1、上限 4，且**只在有场景契约裁过上下文的书上放开**。两条纪律：① 并发的第 2 章起看不到前面章节的正文（还没写出来），衔接只能靠细纲——**连环悬念章不要并行**；② 批量被门禁拦下的章要逐条看原因，多见于细纲缺必写场景或命中禁项——那是设定问题，不是文字问题。',
            '20. **学别人怎么写用书库，不要凭感觉**：novel_library import 把对标作品导进书库（给 path 读工作区文本文件，或直接粘 text），analyze 出结构画像——章节长度曲线（均值/中位/波动 cv）、对话密度、段落节奏、章末钩子率、高频意象，**纯本地零 token**。动手写之前先拆 1–2 部同题材对标，把「该写多长、多少对话、章末怎么收」从感觉换成数字；给 compare_book 会与自己的书**并排**给数。书库是只读饲料：不参与本书一致性判定、不进上下文包；delete 只移索引（宿主 fs 无删除能力，原文仍在磁盘）。',
            // 21 必须是第 21 条而不是 SKILL.md 的第 7/8 条：技能正文**按需加载**（宿主 dsh-tool-skill
            // 常驻的只有目录里的 name+description，模型要先调 skill 工具才拿得到正文），而写前简报
            // 要等 novel_briefing 返回才进上下文——两者都晚于「回合开头」这个病发时刻（真机
            // discussion #3：写章回合先输出大段前置说明 → 前置说明+正文挤爆单回合输出预算 →
            // 工具调用中途截断）。只有常驻 systemPrompt 段能在第一个动作之前拦住它。
            '21. **回合预算纪律**：一个回合要产出长文本（写章/改稿）时，回合开头**直接发起第一个 novel_* 调用，不写任何前置说明**——细纲→approve→场景→简报→写章逐步直接调用，解释留到落盘后的汇报里（前置说明与正文抢同一个单回合输出预算，真机故障就是中途截断、整回合白跑）；回合内回溯前文用 novel_search 的**摘录**与 novel_ledger status_at/timeline 的时点值，**不要整章 read 正文**——读进来的大块文本会挤占本回合后续所有步骤的预算。',
        ].join('\n'),
    });

    // 旁路引擎（D1）：面板的润色/校对、检索打标、批量起草都走它，独立于会话主链路。
    // 宿主缺 llm 服务时不抛错，只标记不可用 —— 其它工具照常工作（G1 检索照样能建索引与查询）。
    // ⚠️ 不要在装配期调 engine.isAvailable() 下结论：boot 时宿主服务大多还没注册，
    // cordis 对未注册服务的属性访问会**直接抛错**（0.13.1 前这里炸过整个 boot）。
    // 可用性在每次请求时判定（isAvailable / run 内部自检），面板拿到的错误是人话。
    const engine = createEngine({ ctx, config, logger: ctx.logger });
    ctx.logger?.info?.('[dsh-novel-forge] 旁路引擎已挂载（可用性在首次调用时探测，装配期不判定）');

    ctx.tools.register(defineProjectTool(ctx, config));
    ctx.tools.register(defineOutlineTool(ctx, config));
    ctx.tools.register(defineCharacterTool(ctx, config));
    ctx.tools.register(defineWorldbookTool(ctx, config));
    ctx.tools.register(defineSceneTool(ctx, config));
    ctx.tools.register(defineBriefingTool(ctx, config));
    ctx.tools.register(defineWriteChapterTool(ctx, config, { engine }));
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
    ctx.tools.register(defineSearchTool(ctx, config, { engine }));
    ctx.tools.register(defineLibraryTool(ctx, config));

    // ── 会话/工作区控制器：各建一条独立 fiber，缺席不牵连主插件 mount ──────
    // 两条分开声明（不是一条数组要两个名字）：宿主哪天只提供其中之一，能力就点亮一半
    // ——轮换面本来就是「开新会话」与「归档旧会话」各自尽力、独立报错。
    // holder 由 fiber 回调写、REST 逐请求重读：服务晚加载也拾得到，与旧的直读探测同性质。
    const sessionServices = {
        [SESSION_CONTROLLER_NAME]: null,
        [WORKSPACE_CONTROLLER_NAME]: null,
        probeError: null,
    };
    const claimController = (name) => {
        if (typeof ctx.inject !== 'function') {
            sessionServices.probeError = '本宿主 ctx.inject 不可用';
            return;
        }
        try {
            ctx.inject([name], (sctx) => { sessionServices[name] = sctx?.[name] ?? null; });
        } catch (error) {
            // 声明失败不是致命错：轮换退回 501 + 复制交接摘要，工具与面板照常。
            sessionServices.probeError = String(error?.message ?? error);
            ctx.logger?.warn?.(`[dsh-novel-forge] 会话控制器 fiber 声明失败（轮换退回 501）：${sessionServices.probeError}`);
        }
    };
    claimController(SESSION_CONTROLLER_NAME);
    claimController(WORKSPACE_CONTROLLER_NAME);

    // 注册 REST API 路由（抽屉 UI 的数据面）
    registerServerApi(ctx, config, { engine, sessionServices });

    // novel skill 注册进宿主技能目录：嵌套子插件独立声明 ['skills']，
    // 宿主没有该服务时只有子 fiber 静默 pending，绝不牵连主插件（详见 skill-registration.js）。
    if (typeof ctx.plugin === 'function') ctx.plugin(NovelSkillPlugin);


    if (config.skipPresetDeploy !== true) {
        const result = deployPreset({
            logger: (msg) => ctx.logger?.info?.(`[dsh-novel-forge] ${msg}`),
        });
        ctx.logger?.info?.(`[dsh-novel-forge] 预设部署：${result.deployed ? '完成' : '跳过'}（${result.reason}）→ ${result.target}`);
    }
}
