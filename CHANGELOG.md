# Changelog

## 未发布

### 新增

- **上下文冲突组消解**（新建 `lib/contextpack-group.js`，纯函数）：`lib/contextpack.js` 的 `push()` 此前是**纯顺序填充**——同一实体被多块各讲一遍时（世界书里同一个角色散在好几条条目里各写各的、人物卡又另有一份描述），谁挤掉谁靠遍历顺序，不是显式规则。现在按主题分组建冲突组，组内按「权威性 → 新鲜度 → 优先级 → 硬需求 → 声明顺序」裁决：人物卡（专用描述）压世界书条目（泛设定）；没有人物卡时，两条世界书按**触发词连通分量**归组、按 priority 决胜负；**裁决键完全相同（讲得同样权威）时两块都留**——替用户挑一条留下就是凭空替他做主。裁决结果进简报回执的 `conflicts` 字段与 warnings：被裁掉的那块不是「预算不够」而是「有另一个说法」，作者不知道就永远不知道自己写了两套打架的设定。
- **丢弃次序声明（dropOrder）**：预算不够时被牺牲的块由**声明**说了算，不再由遍历顺序隐式决定。各弹性块声明牺牲优先级（原著锚段 50 / 世界书条目 40 / 语言基因卡 30 / 术语表 20 / 人物卡 10，越大越先牺牲）；硬需求块（细纲/承诺书/契约/账本/伏笔/节奏）**不声明 = 永不牺牲**。牺牲品必须严格比当前块更可牺牲——否则会出现「锚段自己装不下却去踢语言卡」这种反直觉的取舍。**默认行为一字不变**（没声明的块永不被踢），真机踩坑换来的保留额机制原样保留。
- **质量债分级：局部问题不阻塞全书**（新建 `lib/quality-debt.js`，纯函数 + 新工具 `novel_quality`）：门禁此前只有 blocking/warnings 两档 + 章级熔断，缺**书级**视角——第 30 章有个非致命瑕疵，不该让作者觉得整本书写不下去了。现在写章链的每个警告项落成一条**结构化的质量债**（有级别、有来源代码、有章号、有时间戳），落在 `novel.json.quality.debts[章号]`（按章号覆盖的不可变条目，不是计数器）。三级口径：**minor 质量债**（局部瑕疵，正文保留，继续写下一章）/ **major 需重规划**（影响后续章节结构）/ **hard 硬门禁放行**（本该拒稿、被 force 放行，必须回头核对）。`novel_quality` 工具给书级视图（欠了多少、最重的是哪章、**现在该不该继续写**）与结清（改了正文或设定就结掉，别让账越积越多）。写章回执新增 `qualityDebt` 字段（本章最重的一档 + 明细）。

### 修复

- **硬需求块不会再被误当牺牲品踢掉**：挑选牺牲品时，优先级查询回调对「没声明 dropOrder」的块返回 `undefined`，而 `undefined <= -Infinity` 恒为 false——不做规范化的话，细纲/承诺书/契约这类硬需求块会被当成「最该牺牲的」踢走（4 个既有用例当场变红）。回调返回值现在统一规范化为 `-Infinity`（= 永不牺牲）。

### 文档

- `AGENTS.md` 不变量 2 的纯函数模块名单补入 `contextpack-group` / `quality-debt`。

## v1.1.1 (2026-10-27)

### 修复

- **连续快档的「连续」按章号算，不再按记录链算**：v1.1.0 的连续快档判定只遍历「有节奏记录的章」，没校验章号是否相邻——于是第 10 章是快档、第 13 章才动笔（中间两章没有记录），会被判成「第10章已经是快档…连着 2 章爽点」，章号和数字双双对不上，属于凭空捏造的证据；写前推荐的「上一章是快档，本章别再连着快」同样误报。缺记录 ≠ 快档，现在要求章号**严格相邻**才计入连续链（新增纯函数 `consecutiveFastChain`，体检与写前推荐共用同一口径），告警文案改为写清真实连着的是哪几章。

## v1.1.0 (2026-10-27)

### 新增

- **跨章叙事配额与节奏状态机**（新建 `lib/pacing.js`，纯函数）：本项目的门禁此前全是**单章**判定——noai 八维只看本章、重复检测只看最近 N 章，跨章约束只有 contextpack 注入的一段纯文本（靠模型自觉）。本轮补上三道代码闸：① **反向刹车**——「解决类信号 + ≥2 组配额信号（主线格局变化 / 关系决定性升级 / 秘密完整揭露）」同时命中即拒稿（force 可放行），治「一章把长线底牌全翻了，后面无事可写」；② **事件冷却矩阵**——5 类事件（冲突爽点 / 人物羁绊 / 势力经营 / 风土人情 / 危机升级）冷却章数 2/1/2/3/2，冷却期内再写同类要报；③ **节奏档位**——快档每卷 ≤3 个、连着 ≤1 个，慢档连续 4 章内 ≤2 章。状态表落 `novel.json.pacing`（**章号 → 记录**的不可变条目，合并按章号覆盖，没有计数算术——并发写同书时计数键最容易算错）；写前简报新增「跨章节奏建议」段：哪些事件类型现在可写、哪些还在冷却、第几章解冻、当前档位配额用了多少。阈值与档位可在 `pacing` 配置段调（`brake: blocking/warning/off`）。
- **事实账本三态**：账本条目加 `status`（`confirmed` / `unknown` / `pending`，旧记录缺省 confirmed，不改旧书语义）。`unknown` = 设定明确未定，**必须写明原因**（没边界它就会变成「懒得查设定」的挡箭牌），且**正文不得替它补齐**；`pending` = 有候选值但待复核。事实摘要里三态显形——模型在简报里看见「这里还没定」，才不会自己编一个值填进正文。工具行格式扩为「实体|键|值[|备注][|状态]」。

### 修复

- **未知补齐会被内容门禁拦下**（新增第 ⑥ 维）：账本标 unknown 的属性，正文却对它做了正向断言（「境界是筑基三层」）——这是「设定凭空长出来」的入口，模型编的值随后落进账本就成了「事实」。判定要求同段落出现实体名与属性名、断言给的是**具体值**、且该值不是「未知/不详/不得而知」这类占位词（守住未知不算补齐）。阻断级，force 可放行。

### 文档

- `AGENTS.md` 不变量 2 的纯函数模块名单补入 `pacing`。

## v1.0.9 (2026-10-27)

### 修复

- **客户端**：阅读卡（📖 展开正文）不再固定在章节目录顶部，改为插在**所点章节行的正下方**——长目录里点哪章就展开在哪章，不用回头找；换章、收起均不残留卡片。

### 新增

本轮是「竞品借鉴清单」第 1 轮：三项**纯增量**能力（不改数据结构、不动门禁口径）。

- **检索语料的字段级隔离**：索引块新增 `corpus` 列（`project`/`reference`），建索引路径写死 `project`，检索接口加语料过滤参数，`novel_search` 的 `query` 默认**只召回本书正文**（外部参考素材不会顺着检索结果流进续写上下文）；`status` 回执给出语料构成。旧索引自动补列（保留已打的语义标签），语料进入内容指纹——同一段文字换语料必须重写，否则库里会留着旧标记。
- **写前简报的依据指纹（basis）**：`novel_briefing` 回执新增 `basis`（细纲/场景契约/世界书的内容哈希），服务端另存一份记录；写章提交时**服务端重算并比对**，简报生成后设定被改动过就明确告警「简报已过期，请重新 briefing」。账本只做精确旁证（新增条目静默、改写与删除才报），避免批量起草路径逐章误报。`novel_write_chapter` 新增可选参数 `basis`，带上它会多一道交叉核对。
- **去 AI 味：词表互补 + 跨章频次判据**：并入外部词表 7 类共约 100 词条（AI 高频词/弱化副词/意义膨胀/通用结论套话/段首总结句/正式语体入侵/排比三连），按现有八维归位，不改八维权重与维度数；新增 `lib/noai-cross.js`（纯函数）补上八维全都看不见的那类病：同一标志小动作反复出现、与前文撞场（重复桥段）、格言式收尾、单一意象刷屏、「不是A是B」句式过多。判据结论在写章回执的 `warnings` 与去 AI 味 `topIssues` 里可见（只报不拦，与既有 noai 同一档）。

### 文档

- `AGENTS.md` 不变量 2 的纯函数模块名单补入 `basis` / `noai-cross`。

## v1.0.8 (2026-10-27)

### 修复

- **MCP 通道**：`tools/list` 的 `inputSchema` 不再把已是 JSON Schema 的参数表二次包裹——此前 20 个工具全部暴露空参数表，按 `inputSchema` 渲染参数表单的 MCP 客户端（Claude Desktop / Cursor 等）一个参数都填不了；schema 生成下沉为 `lib/mcp-standalone.js` 的 `toInputSchema`（成品直通 + 兼容旧「参数名 → spec」形状），回归由 stdio 全链测试钉住。
- **MCP 通道**：独立启动不再因宿主 peer 包缺席崩溃——`@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery` 改为动态导入 + 缺席回退（输出校验退化、Config 走构造壳），零宿主环境可正常 `initialize` / `tools/list` / `tools/call`。

## v1.0.7 (2026-10-26)

### 新增

- **创作驾驶舱**：新增只读聚合层与 `GET /projects/:id/dashboard`，打开书自动汇总进度、全书体检、大纲里程碑、提案、黄金三章诊断与本书字数口径；面板详情页顶部给“下一步动作”和状态分级，失败可见且不阻塞写作。
- **平台审稿聚合**：驾驶舱抽样“前 3 + 最近 12”章，按本书生效字数口径跑五平台审稿，聚成硬伤/警告/均分/通过章数与高风险条目；单章全表仍走 `novel_audit platform`。
- 书稿章节只读新增共享收口 `lib/chapter-io.js`：细纲对齐与驾驶舱同一套越书路径拒读、缺文件跳过逻辑，避免两份 IO 拼装漂移。

### 修复

- 里程碑台账支持条目开区间，并按当前细纲区分“已回应 / 已排补 / 仍未安排”；回执增加行数与词数截断，长卷大纲不再把一次 align 的回执撑爆。
- 直角引号存量迁移脚本改为按书目录参数执行，并保持同一份 `normalizeQuotes` 转换、长度等价与剥引号等价双重验证。
- 驾驶舱平台审稿抽样改为只认本书 `novel.platform`；修掉未设平台默认起点、番茄书可能跑错口径的问题。
- 发行面源码注释、演示脚本与测试夹具继续收敛为中性示例名，避免真实书稿或人物特征进入包体。
- 客户端驾驶舱并行加载补齐测试替身的请求编排，保存门禁 409 不再被新端点占用；陈旧响应守卫同步覆盖四路并行追拉。

### 文档

- README（中英）新增创作驾驶舱入口说明，明确它只做本地零 token 聚合与抽样审稿汇总。

## v1.0.6 (2026-10-25)

### 新增

- `novel_outline action=align`：细纲生成前必调的对齐检查——读取全书大纲对应卷段，输出「第 N 章对齐哪个大纲节点」+ 里程碑台账（本卷规划节点是否已被正文兑现、哪些短概念词逾期未付，只摊开不终审），堵住细纲脱离大纲自行漂移的缺口（真机连载本实证：46 章细纲逐章滚动只对齐卷一节点，局部永远自洽）
- 配套 `lib/milestone.js`：按章号区间解析全书大纲的卷规划节点，与措辞相似度的 outlineDivergence 互补——相似度看不出「里程碑整段没写」，台账按「章号已过、短概念词零命中＝欠账候选」摊开
- `save_chapter` 回执新增「【大纲对齐】」块：没先调 align，落盘瞬间也回显本章对齐节点与尚未兑现的概念词
- 里程碑台账判据打磨（真机验证驱动）：度量词（「并发」类内含功能字的固定词）切分前整词保护；钩子/伏笔/换图类元注释词进停用表，不冒充情节点记欠账
- align 两条返回路径落 `outline/align` 审计行（此前是该工具唯一的审计盲区）

## v1.0.5 (2026-10-23)

### 新增

- 上下文体量护栏：疲劳检测新增体量判据（hard 级排第一）——按本会话写章行累计草稿字数估 token（草稿双份 + 每回合简报包，保守下限），预估 ≥ 256k 预算 60% 即硬警告「换会话交接」；估算数字（turns/draftChars/estTokens/pct）未达阈值也常驻返回，横幅按 hard/soft 分级渲染，写章回执与详情视图带体量估算
- README FAQ（中英）：写到几十章后 400 token 超限 = 换会话交接，书没坏、原会话别重试

### 修复

- 会话归属兜底：面板会话 id 与审计记账不同源/缺失时，单会话书按唯一会话兜底估算并自报口径——修外部实证「42 章连写爆栈，疲劳横幅与交接按钮整个缺席」；多会话书宁缺不假
- 疲劳默认值合并跳过显式 undefined（调用方传 `config?.x` 缺项不再把估算打成 NaN）
- 详情路由无条件聚合疲劳数据（不再以 `?session=` 为前提）

## v1.0.4 (2026-10-23)

### 新增

- 平台审稿扩到五家：晋江（3000–6000，开篇忌虐、字数足额按 error）、七猫（2000–3500，强情绪、章末钩子按 error）、飞卢（档案包络 1500–5050；上架前 1500–2000 / 上架后 2500–5050 分带，两带间隙 2001–2499 单独 warn；前 300 字出事、第二章亮金手指、第三章打脸的黄金三章定式）。novel_audit / novel_project 平台参数、工具描述、技能与预设全量同步五平台
- `novel_search query` 弱结果自动查询扩写：零召回或命中不足时把检索词改写 3–5 路重查合并重排；命中扎实不触发，扩写失败按原词结果返回并如实说明
- 写章落盘后自动对本章新块补语义标签（每章封顶 4 块、连败即停、不阻塞提交链）；新增配置 `search.autoAnnotate`（默认开）

### 修复

- 细纲 save_chapter 拦「场景自引禁词」：禁项词出现在必写场景条目里时落盘前拒收，不再烧一整轮写章才被机审驳回（E14）
- 机审连驳且字数停滞（比上一被驳稿净增不足 100 字）时，驳回文案追加「换新回合全文重写」指引（E15）
- 简报「本章字数目标」按本书审计现算首稿均长，低于下限+余量时追加差额与段数配方（E5）
- 预设 persona 移除未注册模板变量 `{{cwd}}`（prompt 组装失败隐患）
- 细纲契约段拍行格式口径与 novel_outline 描述对齐（行内括号与独立行两种都认）
- 平台 id 集合单点化：`PLATFORM_IDS` 改由档案表键派生，platform-review 模块加载时双向对账键集——加平台漏一处即测试红，不再出现「准入放行、审稿炸未知平台」的分家

### 文档

- 真书名撤出 lib/ 源码注释、test/ 夹具与工作脚本，统一中性指代（不变量 12 延伸到随包发行的 lib 与公开仓库）
- README（中英）新增「为什么不是又一个提示词合集」：三条可验证事实

## v1.0.3 (2026-10-22)

### 体检轮：审计收口（错误分类与时钟出纯模块）

1. **★ 门禁拒绝分类改 `code` 标记**（`lib/chapter-commit.js`）：新增 `GateRejectionError`（`code=GATE_REJECT`），提交链 8 个 throw 站点全部迁移；`isGateRejection` 优先认 `code`、文案前缀正则降为历史兜底。旧实现按**驳回文案开头**识别 409/500——文案一改，REST 面就把内容问题静默报成 `IO_FAILURE`（恰与「代码强制」主线相悖）。回归钉：`test/logic.test.mjs`「门禁拒绝分类认 code 标记」（文案前缀完全变了也认 409）。
2. **契约表时钟出纯模块**（`lib/scene-contract.js`）：`setContract` 的 `updatedAt` 兜底从内部 `new Date()` 改为调用方传参 `now`（工具层盖章）——该模块在纯函数名单里（AGENTS.md 不变量 2），时钟进纯函数后直测要 mock、重放会漂移。回归钉：B3 用例补「传 now 落值 / 不传不盖章」两条断言。

### 复核轮：细纲拍行形态与驳回文案可执行性（真机监控驱动）

1. **★ 裸「拍：」续行归属上一场景，不再灌水覆盖率的分母**（`lib/gate-metrics.js` `parseScenes`/`countSceneBeats`）：真机某书把拍写成场景行下方的「拍：…」独立行，旧解析把每行拍当场景（「拍」单字不满足标题冒号 `{2,40}`，整行成了标题）——3 个真场景 + 16 行拍 → 19 个「场景」里命中 3 个 = 覆盖率 15.8%，模型按警告字面去逐字复现拍短语，越追越低、白写两版正文。现在拍行归巢成上一场景的 `beatLines`（行首没有场景时丢弃），容量估算拍数以显式拍行为准（单场景封顶 5 仍生效）；行内「（拍：…）」路径不变，两种写法都认。回归钉：`test/beat-lines.test.mjs`（归属/容量/覆盖率三层纯测 + `novel_write_chapter` 端到端）。
2. **细纲禁项驳回带声明句与正文定位**（`lib/gate-metrics.js` `computeGateMetrics` 新增内部字段 `bannedHitsDetail` + `lib/chapter-commit.js` 驳回文案）：旧文案只给「命中禁项：X」，模型要猜去哪改。现在逐条给出禁项段声明句（截 60 字）与首个命中位置（正文行号 + ±12 字片段）——学 ledger-conflict 的自解释范本。纯内部字段，不进工具 `output.schema`。
3. **覆盖率警告把「什么要逐字」说死**（`lib/chapter-commit.js`）：旧文案列一串拍行让模型「补写」、下一句又提示拍不参与匹配，自相矛盾——正是「越追越低」的直接推手。新文案：需要逐字（跨标点）出现的是场景条目「：」前的**摘要短语**，拍只是节拍提示写意即可。
4. **ledger-conflict 文案删「或换新版本」死路**（`lib/ledger.js` `applyFactUpdates`）：冲突按章号记、与版本无关，同章重写换新版本照样冲突——旧补救指了条走不通的路。新文案给出合法修订通道：重写同章时从 `facts_updates` 省略已落账的键；正文表述确实变了，用 `novel_ledger update` 落到实际变化的章号并备注。`reason` 截断上限回归钉随放（250→320；截断语义不变，未截断值 1100+ 字）。
5. **细纲「必写场景」格式示例进技能页**（`skills/novel/SKILL.md`）：补一份可直接照抄的示例（括号拍与独立拍行两种写法），写明「摘要短语要逐字、拍不要求逐字」——把格式约束从错误信息回教前移到动手前。
6. **预设 persona 隐私清洗**（`lib/preset/novel-forge/agent.cordis.yml`）：去 AI 味铁律段中书内角色名换中性指代（不变量 12；该文件随 npm 包发行并部署到每个用户的 agent-presets 目录，属发行面）。

## v1.0.2 (2026-10-21)

### 代码审查轮：schema 漂移与回显一致性（1.0.2 复核）

