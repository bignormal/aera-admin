# Aera Admin P0-P4 真实运行与集成验收证据

日期：2026-08-03（Asia/Shanghai）

## 结论

- **P0 权限发布阻断：PASS。** 三个内容集合已改为 capability read；五角色与匿名请求的测试、真实 UI 和直接 REST 状态一致。
- **P1 Admin ↔ Aera API：PASS（本地隔离集成）。** 平台用户列表、分页、搜索、详情、一次性创建和审计后置状态形成真实闭环。
- **P2 Admin ↔ Aera Cloud：PASS（本地隔离集成）。** mTLS、Ed25519 服务身份、职责映射、用户/设备/会话读取、受控会话撤销、operation 和双层审计形成真实闭环。
- **P3 Admin ↔ Runtime：PASS（本地隔离集成）。** 注册、设备认证、心跳、资源摘要和 `health_check` 命令形成真实闭环；升级、重启、回滚继续明确拒绝。
- **P4 跨页面浏览器旅程：PASS。** 从登录开始完成内容权限、Aera API、Cloud、Runtime 和审计中心旅程。
- **完整候选门禁：FAIL。** Runtime 可选全仓基线门禁在 31.5% 时出现与干净 `origin/main` 相同的 8 failures + 1 collection error。因此本文件**不宣称候选镜像、部署或真实环境整体打通**。

## 1. 基线与隔离边界

| 仓库 | 专用工作树 | 分支 | 验收 HEAD / 当次最新 `origin/main` |
| --- | --- | --- | --- |
| Admin | `/Users/zizimutou/Desktop/aera/.worktrees/admin-integration-stages` | `codex/admin-integration-stages` | `3e6163e9fd909e502facdd5d7cc3e6846530eb97` |
| API | `/Users/zizimutou/Desktop/aera/.worktrees/admin-integration-api` | `codex/admin-integration-api` | `6542be18fa00a06b8a776daefcbd41cf950739c2` |
| Cloud | `/Users/zizimutou/Desktop/aera/.worktrees/admin-integration-cloud` | `codex/admin-integration-cloud` | `1d2fbc99662bdfc10d4ff3669c7eb47d63dc2034` |
| Runtime | `/Users/zizimutou/Desktop/aera/.worktrees/admin-integration-runtime` | `codex/admin-integration-runtime` | `d8536e72a919eaa31245ea40dbc1faecf9e82d3d` |

- 四仓在门禁前均重新 fetch；验收 HEAD、`origin/main` 与 merge-base 一致。
- 没有修改落后的主检出；没有复用旧 `3100` 服务。
- P4 服务仅监听 loopback：API `18091`，Cloud public/internal `18092/18452`，Payload `3234`，Soybean `9530`。
- P4 数据服务为一次性容器：API PostgreSQL/Redis `55441/56391`；Cloud PostgreSQL/Redis/MinIO `55442/56392/59021-59022`。
- Payload/Runtime 数据根为 `/private/tmp/aera-admin-p4.r5DK0L`；Runtime 使用该目录下独立 `HERMES_HOME`。
- 日常 Payload `3100` 在整个旅程中始终为原 PID `60278`。
- 仅使用一次性本地账号、开发 PKI、测试数据与本地密钥；没有生产写操作，也没有 push、PR、merge 或 deploy。

## 2. P0 内容 read 权限

### 实现与 TDD

| 集合 | 修复前 | 修复后 |
| --- | --- | --- |
| AgentTemplates | `isAuthenticated` | `capabilityAccess('content:agents:read')` |
| ExpertCategories | `isAuthenticated` | `capabilityAccess('content:categories:read')` |
| Media | `isAuthenticated` | `capabilityAccess('content:media:read')` |

新增 `tests/int/content-read-access.int.spec.ts` 先在原实现上暴露“任意已登录角色可读”的失败，再改 capability。测试覆盖三个集合、五角色、匿名请求，并以 `draft: true` 实际查询草稿 AgentTemplates，而不是只检查函数文本。

### 五角色与匿名真实矩阵

代码中的财务角色规范名为 `finance_admin`（需求中的 finance）。

