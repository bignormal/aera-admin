# P3 Admin ↔ Runtime 隔离验收证据

日期：2026-08-03（Asia/Shanghai）

结论：**PASS（仅限本地隔离集成）**。本文件不代表候选镜像、部署或真实环境验收；P4 综合旅程尚未开始。

## 1. 基线与安全边界

| 仓库    | 隔离工作树                                                           | 分支                              | HEAD / 最新 `origin/main`                  |
| ------- | -------------------------------------------------------------------- | --------------------------------- | ------------------------------------------ |
| Admin   | `/Users/zizimutou/Desktop/aera/.worktrees/admin-integration-stages`  | `codex/admin-integration-stages`  | `3e6163e9fd909e502facdd5d7cc3e6846530eb97` |
| Runtime | `/Users/zizimutou/Desktop/aera/.worktrees/admin-integration-runtime` | `codex/admin-integration-runtime` | `d8536e72a919eaa31245ea40dbc1faecf9e82d3d` |

- Payload `127.0.0.1:3233`、Soybean `127.0.0.1:9529`、Runtime gateway 和 SQLite 均为本阶段隔离实例。
- 临时数据根目录为 `/private/tmp/aera-admin-p3.RCU0N6`，未连接 PostgreSQL/Redis/Cloud/API 或生产数据。
- 日常 Payload `3100` 始终由原 PID `60278` 监听，未停止、未复用。
- 未使用日常账号或生产凭据；未推送、开 PR、合并或部署。

## 2. Runtime 注册、身份与失败关闭

| 检查       | 实际证据                                                                          | 结果 |
| ---------- | --------------------------------------------------------------------------------- | ---- |
| 显式注册   | 浏览器生成一次性注册码，Runtime CLI 真实兑换并获得 instance `1`                   | PASS |
| 一次性语义 | 同一注册码重放由 Payload 返回 HTTP 401                                            | PASS |
| 设备认证   | 错误 bearer 心跳返回 HTTP 401；当前设备持续心跳返回 200                           | PASS |
| 本地身份   | `platform-control.json` 权限为 `0600`，仅有 `deviceSecret` 与 `instanceId` 两个键 | PASS |
| 服务端存储 | Payload 仅保存 64 字符 secret hash；不保存原始 device secret                      | PASS |
| 401 后关闭 | Runtime 单测证明身份被拒绝后删除本地身份且不继续请求                              | PASS |
| 默认关闭   | 未显式 enrollment/config enable 时不启动请求                                      | PASS |

Runtime 只主动向 loopback Admin 发出 outbound 请求；Admin 没有反向读取 Runtime 工作区、会话或私有配置。

## 3. 心跳、资源摘要与 `health_check` 闭环

最终真实命令为 command `4`：

| 层              | 后置事实                                                                                        | 结果 |
| --------------- | ----------------------------------------------------------------------------------------------- | ---- |
| 浏览器请求      | `POST /api/platform/v1/runtime/commands` -> HTTP 200                                            | PASS |
| 浏览器响应      | 仅返回 `id=4 / instanceId=1 / state=queued / type=health_check`                                 | PASS |
| Payload command | `succeeded / HEALTHY`，claimed `21:19:30.048`、started `21:19:30.084`、completed `21:19:30.090` | PASS |
| Runtime 日志    | `agent.log:87` 记录 `Platform control command 4 completed with HEALTHY`                         | PASS |
| 实例状态        | `online / 0.18.2 / darwin / arm64`，持续更新 heartbeat                                          | PASS |
| 资源摘要        | `tasks=1 / devices=1`，其余资源为 0；无 prompt、conversation、workspace path 或 secret          | PASS |

浏览器页面实际显示：

- 指令记录：command `4` 对应 `health_check / succeeded / HEALTHY`。
- 运行资源任务：`1:t_4365639a / P3 隔离 Runtime / ready / kanban`。
- 运行资源设备：`1:runtime-15a84649d7705036 / runtime / online`。
- 运行实例页明确提示升级、重启和回滚当前不可执行，且不提供这些按钮。

## 4. 审计后置状态

Payload `audit_logs` 与审计中心 UI 同时显示：

| action                      | actor / capability                     | resource                | requestId                              | outcome     |
| --------------------------- | -------------------------------------- | ----------------------- | -------------------------------------- | ----------- |
| `runtime.command.create`    | `super_admin / runtime:command:create` | `runtime-commands / 4`  | `973d91d9-6391-4dff-9d9a-d9c5c3e5e149` | `succeeded` |
| `runtime.enrollment.create` | `super_admin / runtime:command:create` | `runtime-instances / 2` | `a0207288-79cd-4fd8-9796-57d4d2c8ba6a` | `succeeded` |

- enrollment audit 的 `after` 仅含 expiresAt、instanceId、instanceType、name、tenantId，不含一次性注册码。
- command audit 的 `after` 仅含 idempotencyKey、instanceId、state、type。
- 一次性审计注册记录在 RuntimeInstances 中为 `pending`，注册码只以 64 字符 hash 保存。

## 5. 明确拒绝未实现命令

浏览器登录态下直接向真实端点分别请求：

| 类型               | HTTP / code          | 数据库后置状态 |
| ------------------ | -------------------- | -------------- |
| `runtime_upgrade`  | `400 / INVALID_BODY` | 未创建命令     |
| `gateway_restart`  | `400 / INVALID_BODY` | 未创建命令     |
| `runtime_rollback` | `400 / INVALID_BODY` | 未创建命令     |

三次请求后 `runtime_commands` 仍为 4 条、最大 id 仍为 4。Runtime 客户端自身也只注册 `health_check`；单测对上述三种类型返回 `UNSUPPORTED_COMMAND/failed/rejected`，不存在假升级、假重启或假回滚实现。