1. **★ `novel_noai_scan` 补 `defaultword` 输出 schema**（`lib/tools/noai-scan-tool.js`）：第八维 `defaultword` 进了 `scanAiFlavor` 的返回，但工具 `output.schema` 的 categories 还停在七维、且 `additionalProperties:false`——宿主对工具输出做 lossless 严格校验，多一个键整次调用 `INVALID_TOOL_OUTPUT`，该工具上线后每次调用必炸（与 0.13.3 style / 0.13.7 summary / S1 propose 同族事故）。schema 补 `defaultword`（与 stock 同形 `score/total/hits:[{term,count,per1k}]`）。**两层回归钉**：`test/smoke.test.mjs` 一致性抽查改成「categories 返回键集 == schema 声明键集」的集合相等（不依赖 SDK，双向漂移即红）+ 真校验器用例把 `novel_noai_scan` 纳入 `validateJsonSchemaValue` 面。
2. **`phase` 动作回显归一后的阶段 id**（`lib/tools/project-tool.js`）：返回体此前回显 `args.stage` 原值，入参给旧别名（planning/drafting…）时回执说别名、盘上与审计记的却是归一 id（topic/writing…），两处对不上。改回显 `res.phase`。回归钉：`phase stage=planning` 断言回执 `stage==='topic'` 且落库同源。
3. **`platform` / `chars` 补未落盘守卫**（`lib/tools/project-tool.js`）：同批重构的 `phase`/`set_stage` 有「书目在并发里被删 → `written:false` → 抛未落盘」守卫，这两处漏了——mutator 见 `latest` 缺失返回 undefined 时静默返回缺 `charMin/charMax` 的成功回执。补同形 `if (!written) throw`，并在 `test/batch5.test.mjs` 锁死 `updateJson` 的 `written:false` 契约原语（mutator 返 undefined 绝不写盘、不凭空造文件）。
4. **简报草稿残留扫描的列举兜底**（`lib/briefing.js`）：`io.listNames?.(book).catch(...)` 依赖「可选链短路整条 `?.().catch`」这条反直觉特性，且漏掉「listNames 存在却同步抛」的形态。改显式 try/catch + `??`，三条失败面（方法缺失 / async reject / 同步抛）都收成「当没有」。回归钉：`test/briefing-draft-residue.test.mjs` 补「listNames 同步抛不崩」。
5. **文档口径对齐八维**：`novel_noai_scan` 描述、README/README.en 的「六维去 AI 味扫描」更正为八维（补「断章公式 / AI 默认值词」两项；`novel_style` 的六维文笔基线是另一码事，不动）。CHANGELOG「流程死锁」节编号从误写的 4–7 更正为 1–4。

### 写入形态、归属闭环与假阳性收窄（1.0.2）

1. **项目设置的读-改-写统一走冲突重放**（`lib/tools/project-tool.js` 的 `platform` / `chars` / `phase` / `set_stage`）：四处改为 `updateJson`（读时捕获版本、冲突重读重放），与 REST 面同形。旧实现读一次快照后整份回写、版本在写前一刻才 stat——与面板同期保存撞车时会覆盖掉窗口期内写进去的章节索引、会话归属与熔断计数。回显（字数区间 / 阶段看板）一律在**重读后的最新内容**上算。
2. **列表端按会话挑拷贝**（`lib/server-workspace.js` `scanAllBooks({ session })`、`lib/server-routes/projects.js` 列表与认领）：同名书在多工作区根下并存时，列表此前恒取根排序先到者当「这本书」，过滤用的 novel 与展示的 novel 不是同一份拷贝——会话名下那份不在首根时书会被整个过滤掉（面板空白），或显示 A 份章数、点进去读 B 份。现在与 `locateBook` 共用 `bookInSession` 选拷贝；无 session / 会话无归属时维持 cwd 根优先，同名书仍只出一张卡（副本数照旧标注）。
3. **预约式收尾取窄**（`lib/hook.js`）：【】推送标签与「配送/送达/取餐/出发+冒号」开场后，必须真钉了一个可指认的时点（数字或中文数字紧贴时间单位，或明晚/午夜一类时间锚）才判 announce。首版只要求「标签后跟若干非句号字符」，普通叙事（标签后接一句动作）会被误判成钩子——把「无钩」报成「有钩」等于放行一次真正的断章。
4. **面板字数输入框用服务端现值初始化**（`src/client/controllers/projects.js`、`src/client/state.js`）：`charsValue` 以详情 `charView.charLimits` 为初值，并区分 `undefined`（未拿到/未编辑）与 `''`（明确清除）。此前恒为空串，输入框却显示着盘上的区间——用户没改动就点「保存」会把自定义区间清掉，无报错无提示。
5. **上下文包结尾改截尾**（`lib/contextpack.js`）：「上一章结尾」装不下时保留**结尾**（新增 `clipTail`，标记前置为「前文截断」），不再截头把钩子与最后一句扔掉；截断标记计入 cap（此前实长为 cap+5，按剩余预算现算的区块会静默超支）；给前文摘要留次级保留额（只从结尾超出下限的富余里划），避免结尾先占位把摘要整块挤进 dropped。
6. **平台审稿读本书字数口径**（`lib/platform-review.js` `reviewForPlatform` 新增 `charConfig` / `charSource`，`lib/tools/audit-tool.js`）：字数条目按「本书自定义 > 投放平台 > 插件配置」判（与写章门禁同一个 `effectiveCharConfig`），文案写明数字出处。此前审稿只读静态平台档案——书设 3000–6000、平台番茄时，5000 字的正文在「写」这边通过、在「审」这边被判超长。黄金三章下限改为 `max(2500, 本书下限)`：自定义档高于 2500 时不许被顶回去（原实现是「只抬不压」，写死的 2500 反过来把自定义下限压低了）。
7. **字数口径回执引用真实参数名**（`lib/store.js` `charLimitsNote`）：自定义入口的提示写的是「传 `chars_min` 与 `chars_max`」，而工具 schema、REST、面板都只收单个 `chars` 字符串（"2500-3500"）——模型照回执传参会撞非法入参。改为 `chars: "2500-3500"`，`test/platform-persist.test.mjs` 加「回执参数名必须真实存在」回归钉。
8. **phase 回执回显归一后的阶段 id**（`lib/tools/project-tool.js`）：入参给旧别名（`planning`）时盘上落的是归一 id（`topic`）、审计行也记 id，返回体却回显入参原值——「回执说 planning、盘上是 topic」。改为返回 `res.phase`；`test/smoke.test.mjs` 加旧别名回归钉。

### 检测面假阳性收窄

1. **单 token 兜底不成立**（`lib/gate-metrics.js` `sceneMatched`）：desc 只抽得出一个 ≥2 字词时不再启用降级互证——判据会退化成「正文任意处出现该词」，把「漏场景」的警告静默吞掉（注释承诺的「两条短词须同时出现」此前没有代码保证）。
2. **破折号要求的否定守卫**（`lib/gate-metrics.js` `dashEndingNote`）：细纲写「章末**不得**用破折号收尾」时形状与要求型一致，会被反向读成要求、劝模型去违反自己的细纲。现在只在**命中跨度**内查否定（同一行里并列的「不许用句号收平」不误杀真要求），并要求句含祈使语气（只陈述不算硬要求）。
3. **段落规格不再倒挂**（`lib/audit.js` `paragraphSpecRange`）：下限 >4500 字的长章书此前输出「单段 170–150 字」，三个消费方（简报/批量起草/驳回文案）一起失真——上限钳住。

### 语句层面：抓得到「不通顺」，报得出默认值词（1.0.2）

1. **润色新增「言说动词的宾语被物件顶替」病灶**（`lib/polish.js` `findSpeechObjDefects`）：这类病句此前 100% 漏检——润色只认三类病灶（AI 味 / 段长 / 结论式短句），而「把账本喊了三条巷」在字面上一个禁用词都没有。病根是言说动词的宾语槽被物件顶了，读者按字面读会卡住。三件同时成立才判定（把/将字句 + 言说动词 + **范围补语**），缺一放行：「把他喊了回来」「把话说清楚」都是正常句，没有范围补语就不判；宾语含言说内容词（话/事/名字/消息/经过/原委…）也一律放行。141 章真机语料实测命中 2/141、零假阳性。
2. **去 AI 味新增第八维 `defaultword`**（`lib/noai.js`、`lib/data/noai-lexicon.json`）：AI 默认值词（动作与身体部位的默认选项）此前不在任何一维里——cliche 收的是长模板句，stock 收的是修饰词，而「摩挲」这类实词谁都能写一次。它必须**按密度计、不能命中即计**，因此配两道闸门：① 绝对计数 <3 不计分（「屏住气息」是正常写法）；② 篇幅 <800 字不计分（polish 逐段扫描时每段只有几百字，短样本上密度必然失真——不加这道闸门时，12 字里 1 次命中就是每千字 83 次、直接打满 100 分）。权重从其余七维按比例匀出，八维合计恒为 1。
3. **开书工具描述改成宿主真实能力**（`lib/tools/project-tool.js`、`AGENTS.md` 不变量 1）：`novel_project init` 只落 `novel.json`、不建五个空目录——此前被描述成「novel.json + 目录骨架」，与实现不符。原因是**宿主 `FileSystem` 接口没有 `mkdir`**，local 后端只在 `writeText` 内部递归建父目录，空目录创建不是公开能力。结论是这是正确行为而非缺陷：目录随首次写入自然出现，别为建目录破例用 node:fs、也别造占位文件。
4. **简报报书根草稿残留**（`lib/briefing.js`）：模型爱先用宿主 write 在书根写 `.draft-chN.md` 再搬进 `novel_write_chapter`——那一步绕过门禁、版本记录与账本联动，搬完还常常不删。简报每章扫一次书根的 `.draft*` 并告警，定位是**行为纠正**（指回 `novel_write_chapter`、点名「宿主 write」是错误动作），不是让模型去删它删不掉的文件。

### 流程死锁与纵深防御

1. **陈旧提案可以丢弃**（`lib/proposals.js` `discardProposal`、`src/client/views/project-detail.js`）：陈旧守卫拒下 apply 的文案让用户「请丢弃后重提」，而丢弃只收 `pending`、面板又只渲染 `pending`——照提示操作无路可走。现在 `superseded` 可丢弃，面板把它显示出来（标「已陈旧」、不给「应用」、说明为什么）。
2. **批量起草先读 body 再定位书**（`lib/server-routes/insights.js`）：`draft-batch` 的 `locateBook` 此前排在 `readJsonBody` 之前，`body.session` 完全不参与归属判据——书按 query/头定位、引擎按 body 锚定，多根同名书时两个会话口径分家。
3. **`body.book` 过 id 形状校验**（`lib/server-routes/session.js`）：会话轮换的书名要拿去拼读写路径（含认领时的写路径），与全站其它端点统一先过 `validBookId`。
4. **回退提示只打一次**（`lib/server-workspace.js` `locateBook`）：「会话在本书所有拷贝上都无归属」此前每个请求都 `console.info`，真机刷屏会淹掉真正的告警。

### 真机连载本监控轮修复（1.0.2）

1. **W1 场景匹配约定入文**（`lib/tools/outline-tool.js`、`lib/chapter-commit.js`）：细纲工具描述写明「描述必须是正文里逐字出现的短语，（拍：…）括号内不参与场景匹配」；场景未覆盖的警告附带同一提示——治「逐字短语写进拍里」的系统性漏判（真机第 1 章覆盖仅 28.6% 的根因约定缺口）。
2. **W2 desc 全 <3 字兜底**（`lib/gate-metrics.js` `sceneMatched`）：keywordsOf 抽空时降级取 ≥2 字词，互证结构不变（仍需 ≥2 条命中）——治「谢谢，兄弟」这类短描述被 ≥3 字下限整条滤空的漏判（真机第 10 章「交接」场景）。
3. **W3 许可触发词扩展 + 否定守卫**（`lib/gate-metrics.js` `parseBanRules`）：PERMISSIVE_BEFORE_RE 增补 只称/只叫/只用/指称/名叫；调用点加否定守卫（触发词前 1–2 字含 不/勿/别/非/禁 时不按许可处理）——治「只用绰号指称某角色」被收进禁词表的误拦，同时防「不得只写「X」」被反向误放。
4. **W4 预约/推送式收尾**（`lib/hook.js`）：新增取窄模式——【】推送标签或「配送/送达/取餐/出发+冒号」开场的章末判定为 announce；普通时间陈述句不受影响。
5. **W5 ledger list 动作**（`lib/tools/ledger-tool.js`）：novel_ledger 新增 list——列出全部伏笔（id/埋设章/预计回收章/是否已收），治「伏笔 id 只在 setup 返回体里出现、事后 payoff 拿不到 id」的登记缺口。

### 提交链与熔断

1. **非成稿提交不再计入熔断**（`lib/audit.js` 新增 `nonDraftFloorChars` / `nonDraftNote` / `nonDraftRejection`，`lib/chapter-commit.js`）：阈值由 `minChapterChars / 4` 派生，取不到有效下限时为 0（不判定）。低于阈值的提交照旧驳回（机审判定不变），但不调 `recordRejection`、不落盘计数；审计行带 `nonDraft: true` 与 `nonDraftFloor`。熔断解除通道与 `force` 语义不变。
2. **驳回文案改为可执行信息**（`lib/audit.js` 新增 `paragraphSpecRange` / `PARAGRAPH_SPEC_MAX`、`auditVerdict`、`nonDraftRejection`）：段落过少的驳回写明按**空行**分段（单换行算同一段）、单段字数区间（下限由 `minChapterChars` 派生，上限 150）与全文应分段数；非成稿提交改用「这不是一章」文案，并回显段落数、非空行数、弯引号数、直角引号数。
3. **细纲的破折号收尾要求进 warnings**（`lib/gate-metrics.js` 新增 `dashEndingNote`，`lib/chapter-commit.js`）：细纲声明末段/章末须收在破折号上、正文末段未收在 `—` / `——` 时，写入本章返回的 `warnings`；只提醒，不阻断。

### 覆盖率与人物称谓

4. **覆盖率要素只取「本章必写场景」段**（`lib/contextpack.js` `declaredCoverageTerms`）：世界书关键词仅当出现在场景段（`本章必写场景` / `必写场景` / `本章场景` / `场景清单` / `本章场景清单`）时才计入要素；卷属、本章任务、禁止偏离项里的词不再进要素表。细纲无场景段时退回全文匹配（旧书口径不变）。
5. **写章与审阅共用已知称谓证据**（`lib/audit.js` 新增 `knownAddressCandidates`、`computeAudit` 新增 `castAliasSources`，`lib/chapter-commit.js`、`lib/tools/audit-tool.js`）：对全名未出现在正文的角色，`老/小/大/阿 + 姓` 候选只有在人物卡、语言基因卡或既往章节正文中出现过才计入覆盖（去姓短称仍无出处要求）。两处调用点都只在全名缺席时读卡，读不到降级为空证据。**证据分两层，不拼一锅**：档案证据按人归人（同书两个同姓人物共享同一个候选称呼，把所有人的卡拼成一个证据池，别人档案里写明的「人称老X」就会替这个人交卷、把真漏写吞成没漏）；既往正文没有归属信息，只能整体共享（这一点在代码注释里如实标为残留串味面，且覆盖率本来就是 warning 档、不参与驳回）。

### 上下文包

6. **上一章结尾按剩余空间截断，不再整块丢弃**（`lib/contextpack.js` `buildContextPack`）：保留上限取 `min(600, 剩余空间)`，剩余空间不足 `TAIL_FLOOR_CHARS`（160 字）才进 `dropped` 并给找回指令。原实现只有 600 字整块或 0 字两种结果。

### 会话归属定位（多工作区同名书）

1. **`locateBook(bookId, { session })`**（`lib/server-workspace.js`）：同一本书在多个工作区根下各有一份拷贝时，给了会话就优先返回该会话名下的那份（判据与列表端 `bookInSession` 同一函数）；会话在所有命中拷贝上都无归属 → 按根排序回退第一份（旧行为，不 404）；不带 session → 与旧版逐字节一致。
2. **读/写端点接会话**：章节目录、读正文、保存、一键修订、详情、要素、导出、删除、改名、克隆，以及会话轮换的「新会话工作区推导」与「自动认领书」两处，一律带会话归属判据（`requestSession` 为唯一取法）。
3. **客户端取数带会话**：章节目录 / 阅读器 / 听书播放器走 `withSession()`，保存把 session 放进 body。

### 提案制

7. **提案登记基线，apply 前校验陈旧**（`lib/proposals.js`）：提案文件与索引都写 `baseVersion`（登记时的 `latest`）；apply 先比基线，无 `baseVersion` 的存量提案退回「提案 `createdAt` 早于章记录 `updatedAt`」判定；陈旧提案标 `superseded`（提案文件与索引双写）、落 `propose/superseded` 审计并抛中文错误。`listProposals` / `readProposal` 输出 `baseVersion` 与 `latestVersion`。
8. **同章拒绝重复提案**（`lib/proposals.js` `submitRevisionProposal`）：入口快照 + 登记时复核两段判定；同章已有 pending 提案时抛「先在面板应用或丢弃」。
9. **`discard` 补 id 形状校验**（`lib/proposals.js` `discardProposal`）：与 read / apply 同款 `validProposalId`，阻断把非法 id 拼进提案目录写路径。
10. **apply 保住 gate 字段**（`lib/proposals.js`）：`chapterRecord` 的 prev 改传完整当前记录，契约指标重算返 null 时回落到上一版 gate。
11. **propose 工具补基线字段**（`lib/tools/propose-tools.js`）：返回体与 proposals 条目新增 `baseVersion`、`latestVersion`（integer，无值时不携带）。

### 字数口径（单一真相 + 本书自定义）

12. **字数区间的唯一真相在 `lib/store.js`**：新增 `PLATFORM_IDS`、`PLATFORM_PROFILES`（起点 2000–4000、番茄 1500–3000）、`parsePlatform`、`platformOf`、`parseCharsSpec`、`parseCharLimits`、`charLimitsOf`、`effectiveCharConfig`、`charLimitsView`、`charConfigSourceLabel`、`charLimitsNote`、`platformNote`。生效优先级 **本书自定义（`novel.charLimits`）> 投放平台（`novel.platform`）> 插件配置**；三档都没设过时 `effectiveCharConfig` 原样返回传入的 config 引用（默认行为不变是结构性保证）。`charConfigForPlatform` 保留为「只算平台档」的底层件，判定链一律走 `effectiveCharConfig`。
13. **平台数字不再抄第二份**：`lib/platform-review.js` 反向 import `PLATFORM_PROFILES`，番茄/起点的 `chapter-length` 判定值与文案（label/target/advice）全部由表生成——此前 store 与 platform-review 各抄一份字面量，正是「写审相反」的温床。段落规格同理：`lib/briefing.js` 与 `lib/batch-draft.js` 的内联算式改调 `paragraphSpecRange`，全项目只剩一份。
14. **★ 口径闭环到每一条链**（上一版只改了工具面两处，本轮补全其余六处）：写章 `novel_write_chapter`、写前简报 `novel_briefing`（含 D2 批量起草的 `draftSystem`/`buildBriefing`）、面板存章 REST `POST /chapters/:no`、面板批量起草 `POST /draft-batch`、提案 `novel_propose` 上下限、润色 `novel_polish submit`、细纲 `save_chapter` 的容量门禁与逐场景预算、`novel_audit` 的字数判定与默认平台审稿——全部按本书生效区间算。工具描述里写「以简报为准」，简报就必须报同一个数（旧状：简报说 2000–4000、门禁按本书档位判，模型照简报写完再被退稿）。
15. **`novel_project` 新增 `action=chars`（读/写/清除本书每章字数区间）**：`chars` 参数写「下限-上限」（认 `- – — ~ 、，/` 与空格），不传＝只读，空串＝清除；半套区间、非整数、越界（100–20000 之外）、上下限倒挂一律响亮报错且**不改坏已落库的值**。`init` 也接受 `chars`（与 `platform` 一起在第一次写盘落地，不留「书已建好、区间没落地」的窗口）。`status` / `platform` 回执一并带 `charMin`/`charMax`/`charSource`/`charLimits`（没设自定义时省略 `charLimits`，不送 null）。
16. **面板能设字数**：项目详情新增「✒️ 每章字数」卡（显示生效区间 + 出处，改数保存、一键清除自定义），建书表单新增选填的「每章字数」输入框——**开书时就收集用户的字数设置**（用户不答就不传，回落默认口径）。新端点 `POST /projects/:id/chars`（走 `updateJson` 读时版本 + 冲突重写、fence、审计行 `rest/chars`），`POST /projects` 建书接受 `chars`/`platform`（非法值 400 而不是静默丢弃），`GET /projects/:id` 回 `bookId`（目录名）与服务端算好的 `charView`（面板不重算优先级）。常驻 systemPrompt 与 preset persona 各加一条纪律：字数属于用户，开书先问，绝不替用户定、不拿上一本书的区间套用。