| 身份 | AgentTemplates `draft=true` | ExpertCategories | Media | UI |
| --- | --- | --- | --- | --- |
| `super_admin` | 200 | 200 | 200 | 草稿与操作入口可见 |
| `publisher` | 200 | 200 | 200 | 草稿与发布入口可见 |
| `operations_admin` | 403 | 403 | 403 | 403 |
| `finance_admin` | 403 | 403 | 403 | 403 |
| `auditor` | 403 | 403 | 403 | 403 |
| 匿名 | 403 | 403 | 403 | 未授权 |

Payload 实际访问日志证据：允许组 `payload.log:29-31`、`41-43` 均为 200；拒绝组 `62-65`、`77-81`、`97-100`、`105-108` 均为 403。UI 允许页与 403 页分别见：

- `page-2026-08-03T14-10-19-639Z.png`：super_admin 的草稿智能体。
- `page-2026-08-03T14-12-00-855Z.png`：publisher 的同一草稿。
- `page-2026-08-03T14-13-18-238Z.png`：无 capability 角色的 403 页面。

## 3. P1 Admin ↔ Aera API

### 服务与读取旅程

- `GET http://127.0.0.1:18091/health` 真实返回 HTTP 200；错误探针 `/api/v1/health` 返回 404，正式探针路径为 `/health`。
- Admin 使用隔离的 `AGENTERA_API_URL/AGENTERA_API_ADMIN_KEY`，浏览器平台总览的真实资源就绪度为健康。
- BFF / Payload 日志：
  - 列表 page 1、page 2：`payload.log:113-115`，全部 200。
  - 搜索 `p4-seed-07`：`payload.log:116`，200。
  - 用户详情及 usage、API keys、balance、RPM、quota、attributes、subscription：上游 API 日志 `sub2api.log:95-102`，全部 200。
- 页面证据：
  - `page-2026-08-03T14-16-31-231Z.png`：第 2 页。
  - `page-2026-08-03T14-17-10-093Z.png`：搜索结果。
  - `page-2026-08-03T14-17-38-477Z.png`：用户详情与 usage。

### 一次性安全写与后置状态

| 层 | 事实 |
| --- | --- |
| 浏览器 / BFF | `POST /api/platform/v1/createUser` -> 200，requestId `13b637ce-034d-4826-94c3-b19bdf44ab9b` |
| 上游 API | `POST /api/v1/admin/users` -> 200，`sub2api.log:103`，同一 requestId |
| PostgreSQL | `users.id=14`，`p4-browser-write@aera.local`，role `user`，status `active`，`deleted_at IS NULL` |
| Payload 审计 | `platform.createUser / succeeded / users:write`，requestId 与 upstreamRequestId 均为 `13b...` |
| UI 后置状态 | `page-2026-08-03T14-19-50-983Z.png` 显示 id 14、启用状态与精确搜索结果 |

### 契约根因与最小修复

真实详情页发现 Admin 通用脱敏正则把 `prompt_tokens/completion_tokens/total_tokens` 误判为凭据 token，导致合法 usage 指标消失。根因只在 Admin；API 返回契约正确。新增失败测试后，以 `token(?!s(?:$|[_-]))` 保留指标复数 `tokens`，同时继续脱敏 `access_token/refreshToken`。API 仓无代码修改。

## 4. P2 Admin ↔ Aera Cloud

### mTLS、Ed25519 与失败关闭

| 检查 | 当前 P4 实测 |
| --- | --- |
| public health | `/health/live` 与 `/health/ready` 均为 200 |
| 开发证书 | `openssl verify`：Cloud/client 均 OK |
| 有效 mTLS | TLS 1.3，`TLS_AES_128_GCM_SHA256`，服务端证书验证 OK |
| 无 client cert | TLS alert `certificate required`，命令 exit 1 |
| Ed25519 | `service-public.pem` 被 OpenSSL 识别为 `ED25519 Public-Key` |
| 仅 mTLS、无服务 JWT | Internal Admin users 返回 401 |
| 有效 BFF 身份 | 浏览器只读接口 200；职责不符写请求 403；职责相符写请求 200 |

### 角色、读取与受控写

