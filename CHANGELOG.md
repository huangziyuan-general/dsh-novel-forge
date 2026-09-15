# Changelog

## 0.13.1 (2026-09-15) — 深色主题配色修正 + 按钮按下反馈 + 装配期炸 boot 修复

仙尊深色主题下实测：「配色不好看，刷新和导入按钮没有按下效果」。修完主题当晚重启 dsh，
又炸出第三个问题（比前两个都严重）：**插件装配期直接炸掉整个宿主 boot**。三件事，三个根因。

### 🔴 根因三：装配期探测 `ctx.llm` 炸掉整个 boot（0.11.0 起潜伏）

重启 dsh 后 boot 直接抛 `plugin tree failed to load` →
`cannot get property "llm" without inject`，栈指向 `lib/index.js:123` 装配期调用的
`engine.isAvailable()`。**0.11.0 引入 D1 引擎以来一直潜伏**——单测的假 ctx 访问缺失属性
返回 `undefined`（不抛），而真机 cordis 的 ctx 是 proxy：**访问未注册服务的属性直接 throw**。
之前没炸只因为 dsh 一直没重启、旧进程还载着旧代码。

cordis 的真实语义（读源码 `cordis/lib/index.js` get trap 确认）：服务**已注册**
（在任何可达 fiber 的 store 里）即可直接解析、**无需 inject**；未注册时访问才抛错。
所以「调用时自检」的设计本身成立——错在**装配期（boot）宿主服务大多还没注册**，
此时探测注定抛错。修法：`lib/engine.js` 新增 `readService()` 助手，全程 try/catch——
把抛错当作「暂时缺失」，可用性天然变成**每次调用时**的判定；`lib/index.js` 装配期
日志不再下结论（只报「已挂载，可用性在首次调用时探测」）。回归用例用 Proxy 模拟
cordis 抛错 ctx，锁住「装配与调用都不炸、返回可读错误」。

> 教训进 MEMORY：**替身 ctx 的「访问缺失属性返回 undefined」与真机 cordis 的「访问即抛」
> 不等价**——凡是「自检/优雅降级」类设计，必须在真机 boot 验证一次，单测全绿不算数。

### 🔴 根因一：两处 token **语义**误用（名字存在，但用错了地方）

比 0.13.0 的「名字不存在」更隐蔽——这四个名字都是真的，只是语义搞反了：

- `label-dimmed` 当「弱化文字」用 → 浅色下它是 `#e1e5ee`（**近白**）、深色下是
  `#43454a`（**近黑**）：它根本不是文字色（疑似滚动条/装饰用色），两个主题下都不可读。
  弱化文字回归 `label-tertiary`。
- `bg-overlay` 当「输入框/胶囊底」用 → 深色下它是 `#61666b`（**中亮灰**），
  这就是截图里搜索框和胶囊「发亮发闷」的来源。输入底回归 `bg-layer-1`。

教训：**token 名存在 ≠ 用对了**。核名之外还要核语义——去主题包里把浅/深两块的真实
色值解析出来看一遍再决定用它做什么。

### 🔴 根因二：内联样式**压不过** `:hover` / `:active`

整套 UI 全是内联 style 对象，而内联样式优先级高于任何伪类规则——
所以按钮**天然不可能有**悬停/按下反馈，不是忘了写。修法是加一层真 CSS：

- 新增 **`src/client/css.js`**：`buildCss()` 以 `[data-dsh-novel-forge-panel]` 为作用域根
  生成样式表（38 条规则），`ensureStyles()` 注入 `<style id="dsh-novel-forge-css">`
  并**幂等**（重复调用/无 document/传 null 都安全返回 null）。
- `Btn` 原语改输出 `data-nf-btn` + `data-variant` + `data-size`，
  底色/描边/文字/圆角交给 CSS，布局（尺寸/间距/行高）仍走 `btnLayout()` 内联——
  **外观走样式表、布局走内联**，分工清楚。
- 每个变体（primary/secondary/ghost/accent/danger）都有完整
  **rest / `:hover` / `:active` 三态**，active 带 `translateY(1px)` + 内阴影（真实按压感），
  `:disabled` 全部豁免；过渡 `transition: background-color, border-color, color,
  box-shadow, transform`。
- 可点区域统一 `data-nf-tap`（悬停亮 + 按下沉），分段控件 `data-nf-seg` +
  `data-active` 四态由 CSS 管；输入框补 `:focus` 焦点环，`summary` 补悬停。
- **深色观感**：底色层级用 `bg-layer-1/2/3` 递进而不再靠半透明叠，卡片和页面底在深色下
  拉开层次；主按钮用宿主官方三元组 `button-primary-fill/-hover/-dimmed`。

### 章节字数标准（2026-09-15 补，仙尊定的规矩）

机审门槛默认值原来是 **500–12000 字**——下限形同虚设，模型写多短都放行，且提示词里
**没有任何目标字数**。现按正常网络小说连载标准收口为 **单章 2000–4000 字（目标 3000 左右）**，
与 `platform-review.js` 里已有的起点标准对齐：

- **`lib/index.js`**：`minChapterChars` 500→**2000**（机审拒绝线），`maxChapterChars`
  12000→**4000**（超了提示拆章）；`lib/mcp-standalone.js` 默认值同步。
- **`lib/briefing.js`**：写前简报新增**「本章字数目标」段**（下限/上限/目标值随配置生成，
  「字数不够就把细纲场景写细写透、不要注水凑字」）——简报是写章上下文的唯一收口，
  会话写章与 D2 批量起草天然都吃到。
- **`lib/batch-draft.js`**：D2 起草系统提示补第 9 条硬要求（字数区间 + 收钩子）。
- **`lib/tools/writing-tools.js`**：`novel_write_chapter` 描述开头声明字数标准——
  模型动笔前读的就是它。
- 回归 2 条：Config 默认值锁死 2000/4000；简报必含「本章字数目标」段且目标值算对。

### 章节阅读器（0.13.1 补，仙尊：红框位置加上阅读和朗读）

章节听书的目录行原来只有 ▶（朗读）——想看正文得回编辑区。现每行加 **📖 阅读钮**：

- 点 📖 → 目录上方展开**阅读卡**：章号 + 标题 + 正文（最高 420px 可滚动，网文排版行距）；
- 卡头自带 **「▶ 朗读本章」**（复用 `play-from`，看完想听一键切）和 **✕ 收起**；
- **阅读与播放互相独立**——可以一边听一边看；
- 章号契约与播放钮一致：只认 `data-id`，拿不到就报错（同 0.13.0 的事故教训）；
- 请求竞态防护：连续点不同章的 📖，晚到的旧响应不会覆盖新章（`reader.no` 校验）；
- 换书自动收起阅读器（它属于「上一本书」）。
- 回归 1 条：📖 真取正文落 reader、✕ 清空、章号缺失必须报错。

### 书卡「名称与下方重叠」修复 + 守卫写（0.13.1 补二）

**书卡重叠（双根因）**：

- 书卡标题按钮是裸 `<button>`（TAP，非 Btn）——样式表只重置了字体，**UA 默认 ButtonFace
  灰底透出来**，书名底下天生长出一条灰色横条。修法：`${ROOT} button` 规则补
  `background: transparent; border: none`（真按钮 `data-nf-btn`/`data-nf-seg` 权重更高，不受影响）；
- 热区扩展负边距原来四边都扩，**底部负边距把标签行拉上来贴住按钮背景**，间距归零。
  修法：热区只向上/左/右扩（`padding: xs sm 0` / `margin: -xs -sm 0`）。

**守卫写与优化批（含仙尊手改的复核补全）**：

- `server-api.js` 认领/写章记录改用 `fsio.writeTextIfVersion`（版本守卫防并发覆盖）——
  **但该方法原本不存在**（REST fsio 没有它，且无测试直接驱动 REST+真实 fsio，全绿是假阴性）。
  补上 `createServerFsio.writeTextIfVersion`（stat→`replaceIfVersion`，无文件则普通新建）+ 回归 1 条；
- `phases.js`：force 放行未过门禁时 report status 由 `'approved'`（恒真三元）改为 `'in_progress'`——真 bug 修复；
- `forge-tab.js`：自动开 tab 的重试循环支持 dispose（返回清理函数，停重试）；
- `server-api.js`：会话工作区根扫描加 60s TTL 缓存；`scanBooks` 对非法 JSON 的书给 console.warn（不再静默跳过）；
- `contextpack.js`：`chapter` 默认 1（唯一调用方 briefing 总是显式传）。

### 题材 chip 显示中文（0.13.1 补二，仙尊：这个怎么有英文）

面板创建表单**没有题材输入框**，早期却把默认值写死成英文 'fantasy' 随创建发给服务端
（服务端兜底也是 'fantasy'）→ 面板建的书全是英文 chip。三层修法：

- `state.js` 默认值改空，创建时空值不传；服务端兜底 'fantasy' → '未分类'（对齐工具侧默认）；
- **新增 `src/client/genre.js`**：`genreLabel()` 显示层映射 21 个常见英文题材
  （fantasy→奇幻、Sci-Fi→科幻、xianxia→仙侠…，忽略大小写/连字符/空格），表外原样透传；
- 列表页与详情页的题材 chip 接入——**存量书不动数据，fantasy 自动显示为奇幻**；
- 回归 1 条（7 断言）：映射/透传/trim/空值安全。
### 克隆为模板上面板（0.13.1 补三，仙尊拍板：只做克隆、不做书库 UI）

克隆规则原本长在 novel_clone_project 工具里，面板要做按钮就得走 REST——同一套复制规则不能抄两份：

- **lib/clone.js（新）**：克隆核心抽成共享函数（章节按版本复制重建干净索引、大纲/细纲按目录实列、
  人物卡/世界书/账本/伏笔/术语表/场景契约/语言基因全带走、阶段重置 topic、提案与熔断清空、
  审计落**新书** audit.jsonl 带 actor）；工具面与 REST 各接一头；
- **REST**：POST /projects/:id/clone —— 克隆进源书所在根，归属打 body.session；目标重名/源不存在/同名克隆在共享核心里拦；
- **面板**：书卡操作行加「⧉ 克隆」（与改名同款内联表单：新书目录名必填 + 克隆/取消），互斥打开，
  成功后刷新列表，新书带会话戳直接出现；换书/返回列表自动收起表单；
- createServerFsio 补 listNames（与 createFsio 同名同义，细纲目录实列复制要用）；
- 回归 2 条：cloneProject 内存 io 全链路（含防呆三连）+ 面板克隆流（缺 data-id 报错 / 空名被拦 / POST 契约）。

### 测试

**202/202 全绿**（0.13.0 是 185）。新增 17 条：每个按钮变体的三态规则齐备性、
tap/seg/focus/summary 规则存在性、`ensureStyles` 幂等与降级、样式表注入不破坏渲染、
**cordis 抛错 ctx 下引擎装配与调用不炸**、**字数标准两条**、**守卫写两条 intent 分支**。
假 DOM（`test/helpers/dom.mjs`）顺带补齐 `head` 与 `#id` 选择器——样式表注入路径从此可测。

## 0.13.0 (2026-09-14) — 锻炉面板重做：设计系统 + 把已有能力接上界面

仙尊一句「锻炉页面太难看，帮我根据功能做一版 UI」。查下去发现**难看的根因不是配色品味，
是面板一直在用不存在的变量名**，外加**一半已经做好的能力在界面上没有入口**。
所以这一版既重做视觉，也把「功能与界面」对齐。

### 🔴 根因：4 个 token 名在宿主里根本不存在

`styles.js` 从 0.5.0 起就用 `--dsw-alias-accent-strong` / `accent-soft` /
`label-danger` / `bg-primary` 这四个名字。核宿主 `dsh-client-ui-theme` 的导出表后确认：
**四个全不存在**（宿主里 `accent` / `danger` 只出现在 `interactive-bg-hover-accent`
这类交互态名里）。于是每处 `var(...)` 都落到写死的**深色回退值**上——
面板在浅色主题里就是「一块深色糊字」，跟随主题的能力**从未生效过**。

修正为宿主真实 token：`link`（强调）/ `state-error|warn|success-primary` /
`bg-layer-1|2|3` / `bg-overlay` / `border-l1..l4` / `interactive-bg-hover` /
`button-primary-fill` + `label-primary-foreground`（主按钮官方配色搭配）。
回退值统一改成**双主题可用**（`inherit` / 半透明灰 `rgba(128,128,128,α)` / 中调语义色），
不再写死深色。软底与软描边改用 `color-mix(in srgb, <语义色> N%, transparent)`，
**自动跟随主题**，不必为浅深各写一套 rgba。

