# 兼容矩阵 COMPATIBILITY

| dsh-novel-forge | 宿主 dsh（已验证） | 依据 |
| --- | --- | --- |
| 0.2.x | 0.1.5-rc.1 | 本仓库开发与测试所用的宿主版本；插件只消费稳定面 |

## 我们依赖的宿主面（升级宿主前逐条核对）

插件刻意把宿主面收敛到最稳定的一层，全部位于 Node 半（工具/提示注册），不触碰 client 内部 API：

| 依赖 | 来源 | 说明 |
| --- | --- | --- |
| `ctx.tools.register(tool)` | `@deepseek-ai/dsh-tools` | 工具注册 |
| `defineTool({name, description, parameters, output, isConcurrencySafe, timeoutMs, execute})` | `@deepseek-ai/dsh-tools` | 与 `dsh-files` 0.5.x 同款用法 |
| `ctx.fs.resolve / stat / readText / writeText` | `@deepseek-ai/dsh-fs` | 全部文件读写走宿主 fs（受沙箱与审批策略约束）；`writeText` 由本地后端自动创建父目录 |
| `ctx.fs.listDir` | `@deepseek-ai/dsh-fs` | 0.2.1 起依赖：`novel_clone_project` 经 `fsio.listNames` 扫描细纲目录（未批准细纲一并复制）。若宿主移除该面，克隆退化为"只复制已批准/已写章" |
| `ctx.systemPrompt.section({name, order, text})` | 宿主 system-prompt 服务 | 工作流纪律注入 |
| `exec.agent?.session?.header?.cwd` | 工具执行上下文 | 会话工作目录解析（`dsh-files` 同款） |
| `@deepseek-ai/schemastery` | 宿主自带 | Config schema |

## 已知断裂史（改这些行为时务必 bump 主版本）

- 宿主 0.1.2-rc.1 → 0.1.3：移除 `@deepseek-ai/dsh-client-runtime`、客户端 API 表面断裂（社区插件 dsh-novel-writing / dsh-novel-solo 均发布过紧急兼容版）。本插件 **不 import 任何 client 半模块**，理论上面不受影响，但升级后仍请先在隔离 profile 冒烟。
- `output.schema` 与 execute 返回值必须逐字段一致（`additionalProperties: false`），漏声明字段会得到 INVALID_TOOL_OUTPUT。