### 平台审稿

17. **判定项的窗口写进 label/target**（`lib/platform-review.js`）：`first-3-faceslap` 改为「前三章内本章须含打脸/逆转（窗口：本章全文）」并由 error 降为 warn；`first-1k-thrill` label 改为「前 1000 字窗口：给一个小爽点」。
18. **判定 value 不回显词表**（`lib/platform-review.js` 新增 `hitSummary`）：所有基于 `hitsOf` 的 value 只输出「命中 N 项 / 未检出」。
19. **番茄超上限改 error**（`lib/platform-review.js`）：`chapter-length` 在低于下限或高于上限时均判 error（数值取自 store 的档案表，见 13）；起点分支不变。

### 卷结构与阶段闸

20. **卷头支持开区间**（`lib/gate.js` `volumeRange`）：认「第 N 章起/开始/往后」（起头标记须收在行尾），返回 `to = Infinity`。`volumeSection` 两处一并收口：① 标题形状与 `phase-io.detectVolumePlan` 对齐（1–6 级、`#` 后可不带空格、7 个 `#` 不算），否则「卷结构过了阶段闸、方向闸却看不见」；② **区间重叠时取最后一个命中卷**——开区间未必排在大纲末尾（作者改了卷规划忘了给老卷头封顶，「卷一 1-100」+「卷二 71 章起」并存是常态），取第一个命中会让 71–100 章落在卷一，方向闸拿着错的规划段稳定报「你拐线了」，比没有闸更坏；规范大纲（区间不重叠）下两种取法等价。
21. **「卷一」写法认作分卷**（`lib/phase-io.js` `detectVolumePlan`）：新增「卷/幕/部/篇 + 序数」判据，**但锁在 Markdown 标题行内**——这一支没有「第」当前缀，放宽到正文就会把「这本设定集分 3 卷出版」当成结构信号、让阶段闸形同虚设（红绿实测：撤掉行锚点即误判）。带「第」的「第X卷」仍允许出现在正文任意位置（旧判据不动）。`lib/phases.js` 的阶段闸缺失文案列出被接受的写法清单。

### 诊断

22. **对白统计改认弯引号**（`lib/diagnose.js` 新增并导出 `countDialogue`）：主判弯引号，兼容直角引号与直引号；`openingScore` 与 `conflictScore` 共用同一口径（此前只匹配 `「」`）。

### REST 与会话归属

23. **`locateBook` 接受 `opts.session`**（`lib/server-workspace.js`）：命中拷贝中优先返回 `bookInSession` 名下那份；均不归属时按根排序回退第一份并打 `console.info`；不传 session 保持首命中即返回。
24. **会话取法收口成一份**（`lib/server-api.js` 新增 `requestSession(req, body)`）：POST body 的 `session` 优先，退回 URL 的 `?session=`。此前各域各读各的（GET 只读 query、POST 只读 body），面板漏带一处就悄悄落到**另一会话的同名拷贝**上。
25. **全部按书定位的端点都带归属**（`server-routes/` 的 chapters、projects、proposals、worldbook、insights、session 六域）：目录、读正文、保存、一键修订、详情、要素、导出、删除、改名、克隆、**每章字数设置**、提案队列/全文/应用/丢弃/清理、世界书四种方法、体检、诊断、批量起草、会话轮换与工作区推导、自动认领——一律走 `requestSession`。
26. **★ 面板 session 在唯一出口自动附加**（`src/client/api.js`）：`apiFetch` 对**书作用域路径**（`/projects/<书>/…`、`/worldbook/<书>`）自动附加 `?session=`，逐处补参数的写法退场——上一版只覆盖列表/详情，章节目录/阅读器/听书/保存/提案/导出/删除全都按根排序定位（书卡显示 A 拷贝 105 章、点进去读到 B 拷贝 103 章，删除还会删错那本）。裸 `/projects`（列表范围由 `sessionScope` 决定）与 `/projects/claim`（挂的是**动作段**不是书目名，会话走 body）显式排除在外。
27. **面板存章版本号走统一入口**（`lib/server-routes/chapters.js`）：由内联 `latest + 1` 改为 `versioning.nextVersion`（按磁盘文件名取最大版本）。

### 场景契约

28. **未声明 hidden 时给提示**（`lib/tools/scene-tools.js`）：`args.hidden === undefined` 时追加一条 warning；显式传空串不提示。

### 会话交接

29. **「创建新会话并交接」传错书键**（`lib/server-routes/projects.js` 详情响应新增 `bookId`，`src/client/controllers/projects.js` 改传它）：客户端把 `detail.id` 当 book 传给服务端，而 detail.id 是 novel.json 的内部 id（`nb_…`），`locateBook` / `requireBook` / 认领认的都是**目录名**。真机实测（某连载本，第 14 章交接）：新会话创建成功、落点靠旧会话注册表兜底，但 `claimed:false`，新会话面板书列表 **0 本**；同一次调用把 book 换成目录名后 `claimed:true`、列表 1 本。详情响应在 `...novel` **之后**补 `bookId`（目录名），`id` 旧契约不动。

### 文档与回归

30. **改稿通道边界统一为两条**（`lib/index.js`、`lib/tools/propose-tools.js`、`skills/novel/SKILL.md`、`lib/preset/novel-forge/agent.cordis.yml`）：自己动笔改稿（含机审驳回后重写同章）走 `novel_write_chapter`；登记待批提案走 `novel_propose`。删除「修改已存章节只能走提案」的表述。
31. **回归测试**：新增 `test/m15-coverage-scope-and-continuity.test.mjs`、`test/m15b-session-handoff.test.mjs`、`test/diagnose-quotes.test.mjs`、`test/volume-open-range.test.mjs`、`test/platform-review-fixes.test.mjs`、`test/platform-persist.test.mjs`、`test/char-limits-scope.test.mjs`（口径闭环 + 本书区间：写章/简报/提案/润色/审计五面同一数）、`test/proposal-guardrails.test.mjs`（陈旧提案两分支 + 同章去重 + discard id 守卫 + 称谓证据）、`test/helpers/plugin.mjs`（装插件共用载体，含造字工具）；`test/client.test.mjs` 增「书作用域请求统一带 session」与交接 `body.book` 两条**驱动真控制器**的行为用例（原 `test/m15b-session-handoff.test.mjs` 里读源码字符串的那条断言已按 AGENTS.md 换成行为测试）；`test/server-api.test.mjs` 增「会话归属定位」集成用例并把路由清单加到 28 条（R1 fence 全覆盖）；`test/batch5.test.mjs`、`test/logic.test.mjs`、`test/smoke.test.mjs` 随行为调整断言。

## v1.0.1 (2026-10-16)

### 修复版：机审/门禁假阳性三连修 + 字数口径对齐（真机 20 章监控日志定型，全程零 force 写入）

1. **章末钩子检测扩展四类**（hook.js `detectHookKind`）：真机 20 章监控累计 9 例漏检定型——
   ① 拟声收尾（同一拟声字连响 ≥2 次，如叩门/更鼓 cliffhanger；单字不认）；
   ② 省略型（指代主语+「没+言说动词」收尾，可带 ≤6 字宾语——「他没说。」「谁也没提…」）；
   ③ 宣告型（独立短句「来了。」「到了。」「找上门了。」，主语排除食物/天气等日常宾语）；
   ④ 在场型（「他就在。」「它还在。」）。全部取窄：宁可维持漏检现状，不制造假阳性驱动改稿。
   比喻类收尾（正则分不出比喻与平叙）明确不在范围，留给人工/模型自查。
2. **novel_audit 覆盖率词表取本章契约参与者**（tools/audit-tool.js）：有场景契约的章，
   词表与人物缺失判定的 castNames 优先取 `participants`（契约在场时它才是「本章出场」
   的真值），无契约回退工程 cast 全员——旧口径把全书人物名都算成本章要素，终章回看段
   列举的已完结人物全数误报为「要素字面未逐字出现」（真机单章累计 10 项误报）。
3. **内容门禁「死者复活」结账回看豁免**（content-gate.js）：死者在本章每一次出现都落在
   含结词指纹（「讫」/「一笔勾销」/「账已平」）的句子里时，降级为 `dead-character-mention`
   warning 请人工确认——整章回看宿簿逐页列举已完结账目（页脚「讫」句式）不再被判复活
   拦章；任一次出现不带结词则维持阻断（真复活仍拦）。
4. **机审字数口径写进简报**（briefing.js `charTargetSection`，抽为导出纯函数）：「本章
   字数目标」段新增口径说明——含标题全文、剥 markdown 强调标记后按非空白字符计数
   （标点计入；省略号/破折号各按 2 字符计），明确禁止自查自己剥标题或估字。真机监控
   实测自查与机审两种口径同稿差 45–76 字，「过下限但差目标」的判断随口径漂移，从此
   有唯一口径可对齐。

## v1.0.0 (2026-10-16)

### 里程碑版：引用规范 + 细纲契约对同义改写的完整支持（0.19.1 → 1.0.0 累计，真机两本书全程验证）

#### 25 章完结本真机验证轮（0.19.1–0.20.0，含 v0.20.0 四项修复）

1. **引号规范链路**（punctuation.js `normalizeQuotes`，0.19.2）：直角引号「」『』在三个入口
   （写章/批量起草/面板人工保存）落盘前统一转国标弯引号“”‘’，计数进 `quoteConverted`
   返回值与 softWarnings——转换幂等、零信息损失；`proposeRevision` 归一化先于机审，
   提案与应用双链路同口径。某完结本迁移 1526 处直角引号即走此链路。
2. **场景标题别名**（gate-metrics.js `splitTitleAliases`，0.20.0）：细纲条目支持
   「标题｜别名1/别名2」与「标题（别名）」——同义改写场景从此可声明词面，
   `sceneMatched` 任一命中即算落实；aliases 同样进 desc 词互证豁免。
3. **hidden 人物出场剔除**（scene-contract.js，0.20.0）：场景契约 participants 里
   匹配「X不出场/不得出场/不得出现/不登场/不许出场」模式的人，从注入名单剔除——
   声明式防「参与名单把隐藏人物档案带进上下文」。
4. **提案应用重算 gate**（proposals.js `recomputeGateFor`，0.20.0）：apply 提案后
   契约指标按新版本正文重算并写入 `chapterRecord.gate`（含 at 时间戳）——
   版本演进与 gate 留痕不再脱节。
5. **简报注入未覆盖场景欠账**（briefing.js openGates，0.20.0）：写前简报列出全部
   `gate.missedScenes` 非空的历史章——欠账对下一章写作者可见，不再沉默跳过。

#### 20 章监控轮（本版新增，真机监控日志全程留痕）

6. **短别名同窗共现**（gate-metrics.js `proximityHit`）：2 字词面「落闩」在
   「门闩…咔…自己落了」里跨字拆写，连续 includes 必漏（真机两轮踩坑）。判定放宽：
   2 字别名全部字符出现在 ≤12 字窗口内即算命中（声明即意图，宁松勿漏；
   叠字词去重后不足 2 字不判——单字共现过宽）。3+ 字别名仍要连续词面。
7. **预告式收尾钩子**（hook.js `foreshadow`）：「明日…就到了。」「簿子也在等。」
   「是簿子还没落笔。」——账簿流/规则流网文的标准断章形态（真机 6/6 章漏检）。
   模式取窄：需「明日/明早/天亮前」时间锚或「在等/还没落笔/还没到…日子」未落定措辞。
8. **元叙述（破墙）词检测**（audit.js `metaNarrative`）：正文出现「本章/读者/作者/
   这个故事」即警告——模型补写事故「故事本该这么写」级别句子，noai 六维抓不住，
   只有启发式能拦（真机第 6 章险情）。
9. **目标字数达成率留痕**（gate-metrics `chars`/`targetRatio`）：gateRecord 落
   达成率（机审 chars 口径/机审同源目标值，非阻断）——「长期贴下限」从体感变数字。
10. **机审文本补 quoteConverted 展示**（writing-tools.js render）：结构化返回早有
    该字段、textBlock 漏显示——补齐（>0 显示转换数，=0 显示 0，与 quoteStyle 警告联动可读）。

#### 测试

`test/monitor-fixes.test.mjs` 14 用例锁定上述行为；全套 495/495 通过，
`npm run audit` 硬故障 0。

## v0.19.0 (2026-10-15)

### 某连载本 105 章审校驱动的六个 guardrail（外部审校报告 → 插件侧归因 → 补闸）

外部审校报告给出 P0 结论：剧情从第 25-26 章起彻底脱离全书大纲（卷二应写的「青岚兵院」
整段未发生）、伏笔台账止于第 33 章后约 15 钩零登记、100+ 章「一句宣言+叹号」断章公式、
50 章残留英文单词、账本「十年/十一载」两套并行。本机审计流水还原了机制：168 次
`outline/approve` 全部工具自批（批准人=作者本人）、拐线章正是驳回重写压力最大的位置
（ch24 一小时三驳两轮细纲重写）、写前简报只认伏笔.json 所以未登记的钩子对后续所有章节
不可见——偏离是机制必然，不是某一次失误。六条补闸（全部「代码强制>提示词自觉」）：

1. **大纲方向闸**（gate.js `volumeSection` + `outlineDivergence` 纯函数；outline-tool
   的 save_chapter/approve 接线）：细纲与全书大纲本章所在卷规划段的 2-gram 重合度
   <0.15 → 可见性警告（不阻断——拐线可能是合理的创作演化，但要可见），同时提醒
   `save_book` 更新大纲（真机实证「全书大纲开书后从未更新」也是帮凶）。
2. **开钩登记闸**（content-gate `open-hook-unregistered` + briefing 跨轮重算）：章末
   检出语义钩但伏笔台账无本章 setup → 非阻断点名 + 下一章写前简报再次提醒——
   `foreshadow_setup` 从自愿调用变成每次开钩可见，「未登记的钩子」从不可见变一直可见。
3. **断章公式维**（noai 第 7 维 `formula`）：章末「短宣言+叹号」直接计分 + 全文短叹号句
   占比（真机 55% 实测标定，健康书 2-3% → 0 分）。
4. **纯感叹收尾从钩子除名**（hook.js 删 `exclaim`）：拆除三处反向激励——content-gate 的
   「欠账未还禁开新钩」此前被一个叹号绕过、diagnose 给叹号 70 分、audit 文案把感叹列为
   合格钩子；书库画像换 `exclaimEndingRate` 独立维度（对标书叹号收尾章占比照样可量化）。
5. **英文残留阻断**（audit `latinRuns`）：连续 ≥4 英文字母机审拒收（「folded」案例回归）；
   单双字母（A 股/X 光/维生素 C）不误伤。TODO/FIXME 归机审、待补/待写归内容门禁，分层合理。
6. **数值口径漂移**（continuity `numeric-drift`）+ **批准通道归属**（`outlineVia` +
   status `approvedVia`）：短值数词归一化比对抓「十年 vs 十一载」两套并行（长叙述值不做，
   无分词器硬抽数词只会刷噪声）；approve 记 via 标记、status/面板 API 统计自批占比——
   先可见，面板人工批准通道后续补。

### 附：审校报告的「已修 bug 时序」复盘（不是本版改动，是归因留档）

报告附录指出：摘要只注入第 1-10 章（0.16.3 修）、大纲/锚段被预算整块饿死（0.17.0 修）——
该连载本 1-104 章几乎全写在修复前。修好车，车已在错路：这 80 章的偏移基线
只能按报告路线图在书侧重写大纲后逐章修订（`novel_propose` 提案制），插件侧本版起
新窗口期不再复现。

## v0.18.0 (2026-10-14)

### 用户报障三条：世界书首发报错 / 首稿字数不达标 / 第三章就「会话疲劳」（真机 183 章数据修根）

外部用户真机（新书验证）回报三个症状，逐条在本地复现后定位，
**三条都不是门禁失灵，而是判据/口径本身错了**——用本机 7 本真书 183 章的审计流水
（`test/tmp/firstdraft-full.mjs` 等四个分析脚本）做了标定与反证。

- **① 世界书：初次会话第一条红色报错**「世界书条目需要至少一个关键词，或 always:true 常驻注入」。
  复现：`novel_worldbook add` 只给 content 就抛。病根是**开书阶段要固化的天然是全书级设定**
  （题材定位/主线/金手指），本来就没有触发词，而 `always` 是可选布尔、要靠模型先想到它——
  常驻 systemPrompt 只带过一句「或 always」。按本项目老规矩（靠模型自觉的约束视同没有），
  这一步改由代码补位：`store.resolveWorldTrigger` 先从内容里挑**本书已知实体名**
  （cast ∪ 账本实体 ∪ 术语表 ∪ 已有条目关键词，只长者优先、单字不取，不凭空造 2-4gram），
  挑不到就转 `always:true`，两条兜底路都带**可见 warning** 并在 render 里转述。
  `normalizeWorldEntry` 的抛错分支保留给没有兜底通道的调用方（REST 面板/import）。
  顺带把 `novel_worldbook` 里 update/remove/import 的裸 `e.id === args.id` 比较统一成
  `sameEntryId`（历史数字 id 与 `'W5'` 字符串混存时，裸比较会静默删不掉/改不到）。
- **② 会话疲劳：第二章就误报**（真机文案「本会话已写 2 章，首稿均长 1459 字低于全书基线 2242 字的 70%」）。
  **量纲错配**：分子是首稿（门禁驳回前的裸稿），分母是全书**落盘**均值（被门禁顶到 ≥2000 的成稿）。
  门禁越起作用比值必然越低——「门禁正常工作」这件事本身被判成疲劳。本地复刻同形状
  （首稿 1197/1717 → 落盘 2046/2429）实测：比值 0.651 < 0.7，**第 1 章落盘就告警**；
  换成同口径（首稿 vs 首稿）比值 1.001，零退化。重写 `sessionFatigue` 判据（全部同口径）：
  ① 趋势（主判据）——本会话首稿序列后半 < 前半 × 0.75，真机每本书都测到负斜率
  （四本真机书实测：−24 至 −10 字/章，corr −0.80 量级），
  且换会话立刻回弹（两本真机书换会话后首稿均值回弹 15%–95%）；
  ② 水平——本会话首稿均值 < **其它会话**首稿均值 × 0.7，且本会话 ≥3 章、参照池 ≥3 章
  （新书没有跨会话参照 → 不判，此时「换会话」零收益）；③ 连写 ≥8 章兜底。
  文案与面板横幅都标出口径「首稿＝门禁驳回前的初稿字数，不是成稿字数」——
  用户把 1459 读成了「放行了短章」，这本身是第二条报障的来源。
  `bookCharBaseline` 退成纯展示口径（不再当分母）。