### 设计系统（`src/client/styles.js` + 新增 `src/client/ui.js`）

三层：语义色 → 尺度（space/radius/font/weight）→ 组件（card / btn / chip / field /
meter / emptyState / stageRail / fold）。视图不再各自拼 style 对象——**同一件事只写一次**，
改一次颜色不用翻六个文件（这正是 0.12 之前「哪里都不一样」的来源）。
新增 `ui.js` 原语层：`Card / Section / Btn / Chip / Stat / StageRail / Meter / Empty /
KV / Fold / Mono`。

### 五个视图重做

- **项目列表**：书脊卡（左侧色条）+ 标题/类型/有基线胶囊 + **九阶段轨道**（阶段链取自
  `lib/phases.js`，单一定义，不在视图里另抄一份）+ 统计块（章/台账/伏笔/角色，
  伏笔超期自动转警告色）+ 图标操作行。顺带修一个**从未生效的字段**：列表项读的是
  `p.styleBuilt`，而服务端返回的是 `p.style.built` —— 「有基线」徽标一直没显示过。
- **详情页**：面包屑（书名 + 阶段胶囊）+ 分段控件、档案卡（含 logline 引文块）、
  要素统计块、**时间线改竖轴**（账本的价值在「按章推进」，平铺成灰字就看不出这件事）、
  伏笔状态胶囊（已回收/超期/未回收）、提案队列升格为待批高亮卡（批准钥匙在这里）。
- **章节听书**：置顶播放条（正在读哪章 / 暂停 / 停止 / 目录总字数）+ 目录行（播报中行
  高亮 + 圆形播放钮 + 版本胶囊）。
- **世界书**：条目卡把「什么会被注入」摆明——常驻／停用／优先级／关键词胶囊，
  无关键词的常驻条目给一句「靠常驻注入，不会被触发」。
- **设置**：从三行只读清单扩成「已装配 + 这个面板能直接做 + 只能回会话里做」。
  后半张表是**如实交代边界**：一键写章仍是 501（要走 briefing + 落盘门禁），
  不再拿一个点了没反应的按钮糊过去。

### 把已有能力接上界面（4 个真端点）

服务端早就有了，界面却还给「需要模型参与」的引导——本版全部接上：

| 动作 | 端点 | 界面行为 |
| --- | --- | --- |
| 一键润色 | `POST /projects/:id/chapters/:n/polish` | D1 旁路引擎；产物是**提案**，不落正文 |
| 机械校对 | `POST /projects/:id/chapters/:n/proofread` | 同上，守卫更严（篇幅上限 1.06） |
| 全书体检 | `GET /projects/:id/continuity` | 死人复活 / 账本矛盾 / 伏笔超期 / 章号断档 / 人物卡缺失；零 token |
| 批量起草 | `POST /projects/:id/draft-batch` | 并发生成、串行提交；逐章成败摊开，被拦不算整批失败 |

两条工程细节：
- **超时必须放宽**：润色/校对通道超时 180s 且默认重试 2 次，用通用 12s 会把正常长任务
  一律误报成「请求超时」——单请求分别给 600s / 900s。
- **错误要翻人话**：`503 引擎未就绪` / `409 无路由` / `422 守卫拦下` / `499 中止`
  各有各的处置（「守卫拦下」明确告知**正文没动**），不再把原始 message 直接糊到界面上。

### 设置入口常驻头部

详情页与世界书页原本够不到设置（那个按钮只在列表页）。现在头部常驻一个 ⚙，
面板的「能力清单」永远一步可达。

### 新增：可交互 UI 预览（`npm run preview`）

`scripts/preview-ui.mjs` 生成 `preview/forge-ui.html`（单文件，内联客户端产物与 React 运行时，
**离线可开**）。刻意不是手搓 mock：页面里跑的就是 `lib/client.js` 本体，样式取自宿主
**真实的**浅/深两套 token（从 `dsh-client-ui-theme` 原样抽出），点按钮走的是面板真正的
事件代理 —— 手搓的预览必然会漂移（改完样式忘了改预览，于是预览好看、真机还是丑）。
这份预览在开发中当场抓出两个真问题：`overview.js` 少导入 `KV` 导致整块渲染失败、
以及 markdown 星号漏进界面文案。

### 🐛 同版修复：整列「▶」与顶部「从第 N 章开始听」点了毫无反应

仙尊装上一试即报「UI 部分按钮点击无效」。真因是**两头属性名对不上**：

- 视图写 `Btn({ action: 'play-from', id: c.no })`，而 `Btn` 把 `id` 渲染成 **`data-id`**；
- 控制器读的却是 **`dataset.no`** —— 全项目**没有任何地方写过 `data-no`**。

于是 `Number(undefined)` = `NaN` 一路传进播放器：`synth.cancel()` 先把状态置 `playing`，
`loadChapter(NaN)` 取不到正文，`nextChapterAfter(NaN)` 也找不到下一章，回调里 `finish()`
把状态**还原成 idle**。前后两次 emit 长得一模一样，界面上看就是「点了没反应」——
不是没执行，是**执行完又退回去了**。

修法：控制器统一按 `data-id` 读章号（与 `open` / `claim` / `lore-*` 一致），
并且**拿不到章号就报错**，不再静默。

**这个 bug 能活下来，靠的是两处「看着没问题」**：

1. **既有用例照着实现编了 dataset**：`handleAction('play-from', { dataset: { no: '2' } })`
   —— 替身 mirror 的是实现，而不是真机渲染出来的属性。实现读错字段，用例照样全绿。
   （正是 AGENTS.md「替身必须镜像宿主/真机，不是镜像自己的实现」那条，第三次交学费。）
2. **静态自检只查大写**：此前只找「大写开头的调用」（如 `KV`），小写的 style 助手漏在网外。

**防守**：

- 两条回归用例：锁「章号取自 `data-id`」+ 锁「拿不到章号必须报错、不得静默」。
- 静态自检升级为 `scripts/audit-static.mjs`（`npm run audit`，仍在 `pretest`）：
  **剥掉注释与字符串**再扫（此前把注释里的 `Btn(` 当成了真调用），
  并新增 **「`dataset.X` 读取必须有对应写入」** 这条检查 —— 正好是本事故的类别。
  已用注入探针验证它确实会以退出码 1 拦下。
- 预览页新增**按钮扫射**（`[data-do="sweep"]`）：遍历每个视图逐一点击所有 `data-action`，
  报「点击没送达事件代理」与「送达了但界面无变化」，并把「预览下本就无法判定」的几类
  （mock 不持久化）单列，避免满屏狼来了。它自己踩过一次坑：面板选择器少写 `dsh-` 前缀 →
  恒判「无变化」，把整页按钮都报成坏的 —— 已改成**拿不到面板根就直接报错**，不再产出假报告。

**测试**：185/185 全绿（+2 条回归用例）。另加两道自查：

- **可交互预览即验收**：`npm run preview` 跑真产物 + 真 token（见上）。
- **静态自检** `npm run audit`（已进 `pretest`）：①「调用了但没导入/声明」与「导入了但没用」；
  ②「孤儿 `dataset.X` 读取」。**为什么必须有**：`src/client/` 少一个 import，构建**不报错**
  （打包成 factory 后是运行时 ReferenceError），单测又只覆盖控制器不覆盖视图渲染 ——
  这正是 `overview.js` 少导入 `KV` 导致整块空白却全程绿灯的路径。两类问题都按**硬故障**退出码 1。

## 0.12.0 (2026-09-14) — 融合收官：角色状态时点推演 + 书库饲料（工具 19→20）

第五批交付后回查总览表，发现四条没落地：**B2 / G2 属原始 18 条**，H1 / H2 是表外补充。
本批把真正该补的两条做完，另两条**判定不做**（理由见 `docs/FUSION-PLAN-2026-09-14.md`
的「未落地项盘点」：H1 乐观并发 / H2 事件哈希链的威胁模型是「多人同改、第三方稽核」，
而本插件是单机单人写作，属过度设计）。**A~G 的 18 条至此 18/18 收官。**

### B2 · 角色状态时点推演 —— 回答「第 12 章时他是什么状态」

**问题**：`queryFacts` 只给**最新值**。写到第 80 章想回溯「第 12 章他在哪、什么境界」，
或者核对「第 40 章断腿、第 50 章还能跑」，拿最新值是算不出来的——这是账本侧的真缺口，
不是「再加个查询参数」能补的。

**改动**：
- `lib/ledger.js` 新增 `factsAt(facts, chapter, {entities, keys})`：**时点快照**。
  取 `chapter <= n` 的记录里**章号最大**的一条（同章取最后写入）。注意**不能取数组最后一条**
  ——补录早期章节是常态（先写第 12 章、后补第 3 章），那会把新值覆盖成旧值。
- 新增 `statusTimeline(facts, entity, {keys})`：单实体状态演化线（按章升序），
  对账「这个值是哪一章被改掉的」。
- `novel_ledger` 新增两个动作：`status_at`（时点快照）、`timeline`（演化线）。
  工具面 4 → 6 个动作，**没加新工具**——按「纵深优先」原则。
- `lib/continuity.js` 新增 `posthumousChanges(facts)` 并并入 `validateContinuity`：
  **账本级**的「死后仍在活动」。与既有 `scanDeadReappear` 是互补而非重复——
  那个扫**正文里的实体名**（会误伤「有人提起亡者」「灵位遗物」），这个扫**模型主动落的账**
  （语义明确、误报率低），且能抓到名字根本没出现的状态矛盾。
- 顺手补死亡词表：`战死 / 殉难 / 殉职 / 殉道 / 遇害 / 气绝 / 驾崩 / 玉殒`。
  **「战死」原先竟不在表里**（表里有「死战」这个反例词，却没有最常见的死法之一）。
  反例表不动——`死战 / 拼死一战 / 不死之身 / 生死未卜` 仍全部正确排除。

### G2 · 书库饲料 —— 「学别人怎么写」从凭感觉换成看数字

**定位**：全插件唯一**不服务于「写下去」**的能力。所以刻意与书目体系隔离——
饲料不是稿件，没有审计、不进上下文包、不参与本书一致性判定（对照标准是别人，不是本书）。

**改动**：
- `lib/library.js`：`chaptersFromText`（复用正文导入的标题识别）、`analyzeStructure`、
  `compareStructures`、`repeatedPhrases`、`coefficientOfVariation`、`libraryId`。
  落点在工作区根的 `书库/`，与各书目平级——**多本书共享同一批饲料**。
- `lib/tools/library-tools.js` + `novel_library`（**第 20 个工具**）：
  `import`（给 path 读工作区文本文件，或直接粘 text）/ `list` / `read` / `analyze` / `delete`。
