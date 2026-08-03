# P2 Admin ↔ Aera Cloud 隔离验收证据

日期：2026-08-03（Asia/Shanghai）

结论：**PASS（仅限本地隔离集成）**。本文件不代表候选镜像、部署或真实环境验收；P3 Runtime 尚未开始。

## 1. 基线与安全边界

| 仓库  | 隔离工作树                                                          | 分支                             | HEAD / 最新 `origin/main`                  |
| ----- | ------------------------------------------------------------------- | -------------------------------- | ------------------------------------------ |
| Admin | `/Users/zizimutou/Desktop/aera/.worktrees/admin-integration-stages` | `codex/admin-integration-stages` | `3e6163e9fd909e502facdd5d7cc3e6846530eb97` |
| Cloud | `/Users/zizimutou/Desktop/aera/.worktrees/admin-integration-cloud`  | `codex/admin-integration-cloud`  | `1d2fbc99662bdfc10d4ff3669c7eb47d63dc2034` |
| API   | `/Users/zizimutou/Desktop/aera/.worktrees/admin-integration-api`    | `codex/admin-integration-api`    | `6542be18fa00a06b8a776daefcbd41cf950739c2` |

- 三个工作树均在验收结束前重新 `git fetch origin main`，HEAD、`origin/main` 与 merge-base 一致。
- P2 服务只监听 loopback：Cloud `18087/18444`、Payload `3232`、Soybean `9528`。
- Compose project：`aera-admin-p2-019fc61b`；隔离 PostgreSQL `55435`、Redis `56382`、MinIO `59011`。
- Destructive Cloud integration 另用一次性 PostgreSQL `55436` 和 Redis `56383`，没有复用 P2 验收数据库或 Redis。P2 Redis DB 9 在门禁前后均为 1 个键。
- 日常 Payload `3100` 始终由原 PID `60278` 监听，未停止、未复用。
- 未使用日常账号、生产数据或生产凭据；未推送、开 PR、合并或部署。

## 2. 传输、服务身份与失败关闭

| 检查          | 实际证据                                                                                        | 结果 |
| ------------- | ----------------------------------------------------------------------------------------------- | ---- |
| Public health | `GET http://127.0.0.1:18087/health/live` 与 `/health/ready` 均返回 `{"status":"ok"}`            | PASS |
| TLS 版本      | client-cert 握手为 `TLSv1.3 / TLS_AES_128_GCM_SHA256`，证书验证返回 0                           | PASS |
| mTLS          | 不带客户端证书访问 `18444` 被握手拒绝；带受信开发证书可完成 TLS 1.3 握手                        | PASS |
| 服务 JWT      | mTLS 成功但不带服务 JWT 请求 Internal Admin users 返回 HTTP 401                                 | PASS |
| Ed25519       | `deploy/dev-pki/service-public.pem` 由 OpenSSL 识别为 `ED25519 Public-Key`                      | PASS |
| 开发 PKI      | Cloud/client 证书均由 `agentera-admin dev CA` 签发并通过 `openssl verify`                       | PASS |
| 有效 BFF 身份 | 同一运行实例经 Admin BFF 访问 Cloud Internal Admin 接口得到职责相符的 200；职责不符请求得到 403 | PASS |

开发证书 SHA-256 指纹（公有证据）：

- Cloud：`5E:78:DE:6D:60:82:B3:93:22:93:3A:BF:7C:32:BC:50:42:25:C2:E3:B7:F6:01:11:4D:D8:66:C2:AD:38:80:66`
- Admin client：`69:8B:0B:05:AC:3C:BD:4D:0C:90:94:A1:BE:EC:5A:DB:33:57:14:56:33:93:F3:57:15:04:9B:FC:EC:51:1C:B7`

## 3. 五角色真实浏览器与 BFF 权限矩阵

浏览器 trace：

`/Users/zizimutou/.codex/visualizations/2026/08/03/019fc61b-83bc-7661-b39c-14363bb23317/admin-integration-stages/p2/browser/.playwright-cli/traces/trace-1785755420250.network`