- **③ 首稿字数：为什么第一次写就不达标。** 先立事实：**一次过率 79%**（151 章里 119 章首稿 ≥2000），
  失败集中在长会话后段（某连载本 ch75–104 首稿 558–1706，换会话后回到 1625–2233）——
  所以主因是 ②，不是细纲。但顺带查出细纲容量闸的判据被真机证伪：
  旧口径 `场景数 × 480` 对首稿字数的解释力 **R²=0.033**（4 场景细纲实测 median 2087 字），
  拿它当硬闸在 151 章上**拦 35 章、误驳 22 章（63%）**，同时漏判 19/32 章真正写不够的，
  而且开的药方（「拆到至少 7 个场景」）打错靶子。换成 `场景数×300 + 拍×160`
  （拍＝描述里的动作分隔符，封顶 5）：**拦 15、误驳 2、精确率 87%**。
  驳回文案改成点名「哪几个场景只有一拍」+「还差几拍」，并明说**加拍比加场景有用**；
  过线但离目标远时 save_chapter 与写前简报各给一张**逐场景字数预算**
  （`sceneCharBudget`，按声明密度加权、合计贴住目标）——把「本章 3000 字」翻译成
  「这一场 ≈1350 字」，模型对前者无感、对后者可执行。召回只有 87%/41% 是诚实上限：
  剩下那半由会话退化造成，细纲层看不见它，硬拦只会误伤，交给机审与 ② 兜。
- **外部用户真机回采（报障那台机器，0.17.1，单会话 20 章 / 3.5 小时 audit.jsonl）**
  ——这份数据同时**证实、证伪、并补刀**了上面三条：
  - 证伪了「熔断被 cosmetic 改动刷掉」的猜测：第 1 章三驳（1650/1833/1946）→ `breaker_tripped`
    → 模型**真的把细纲从 774 字写到 1267 字**再 approve（`changed:true`）→ 解锁 → 落盘 2077。
    闭环按设计走通了，0.17.0 的「解除须真实改动」在真机上成立。
  - 证实 ② 且更狠：这 20 章的**首稿是一路上行的**（1650/1267/1258/1692 → 第 5 章起 2100–2655），
    落盘均值 2330、首稿均值 2107（比值 0.904）。旧算法在 ch1–ch2 就喊疲劳，到第 20 章反而不喊了
    ——它测的从来不是疲劳，是「首稿与成稿的落差」，而落差只在早期最大（早期全靠门禁顶上去）。
    新算法在这份数据上只出章数兜底、不出趋势/水平，行为正确（已固化成 logic 用例）。
  - 补刀 ③：前 4 章细纲 774–1312 字 → 首稿 1258–1692；细纲 ≥1284 之后首稿基本 ≥2000。
    也就是说对 flash 级模型，**头三四章的驳回是它的学习成本**，而降这个成本的正是
    「把字数线翻译成细纲阶段的素材要求」，不是事后提醒换会话。
  - 顺带修掉我自己写错的一条：章数兜底原文案说「上下文堆积**会稀释输出质量**」，这份数据里
    20 章连写质量没掉——章数只能回答「上下文规模在涨、重开是零损失的成本控制」，
    退化与否归趋势判据。文案与用例（`doesNotMatch(/会稀释输出质量/)`）一起改。
  - 世界书那条也对上了：报错的 add 走的是自定义 id `power_map`（「权力地图」＝典型全书级设定，
    天然无触发词），且**抛错发生在写盘前 → audit 里连一行痕迹都没有**，用户只看得见红字。
- 用例：logic 新增/重写 9 条（同口径真机形状、外部用户 20 章上行序列、趋势、水平参照、
  章数兜底不得宣称退化、firstDraftByChapter、容量估算含真机反例、逐场景预算、拍数封顶、
  世界书触发词兜底），smoke 新增 2 条端到端
  （世界书兜底三态 + 简报预算表），server-api 的 R-疲劳 用例改按新形状断言。
  **红绿双向**：回退 `health/chapter-commit/projects/writing-tools` → 疲劳用例红；
  回退 `store/worldbook-tool/gate-metrics/outline-tool/briefing` → 世界书与容量三条 smoke 用例红
  （3 条全红、还原 59/59 绿）。测试 436。
- 附带：`novel_write_chapter` 的 `progress.session` 输出形状变更
  （`baselineAvg` → `bookFirstAvg` + `firstSeries` + `referenceChapters`），output.schema 与
  面板横幅同步；README 中英两版的疲劳判据行按新规则改写，并补「第一章就写不够字数」一行。

### 补洞：面板「💾 保存」是全插件唯一的门禁旁路

顺着上面的排查查到最后一条：`POST /projects/:id/chapters/:no`（面板编辑器的保存按钮）
**不过任何一道判定**——任意字数（含空稿）都能落盘、写进 `novel.json.chars`、登记版本，
机审/内容门禁/账本/审计全被绕空。AGENTS.md 的立身之本是「代码强制 > 提示词自觉」，
而这条路上连代码都没有。修法分三层：

- **判定段只此一份**：把提交链的 ①→⑤.6（阶段门禁 → 细纲存在性 → 熔断 → 机审 →
  账本冲突 → 内容门禁 → 细纲契约指标）从 `commitChapter` 里**纯提取**成
  `runChapterGates()`，面板与模型/批量起草共用同一个函数——不在路由里另抄一份预检，
  按本项目那课：抄出来的那份一定在保护条款上漂移。**写段留在路由里**：面板的版本号必须
  在 `updateJson` 的冲突重放里算（两个面板同时存同一章不能撞车，`并发提交书` 用例钉着），
  `commitChapter` 的写段没有这个重放，借不得。
- **面板只豁免流程门禁**（`stageGate: false`：该章细纲是否已批准）——那是管模型的，
  不该拦住人改自己的稿子；内容级判定（字数/重复/死人复活/泄底/占位符/账本冲突/熔断）
  一条不让。被拦下回 **409 `GATE_REJECTED`**（与 500 `IO_FAILURE` 分码，判据是
  `chapter-commit.js` 导出的 `isGateRejection`，新增门禁必须同步进去），面板把原文摆出来
  并给一次显式的「仍要保存（跳过内容门禁·记审计）」——`force` 只放行内容门禁/禁项，
  字数线、账本冲突、熔断连 force 也顶不开，文案如实说明。
- **顺带修掉同一条路上的三个真 bug**：① 空稿一存 → 0 字章节落盘 + 索引登记 + 版本 +1，
  现在 400 `EMPTY_CHAPTER`；② 面板每次 POST 都送 `第 N 章` 当 title，而 `chapterRecord`
  的 title 无兜底 → **存一次就把真标题抹掉一次**（文件名同样被改），现在不送 title、
  服务端沿用原标题；③ 面板落盘的 `chars` 直接数原文（含 `**`），与机审的
  「先剥 markdown 强调再数」不同口径 → 面板显示的篇幅比读者看到的虚高（真机一章 188 个
  `*` 算 188 字），现在取 `auditResult.chars` 同口径。另外面板存章现在也走索引续建与
  `rest/chapter_save` 审计（带 `forced` / `blocked` 清单，放行了什么硬伤事后查得到）。
- 客户端：`apiFetch` 把服务端 `error.code` 挂到抛出的 Error 上（只抛 message 的话，
  分流就得靠正则匹配中文文案——那正是会静默漂移的写法）；`state.saveBlocked` 承载拦停
  原文，换章/换书/保存成功后复位。
- 用例：server-api 重写 R4（空稿 400 / 短稿 409 且盘上零残留 / 合格稿落盘 + 审计
  `actor=user` + `forced=false` + `blocked=[]`）、新增 R4b（标题不被抹）、R4c
  （占位符 409 → force 200 + 回显 + `content_gate_forced` 留痕）；client 新增
  「第一击不带 force、第二击才带」两段确认用例，并给 `scriptedFetch` 补了**带 code 的
  失败响应**能力（只会回 `ok:true` 的替身永远测不到按 code 分流的逻辑）。
  **REST 测试配置补 `minChapterChars`**：不配 = `chars < undefined` 恒假 = 面板字数门禁
  在测试里永远不生效，这条洞就是这么被绿灯放过去的。红绿：回退 `src/client/api.js` →
  两段确认用例红（saveBlocked 空）；还原 444/444 绿。

### 真机竞态三根因：面板双开存同一章 3/10 失败（memIo 原子替身结构性测不出）

对上面整批修复做真机验证（独立进程 + `createNodeFsBackend` 真后端 + 真 http + 真 fetch，
`scripts/rest-real-check.mjs` 固化为 15 项可重复回归）：18/19 PASS，唯一 FAIL 是并发双存
同一章 3/10 失败，逐个定性为三个根因一次关死（`8ff781d`）：

- **写原子化**：`createNodeFsBackend.writeText` 原为裸 `writeFile`——O_TRUNC 中间态被并发
  `readText` 读到 → novel.json「不是合法 JSON（可能被手工改坏）」误报。改为同路径写互斥
  （校验-写-递增 seq 成为原子段）+ tmp+rename 原子替换，读侧永远看到完整旧版或新版。
- **追加原子化**：`appendLine` 适配器的「stat→不存在 create / 存在 read+replace」在并发下
  两请求都 stat 到 null → 后者 `FS_NOT_OBSERVED`；读同一版本 → `FS_STALE_VERSION`。backend
  新增原生 `appendLine`（锁内读-拼-原子替换），fsio 两适配器检测到即委托——宿主后端没有
  此方法走原逻辑，零行为变化。
- **重放接住 mutator**：`updateJson` 的重放 try 只包写步，mutator 内的守卫写撞并发
  （两边都从 latest=0 算出 v1，正文 create 撞车）直接炸成 500。现 mutator 抛版本类冲突也
  视同「别人先写了」接进重放（重算落下一空位），上限 3→8 加微退避。锁清理链
  `next.finally` 的 rejection 泄漏（业务全 200 仍 unhandledRejection）一并修掉。
- 守卫进 `npm test`：`test/rest-race.test.mjs` 用真 node:fs 后端直驱 handler（memIo 同步
  Map 是原子替身，异步交错窗口只有真后端才有——替身必须镜像宿主这条学费的第三次）。
  断言语义修正：并发下两个响应的落账顺序无保证，真语义是「版本集合连续无重复无空洞」。

### 面板保存不再驱动熔断（skipBreaker）：熔断是给模型执笔流程的闸

上面「熔断一条不让」的边界经外部审查复核后收窄：熔断防的是「模型无意识循环硬压」，
而面板保存是人有意识的编辑行为，其解锁条件（聊天里 `novel_outline approve`）对人工编辑
不可达也无意义（面板本就不要求细纲批准），force 又顶不开熔断——连点 3 次保存就被锁死
且无自救路径。`runChapterGates` 新增 `skipBreaker`（默认 false，模型/批量路径行为一字
不变）：面板路径不推进驳回计数、不受 tripped 拦截；审计行照记（`by:user`，痕迹不丢）。
用例 `test/panel-breaker.test.mjs` 双向钉住：面板三连拦计数零推进且第 4 次仍是机审文案；
默认路径 3 驳后第 4 次照常熔断（真机 audit.jsonl 实证序列同构）。

## v0.17.1 (2026-10-13)

- **英文版 README 入包**：`files` 白名单加 `README.en.md`——0.17.0 起仓库有两份 README
  （中文 / English 互链），npm 包此前只带中文版。
- **界面截图更新**：dark / real 两套共 12 张面板实渲染截图重新生成（`preview-ui.mjs`
  同步微调）；README「界面一览」引用的就是这套图。

## v0.17.0 (2026-10-13)


### 摘录路线修通：检索输出被宿主整次拒收 + 衔接被预算饿死（真机写章会话实录）

真机跑了一发完整写章会话（`scripts/real-turn-test.sh`，模型 `arkcoding/ark-code-latest`，
101 章真书的副本），**38 步跑完仍未落盘**、峰值上下文 **189,025 tokens**、单次 completion
冲到 22,824、
**宿主 read/grep/glob 18 次**、**工具被宿主拒收 2 次**，最终一章没落盘——discussion #3
的故障形状被原样复刻。顺着这次实录挖出两个断点，都在「用摘录代替整章 read」这条路上：

- **`novel_search query` 一调就被拒**：未打标块的 `tags` 归一成 `null`，而工具层
  `{ ...h, ...(h.tags === null ? {} : { tags: h.tags }) }` 里那个 spread 把 `tags: null`
  原样带了出去 → 宿主 lossless 校验判 `"value.hits[0].tags" must be a string` 并**整次调用
  拒收**。修法：`hits` 逐条只投影 schema 声明过的字段，`tags` 非空 string 才带键；顺带修
  `mode` 谎报 hybrid（`null` 曾被算成「有标签」）。
- 把它钉住的用例（宿主**真校验器**过一遍带命中的 query 输出）又炸出同族第二颗：
  bm25 的极小负分 `toFixed(3)` 得到 **`-0`**，宿主按 JSON 规范判
  `"must be a finite JSON number"` 同样整次拒收。这颗特别隐蔽——`String(-0)` 是 `"0"`、
  `Number.isFinite(-0)` 是 `true`，第一轮诊断字段看着完全正常，是拿真校验器逐个喂
  `0 / -0 / NaN / ±Infinity` 才定位的。修法：铸造点 `finiteOr` 统一收敛（非有限记 0、
  `-0` 归一为 `0`），非有限的命中比例不进结果。
- **衔接三块被预算整块饿死**（同一发会话的第二推力）：101 章书在默认 `contextBudgetChars=6000`
  下，7 张人物卡 + 7 张语言基因卡 + 12 条世界书吃掉 room 只剩 ≈113 字，简报当面写着
  「因预算丢弃：上一章结尾、原著锚段、全书大纲」——模型看不到上一章结尾，只能自己去
  grep/read 整章捞前文（18 次退路、上下文从 1.7 万一路爬到 18 万）。
  修法给「衔接」划**保留额** `min(1500, budget/3)`：随书规模线性增长的弹性区块
  （人物卡 / 语言基因卡 / 术语表 / 世界书 / 原著锚段）封顶在 `budget - 保留额`，装不下
  如实进 `dropped`；固定需求的衔接组（上一章结尾 + 摘要窗口 + 全书大纲）用得到保留额。
  **默认预算没动**。真书第 102 章实测：修前 摘要只剩 1 行、上一章结尾/锚段/大纲全丢 →
  修后 上一章结尾 600 字 + 摘要三行（第99/100/101章）在场，被裁的是 10 条世界书
  （可用 `novel_worldbook list` / 契约白名单再得，而上一章结尾没有别的获取路径）。
  旧的单线优先级注释随之改成两层分配（硬需求 / 弹性 / 衔接），免得下个改代码的人按旧序理解。
- 用例：`logic`「衔接保留额」复刻真机形状（断言衔接两件套不得进 `dropped`、细纲与账本
  不受保留额影响、总占用不得越过预算）；`smoke`「检索命中的输出必须过宿主真校验器」。
  两条都做了红绿：回退 5 处弹性封顶 → 保留额用例红（"上一章结尾必须在场"）；去掉 `-0`
  归一 → 校验器用例红（"must be a finite JSON number"）；还原全绿。测试 420。
- **修后对照实测**（同一脚本、同一本书的副本、同一模型，三处修复合入后重跑）：

  | | 修前 | 修后 |
  |---|---|---|
  | 步数 | 38（跑完未落盘） | 16 |
  | 峰值上下文 | 189,025 | **87,069（−54%）** |
  | 宿主 read/grep/glob | 18 | **0** |
  | 工具被宿主拒收 | 2 | **0** |
  | 检索调用 | 断在拒收上 | 11 次全部返回 |

（峰值口径：cacheReadTokens + inputTokens，不含 completion 输出。）
  | 第 102 章 | **未落盘** | **v1 落盘 2,499 字** |

  行为轨迹变化才是重点：修前检索一拒收就改用 `grep "冬至"` 命中 95 处、再 read 整章；
  修后序列是 `skill → project → briefing → search ×11 → outline/scene → write_chapter`
  ——摘录路线真的走通了。落盘过程中门禁按设计拦了两次（机审 1,960<2,000 带定向补字配额、
  细纲禁项「添灯的那位」），第三次通过，回执同时打出
  `检索索引已续建：第102章 8 块（全库 102 章 / 742 块）`（自动续索引的真机实锤）。
  遗留观察：峰值上下文 8.7 万仍不算小（11 次检索回执 + 会话历史单调累积），
  那是「换会话/交接」那条机制管的维度，与本轮三处修复正交；单次 completion 峰值
  25,692 未再触发截断（`reason=completed`），进一步支持「暂不做分段写章」的判断。
- 附带收获：这发会话第一步就自己调了 `skill(novel)`（2,627 字进上下文），说明技能按需加载
  在真实写章链上确实发生——之前担心的「纪律到不了首回合」在这条路径上不成立；但保留额
  与常驻第 21 条仍然是必要的，因为简报本身要等 `novel_briefing` 返回。

### 缺点收口：数值铸造统一 / 衔接找回指令 / 真机门禁（复核轮）

- **修实例 → 修类**：-0/NaN 同族雷在真机咬过三处、三处各自为战（style `normalizeZero`、retrieval `finiteOr`、library `round` 半守卫）。统一收编进 `lib/json-numbers.js`：铸造点全走 `finiteOr`（非有限收 0、`Object.is` 归一 -0），新增 `jsonSafeIssues` 递归扫「待输出对象」的 JSON 安全性（NaN/±Infinity/-0/undefined 全抓、带路径）。退化输入断言进 logic（空文本 style/library 指标）、library analyze 数值输出过宿主真校验器（smoke）。诚实注：audit 的 jaccard 复核时发现上游本有双空守卫——audit 的收编是统一化，不是救火。
- **丢弃给路**：衔接两件套被预算挤掉时，contextpack 生成 `recoveryNotes`（novel_search 摘录 / read 尾部 ~40 行，点名整章 read 是禁路），briefing 走 warnings 注入——不占包预算。修前模型对「因预算丢弃」的反应恰是去 read 整章；坦白要带恢复路径，才不会反过来变成逼模型自救的信号。红绿：去掉 recoveryNotes 红、还原绿。
- **真机门禁**：`read-turn-usage.mjs` 加 `--events` + `--assert` 模式（步数 >0、峰值上下文 ≤120k、退路读取 =0、宿主拒收 =0，越线 exit 1），real-turn-test.sh 的内联分析器收编为脚本调用。红绿用真实事件流：修前流 exit 1（三门槛齐爆）、修后流 exit 0（87,069 与上表逐位一致）。阈值不许失败后改数字硬压，要改连同理由写注释。
- 测试 420 → 422（新增「数值铸造统一」「衔接找回指令」两条 logic 用例 + smoke 校验器扩 library analyze 路径），realboot 36/36。



### 熔断闭环收紧：不认 force、解除须真实改动、全程留痕

两本真机连载书（24 章完结本、102 章连载本）的审计轨迹还原出同一类字数循环：模型对中文
字数无感（102 章本 257 次驳回、其中 134 次字数驳回，558–1998 字），细纲太薄时**结构上
写不到下限**（4 个必写场景 ≈ 容量上限 1920 < 2000，怎么重写都不过），于是要么用 force
硬压（24 章本 breaker_forced ×4——但 force 放不了机审字数线，breaker_forced 后同一秒
仍被机审拒绝，只能无限 hammer），要么每 3 次驳回就用「outline 微调 → approve →
scene/save」三连把熔断清零续命（其中一章 18 分钟 6 轮 12 驳；全书 scene/save 161 次 >
102 章）。三刀堵死：

- **熔断不再被 `force` 放行**：单章路径 `chapter-commit.js` 与批量路径 `batch-draft.js`
  此前都允许 `force:true` 静默绕过「同章连续驳回 ≥3 次」熔断。现改为 `force` 只 override
  内容判定（细纲门禁 / 内容门禁 / 细纲禁项），不放开熔断；tripped 后 force 照样拒绝，
  拒绝发生在计数递增之前、不写盘。`circuit-breaker.js` 注释与 `breakerState` 文案同步。
