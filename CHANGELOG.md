# Changelog

## 0.3.0 (2026-09-12) — 浏览器 client-half（GUI）首块：右侧"锻炉"tab

- **新增 `lib/client.js`**：dsh-novel-forge 第一个浏览器 client 模块，以 `__ModuleLoader__.load` 部署格式（对齐 dsh-client-ui-brand-official / sidebar-files），在右侧栏注册一个"锻炉" tab（面板 + chip 标题）作插件的常驻 UI 挂载点。v1 为静态识别面（插件名/版本/17 工具/双通道/规范三条），证明 client 挂载链路；数据面（书目/账本/风格基线…经 remote 拉取工具态）留到下一里程碑。
- **package.json**：新增 `exports["./client"]` 与 `dsh.client { inject:["@deepseek-ai/dsh-client-ui-sidebar-right"], platform:"web" }`；版本 0.3.0。
- **结构契约回归测试**：`smoke.test.mjs` 新增断言 package.json 的 `./client`/`dsh.client` 声明与 client.js 的 ModuleLoader 标记/load id/apply+inject 导出。62/62 全绿。
- ⚠️ **验证依赖真机**：浏览器半无法在假 ctx 挂载验证。装进 live web profile 后需**重启 DSH web**，右侧栏应出现"🔨 锻炉" tab；结构契约测试守住了产物不漂移，但挂载效果需真机确认。（回滚：撤 dsh.client + exports["./client"] + 删 lib/client.js 即回到纯服务端。）

## 0.2.8 (2026-09-12) — 三项遗留加固

- **MCP 后端符号链接逃逸修复**：`createNodeFsBackend` 的 containment 从词法 `path.relative` 升级为 **realpath 校验**——工作区内的软链指向区外时 stat/read/write 全部拒绝（`FS_SANDBOX_DENIED`）；root 本身是软链时统一到真实路径再比较；待创建新文件对最近存在祖先做 realpath 后拼回剩余段。0.2.6 记录的"低风险加固项"就此关闭。
- **MCP 通道输出契约校验**：`buildStandaloneTools.call` 对返回值跑宿主同款 `validateJsonSchemaValue`（防御性动态导入，SDK 缺席时退化为不校验）——MCP 客户端拿到的数据与宿主通道同一标准，违规抛 `INVALID_TOOL_OUTPUT`。
- **style 词表外置**：`style.js` 的六维词表（模糊限制语/抽象后缀/动作动词/动态助词/「X地」排除表）与 12 轴氛围词表挪到 `lib/data/style-lexicon.json`，与 noai/diagnose 词库同一存放约定；`MOOD_AXES` 改为从词库导出，用户调词不动算法。
- 测试 61/61 全绿（新增：软链逃逸 ×read/write/resolve 三通道、契约探针违规拒绝 + 正常工具不受影响）。

## 0.2.7 (2026-09-12) — 氛围光谱去重修复

- **修复**：`MOOD_AXES` 的 `mystery` 轴 `'线索'` 重复出现，而 `measureMood` 逐词累加命中 → 悬疑轴被双倍计分、系统性抬高。已删数据层重复词，并在 `measureMood` 内用 `new Set(words)` 去重兜底（防词表再次引入重复）。新增回归测试：998 字文本含 1 个"线索"时悬疑轴精确为 1.0/千字（旧实现会得 2.0）。59/59 测试全绿。
- 另：MCP 后端 containment 用 `path.resolve`（不追符号链接）——本地工作区若已有指向区外的符号链接可沿链接读写逃逸，属低风险加固项，暂未改动（见评审记录）。

## 0.2.6 (2026-09-12) — 大肥鱼三连：锚包写作 + 氛围光谱 + MCP 双通道

- **锚包写作**（灵感：dsh-novel-writer 锚包哲学）：`novel_briefing` 上下文包新增
  「原著锚段」区——从最近已写的 3 章里启发式挑出叙述感/对话感各一段代表性段落，
  有基线时附六维指纹行；纪律同一条：照锚段的语感节奏写，勿抄词句，勿把数字当写作规则。
- **氛围光谱 12 轴**：`lib/style.js` 新增 `measureMood`（热血/悬疑/惊悚/压抑/甜宠/
  温情/悲情/诙谐/爽感/神秘/肃杀/苍凉，命中数/千字，宁漏勿误词表）；`novel_style`
  build 附全书各轴均值 + 最浓三轴，check 附本段向量与主导氛围漂移判定
  （from → to，方向参考非错误）。