| 本地角色           | UI / BFF 实际行为                                                                          | 结果 |
| ------------------ | ------------------------------------------------------------------------------------------ | ---- |
| `finance`          | Cloud 菜单/页签不暴露；直接 `listCloudUsers` 为 403                                        | PASS |
| `auditor`          | 用户、设备、会话只读链路为 200；UI 不显示写按钮；直接 `revokeCloudSession` 为 403          | PASS |
| `operations_admin` | Cloud 用户/设备/会话只读可用；发布中心修复后只请求 official versions/releases，均 200      | PASS |
| `publisher`        | official definitions/drafts/submissions/versions/releases 均 200；不再请求无权访问的 audit | PASS |
| `super_admin`      | official definitions/audit 均 200；一次性 Cloud 写流程获准                                 | PASS |

关键 trace 状态（UTC）：

- `11:24:27 listCloudUsers -> 403`
- `11:26:27 listCloudUsers -> 200`
- `11:27:36 revokeCloudSession -> 403`
- `11:45:06 listOfficialVersions/Releases -> 200/200`
- `11:46:40 definitions/drafts/submissions/versions/releases -> 200`
- `11:48:03 definitions/audit -> 200/200`
- `11:50:02 revokeCloudSession -> 200`，随后 operation GET -> 200
- `11:51:21 disableCloudUser -> 200`，随后 operation GET -> 200

浏览器证据目录：

`/Users/zizimutou/.codex/visualizations/2026/08/03/019fc61b-83bc-7661-b39c-14363bb23317/admin-integration-stages/p2/browser/.playwright-cli`

关键页面截图（文件名相对于上述目录）：

- 修复前 catalog 失败：`.../.playwright-cli/page-2026-08-03T11-39-17-572Z.png`
- 修复前 official panel forbidden：`.../.playwright-cli/page-2026-08-03T11-39-45-005Z.png`
- 修复后 operations_admin：`.../.playwright-cli/page-2026-08-03T11-45-11-559Z.png`
- 修复后 publisher：`.../.playwright-cli/page-2026-08-03T11-46-45-417Z.png`
- 会话撤销成功：`.../.playwright-cli/page-2026-08-03T11-50-08-813Z.png`
- 用户禁用成功：`.../.playwright-cli/page-2026-08-03T11-51-26-166Z.png`
- 最终 reload 后 Cloud 用户列表：`.../.playwright-cli/page-2026-08-03T12-20-03-171Z.png`

## 4. 一次性受控写与后置状态

| 操作     | BFF requestId                          | operationId                            | 独立 operation 查询 requestId          | 最终状态 / 修订 |
| -------- | -------------------------------------- | -------------------------------------- | -------------------------------------- | --------------- |
| 撤销会话 | `cb39148f-1025-411e-b3f4-932b4768ae84` | `a2876123-b6eb-4888-b5b4-508898a2726a` | `5e09efe7-7cc7-440a-89d6-34236c512134` | `succeeded` / 2 |
| 禁用用户 | `f23fec0a-ee9e-4f26-b9b9-8cd2287ed083` | `414e99fd-583c-4dc6-9fb1-fd705d7a4dc9` | `107f4ddd-1c9b-47e8-b5fd-6f9ad280109c` | `succeeded` / 3 |

Cloud PostgreSQL 最终事实（仅列 UUID 与状态，不含原始身份）：

- user：`disabled`，`administratively_disabled=true`，revision `3`
- session：`revoked=true`，reason `admin_revoked`
- device：`revoked`
- personal space：`disabled`
- offline entitlement：`revoked=true`
- 两条 `admin_operations` 均 `succeeded`、已完成，requestId/operationId/result revision 与上表一致
- 两条 `audit_events` 分别为 `session_admin_revoked/success` 与 `account_disabled/success`，requestId/operationId 一致

Payload SQLite `audit_logs`：

- `cloud.revokeCloudSession | succeeded | cloud:sessions:write | cb39148f... | a2876123...`
- `cloud.disableCloudUser | succeeded | cloud:users:write | f23fec0a... | 414e99fd...`

## 5. P2 中发现并修复的问题

### Admin 发布中心职责分区缺陷

根因：

- `operations_admin` 默认加载无权访问的本地内容目录。
- official Agent panel 用一个 `Promise.all` 请求所有职责域，合法的部分 403 会把整页变成 forbidden。
- Cloud 的 scope-to-duty 检查正确；问题在 Admin UI 没按当前 Cloud 角色分区加载。

最小修复：