- 浏览器完成 Cloud 用户列表、详情、设备、会话与 memberships 读取；`payload.log:130,132-135` 均为 200。
- auditor 可读但 UI 不显示写入口；其直接 `revokeCloudSession` 为 403（`payload.log:190`），requestId `090bebb9-94b1-4320-90dc-ef3270931ac6`。
- super_admin 以一次性原因/工单执行同一 session 撤销，BFF 为 200（`payload.log:201`），requestId `218b34c1-7c95-4041-993f-d52208e4df58`。
- operation 独立查询为 200（`payload.log:209`），requestId `fe12c689-2c74-413e-a53b-fcc39b5450b0`。

Cloud PostgreSQL 最终事实：

| 对象 | 最终事实 |
| --- | --- |
| operation | `c44f638a-c680-47f1-9454-5a741791adde / revoke_session / succeeded / result_revision=2` |
| session | `40000000-0000-4000-8000-000000000405 / admin_revoked`，`revoked_at` 已写入 |
| Cloud audit | `session_admin_revoked / success`，requestId、operationId 与上表一致 |
| Payload audit | `cloud.revokeCloudSession / succeeded / cloud:sessions:write`，资源为同一 session |
| offline entitlement | 同 user/device 的 entitlement `...407` 仍为 `active` |

最后一项是正式的职责/级联边界：**撤销单个在线 session 不等于撤销设备、账号或离线 entitlement**。本旅程没有把未发生的级联写入冒充为成功。

页面证据：

- `page-2026-08-03T14-20-55-031Z.png`：Cloud 用户列表。
- `page-2026-08-03T14-24-43-500Z.png`：super_admin 写入口。
- `page-2026-08-03T14-32-11-239Z.png`：auditor 只读且操作列为 `-`。
- `page-2026-08-03T14-40-07-827Z.png`：一次性原因、工单和备注确认。
- `page-2026-08-03T14-41-27-710Z.png`：session revoked、operation succeeded、revision 2。

## 5. P3 Admin ↔ Runtime

### 注册、认证、心跳和命令

| 层 | 事实 |
| --- | --- |
| enrollment | 浏览器创建一次性注册码，requestId `e83a4de9-60ed-42c9-a852-004847e7a231`，Payload `runtime.enrollment.create` 审计成功 |
| 一次性语义 | 首次 `/api/control/v1/enroll` 为 200，重放为 401（`payload.log:213-214`） |
| 存储边界 | Runtime instance `device_secret_hash` 长度 64；服务端未保存原始 secret |
| heartbeat | 隔离 Runtime 持续得到 200；实例为 `online / 0.18.2 / darwin / arm64` |
| command | 浏览器 `POST /api/platform/v1/runtime/commands` -> 200，requestId `91c6ceb4-bcf5-4d53-a964-3a6ef58fe530` |
| Payload | command `1 / health_check / succeeded / HEALTHY`，claimed/started/completed 均已写入 |
| Runtime | `agent.log:297`：`Platform control command 1 completed with HEALTHY` |
| audit | `runtime.command.create / succeeded / runtime:command:create`，资源 `runtime-commands/1` |

资源摘要为 `devices=1`、tasks/workflows/cron/codingAgents 均为 0；只包含有界运行摘要，不含 prompt、对话内容、工作区路径或设备密钥。

Runtime command 创建响应已收窄为 `id/instanceId/state/type`；浏览器网络层不再收到 `deviceSecretHash/enrollmentCodeHash/commandKey/admin session` 等 service-only 字段。

### 未实现命令继续拒绝

`runtime_upgrade`、`gateway_restart`、`runtime_rollback` 三次真实请求均为 `400 / INVALID_BODY`（`payload.log:690-692`），数据库仍只有一条 `health_check`。Runtime 客户端也只注册 `health_check`，没有假升级、假重启或假回滚。

页面证据：

- `page-2026-08-03T14-54-15-447Z.png`：在线 Runtime 与“只开放健康检查”提示。
- `page-2026-08-03T14-55-05-246Z.png`：实例详情、版本/系统/架构与有界资源摘要。
- `page-2026-08-03T14-56-59-497Z.png`：`health_check / succeeded / HEALTHY`。
- `page-2026-08-03T14-59-44-449Z.png`：Runtime device 资源与在线状态。
- `page-2026-08-03T15-01-15-263Z.png`：四条 P1/P2/P3 业务审计同屏后置状态。

### 本阶段最小修复