- **MCP 双通道**：新增零依赖 stdio MCP server（`mcp/server.mjs`，原生 JSON-RPC 2.0），
  把全部 17 个 novel_* 工具暴露给 Claude Desktop / Cursor 等任意 MCP 客户端；
  `lib/mcp-standalone.js` 提供 node:fs 后端（containment + createIfAbsent/
  replaceIfVersion 版本守卫，与宿主沙箱语义对齐）；package.json 增加
  `bin: dsh-novel-forge-mcp`；工作区根 = `NOVEL_FORGE_ROOT`（缺省 cwd）。
- 测试 58/58 绿（新增 6：锚段提取、氛围测量、后端 containment/版本守卫、
  standalone 装配、stdio 子进程 initialize→tools/list→tools/call 全链）；
  真机 headless 验证：build 氛围 top3=苍凉/肃杀/压抑（废土书方向正确），
  briefing 锚段区 + 指纹正常注入（totalChars 2794）。

## 0.2.5 (2026-09-12) — 新增 novel_style 文笔六维基线（第 17 个工具）

- **新增** `lib/style.js` 纯逻辑模块（零依赖、零模型调用）：六维测量——句法复杂度（小句/句）、修饰密度（X的/X地，排除「地铁/地方」等名词词素）、抽象度（抽象后缀词/千字）、动作密度（动词+动态助词/千字）、不确定性（模糊限制语/千字）、留白指数（省略号/破折号+未完句）。按章算 μ±σ 基线带，容差默认 1.5σ 相对占比（夹 10%~100%，单样本退化 35%）。
- **新增** `novel_style` 工具：`build` 测全书各章建基线存 `.novel/style-baseline.json`；`check` 拿某章或给定 text 对照基线，逐维报带内✓/出带⚠与偏差百分比，verdict 三档（in_band / minor_drift / drift），容差可按维覆盖。
- 系统提示新增纪律第 8 条：续写前 build、交稿前 check，出带只报方向、不把数字翻译成写作规则。
- 思路致谢 dsh-novel-writer（siweina，MIT）的六维测量设计；实现口径为本插件自有（密度统一每千字、测量与判断分离与既有审计一致）。
- 测试 53 项全绿（新增 5 项 style 单测）；真机 headless 验证 build+check 通过（顺带抓出并修复 build/check 输出 schema 与实际返回不一致两处）。

## 0.2.4 (2026-09-12) — 垫片补全 presentationMeta 对称归位

- **补齐**：`lib/tools/define-tool.js` 之前只把顶层 `render` 挪进 `output.render`，`presentationMeta` 仍会留在顶层被宿主忽略——注释/0.2.3 说明写的"render / presentationMeta 归位"名不符实。现对称处理：顶层 `render`/`presentationMeta` 都归位到 `output` 下（output 已有值不覆盖），注释与行为一致。当前无工具用 presentationMeta，故纯为消缺 + 消除误导。
- 新增回归测试：顶层 render/presentationMeta 经垫片归位后，`t.output.render(...)` 不再抛 `userRender is not a function`，`presentationMeta` 同样可用（走真实宿主 SDK，48 测试全绿）。

## 0.2.3 (2026-09-12) — 真机冒烟修复：render 兼容 0.1.5-rc.1 宿主

- **修复**：`defineTool` 选项顶层的 `render` 在 dsh 0.1.5-rc.1 宿主上全部失效——宿主只读 `options.output.render`，其渲染包装函数拿到 `undefined` 调用即抛 `output.render failed: userRender is not a function`，工具输出被判 INVALID_TOOL_OUTPUT（16 个工具全数命中）。新增 `lib/tools/define-tool.js` 兼容垫片（顶层 render / presentationMeta 归位到 output 下），6 个工具文件改走垫片导入。单测（假 fs）不走宿主渲染路径故未暴露，真机 headless one-shot 冒烟抓出。
- 真机冒烟 7 步全通：import preview/import → diagnose 四维 → export 落盘 → clone_project（`ctx.fs.listDir` host 面验证，缺失 0）→ polish analyze/submit → propose list/apply（提案制 v1→v2 旧版保留）。

## 0.2.2 (2026-09-12) — 输出契约硬化 + 世界书互操作 + 克隆修复