## 6. P3 中发现并修复的问题

### Runtime 管理写操作缺少审计

根因：

- enrollment/command 两个管理端点在权限检查后直接调用 `overrideAccess` 服务写集合。
- RuntimeInstances/RuntimeCommands 没有通用 collection audit hook，端点也未调用现有 audit domain。

TDD 与最小修复：

- 新测试先因 enrollment audit 查询为 0 条而 RED。
- 端点在成功写入后追加 `runtime.enrollment.create` 与 `runtime.command.create`，使用既有脱敏审计域。
- 定向测试最终 5/5 PASS；真实浏览器和 SQLite 后置事实见第 4 节。

### 命令创建响应泄露 service-only 文档

真实发现：

- 首次用 Playwright `response-body` 检查 HTTP 200 时，响应包含 Payload `overrideAccess` 返回的完整命令关系。
- 其中展开了 `deviceSecretHash`、`enrollmentCodeHash`、内部 `commandKey` 和管理员 session 元数据；UI 虽未渲染，但浏览器网络层可见。

根因与修复：

- `queueRuntimeCommand` 返回完整 Payload document，custom endpoint 未做公开响应投影。
- 新测试先看到完整 16 字段/关系对象而 RED；端点改为只返回 `id/instanceId/state/type`。
- 隔离 Payload 重启后重新通过真实浏览器请求，HTTP 200 响应已收窄且不再含 hash/secret/session/createdBy/commandKey。

## 7. 浏览器与网络证据

证据目录：

`/Users/zizimutou/.codex/visualizations/2026/08/03/019fc61b-83bc-7661-b39c-14363bb23317/admin-integration-stages/p3`

脱敏 HTTP 记录：`HTTP_EVIDENCE.md`

关键截图（相对于 `browser/.playwright-cli`）：

- 实例健康与资源详情：`page-2026-08-03T13-03-27-692Z.png`
- 初次真实命令成功：`page-2026-08-03T13-04-04-685Z.png`
- 在线实例与审计 enrollment fixture：`page-2026-08-03T13-20-08-885Z.png`
- 审计中心两条 Runtime 记录：`page-2026-08-03T13-20-42-146Z.png`
- 最终 command `4` 成功：`page-2026-08-03T13-21-09-692Z.png`
- Kanban task：`page-2026-08-03T13-21-52-871Z.png`
- Runtime device：`page-2026-08-03T13-24-08-165Z.png`

Playwright CLI `requests` 还确认 Runtime 页面相关 `admins/me` 与 `runtime-instances` GET 均为 200。最后一次主动查询没有未解释的 console error；三个 400 console error 来自第 5 节的预期拒绝请求。

## 8. 完整本地门禁

### Runtime

| 命令                                                                  | 结果                      |
| --------------------------------------------------------------------- | ------------------------- |
| `scripts/run_tests.sh` 运行 9 个 platform/config/gateway 生命周期文件 | 9 files / 286 tests PASS  |
| Ruff（全部 P3 改动 Python 文件）                                      | PASS，0 warning / 0 error |
| `compileall`（全部 P3 改动 Python 文件）                              | PASS                      |
| `git diff --check`                                                    | PASS                      |

### Admin

| 命令                                                                   | 结果                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------- |
| `pnpm test:int`（一次性 secret + 独立 SQLite + 真实 Runtime contract） | 26 files PASS；133 PASS、2 conditional skip         |
| `pnpm test:admin`                                                      | 28 files / 105 tests PASS                           |
| `pnpm test:e2e:admin`                                                  | Chrome 16/16 PASS，独立 3101/9527 与进程专属 SQLite |
| 根 `tsc --noEmit` + Admin Web `vue-tsc`                                | PASS                                                |
| 根 ESLint + Admin Web oxlint                                           | PASS，0 warning / 0 error                           |
| Next production build（独立 distDir）+ Soybean production build        | PASS                                                |
| `git diff --check`                                                     | PASS                                                |

两个 conditional skip 均保持显式：缺席的 Studio 实际契约与其独立探针没有被 Runtime 结果冒充；Aera API route-file contract 因隔离工作树不是测试硬编码的 sibling 布局而 skip，P3 没有用本阶段绿色替代 P1 的实际 API 证据。

默认 `pnpm test:e2e` 硬编码 3100，按安全边界没有执行；它不能以复用或停止日常 3100 为代价充当本阶段证据。

## 9. 交付边界与 teardown

- P3 本地隔离集成：PASS。
- 候选镜像：未构建为发布候选；production build 不能替代候选镜像证明。
- 部署 / 真实环境：未执行。
- P4 综合旅程：尚未开始，本文件不宣称整体打通。
- teardown：已完成。
  - `aera-admin-p3-evidence` 浏览器已关闭；Runtime gateway、Payload `3233`、Soybean `9529` 均通过各自会话的 Ctrl-C 停止，Runtime 记录 planned clean shutdown。
  - `3233/9529` 已释放，日常 `3100` 仍由 PID `60278` 监听。
  - `/private/tmp/aera-admin-p3.RCU0N6`、所有 P3 测试 SQLite、Runtime identity、构建缓存和 `.p3-contract-inspect` 已移入 `/Users/zizimutou/.Trash/aera-admin-p3-cleanup.Ss86p6`，可恢复。
  - 原始 Playwright trace 含设备认证流量，两个 snapshot 含一次性注册码；它们已一并移入废纸篓，未作为可分享证据保留。脱敏 `HTTP_EVIDENCE.md` 与无敏感内容截图保留。
- P4 综合旅程：下一阶段 TODO，P3 的本地隔离 PASS 不等于整体打通。
