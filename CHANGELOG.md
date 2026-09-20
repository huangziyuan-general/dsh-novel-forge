# Changelog

## 未发布

- **projcache 双落盘形态支持（Windows 真机日志复盘发现的真 bug）**：dsh 0.1.5 起宿主把
  projcache 从单文件 `storages/session_projcache.json`（`tables.sessions.*.identity.cwd`）改为
  目录态 `storages/session_projcache/sessions/*.json`（每份 `record.identity.cwd`）。旧实现只读
  单文件 → 新宿主上源①静默归零（readFileSync 抛错被 catch 吞掉，连日志都没有）。现在两代形态
  都读、命中去重，单会话文件坏 JSON 不阻断其余；真机形状（record.identity.cwd）固化为回归，
  另加「只造目录态、绝不建单文件」的集成用例锁死通路（286 测试）。同批：Windows 侧 agent 按
  0→5 诊断步骤实锤——该机面板空 = projcache 形态失配 × 目录名反推 ~XXXX/盘符歧义 ×
  书缺 novel.json（旧沙箱时代 init 被拒写，内容走 pwsh 手工维护）三重叠加。

## 0.13.7 (2026-09-20)

Windows 真机三连修：这一版把「同一台 Windows、同一次创作流程里连环撞上的三个环境相关问题」一次收口——写盘被沙箱误拒、细纲禁项解析假命中、面板永远空书。三条都带真机实录做回归，测试 278 → 285。

- **Windows 真机修复：插件写盘被沙箱误拒（`file access denied under workspace-write mode`）**。根因在宿主与插件的接缝：内置 fs 工具把按 exec 解析的 sandboxPolicy 作为第 5 参传给
  `ctx.fs.writeText`，而 fsio 只传 4 参——宿主 `checkedTarget` 兜底 `sandboxPolicy.resolve()`
  无 session，workspaceRoot 回落 **web 进程 cwd**；会话工作区 ≠ 进程 cwd 的部署
  （Windows 上 dsh web 从别处启动、会话开在 `D:\某目录`）把工作区内的正常写判成越界。
  修法 = fsio 两个工厂（会话面 / REST 面）全部 6 处写盘统一走 `writeGuarded`：
  把 exec 的 session 显式交给策略服务（`sandboxPolicy.resolve({ session })`）再作第 5 参
  传出，写界与内置工具对齐；服务缺失时第 5 参缺省逐字节复刻旧调用形状（旧宿主/裸后端
  零回归）；`FS_SANDBOX_DENIED` 改写为可行动提示（保留宿主原文）。回归 4 例：
  会话策略线程 / 服务缺失形状 / 拒绝文案改写 / REST 平面同值回落。
- **细纲禁项解析器纠偏：假禁词两连拒 + 禁令静默失效（墨骨录会话实录双缺陷）**。①前置否定句式
  （「不得出现X」）里主语正则（`{1,8}?` 下限=1，引擎回溯到最短可行）把**否定词本身**捕获成禁词
  → 正文含「不得」二字即误判命中；②「不得让沈无咎说出…」按**人名**收禁词 → 主角名在正文无处
  不在，必命中——真正想禁的是引号里那句话。同发现三处静默失效：「禁止现代词汇（法医、指纹…）」
  整行漏解析（枚举禁词全灭）、「不得点破X」漏解析、**裸词表行**（`墨银、沈慎、法医…`，写手被
  迫改格式绕门禁后的产物）解析为空=门禁失效。修法：否定词永不入禁词表；「不得让X登场/出场」
  人名即禁词、「不得让X说/做…」人名归条件型+引号宾语收禁词；前置否定收宾语；顿号枚举逐项拆、
  「等」尾去；许可/指称语境（只许以「X」模糊指称/用语用《X》）归条件型；裸词表行逐项生效。
  账本冲突文案补指引（同一键同章只落一行终态，过程变化写备注）。回归 4 例 + 真书细纲数据
  验证（墨骨录 step5 版与裸词表版双向过）。