- Runtime：新增 opt-in platform control 配置/CLI 与 gateway 生命周期接入，使用隔离 `HERMES_HOME` 完成真实 outbound 注册、认证、心跳和命令执行。
- Admin：为 enrollment/command 管理写入追加脱敏审计；把 command 响应投影为有界公开 envelope。
- TDD：审计缺失与 service-only 字段泄露测试先 RED，修复后纳入完整 Admin integration gate。

## 6. P4 跨页面真实浏览器旅程

真实 Chrome 旅程从登录页开始，依次经过总览、P0 内容权限、P1 平台用户分页/搜索/详情/创建、P2 Cloud 只读/拒绝/受控写、P3 Runtime 注册/命令/资源，最后进入审计中心核对四条业务写入。

保留的 25 张脱敏 PNG 位于：

`/Users/zizimutou/.codex/visualizations/2026/08/03/019fc61b-83bc-7661-b39c-14363bb23317/admin-integration-stages/p4/browser/screenshots`

代表性起止证据：

- `page-2026-08-03T14-14-41-804Z.png`：隔离管理员登录页。
- `page-2026-08-03T14-08-44-563Z.png`：总览真实资源健康。
- `page-2026-08-03T15-01-15-263Z.png`：最终审计中心。

原始 trace/network/YAML/console/API 材料可能包含认证流量，已移入 macOS 废纸篓 `/Users/zizimutou/.Trash/aera-admin-p4-browser-raw-20260803-2315`，不作为可分享产物；上述截图与本文件只保留脱敏证据。

## 7. Fresh 本地门禁

### Admin

| 门禁 | 结果 |
| --- | --- |
| `pnpm test:int` | 25 files PASS、1 conditional file skip；132 PASS、3 conditional skip |
| Admin Web tests | 28 files / 105 tests PASS |
| 根 TypeScript + Web `vue-tsc` | PASS |
| 根 ESLint + Web ESLint/oxlint | PASS |
| Cloud contract mirror/drift | PASS，hash `c64a6a9623d07b130a26d03cadb20b7d1424c9c3c5eb517a903fdec415d20fff` |
| `pnpm run build:platform` | Next + Soybean production build PASS |
| `pnpm test:e2e:admin` | Chrome 16/16 PASS；独立 `3101/9527`，结束后端口释放 |
| `git diff --check` | PASS |

默认 `pnpm test:e2e` 硬编码日常 `3100`，按安全边界未运行；不能以停止或复用日常进程为代价制造绿色。

### Cloud

| 门禁 | 结果 |
| --- | --- |
| `go test -count=1 ./...` | PASS |
| `go test -race ./...` | PASS |
| `go vet ./...` | PASS |
| fresh PostgreSQL/Redis/MinIO integration | PASS |
| tagged e2e | PASS |

fresh integration 从空卷启动。首轮 MinIO 失败的根因是门禁把 endpoint 错配为带 `http://` 的 URL；Cloud 契约要求 `host:port`。修正门禁参数并从空卷重建后全量通过，Cloud 仓无需代码修改。

### Runtime

| 门禁 | 结果 |
| --- | --- |
| 9 个 platform/config/gateway 生命周期文件 | 286/286 PASS |
| Ruff | PASS |
| compileall | PASS |
| `git diff --check` | PASS |
| 可选全仓门禁 | **FAIL：8 failures + 1 collection error，与 detached `origin/main` 相同** |

## 8. 未通过项、根因与最小建议

### Runtime 全仓基线门禁（发布阻断）

全仓发现 2055 files / 39376 tests；运行到 31.5% 时因 8 failures + 1 collection error 中止。随后在 detached、干净的 `origin/main@d8536e72` 复跑相同失败，确认不是本分支回归，但它仍阻止“完整候选门禁通过”的结论。

| 基线失败 | 已确认根因 | 最小建议 |
| --- | --- | --- |
| `test_bounded_response.py` | macOS 系统代理把 loopback 请求送到 `127.0.0.1:7897` | test wrapper 固定 `NO_PROXY=127.0.0.1,localhost`；该文件加 NO_PROXY 后 6/6 PASS |
| `test_anthropic_adapter.py` | 全局 `subprocess.run` mock 同时截获 macOS Keychain 调用 | 只 patch adapter 子进程边界，或先 stub credential provider |
| `test_model_metadata_ssl.py` | 把 `tests/` 插入 `sys.path` 首位，遮蔽真实 `agent` package | 用包级 import/fixture，不要污染 sys.path 首位 |
| `test_background_command.py` | macOS `/tmp` 与 `/private/tmp` realpath 不同 | 路径断言前统一 `resolve()/realpath` |

