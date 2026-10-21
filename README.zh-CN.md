# jiflow-canvas-mcp

一个独立的 **[MCP（Model Context Protocol）](https://modelcontextprotocol.io/) stdio 服务器**，让 AI Agent 能够安全地读取和修改本地的**画布图（canvas graph）**。

服务器通过 stdin/stdout 上的换行分隔 JSON-RPC 2.0 协议，仅暴露九个列入白名单的 `canvas_*` 工具。每一次写入都需要通过带作用域（scope）的静态令牌认证，并受比较并交换（CAS）修订号检查与**安全的按画布锁**保护（所有者令牌文件 + 单调递增栅栏（fence），仅对同主机上可证明已死亡的属主执行崩溃恢复）；写入内容会与持久化的操作回执（receipt）一起原子提交，因此中断或重试的操作可以幂等重放，而不会被重复应用。

> **项目状态：MIT 开源项目，已在 GitHub 公开。**
> 仓库：[q973946080/jiflow-canvas-mcp](https://github.com/q973946080/jiflow-canvas-mcp)。v0.1.0 源码发行包可在 GitHub Releases 获取。项目**尚未发布到 npm**，也不声称已有外部用户采用或已获得 OpenAI/Codex for OSS 优惠。发布前核验结果：**179/179 项自动化测试、11/11 项功能验收通过**。
>
> **许可证：MIT。** Copyright (c) 2026 chen gs；`package.json` 与 `package-lock.json` 均声明 `MIT`。
>
> **发布范围：** 只有本仓库中的文件属于公开发布内容。内部审计、来源与验证记录不属于本仓库，且永远不会发布。

## 目录

- [是什么](#是什么)
- [特性](#特性)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [MCP 客户端配置](#mcp-客户端配置)
- [认证与权限范围](#认证与权限范围)
- [工具](#工具)
- [写入：CAS、回执与幂等重放](#写入cas回执与幂等重放)
- [CLI 参考](#cli-参考)
- [存储布局](#存储布局)
- [错误码](#错误码)
- [示例](#示例)
- [恢复与安全重试](#恢复与安全重试)
- [验证状态](#验证状态)
- [已知限制](#已知限制)
- [安全](#安全)
- [许可证](#许可证)

## 是什么

`jiflow-canvas-mcp` 是一个小型、零依赖的本地服务，为 AI Agent 提供针对单个画布数据目录的**狭窄、安全的工具面**：

- Agent 可以**列出和读取**画布、节点和操作回执；
- Agent 可以**创建/修改节点、连接节点**，可以单次操作，也可以作为有序批量操作；
- 除此之外**什么都做不了** — 没有 shell、文件、HTTP 或删除工具，也没有匿名访问；
- 共享同一存储的多个 Agent（多个服务器进程）不会静默互相覆盖：过期的修订号会被拒绝，调用方必须重新读取后重试；
- 并发写入者不能抢占**存活**的锁持有者：锁携带所有者令牌、进程身份和单调递增的栅栏；失去锁代次的属主无法提交，无法安全验证的锁会失败即关闭而不是被抢占；
- 每个已应用的操作都会留下**回执**，其中包含精确负载的哈希；因此使用相同 `operationId` 重试时会返回原始结果，而不是写入两次。

画布模型刻意保持通用：五种节点类型（`text`、`image`、`video`、`audio`、`note`）、一小组可变的节点数据字段，以及按能力表校验的边。不包含任何特定产品的业务词汇或业务逻辑。设计说明见 [`ARCHITECTURE.md`](ARCHITECTURE.md)。

## 特性

- **九个白名单工具** — 五个读取工具和四个写入工具；白名单是工具名称与参数 schema 的唯一权威来源。没有 shell/文件/网络工具，也没有任何绕过开关。
- **零运行时依赖** — 服务器只导入 Node 内置模块（`node:fs`、`node:path`、`node:crypto`、`node:url`、`node:process`）。唯一的 devDependency 是 MIT 许可的 `@modelcontextprotocol/sdk@1.30.0`，仅被协议测试套件与验收运行器使用；`src/` 从不导入它。
- **带作用域的静态令牌** — 每个 principal 拥有 SHA-256 令牌摘要、模式（`READ_ONLY` 或 `CANVAS_WRITE`）、画布允许列表以及可选的工具允许列表。启动失败即关闭（fail closed）。
- **CAS 修订号冲突检测** — 写入携带 `expectedRevision`；不匹配时返回 `CANVAS_REVISION_CONFLICT` 及 `{expectedRevision, actualRevision}`，并且不写入任何内容。
- **原子文件存储** — 每个画布一个 JSON 文件，通过同目录临时文件 + `fsync` + 原子 `rename` 写入，状态文件权限为 `0600`。
- **持久回执 + 幂等重放** — 回执与画布状态存储在同一个 JSON 文件中，因此状态变更与回执一起提交。使用相同负载重放同一个 `operationId` 会返回已存储的结果（`replayed: true`），不会发生第二次写入。
- **安全的按画布锁** — 写入者通过原子硬链接（对已完整写入的 `0600` 认领文件创建硬链接）认领一个 JSON **所有者记录**，其中包含唯一令牌、PID、主机名和**单调递增栅栏（fence）**。存活的属主永不被抢占；释放时校验所有权，绝不删除他人的锁；对**同主机上可证明已死亡**的属主（存活检查为 `ESRCH` 且超过年龄门限）的恢复由按画布的**恢复标记**串行化，而死恢复标记本身只有在持有独立的**恢复守卫（recovery guard）**时才能被回收。存活的恢复守卫或恢复标记永不被抢占；已死亡/外部主机/损坏/无法判定的恢复守卫会以 `CANVAS_LOCK_UNVERIFIABLE` 失败即关闭并给出人工清理动作（恢复标记持有者崩溃会通过守卫自动恢复；恢复守卫持有者崩溃则刻意不自动恢复）。锁代次已失效的写入者会在任何状态写入之前被 `CANVAS_LOCK_OWNERSHIP_LOST` 拒绝；损坏记录、外部主机或无法判定的存活状态会以 `CANVAS_LOCK_UNVERIFIABLE` 失败即关闭。
- **审计日志** — 仅在 **stderr** 上每行输出一个 JSON 对象（stdout 是纯协议通道），记录参数摘要而不是原始参数，且绝不包含任何令牌材料。

## 环境要求

- **Node.js >= 20**（`engines.node: ">=20.0.0"`）。开发与记录在案的验收运行使用 Node.js **v24.11.1**。
- 一个用作存储的本地目录（由你创建；服务器启动前该目录必须已存在）。
- `npm` 仅用于安装测试期 devDependency；**服务器本身没有运行时依赖，仅靠 `src/` 的一份拷贝即可运行**。
- 操作系统：在 macOS（darwin arm64）上开发和测试。代码只使用可移植的 Node 内置模块，但本候选项目尚未在其他平台上测试。

## 安装

GitHub 仓库现已公开：[q973946080/jiflow-canvas-mcp](https://github.com/q973946080/jiflow-canvas-mcp)。使用以下命令克隆：

```bash
git clone https://github.com/q973946080/jiflow-canvas-mcp.git
cd jiflow-canvas-mcp
npm ci   # 可选：安装 @modelcontextprotocol/sdk@1.30.0（仅测试用 devDependency）
```

服务器本身没有运行时依赖；如果只想运行服务器，可以跳过 `npm ci`，直接在检出目录运行 `node src/server/main.mjs`。项目通过 GitHub 提供源码，尚未发布到 npm。

如果只想运行服务器，可以跳过 `npm ci`：复制仓库后直接运行 `node src/server/main.mjs`。

## 快速开始

示例只使用**虚构的演示数据**（画布 id 为 `canvas-demo-a` / `canvas-demo-b`，URL 使用 `example.invalid`，令牌是文档中说明的 `demo-*` 占位符）。

```bash
npm run seed:demo       # 写入 examples/demo-store/ 和 examples/auth.demo.json（虚构、幂等）
npm run demo            # 启动真实服务器：读取 → 创建 → 修改 → 连接 → 回执 → 幂等重放
npm run demo:conflict   # 两个服务器进程竞争同一个过期修订号；恰好一个成功，失败者重试
```

直接针对演示存储运行服务器（stdin/stdout 即 MCP 传输通道；`Ctrl-D` / EOF 以退出码 0 结束）：

```bash
CANVAS_MCP_TOKEN=demo-reader-token \
  node src/server/main.mjs \
    --store examples/demo-store \
    --auth examples/auth.demo.json
```

## MCP 客户端配置

任何能够启动 stdio 服务器的 MCP 客户端都可以使用本服务器。请为 `src/server/main.mjs` 以及 `--store`、`--auth` 使用**绝对路径**：

```json
{
  "mcpServers": {
    "jiflow-canvas-mcp": {
      "command": "node",
      "args": [
        "/absolute/path/to/jiflow-canvas-mcp/src/server/main.mjs",
        "--store", "/absolute/path/to/canvas-store",
        "--auth", "/absolute/path/to/auth.json"
      ],
      "env": {
        "CANVAS_MCP_TOKEN": "<your-token>"
      }
    }
  }
}
```

说明：

- `mcpServers` 是常见的 MCP 客户端配置结构；如果你的客户端使用不同的外层结构，请查阅其文档。关键部分是：`command: "node"`、服务器入口的绝对路径、两个必需参数，以及通过环境变量提供的令牌。
- 令牌**只能**通过 `CANVAS_MCP_TOKEN` 环境变量传入，绝不接受命令行参数形式。
- 服务器一次处理一条 JSON-RPC 消息；每个客户端的 `initialize` 握手会协商协议版本（见 [ARCHITECTURE.md](ARCHITECTURE.md#mcp-method-support)）。
- 日志写入服务器的 stderr，响应写入 stdout。客户端不应混用两者。

## 认证与权限范围

认证是强制性的：**没有匿名模式、没有演示绕过开关，也无法在没有匹配令牌的情况下启动服务器。** 启动时服务器依次检查 CLI 配置、存储目录、认证配置文件与令牌，遇到第一个失败即退出非零码。

认证配置是一个 JSON 文件，其中只包含令牌的 **SHA-256 摘要**，绝不包含原始令牌：

```json
{
  "version": 1,
  "principals": [
    {
      "principalId": "agent-writer-a",
      "tokenSha256": "<64 lowercase hex characters>",
      "mode": "CANVAS_WRITE",
      "canvasIds": ["canvas-demo-a"],
      "allowedTools": null
    },
    {
      "principalId": "agent-reader",
      "tokenSha256": "<64 lowercase hex characters>",
      "mode": "READ_ONLY",
      "canvasIds": ["*"],
      "allowedTools": null
    }
  ]
}
```

规则：

| 字段 | 规则 |
|---|---|
| `version` | 必须为 `1`。 |
| `principalId` | `^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$`；令牌摘要必须唯一。 |
| `tokenSha256` | 恰好 64 个小写十六进制字符；不同 principal 之间的重复摘要会被拒绝。 |
| `mode` | `READ_ONLY` 或 `CANVAS_WRITE`；其他值使配置无效。 |
| `canvasIds` | 非空的画布 id 数组，或唯一的通配符 `["*"]`；重复项会被拒绝。 |
| `allowedTools` | `null`/缺省 = 所有白名单工具（仍受 mode 限制）；否则为白名单工具名的非空数组。未知工具名使配置无效。 |

使用 Node 生成令牌摘要（令牌从参数读取，不会写入磁盘）：

```bash
node -e "console.log(require('node:crypto').createHash('sha256').update(process.argv[1],'utf8').digest('hex'))" "your-token"
```

启动时，服务器对 `CANVAS_MCP_TOKEN` 中的令牌做哈希，并以常量时间（`crypto.timingSafeEqual`）与每个已配置摘要比较；必须恰好匹配一个。令牌缺失时以退出码 **3** 失败并返回 `CANVAS_AUTH_REQUIRED`；未知令牌以退出码 **3** 失败并返回 `CANVAS_PRINCIPAL_UNKNOWN`。

`--agent-id`（可选）会作为标签记录在审计日志和回执中。它绝不能改变已认证的 `principalId` 或该 principal 的权限。

### 演示令牌（虚构、公开、仅用于演示）

`npm run seed:demo` 会创建 `examples/auth.demo.json`，其中包含以下**刻意设置为弱口令的公开演示固定值**。它们被记录下来是为了让示例可复现；**切勿在其他任何地方复用**。

| Principal | 模式 | 画布范围 | 令牌（公开演示固定值） |
|---|---|---|---|
| `agent-writer-a` | `CANVAS_WRITE` | `canvas-demo-a` | `demo-writer-a-token` |
| `agent-writer-b` | `CANVAS_WRITE` | `canvas-demo-b` | `demo-writer-b-token` |
| `agent-reader` | `READ_ONLY` | `*`（所有画布） | `demo-reader-token` |

认证文件只存储每个演示令牌的 SHA-256 摘要。

## 工具

恰好九个工具，全部以 `canvas_*` 命名（宿主/客户端可能添加自己的命名空间前缀）。每个写入工具还接受可选的 `expectedRevision` 和 `operationId` 参数。

| # | 工具 | 权限 | 必需参数 | 可选参数 |
|---|---|---|---|---|
| 1 | `canvas_list_canvases` | `READ` | — | — |
| 2 | `canvas_read_canvas` | `READ` | `canvasId` | — |
| 3 | `canvas_read_node` | `READ` | `canvasId`、`nodeId` | — |
| 4 | `canvas_read_receipt` | `READ` | `canvasId`、`operationId` | — |
| 5 | `canvas_list_receipts` | `READ` | `canvasId` | `limit`（整数 1–100，默认 20） |
| 6 | `canvas_create_node` | `WRITE` | `canvasId`、`kind`、`label` | `position`、`data`、`nodeId`、`expectedRevision`、`operationId` |
| 7 | `canvas_patch_node` | `WRITE` | `canvasId`、`nodeId` | `data`、`position`、`expectedRevision`、`operationId`（`data`/`position` 至少提供一个） |
| 8 | `canvas_connect_nodes` | `WRITE` | `canvasId`、`source`、`target` | `relation`（默认 `reference`）、`edgeId`、`expectedRevision`、`operationId` |
| 9 | `canvas_commit_batch` | `WRITE` | `canvasId`、`actions`（1–100 个操作） | `expectedRevision`、`operationId` |

画布/节点/边模型摘要（完整表格见 [`ARCHITECTURE.md`](ARCHITECTURE.md#data-model)；每个工具的完整参数、结果结构与原始 JSON-RPC 示例见 [`docs/TOOLS.md`](docs/TOOLS.md)）：

- **节点类型：** `text`、`image`、`video`、`audio`、`note`；每个节点为 `{id, type, position: {x, y}, data}`。
- **可写节点数据字段：** `label`、`status`（`idle`/`running`/`done`/`error`/`skipped`）、`source`、`content`、`prompt`、`url`（必须以 `http://` 或 `https://` 开头）、`mimeType`、`width`、`height`、`duration`、`errorMessage`。受保护字段（`nodeType`、`assetId`、`stateId`，以及节点级的 `id`/`type`）如果由调用方提供会被拒绝。
- **边：** `{id, source, target, relation}`。允许的关系为 `image → video` 配 `reference`、`text → note` 配 `context`；自环以及重复的 id/三元组会被拒绝。
- **批量操作：** `node.create`、`node.patch`、`edge.connect`。一个批量的所有操作作为一个修订号原子应用。
- **读取结果**包含 `ok`、`tool`、`permission`、`server: "jiflow-canvas-mcp"`、`principalId` 和 `agentId`。**写入结果**额外包含 `operationId`、`kind: "canvas.batch"`、`replayed`、`payloadHash`、`revision`、`result: {canvasId, revision, nodes, edges}` 以及受影响的 id。
- 工具失败会作为 MCP 工具结果返回，`isError: true`，JSON 载荷为 `{ok: false, code, error, detail?}`，使用下方稳定的错误码 — 绝不会导致崩溃。

## 写入：CAS、回执与幂等重放

一次写入就是一个 `canvas.batch` 操作：

```
{operationId, kind: "canvas.batch", payload: {canvasId, expectedRevision, actions: [...]}}
```

- **`expectedRevision`** — 调用方认为的当前修订号。如果省略，dispatcher 会先读取当前修订号（写入结果中会报告 `source: "provided"` 或 `source: "read"`），但存储层仍然执行 CAS 检查。如果期间修订号已变化，写入失败并返回 `CANVAS_REVISION_CONFLICT`，且**什么都不写入、修订号不增加、回执不持久化**。
- **`operationId`** — 幂等键。如果省略，服务器生成 `op-<uuid v4>`。如果再次发送相同的 `operationId`：
  - 作用域相同、kind 相同且**负载完全一致**（经过规范化 JSON 处理后）→ 返回已存储的结果，`replayed: true`，修订号为原始的 `resultingRevision`；不发生变更，也不新增回执；
  - 负载/作用域/kind 不同 → `CANVAS_OPERATION_PAYLOAD_CONFLICT` / `CANVAS_OPERATION_SCOPE_CONFLICT` / `CANVAS_OPERATION_KIND_CONFLICT`。
- **`payloadHash`** = `sha256(canonicalJson(payload))`；回执中还记录 **`scopeHash`** = `sha256(canonicalJson({principalId, canvasId}))`。两者都使用确定性的规范化 JSON 形式（键排序、`-0` 归一化为 `0`、拒绝非有限数字和循环引用）。
- **回执字段**（公开投影）：`operationId`、`kind`、`payloadHash`、`scopeHash`、`expectedRevision`、`resultingRevision`、`actionKinds`、`principalId`、`agentId`、`committedAt`、`result`。回执中绝不存储令牌、原始参数或文件内容。
- 回执与状态变更**在同一个画布 JSON 状态文件、同一次原子写入中**完成，因此已提交的操作一定有回执，失败的操作既没有状态变更也没有回执。

由于生成的 id 每次调用都是新的 UUID，省略 `nodeId`/`edgeId`/`operationId` 的盲目重试是一个*不同的*负载，会被重放检查拒绝。为了可安全重试的写入，请显式传入 id 并在重试时复用。参见[恢复与安全重试](#恢复与安全重试)。

## CLI 参考

```text
node src/server/main.mjs --store <dir> --auth <file.json> [options]
```

| 参数 | 必需 | 默认值 | 说明 |
|---|---|---|---|
| `--store <dir>` | 是 | — | 用作画布存储的已存在目录（可以为空；子目录会被创建）。 |
| `--auth <file.json>` | 是 | — | 包含令牌 SHA-256 摘要与作用域的认证配置。 |
| `--agent-id <id>` | 否 | principal id | 记录在回执和日志中的 ASCII 标签（1–64 个可打印字符）。 |
| `--lock-timeout-ms <n>` | 否 | `5000` | 等待被持有的画布锁的最长时间，超时返回 `CANVAS_STORE_BUSY`。 |
| `--stale-lock-ms <n>` | 否 | `10000` | 对**可证明已死亡**的属主执行隔离恢复前的最小年龄门限（必须在同一主机上判定为已死亡；年龄本身永不作为死亡证据）。 |
| `--help`、`-h` | — | — | 将用法打印到 stdout 并以 `0` 退出。 |
| `--version`、`-v` | — | — | 将 `0.1.0` 打印到 stdout 并以 `0` 退出。 |

退出码：

| 码 | 含义 |
|---|---|
| `0` | 正常运行：`--help`/`--version`、stdin 遇到 EOF、或优雅处理 `SIGINT`/`SIGTERM`。 |
| `1` | 未预期的内部错误（`CANVAS_INTERNAL_ERROR`）。 |
| `2` | 配置/存储问题（`--store` 缺失或无效、数字参数错误、未知参数、启动时存储损坏）。 |
| `3` | 认证问题（`CANVAS_AUTH_REQUIRED`、`CANVAS_AUTH_CONFIG_INVALID`、`CANVAS_PRINCIPAL_UNKNOWN`）。 |

stdout 是协议通道，只承载 JSON-RPC 响应。所有诊断信息和审计日志都是 stderr 上的 JSON 行。

## 存储布局

```text
<store>/
  canvases/
    <canvasId>.json        # 每个画布一个状态文件（状态 + 回执 + lockFence）
  .locks/
    <canvasId>.lock        # JSON 锁所有者记录：token、pid、hostname、fence（0600 文件）
    <canvasId>.fence       # 单调递增的锁代次计数器（0600 文件）
    .<canvasId>.recovery   # 隐藏的按画布恢复标记（0600 文件；串行化已死亡属主的恢复）
    .<canvasId>.recovery-guard # 隐藏的恢复守卫（0600 文件；串行化死恢复标记的回收；永不自动回收）
    .claim-… / .marker-claim-… / .guard-claim-… / .quarantine-… / .marker-quarantine-…   # 短暂临时文件
```

- 画布 id 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`，且不得包含 `..`、`/` 或 `\`；它们在**任何路径拼接之前**被校验，因此存储绝不会读写 `<store>` 之外的位置。
- 状态文件是 JSON，顶层包含 `storeVersion: 1`、`canvas`、`revision`、`data: {nodes, edges}`、`tombstones`、`receipts`、`updatedAt`，以及可选的 `lockFence`（提交最后一次写入的锁代次）。格式错误或结构不符的文件会报告为 `CANVAS_STORE_CORRUPT`，绝不会被静默重新初始化。
- 用于原子写入的临时文件在 `canvases/` 内以 `0600` 权限创建，失败时会被清理。
- 读取不获取锁：写入通过原子替换整个文件完成，因此读取方看到的要么是完整旧状态，要么是完整新状态。写入会获取所有者记录锁、校验所有权、在锁内重新读取权威修订号与 `lockFence`，并且只提交一次。崩溃恢复还会使用隐藏的恢复标记与恢复守卫；`inspectCanvasLock(storeDir, canvasId)` 以只读方式报告它们的状态。

完整的状态文件示例见 [`ARCHITECTURE.md`](ARCHITECTURE.md#store-format)。

## 错误码

所有错误码都是稳定的、机器可读的字符串。MCP 载荷为 `{ok: false, code, error: "<message>", detail?: {...}}`；`detail` 绝不包含令牌或超出 id/修订号范围的原始调用内容。注册表共包含**六个组、40 个稳定错误码**。

**工具与参数错误**

| 错误码 | 含义 |
|---|---|
| `CANVAS_TOOL_NOT_WHITELISTED` | 工具名不在九个白名单工具中（在访问存储前检查）。 |
| `CANVAS_TOOL_UNKNOWN` | 工具名缺失或不是字符串。 |
| `CANVAS_TOOL_DENIED` | 工具在白名单中，但不在该 principal 的 `allowedTools` 内。 |
| `CANVAS_ARGUMENTS_INVALID` | 参数未通过 schema 校验 / 存在未知键 / 结构错误。 |
| `CANVAS_ACTION_NOT_WHITELISTED` | 批量操作类型不是 `node.create`、`node.patch` 或 `edge.connect`。 |
| `CANVAS_ACTION_INVALID` | 操作结构错误或操作值无效。 |

**认证与授权错误**

| 错误码 | 含义 |
|---|---|
| `CANVAS_AUTH_REQUIRED` | `CANVAS_MCP_TOKEN` 缺失或为空（启动时，退出码 3）。 |
| `CANVAS_AUTH_CONFIG_INVALID` | 认证配置不可读、JSON 无效或 schema 违规（启动时，退出码 3）。 |
| `CANVAS_PRINCIPAL_UNKNOWN` | 令牌不匹配任何已配置的 principal（启动时，退出码 3）。 |
| `CANVAS_READ_ONLY` | `READ_ONLY` principal 尝试调用写入工具。 |
| `CANVAS_AUTH_DENIED` | 授权失败（包括伪造/不可信的操作作用域）。 |
| `CANVAS_CANVAS_SCOPE_MISMATCH` | 画布不在该 principal 的 `canvasIds` 内。 |

**画布模型错误**

| 错误码 | 含义 |
|---|---|
| `CANVAS_CANVAS_ID_INVALID` | 画布 id 无效（形状/路径穿越）。 |
| `CANVAS_CANVAS_NOT_FOUND` | 作用域内的画布没有状态文件。 |
| `CANVAS_NODE_ID_INVALID` | 节点 id 无效（形状/路径穿越）。 |
| `CANVAS_NODE_ID_CONFLICT` | 节点 id 已被某个节点、边、墓碑、画布 id 或操作 id 占用。 |
| `CANVAS_NODE_NOT_FOUND` | 节点（或边的端点）不存在。 |
| `CANVAS_NODE_FIELD_PROTECTED` | 调用方提供了受保护的节点数据字段。 |
| `CANVAS_NODE_FIELD_UNKNOWN` | 未知的节点数据字段。 |
| `CANVAS_NODE_FIELD_INVALID` | 节点数据字段的类型/长度/值无效。 |
| `CANVAS_POSITION_INVALID` | 位置不是恰好两个有限数字。 |
| `CANVAS_EDGE_ID_INVALID` | 边 id 无效。 |
| `CANVAS_EDGE_ID_CONFLICT` | 重复的边 id 或重复的 `(source,target,relation)`。 |
| `CANVAS_EDGE_NOT_FOUND` | 边不存在。 |
| `CANVAS_EDGE_RELATION_INVALID` | 关系不被能力表允许，或为自环。 |

**修订号、操作与回执错误**

| 错误码 | 含义 |
|---|---|
| `CANVAS_REVISION_REQUIRED` | 没有可用的 `expectedRevision`（省略且无法读取当前修订号）。 |
| `CANVAS_REVISION_CONFLICT` | `expectedRevision` 已过期；`detail` 包含 `{expectedRevision, actualRevision}`。 |
| `CANVAS_REVISION_EXHAUSTED` | 修订号空间耗尽（实际不可达）。 |
| `CANVAS_OPERATION_ID_INVALID` | `operationId` 形状无效。 |
| `CANVAS_OPERATION_REQUEST_INVALID` | 操作信封格式错误。 |
| `CANVAS_OPERATION_SCOPE_CONFLICT` | `operationId` 已被不同作用域使用。 |
| `CANVAS_OPERATION_KIND_CONFLICT` | `operationId` 已被不同操作类型使用。 |
| `CANVAS_OPERATION_PAYLOAD_CONFLICT` | `operationId` 已被不同负载使用。 |
| `CANVAS_RECEIPT_NOT_FOUND` | 该画布上找不到该 `operationId` 的回执。 |

**锁错误**

| 错误码 | 含义 |
|---|---|
| `CANVAS_LOCK_OWNERSHIP_LOST` | 该操作对应的锁代次已不再是当前属主/栅栏；**不写入任何状态**。重新读取画布修订号后重试（切勿删除锁文件）。 |
| `CANVAS_LOCK_UNVERIFIABLE` | 锁/恢复状态无法被安全校验（锁/标记/守卫记录损坏、外部主机、硬链接不可用、存活状态无法判定，或**恢复守卫持有者已死亡**）。**失败即关闭**：既不写入也不接管。对于已死亡/外部主机/损坏/无法判定的恢复守卫，`detail` 携带 `action: MANUAL_OPERATOR_CLEANUP_REQUIRED` 以及 `reason` 之一：`GUARD_OWNER_DEAD`、`GUARD_FOREIGN_HOST`、`GUARD_RECORD_INVALID`、`GUARD_LIVENESS_UNKNOWN`；存活或外部的状态绝不会被移动或删除。 |

**存储与运行时错误**

| 错误码 | 含义 |
|---|---|
| `CANVAS_STORE_UNAVAILABLE` | 存储目录缺失/不可写，或状态无法持久化。 |
| `CANVAS_STORE_BUSY` | 存活的属主持有画布锁（或存活的恢复守卫/恢复标记正在恢复中）且 `--lock-timeout-ms` 已超时。存活的持有者永不被抢占。 |
| `CANVAS_STORE_CORRUPT` | 画布状态文件无法解析或结构错误。 |
| `CANVAS_INTERNAL_ERROR` | 未预期的内部失败（不泄露内部细节）。 |

## 示例

[`examples/`](examples/README.md) 目录包含零成本、虚构数据的演示：

| 命令 | 演示内容 |
|---|---|
| `npm run seed:demo` | 从头重建两个虚构画布（修订号 0）和虚构的认证配置。 |
| `npm run demo` | 真实 stdio 服务器：`initialize` → `tools/list`（9 个工具）→ 读取 → 创建 → 修改 → 连接 → 回执 → 幂等重放。 |
| `npm run demo:conflict` | 两个真实服务器进程读取同一修订号，均以过期的 `expectedRevision` 尝试写入：恰好一个成功，另一个得到 `CANVAS_REVISION_CONFLICT`；失败者重新读取后重试；胜者的操作通过另一进程重放。 |

`examples/` 包含在包的 `files` 允许列表中；生成的 `examples/demo-store/` 已被 git 忽略，绝不会进入发布物。

## 恢复与安全重试

服务器被设计为：崩溃、超时或响应丢失后，永远不需要猜测写入是否已落地：

1. **重试前先检查。** 如果响应丢失，使用显式 `operationId` 读取 `canvas_read_receipt`（或用 `canvas_list_receipts` 查看画布上最新的回执）。存在回执意味着操作已提交；其 `resultingRevision` 和 `result` 告诉你发生了什么变更。
2. **用完全相同的负载重试。** 要获得幂等重放，请重发完全相同的 `operationId` 和相同参数。创建时请显式传入 `nodeId`/`edgeId`，使负载保持稳定。
3. **过期修订号不是可以滥用的错误状态。** `CANVAS_REVISION_CONFLICT` 表示其他写入者获胜；重新读取画布，基于新状态重新计算你的变更，并使用新的 `expectedRevision` 提交（使用新的 `operationId`，因为负载/状态已改变）。
4. **`CANVAS_STORE_BUSY`** 表示**存活的**属主持有按画布锁，或存活的恢复守卫/恢复标记正在恢复中，且 `--lock-timeout-ms` 已超时。请稍后重试。存活的持有者永不被抢占；崩溃的锁属主只有在其被**证明已死于同一主机**（存活检查）且锁龄超过 `--stale-lock-ms`（默认 10 秒）后才会被恢复。切勿手工删除锁文件。
5. **`CANVAS_LOCK_OWNERSHIP_LOST`** 表示本次操作的锁代次在写入前已被取代：没有写入任何内容。重新读取画布（拿到新修订号）后重新尝试；不要复用已失效的锁状态，也不要删除锁文件。
6. **`CANVAS_LOCK_UNVERIFIABLE`** 表示锁/恢复状态无法被安全校验（所有者/栅栏/标记/守卫记录损坏、外部主机、硬链接不可用、存活状态无法判定，或**恢复守卫持有者已死亡**）。服务器失败即关闭且不写入。恢复语义：
   - 崩溃的**恢复标记**持有者会被自动恢复 —— 下一个进程获取恢复守卫并安全回收死标记，然后继续死属主恢复；
   - 崩溃的**恢复守卫**持有者**不会**被自动回收（否则会重新打开守卫旨在关闭的竞态）；该画布的死标记恢复会失败即关闭，需要人工处理。死亡守卫会报告 `detail.reason` 为 `GUARD_OWNER_DEAD`（或 `GUARD_FOREIGN_HOST` / `GUARD_RECORD_INVALID` / `GUARD_LIVENESS_UNKNOWN`）以及 `action: MANUAL_OPERATOR_CLEANUP_REQUIRED`。守卫只用于恢复路径，因此健康画布上的正常读写永远不会接触它。

   悬空恢复守卫的人工处理流程（仅在持续收到该错误时）：
   1. 停止使用该存储的所有画布服务器进程；
   2. 运行只读库诊断 `inspectCanvasLock(storeDir, canvasId)`，确认报告的 `recoveryGuard` 属主已死亡，且不存在存活的写入者/标记/守卫；
   3. 只有在此之后才删除悬空文件 `<store>/.locks/.<canvasId>.recovery-guard`；
   4. 重试。切勿删除存活或外部的守卫，也切勿删除写锁 `.lock` 文件。

   将跨主机或网络文件系统存储视为不支持。
7. **`CANVAS_STORE_CORRUPT`** 表示状态文件不可读；请备份并人工检查。服务器绝不会重新初始化或覆盖损坏的画布。

更完整的、可直接复制的重试模式见 [`docs/RECOVERY.md`](docs/RECOVERY.md)。

## 验证状态

本候选项目已通过独立技术核验：以下测试与验收矩阵由独立核验者使用真实服务器子进程、通过 stdio 进行真实 JSON-RPC 通信重新执行（没有协议 mock）。以下结果为这些真实运行的结果；原始日志属于内部验证记录，**不**属于本仓库。

| 命令 | 结果 |
|---|---|
| `npm test`（`node --test "test/**/*.test.mjs"`） | **退出码 0 — 179 个测试 / 40 个套件，179 通过、0 失败、0 跳过**（Node.js v24.11.1；记录为验收检查 `C11_automated_test_suite`）。显式 glob 使测试发现过程确定：只运行 `*.test.mjs` 文件。组成：**155 个保留的回归测试**（锁原语测试 1:1 适配，未弱化断言）**+ 13 个多进程锁安全测试 + 5 个扫描器测试 + 6 个恢复标记竞态测试** = 179 个真实测试。（更早的裸 `node --test` 发现还会把 9 个辅助模块计为文件级条目；显式 glob 不再计入。） |
| 锁安全套件（位于 `npm test` 内：`test/concurrency/lock-safety.test.mjs`） | **13/13 PASS** — 超过旧过期阈值的存活属主不被抢占（竞争者得到 `CANVAS_STORE_BUSY`）；所有权校验的释放不会删除他人的锁；A/B/C 临界区严格不重叠（15 个临界区，0 重叠）；过期句柄写入被 `CANVAS_LOCK_OWNERSHIP_LOST` 拒绝且状态字节不变；SIGKILL 属主的恢复需等待死亡被证明 + 年龄门限并安全完成；4 个真实 MCP 服务器进程在 CAS 重试下保持修订号/回执精确；相同 `operationId` 从两个真实进程只应用一次、重放一次；不同画布并行不会产生不必要阻塞；**25 轮随机 3–5 进程竞争共执行 94 个操作，0 个临界区重叠**（最终修订号 94、节点 97、回执 94）；同一死属主锁的多恢复者竞争恰好一个胜者；损坏/外部主机/畸形栅栏/遗留锁以 `CANVAS_LOCK_UNVERIFIABLE` 失败即关闭且绝不被接管。 |
| 恢复标记竞态套件（位于 `npm test` 内：`test/concurrency/recovery-marker-race.test.mjs`） | **6/6 PASS** — 针对更早实现的确定性修复前复现**复现了**该竞态（存活恢复标记被移动/删除；出现两个恢复所有者），而在本实现上该竞态**不可复现**。覆盖：存活守卫/标记永不被抢占；同一死标记的两个恢复者不能同时通过守卫（一个获胜，另一个得到 `CANVAS_STORE_BUSY`）；死标记仅在持有守卫且通过同一死属主复核后才被回收；恢复守卫持有者崩溃会以 `CANVAS_LOCK_UNVERIFIABLE` 失败即关闭且标记/状态完好；恢复标记持有者崩溃会通过守卫自动恢复；过期句柄写入被 `CANVAS_LOCK_OWNERSHIP_LOST` 拒绝且状态不变。 |
| `npm run test:acceptance`（`node scripts/verify/run-acceptance.mjs`） | **退出码 0 — overall `PASS`，11/11 检查 PASS**（`C01_standalone_start`、`C02_mcp_handshake`、`C03_read_canvas`、`C04_create_node`、`C05_patch_node`、`C06_connect_nodes`、`C07_concurrency_conflict`、`C08_unauthorized_rejected`、`C09_operation_receipt`、`C10_isolation_security`、`C11_automated_test_suite` 179/179），环境为 Node.js v24.11.1 / npm 11.6.2 / darwin arm64。 |
| `npm run audit:secrets`（密钥/PII/私有引用扫描） | **退出码 0 — RESULT CLEAN**：扫描 63 个文本文件，10 条发现全部为已允许的虚构演示/固定数据引用，0 失败；严格内部模式加载了 10 条仅本地规则（公开扫描器为通用版本，不需要该本地文件）。 |
| `npm run seed:demo && npm run demo && npm run demo:conflict` | 每条命令均以 `0` 退出；演示覆盖读取/创建/修改/连接/回执/重放，以及双进程 CAS 冲突 + 重试（独立验证者在 C01–C09 中覆盖同样的行为）。 |

验收矩阵是黑盒的：它从 `src/` + `package.json` 的隔离临时副本启动服务器（不含 `node_modules`），同时使用原始 JSON-RPC 和官方 `@modelcontextprotocol/sdk@1.30.0` 客户端，检查独立启动、握手、读取、写入、并发冲突、授权拒绝、回执、隔离/安全以及完整测试套件。这些检查做什么、不做什么，见 [`ARCHITECTURE.md`](ARCHITECTURE.md#verification-evidence)。

## 已知限制

这是一个早期的、单用户本地服务器，不是生产级多租户服务。已知限制：

- **本地单用户存储。** 一台机器上的一个存储目录；不提供共享、复制、备份或迁移工具。
- **仅静态令牌。** 令牌配置在 JSON 文件中，没有轮换、过期、撤销 API 或按会话的身份。更改令牌意味着编辑认证文件并重启服务器。
- **没有 TLS。** 认证是通过本地 stdio 管道传输的 bearer 令牌；没有网络监听器，也没有传输加密。如果你包装服务器或将其暴露到远程，传输安全由你负责。
- **没有多租户认证服务器 / 身份提供方。** Principal 由操作者配置；没有 OAuth、目录集成或委托身份。
- **没有删除工具。** v1 只支持创建/修改/连接；没有节点/边删除、分组或移动/复制工具。
- **同步 I/O。** 存储读写和锁等待是同步的（为简单的单写入者临界区而刻意设计）；大画布会延迟该进程中的后续消息。
- **每个进程一次处理一条消息。** 服务器按到达顺序处理 stdin 的 JSON-RPC 消息；不会在进程内并行执行工具调用。多进程并发通过存储支持，而不是通过进程内并行。
- **单主机锁安全。** 崩溃恢复依赖同主机进程存活检查（`process.kill(pid, 0)`）。跨主机共享的存储（网络文件系统、NFS/SMB、主机名不同的容器）**不受支持**：外部主机的所有者记录会以 `CANVAS_LOCK_UNVERIFIABLE` 失败即关闭，绝不会被接管。系统也没有分布式共识或跨机器协调。
- **PID 复用按失败即关闭处理，而不是自动消解。** 如果已崩溃属主的 PID 立即被另一个存活进程复用，锁会被视为由存活属主持有（等待 → `CANVAS_STORE_BUSY`），而不是被抢占；系统没有 PID 启动时间校验。只有当存活检查确定返回 `ESRCH` 且年龄门限已过时才会恢复。
- **恢复守卫崩溃需要人工清理。** 崩溃的恢复守卫持有者刻意不会被自动回收（自动回收会重新打开恢复竞态）。该画布的死标记恢复随后会以 `CANVAS_LOCK_UNVERIFIABLE` 失败即关闭，直到受信任的操作者在所有画布进程停止后，用 `inspectCanvasLock` 核实状态并删除悬空守卫文件。健康画布上的正常写入不受影响，因为它们永远不会接触守卫。这是失败即关闭的可用性取舍，而不是静默修复。
- **尚无外部安全审计。** 没有 fuzzing 或渗透测试证据；[`SECURITY.md`](SECURITY.md) 中的安全声明是设计/验证声明，不是审计认证。
- v0.1.0 源码发行包可在 GitHub Releases 获取；项目尚未发布到 npm。

## 安全

威胁模型、信任边界、令牌处理、启动失败即关闭、路径包含、审计日志字段和已知风险见 [`SECURITY.md`](SECURITY.md)。简而言之：服务器是一个本地 stdio 进程，只暴露九个画布工具；没有 shell/文件/网络工具；没有匹配令牌时拒绝启动；并确保原始令牌不落入磁盘、回执或日志。

如要报告安全问题，请按照 [`SECURITY.md`](SECURITY.md#reporting) 中的说明私下联系维护者。

## 许可证

**MIT 许可证。完整文本见 [`LICENSE`](LICENSE)。源码已在 GitHub 公开，尚未发布到 npm。**

- Copyright (c) 2026 chen gs；本仓库包含 MIT `LICENSE` 文件。该 LICENSE 仅适用于本项目代码，不适用于第三方依赖。
- 第三方依赖审计发现**零运行时依赖**，只有全为宽松许可的、仅开发期使用的依赖树（`@modelcontextprotocol/sdk@1.30.0`，MIT）— 与 MIT 发布没有第三方许可冲突。
- 所有者已批准本候选项目的 MIT 许可证；来源审计未在包中发现上游复制源码，唯一的开发依赖为 MIT（`@modelcontextprotocol/sdk@1.30.0`）。
- `package.json` 声明 `"license": "MIT"`，仓库包含 `LICENSE` 文件。
- v0.1.0 源码发行包可在 GitHub Releases 获取；项目尚未发布到 npm。
- 本次公开发布**只**包含本仓库中的文件；内部审计、来源与验证记录永远不会发布。

架构说明见 [`ARCHITECTURE.md`](ARCHITECTURE.md)，安全模型见 [`SECURITY.md`](SECURITY.md)，工具与恢复参考见 [`docs/TOOLS.md`](docs/TOOLS.md) / [`docs/RECOVERY.md`](docs/RECOVERY.md)。
