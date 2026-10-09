# Changelog

## 0.16.1 (2026-10-09)

### 会话交接真机修复（2026-10-09，403 用例全绿）

- **命名（用户钦定）**：新会话 `《书名》续写` → **`书名-YYMMDD`**（如 `开局觉醒加特林-261009`）——归属一眼可见，按名称排序即按时间排序。
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