这些无关基线修复没有被塞入当前 Runtime 功能分支。

### 真实旅程中的非阻断噪声

- 五角色快速登录/退出时，页面离开取消了尚在执行的 API 仪表盘 fan-out；Aera API 把 `context canceled`/`pq: canceling statement due to user request` 记为 HTTP 500。最终稳定旅程在 `22:30:03` 同批 overview/error/throughput/latency 端点均为 200。建议 API 将客户端取消映射为 499 或低噪声日志，避免误报业务 500。
- API 的周期性公共价格 hash 拉取在验收结束后出现 GitHub timeout；不涉及生产数据或写入，也未影响 Admin 主链路。若要形成完全可复现的候选门禁，建议在 hermetic profile 中关闭该外部 scheduler 或注入本地价格源。
- 手工探索曾请求错误的 `/api/v1/health` 并得到 404；真实且正式的 API health 路径为 `/health`。建议把正式路径固化进统一探针，避免运维误判。

## 9. 交付边界

| 层级 | 状态 | 能证明什么 |
| --- | --- | --- |
| 本地代码门禁 | Admin/Cloud/Runtime 定向通过；Runtime 全仓基线失败 | 证明当前改动的定向正确性，不等于候选通过 |
| 本地隔离集成 | P0-P3 PASS | 证明本机隔离服务、浏览器、网络、数据库、日志与审计闭环 |
| 浏览器综合旅程 | PASS | 证明真实 Chrome 管理端跨页面可运行，不等于 Electron 包或候选镜像 |
| 候选镜像 | NOT RUN / BLOCKED | 未构建不可变候选；Runtime 全仓基线仍红 |
| 部署 | NOT RUN | 没有部署动作 |
| 真实环境验收 | NOT RUN | 没有生产凭据、日常账号、真实服务或物理客户端证据 |

现有内测用户不属于本次一次性 fixture。若进入下一层，应先做**真实内测环境只读验收**：由用户确认环境并提供只读凭据或临时验收账号，只验证状态探针、用户列表/搜索/详情和 Cloud 设备/会话读取；不得把本阶段创建用户、撤销 session 或 Runtime 下发命令直接改到真实用户库。任何真实环境写入继续单独等待授权。

## 10. Teardown

- Playwright trace 已停止，浏览器会话已关闭；25 张脱敏 PNG 保留，原始敏感材料在 `/Users/zizimutou/.Trash/aera-admin-p4-browser-raw-20260803-2315`。
- Runtime gateway 在旅程结束时记录 `gateway_state=stopped`；API、Cloud、Payload、Soybean 均通过各自原启动会话 Ctrl-C 正常退出。
- `18091/18092/18452/3234/9530` 均已释放；最终 listener 复核只剩日常 `3100/PID 60278`。
- 五个 `aera-admin-p4-r5dk0l-*` 容器及其五个专属 PostgreSQL/Redis/MinIO volumes 已删除；一次性容器数据不可恢复。
- `/private/tmp/aera-admin-p4.r5DK0L`、开发 PKI 和 `.next-p4-gate` 已分别移入：
  - `/Users/zizimutou/.Trash/aera-admin-p4.r5DK0L-20260803`
  - `/Users/zizimutou/.Trash/aera-admin-p4-dev-pki-20260803`
  - `/Users/zizimutou/.Trash/aera-admin-p4-next-gate-20260803`
  这些文件仍可从废纸篓恢复。
- detached Runtime 基线工作树 `/private/tmp/aera-runtime-baseline-p4-20260803` 已通过 `git worktree remove` 删除。
- teardown 后再次 fetch：四个功能工作树的 HEAD、`origin/main`、merge-base 仍分别完全一致。
- 原 Admin/API/Cloud/Runtime 主工作区均没有新增未提交文件；其原分支和既有进度保持不变。
- 未 commit、stage、push、开 PR、merge 或 deploy。