- **approve 解除通道带细纲内容 sha1 指纹**（`approvals.outlinePrints`，按章存）：与上次
  approve 相同＝零改动重批，**不清零**并返回警告；**首次批准（无批准记录）同样不清零**——
  否则「存一版细纲 → 熔断后补一次 approve」就是一次免费解锁（本批自测抓出后收紧）。
  真改 → 清零，若此前已熔断写专项审计行 `breaker/released_via_outline_approve`。
- **scene save 对比 `contractFingerprint`**（scene-contract.js 新纯函数，只含语义字段、
  不含 updatedAt——原 contractDigest 是人读摘要，只含人数当不了变化检测键）：原样重存
  **不清零**，tripped 时返回「熔断未解除」警告并写 `breaker/unchanged_save`；真改清零
  同样留痕（`breaker/released_via_scene_save`）。
- **写前自查字数口径对齐**：`novel_write_chapter` 描述新增自查提示（按插件字数口径——
  先剥 markdown 强调标记、再去空白）；CHAR_MARGIN（100 字）提为 audit.js 导出常量，
  自查线统一「≥ min+100 再提交」——机审退稿线是 min 且要求留余量，卡整线值仍会被口径
  抖动打回（贴线正是循环的主要形态：全书 80/102 章成稿 <2200 字，median 2100）；
  `force` 参数描述收窄为「不放开熔断」。
- **测试**：commitChapter 级「tripped + force → throw、不递增、不写盘」；工具级
  「approve/scene 改了才清零、原样重存带警告」；批量 planDraftBatch 用例改为 force 放行
  未批准细纲、但不放行熔断。

### 细纲契约段书级策略（strict / warn）+ backfill 粗纲补契约段

容量门禁与契约指标（场景覆盖率 / 禁项拒绝）全部「有「## 本章必写场景」段才算」——
无段细纲此前是**静默旁路**（真机某章 972 字细纲、4 个场景，结构性写不到 2000 还能被
批准）。按书级 `novel.outlineContract` 分档落地：

- **strict（新账新办法）**：init / import（`defaultNovel`）与 clone 新建的书默认
  strict——save_chapter 缺段（`outline/rejected_contract` reason=no_section）或有段
  无条目（reason=unparsed）直接驳回并教格式（「- 标题：描述」，每场景 3–5 拍）。
- **warn（旧书软着陆）**：存量书无字段缺省 warn——不拒稿，但返回 note 指路 +
  审计留痕（`outline/no_contract_section` / `outline/contract_unparsed`）；旁路从
  静默变显式，留痕出现率决定存量书要不要手动升 strict。
- **解析口径单源**：gate-metrics 新导出纯函数 `outlineContractCheck`（与
  sceneCapacityShortfall 共用同一份 sectionOf/parseScenes，判定不许漂移）。
- **backfill 补契约段**：roughOutline 生成的回补粗纲带「## 本章必写场景」段
  （开场复现 / 章末收束两条确定性场景，不编造中间拍）——导入书一并纳入容量门禁
  与覆盖率指标。
- **防线分工**：散文行会被 parseScenes 当成 1 个场景（标题=整行），真机配置
  （min 2000）下先被容量门禁接住（480 < 2000，「拆到 N 个」驳回）；strict 的
  格式教学兜住空段与低下限情形。
- **测试**：strict 两分支 + warn 留痕 + 克隆书 strict 戳 + roughOutline 契约段断言；
  smoke 加 `setOutlineContract` helper，与细纲格式无关的用例打 warn 保持原意图。

### 面板样式审查修复

- **`--nf-elev-*` 阴影变量改注面板根**：原写在 `:where(:root, body)` 上，被「每条规则
  必须以面板根限定」护栏测试拦下；改注 `[data-dsh-novel-forge-panel]` 后，深色补丁
  （`:where(body[data-ds-dark-theme])` 权重 0）与浅色同特异性、靠后声明压过浅色，
  面板内所有 `var()` 引用照常继承，styles.js 回退值继续兜底。
- **prefers-reduced-motion 补 `[data-nf-tap]:hover`**：悬停抬升 `translateY(-1px)`
  此前不在 `transform:none` 清单里，与该行「位移与过渡都停」的注释自相矛盾；现已归零。
- **死代码清理**：`accentHover` / `onFill` / `sectionTitleStyle` 三个无引用导出删除
  （Section 的区块标题样式以 ui.js 内联为准）；`card` 的「不用阴影」旧注释随层级化
  改版一并更正。
- **前景金改双档主题变量 `--nf-accent`**：单一 `#e0890f` 作文字/焦点环在浅色下仅
  ≈2.7:1（<3:1），深色 ≈6.4:1——金是中亮度色，单一值无法两主题同时过 4.5。
  css.js 在面板根注入浅 `#a86200`（≈4.7:1）/ 深 `#f3a62a`（≈8.6:1），
  `color.accent` 指向 `var(--nf-accent, #a86200)`：文字、chip、accent 按钮、
  焦点环、品牌块一次全修，主题切换实时生效（var 随 `body[data-ds-dark-theme]` 换档）。
- **主按钮改深字压金**：白字压金渐变在两主题都 2.3–2.7:1（<4.5:1）；新增
  `color.onGold = #231303`，rest/hover/active 三态 5.1–8.8:1 全过，亮金渐变不动；
  头部品牌图标块同改 `onGold`（深色主题下白图标压亮金仅 ≈2:1）。

### 全书监控八项发现修复（导入旧书回归）

- **细纲禁项范围限定括号不再误杀整章**（监控最重发现，真机某章实证）：排除行里
  「（只推进到"X"）（仅限"Y"）（止于"Z"）」类括号是禁令推进程度的说明，不是禁词本体——
  在括号跨度内独立提取引号词归条件型（主循环的括号开启符会吞掉紧随的开引号，须剥到
  首个引号再匹配）。放宽方向是「少禁」：漏禁缓降、误禁拦章。
- **对话占比计入直引号**（导入书全书四章实证）：`dialogueRatio` 正则补 U+0022——插件自己
  的写作规矩就是对话用直引号，226 个直引号四章占比全 0%，连带番茄平台审查判失败。
- **mapWithConcurrency 自兜异常**：fn 同步/异步抛错以 Error 实例占位收进 results，不再
  依赖调用方自带 try/catch（导出函数裸调一个抛错 fn 就炸整批的坑）；调用点映射回章级
  失败形状，测试补同步抛错回归。
- **章末钩子检测补两类强钩子**：倒计时式宣告与打断式收尾——陈述句收口的教科书
  cliffhanger，旧四模式全检不出。模式取窄：只认明确的倒计时/打断措辞，宽松化会制造
  假阳性驱动无谓改稿。
- **场景契约跨章提醒**：novel_outline save_chapter 结果带出上一章契约的禁项与隐藏人物
  （延续则重申、解除则放行——把「靠模型自觉记」变成显式决定）；无上一章契约时不打扰。
- **字数目标 85% 硬约束**：写前简报加「不足目标 85% 不许收尾」（真机 v1 稿 2150/2268 字
  对目标 3000 全靠润色补齐）；机审下限只是拒绝线。
- **要素警告措辞降误导**：「字面未逐字出现（同义改写不算缺失，请人工判断）」——字面
  includes 匹配下同义改写必然误报，语义匹配纯本地做不到，先如实说明。
- **人称混用改判「段落叙述声音」**：引语里的他/她是角色在说话（剥对话跨度）；叙述句首的
  「他」也常是第一人称笔法（「。他把钥匙放到桌上」是转述，甚至可有整段无「我」的交代段）
  ——真机回归抓出按章数代词必误报。改为「连续 ≥3 段句首他/她且段内无我」与第一人称
  并存才算混用；多视角真混用（整段成串）仍报。

### 源码注释匿名化（发布卫生）

`lib/` 与 `src/client/` 是随 npm 发布的面，其中 16 处实证注释带真机书名（书名 / 书内
人名 / 书内原句例证 / 面板克隆占位符示例）。全部替换为中性指称（真机连载本 / 真机
完结本 / 真机导入书 / 真机某章），机制性数字与教训原样保留；`lib/client.js` 是
esbuild 产物，随源码改动重建。`scripts/` 与 `test/` 不在 npm `files` 内未动——那里的
书名是运行参数与测试数据，改动会破坏可跑性。

## v0.16.3 (2026-10-12)

### 输出预算纪律（回应 discussion #3：200 章后「输出token超过预算」）

- SKILL.md 首要原则新增第 7 条（工具回合零前置说明：调 `novel_write_chapter` 的回合开头
  直接调工具，前置说明放落盘后的收尾汇报）与第 8 条（回溯用摘录不整章读：优先
  `novel_search` 摘录 / `novel_ledger status_at`、`timeline` 时点值）。第 8 条同时注明检索词的
  参数名是 `q`（`action:query`）——文案口径与工具契约对齐，别让模型照着文案去传 `query:`。
- 写前简报新增注入段「输出预算纪律（回合怎么开）」——与收尾纪律同族：回合开头的大段
  前置说明 + 回合内整章 read 前文，都会挤占写章工具调用的输出预算（真机实测：97 章新会话
  第一回合 in_tok 13 万级触发 compaction；前置说明 + 正文挤爆预算 = 工具调用中途截断）。

### 前文可见性：摘要窗口修到根上（上面那条禁令的落脚点）

- **旧实现只注入第 1–10 章**：`lib/contextpack.js` 的 `summaries.slice(0, 10)` 取的是升序数组
  的**前**十条——写第 200 章时第 11–199 章在模型视野里全部不存在，能看到的只有上一章结尾 600 字。
  它为了衔接只能自己整章 `read` 前文，in_tok 因此堆到 13 万级，反过来又压小单回合输出预算。
  所以「回溯用摘录不整章读」在窗口修好之前，要的是模型放弃它唯一的自救手段——按本项目
  「代码强制 > 提示词自觉」的主线，那是提示词补丁，不是修复。
- **现在给「开篇 + 最近」窗口**（开篇留 2 章保人物第一印象，其余 8 个名额给最近章节），区块名
  显式标注非全量，中间留一句 `novel_search` 找回通道。200 章书实测第 200 章可见章号
  `1,2,192,193,…,199`（旧：`1..10`，即 189 个近期章全部不可见）。
- **合成一个区块**：旧的逐行 push 让同一个 `<<前文章节摘要>>` header 重复 10 遍（实测区块数
  10 → 1，同名 header 开销 100 字 → 21 字），更糟的是预算耗尽时按 push 顺序丢掉的是**数组尾部**
  ——恰好是最接近当前的那几章，裁剪方向整个是反的。现在单条超长就地截断（不整行挤掉），整块
  装不下时从**头部**淘汰（开篇先让位，最近一章绝不许掉队），完全放不下才如实进 `dropped`。

### 受众门控：会话纪律段不再进批量起草的提示词

- 「待批提案／交付纪律／输出预算纪律」三段管的是「会话执笔人怎么发起调用、怎么收尾、怎么报数」。
  `buildBriefing` 新增 `audience`（默认 `'session'`；值写错 fail-fast 报错，不许静默退化成
  「没有纪律段」），D2 批量起草传 `'batch'`——那里的读者是旁路引擎的单次补全（`draftSystem`
  第 1 条硬要求就是「只输出正文，不要任何解释/前言」），手上没有任何 `novel_*` 工具可调用，
  也不向用户汇报。把「每一步直接发起调用」拼进它的提示词，等于指挥它去调它调不到的工具
  （诱导假工具调用），还每章白烧输入（200 章书实测三段共 620 字/章，一批 40 章就是 2.5 万字）。
  上下文包仍只有一个实现，变的只是给谁看；写作规格（「本章字数目标」）与上下文告警两条路径
  一致，未受影响（实测两边 `warnings` 完全相同）。
- 「输出预算纪律」段补上它的前提：前文由简报给够（上一章结尾 + 开篇与最近摘要），不再是一句
  没有出路的禁令。
- 测试 413（较 0.16.2 的 408 +5：本轮 4 条 + 「输出预算纪律」段自身那条同轮落地）。本轮四条：
  摘要窗口与淘汰方向（logic）、受众门控（logic）、批量起草提示词真跑抓取
  （batch5——断言**实际发给引擎的 prompt** 里没有那三段、仍有字数目标，不 grep 源码）、
  SKILL.md 第 7/8 条常驻断言（smoke）。四条都做过红绿双向验证：换回 HEAD 的旧实现必须红
  （旧 contextpack → 「实得 10 个区块」「最近一章优先保住」红；旧 batch-draft → 「待批提案不该
  出现在起草提示词」红；旧 briefing → 「必须带输出预算纪律段」红；旧 SKILL.md → 第 7/8 条断言红），
  换回新版全绿。

### 回合预算纪律常驻（投放面收口）

- 上面两条纪律原先只写在 SKILL.md 与写前简报里，**两者都晚于病发时刻**：宿主的技能是按需加载的
  （`dsh-tool-skill` 常驻只有目录里的 name+description，正文要模型自己调 `skill` 工具才拿到），
  简报更要等 `novel_briefing` 返回才进上下文——而「回合开头先写一大段前置说明」发生在第一个工具
  调用之前。管得住那个时刻的只有常驻段。
- `lib/index.js` 纪律清单新增**第 21 条**（约 130 字；实测常驻段 3253 字 → +4%）：产出长文本的
  回合开头直接发起第一个 `novel_*` 调用、解释留到落盘后的汇报里；回溯用 `novel_search` 摘录与
  `novel_ledger` 时点值，不整章 read 正文。
- **不往 preset persona 复制**：persona 要走 `preset-deploy` 版本升级、只覆盖用预设的会话，
  与常驻段收益完全重叠。`smoke`「回合预算纪律常驻」钉住这条判断（含"必须是清单第 21 条"，
  编号断号=被覆盖过）。

### 索引新鲜度变成代码强制（让「用摘录代替整章读」真的做得到）

- 规则 8 让模型别整章 read，前提是**索引跟得上**：索引缺章 → 召不回 → 只能回去捞正文。
  真书量化：某 101 章完结本全书正文 22.0 万字，按中文约 1.6 字/token 折 ≈ **13.8 万
  token**——与故障记录「in_tok 13 万级」同量级；而插件侧只喂了 6,751 字简报。整章捞正文才是
  那 13 万的来源，索引跟不上就是它的诱因。
- **写章落盘后自动增量续建本章**（`lib/chapter-commit.js` 提交链，会话与批量起草共用同一链）。
  建索引逻辑收口成 `indexStore.indexChapters` **单一实现**，`novel_search build` 改为调它——
  原先长在工具 execute 里，想在提交链复用就得抄第二份，抄出来必然在「标签保留 / 越书路径收口 /
  全量时清删章幽灵块」三条保护上漂移。`indexChapters({ full })`：只有全量才清删章的旧块，
  单章增量不碰别章（用例专门钉了这条）。
- **回执必须可见**：`novel_write_chapter` 新增 `indexNote`（同步 output schema 与 render），
  成功给「已续建 N 块 / 全库 M 章 / K 块」，降级给原因并指路 build；建索引失败**绝不**把成稿
  报成失败（与 saved 审计同一档——假阴性会诱导调用方重试，批量路径重试出的是重复版本）。
- **简报点名落后多少章**：`novel_briefing` 只读探测索引（`create:false`——简报绝不凭空造库），
  索引不可用或缺章时告警「先 build 再摘录，别整章 read」；build 之后告警自愈。
- 用例（`smoke`）：「索引自动续建」一条覆盖 落盘后不 build 即可召回 → 删库后简报必须点名 →
  build 后自愈 → 增量不误伤别章；红绿双向：停用自动续建 → 「落盘后必须自动续建索引」红；
  改掉第 21 条标题 → 常驻断言红。⚠️ 第一版把降级分支写成「凡未更新就 return」，会把
  「自动续建根本没跑」吞成假绿——已收紧成只允许运行时能力（无 sqlite / 后端不给真实路径）
  这一种早退。全量 418 绿（0.16.2 的 408 → +10，含 headless 修复批的回归钉）。

### 暂不做：分段写章 / 草稿缓冲（记录依据，不是遗忘）

- 曾考虑给 `novel_write_chapter` 加分段 append，治「一次输出整章被截断 = 整回合白跑」。
  实测数据不支持这个前提：插件侧输入约 6k token（简报 6,751 字 + 常驻段 3,253 字），
  一章 2,180 字 ≈ 1.4k token 输出，远没贴到单回合输出上限——截断是**输入侧**把预算挤掉的
  结果，而输入侧已由摘要窗口 + 受众门控 + 索引自动续建三件事修掉。
- 分段要连带动四件事：熔断计数语义（半章算不算一次驳回）、悬挂草稿寿命管理、面板要显示
  「未完成」态、批量路径不得读到半章。复杂度远大于当前收益。
- 判据留一次真机复测：账户额度恢复后跑一次写章回合量 in_tok；若已降下来却仍报输出超限，
  那时再上缓冲。

### headless 不再整块挂起：宿主真名服务改走数组 inject 独立 fiber（真机事故回归）

- 事故：`dsh --profile headless` 上 `dsh-novel-forge: pending (waiting for services:
  sessionController, workspaceController)` + `warning: 1 entry did not activate`——主插件顶层
  `inject` 硬声明了这两个宿主真名，headless 没有它们，cordis 数组 inject 又没有可选语义，
  于是 **20 个 novel_* 工具 + 面板在 headless 上整块消失**。讽刺的是
  `probeSessionCapabilities` 早就写了「逐名 try/catch、拒绝式代理安全降级」的可选链，
  却被 mount 挡在门外，那段降级代码永远轮不到执行。与 `'skills'` 同一课
  （skill-registration.js：数组 inject 无可选语义，要用独立 fiber，父插件不受牵连）。
- 修法：真名从顶层 `inject` 撤下（顶层只留确实存在于各 profile 的服务），改在 `apply()` 里
  用数组形式 `ctx.inject([name], cb)` **各建一条独立 fiber**（不是一条数组要两个名字——
  宿主哪天只给其一，能力也应点亮一半，轮换面本来就是两段各自尽力），回调把服务写进 holder，
  REST 逐请求重读。`ctx.inject` 的返回值（Disposable）**不得接住**——接了迟早被 `using`，
  插件退出时连 fiber 一起释放（测试里把这条路堵死）。
- 探测契约同步收紧：`probeSessionCapabilities` 只认 fiber 交付的**真名**服务，不再按候选名
  peek——唯一的例外候选 `'sessions'` 是浏览器面假体（有 create 但建的是内存 session-N，
  宿主面板可见、磁盘无目录、工具拿不到工作区），旧实现会把它当能力「成功」开出不可用会话。
  holder 声明失败（`probeError`）与拒绝式代理都进 `detail` 留痕，探测路径上一个字符都不许
  未加防护地直读（68cb694 的同类事故）。R-轮换-0 用例按新契约重写，假体陷阱钉死。
- 真机证据（修前 → 修后）：`1 entry did not activate` + `pending (waiting for services: …)`
  两条全消失，session 事件正常、进程走到模型调用；realboot 36/36 全绿（新增 MOUNT 层：S11a/S11b 计分、S11c 留痕），
  realboot 新增 **MOUNT 层**（S11a 前置：headless 真的完成启动，防「没有 pending 行」空判 /
  S11b 本插件不再 pending / S11c 模型侧 402 留痕——余额故障与本层无关）。

### 摘录路线修通：检索输出被宿主整次拒收 + 衔接被预算饿死（真机写章会话实录）

真机跑了一发完整写章会话（`scripts/real-turn-test.sh`，模型 `arkcoding/ark-code-latest`，
101 章真书的副本），**38 步跑完仍未落盘**、峰值上下文 **189,025 tokens**、单次 completion
冲到 22,824、
**宿主 read/grep/glob 18 次**、**工具被宿主拒收 2 次**，最终一章没落盘——discussion #3
的故障形状被原样复刻。顺着这次实录挖出两个断点，都在「用摘录代替整章 read」这条路上：