- `analyze` 产出的可参照数字（**纯本地零 token**）：章节长度曲线（均值/中位/极值/**波动 cv**）、
  对话密度（引号内占比）、段落节奏、**章末钩子率**（复用 `hook.js` 的四类判定）、
  前 3 章均长、单句均长、高频意象。给 `compare_book` 时与自己的书**并排**给数——
  这才是拆书的用处：把「该写多长、多少对话、章末怎么收」从感觉换成数字。
- **重复短语挖掘不做分词**（无依赖可用，且中文分词器对网文特有名词更差），改用 3–4 字
  n-gram 频次 + 两层抑制：被更长高频串**包含**的丢弃；**周期串错位窗口**也丢弃
  （「青铜古灯」重复三次会产生「古灯青铜」「灯青铜古」——它们必然出现在 `k+k` 里）。
  实测连续重复的极端输入只剩 `青铜古灯×3` 一条。
- **`delete` 只移索引，不删原文**：宿主 `ctx.fs` 服务**不提供删除能力**
  （只有 resolve/stat/readText/streamText/listDir/writeText），所以返回里明确告诉用户
  原文仍在 `书库/<id>/` 下、要彻底清除得手工删目录。同时对**同名导入直接拒绝**
  ——饲料删错了没法找回，宁可让用户显式 delete。

### 顺带修掉的两处

- **系统提示条目 16–19 原来是倒序的**（`19. 批量起草` 排在 `16. 发书前体检` 前面），
  是 v0.10.0/v0.11.0 两批插入时埋的。已重排为 16/17/18/19 并在第 1 条补上 B2 的用法，
  新增第 20 条（书库）。
- `COMPATIBILITY.md` 记下「宿主 fs 无删除能力」这条约束（影响所有删除类功能的设计）。

**测试**：173 → **183**（`logic` +7：B2 三条 + G2 四条；`smoke` +3：B2 端到端两条、
G2 端到端一条——含 `delete 不得删原文` 这条硬断言）。

## 0.11.0 (2026-09-14) — 融合第五批：重资产（旁路直调 / 并发批量起草 / 长篇检索）

第五批是前三批的**纵深补课**：把「润色、校对、打标、起草」这些**内部工序**从主对话里
搬出去（D1），把「一章一章地写」变成「一批一批地写但仍有同一道门禁」（D2），
再把「写到一百章后记不住前文」变成一个可检索的东西（G1）。

三件事都不引入新的**真相来源**：D1 不产生新状态（只出提案），D2 不改门禁语义，
G1 的索引是**派生物**（删了重跑即得）。工具数 18 → **19**（新增 `novel_search`）。

PoC 与取舍记录见 `docs/BATCH5-POC-2026-09-14.md`，方案进度见 `docs/FUSION-PLAN-2026-09-14.md`。

### D1 · 旁路直调引擎（`lib/engine.js` + `lib/engine-tasks.js`）

**问题**：润色一章、校对错别字、给段落打标签，本质是**内部工序**——但走主对话调用会
把上下文撑爆，还会污染会话历史（用户看到一堆系统内部往返）。

**做法**：宿主的 `ctx.llm.stream()` 本来就在进程里，插件直接**旁路**调用它，开一条
独立流、拿完就丢：

- **零新增配置**：不需要配 key、不需要选 provider。四条通道
  （`polish` / `proofread` / `annotate` / `draft`）默认**继承当前路由**，
  需要时可在 `engine.channels.*` 里按通道覆盖模型/温度。
- **不占主对话**：旁路流不写会话记录（`attachSession` 默认 `false`），
  用户的历史里只有一次工具调用，没有内部往返。
- **自带超时/重试/中止**：宿主的重试策略**不覆盖**手搓的 llm 调用，所以这里自己实现——
  指数退避重试（默认 2 次）、`classifyFinish` 区分正常结束/截断/拒绝、真中止
  （用 `Promise.race` 消费流，而不是只在循环里查 `signal.aborted`；对不听话的适配器
  也能立刻断开，不再白等）。
- **优雅降级**：cordis 的 `inject` 只有必填、没有可选，所以引擎在**调用时**自检
  `ctx.llm` 是否存在——宿主不提供 llm 时插件照常装载，调用返回可读原因而不是崩。
- **只出提案，绝不改正文**：润色/校对的结果是**提案**（走既有提案制），
  由用户在面板上批准才落盘。旁路引擎再快也动不了正文这件事。
- REST 侧 `/polish`、`/proofread` 从 501 桩改为真调用，并把失败翻译成语义化状态码：
  `503` 引擎未就绪 / `409` 无可用路由 / `422` 越护栏 / `499` 已中止 / `502` 上游失败。

### D2 · 并发批量起草（`lib/batch-draft.js` + `lib/chapter-commit.js`）

**问题**：逐章写章像挤牙膏，而且每章都要模型重跑一遍「上下文包 → 起草 → 门禁」。

**做法**：并发生成、**串行提交**。

- 新端点 `POST /projects/:id/draft-batch`（`from` / `count` / `concurrency` / `force`），
  并发上限 4、**默认 1**（保守起步，作者确认稳定后再往上开）。
- **门禁一道都不少**：每章仍走同一套 `commitChapter` 全链——阶段门禁 → 细纲存在 →
  熔断检查 → 确定性审计 → 事实账本 → 内容门禁 → 契约指标 → 版本 → 审计留痕。
  「并发」只并发**起草**，提交始终排队，因此账本/版本文件的写入顺序和逐章写时完全一致。
- **单章失败不回滚整批**：一章被门禁拦下（或引擎失败），其余章节照常落盘——
  作者拿到的是一份「成了哪些、卡在哪一章、为什么」的报告，而不是全批作废。
- **上下文预算刹车**：书里**没有场景契约**时，并发自动降为 1——
  没有契约就没有「必须写什么」的锚点，多章并发只会批量跑偏。
- `force` 能越过「细纲未批准」「已熔断」，但**永远越不过「已写」**（不会覆盖成稿）。
- 「写章上下文包」抽成 `lib/briefing.js` 单一来源，`novel_briefing` 工具与批量起草共用
  同一份组装逻辑（悬念保护、语音卡、契约裁剪只有一处实现）。

### G1 · 长篇检索（`lib/retrieval.js` + `novel_search`，第 19 个工具）

**问题**：写到几十上百章后，「第 12 章那个戴斗笠的人是谁」靠模型记忆一律失败，
`novel_briefing` 也只给近几章窗口。作者真正要的是**按自己的记忆碎片把那段找回来**。

**做法**：零依赖的本地检索索引。

- **零依赖**：用 Node 22+ 自带的 `node:sqlite`（不引 `better-sqlite3`，
  免掉原生编译三重麻烦）。
- **中文必须自己切分**：实测 FTS5 默认分词器对 2 字查询命中 0，`tokenize='trigram'`
  连 3 字查询也 0 命中。改用手工**二元切分**（`斗笠人 → 斗笠 / 笠人`），
  2 万块规模下查询实测 ~11ms，BM25 排序正常。
- **索引是派生物**：落在 `书/.novel/index.db`（跟着书走，删书即删索引），
  删掉重跑 `build` 即得，**永不参与一致性判定**——正文与 `novel.json` 才是真相。
- 四个动作：`build`（增量建索引，指纹判等，未变的块跳过）、
  `query`（检索，返回章号 + 摘录 + 命中比例）、
  `annotate`（用 D1 旁路引擎给块补语义标签）、`status`。
- **语义增强走路线 C**：宿主没有 embedding 模态，所以标签由 LLM 生成——
  标签与正文进**同一个检索列**，于是查询语法不用变，「决斗」也能召回只写了
  「刀收回袖中」的那段。标签可增量补，成本可控。
- **精度闸门** `min_hit`（默认 0.25）是实测调出来的：再高会误杀「戴斗笠的人」
  这类只记得一个关键词的**真实**查询；记不清时调到 0.15 提高召回。
- **无 sqlite 的运行时自动退化**为子串匹配——功能弱但「找一段」仍可用，且不报错。

### 硬约束新增

| 约束 | 强制点 |
| --- | --- |
| 旁路调用不占主对话、不写会话记录 | `engine.js`（默认不 attach session） |
| 旁路调用自带超时/重试/中止（不赖宿主） | `engine.js`（`Promise.race` 真中止） |
| 批量起草逐章过**同一道**门禁，单章失败不回滚整批 | `batch-draft.js` → `chapter-commit.js` |
| 无场景契约时并发自动降为 1 | `batch-draft.js` |
| 索引是派生物，删了重跑即得——不作为事实来源 | `retrieval.js` / `novel_search` |
| 润色/校对只出提案，改正文要用户批准 | `engine-tasks.js` → `proposals.js` |

### 测试

149 → **173**（新增 `test/batch5.test.mjs` 23 条 + `smoke` 1 条端到端 G1）。
新增的 smoke 用例走真实工具注册跑通 `build → query → 幂等 → 删索引重建`，
是「`node:sqlite` + FTS5 + 二元切分」唯一端到端证据（`batch5.test.mjs` 只覆盖纯函数层）。

## 0.10.0 (2026-09-14) — 融合第四批：流程与角色（九阶段 / 熔断 / 平台审稿 / 敏感自查）

第四批把「什么时候能写、谁说了算」从 persona 建议升级为**引擎判定**。
来源：dsh-novel-writer（九阶段状态机）、多核协同（队长+5 子代理、否决权/熔断权）、
dsh-tool-writing（平台审稿、敏感自查）。工具数不变（18）——四条都是既有工具的纵深。
方案与进度见 `docs/FUSION-PLAN-2026-09-14.md`。

### F1 · 九阶段状态机（`lib/phases.js` + `lib/phase-io.js` + `novel_project phase`）

阶段链由五段扩到九段：`立意 → 设定 → 人物 → 大纲 → 分卷 → 细纲 → 正文 → 修订 → 完稿`，
每阶段带**入场条件**（纯函数判定）与 **PhaseReport**（passed / errorCount / warningCount）。

- 新动作 `novel_project phase`：不给 `stage` 返回看板（每阶段现状 + 入场检查 + 缺什么）；
  给了 `stage` 则**先查入场条件**再进入——「设定没定就想写大纲」「大纲没过就想写正文」
  在这里变成一个 throw，而不是一句提醒。
- **越级可审计**：入场条件不满足仍要推进须 `force:true`；被越过的前置阶段记
  `skipped`，PhaseReport 记下当时的缺口数——「跳阶段」这件事从此有据可查。
- **老书零迁移**：旧五阶段名 `planning/outline/drafting/revising/done` 作为别名映射进新链，
  读、写、展示（含「锻炉」面板的 stageLabel）全都认；`set_stage` 仍是无校验纠正通道。
- `advanceStage` 顺带点亮 `novel.phases[阶段]`，看板与 `novel.stage` 不会各说各话。

### E2 · 熔断权（`lib/circuit-breaker.js`）

多核协同把「同章连续驳回 3 次就重校准」写在 persona 里；persona 拦不住模型，
所以这里配了**落盘计数器**（`novel.json.gateFailures`，章号 → 连续驳回次数）：

- 机审不通过 / 内容门禁阻断 / 细纲禁项命中 → 各记一笔（驳回也要落盘，否则永远数不满）。
- 同一章第 3 次驳回后，`novel_write_chapter` **直接拒绝再写**（连门禁都不跑），
  错误信息给出解除路径而不是一句「不许写」。
- 三条解除通道：**细纲重批**（`novel_outline approve`）、**本章场景契约更新**（`novel_scene save`）、
  `force:true` 放行。任一触发即清零；成功落盘一章也清零。
- 设计意图：反复写不好的根因多半在设定不在文字——熔断是逼回去改设定，不是惩罚。

### E1 · 队长 + 5 子代理（preset persona，纯 prompt 工程）

`agent.cordis.yml` 的 persona 增补三段：**角色分工**（统筹队长 + 世界/剧情/人物/文笔/复核
五个视角）、**通信经济**（派单只给切片、长文本用文件引用代替复述）、
**否决权**（复核视角对硬伤一票否决，冲突 3 轮内终裁）+ **每 3–5 章全局刷新**。
`lib/index.js` 的 systemPrompt 同步补 14/15/16 三条纪律（阶段/熔断/发书体检）。

### C4 · 平台审稿（`lib/platform-review.js` + `novel_audit platform`）

同一章在起点与番茄的结论可以完全相反，所以做的是**两张不同的体检表**（纯本地零 token）：

| 平台 | 检查项 |
| --- | --- |
| 起点 | 单章字数（2000–4000，黄金三章 2500 起）、章末钩子、对话占比 15–45%、移动端段长 ≤200、黄金三章开篇 300 字立冲突、每 3 章爽点节奏、信息密度（动作密度 ≥8/千字） |
| 番茄 | 单章字数 1500–3000、**前 1000 字内给小爽点**、前 3 章打脸/逆转、完读率（段均 ≤150 且对话 ≥25%）、**憋屈时长 ≤1200 字**、章末钩子、句长变异系数 ≥0.35 |

每条给 `value / target / advice`——不是打分，是**改稿清单**。判定复用了已有的
`computeAudit` / `measureMood` / `measureStyleMetrics`，不新增模型调用。

### C5 · 敏感自查（`lib/censor.js` + `novel_audit censor`）

七类：涉政 / 色情擦边 / 暴力血腥 / 赌博毒品 / 封建迷信 / 现实机构影射 / 未成年红线。
命中给**行号 + 上下文摘录 + 改法建议**，`exempt` 可按题材豁免（玄幻里的符咒不必报警）。

- **未成年红线用邻近共现判定**：未成年主体词 与 亲密词在 100 字内同时出现才算命中——
  单出现「小学生」不该报警（校园文天天有）。
- **涉政类刻意不枚举敏感词**，只做语域识别（政体术语 / 群体事件 / 情报机构等通用标记），
  命中即提示人工复核。文件头写明定位：**启发式预筛，不是合规判定，不是免责工具**。

### 顺手修掉的两个真问题

1. **克隆丢资产**：`novel_clone_project` 复制世界书/账本/伏笔/术语表，却漏了
   第三批新增的 `设定/场景契约.json` 与 `设定/语言基因.json`——克隆出一本新书，
   悬念保护和人物口吻全没了。已补进复制清单。
2. **熔断计数不落盘**：驳回路径原本不写 `novel.json`，计数只活在内存里，
   进程一退就归零——熔断永远数不满。现在三条驳回路径都先 `saveBook` 再抛错。

测试：**149 / 149 通过**（0.9.0 为 142），新增 7 条：F1 九阶段（含 skip/force/看板）、
E2 熔断（三条解除通道）、C4 双平台（含憋屈时长与点列式正文的反例）、C5 七类（含邻近共现反例与题材豁免）。

---

## 0.9.0 (2026-09-14) — 融合第三批：上下文工程（场景契约 / 语言基因卡 / 契约指标）

第三批四条解决的是「**上下文喂什么**」的问题——前两批管「能不能写、谁批准」，
这批管「写的时候看得见什么、看不见什么」。全部零 token（纯函数 + 文本注入）。
来源：novel-studio（场景契约 + hidden 人物）、多核协同（语言基因卡）、peterwangze（覆盖率/偏离度）。
方案与进度见 `docs/FUSION-PLAN-2026-09-14.md`。

### B3 · 场景契约 + 隐藏人物（`lib/scene-contract.js` + `novel_scene`）

新工具 `novel_scene`（save/get/list/delete），契约按章存 `设定/场景契约.json`：
`scene` / `participants` / `hidden` / `settings`（世界书白名单）/ `forbidden` / `notes`。

- **省 token**：契约在场时 `novel_briefing` **只注入 `participants` 的人物卡**，
  世界书按 `settings` 白名单取——写长书时不再全书灌入（30 章后上下文不会爆）。
  无契约时退回原行为（工程 cast 全员），老书不受影响。
- **悬念保护（本批的核心）**：`hidden` 里的人物
  ① 档案不进上下文；② **注入区块不写其名**（只报「有 N 人未登场」）；
  ③ 正文一旦出现其名，`novel_write_chapter` 的**内容门禁直接拒绝落盘**（force 可放行并记审计）。
  「不知道就写不出来」——悬念不靠模型自觉。
- `participants` 与 `hidden` 同名＝契约自相矛盾：**保护优先**，从出场名单剔除并给警告。

### E3 · 语言基因卡结构化（`lib/voice.js` + `novel_character voice`）

从「人物卡里的一句话」升级为**结构化实体**（`设定/语言基因.json`，键 = 人物名）：
句长习惯 / 逻辑风格 / 口头禅 / 绝不说 / 标志性小动作 / 语域。

- `novel_character` 加 `voice` 参数（多行「键|值」，支持中文键名与引号容错）；
  `list` 回显谁已建卡。
- `novel_briefing` 把语言基因卡**单独注入成区块**（混在人物卡正文里模型会滑过去）；
  同一角色多章同台时，「怎么说话」比「是什么人」更决定文笔像不像。
- `novel_audit voice:true` 做一致性核对：**说了自己声明过的「绝不说」的词 = 硬伤**；
  有台词却一句口头禅都没有 = 提示（口头禅是习惯不是义务，不扣 OOC 帽子）。

### A3+A4 · 细纲契约指标（`lib/gate-metrics.js`）

细纲里写 `## 本章必写场景`（`- 标题：描述`）与 `## 本章禁止偏离项`，写章时由**代码**算：

| 指标 | 定义 |
|---|---|
| `coverage` | 必写场景命中率（标题精确命中，或描述关键词 4 字滑窗模糊命中） |
| `drift` | 命中禁项数 / 禁项总数 |
| `missedScenes` | 漏写的场景（→ 警告） |
| `bannedHits` | 命中的禁项（→ **拒绝落盘**，force 可放行并记审计） |

指标带时间戳落盘到 `novel.json.chapters[n].gate`——**能看趋势**（第 10 章 95% → 第 30 章 60%，说明结构松了）。
`novel_audit` 的输出把「机械指标（代码算）」与「审读意见（模型出）」分开，模型不再既当运动员又当裁判。

与彼的三处**刻意差异**：
1. 契约段是**可选**的——没写就不判、不阻断（彼 fail-closed）；老书不可能因为没写场景段而写不了章。
2. 段存在却解析不出 → 只给提示不阻断（中文格式漂移无法穷尽，阻断的代价远大于漏判）。
3. 禁项按否定句式**三分类**：排除型计偏离度；需求型（`不得省略 X`）与条件型（`不得无铺垫引入 X`）
   不计——把需求误判成禁词会让「写对了反而被拦」（彼踩过的坑）。

### 修掉两个真问题

1. **契约自己泄底**（实测踩到）：`notes` 里写「陆寒的真实身份本章不揭」——名字照样被注入上下文，
   等于把悬念送给模型。现在**双层擦除**：`renderContractSection` 把 scene/forbidden/notes 里的
   隐藏名替换成「（该人物）」；`scrubHiddenNames` 对**最终注入的每一节**逐行过滤（账本里躺着
   「陆寒|状态|阵亡」、摘要里写着「陆寒登场」这类**派生泄漏**一并堵掉），删空则整节不注入，
   被删过的节尾注记「已屏蔽 N 行」——告诉模型有内容被挡，但不告诉它挡了什么。
2. **门禁判定顺序错了**：`novel_write_chapter` 里「细纲禁项」的判定原本排在内容门禁之前，
   于是**先抛禁项错误、内容门禁（死人复活/隐藏人物泄底等硬伤）根本没机会判**。
   已调整为：内容门禁（这章不能要）→ 细纲契约（这章写偏了）。

### 其他

- `contextpack` 新增两个预算位（`sceneContract` 500 / `voiceCard` 320·`voiceTotal` 1000，均摊）。
- `chapterRecord` 支持 `gate` 字段（不传时保留旧指标）。
- `store.pathsFor` 新增 `sceneContracts` / `voices`。
- 新增审计事件：`scene/save`、`scene/delete`、`character/voice`、
  `write_chapter/gate_forced`、`write_chapter/scene_contract`（记录本章契约是否生效及 hidden 名单）。

### 测试

142/142（+12）：契约归一/裁剪/矛盾处理/**注入区块不含隐藏名**、泄漏检查、契约表不可变、
语言基因卡两种输入归一、语言一致性三态、细纲解析四种格式、禁项三分类、
契约指标（覆盖/漏写/偏离/场景豁免/未启用不阻断）、
以及三个工具级端到端：**隐藏人物写进正文被拦→force→指标落盘+审计**、细纲禁项拒绝落盘、
语言基因卡建卡→注入→审计抓出禁忌词。

## 0.8.0 (2026-09-14) — 融合第二批：零成本质检（一致性 / 内容门禁 / 承诺书 / 追读）

第二批四条全部是**纯函数或文本注入**，零 token 成本、可单测、收益立刻可见。
来源：novel-studio（一致性校验）、dsh-tool-writing（autoproof / gate 四维 / 追读约束）。
方案与进度见 `docs/FUSION-PLAN-2026-09-14.md`。

### B1 · 全书一致性校验 —— 来源：novel-studio

**问题**：长篇最常见的硬伤是「死人复活」「伏笔倒挂」「索引指向已删文件」——
这类**有明确对错**的事，七家只有 novel-studio 用代码抓，其余全靠模型自己记得。

**改动**：新增 `lib/continuity.js`（纯函数）+ `lib/continuity-io.js`（io 装配，工具与 REST 共用）。
八类检查：
- ① 死亡/退场实体在死亡章之后再现（**闪回/梦境自动豁免**降级为警告）
- ② 伏笔回收章早于埋设章、同 id 重复、超期未回收、计划早于埋设
- ③ 章节索引指向缺失文件、latest 与文件版本不一致、章号断档、缺 summary
- ④ 账本章号超前（污染历史）、同章同键多值、重复记录
- ⑤ cast 里的人没有人物卡

**为什么是「适配」而非照抄**：studio 的模型建在 characters/relations/scenes 结构化实体上；
本插件的人物是 `.md` 卡 + `cast[]`、关系与场景无独立实体。所以改写成本插件真实可判定的信号集
（账本 + 章节索引 + 伏笔台账）。**死亡判定**做了反例排除：`不死之身`/`拼死一战`/`死寂` 不判死。

**入口**：`novel_project action=check`（全书体检）、`novel_audit continuity:true`（审计时附带）、
`GET /projects/:id/continuity`（面板）。三处共用同一份实现。

### C1 · 润色保守编辑守卫 —— 来源：dsh-tool-writing 的 autoproof

**问题**：润色最大的风险不是「没改好」，而是**改出了新错**——校对模型自作主张重写、
形近字替错、短句膨胀成长段。本插件此前没有这一层。

**改动**：`lib/polish.js` 新增 `validatePolishEdits(original, edited)`：
- ① 首行形似标题（`第N章` / `# 标题`）被改 → **阻断**
- ② 引入原文没有的高危易混字（`恨 戍 戌 柝 祗 祇 菅 圮`）→ **阻断**（这是校对自伤的强信号）
- ③ 整章膨胀超 1.3 倍、单段膨胀超 2 倍+20 字 → 警告（润色应删冗而非扩写）
- ④ 段落相似度 < 0.4 视为整段被换；>40% 段落如此 → 警告「这是重写不是润色」

接入 `novel_polish submit`：阻断级直接拒绝提交并记审计；警告级随提案返回给用户看。

### C2 · 四维内容门禁 —— 来源：dsh-tool-writing 的 gate

**问题**：`novel_briefing` 会注入「故事承诺书」，但**没有任何机制检查正文是否违背它**——
承诺书写了就没人看。欠账（到期伏笔）也没人查。

**改动**：新增 `lib/content-gate.js`（纯函数），接在 `novel_write_chapter` 的硬约束链里
（机审 → 账本 → **内容门禁** → 落盘）：
- ① **死亡实体再现** → 阻断（复用 continuity 的死亡推演）
- ① 过期状态词：正文出现账本已被覆盖的旧值（「筑基三层」但已升金丹）→ 警告
- ② **到期伏笔零回应 + 本章开新钩** → 阻断（追读铁律的可判定形式）
- ③ 占位符/未完成稿（TODO、待补、此处省略…）→ 阻断
- ④ 人称混用（第一人称与第三人称叙述并存，低置信）→ 警告

`force:true` 可强行放行，但记 `write_chapter/content_gate_forced` 审计。
**判定权归属**：能算的一律代码算，不靠模型自报「我检查过了」；算不了的（物理硬伤、
创意类承诺违背）明确不假装能判。

### C3 · 追读节奏硬约束 + 故事承诺书 —— 来源：dsh-tool-writing

- `lib/contextpack.js` 新增固定注入节「**追读节奏·硬约束**」：上一章欠账未回应前不许开新钩子；
  每 600–900 字一次微兑现；到期伏笔优先兑现；章末留钩子但不许用新悬念掩盖旧欠账。
- **故事承诺书**成为一等公民：新建 `设定/故事承诺书.md`，`novel_project action=promise` 读写，
  briefing 每次都注入（排在细纲之后——它约束的是整本书，优先级高于任何单章技巧）。
- 系统提示新增第 10、11 条；preset persona 增加「承诺与欠账」段。

### 修掉的一个 bug

内容门禁的 force 放行判据最初用了 `gate.forced`——那是「细纲未批准也被放行」的意思，
细纲已批准时它**恒为 false**，导致 `force:true` 也拦。改用「用户是否显式传了 force」，
测试里专门断言了这条路径。

### 测试

130/130（+13）：死亡判定反例、闪回豁免、八类一致性检查、账本状态推演与关键词提取、
死人复活端到端阻断 + force 留痕 + check 复查、追读铁律阻断/回应放行、承诺书注入、润色守卫五例。

## 0.7.0 (2026-09-14) — 融合第一批：批准钥匙归用户 / 审计留痕 / 节奏铁律

对标六家竞品（大肥鱼、多核协同、peterwangze、dsh-tool-writing、novel-studio、
dsh-ai-novel-writer）后落地的「判定权」三项。完整方案见
`docs/FUSION-PLAN-2026-09-14.md`。

### A1 · apply 摘出工具面 —— 模型无法自己批准自己的提案

**问题**：`novel_propose` 的 `action` 曾是 `['propose','list','apply','prune']`，
全在工具面。模型可以自己 propose、自己 apply，一条龙改完已存章节 ——
「提案制」形同虚设。

**改动**：
- 工具面收窄为 `['propose','list']`。`apply` / `discard` / `prune` **不再存在**，
  模型想改已存章节只能出提案。
- 新增 `lib/proposals.js`：提案全生命周期（propose/list/apply/discard/prune）
  的唯一实现，**工具层与 REST 层共用一份**，避免两边漂移。
- 新增 REST 端点：`GET /projects/:id/proposals`、
  `POST /projects/:id/proposals/:pid/apply`、`.../discard`、`.../prune`。
- 面板详情页新增「📝 待批准提案」区块：列出 pending 提案，逐个「应用 / 丢弃」。

**结果**：批准钥匙是**工具层保证**的，不再依赖 persona 自觉。

### A2 · 审计加 `actor` 字段 —— 能分辨「这条是谁做的」

`auditLine(action, detail, actor)`：`user`（面板/REST）/ `agent`（模型调工具，
默认）/ `system`（插件自动）。缺省 `agent` 故工具路径无需逐个改；
`actor` 放在 detail 展开**之后**，业务字段无法覆盖。
由此可以直接查「这本书的细纲/修订是模型自己批的，还是用户批的」。

### F2 · 节奏铁律 —— 治「一句话就写到章节结束」

三处同时写死「**一次只写一章**，写完停下向用户汇报，绝不擅自连写第二章」：
- preset persona（`lib/preset/novel-forge/agent.cordis.yml`），最高优先；
- `novel_write_chapter` 工具描述；
- 系统提示纪律清单第 9 条。

六家里只有「多核协同」在原则上写死过这条；本插件现在 persona 层 + 工具描述层双保险。

### 其他

- `createServerFsio` 补齐 `readJson` / `readJsonl` / `writeJson` / `appendLine`，
  与 `createFsio` **接口同构** —— 提案逻辑才能一份两用。
- 提案新增 `appliedAt` / `discardedAt` 时间戳。
- **`preset-deploy` 从「存在即跳过」升级为版本感知**（F2 的必需配套）：
  原先目标目录存在就跳过，导致插件升级带的 persona **永远到不了用户盘上**，
  F2 的纪律等于白改。现在：同版本跳过；版本不同则逐文件比对，
  用户没改过的直接更新、改过的先备份 `.user.bak` 再更新。部署后写 `.deploy.json` 清单。

### 测试

117/117（+7）：工具面 enum 收窄与门禁断言、discard 不动正文、actor 留痕（apply=user
/ propose=agent / detail 不可覆盖）、preset 铁律三处在场、预设部署四条（首次+跳过 /
版本升级 / 用户改动保护 / SKIP 不碰盘）。

## 0.6.6 (2026-09-14) — REST 多工作区扫描：修复「会话里建了书，面板却没有」

**根因**：书由 AI 工具创建，落在**会话 workspace**（如 `~/Documents/novel/剑来旺财`）；
而 REST 所有端点都用 `config.workspaceRoot || process.cwd()`（= dsh 进程 cwd，如
`~/Documents/other`）当根。dsh 有多个工作区时（左侧栏 novel / other / …），其它工作区
里的书永远扫不到——面板显示「本会话没有项目」，其实书好好的在盘上。

**修复**：

- 会话工作区列表从 `~/.dsh/sessions/` 目录名反推（目录名 = `--` + 绝对路径 `/`→`-` +
  `--`，如 `--Users-me-Documents-novel--` → `/Users/me/Documents/novel`；**前导斜杠
  必须补回**，反推结果用 `statSync` 验证，含 `-` 的真实目录名会解码错 → 验证失败跳过，
  安全降级）。
- `scanAllBooks()`：扫**全部根**合并书目，同名以 cwd 根优先；每本书记住自己的 fsio，
  账本摘要 / 认领写回都落在书真正所在的根。
- `locateBook(bookId)`：详情 / 要素 / 章节读写 / 导出 / 删除 / 改名 / 世界书 CRUD
  共 11 个按 id 找书的端点全部改为跨根定位——书在哪个工作区就能从哪个工作区读写。
- 删除端点改走 `locateBook`（原来会去 cwd 根写一个错位的 novel.json）。
- `POST /projects` 支持 `body.workspace`：面板创建书可落到当前会话的工作区。

**验证**：解码单测（8 个会话目录 → novel / other 两个有效根，《剑来旺财》《万刃》命中）；
端到端预演（同款扫描+过滤逻辑，`?session=session-90eeea18…` → 剑来旺财 命中）；
**110/110 全绿**。**需重启 dsh web 生效（纯服务端改动）**。

## 0.6.5 (2026-09-14) — 项目列表支持改名 + 删除

在项目卡片上加两个管理动作，都是两步式/内联确认，防误触：

- **改名**：卡片「改名」弹内联输入（预填当前书名），确定后 `POST /projects/:id/rename`。
  **目录名（=id）是这本书的稳定身份**——章节 / 世界书 / 账本路径都挂在它下面，改名只改
  `novel.json.title`、不挪目录，与删除的「软操作」模型一致，零数据丢失风险；正在看这本书
  时改名会同步刷新详情标题。
- **删除**：卡片「删除」两步确认（可取消），确认后走既有 `DELETE /projects/:id` 软删
  （服务端把 novel.json 清空标记为非书）。详情页内的删除保留，行为一致。
- **补测**：「改名空名被拦 / 提交 body 带新书名」「列表删除两步确认走 DELETE / 取消不删」，
  并修正上一轮 detail 删除测试里 `r.method`→`r.init.method` 的空报警笔误。
  **110/110 全绿**。

## 0.6.4 (2026-09-14) — 锻炉面板一轮 UI/UX 优化（web-design-guidelines 走查）

对右侧栏面板做过一轮可访问性 / 反馈 / 一致性走查，逐条落地：

- **未保存草稿不再静默丢**（你上一次点名的高价值项）：返回 / 换章前若有改动，先弹「丢弃改动
  / 取消」确认；取消留在原地、草稿保留，确认才真正离开。目录早停等路径一并守卫。
- **打开项目卡改成真 `<button>`**：原来用 `<div data-action="open">`，键盘 / 读屏用户点不开书；
  现在可聚焦、进 Tab 序、回车触发。
- **删除二次确认补「取消」出口**：误触「删除」后可以取消，不必再点一下删。
- **颜色 token 化 + 提对比度**：主/副/危险按钮与成功色原来硬编码 `#156/#2a7/#29a/#c33` 等深色
  hex，深底上几乎看不清，且违背「不自己发明颜色、走 dsw 别名」约束——统一改成
  `--dsw-alias-accent-strong` / `--dsw-alias-label-danger` 并配浅色回退。
- **切章读取失败有反馈**：loadChapter 失败不再静默置空，给一句人话报错。
- **openProject 请求并行**：detail 与第 1 章正文并行拉；elements/chapters 并行。
- **去重刷新**：面板头部与项目列表同屏两个「刷新」→ 只留列表内那个。
- **title 输入受控同步**：书名输入即时 notify，避免受控 value 与 DOM 脱节。
- **补测**：「未保存草稿返回确认 / 取消不丢 / 确认离开」「删除取消不删书」。
  **108/108 全绿**。

## 0.6.3 (2026-09-13) — 代码审查修复：听书真机契约 / 连播跳缺口 / 服务端路径

对 0.6.x 新代码做过一轮逐文件审查，把发现的问题一次修干净：

- **P1 真机必炸**：`tts.js` 原先把普通对象 `{text,lang,...}` 喂给 `speechSynthesis.speak()`，
  而 Web Speech 只收 **`SpeechSynthesisUtterance` 实例**（传普通对象直接 `TypeError`）。
  新增 `defaultUtteranceFactory()`：真机用 `new SpeechSynthesisUtterance()`、无该构造器的
  headless 才退回普通对象。**测试替身按真机契约收口** —— `makeSynth().speak` 现在只收
  实例、普通对象必抛，防「真机炸测试绿」（0.4.2/0.4.3 同款学费的第三条路堵上）。
- **P2 连播早停**：连播/空章跳过原来 `currentNo+1`，章号有缺口（如只有 1、3）会在缺口处
  停。新增 `nextChapterAfter` 依赖（面板按已排序的 chapterList 给「下一存在的章」），
  缺省退化为 `hasChapter(no+1)`。
- **speak 守卫**：`synth.speak(u)` 包 try/catch，引擎对某块同步抛错不再把链卡死在 playing。
- **P3 服务端路径**：`bookId` 一律 `safeDecode`（URL 段是 percent-encoded，中文书名如
  `%E6%98%9F...` 不加解会被当成真实目录名、读盘全败——server-api 比 remote.workspaceFiles
  新，这条从没真机跑过）+ `validBookId` 校验（拒空/`.`/`..`/含分隔符），11 处统一。
- **api.js**：只有自身超时 controller 触发的中止才报「请求超时」；调用方自带 signal 中止报
  「请求已中止」，不再误报成超时。
- **补测**：「普通对象被引擎拒不卡死」「连播按目录跳缺口（1→3→5）」「chunkText 纯函数」。
  **106/106 全绿**。

## 0.6.2 (2026-09-13) — 面板「永远加载中」根治：请求超时 + 可读错误 + 探针日志

- **背景**：真机面板卡「加载中…」。全链路排查（curl 各端点 / 无头浏览器用真实会话 id 复现）
  均正常 —— 服务端 10ms 级响应、面板正常落到空态。代码链路无 bug，遂把矛头对准
  「请求在个别浏览器环境里永不返回」这类无法根治的场景。
- **apiFetch 加固**：① 单请求 12s 超时（AbortController），超时给可读错误
  （提示服务未起 / 被扩展或代理拦截）；② 响应非 JSON（典型：dsh 重启后旧页面被 401 成
  text/plain、代理回 HTML）不再抛 SyntaxError 天书，改为指引「硬刷新」；
  ③ `ok:false` 契约不变。
- **探针日志**：`refreshProjects` 打 `[novel-forge] GET /projects?session=…`，
  失败打 warn —— 用户卡加载时 console 一眼分诊（有出无回=网络层，有回有错=错误可见）。
- 测试 100 → **103**：超时 / 非 JSON / ok:false 三条行为测试；反向验证（改掉超时文案 → 红）。

## 0.6.1 (2026-09-13) — 基本信息标签升级为小说基本要素总览

- **REST**：新增 `GET /projects/:id/elements` 一次聚合五类要素：
  档案（title/genre/logline/stage/时间/cast）、大纲（全书大纲全文 + 细纲份数）、
  角色卡（`人物/*.md` 全文）、设定（世界书/术语表条数）、时间线（facts 按章分组 + 伏笔）。
- `fsio.js` 服务端半新增 `listEntries`（listNames 只回目录，列角色卡 .md 需要文件条目）。
- **客户端**：新视图 `views/overview.js` —— 基本信息 = 要素总览（档案 / 大纲 / 角色卡 /
  设定 / 时间线·账本）+ 底部保留本章编辑区。大纲全文与角色卡用原生 `<details>` 折叠；
  事实时间线按章升序分组展示；每个缺失要素给空态引导（novel_outline / novel_cast /
  novel_world / 写章自动记账）。要素接口失败置空、不影响打开书。
- 测试 99 → **100/100**（新增：elements 拉取与落地、接口失败置空不炸）；
  反向验证（拆掉 loadElements → elements 用例变红）。

## 0.6.0 (2026-09-13) — 详情页两个标签：基本信息 / 章节听书（语音连播）

- **REST**：新增 `GET /projects/:id/chapters` —— 章节目录（`{no,title,chars,version}` 按章号升序），
  既是听书清单也是连播的边界。
- **客户端**：项目详情页顶部两个标签「📋 基本信息 / 🎧 章节听书」；
  章节标签（`views/chapters.js`）按顺序列章，每章一个「▶ 从这章听」，
  顶部控制条支持播放/暂停/继续/停止。
- **TTS（`src/client/tts.js`）**：Web Speech 合成封装 ——
  ① 正文切块（默认 180 字符/块）逐块 speak，规避 Chrome 对超长 utterance
  「读十几秒就停」的老毛病；② **连播**：一块 onend 接下一块，一章读完自动取下一章，
  目录尽头自动收工；③ **代际计数**：stop() / 重新 playFrom 之后，一切迟到的
  onend 一律作废（真实浏览器 cancel 后仍会补发回调，不作废就是「停了又活过来」）；
  ④ 面板卸载 / 换书 / 删书 / 换会话一律 stop —— tab 关了不能还在出声；
  ⑤ 无语音引擎的环境给可读报错，不静默炸。
- 空态：《星海拾骨》这类还没写章节的书，章节标签显示引导
  （「在会话里让 AI 调用 novel_write_chapter 开写」）。
- 测试：client 测试 22 → **27** 条（目录请求、指定起始章连播、尽头自动停、
  stop 即停 + 迟到 onend 作废、暂停/继续、无引擎报错），全量 **99/99**；
  三组反向验证（拆连播链 / 代际计数失效 / 尽头不收工）各让对应用例变红。
- 自检脚本修复一处误报：宿主模块表检查的 `from\s*["']` 正则没有词边界，
  会把压缩产物字符串里的 `"play-from"` 当成 ESM import（报「索要未播种模块 `, `」）。
  加负向后行断言 `(?<![\w-])`，真非法 import 依旧报致命。

## 0.5.1 (2026-09-13) — 锻炉改回右侧栏常驻独立 tab（撤销"会话有项目才显示"门控）

- **现象**：真机上右侧栏不再有那个单独的「🔨 锻炉」。原因：0.5.0 把打开时机收进
  `session-watch` 的「本会话有项目才开」门控——没项目（或 `/projects?session=` API 没命中）
  时只注册了 tab 类型和内容 seat、**不调 `openTab`**，于是右侧栏标签条里没有独立 tab。
- **修复**：`src/client/index.js` 的 `apply` 在注册后**无条件 `openForgeTab(ctx)`**——锻炉恢复成
  右侧栏**常驻独立 tab**（恢复 0.3.x 的行为）。面板内仍按会话语义过滤项目列表，空会话
  渲染引导空态（project-list.js 已有"本会话还没有项目…"），不会露丑。
- `session-watch.js` 的调度能力保留并仍经 `__internals` 导出，但**不再由 apply 门控打开**；
  其"有项目才开 / 切会话重判 / stop 停止轮询"语义改为直接在测试里调 `startForgeAutoOpen` 验证。
- 客户端行为测试同步改写：新增「无项目也独立打开」「独立打开只发生一次」；原「本会话没有项目
  时不显示」断言反转为常驻打开。**94/94 全绿**。
- 见 AGENTS：`npm run build`（pretest 已跑）→ **重启 DSH web**（bundle 进程启动时快照）→ 浏览器硬刷新。

## 0.5.0 (2026-09-13) — 入口回到右侧栏；项目跟会话走

两条产品决定（仙尊定）：**入口放右侧栏**，**且只有用过工具的会话才显示**；
项目 = 会话里的项目，会话里创建了几本就几本。

### ① 入口：左侧栏 DOM 注入 → 官方右侧栏 tab（三步契约）

- **删掉路线 B**：`src/client/sidebar-entry.js`（入口 DOM 注入 + 双观察自愈）与
  `src/client/drawer.js`（自建 root 的全屏抽屉）整体退场 —— 产物里不再出现
  `data-dsh-novel-forge-entry` / `sidebarCol` / `MutationObserver`（测试有一条反向断言守着，
  防两条入口路线并存）。
- **改走官方三步契约**（`src/client/forge-tab.js`）：
  ① `ctx.sidebarRightTabs.register({ id, kind, priority, title, guide })` 声明类型；
  ② `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key: <id>, inject }, Panel))`
  注册内容 seat；③ `ctx.sidebarRight.openTab(kind)` 才真正上屏。
  **只做①②不做③的话，一格都不多、也不报任何错** —— 这一条写进注释，别再误判成加载问题。
- **`openTab` 延迟重试**：seat 未挂载时 `openTab` 直接抛错，故首次延迟 400ms、
  之后每 250ms 重试、窗口 30 秒。
- **`guide` 入口胶囊**：跨会话常驻的手动通道，自动打开失败 / 被关掉时的保底。
- **面板改由 slot 框架渲染**（`src/client/panel.js`）：不再自己 `createRoot`，
  于是 0.4.3 的「点一次没反应、再点一次整屏空白」那一类事故从根上消失。
  控制器（状态 / 业务动作 / 原生事件代理）与组件（ForgePanel）分离，
  控制器是纯闭包 → headless 测试可直接驱动断言。
- `inject` 声明补齐：`['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions']`。

### ② 显示时机：本会话有项目才出现

- 新增 `src/client/session-watch.js`：当前会话 id 从 `ctx.sessions.list`
  （`ObservableSnapshot<SessionListState>.current`）读 —— 不猜 URL、不抠 DOM；
  兼容 `getSnapshot()` / `snapshot()` / 裸对象三种快照形态。
- **有项目才自动打开**：没写过小说的会话不打扰；
- 书是会话里的 AI 调工具建的，客户端收不到通知 → **会话切换立刻查一次 + 未打开时每 8 秒轮询一次**，
  一旦为某个会话开过就不再重复（关掉是用户的自由）。
- 服务端不可达 / 面板未挂载都静默重试，不炸装配。

### ③ 数据：项目跟会话走

- `novel.json` 新增 `sessions: []` —— 「拥有这本书的会话」集合（`lib/store.js`）。
  新增纯函数 `bookInSession` / `isUnclaimed` / `addBookSession`（服务端与面板共用一份判据）。
- **创建时打戳**：`novel_project init`、`novel_import`、`novel_clone_project` 写入创建会话
  （`io.sessionId` ← `exec.agent.session.header.id`，见 `lib/fsio.js` 的 `sessionIdOf`）。
- **碰到就补录**：`requireBook` 里统一补录当前会话（`lib/tools/common.js` 的 `rememberSession`）——
  17 个工具一处接线，另一个会话接续写同一本书也看得见；老书（无 `sessions` 字段）因此自动认领。
  拿不到会话 id 时不写（headless 场景不得凭空造归属），写盘失败静默不阻断写作。
- **REST 按会话过滤**（`lib/server-api.js`）：
  - `GET /projects?session=<id>` 只回本会话的书；`?scope=unclaimed` 回未归属的旧书；不带参数回全量（curl 调试用）；
  - `POST /projects` 接受 `session` 并把戳写进新书；
  - 新增 `POST /projects/claim`：把未归属的书认领到本会话（只动未归属的，不抢别人已归属的书）。
- 面板所有列表/创建/认领请求带 `session`；无会话 id 时降级为全量（头部提示「全部项目」）。

### 测试与工程

- `test/client.test.mjs` **重写为右侧栏契约 + 会话语义的行为测试**（22 例）：
  三步契约逐项断言、`inject` 工厂交 sessionId、`openTab` 时机（无项目不开 / 有项目开一次 /
  换会话重判 / 项目后到补开 / 抛错重试）、控制器请求带会话、创建/认领写会话戳、事件代理 attach/detach、
  以及「左侧栏痕迹退场」的反向断言。
- `test/helpers/dom.mjs` 换成 **headless 装载体**：`makeCtx()`（真语义 `ctx.effect`、
  可控 `openTab`、可切会话的 `sessions.list`）+ 记账式假定时器（时序断言无 flake）
  + 沿 parentElement 冒泡的极简 DOM（真跑事件代理）。
- 三条**反向验证**（退化即红，证明测试有牙齿）：去掉「有项目才开」→ 2 红；
  请求不带 session → 1 红；`init` 不写会话戳 → 1 红。
- 契约自检脚本两处修正：page type（无 `patterns`）有 `definition.title` 时不再误报
  「缺 pane.tab.title」；入口选择器判据放宽到「只有属性名」（打包产物里常见）。
- 全量 94/94 通过。

## 0.4.3 (2026-09-13) — 修「点击无反应 / 变空白页」与「左侧栏 8 个锻炉」

两个真机症状，两个独立根因，**都不是加载链路问题**（产物与重启时间线都对得上）。

### ① 点击入口没反应，或整屏空白 → `createRoot` 取错了包

- **根因**：`mountDrawer` 写的是 `react.createRoot(container)`，而 **React 核心包没有
  `createRoot`** —— 它在 `react-dom/client` 里。官方插件一律
  `let react_dom_client = require("react-dom/client"); react_dom_client.createRoot(node)`；
  宿主播种的模块表（`CHUNK_EXTERNALS`）也是 `react` / `react/jsx-runtime` / `react-dom` /
  `react-dom/client` 四件套。
- **症状为什么这么怪**：第 1 次点击 → `createRoot` 抛 TypeError → 容器已 append 但停在
  `display:none` → **看起来毫无反应**；第 2 次点击 → `container` 已存在，于是只切了 `display`
  → 露出空的 fixed 全屏层 → **整屏空白**。两种表现交替出现，极易误判为「构建没生效」。
- **修复**：
  - 新增 `src/client/react.js` —— **React 与 createRoot 的唯一取用口**
    （`react` 取 `createElement`/`Component`/`Fragment`，`createRoot` 只从 `react-dom/client` 取），
    并带 `diagnoseRenderer()` 把「宿主到底给了什么」摊开。
  - 四个视图与 `drawer.js` 统一改为 `import { h } from './react.js'`，消灭散落的 `react.createElement`。
  - `mountDrawer` 前置守卫：缺 `createRoot` 时**明确抛错**（带缺失清单与 react 实际导出）。
  - `toggleDrawer` 失败时**回收半成品容器** + 弹原生故障卡（`data-dsh-novel-forge-fatal`）——
    **失败必须可见，绝不再留空白遮罩**。
  - 加渲染错误边界 + `render()` try/catch：视图抛错只替换该区域文案，
    不再让 React 卸载整棵树（那是「整屏空白」的第二种成因）。
  - `window.__novelForge.toggle()`：入口挂不上时的保底开关。
- **构建**：`build-client.mjs` 的 `external` 补齐宿主模块表
  （`react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` / `cordis`）。

### ② 左侧栏冒出一列 8 个「小说锻炉」→ 去重路径走不到

- **根因有两层**：
  1. **去重写在 `placeEntry` 里，而已就位的挂载会在 `tryPlace` 里提前 `return`** ——
     那条去重路径**永远走不到**，历史重复节点再怎么刷也洗不掉；
  2. `apply` **没注册 disposer**，插件每重装一次（dsh 重启 / 热更新 / 会话重建）
     就漏一份入口 + 两个观察者，越积越多。
- **修复**：
  - 入口改为**DOM 单例收养**：`acquireEntry` 若发现已有同类节点，就**复用**它并
    把点击处理器换成最新实例的（处理器存在节点的 `__novelForgeOnClick` 上，
    避免收养来的节点还指着上一个实例的幽灵抽屉），同时把多余节点**清扫**掉。
    仲裁权放 DOM 而不是模块变量 —— cordis 反复装配时上一个模块实例还活着，模块变量挡不住跨实例。
  - `tryPlace` / `rootObserver` 里**无条件** `sweep()`，不依赖 `placeEntry` 是否被执行。
  - `mountDrawer` / `disposeDrawer` 按 `data-dsh-novel-forge-drawer` 清扫其它实例遗留的抽屉容器，
    保证页面上只有一个全屏层。
  - `apply` 用 `ctx.effect(() => dispose)` 注册清理（cordis 语义：回调立刻执行、返回值登记为清理函数）。

### ③ 测试：把「假前提」从替身里挖掉

- 旧 headless 替身的 `require` **顺手给 `react` 挂了 `createRoot`** —— 与真机相反，
  等于把「`react.createRoot` 能用」这个假前提固化成绿灯。现在替身的模块表**严格镜像宿主**
  （`react` 明令不给 `createRoot`，`createRoot` 只在 `react-dom/client`），
  并新增断言：**产物只许 require 宿主播种的模块**。
- 旧 `ctx.effect` 替身写成 `(f) => f()`（登记 f 本身且立刻调用），与真机语义相反，
  导致「注册 disposer」这类改动**根本测不出来**。现按官方写法
  （`ctx.effect(() => () => {...})`）复刻：立刻执行、登记返回值。
- 新增 8 条用例：模块取用契约、渲染器缺失不留空白遮罩、同实例反复 apply 唯一、
  跨实例收养唯一、历史 8 个重复被清扫、后冒出的重复被自愈清掉、`ctx.dispose` 后入口移除。
- **反向验证**（证明测试真有牙齿）：把 `createRoot` 改回从 `react` 取 → 2 条变红；
  拆掉收养 → 1 条变红；拆掉无条件清扫 → 1 条变红；还原后全绿。**86/86**。

## 0.4.2 (2026-09-13) — 补上构建链：客户端源码模块化，四视图落地

- **背景**：0.4.0/0.4.1 把浏览器半改成「左侧栏 DOM 注入 + 全屏抽屉」后，按设计文档写的
  `lib/client/drawer.js` / `lib/client/sidebar-entry.js` 是 **ESM**，而 dsh **只加载**
  `exports["./client"]`（`lib/client.js`）—— 这两个文件是**不可达的死代码**；更糟的是
  `sidebar-entry.js` 里的自愈还是 **0.4.1 修掉前的旧语义**（`if (!placed) place()`），
  一旦有人误把它当源码打包进去，入口消失的 bug 会原样复活。设计文档 Step 4-7 的四个视图
  文件（project-list / project-detail / lorebook / settings）也一个都没落地。**三份实现互相分叉。**
- **根因**：缺**构建步骤**。dsh 官方 `dsh-client-modules` 明确「宿主提供的是**已构建的**客户端
  bundle，启动前必须已产出每个 `lib/client.js`」—— 源码可以是 ESM，但发布物必须是经典脚本。
- **修复**：
  - 新增 **`src/client/` 源码树**（ESM，唯一真相）：`index.js`（入口）· `sidebar-entry.js` ·
    `drawer.js` · `views/{project-list,project-detail,lorebook,settings}.js` · `api.js` ·
    `state.js` · `styles.js`。以活跃的 `lib/client.js` 为**行为基准**（保存/导出/写章引导等功能
    一个不少），吸收 `lib/client/drawer.js` 的参数化与 `dispose` 设计。
  - 新增构建脚本 **`scripts/build-client.mjs`**（esbuild）：`src/client/` → `lib/client.js`，
    产出与官方插件一致的 `window.__ModuleLoader__.load({ id, factory })` 经典脚本；
    `react` 走 external，由宿主 `PLATFORM_MODULES` 基座提供（不重复打包）。
  - 加 **`npm run build`** 与 **`pretest`**（测试永远跑当前源码构建出的产物）；
    构建脚本内置**版本守卫**：源码 `PLUGIN_VERSION` ≠ package.json version → 直接构建失败。
  - **移出 `lib/client/` 目录** —— 它与产物 `lib/client.js` 同名，是歧义与分叉的温床。
    源码改用 `src/`（dsh 生态惯例），`lib/` 从此只放产物与 node 半侧。
- **顺带修的两处真问题**：
  - `ENTRY_SELECTOR` 原来只导出、无人使用，会被 esbuild **tree-shake 掉**（连带让契约自检脚本
    误判「没有入口选择器」）。现在 `placeEntry` 用它做**幂等去重**（清掉重复入口），常量变成真用途。
  - `package.json` 的 `dsh.client.inject` 还写着 `@deepseek-ai/dsh-client-ui-sidebar-right` ——
    那是右侧栏 tab 路线的遗留声明，DOM 注入不需要它，已移除。
- **测试**：新增「构建链：四视图已拆成独立源码，产物由 src/client/ 构建而来」用例（四视图源文件存在
  + 产物 generated 头 + 源码/产物版本一致）；更新 smoke 的结构契约断言 —— 不再绑死手写 IIFE 的
  `exports.apply = apply` 形态，改为断言 esbuild 的导出**表内容**。**79/79 全绿**。
- **反向验证**（证明新断言有牙齿，不是"看起来绿"）：手动去掉产物的 generated 头 → 相关用例立刻变红
  （8 pass / 1 fail）；把源码版本改成 `9.9.9` → `npm run build` 以 **exit=1** 拒绝并打印版本漂移。
- **一个教训**：`src/client/sidebar-entry.js` 的注释里为了解释旧 bug 原样写着 `if (!placed) place()`，
  于是「源码不得退回旧自愈语义」那条**文本断言把注释当成了代码**命中（假阳性）。
  该语义本就由行为用例真跑守住 —— 已删掉那条文本断言。**能跑就别 grep。**

## 0.4.1 (2026-09-13) — 修「左侧栏入口被 React 冲掉后永不复生」

- **现象**：0.4.0 把入口从官方右侧栏 tab 换成左侧栏 DOM 注入后，真机上右侧栏不再有「🔨 锻炉」（**这是设计使然**），但**左侧栏那个「小说锻炉」入口也没出现** —— 等于整个锻炉入口消失。
- **根因**：宿主侧栏是 **React 托管**的。旧实现 `mountSidebarEntry` 只走一次：
  ```js
  const tryPlace = () => { try { if (!placed) place(); } catch {} };
  tryPlace();
  if (!placed) { observer = new MutationObserver(...); }   // 插成功就根本不建 observer
  ```
  - 首次插入若落在 React 下一次 reconcile 会整棵替换掉的过渡容器上 → 节点被冲掉；
  - 此时 `placed` 仍是 `true`，`tryPlace` 永远早退，**observer 又压根没建** → 入口**再也回不来**。
- **修复**（对齐参考实现 `dsh-mnemon/lib/client.js` 的写法）：
  - `placeEntry(root, entry)`：以 `newSession` 按钮为锚，且用**族选择器**（`[data-dsh-taskboard-entry], [data-dsh-ssh-entry], [data-dsh-mnemon-entry], [data-dsh-novel-forge-entry]`）排队，避免与其它第三方入口互相顶位；
  - **双观察自愈**：`waitObserver`（等侧栏出现，observe `document.body`）+ `rootObserver`（常驻守着，`!root.contains(entry)` 就重插，`!root.isConnected` 就重解析 root）；
  - 判据从「插过没有」改成「**现在还在不在**」（`document.body.contains(entry)`），这才是幂等的正确写法；
  - 新增 `data-dsh-plugin` / `data-dsh-part` 标记；`apply()` 加 `console.info` 分诊日志（**没有这行 = apply 压根没被调用，问题在加载链路而非本文件**）。
- **测试重写（关键）**：旧 `test/client.test.mjs` 全是 `code.includes('mountSidebarEntry')` 式的**字符串断言** —— 只要有这个名字就绿，于是上面这个真 bug 一路 77/77 绿灯。现改为**行为测试**：`test/helpers/dom.mjs` 提供照抄 dsh 真机 DOM 的仿真环境（`pI_x6G_sidebarCol` / `hHd-Xa_root` / `logoRow` / `newSession`），**真跑 `apply()`**，覆盖：插在正确位置、**被冲掉后自愈**、侧栏后到、**整棵替换后重挂**、点入口挂抽屉、经典脚本结构。**78/78 全绿**；反向验证：把自愈退化回旧语义 → 相关用例立刻变红。
- **诊断教训**：`node --check` 在本包会按 **ESM** 解析（`"type": "module"`），而 dsh 按**经典脚本**执行 bundle —— 混入 `import/export` 会让整包 syntax error 却检查不出来。新自检脚本已把这条做成硬检查。
- **注意**：`lib/client/drawer.js`、`lib/client/sidebar-entry.js` 是 **ESM**，dsh **只加载** `exports["./client"]`（`lib/client.js`），这两个文件目前是**不可达的死代码**，与 bundle 内联版本存在分叉风险。

## 0.3.10 (2026-09-13) — 可选文件缺失不算错：去梢余的可选 read 报错

- **问题**：0.3.9 真机上《星海拾骨》读盘成功，唯独 `style-baseline.json` 如实报出 `workspace-file/not-found`——那是**正常状态**（该书从没跑过 `novel_style build`，基线文件本就不存在）。但 `probeReadBook` 把"没读到"一律推成 `readError`，面板刷了一道红，掩盖了"这书没基线"这个本可正常表达的信息。
- **修复**：specs 加"必需/可选"标记——`novel.json` **必需**（定义一本书，读不出不算书）；`账本/facts.json`、`账本/伏笔.json`、`.novel/style-baseline.json` **可选**（数据累计后才生成，缺失=零/未建，静默跳过、不进 readError）。摘要里缺失可选文件自然降级（facts=0、伏笔 open/0、styleBuilt=false）。
- 摘要门槛收紧：只有在读到 `novel.json` 时才造摘要（可选文件全读到也只算陪衬），杜绝幽灵书目。
- 新增 2 例锁定行为（可选 style not-found 不进 readError + novel 必需缺失才报错）。**85/85 全绿**。
- 刷新 DSH web 页面即可：书目卡《星海拾骨》的红 read 行应消失，行情变成 `规划 · 账本 3 · 伏笔 1/1`（无"有基线"）。

## 0.3.9 (2026-09-13) — 书目发现加预筛：非书目录不再被盲读

- **实机验证结果：0.3.8 的数据面在真实 dsh 上跑通了。** `list(sessionId, ".")` 成功列出工作区根内容；`read` 成功读到书并带出 `absolutePath`；面板如实显示工作区内真书《星海拾骨》的 `planning · 账本 3 · 伏笔 1/1`，并**如实**报出 `style-baseline.json` 的 `workspace-file/not-found`（那本书确实还没建基线）。**面板功能验证通过。**
- **修掉一个真缺陷**：`loadBookConsole` 原先把工作区根下**所有**一级目录都当书，每个盲读 4 个机器文件。实机里工作区根是 `~/Documents/other/`，含 `dsh-novel-forge/`（插件仓库）等非书目录 → 刷出满屏 `workspace-file/not-found`，把真实错误淹没。
- **修复**：新增 `dirHasNovel(wf, sessionId, dir)`——先用 1 次轻量 `list` 判断目录里有没有 `novel.json`，只对真正的锻炉书读盘。**1 次 list 换掉 4 次 read**，既省请求又去噪。任何异常（无 `list` 方法 / `ok:false` / 抛错）一律当"不是书"，候选筛选宁缺勿滥、绝不抛。
- 加扫描上限 `MAX_SCAN=30` / `MAX_BOOKS=12`，防工作区被塞进巨型目录时打爆面板。
- 新增 2 例（非书目录不被误读 + `dirHasNovel` 全异常降级）。**83/83 全绿**。
- **诊断教训**：本次一度误判「面板读到旧数据」，真相是我把验证样本建到了**工作区根的子目录**（`dsh-novel-forge/星海拾骨/`）而不是工作区根下。**dsh 的工作区根 = dsh 进程的启动目录**，样本必须放在它能 `list` 到的那一层。这也是**插件开发目录常在数据目录的子层**时的典型陷阱。先 `list(sessionId, ".")` 把工作区真实内容打出来，比任何猜测都快。

## 0.3.8 (2026-09-13) — 纠正数据面根路径：list 受工作区边界限制，read 不受限

- **推翻 0.3.7 的结论**。0.3.7 从本地 mock 归纳出"根目录只能传工作区绝对根、`$host.home` 就是它"——**这个前提是错的**。它在真实 Host 上 100% 失败，错误码 `workspace-file/outside-workspace`：`"/Users/huangshengju" is outside the workspace`。
- **真契约**（源：依赖包自带文档 `@deepseek-ai/dsh-api-workspace-files` 的 README + types，非猜测）：
  - `list(sessionId, path, signal?)` —— **path 必须落在会话工作区内**（`list` 与 `changes` 受限）；空串是 `gateway/bad-request`。
  - `read(sessionId, path, range, signal?)` / `stat` / `readBytes` / `readAll` / `readRelated` —— **不受工作区边界限制**，接受绝对路径，可读工作区外。原文：「文件读取可以指向工作区外路径；目录列举与已埋点的文件系统观察仍限定于工作区」。
  - 工作区根 = `SessionHeader.cwd`（**单根、不可变**）；`process.cwd()` 只是无 cwd 会话的兜底，且明确"不支持额外可写根"（源：`dsh-sandbox-policy`）。
  - `$host.home` 是 **Host 机器的家目录**，通常正是工作区根的**父目录**——拿它当 list 根必被拒。
- **修复**：
  1. `probeRemote` 的 list 根改用**工作区相对根 `"."`**（备用 `"./"`）；删掉 `$host.home` 形态与空串形态，并在错误里点明"list 只能列会话工作区内的路径"。
  2. `probeReadBook` 的 read 形态改为真实 arity：`read(sessionId, path, {}, signal?)`——**range 是必填对象**，缺参或传 undefined 会以装配错误（arity）reject；0.3.7 的 `read(sessionId, path)` 与 `(sessionId, path, undefined)` 都属缺参。
  3. read 返回值按 `WorkspaceFileText` 取 `text` 字段（不再假定裸字符串），并带出 `absolutePath`；面板新增「盘」行 ＝ 确实读到真实文件的凭证。
  4. `loadBookConsole` 加**两态判定**：工作区根下直接有 `novel.json` ⇒ 根本身就是一本书（bookName 传空串，路径**不带前导斜杠**，否则会变成绝对路径绕过工作区根）；否则把一级子目录当候选书。
  5. 面板「书目」空态给出可执行的修复指引：`DSH_PROJECT=<书库目录> ~/restart-dsh.sh`；`host` 行标注"机器 home，非工作区根"。
- **测试**：改掉"跟着自己实现走"的 mock，让 mock 复刻真实契约——list 对工作区外路径回 `outside-workspace`、read 缺 range 直接抛装配错误。新增 e2) 反向防线（禁止再把 `$host.home` 当根）+ 两个用例（空 bookName 路径无前导斜杠、两态判定）。**82/82 全绿**。
- **教训**：本地 mock 若跟着自己的实现写、而不是跟着被集成的真实接口写，就会产出「全绿但接不上」的假象——0.3.4~0.3.7 连续四版都栽在这一件事上。凡猜调用形态，先读依赖包自带的 README/types。

## 0.3.7 (2026-09-13) — 修列目录：根目录用 $host.home 作为 list 根路径

- **根因（实测错误码收敛）**：`workspaceFiles/list` 收**非空 path**——空串被 `path is required` 拒；对象实参被 `rejected "path"` 拒；实参不足被 `expected 2 business argument(s) plus an optional AbortSignal` 拒。解析逻辑是 `{startsWith("/") ? path : ROOT/path}`，根目录只能传**工作区绝对根**。
- **修复**：`$host.home` 即工作区绝对根（连接侧 fixture 里 `host.home == WORKSPACE_FILES_ROOT`），把 `list(sessionId, host.home)` 列为第一形态，home 缺失才退回空串（诊断用）。`probeRemote` 的 list 尝试自此以 host.home 为根。
- **read 形态校准**：`probeReadBook` 的 read 实参按"2 业务实参 + 可选 signal"口径重排，`read(sessionId, path)` 最优先。
- 测试(e) 改为断言 `host.home` 作为 list 根路径列出成功（含书目目录浮现）。**80/80 全绿**。
- 样例书《星海拾骨》可验证：刷新后书目卡应列入书名目录并读出摘要。

## 0.3.6 (2026-09-13) — 修数据面：remote 子域必须显式声明 inject

- **根因**：`ctx.remote.workspaceFiles` 被 remote Proxy 挡住，报 `cannot get property "remote.workspaceFiles" without inject`。remote 的每个**子域**都要求消费者把 `"remote.<domain>"` 写进 client 的 `inject` 数组，只声明 `"remote"` 不够；对齐官方 sidebar-files / documentpreview（二者都显式声明 `"remote.workspaceFiles"`）。
- **修复**：inject 增 `"remote.workspaceFiles"`（数据面的唯一读盘通道，缺它整块数据面起不来）。同时测试断言从 4 项扩到 5 项（含 `remote.workspaceFiles`），杜绝回退。
- **实证确认调用形态**：服务端 RPC 是 `workspaceFiles/list|read|stat|changes`，收**工作区相对 path**；client 调用为 `workspaceFiles.list(sessionId, path, signal)`——0.3.5 的 `probeReadBook` 形态 0 正好命中。
- 样例书《星海拾骨》（novel.json + 账本 3 条 + 伏笔 1 开）已就位，供刷新后验证书目卡。
- 80/80 全绿。⚠️ 刷新 DSH web 页面装载即可。

## 0.3.5 (2026-09-13) — 数据面渲染：书目控制台（真实读取 + 解析）

- **读盘收敛**：新增 `probeReadBook`，对书目目录读取 4 个机器文件（`novel.json` / `账本/facts.json` / `账本/伏笔.json` / `.novel/style-baseline.json`），`read` 签名同样按多形态降级逐一尝试（对齐 0.3.4 的 list 收敛法）；能读到就顺手 parse——"读盘签名"与"真实渲染"一次收敛，失败带原始错误码不伪造。
- **纯解析层 `lib/book-console.js`（新）**：把文件文本解析成紧凑书目摘要（标题/阶段/已写章/已批准细纲/账本条数/伏笔开没与超期/基线有无），`summarizeBook` 全容错（缺失、非法 JSON、结构不符一律降级不抛）。8 例 node --test 直测（用插件真实数据结构）。
- **client 面渲染**：`ForgePanel` 新增「书目」卡，列出工作区里每本书的量化摘要；`loadBookConsole` 枚举 `list` 出的书目录逐个读盘。面板注册的 `inject` 工厂把 sessionId 带进来。
- **parity 门禁**：client 内联解析（`summarizeBookClient`，浏览器半无 import、需内联）与服务端 `lib/book-console.js` 用同一批样本断言**同口径**，封死"两处实现漂移"。
- **细节修正**：novel 缺失时 client 侧 chapters/approved 与 server 对齐为 `null`（不塌成 0）；一章都没读到时不造幽灵书目，只留 readError。
- 新增 12 例（解析 8 + parity 1 + 读盘收敛 3）。**80/80 全绿**。
- ⚠️ client bundle 按内容 hash 拉取，**刷新 DSH web 页面**即可装载（无需进程重启）；数据面是否读盘成功看「书目」卡的 read 行。

## 0.3.4 (2026-09-13) — 数据面开工：接上 Client Remote + 修面板版本硬编码

- **修版本漂移（真 bug）**：面板徽章硬编码 `v0.3.0`，0.3.1→0.3.3 三轮都没跟着改，界面上挂了三版旧号。
  现抽成常量 `PLUGIN_VERSION`，并新增断言强制它等于 `package.json` 的 `version`——再漂移会被测试当场拦下。
- **接上数据面通道**：`inject` 增 `"remote"`；tab 面板的 slot 注册改为带
  `inject: (sessionId, actions) => …` 工厂，把会话 id 交给组件
  （对齐 `dsh-client-ui-sidebar-documentpreview` 的官方姿势——这是拿到 sessionId 的唯一入口，
  0.3.0 起的注册没写它，面板一直拿不到会话上下文）。
- **选型结论（实证，非猜测）**：client 半读工作区**不必自建 typert 域**。
  官方 `remote.workspaceFiles` 域已提供 `read` / `readBytes` / `stat` / `list` / `changes`，
  足以覆盖书目（`novel.json`）、账本（`facts.json`）、正文与基线的全部读盘需求。
  调用签名是 `(sessionId, path, …args, signal)`（比 d.ts 的 wire 类型多一个 sessionId）；
  `read`/`readBytes`/`stat` 收**绝对路径**，`list` 收**工作区相对路径**。
  自建域需 typert 代码生成链（`Generated by dsh-typert-generator … do not edit`），
  留给 v0.4 需要服务端计算的聚合指标。
- **新增运行时探测**：面板「数据面探测」卡显示 `sessionId` / `$host`（home、isLoopback）/
  可用 remote 域清单 / 工作区根目录列表。`probeRemote` 是纯逻辑，含 `list` 四种调用形态的降级链，
  失败时**原样带回错误码**而非伪造数据——四种形态的错误码能一次性收敛出正确写法。
- 导出 `__internals`（前缀 `__`，非插件对外契约）供 headless 门禁直测探测逻辑，
  把"浏览器半没法测"的又一个坑填成可命令复现的用例。新增 3 例：
  sessionId 注入、版本同步、探测降级与错误聚合。**68/68 全绿**。
- ⚠️ client bundle 在 web 进程内缓存，需**重启 DSH web** 装载（link 已同步，无需重装）。
- 下一步（v0.4）：按探测结果收敛 `list` 形态 → 面板渲染真实书目/账本/伏笔。


## 0.3.3 (2026-09-13) — 修复"锻炉"tab 仍不出现：缺第三步 openTab（0.3.2 只补齐了前两步）

- **真根因**：进右侧栏某格只有一条路——`ctx.sidebarRight.openTab(kind)`（资源类走 `openResource`）。
  `sidebarRightTabs.register` 只是**第一阶段：声明类型**，它本身不产生 tab；0.3.2 补齐了类型声明，
  但**从没有人"打开"过这个类型**，所以右侧栏永远不多出一格。官方 `dsh-client-ui-sidebar-right`
  的类型文档原文：*"Tab types register in two stages… And `openResource`/`openTab` are the navigation
  controller, and **every way into the column is a call to one of them**."*
- **修复 `lib/client.js`（三步齐活）**：
  1. `inject` 补 `"sidebarRight"`——打开 tab 需要导航面（0.3.2 只 inject 了 slots + sidebarRightTabs）。
  2. tab 定义补 `guide` 条目：右侧栏 guide 是常驻 docked 页，任何 session 都能从「🔨 锻炉」胶囊把 tab 拉出来（**长期入口**，切会话后依然可用）。
  3. apply 第三步排一个 400ms 启动延迟调 `openTab("novel-forge")`。seat 未挂载时 openTab 按设计**直接抛**（没有 session 可操作时宁可报错，也不静默写进没人画的 surface），故按 250ms 节拍重试（上限 40 次 ≈ 10s），**开成即停**——用户手动关掉后不再骚扰。
- **诊断钩子**：client 装载/失败会在浏览器 console 打 `[dsh-novel-forge]` 前缀日志，用于区分"bundle 根本没加载"与"加载了但打开失败"两种故障。
- `test/client.test.mjs` 2 例 → 3 例：新增 guide 条目断言、page type（不声明 patterns）断言，以及"seat 未挂载 → 抛 → 重试 → 挂载后打开成功 → 不重复打开"的**假定时器确定性时序断言**（sandbox 里 setTimeout 换成受控记账，不引真实等待、不 flake）。65/65 全绿。
- ⚠️ client 图在 web 进程内缓存，需**重启 DSH web** 装载新 bundle（link 已同步，无需重装）。

## 0.3.2 (2026-09-12) — 修复"锻炉"tab 不出现：缺 sidebarRightTabs tab 类型注册

- **根因**：右侧栏 tab 是"tab 类型 + 内容 seat"两层。光注册 `sidebar.right.pane.tab` seat（0.3.0 所写）不会生成 tab 入口；必须先 `ctx.sidebarRightTabs.register({ id, kind, title })` 创建 tab 类型，内容才按 **id** 派发进 seat（对齐 dsh-client-ui-sidebar-files 的 tab-types+pane 体系）。0.3.0 只做了后一半 → 真机"没有🔨锻炉"。
- **修复**：`lib/client.js` 现在 `inject:["slots","sidebarRightTabs"]`，apply 先 `sidebarRightTabs.register({id:"novel-forge",kind:"novel-forge",title:()=>"锻炉"})`，tab id 同时作为两个 seat 的 key。
- `test/client.test.mjs` 增强：断言 apply 调用 `sidebarRightTabs.register` 恰好一次、id/kind 唯一、title="锻炉"，且 seat key 与 id 同源。64/64 全绿。
- ⚠️ client 图/负判定在 web 进程内缓存，需再次**重启 DSH web** 装载新 bundle（link 已同步，无需重装）后右侧栏应出现"🔨 锻炉"tab。

## 0.3.1 (2026-09-12) — client-half headless 注册验证门禁

- **新增 `test/client.test.mjs`**：用 `node:vm` 以 `__ModuleLoader__` 真实语义加载 `lib/client.js`，物化 `{ inject, apply }`，再用 slots/effect stub 跑 `apply(ctx)` 断言右侧栏两个槽位（`sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`）各注册一次、meta.name 与槽位同名、key=novel-forge、带组件函数。**把"假 ctx 载不了浏览器半"的验证坑填成可命令复现的门禁**——即便无浏览器也能确定性验证 client load 不炸、注册调用正确。
- 同时确认：裸 `react` 是平台可解析种子词（宿主 80 处已打包 client 均如此 require）；`dsh.client.inject` 指向的 `@deepseek-ai/dsh-client-ui-sidebar-right` 为宿主既有可注入服务。
- 排除需重启 web：客户端挂载错误只出现在浏览器 console，不落服务器日志，重启无诊断增益；服务器侧已确认 web 存活（HTTP 401 为登录门禁）且 link 安装、0.3.1 client 产物与声明就位。64/64 测试全绿。

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