- **世界书互操作**（新 `lib/worldbook-io.js` 纯函数）：`novel_worldbook import/export` 接受三种形态——JSON 数组、SillyTavern 简化形（`{key/keyword/comment/constant/uid}` 尽力规约）、纯文本行 `关键词1,关键词2 | 内容`；导入按 id 覆盖合并，坏行跳过并报告 errors。
- **输出契约硬化**：可选字段缺省时**省略键**而非给 null（`audit.endingHook.kind`、`repetition.chapter`、伏笔 `plan/payoffChapter` 经 `foreshadowView` 统一裁剪）——宿主对 null 一样判 INVALID_TOOL_OUTPUT；新增**真校验器**冒烟（宿主 `validateJsonSchemaValue` 对真实返回值零违规）。
- **克隆修复**：未批准细纲一并复制（按已写∪已批准并集，经新增 `fsio.listNames`→`ctx.fs.listDir` 扫描细纲目录）；克隆产物 `approvals` 与 `defaultNovel` 同形（此前是 `{}`，新书 approve 会 TypeError）。
- **propose/apply 机审计基线修正**：应用提案后的重复率检测从空 `previous` 改为真实前文窗口（与 write_chapter 同口径）。
- `parseFactLines` 补实体/键名空值校验；`audit.js` 钩子检测复用 `hook.js`。
- **版本计算统一**：`write_chapter` / `propose apply` 的内联正则版本号计算收敛到 `versioning.nextVersion`（唯一入口）；删除无调用方的 `latestChapterFile` / `listChapters`。
- COMPATIBILITY 宿主面清单补 `ctx.fs.listDir`（0.2.1 起实际依赖）。
- 测试 47 全绿。

## 0.2.1 (2026-09-12)

两项收尾：

- **`novel_import backfill`**（门禁回补）：为导入旧书从已存正文确定性生成粗纲（标题/字数/开场/章末钩子/出场人物识别，`lib/import.js roughOutline` 纯函数），`approve:true` 可一并批准（记入审计）。只回补缺失细纲，已有细纲的章不动；续写新章仍走正常 save_chapter + approve。导入→继续写的链路不再逐章手工补纲。
- **诊断词库外置**：`diagnose.js` 的冲突/灌输/开场动作/抒情开场词表挪到 `lib/data/diagnose-lexicon.json`（与 noai-lexicon 同一约定，用户可调词库不动算法）；顺带修正 `conflictWords`/`infoTokens` 缺 `g` 标志导致"命中数加权"实际恒为 1 次的隐性问题。
- 测试 39 全绿（新增：roughOutline 纯函数、词库外置后四维诊断、backfill 端到端含二次回补幂等）。

## 0.2.0 (2026-09-12) — 竞品劣势补齐（Node 半确定性工具，工具 10 → 16）

针对竞品对比里"缺本地导入 / 无润色 + diff / 无黄金三章诊断 / 无导出 / 无克隆 / 世界书薄 / 无术语表"的落地：

- **`novel_import`**：本地书籍导入。`lib/import.js` 纯函数按章节标题切分（无标题则整段一章），preview 只预览不落盘，import 建书 + 每章版本化落盘。
- **`novel_export`**：按版本顺序拼装整本 → `.md` / `.txt`，写 `书/导出/`，返回 stats。
- **`novel_diagnose`**：黄金三章确定性四维诊断（钩子/开场/冲突/信息灌输，0-100），延续"机审与模型审分离"。
- **`novel_polish`**：analyze 返回段落级病灶（AI 味/长段/灌输腔/章末钩子）；submit 把润色稿**走提案制**提交（确认才 apply 成新版本，永不覆盖旧稿）。
- **`novel_glossary`**：术语表 store，写前简报随上下文包注入，防专有名词乱译。
- **`novel_clone_project`**：整书克隆为模板（复制章节/大纲/人物/世界书/账本/伏笔，阶段重置 planning、提案清空）。
- **世界书**：新增 `import`（JSON 数组或 `关键词|内容` 行）/ `export`（JSON）动作。
- 工具 10 → 16；测试 37 全绿。

决策记录：**GUI 工作台暂缓**。宿主浏览器 client-half 需 tsdown 打包 + `window.__ModuleLoader__` 运行时 + 挂进 `@deepseek-ai/dsh-client-ui-*` 槽与命令依赖网，只能在真实 DSH web 装载验证；本仓库未接入该 build 工具链、测试环境也载不了浏览器半。并清掉了 package.json 里悬空的 `dsh.client` 声明（申明有 client-half 却无 `./client` export，真机可能误判）。方案（`dsh.client` 声明 + `./client` export + tsdown 打包 client.js）已调研清楚，待装进真机后另行实现，避免产出不可验证的死代码。

## 0.1.3 (2026-09-11)

七项整改（评审反馈落地）：