- **`novel_search query` 一调就被拒**：未打标块的 `tags` 归一成 `null`，而工具层
  `{ ...h, ...(h.tags === null ? {} : { tags: h.tags }) }` 里那个 spread 把 `tags: null`
  原样带了出去 → 宿主 lossless 校验判 `"value.hits[0].tags" must be a string` 并**整次调用
  拒收**。修法：`hits` 逐条只投影 schema 声明过的字段，`tags` 非空 string 才带键；顺带修
  `mode` 谎报 hybrid（`null` 曾被算成「有标签」）。
- 把它钉住的用例（宿主**真校验器**过一遍带命中的 query 输出）又炸出同族第二颗：
  bm25 的极小负分 `toFixed(3)` 得到 **`-0`**，宿主按 JSON 规范判
  `"must be a finite JSON number"` 同样整次拒收。这颗特别隐蔽——`String(-0)` 是 `"0"`、
  `Number.isFinite(-0)` 是 `true`，第一轮诊断字段看着完全正常，是拿真校验器逐个喂
  `0 / -0 / NaN / ±Infinity` 才定位的。修法：铸造点 `finiteOr` 统一收敛（非有限记 0、
  `-0` 归一为 `0`），非有限的命中比例不进结果。
- **衔接三块被预算整块饿死**（同一发会话的第二推力）：101 章书在默认 `contextBudgetChars=6000`
  下，7 张人物卡 + 7 张语言基因卡 + 12 条世界书吃掉 room 只剩 ≈113 字，简报当面写着
  「因预算丢弃：上一章结尾、原著锚段、全书大纲」——模型看不到上一章结尾，只能自己去
  grep/read 整章捞前文（18 次退路、上下文从 1.7 万一路爬到 18 万）。
  修法给「衔接」划**保留额** `min(1500, budget/3)`：随书规模线性增长的弹性区块
  （人物卡 / 语言基因卡 / 术语表 / 世界书 / 原著锚段）封顶在 `budget - 保留额`，装不下
  如实进 `dropped`；固定需求的衔接组（上一章结尾 + 摘要窗口 + 全书大纲）用得到保留额。
  **默认预算没动**。真书第 102 章实测：修前 摘要只剩 1 行、上一章结尾/锚段/大纲全丢 →
  修后 上一章结尾 600 字 + 摘要三行（第99/100/101章）在场，被裁的是 10 条世界书
  （可用 `novel_worldbook list` / 契约白名单再得，而上一章结尾没有别的获取路径）。
  旧的单线优先级注释随之改成两层分配（硬需求 / 弹性 / 衔接），免得下个改代码的人按旧序理解。
- 用例：`logic`「衔接保留额」复刻真机形状（断言衔接两件套不得进 `dropped`、细纲与账本
  不受保留额影响、总占用不得越过预算）；`smoke`「检索命中的输出必须过宿主真校验器」。
  两条都做了红绿：回退 5 处弹性封顶 → 保留额用例红（"上一章结尾必须在场"）；去掉 `-0`
  归一 → 校验器用例红（"must be a finite JSON number"）；还原全绿。测试 420。
- **修后对照实测**（同一脚本、同一本书的副本、同一模型，三处修复合入后重跑）：

  | | 修前 | 修后 |
  |---|---|---|
  | 步数 | 38（跑完未落盘） | 16 |
  | 峰值上下文 | 189,025 | **87,069（−54%）** |
  | 宿主 read/grep/glob | 18 | **0** |
  | 工具被宿主拒收 | 2 | **0** |
  | 检索调用 | 断在拒收上 | 11 次全部返回 |
  | 第 102 章 | **未落盘** | **v1 落盘 2,499 字** |

  行为轨迹变化才是重点：修前检索一拒收就改用 `grep "冬至"` 命中 95 处、再 read 整章；
  修后序列是 `skill → project → briefing → search ×11 → outline/scene → write_chapter`
  ——摘录路线真的走通了。落盘过程中门禁按设计拦了两次（机审 1,960<2,000 带定向补字配额、
  细纲禁项「添灯的那位」），第三次通过，回执同时打出
  `检索索引已续建：第102章 8 块（全库 102 章 / 742 块）`（自动续索引的真机实锤）。
  遗留观察：峰值上下文 8.7 万仍不算小（11 次检索回执 + 会话历史单调累积），
  那是「换会话/交接」那条机制管的维度，与本轮三处修复正交；单次 completion 峰值
  25,692 未再触发截断（`reason=completed`），进一步支持「暂不做分段写章」的判断。
- 附带收获：这发会话第一步就自己调了 `skill(novel)`（2,627 字进上下文），说明技能按需加载
  在真实写章链上确实发生——之前担心的「纪律到不了首回合」在这条路径上不成立；但保留额
  与常驻第 21 条仍然是必要的，因为简报本身要等 `novel_briefing` 返回。

## 0.16.2 (2026-10-10)

### 会话交接全自动 + 真机验证（realboot S10 新增 11 项检查，29/29 全绿）

- **交接摘要直发**（用户钦定）：创建新会话后由服务端直接把交接摘要 prompt 进新会话
  （mode:queue，点开即写，不手动粘贴）；prompt 失败不吞创建结果（promptError 如实上报，
  剪贴板兜底只在未 prompt 时生效）。
- **延迟归档**（用户钦定）：`deferArchive` 跳过 create 内联归档——客户端先跳进新会话，
  再调新增的 `POST /session/archive` 补归档，躲开「归档当前会话 → 宿主 clearMain 踢回
  首页」的竞态（真机实证）；归档路由带 fence/形状校验/全局限流，宿主无 archive 能力 501 指路手动。
- **自动认领书**：create 带 book 时把新会话 id 写进 novel.json.sessions（locateBook→
  updateJson→addBookSession，幂等）——跳进新会话面板立即见书，不用先跑一次工具触发补录。
- **跳转前先渲染反馈**：openSession 之前先 notify 落 notice（面板随即卸载，同步赋值
  来不及渲染，真机 2026-10-09 表现为「点了没反应」）。
- **prompt 直发真机修复**：宿主 typert host 面 `prompt(request, signal)` 的 **signal 是必传
  第二参**（真机实现裸调 `signal.throwIfAborted()`，不传 = TypeError "reading
  'throwIfAborted'"，交接摘要直发整条链静默降级成复制粘贴）。补 `new AbortController().signal`
  （queue-and-forget 无取消方，给常驻未 abort 信号）；单测桩按 AGENTS「替身镜像真机」补第二参
  并断言 `instanceof AbortSignal && !aborted`。
- realboot web 层新增 S10 会话交接全自动链：create+handoff+deferArchive 真容器端到端
  （命名 书名-YYMMDD / prompted / claimed / accounted / novel.json 磁盘对账 / 新会话面板立即
  见书 / /session/archive 真机归档成功 / 归档不存在会话不假成功）。

## 0.16.1 (2026-10-09)

### 会话交接真机修复（2026-10-09，403 用例全绿）

- **命名（用户钦定）**：新会话 `《书名》续写` → **`书名-YYMMDD`**（如 `samplebook-261009`）——归属一眼可见，按名称排序即按时间排序。
- **创建时直接带 `workspaceId`**（types.d.ts 实证 `SessionCreateRequest = { workspaceId?, cwd?, … }`）：注册表命中工作区时，首个 create 形状为 `{ workspaceId, cwd }`——**宿主在创建时就完成工作区登记**，绕开事后 attachSession 的两个真机失败点（新会话 header cwd 校验、持久化滞后）。此前「创建后插到原会话旁边」的链路依赖创建后的 cwd 正确，任何一环失败侧栏就看不见。
- **建完直接跳进新会话**（用户钦定：点完按钮就落在新会话里，不落在「选择工作区」空白页）：经宿主 `uiWorkspace.openSession` 导航；导航失败不吞创建成功的事实（notice 仍给出会话名，可手动打开）。
- **登记终验**：响应新增 `accounted`（重读注册表确认新会话真的进了某个工作区分组——GUI 侧栏可见的唯一判据）与 `title`（真实命名结果）；面板通知直接显示会话名，`accounted:false` 时明示「侧栏暂未登记」。
- 新增 R-建会话-11（workspaceId 优先形状）+ 命名断言更新。

### 0.16.0 复核跟进

- MCP 通道补 `readBytes`（createNodeFsBackend）：docx 导入此前在 MCP 直连必炸
  `ctx.fs.readBytes is not a function`（宿主 dsh-fs 有该原语、node 后端漏了）。与宿主
  契约同语义：maxBytes 必传、先 stat 校大小超限 FS_TOO_LARGE 拒绝而非截断。补两条
  用例：字节逐个一致 + 超限拒绝；novel_import .docx 经 MCP 通道 preview 全链。
- docx 数字实体越界码点（`&#x110000;`）原样保留，不再抛 RangeError（负数此前已被
  正则挡住）；合法数字实体（`&#x41;`/`&#66;`）照常还原，有单测钉住。
- 批量 resume 防双跑：检查点 `status === 'running'` 且 startedAt 距今 10 分钟内 →
  409 BATCH_RUNNING（面板按钮按 status !== 'done' 就显示，双跑会对同章各落一版、
  白烧配额）；startedAt 缺失/损坏或超过 10 分钟（web 重启残留）放行。
- 面板 chapterNo 注释校准：'1.5' 已拦，'2e3'（=2000）仍是整数会放行、由服务端 404
  兜底——原注释过claim。

## 0.16.0 (2026-10-09)

### 批量起草断点续跑

- 批量起草全程写检查点 `.novel/batch-checkpoint.json`（机器状态；每章提交/被拦后更新，
  状态 running→done|partial）。REST `draft-batch` 新增 `resume:true`：参数从检查点恢复，
  已落盘章由 planDraftBatch 自动挡掉、只重试未完成的；无检查点 400 NO_CHECKPOINT、
  已完成 409 BATCH_DONE。请求形状校验先于引擎 503（4xx 不被 503 抢答）。
- 面板：书详情携带 batchCheckpoint，批量区出现「继续上次批量（第a–b章，已落N）」按钮
  （partial 时可见）；续跑后 notice 带「断点续跑：」前缀。检查点写失败不阻断批量
  （正确性靠 plan 对已落盘章的自动拦截，重跑同范围天然续跑）。

### novel_import 支持 .docx（Word 稿直接导入）

- `novel_import` 的 `file` 参数接受 `.docx`：经宿主 `ctx.fs.readBytes` 取原始字节（不走
  文本通道，避免二进制解坏），`lib/docx.js` 纯函数抽取——手写 ZIP 读（STORED/DEFLATE、
  拒 zip64，48MB 解压上限防炸弹）+ OOXML 段落解析（Heading1-9/1-9/标题N 样式 → md 标题，
  「第N章」正则兜底；w:t 实体/tab/br 按序保留）。找不到 `word/document.xml`（.doc/改后缀）
  明确报错，不静默半截导入。txt/md 通路不变。

### npm 首发 + 两个拆分回归修复（387 用例全绿）

- **npm 首发占名**：`dsh-novel-forge` 首次发布到 npm（此前仅 GitHub 安装，dshmarket
  "Most installed" 榜按 npm 周下载排名，缺席即永久榜外）。
- **润色/校对 REST 双写修复**（`server-routes/chapters.js`，04e377a 拆分回归）：
  polish/proofread 分支曾 `return runChapterRevision(...)`——该函数经 writeJson/fail
  收口返回 undefined → dispatch 落到 404 二次写响应（ERR_HTTP_HEADERS_SENT），
  真机症状是面板只收到半截错。改为显式 `await …; return true`；R1+ 回归用例
  （带 fence 真进分支收口处）补上 fence:false 抓不住的盲区。
- **engine resume 句柄解包**（`engine.js anchorParent`）：宿主契约是
  `(await agents.resume(...)).agent`（发布句柄 {agent, signal, publish, dispose}），
  此前把句柄当 parent 直传 subagents.start——宿主在 parent.options 处 TypeError。
  现解包 .agent 后再传；batch5 替身改为镜像宿主真机形状（替身镜像自己实现的第三次学费，
  断言原文「物化出的 handle 直接当 parent」一并纠正）。

### 安全审计修复（CodeBuddy 双路审计 2026-10-09，383 用例全绿）

高危：

- **REST 入口 Host/Origin 白名单**（`server-api.js`）：fence header 不是秘密（写死在面板 JS），
  只挡普通跨域；DNS rebinding 下攻击页与 127.0.0.1「同源」可自由带 fence 调全部 API。
  现在 Host 必须是 `localhost/127.0.0.1/[::1]`，Origin 存在时同样校验，畸形 Origin 拒绝。
- **novel.json 路径字段收口**（`store.js containedBookPath`）：`chapterRelPath` 支持 bookId
  收口——必须以书名开头、无空段/./.. 段，不合式按缺文件处理（REST 章节读、诊断、导出、
  repair 五个调用点全部接入）。此前被污染的索引可越出书目录**任意读**（fsio 沙箱只护写）。
  提案 id 同样白名单化（`validProposalId`，alnum/_- 限长 64），list/read/apply 三处接入。
- **批量起草陈旧快照回写**（`chapter-commit.js saveBookMerged`）：批量从计划到提交可达几十
  分钟，整批结束后拿启动快照整体 saveBook 会把并发期间的改名/提案应用/驳回计数**整份抹掉**
  （熔断计数清零）。改为 updateJson 版本重放：在最新文档上只合入本次三类增量（本章
  gateFailures 两条键、真正改写的章节记录、advanceStage 只前进语义重放），驳回路径不碰
  chapters/stage。顺带补 `write_chapter/breaker_forced` 审计（force 绕熔断此前零留痕）。

中危：

- engine 流式 abort 后 pending `next()` 接住 rejection（裸 rejection 在宿主是 fatal）。
- search build 全程 try/finally 关 sqlite 句柄（此前中途抛错即泄漏，annotate 早有此纪律）。
- 客户端跨书竞态三处守卫（applyProposal / runBatch / runRevision）：快照 bookId + 迟到写回
  丢弃 + 表单值发起时快照（M15 重载判断不再被中途改表单带偏）。
- `/session/rotate|create` 全局节流（6 次/分 → 429）+ session id 形状校验；测试经
  `resetSessionRateLimit` 隔离。
- `fail()` 统一路径脱敏：错误消息里家目录→`~`、cwd→`.`（FS_SANDBOX_DENIED 原文带绝对路径）。
- 书库索引 import/delete 改 updateJson 版本重放（并发导入不再互相抹条目）。
- projcache 单文件读取加 24MB 上限：超限跳过该形态（目录态/反推仍在），不再可能数秒冻结
  web 事件循环；跳过事实进扫描根诊断行。
- REST `validBookId` 对齐工具面 `assertBookName`（限长 64、拒前导点）；create 书名超长仍 400
  （R2c 契约），rename title 截 64。

低危：章号输入只收正整数；`setSession` bump 序号作废在途响应；`anchorParent` 重试检查
abort signal；`readJsonBody` 拒绝后不再拼残余 chunk。测试 383 全绿（新增 S-1..S-4 安全
用例 + containedBookPath/validProposalId 单测）。

### 安全审计跟进项（2026-10-09 复核后收尾，与上批同源）

- **工具层读路径全部收口**（跟进项①）：上批只收了面板侧五个读点，`novel_search`
  build/degrade、`novel_style`、`novel_noai_scan`、`novel_audit`（本章+重复窗口）、
  `novel_polish`（analyze/守卫原文/重复窗口）、`novel_diagnose`、`novel_import` 回补、
  `novel_library` 并排分析、`chapter-commit` 重复窗口、`novel_briefing` 锚段样本、
  `novel_project` 一致性体检（stat+正文读，经 `pathsFor` 新增的 `bookName` 随行书名，
  免去五个调用点层层加参）、`novel_export` 全版本拼装共 17 处仍裸读索引里的 `rec.path`
  /`files[].file`。现全部走 `chapterRelPath(rec, book)`/`containedBookPath(book, file)`：
  越书路径按缺章跳过（窗口/导出/体检类）或给可行动错误「越出书目录（先 novel_project
  repair 对账）」（单章类）；`novel_polish` submit 守卫原文读不到直接拒绝提交（空原文
  会让保守守卫形同虚设）；`novel_project repair` 把越书文件按「不可达」进 missing 随
  对账清出索引。新增 smoke 用例：污染索引 + 书外「机密」文件 → 工具拒读、repair 清账、
  机密内容零泄漏。
- **Host 白名单小写归一**（跟进项②）：Host 是 case-insensitive 头，浏览器恒小写但
  本地工具可能大写——先 `toLowerCase()` 再比白名单。S-1 补 `LOCALHOST:3080` 放行断言。
  本机限定的行为变化（LAN IP 访问将 403）已写入 README「已知边界」。
- **驳回计数改增量合入**（跟进项③）：`saveBookMerged` 此前拿快照的 gateFailures
  绝对值覆盖 latest 同章键——并发期间同章被别处驳回的递增会被抹掉。现在捕获提交起点
  计数（prevCount），合入时只加本次递增（`latest + (快照 - prevCount)`）；`:last` 仍
  快照覆盖；成功路径删键归零语义不变；updateJson 版本冲突重放每次从最新 latest 重算，
  不会双记。新增 batch5 两条用例：驳回合入撞冲突重放后计数 = 7（6+1，旧的绝对值覆盖
  会写成 1）、成功合入后并发提案/别章计数存活且越书路径不进重复窗口（内容与正文完全
  相同的越书「上一章」作为金丝雀——读了必被重复率拦下，收口生效才落得了盘）。

- **修复「创建新会话后侧栏不显示」**（真机 2026-10-08）：旧实现对宿主工作区服务调
  `insertSessionBefore({workspaceId, sessionId, ...})` ——**对象参数形状在宿主上根本不存在**
  （宿主 `dsh-workspace` 实证：控制器 `get(workspaceId)` → 每工作区实体，
  `entity.attachSession(sessionId)` 先登记，`entity.insertSessionBefore(sessionId, beforeSessionId)`
  是**位置参数**且只重排已登记会话，未登记直接抛 "the session is not accounted"）。
  旧实现连登记（attach）都没做，插入在真机上从未成功过——测试假探针也按对象形状写，
  等于给错误背书。现改为：get 实体 → attachSession 登记（两种参数形状逐试）→
  位置参数 insertSessionBefore 排位（锚点=原会话），响应补 `attached/attachError`，
  面板通知区分「已插到原会话旁边 / 登记失败（原文可见）/ 宿主未暴露工作区面」三态。
  测试假探针同步改真形状 + 新增 attach 失败可见性用例（cwd 落点不匹配场景）。