- **面板扫书根推导 Windows 修正：「小说生成在盘上、锻炉面板永远空」（真机实锤）**。旧实现只从
  `~/.dsh/sessions` 目录名反推会话工作区（`--Users-me-Doc-novel--` → `/Users/me/Doc/novel`），
  这条链路是 POSIX 专属：Windows 的 `D:\X` 反推成 `/D://X`，statSync 验证必然失败被整体跳过
  → 扫描根只剩 web 进程 cwd → 非进程 cwd 目录里的书永远不进列表。修法 = 三源合并（全部
  statSync 验证后采用）：① live sessions（新增 `sessions` inject 声明，`header.cwd` 是宿主
  校验过的绝对路径，面板正开着的会话必在其中——最准一手来源）；② `session_projcache.json`
  的 `identity.cwd`（持久层，实测 81/81 会话带 cwd，无损跨平台）；③ 目录名反推降级保留
  （POSIX 兜底）。`deps.homedir` 注入缝让测试封闭（旧实现下真机 `~/.dsh` 的真实工作区会漏进
  列表断言）。回归：纯函数 2 例 + live-sessions/projcache 集成 2 例。

## 0.13.6 (2026-09-19)

审查报告第二、三批（高 / 中 / 轻微级）全部落地；随后复核审查修复本身，补上**四处「修到数据层就停手」或「名义修复」**的账——本轮把它们真正落到用户可见的行为上，
并把 REST 半边天的测试护栏从零建起来。

- **aria-label 真正生效**（上一轮声称已修，实际无效）：Btn 只认 camelCase
  `ariaLabel`，而三个图标按钮的调用点写的是 kebab-case `'aria-label'` —— 键名对不上
  不报错，无障碍名照旧被静默丢弃（与 0.13.0 的 `dataset.no` 事故同族）。Btn 改为两种
  写法都收，调用点统一 camelCase，并补「渲染结果里必须有 aria-label」的断言。
- **门禁提示进面板**：applyProposal 此前已返回 gate（死人复活 / 隐藏人物泄底），
  但 panel 只读 chapter/version，gate 被丢弃 = 用户端仍然静默。现在 gateNotice 进
  state、在详情页渲染（阻断红字、警告琥珀），notice 里也留一条计数。
- **删除确认态不跨书存活**：openProject / goBack 漏清 `deleteState`，在 A 书点过
  「删除」→ 打开 B 书后**单击即删**（两步确认失效）。同族修掉列表删除的 `'busy'` 哨兵
  （确认行整行卸载、视图「删除中…」分支永不可达）→ 改独立 `listDeleting`；
  详情页 busy 态补视觉反馈。
- **REST 面加固**：POST /projects 建书从 `auto` 改 `'create'`（同名书过去会被
  defaultNovel 整体覆盖，章节索引/会话归属丢失、正文成孤儿）→ 409 BOOK_EXISTS；
  非法书名从 500 IO_FAILURE 改 400 BAD_BOOK；GET chapters/:no 补与 POST 同款的
  正整数守卫（过去 NaN 当键查恒返回空串，看着像「这章是空的」）；删掉白名单之后的
  死分支 `..` 判断。
- **落盘后的审计失败不再拖垂整章**：saved 审计行写失败（并发版本冲突）会让
  commitChapter 整体抛错，调用方（含批量起草）把已保存的章报成失败 → 重试造重复版本。
  改 console.warn 降级（静默降级不等于静默）。
- **检索幽灵块出口过滤**：索引清理只发生在全量 build，删章后未重建前 query 仍会命中
  指向不存在章节的块 → 按现有章号过滤并给重建提示；sqlite 句柄补 try/finally。
- **提案链与 REST 写路径的丢更新（H2 根因修复）**：新增乐观并发通道
  `readJsonWithVersion` / `writeJsonAtVersion` / `updateJson`（读时捕获基线版本 →
  守卫写 → 冲突则**重读最新内容重放**，默认 3 次），提案的登记/应用/丢弃/清理、
  REST 的认领/改名/章节保存/世界书 CRUD 全部改走它。
  上一轮那句「writeJson 缺省 'auto' 已是版本守卫」是**看着有、实际拦不住**的东西：
  'auto' 在写前一刻才 stat，版本永远匹配，陈旧对象照样把别人的更新整体覆盖掉
  （幽灵提案、自增 id 撞车都源于此）。据此**删除** `writeTextIfVersion`——
  守卫基线必须由调用方从读取那一刻带进来。附带修掉世界书删除的假成功：条目不存在
  时不再无条件写回（原先连 `世界书.json` 都能凭空建出来）。
  同一条链上最后那个旧快照回写也补了：`rememberSession`（每个工具入口都走，含
  `isConcurrencySafe` 的读工具）原先把调用方手上的整本 novel 写回盘 —— 与面板并发时
  正是幽灵提案的另一条成因；现在只重放「补一条会话归属」这个增量（并把归属同步回
  手上的对象，免得随后 saveBook 又把它写丢）。