- **〔P0〕自动 id 碰撞修复**：伏笔/世界书的自动编号从「数组长度+1」改为「已用最大后缀+1」（`nextSuffixedId`）——手工删过条目后再新增，不再复用旧后缀把已存在条目静默覆盖。
- **中·1** `novel_write_chapter` 去 AI 味只扫一次（审计日志与返回值复用同一结果），消除重复 `scanAiFlavor`。
- **中·2** 上下文包预算把每个 section 的 `<<name>>` header 计入（消除约 3-5% 的预算虚高）。
- **中·3** 世界书新增 `update` 动作（按 id 合并 content/keywords/priority/always，id 不变）。
- **轻·4** 账本查询结果带出 `note`（`novel_ledger` 与 `novel_write_chapter.addedFacts` 的 schema+返回同步）。
- **轻·1** 新增 `novel_project set_stage`：显式阶段重置/纠正通道（对应 `gate.resetStage`，不走只前进的 `advanceStage`）。
- **轻·3** 新增 `novel_propose prune`：清理已终态（非 pending）提案的索引引用；宿主 fs 无删除原语，真文件留作冷归档。
- 测试 36 用例全绿（新增：id gap 安全 ×2、世界书 update/set_stage/prune 冒烟、账本 note）。

## 0.1.2 (2026-09-11)

复查回合的加固（A 方案）：

- `novel_write_chapter` 的 `facts_updates` 补章号护栏：`assertLedgerChapter` 现在同样拦住写章时的账本超前（force 场景也拦，且被拦不留请求文件）。
- 伏笔**改期**通道：`foreshadow_setup` 对同 id 且未回收的伏笔改为更新 plan/setup（而不抛"重复"），已回收的仍拒绝改期；审计区分 `foreshadow/setup` 与 `foreshadow/replan`。
- 文档样例修正：README 数据布局补上世界书的 `priority` 与伏笔的 `plan` 字段。
- 测试 32 用例全绿（新增：伏笔改期逻辑、写章账本超前被拒冒烟）。

## 0.1.1 (2026-09-11)

修复 + 吸收外部方案优点（SillyTavern 世界书 / Crucible Plants & Payoffs / story-long-write 数据化资产）。

修复：

- 上下文包预算：人物卡设总预算（2800 字符均摊）——卡多时不再挤掉账本/伏笔/世界书。
- `novel_audit` 前文循环对不完整索引记录的空指针；跳过缺失文件而非崩溃。
- 账本 chapter 护栏：`update` 章号不得超前于已写章节 +1（模型填错章号会污染账本历史）。
- 跨章重复检测窗口从固定 5 章改为可配置 `repetitionWindow`（默认 10）。
- 去 AI 味扫描对 <1500 字文本输出置信提示（密度指标统计噪声声明）。

新增：

- 世界书条目 `priority`（0-100）：预算不足时高优先级条目先入上下文（SillyTavern 插入序）。
- 世界书**递归激活**：已激活条目内容参与下一轮关键词扫描（限 2 轮，防 runaway）。
- 伏笔 `plan`（预计回收章号）：briefing 对**超期未回收**伏笔硬告警（Crucible 式 payoff 追踪）。
- `novel_project repair`：novel.json 索引与磁盘对账（清理失效文件引用、撤销无细纲批准）。

测试：30 用例全绿（新增 5 个：章号护栏 / 伏笔超期 / 人物卡预算 / 世界书递归+优先级 / repair 端到端）。

## 0.1.0 (2026-09-11)

首个可用版本。主线：**代码强制 > 提示词自觉**。

- 10 个 `novel_*` 工具：project / outline / character / worldbook / briefing /
  write_chapter / ledger / noai_scan / audit / propose。
- 四道写章门禁：细纲批准 → 细纲文件存在 → 机审（字数/重复/要素）→ 账本同章冲突检查。
- 事实账本与伏笔台账（历史保留、跨章推进放行、同章改值拒绝）。
- 写前简报上下文包（细纲→人物卡→账本→伏笔→世界书→上章结尾→摘要→大纲，预算裁剪）。
- 六维结构性去 AI 味扫描（模板句/库存词/情绪直写/句式模板/节奏方差/信息稀释），纯本地计算。
- 确定性章节审计（字数/对话占比/章末钩子/8 字 shingle 重复率/要素覆盖）。
- 修改提案制（propose → 用户确认 → apply 生成新版本；旧版永不覆盖）。
- agent 预设「小说锻炉」随包幂等部署（工具瘦身为创意写作定制）。
- 全动作 audit.jsonl 审计；全部书稿 io 走宿主 ctx.fs（沙箱/审批友好）。
- 测试：25 用例（纯逻辑 + 真实宿主 SDK + 假 fs 全链路）全绿。