- **疲劳横幅一键轮换（服务端能力探测 + 降级）**：新增 `POST /session/rotate { session }`——
  服务端对宿主会话/工作区控制器做**非阻塞属性直读探测**（候选服务名逐请求重读，绝不写进
  inject 清单——cordis inject 未知名会挂死插件加载）：create + archiveSession 全有 → 开新
  会话并归档指定会话（归档可逆、带准入门禁：归档会话恢复前不能跑模型步）；探测不到 →
  结构化 501 `SESSION_ROTATE_UNSUPPORTED`，面板退回「复制交接摘要」。横幅第二按钮只在
  详情块 `rotate:true` 时渲染，两段确认防手滑（第一击 arm、第二击才发）；create 成功而
  archive 失败时 200 带 `archiveError` 不吞新会话。请求形状未静态实证（宿主包是打包产物），
  create 按最小形状逐个尝试、失败原文进错误消息——重启验证时据此校准。
  - 「创建新会话并交接」（create 单能力，真机实证注入的 sessions 服务在服务端带
  create）：疲劳横幅主按钮单击即建新会话——先 list 找当前会话行的 workspaceId
  （命中就带位置建，新会话落同一工作区），失败逐级兜底裸 create；交接摘要自动进
  剪贴板，提示如实说明「归档请在会话列表手动完成」。归档通道仍被宿主门禁封死，
  create+archive 双能力的「开新会话并归档本会话」按钮保持隐藏、端点 501 明细如实
  报告，宿主开放即自动点亮。写章工具输出的会话疲劳警示升级为显式转述指令（agent
  必须向用户建议换会话——会话区内宿主未给第三方插槽，agent 通道是唯一在对话里
  可见的提示位）。
  **真机实证（2026-10-07）**：①cordis ctx 代理对未 inject 的服务名访问即 throw
  （"cannot get property X without inject"）而非返回 undefined——探测必须逐名
  try/catch，首个实现因此炸掉疲劳横幅整块（回归钉已加：对拒绝式代理安全降级）；
  ②注入的 `sessions` 服务在服务端带 `create`（建会话通道在），但 workspace 控制器
  未注册任何 cordis 服务名 → 归档对第三方插件不可见 → 旋转按钮保持隐藏、端点 501
  明细如实报告，宿主哪天开放即自动点亮。
- **会话疲劳进面板：横幅 + 复制交接摘要**：`GET /projects/:id?session=<id>` 按会话聚合首稿
  趋势（health.js sessionFatigue）并在详情响应里带 `session` 块；面板详情页渲染疲劳横幅
  （本会话章数 / 首稿均长 / 基线 + 警示文案），动作是**「复制交接摘要」**——新会话粘一句即可
  续写（书的状态全在盘上）。一键创建会话宿主未对第三方 client 暴露（网关是读取向，0.15.x
  复核），不做假按钮。细节：详情请求经 `withSession` 带 session 参数；`navigator` 必须先过
  `typeof` 再取 clipboard（headless vm 里是未声明标识符，可选链不防 ReferenceError）；
  陈旧响应守卫测试的锚定正则放行可选 query。
- **会话疲劳检测（首稿退化根因的代码强制对策）**：真机实录——同一会话连写 19 章，首稿字数
  从 1939 一路退化到 558，全靠门禁驳回硬顶；换新会话首稿立回 2559。根因是对话历史堆积
  （模型把自己最近的短稿当上下文示例继续模仿），而退化发生时没有任何信号提示该换会话。
  修法：① `audit.jsonl` 的 write_chapter 行带 `session` 字段（历史行没有——统计只覆盖
  本版本之后的行，预期行为）；② `health.js` 新增纯函数 `sessionFatigue`（按章取第一次
  rejected/saved 的字数＝首稿，聚合本会话均值对比全书基线 `bookCharBaseline`）；
  ③ 进度卡新增 `progress.session`（本会话已写章数 / 首稿均长 / 基线），低于基线 70% 或
  本会话章数 ≥8 时警示「开新会话」（软警告；首稿退化警示优先于章数阈值；无基线/无会话
  id/审计读不到一律跳过，绝不阻断写作）。回归 4 例 + 真校验器同步（session 字段名与
  schema 逐字段对齐）。

## 0.15.0 (2026-10-06)

面板提案与正文对齐 + 预设新增「交付不走 present」纪律，测试 331 → 333。

- **应用提案后编辑器自动切到被改的那一章**：提案的成功提示与门禁提示都是页面级的，而章号下拉
  停在开书时固定的第 1 章——应用第 N 章的提案后会出现「提示说第 N 章、正文却是第 1 章」的错位。
  现在应用后把编辑器对齐到被改的那一章：正开着该章就重新载入取新版本；**别的章有未保存草稿
  则不静默丢弃**，挂起交给你点「丢弃改动 / 取消」；服务端没回章号时不猜（`Number(undefined)=NaN`
  会切到幽灵章），改为提示 + `console.warn`。
- **预设纪律「交付不走 present」**：真机实测模型每写完一章都自发调宿主 `present` 交付章节文件，
  连续 22 章 22/22 全失败——它在 `files[].path` 里塞进了成片的 `\r`，拼出的路径磁盘上根本不存在
  （盘上真名是干净的 `第N章-标题-vN.md`），每章白烧上千字符。章节落盘时插件已把文件登记为
  「已交付」，故在 persona 里写明：交付用工具返回的文件信息，别自己拼路径。

## 0.14.0 (2026-10-05)

四个演进方向：汇报走代码强制 / 反复故障体检 / 提案寿命管理 / 同名书稳定身份，测试 306 → 315。

- **① 汇报走代码强制**：`novel_write_chapter` 落盘后由工具现算「进度卡」（已写章数 / 账本条数 /
  在册伏笔 / 待批提案 / 下一章细纲是否就绪）随返回值给出，模型只据实转述，不再自数、也不再照抄
  历史消息里的旧数字——真机实测 P45/48/49 应用两天后，交付消息仍复述「三个待审提案」，病根就是
  事实靠模型记忆而非当次现算。
- **② 反复故障体检 + repair 扩项**：`novel_project repair` 先**归一化**含控制字符的章节路径
  （路径混入 `\r`/`\n` 会让 fs 判 `file not found`，且含 `\r` 的好章会被误判「整章丢失」而误删），
  并检出「数值字段落成 null」（`JSON.stringify(NaN/Infinity)` 的盘面残留，对应
  `value is not lossless JSON` 一类事故）。新增纯函数模块 `lib/health.js`——工具面 repair 与
  REST `/continuity` **共用同一实现**，面板「🩺 全书体检」归并展示，体检结果不再只活在工具输出里。
- **③ 提案寿命管理**：repair 检出「幽灵提案」（索引登记但 `.novel/proposals/*.json` 不在 →
  面板点开必失败 / 文件在但索引无 → 冷归档），**只报告不删**（文件缺失可能是同步未落盘，清索引
  就再也找不回）；终态裁剪沿用既有 `prune`。
- **④ 同名书稳定身份**：`novel.json` 落稳定 `id`（`nb_*`，不引 `node:crypto` 以便进浏览器 bundle），
  老书 repair 时补写；多工作区扫描同名书不再「先到者胜」静默丢一份，改为只出一卡并标注
  「同名书另有 N 份」（`duplicates` / `duplicateRoots`），面板书卡显式提示。
- 测试伴改：`lib/health.js` 纯函数属性测试、REST `/continuity` 归并体检集成测试、repair 体检回归。

## 0.13.9 (2026-09-24)

真机排障两连修 + 插件携带 novel skill，测试 296 → 297。

- **提案文件状态回写**：apply/discard 此前只更新 novel.json 索引，盘上
  `.novel/proposals/*.json` 的 status 永远停在创建时的 pending（双源分裂——索引说 applied、
  文件说 pending，读文件的诊断全被带偏）。apply/discard 终态 best-effort 回写文件，失败降级
  不阻断（索引为唯一真相）。
- **面板提案队列加载失败可见**：加载失败曾被静默渲染成「没有待批的修订」，与真空态不可分辨
  （用户误以为提案被吞）。新增 proposalsError 状态 + 详情页错误分支 + 重试动作。
- **novel skill**：插件携带会话内工作流指令包（`skills/novel/SKILL.md`）——首要原则、开书七步、
  续写四步、写作纪律、质检发布、面板联动，新会话可点名触发。

## 0.13.8 (2026-09-21)

真机 E2E 全流程测试（3 章试写本）抓出并修复三个 bug + 面板写界收口，测试 285 → 296。

- **fsio 策略探测修复（真机 novel_outline / novel_write_chapter 写盘全线抛错）**：cordis 对未
  inject 声明的服务，`ctx.sandboxPolicy` 的 getter 直接 throw（可选链防不住 getter 内部 throw）——
  补 try 视为缺失，降级走 `ctx.get` 双路探测；双路全缺失回 4 参旧形状。
- **面板世界书「启用/停用/删除」按钮全坏**：REST PUT/DELETE 把条目 id `Number` 强转
  （`W1`→NaN 永不匹配→404），改为字符串匹配；PUT 合并保留存储原 id（防数字 id 被腐蚀成字符串）。
- **旁路引擎抽文件健全性闸**：推理模型无围栏输出时，整段原始响应（真机实测 59KB、中文占比
  0.24）被兜底当成润色正文入库成提案——超原文 3 倍或中文占比 <50% 即判抽取失败，走
  `EMPTY_AFTER_EXTRACT` 干净报错，绝不入库。
- **REST 面写界对齐**：面板写盘（无 exec）以绑定书根覆写 `workspaceRoot`（mode 仍归
  resolver），writeText / writeTextAtVersion / appendLine 全写通道覆盖；沙箱拒绝识别走结构化
  `FsError.code`；拒绝提示按「策略是否线程成功 × 有无会话 × 宿主 mode」三段定向（REST 面
  明说切会话策略无效）。
- **扫描根新鲜度**：持久源内容签名失效（projcache 目录态落盘即时进场，TTL 降兜底）；
  projcache 双落盘形态（目录态 + 老单文件都读）；目录名反推 Windows 感知（~XXXX / 盘符形态）。
- 测试伴改：假后端真实施放 workspaceRoot 边界、cordis getter-throw 语义替身、W1 形态 id
  开关+删除闭环回归。

## 0.13.7 (2026-09-20)

Windows 真机三连修，测试 278 → 285。

- **插件写盘被沙箱误拒**（`file access denied under workspace-write mode`）：fsio 全部写盘统一
  `writeGuarded`，session 线程沙箱策略作第 5 参（与内置 fs 工具同参位）；服务缺失复刻旧 4 参
  形状零回归；拒绝文案补可行动指引。
- **细纲禁项解析器纠偏**：否定词/人名被误收成禁词、枚举行与裸词表行漏解析——按句式规约收
  禁词（「不得让X说…」收引号宾语），真书细纲数据双向回归。
- **面板扫书根 Windows 修正**（面板永远空书）：POSIX 专属目录名反推改为三源合并——live
  sessions、projcache `identity.cwd`（持久层）、目录名反推兜底，全部 statSync 验证后采用。

## 0.13.6 (2026-09-19)

审查修复收口 + REST 面护栏从零建立，测试 274 项。

- **乐观并发通道**（H2 根因修复）：`updateJson` 读时捕获基线 → 守卫写 → 冲突重读重放；
  提案链与 REST 写路径全部改走它；删除假守卫 `writeTextIfVersion`；`rememberSession` 只重放
  会话归属增量。
- **REST 加固**：同名建书 409、非法书名 400、章号守卫、workspace 白名单 403、请求体 4MB
  上限、claim/rename/delete 补审计；createServerFsio 补 create/replace/auto 写语义（与工具面同构）。
- **提案链**：全链路版本守卫（连点「应用」不互覆）、id 加随机后缀、应用返回内容门禁 notice。
- **导出自毁通道封死**：`novel_export` 的 `file` 只允许落在 `书/导出/` 内。
- **面板**：aria-label 真正生效（键名对不上曾静默丢弃）；内容门禁 notice 进详情页；删除确认态
  不跨书存活；体检/诊断切书守卫；未保存确认；批量起草落盘后重载受影响章。
- **工具/数据**：REST 存章 undefined summary 炸 status/repair 三层修复；账本最新值按章号取大、
  冲突条件改 `===`、`now` 必填；审计写失败降级不拖垂整章；检索幽灵块出口过滤 + sqlite 句柄
  try/finally；repair 孤儿正文扫描（对账后扫、只报告不删）；子代理传输接重试；工具面小修一批
  （ledger 多实体、glossary remove 报错、outline 先验书存在、场景序号边界等）。
- **听书**：暂停落在取文窗口可恢复续播；无句读超长段按字数硬切。
- **测试面**：REST 数据面首批行为测试 13 例（fence 全覆盖、假 fs 按宿主真语义）；并发回归翻转
  为断言不丢更新；面板 7 例；孤儿扫描回归 3 例。

## 0.13.5 (2026-09-19)

- **novel_propose list 输出修复**：`proposals[]` 条目实际携带的 title / missing /
  reason / preview 四字段未在 output.schema 声明（additionalProperties:false），
  宿主严格校验拒收——模型每次调用 list 均得无效输出。修：schema 补四字段；
  章标题为 null 时改缺键不再显式携带。
- **novel_project set_stage render 修复**：set_stage 返回值落进 render 链的
  status 兜底分支读 `v.chapters.length` 必 TypeError（输出被判无效）。补专属分支。
- **REST 面 fence 校验补齐**：`GET /projects/:id/continuity` 与
  `GET /projects/:id/diagnose` 补 trusted(req) 前置检查，与其余端点一致。
- **REST 章节保存加固**：章节号正整数校验（原先 `chapters/abc` 会落出
  「第NaN章」文件与索引键）；每笔保存写审计行（actor=user），「谁改的这一版」
  在 audit.jsonl 可查。
- **内容门禁误伤修正**：「待定」「略去」从阻断级降为软警告——『后续安排待定』
  『细节略去不表』是正常叙事措辞（「略去不表」为传统套语），阻断会产生假阳性
  熔断计数。
- **敏感自查词表修正**：亲密词表移除单字「性」（性格/理性/可能性全命中），
  以 性爱/性行为/性器官 替代；未成年主体词补 十一岁/十二岁/十七岁 与
  阿拉伯数字写法（12岁–17岁）。
- **测试面护栏**：新增「全工具×全 action」用例——用宿主真校验器
  （validateJsonSchemaValue）验证每个成功 action 的输出，并对 output.render
  冒烟。scene updatedAt（0.13.3）、propose list、set_stage render 三个同类
  事故覆盖的盲区自此结构性关闭。测试 245 项。

## 0.13.4 (2026-09-19)

- **批量起草并发父锚定收敛**：并发>1 时原先每章独立走候选链，多章并发
  `agents.resume` 同一持久化会话有撞宿主持久化写锁的风险。收敛为
  `engine.anchor()` 起草前解析一次、经 `run({ parent })` 传给每一章；
  锚定失败自动把并发降回 1（单章路径给出完整人话诊断）。
- **GitHub Actions CI**：push/PR 自动跑 `npm test`（构建 + 双静态审计 +
  全量单测）；README tests 徽章从静态文字换成动态 workflow 徽章。
- **README npm 死链摘除**：`npm:dsh-novel-forge` 从未发布（registry 404），
  安装指南里的 npm 路改为注释并标注 scoped 包名 `@huangziyuan-general/dsh-novel-forge`，
  发包后启用。
- 测试 244 项（新增 4 条：anchor 独立可用、预解析 parent 不碰注册表、
  批量锚定只一次、无 anchor 面兼容旧替身）。

## 0.13.3 (2026-09-19)

- **novel_scene 恒 invalid output 修复**：`normalizeContract` 产出 `updatedAt`，
  但 output schema 的 `contract` / `contracts[]` 条目都没声明它——宿主按
  `additionalProperties:false` 严格校验直接拒收。真机会话复盘：该工具在
  整个连载会话 **13 次调用全军覆没、0 成功**（场景契约读写一直没生效过）。
  修：schema 两处补 `updatedAt`；出口对存量数据（无 updatedAt）盖章成 string。
- **novel_style check 对旧基线防御**：旧版本基线条目可能缺 `sigma`/`tolerance`，
  `judgeAgainstBaseline` 逐项兜底（undefined 混进输出会被宿主 lossless JSON
  拒收，报「value is not lossless JSON」）；`chapters` 同样兜底为整数。
- 测试 240 项（新增 3 条：schema 声明、存量盖章、旧基线无 undefined）。

## 0.13.2 (2026-09-18)

- **工具参数严格化（全工具）**：`define-tool.js` 垫片包装 `execute`，未知参数字段一律拒绝，20 个工具一处生效（宿主参数 schema 无 `additionalProperties:false` 开关）。
- **全工具 schema 形状守卫**：装载测试逐一校验每个工具的 `output.schema` 与归一化 `parameters`（type / additionalProperties / required 幽灵字段）。
- **旁路引擎修复**：
  - inject 补声明 `agents`；
  - 父会话锚定加 `agents.resume({ resumeSessionId })` 按需物化兜底（会话未驻留也可锚定）；
  - 通道 `maxTokens` 默认 0＝不传（继承宿主按模型校准的上限），显式配置才设限；
  - 长文通道 `timeoutMs` 默认 600s（polish / proofread / draft），annotate 保持 512 / 60s；
  - `stopReason=max-tokens` 独立为 `OUTPUT_TRUNCATED` 错误码（含当前上限与配置指引）；锚定失败报错自带诊断段（agents 可解析性、resume 失败原因）。
- **章节路径统一**：新增 `store.chapterRelPath(rec)`（`path` 优先、`files[].file` 回退），读章 / 修订端点共用，修复阅读器恒为空；存量书目记录兼容。
- **导出修复**：导出端点改走 `collectBookChapters` + `assembleBookText` + `bookStats`，修复恒 500。
- **新端点**：`GET /projects/:id/diagnose`（黄金三章确定性诊断，纯词表零 token）、`GET /projects/:id/proposals/:pid`（单条提案全文）。
- **章节版本链**：保存端点版本号改 `prev?.latest` 起算，`chapterRecord` 记 `path` / `files` / `latest`，chars 按非空白字符计。
- **批量起草**：接入同一父会话锚定链路（`sessionId` + 书归属会话候选）。
- 面板请求超时与引擎对齐（600s）。
- 测试 237 项。

## 0.13.1 补六 (2026-09-17)

- **导出按钮修复**：新增 `collectBookChapters(io, novel)`，REST 导出走正确链路（v1/v2 版本指向、空章跳过、md/txt 两形态）。
- **润色/校对/批量起草的 web profile 可用性**：引擎增加 subagents 备用传输（`subagents.start('spawn', …)`，`result.output` 取文本）；isAvailable = llm 或 subagents 任一可用；直连路径保留。
- **字数标准**：`cordis.patch.yml` 覆盖值改 2000/4000（与 schema 默认对齐）。
- 修订端点空值判断改 `!recRel`；新增临时诊断端点 `GET /debug-services`。
- **子代理调用崩溃修复**：`SubagentStartRequest.parent` 必填，引擎先解析父会话再发起；`subagents.start()` 全部 await。

## 0.13.1 补五 (2026-09-16)

- `lib/proposals.js`：`listProposals` 每条附 `reason`、`preview`（120 字摘要）、`title`（章标题），提案文件丢失标 `missing`；新增 `readProposal` 读单条全文。
- REST：`GET /projects/:id/proposals/:pid`。
- 提案卡重做：三行结构（章号·标题 + 提案号 + 时间 + 查看/应用/丢弃）、说明行（reason 优先）、查看展开全文（可滚动收起）、丢弃联动收起、陈旧响应守卫。
- `preview-ui.mjs` mock 路由正则修复。
- 新增回归 2 条（listProposals/readProposal 全链路、面板查看契约）。测试 208 项。

## 0.13.1 补四 (2026-09-16)

- 界面修缮：世界书删除两步确认；`:focus-visible` 覆盖全部按钮；`Feedback` 原语（`role=alert` / `role=status`）；表单 label / aria-label 补全；Stat 数字 `tabular-nums`；日期 `toLocaleDateString`；章节目录与时间线 `content-visibility: auto`；书列表筛选（>8 本）；书名输入非受控化；`touch-action` 与 `prefers-reduced-motion`；StageRail 已过段半透明。
- settings 移除写死的工具数量。
- 假 DOM 的 `createElement` 镜像真 React 元素形状。
- 新增回归 5 条。测试 210 项。

## 0.13.1 补三 (2026-09-16)