- `admin-web/src/constants/capabilities.ts`
- `admin-web/src/constants/publishing-access.test.ts`
- `admin-web/src/views/publishing/index.vue`
- `admin-web/src/views/publishing/modules/official-agents-panel.vue`

定向测试先出现 2/2 RED，修复后 2/2 PASS；真实浏览器复验见第 3 节。

### 本地门禁卫生问题

- 根 ESLint 原先会扫描已由 `.gitignore` 排除的 `.tmp` Next 编译产物，真实验收后产生 85 个生成代码错误；最小修复为在 `eslint.config.mjs` 增加 `.tmp/**` ignore。
- Admin Web 基线存在静态标题的无意义 `v-bind`；改为静态 `title`，渲染语义不变，并通过 Web ESLint。
- Vite build 触发运行中 dev server 的一次路由 HMR 初始化错误；完整 reload 后页面恢复，Cloud 页签重新读取到禁用状态与 revision 3。未把热更新瞬态当成产品通过证据。

## 6. 完整本地门禁

### Cloud

| 命令                                                                                  | 结果 |
| ------------------------------------------------------------------------------------- | ---- |
| `go test ./...`                                                                       | PASS |
| `go test -race ./...`                                                                 | PASS |
| `go vet ./...`                                                                        | PASS |
| `AERA_INTEGRATION_TESTS=1 go test -count=1 -p 1 ./...`（额外一次性 PostgreSQL/Redis） | PASS |
| `AERA_INTEGRATION_TESTS=1 go test -count=1 -tags e2e ./cmd/aera-cloud-e2e`            | PASS |

### Admin

| 命令                                           | 结果                                                            |
| ---------------------------------------------- | --------------------------------------------------------------- |
| `pnpm test:int`（一次性 secret + 独立 SQLite） | 25 files PASS、1 conditional skip；130 PASS、2 conditional skip |
| `pnpm --dir admin-web test`                    | 28 files / 105 tests PASS                                       |
| `pnpm --dir admin-web typecheck`               | PASS                                                            |
| `pnpm lint`                                    | PASS                                                            |
| Admin Web `oxlint` + non-fixing `eslint`       | PASS（0 warning / 0 error）                                     |
| 改动文件 `oxfmt --check` + `prettier --check`  | PASS                                                            |
| `pnpm run build:platform`                      | Next + Soybean production build PASS                            |
| `pnpm test:e2e:admin`                          | Chrome 16/16 PASS，独立 3101/9527 与进程专属 SQLite             |

默认 `pnpm test:e2e` 硬编码 3100，按安全边界没有执行；它不能以复用或停止日常 3100 为代价充当本阶段证据。

## 7. 失败轮次与根因闭环

- Cloud integration 首轮使用了非 `aera_cloud` 数据库名，被 Cloud dedicated-database guard 正确拒绝；未触碰 P2 数据库。
- 第二轮 URL 没有非空凭据字段，被配置校验正确拒绝；加入仅用于一次性门禁的本地字段后完整重跑通过。
- Admin integration 首轮未注入测试所需 `PAYLOAD_SECRET`，18 个 Payload 相关用例同因失败；加入一次性 secret 与独立 SQLite 后完整重跑通过。
- 根 lint 与 Web lint 的实际问题见第 5 节，均已最小修复并用原/非修复式命令复验。

## 8. 交付边界与 teardown

- P2 本地隔离集成：PASS。
- 候选镜像：未构建为发布候选；production build 不能替代候选镜像证明。
- 部署 / 真实环境：未执行。
- P3 Runtime：未开始；Admin E2E 中的 mock/fail-closed Runtime 用例不算 P3。
- teardown：已完成。
  - Playwright trace 已停止，`aera-admin-p2-evidence` 浏览器已关闭；截图、snapshot、network trace 保留在第 3 节目录。
  - P2 Cloud、Payload、Soybean 已停止；验收端口 `18087/18444/3232/9528` 已释放。
  - Compose project、额外 gate 容器、P2 网络与 PostgreSQL/MinIO volumes 已删除；一次性 fixture 数据不可恢复。
  - 开发 PKI、临时 secret/SQLite 与本次构建缓存已从工作树和 `/private/tmp` 移入 macOS 废纸篓，可恢复。
  - 日常 `3100` 仍由 PID `60278` 监听。
