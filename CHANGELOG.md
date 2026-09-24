# Changelog

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

真机 E2E 全流程测试（《长夜灯》3 章）抓出并修复三个 bug + 面板写界收口，测试 285 → 296。

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