- **克隆为模板**：新增 `lib/clone.js`（章节按版本复制重建索引、大纲/细纲/人物卡/世界书/账本/伏笔/术语表/场景契约/语言基因全复制、阶段重置、提案与熔断清空、审计落新书）；`novel_clone_project` 与 REST 共用。
- REST：`POST /projects/:id/clone`（归属打 `body.session`，重名/不存在/同名克隆拦截）。
- 面板：书卡「⧉ 克隆」内联表单（目录名必填、互斥打开、成功刷新）。
- `createServerFsio` 补 `listNames`。
- 新增回归 2 条。

## 0.13.1 补二 (2026-09-16)

- 书卡标题重叠修复：裸 `<button>` 背景重置 + 热区负边距只向上/左/右扩。
- `server-api.js` 认领/写章记录改用 `fsio.writeTextIfVersion`；补 `createServerFsio.writeTextIfVersion` 实现。
- `phases.js`：force 放行时 report status 改 `'in_progress'`（原恒 `'approved'`）。
- `forge-tab.js` 自动开 tab 重试支持 dispose。
- 会话工作区根扫描 60s TTL 缓存；非法 JSON 书目给 console.warn。
- 题材 chip 显示中文：`state.js` 默认值改空、服务端兜底 '未分类'；新增 `genre.js`（21 个常见英文题材映射，表外透传）。
- 回归 3 条（writeTextIfVersion、题材映射、克隆前置）。

## 0.13.1 (2026-09-15)

- **深色主题配色修正**：语义色改宿主真实 token（`bg-layer-1/2/3`、`button-primary-fill/-hover/-dimmed`、`label-tertiary`）；`label-dimmed` / `bg-overlay` 误用回归正确语义。
- **按钮交互态**：新增 `src/client/css.js`（`buildCss()` 以面板根为作用域生成样式表，`ensureStyles()` 幂等注入）；`Btn` 输出 `data-nf-btn` + `data-variant` + `data-size`，外观走样式表、布局走内联；各变体 rest/hover/active 三态（active 带 `translateY(1px)`）；分段控件、输入框 focus 环、summary 悬停补齐。
- **装配期安全**：`lib/engine.js` 新增 `readService()`（try/catch 双路探测），可用性改为每次调用时判定；装配期不再访问宿主服务属性。
- **章节字数标准**：`minChapterChars` 2000 / `maxChapterChars` 4000（目标 3000 左右）；`briefing` 新增「本章字数目标」段；批量起草系统提示补字数硬要求；`novel_write_chapter` 描述声明字数标准。
- **章节阅读器**：听书目录行加 📖 阅读钮（章号 + 标题 + 正文卡片，最高 420px），卡头带「▶ 朗读本章」与收起；阅读与播放独立；章号契约与播放钮一致；请求竞态防护（`reader.no` 校验）；换书自动收起。
- 回归 3 条（Config 默认值、简报字数段、阅读器契约）。

## 0.13.0 (2026-09-15)

- **设计系统**：`styles.js` 三层（语义色 → 尺度 → 组件）+ 新增 `ui.js` 原语层（Card / Section / Btn / Chip / Stat / StageRail / Meter / Empty / KV / Fold / Mono）。
- **五个视图重做**：项目列表（书脊卡 + 九阶段轨道 + 统计块）；详情页（面包屑、档案卡、竖轴时间线、伏笔状态胶囊、待批提案卡）；章节听书（置顶播放条 + 目录行状态）；世界书（注入条件摆明：常驻/停用/优先级/关键词）；设置（能力边界清单）。
- **已接上界面的四个端点**：一键润色、机械校对（`POST /projects/:id/chapters/:n/polish|proofread`）、全书体检（`GET /continuity`）、批量起草（`POST /draft-batch`）。
- 润色/校对单请求超时 600s / 900s；错误按状态码翻译（503 引擎未就绪 / 409 无路由 / 422 守卫拦下 / 499 中止）。
- 设置入口常驻头部。
- 新增可交互 UI 预览：`npm run preview` 生成 `preview/forge-ui.html`（真产物 + 宿主真实 token，离线可开，含按钮扫射自检）。
- **修复**：听书整列「▶」与顶部连播钮无效——控制器按 `data-id` 读章号（原读不存在的 `dataset.no`），拿不到章号报错不静默。
- 新增 `npm run audit`（`scripts/audit-static.mjs`）：调用/导入/声明核对 + 孤儿 `dataset.X` 读取检查，硬故障退出码 1，进 `pretest`。
- 列表「有基线」徽标修复（读 `p.style.built` 而非不存在的 `p.styleBuilt`）。
- 测试 185 项。

## 0.12.0 (2026-09-14)

- **角色状态时点推演**：`lib/ledger.js` 新增 `factsAt`（`chapter <= n` 内章号最大一条的时点快照）与 `statusTimeline`（单实体按章演化线）；`novel_ledger` 新增 `status_at` / `timeline` 两个动作（4 → 6）。
- `lib/continuity.js` 新增 `posthumousChanges`（账本级死后活动）并入 `validateContinuity`；死亡词表补 `战死/殉难/殉职/殉道/遇害/气绝/驾崩/玉殒`。
- **书库**：新增 `lib/library.js` + `novel_library`（第 20 个工具）：import / list / read / analyze / delete；章节长度曲线、对话密度、段落节奏、章末钩子率、高频意象；`compare_book` 与本书并排对比。落点在工作区根 `书库/`，与书目体系隔离（不进审计、不进上下文包、不参与一致性判定）。
- 克隆补齐 `设定/场景契约.json` 与 `设定/语言基因.json`。
- 熔断计数落盘：三条驳回路径先 `saveBook` 再抛错。
- 测试 149 项。

## 0.11.0 (2026-09-14)

- **平台审稿**：`novel_audit platform:qidian|fanqie`，起点与番茄两套体检表（字数/章末钩子/对话占比/段长/黄金三章/爽点节奏/完读率/句长变异系数），每条给 `value / target / advice`；复用既有 `computeAudit` / `measureMood` / `measureStyleMetrics`，零模型调用。
- **敏感自查**：`novel_audit censor:true`，七类（涉政/色情擦边/暴力血腥/赌博毒品/封建迷信/现实机构影射/未成年红线）；命中给行号 + 上下文 + 建议；`exempt` 按题材豁免；未成年红线用邻近共现判定；涉政类只做语域识别、命中提示人工复核。
- 测试 142 项。

## 0.10.0 (2026-09-14)

- **九阶段状态机**：立意→设定→人物→大纲→分卷→细纲→正文→修订→完稿，`novel_project phase` 带代码判定的入场条件，`set_stage` 硬设通道，`force` 记审计。
- **熔断**：同一章连续驳回 3 次拒写；改细纲或场景契约后计数清零；面板可查熔断计数。
- 场景契约与语言基因卡的克隆、门禁判定顺序（内容门禁先于细纲契约）等配套修复。
- 测试 149 项（F1 九阶段、E2 熔断等新增）。

## 0.9.0 (2026-09-14)

- **场景契约 + 隐藏人物**（`lib/scene-contract.js` + `novel_scene`）：契约按章存 `设定/场景契约.json`；briefing 只注入 `participants` 人物卡、世界书按 `settings` 白名单取；`hidden` 人物档案不进上下文、注入区块不写其名、正文出现其名内容门禁拒绝落盘（force 记审计）；`participants` 与 `hidden` 同名时保护优先。
- **语言基因卡**（`lib/voice.js` + `novel_character voice`）：`设定/语言基因.json` 结构化存储（句长/逻辑/口头禅/绝不说/标志动作/语域）；briefing 单独注入区块；`novel_audit voice:true` 核对禁忌词硬伤与口头禅缺失提示。
- **细纲契约指标**（`lib/gate-metrics.js`）：`## 本章必写场景` 与 `## 本章禁止偏离项` 由代码计算 `coverage` / `drift` / `missedScenes` / `bannedHits`，带时间戳落盘 `novel.json.chapters[n].gate`；禁项按否定句式三分类；契约段可选、解析失败只提示不阻断。
- **隐藏名双层擦除**：`renderContractSection` 替换 scene/forbidden/notes 里的隐藏名；`scrubHiddenNames` 对最终注入逐行过滤（含账本/摘要派生泄漏），删空整节不注入并尾注「已屏蔽 N 行」。
- `contextpack` 新增 `sceneContract` / `voiceCard` 预算位；`store.pathsFor` 新增 `sceneContracts` / `voices`；新增审计事件 `scene/save`、`scene/delete`、`character/voice`、`write_chapter/gate_forced`、`write_chapter/scene_contract`。
- 测试 142 项。

## 0.8.0 (2026-09-14)

- **全书一致性校验**（`lib/continuity.js` + `continuity-io.js`）：八类检查——死亡实体再现（闪回/梦境自动豁免降级警告）、伏笔倒挂/重复/超期、章节索引缺文件/断档/缺 summary、账本章号超前/同章多值/重复、cast 缺人物卡；死亡判定含反例排除（`不死之身`/`拼死一战`/`死寂` 等）。入口：`novel_project check`、`novel_audit continuity:true`、`GET /projects/:id/continuity`。
- **润色保守编辑守卫**（`lib/polish.js validatePolishEdits`）：标题行被改阻断；高危易混字阻断；整章膨胀 >1.3 倍、段落相似度 <0.4 等给警告；接入 `novel_polish submit`。
- **四维内容门禁**（`lib/content-gate.js`）：死亡实体再现阻断、过期状态词警告、到期伏笔零回应 + 开新钩阻断、占位符阻断、人称混用警告；`force` 记 `write_chapter/content_gate_forced` 审计；force 判据改用显式传参（原恒 false）。
- **追读节奏硬约束**：contextpack 固定注入节；故事承诺书（`novel_project promise`）成为 briefing 固定注入项。
- 测试 130 项。

## 0.7.0 (2026-09-14)

- **apply 摘出工具面**：`novel_propose` 收窄为 `propose`/`list`；apply/discard/prune 仅在面板与 REST，模型无法自己批准提案。新增 `lib/proposals.js` 唯一实现（工具层与 REST 层共用）与 `GET /projects/:id/proposals`、`POST .../apply|discard|prune` 端点；详情页新增待批准提案区块。
- **审计 `actor` 字段**：`user` / `agent` / `system` 三值，置于 detail 展开之后、不可被业务字段覆盖。
- **节奏铁律**：persona + 工具描述 + 系统提示三处写死「一次只写一章」。
- `createServerFsio` 补齐 `readJson` / `readJsonl` / `writeJson` / `appendLine`（与 `createFsio` 接口同构）；提案新增 `appliedAt` / `discardedAt`。
- **preset-deploy 版本感知**：同版本跳过；版本不同逐文件比对，未改动文件直接更新、已改动文件备份 `.user.bak` 再更新；部署写 `.deploy.json` 清单。
- 测试 117 项。

## 0.6.6 (2026-09-14)

- REST 多工作区扫描：从 `~/.dsh/sessions/` 目录名反推会话工作区列表（`statSync` 验证），`scanAllBooks()` 扫全部根合并书目（同名 cwd 根优先）；`locateBook(bookId)` 跨根定位，11 个按 id 找书的端点全部跨根读写；删除端点改走 `locateBook`；`POST /projects` 支持 `body.workspace`。
- 测试 110 项。

## 0.6.5 (2026-09-14)

- 项目改名：卡片内联输入，`POST /projects/:id/rename`，只改 `novel.json.title` 不挪目录。
- 项目删除：卡片两步确认，走既有 `DELETE /projects/:id` 软删。
- 测试 110 项。

## 0.6.4 (2026-09-14)

- 未保存草稿返回/换章前确认（丢弃/取消）。
- 项目卡改真 `<button>`（键盘/读屏可用）。
- 删除二次确认补「取消」出口。
- 颜色 token 化（硬编码 hex → dsw 别名 + 浅色回退）。
- 切章读取失败给报错；`openProject` 并行请求；头部与列表去重刷新；title 输入受控同步。
- 测试 108 项。

## 0.6.3 (2026-09-13)

- TTS 修复：`speechSynthesis.speak()` 只收 `SpeechSynthesisUtterance` 实例（新增 `defaultUtteranceFactory()`，headless 退回普通对象）。
- 连播跳缺口：新增 `nextChapterAfter`（按已排章节目录取下一存在的章）。
- `synth.speak` 包 try/catch，单块同步抛错不卡播放链。
- 服务端路径：`bookId` 一律 `safeDecode` + `validBookId` 校验（拒空/`.`/`..`/分隔符），11 处统一。
- `api.js`：超时与调用方中止分开报错。
- 测试 106 项。

## 0.6.2 (2026-09-13)

- `apiFetch` 加固：单请求 12s 超时（AbortController）；响应非 JSON 给可读指引（硬刷新）；`ok:false` 契约不变。
- `refreshProjects` 加探针日志（请求/失败各一条，console 分诊）。
- 测试 103 项。

## 0.6.1 (2026-09-13)

- 新增 `GET /projects/:id/elements`：聚合档案 / 大纲 / 角色卡 / 设定 / 时间线五类要素。
- `fsio.js` 服务端半新增 `listEntries`。
- 新视图 `views/overview.js`：要素总览 + 空态引导；`<details>` 折叠；接口失败置空不影响打开书。
- 测试 100 项。

## 0.6.0 (2026-09-13)

- 新增 `GET /projects/:id/chapters`（章节目录，按章号升序）。
- 详情页两个标签「基本信息 / 章节听书」；TTS（`src/client/tts.js`）：正文切块逐块合成、连播、代际计数（stop/重播后迟到 onend 作废）、面板卸载/换书/删书/换会话一律 stop、无语音引擎给可读报错。
- 空书章节标签给引导。
- 自检脚本修一处正则误报（`from\s*["']` 加负向后行断言）。
- 测试 99 项。

## 0.5.1 (2026-09-13)

- 撤销「会话有项目才显示」门控：`apply` 无条件 `openForgeTab`，锻炉恢复右侧栏常驻独立 tab；面板内仍按会话过滤项目列表。
- `session-watch.js` 调度语义保留，仅供测试直调。
- 测试 94 项。

## 0.5.0 (2026-09-13)

- 入口迁移到官方右侧栏 tab 三步契约（`sidebarRightTabs.register` → `slots.register` → `sidebarRight.openTab`）；删除左侧栏 DOM 注入路线（`sidebar-entry.js` / `drawer.js` 退场，产物反向断言守着）。
- 项目跟会话走：`novel.json.sessions` 归属集（创建写会话、`requireBook` 补录当前会话）；面板按会话过滤项目列表；新增 `src/client/session-watch.js`。
- `POST /projects` 支持 `body.session` 打归属戳。
- 测试 94 项。

## 0.4.2 (2026-09-13)

- 补上构建链：新增 `src/client/` 源码树（ESM 唯一真相）与 `scripts/build-client.mjs`（esbuild，`src/client/` → `lib/client.js` 经典脚本；react external 由宿主提供）；`npm run build` + `pretest`（测试跑当前源码构建产物）；构建内置版本守卫（`PLUGIN_VERSION` ≠ package.json version 即失败）。
- 移出 `lib/client/` 目录（与产物同名歧义）；`ENTRY_SELECTOR` 转为真用途（幂等去重）；移除遗留 `dsh.client.inject` 声明。
- 测试 79 项。

## 0.4.1 (2026-09-13)

- 修复左侧栏入口被 React reconcile 冲掉后不再恢复：`placeEntry` 族选择器排队 + 双观察自愈（`waitObserver` + `rootObserver`），判据改「现在还在不在」。
- 新增 `data-dsh-plugin` / `data-dsh-part` 标记；`apply()` 加分诊日志。
- 测试重写为行为测试（`test/helpers/dom.mjs` 仿真真机 DOM，真跑 `apply()`）：插入位置、冲掉自愈、侧栏后到、整棵替换重挂、点入口挂抽屉。测试 78 项。

## 0.4.0 (2026-09-13)

- 入口改为左侧栏 DOM 注入 + 全屏抽屉（0.5.0 撤销）；`lib/client/drawer.js` / `sidebar-entry.js` 初版。

## 0.3.10 (2026-09-13)

- 书目发现区分必需/可选文件：`novel.json` 必需，账本/伏笔/风格基线可选（缺失 = 零值，不进 readError）；仅在读到 `novel.json` 时生成摘要。
- 测试 85 项。

## 0.3.9 (2026-09-13)

- 书目预筛：新增 `dirHasNovel`（1 次 `list` 判目录内有无 `novel.json`，只对真书读盘）；扫描上限 `MAX_SCAN=30` / `MAX_BOOKS=12`；任何异常一律按「不是书」降级。
- 测试 83 项。

## 0.3.8 (2026-09-13)

- 数据面根路径纠正：`list` 用工作区相对根 `"."`（list 受工作区边界限制、read 不受限）；`read` 带 range 必填对象；返回按 `WorkspaceFileText.text` 取值并带出 `absolutePath`；`loadBookConsole` 两态判定（根本身是书 / 一级子目录为候选书）。
- 测试 82 项。

## 0.3.7 (2026-09-13)

- list 根路径用 `$host.home` 作为工作区绝对根；read 实参按「2 业务实参 + 可选 signal」重排。（0.3.8 修正此方案。）

## 0.3.6 (2026-09-13)

- client `inject` 补 `"remote.workspaceFiles"`（remote 子域必须显式声明）。

## 0.3.5 (2026-09-13)

- 数据面接入 `ctx.remote.workspaceFiles`（list / read / stat 探测形态）。

## 0.3.4 (2026-09-13)

- 面板改走 remote 数据面读盘的初版（0.3.6–0.3.8 连续修正调用形态）。

## 0.3.3 (2026-09-12)

- 面板项目列表/详情与 REST 对接（`GET /projects`、`GET /projects/:id`）。

## 0.3.2 (2026-09-12)

- REST 基础面：书目录扫描、novel.json 读取、`trusted` fence 鉴权。

## 0.3.1 (2026-09-12)

- `lib/server-api.js` 初版：REST 注册框架、`readJsonBody` / `fail` / `writeJson` 基元。

## 0.3.0 (2026-09-12)

- 面板雏形：项目列表 + 详情只读（内嵌于产物 bundle）。

## 0.2.0 (2026-09-11)

- 上下文包预算化（人物卡 2800 字符均摊）、`novel_audit` 空指针与缺失文件跳过、账本 chapter 护栏（章号不得超前已写章节 +1）、`repetitionWindow` 可配置（默认 10）、短文本扫描置信提示。
- 世界书 `priority`（0–100）与递归激活（限 2 轮）；伏笔 `plan`（超期硬告警）；伏笔改期通道（同 id 未回收改 plan/setup，审计区分 setup/replan）；`novel_project repair`（索引-磁盘对账）。
- 测试 32 项。

## 0.1.1 (2026-09-11)

- 同 0.2.0 合并发布前的热修批（预算化、护栏、repair 等，随 0.2.0 收口）。

## 0.1.0 (2026-09-11)

首个可用版本。

- 10 个 `novel_*` 工具：project / outline / character / worldbook / briefing / write_chapter / ledger / noai_scan / audit / propose。
- 四道写章门禁：细纲批准 → 细纲文件存在 → 机审（字数/重复/要素）→ 账本同章冲突检查。
- 事实账本与伏笔台账（历史保留、跨章推进放行、同章改值拒绝）。
- 写前简报上下文包（细纲→人物卡→账本→伏笔→世界书→上章结尾→摘要→大纲，预算裁剪）。
- 六维结构性去 AI 味扫描（纯本地计算）。
- 确定性章节审计（字数/对话占比/章末钩子/8 字 shingle 重复率/要素覆盖）。
- 修改提案制（propose → 用户确认 → apply 生成新版本；旧版永不覆盖）。
- agent 预设「小说锻炉」随包部署；全动作 audit.jsonl 审计；书稿 io 走宿主 ctx.fs。
- 测试 25 项。