- **导出不是自毁通道**：`novel_export` 的 `file` 过去只要落在本书目录内就行，于是可以
  指到自己的 `novel.json` / `账本/facts.json` / `.novel/audit.jsonl`，`replace` 一次
  就把索引与账本抹掉。现在只允许落在 `书/导出/` 内（白名单目录比黑名单文件稳），
  参数描述同步收紧。
- **杂项**：openForgeTab 的 disposer 接进 ctx.effect 清理（卸载后最多 30s 的重试链
  不再照跑）；session-watch / index 头注释订正为「常驻独立 tab」的现实。
- **repair 孤儿正文扫描**：列出盘上有、索引没引用的 `正文/*.md` 进 orphanFiles——
  提案重放中途失败留下的孤儿版本文件有了确定的发现通道。四处收口一并做完：
  扫描**挪到对账之后**（被整条移除的记录留下的正文此刻才成孤儿，扫在前面必漏报）；
  「在用」判据除 `files[]` 外再收 `chapterRelPath(rec)`（path 优先是读取语义，
  手工把 path 指到 files 之外时那文件仍在被读写）；正文目录收进
  `pathsFor().chaptersDir` 单点定义（另拼字面量的失效方式是目录改名后扫描静默扫不到
  → 报「零孤儿」的假清白）；`orphanFiles` 数组给全量而 `next` 只列前 20 个 +
  「另有 N 个」，措辞去掉 `rm`（本工具对用户文件只报告不删，确认可弃交给回收站）。
  仅报告不删除；schema 同步声明，audit 带 orphan 计数。兜底清理钩子不做：
  事后自愈、纯防线、不碰热路径。
- **真机复验炸出的旧病：面板存过章的书调 novel_project status/repair 必报
  value is not lossless JSON**：REST 面板存章走 chapterRecord 不传 summary，
  undefined 原样进记录、落盘后 summary 键整个消失，status/repair 的输出装配
  `summary: c.summary` 把 undefined 带进宿主 → 整次调用被拒（与 0.13.3
  novel_style 同族）。修三层：chapterRecord 缺省补 `''` 且保留 prev.summary
  （工具写的梗概不被面板再存抹掉）；status/repair 出口 `c.summary ?? ''`
  （治愈已在盘上的旧记录）；smoke 补「REST 形状章记录 + 孤儿文件」端到端回归。

- **REST 写语义与工具面同构**：createServerFsio 的 writeText/writeJson 补
  create/replace/auto 三种 mode（此前 mode 参数被静默丢弃，'create' 的
  「存在即失败」在 REST 路径变成无条件覆盖）；缺省 auto = stat→replaceIfVersion
  版本守卫写。
- **提案全链路版本守卫**：登记 / 应用 / 丢弃 / 清理写 novel.json 全部走守卫写，
  面板连点两次「应用」不再可能互相覆盖；提案 id 加随机后缀，同毫秒提交不撞。
- **提案应用附内容门禁 notice**：应用后返回 gate（ok/blocking/warnings），
  死人复活、泄底当场有话可说（不拦——应用是用户主权动作）。
- **REST 创建书加固**：workspace 只收扫描根集合内的路径（越界 403）；
  slug 与工具侧同规校验；请求体 4MB 上限；会话工作区解码失败留 warn 日志
  （书「静默消失」可查）。claim / rename / delete 补审计行。
- **账本语义修正**：queryFacts「最新值」按章号取最大（同章取后写入）——补录
  早章不再冒充当前值；applyFactUpdates 冲突条件从 `>=` 改 `===`，补录更早
  章节放行（与报错文案一致）；账本冲突计入熔断计数；`now` 改为必填参数
  （纯函数不取钟）。
