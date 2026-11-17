# MCP 客户端安装：在 Claude / Cursor / 任意 MCP 客户端中使用 novel_* 工具

无需安装 DSH 宿主：dsh-novel-forge 自带一个零依赖的 stdio MCP Server，把同一套
`novel_*` 工具（门禁/账本/审计/基线全在工具层）暴露给任意 MCP 客户端。一本小说 =
工作区里的一个目录；所有门禁、账本与审计行为与宿主内完全一致。

## 前置

- **Node.js ≥ 20**。长篇检索索引用到 `node:sqlite`（Node ≥ 22 体验完整；缺席时自动退化为关键词匹配，其余功能不受影响）。
- **dsh-novel-forge ≥ 1.7.2**（`npx` 直跑形态的版本要求；更早版本在宿主外启动有缺陷）。
- 一份小说工作区目录（空目录即可，第一本书用 `novel_project init` 创建）。

**无需构建**：npx 直跑与全局安装都直接从 npm 拿现成产物，不 clone 源码、不 `npm run build`。
唯一需要自己构建的形态是「源码 clone」（形态 C），且仅开发者需要——普通接入用 A 或 B 即可。

## 三种安装形态

下面三种形态任选其一，`env` 一律相同（见下节 `NOVEL_FORGE_ROOT`）。

### A. npx 直跑（推荐，零安装）

```json
{
  "mcpServers": {
    "novel-forge": {
      "command": "npx",
      "args": ["-y", "dsh-novel-forge"],
      "env": { "NOVEL_FORGE_ROOT": "/你的小说工作区" }
    }
  }
}
```

### B. 全局安装后常驻

```bash
npm install -g dsh-novel-forge
```

```json
{
  "mcpServers": {
    "novel-forge": {
      "command": "dsh-novel-forge-mcp",
      "args": [],
      "env": { "NOVEL_FORGE_ROOT": "/你的小说工作区" }
    }
  }
}
```

### C. 源码 clone（开发者）

```bash
git clone https://github.com/huangziyuan-general/dsh-novel-forge.git
```

```json
{
  "mcpServers": {
    "novel-forge": {
      "command": "node",
      "args": ["/path/to/dsh-novel-forge/mcp/server.mjs"],
      "env": { "NOVEL_FORGE_ROOT": "/你的小说工作区" }
    }
  }
}
```

## 分客户端接入

### Claude Code

一行命令接入（默认只进当前项目；加 `-s user` 让所有项目可用）：

```bash
claude mcp add novel-forge -e NOVEL_FORGE_ROOT=/你的小说工作区 -- npx -y dsh-novel-forge
```

### Claude Desktop

编辑配置文件（不在 `mcpServers` 里就新建该键），加入上面任一形态的 JSON，然后重启 Claude Desktop：

- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows：`%APPDATA%\Claude\claude_desktop_config.json`

### Cursor

`~/.cursor/mcp.json` 里加入同一份 `mcpServers` JSON（或 Settings → MCP → Add server 粘贴同样内容），重启 Cursor。

### Codex

`~/.codex/config.toml` 追加：

```toml
[mcp_servers.novel-forge]
command = "npx"
args = ["-y", "dsh-novel-forge"]
env = { NOVEL_FORGE_ROOT = "/你的小说工作区" }
```

### 任意 stdio MCP 客户端

同一份 `mcpServers` JSON（`command` + `args` + `env`）。协议为 JSON-RPC 2.0 over
stdio，零第三方依赖——宿主 peer 包缺席也能启动（输出校验退化为不校验，工具本体照常）。

## NOVEL_FORGE_ROOT（务必显式设置）

| 变量 | 必填 | 取值 | 说明 |
| --- | --- | --- | --- |
| `NOVEL_FORGE_ROOT` | GUI 客户端必填 | 小说工作区根目录（绝对路径） | 一本小说 = 工作区里的一个目录。缺省为进程 cwd；GUI 客户端（Claude Desktop / Cursor）的 cwd 不可控——不设置会落到安装目录，找不到你的书。CLI 客户端（Claude Code / Codex）在项目目录下启动时 cwd 即项目，可省，但显式设置最稳。 |

## 验证

接入后在对话里说「列出小说工具」：应看到 **24 个** `novel_*` 工具；再说
「用 novel_project init 建一本测试书」，`NOVEL_FORGE_ROOT` 下出现新书目录即通。

## 能力边界

- **全功能**：写章门禁、机审、账本（事实/关系/弧线/认知/叙事契约）、伏笔、检索、导入导出、克隆、全书体检等零模型工具。
- **受限**：需要旁路模型的工具（一键润色/校对/语义拆书/档案抽取/批量起草的模型调用）在 MCP 通道返回带指引的报错——它们依赖 DSH 宿主的模型路由；提案审批、批量留痕、三路合并等面板可视化也只在 DSH 宿主内。
- **数据安全**：宿主外的 fs 后端带与宿主相同的 containment 与版本守卫语义；书稿只落在你指定的 `NOVEL_FORGE_ROOT` 下。

## 常见问题

- **启动失败（server 起不来 / 立刻退出）**：多半是 Node 版本不够（需 ≥ 20；≥ 22 才能启用检索索引，缺 `node:sqlite` 时自动降级为关键词匹配，不影响其他工具）；或装到的是 1.7.2 之前的旧版本（在宿主外启动有缺陷）——`npx -y dsh-novel-forge` 会拉最新，全局安装先 `npm view dsh-novel-forge version` 确认。
- **工具不显示（客户端里看不到 24 个 `novel_*`）**：改完配置必须**重启客户端**才生效；确认 server 进程在客户端的 MCP 面板/日志里是 connected；再确认 `NOVEL_FORGE_ROOT` 填了——路径不存在或不可写时 server 启动即报错，工具自然一个都列不出来。
- **路径错误（找不到书 / 找不到工作区）**：`NOVEL_FORGE_ROOT` 缺省取进程 cwd；GUI 客户端的 cwd 不可控，务必用绝对路径显式设置。确认该目录存在且当前用户对它有读写权限（权限不足时同样表现为「找不到书」）。
- **权限问题（写不了）**：书稿只落在 `NOVEL_FORGE_ROOT` 下（containment 与宿主同语义），该目录不可写时全部写入类工具报错；把路径指到你有写权限的目录即可，别用 `/` 或系统目录。