- **简报供给对称**：factsDigest cast 实体优先、其余实体（门派/地点/信物）跟上，
  与一致性检测的口径一致。
- **子代理传输接重试**：engine.retries 此前只对直连路径生效（web 主路径恒
  attempts=1）——接上与 run() 同款重试循环，只重试 SUBAGENT_FAILED /
  EMPTY_RESPONSE，超时/截断/取消不重试。
- **检索修正**：全量 build 清掉书里已不存在章节的索引残留；索引路径 cwd 拼接
  前先确认本地后端（否则退化关键词匹配）；annotate 用 try/finally 关 sqlite
  句柄。
- **工具面小修**：novel_ledger query 实体支持「、」多值（与 status_at 对齐）；
  glossary remove 不存在的术语报错（不再静默）；人物卡 save 拒空白名与路径
  分隔符；novel_outline save_book/save_chapter 先验书存在（不再写幽灵目录）；
  novel_export 的 file 覆盖路径限本书目录内；场景序号剥离必须带分隔符
  （「12岁少女」不再被吃掉序号）；人称检测句边界补 ASCII `!?`。
- **批量起草**：取消信号留下的空洞不再产出没有章号的幽灵结果行，改为明确
  计数提示。
- **面板竞态与交互**：体检/诊断加切书序号守卫；保存章后核对「同书同章同快照」
  再标干净；刷新按钮走未保存确认；批量起草落盘后重载编辑器中的受影响章
  （防旧稿盖新版本）；删书确认态不再闪烁、进行中忽略重复点击。
- **听书**：暂停落在取文窗口时恢复可续播（不再假暂停）；无句读超长段按字数
  硬切（整段塞给 TTS 引擎被拒）。
- **文案与无障碍**：设置页能力清单更新（写单章 / 结构诊断面板已能做）；
  Btn 透传 aria-label（图标按钮对读屏器可名）；熔断文案说清计数清零条件。

测试面（这次的重点是「护栏别只修半边」）：

- **REST 数据面首批行为测试** `test/server-api.test.mjs`（13 例）：路由清单驱动的
  fence 全覆盖（将来加端点漏 trusted() 必红）、workspace 白名单、非法书名 400、
  重复建书 409、章节号守卫、章节保存写审计、createServerFsio 的 create/replace/auto
  intent 语义。**假 fs 按宿主 dsh-fs 真语义实现 createIfAbsent / replaceIfVersion
  拒绝**（沿用「替身必须镜像真机」的纪律）。
- **H2 的回归钉法**（关键是让替身真能造出冲突，否则测了个寂寞）：
  `test/batch5.test.mjs` 的内存 io 补上与生产同名同义的 `readJsonWithVersion` /
  `writeJsonAtVersion`（版本按内容长度变化，版本不符抛 `FS_STALE_VERSION`），
  `test/server-api.test.mjs` 的 R6b 从「记录现状·待修」翻转成**断言不丢更新**
  （并发新增世界书 → 两条都在且 id 不撞；并发保存同一章 → 两个版本各占一号、
  正文文件互不覆盖），并新增 `updateJson` 重放用例（读写之间被插一刀 →
  `attempts >= 2` 且两边更新都留得下来）与 `submitRevisionProposal` 幽灵提案用例。
  `test/logic.test.mjs` 改测新原语的 intent 逐字段正确性（原 writeTextIfVersion 用例退役）。
- 面板新增 7 例（gate 进 state、门禁干净不吵、删除态跨书、goBack 清理、列表删除在途、
  Btn 两种写法、目录图标按钮端到端 aria-label）；工具面补 2 例（saved 审计写失败、REST 形状章记录的 status/repair + 孤儿通道）。
- 孤儿扫描收口的回归 3 例：path-only 记录被对账移除后其正文**必须**出现在 orphanFiles
  （钉住"扫描在对账之后"这个顺序）、25 个残留时数组全量而 `next` 折成「另有 5 个」且
  不得出现 `rm`、`chapterFile` 必须由 `chaptersDir` 派生。README / demo 尾帧里写死的
  用例数一并去掉（加三条用例 272 就成了假话，顶部 tests 徽章才是真相）。

- 测试 274 项。

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
