# Aera Admin Foundation V1 增量设计（Admin-only）

- 状态：已批准，待书面复核
- 设计批准日期：2026-07-22
- 父规格：`docs/superpowers/specs/2026-07-21-aera-admin-phase-1-design.md`
- 实施仓库：`/Users/zizimutou/Desktop/aera/aera-admin`
- 远端仓库：`https://github.com/bignormal/aera-admin`
- 基线提交：`6260a44 test: close Aera Admin security foundation`

## 1. 本增量的目的

当前仓库已经具备独立管理员账号、密码、强制 TOTP、管理会话、固定六角色 RBAC、管理员生命周期管理和追加式哈希链审计。本增量不重复这些能力，而是在同一安全底座上完成 Aera Admin 侧的 Cloud 用户、设备、会话和双人审批基础。

本次只修改 `aera-admin`。目标是让 Admin 侧的领域模型、BFF API、可靠执行机制、Cloud 客户端边界、页面和自动化测试达到可与未来 Cloud Internal Admin API 对接的生产级状态。

由于本次不修改 `aera-cloud`，本增量不能被描述为已经完成真实 Cloud 端到端管理。Cloud 未配置、不可达或契约不匹配时，系统必须失败关闭，并明确显示“Cloud 管理服务不可用”，不得用演示数据、内存假实现或本地数据库伪造成功。

## 2. 范围

### 2.1 本次实现

1. Admin 侧 Cloud 用户、设备和会话的浏览器 API 与响应白名单。
2. 完整邮箱或手机号精确搜索的安全输入链路；原始搜索值不记录、不缓存、不回显。
3. 设备和会话单项撤销的 Admin 侧命令、幂等、Outbox 和状态展示。
4. 用户禁用和恢复的申请、非本人审批、取消、过期、冲突与执行状态。
5. Cloud Admin HTTP 客户端、mTLS 客户端身份和短期 audience-bound 服务令牌。
6. 用户、设备与会话、审批、Cloud 健康页面，沿用 RuoYi-Plus-Soybean 风格。
7. RBAC、Step-up、并发审批、Outbox 重试、契约、脱敏和失败关闭测试。
8. OpenAPI、配置示例、运行说明和交付状态文档。

### 2.2 本次不实现

- `aera-cloud` Internal Admin Listener、服务端鉴权、用户查询、设备/会话撤销或账号生命周期命令。
- 桌面端 Official Managed Agent、浏览、安装或任何其他桌面功能。
- Official Agent 草稿、审核、不可变版本、灰度发布或回滚。
- Workspace、Organization、成员、ExperienceCandidate 或 Platform Agent 管理。
- `aera-api` 充值、余额、账单、模型或财务功能。
- Hermes Profile、RuntimeBinding、Memory、会话、Skills、凭证或私有学习数据。
- 普通用户模拟登录、完整身份展示、批量操作、任意 SQL 或远程命令。
- `aera-runtime`、`aera`、`aera-api`、`aera-cloud` 和 `aera-guanwang` 的任何代码修改。

## 3. 交付状态定义

本增量完成后可以声明：

- `aera-admin` 的 Admin Foundation V1 客户端侧和工作流侧已经实现并通过本地自动化验证。
- Admin BFF 已经具备明确、可测试、失败关闭的 Cloud Internal Admin API 消费契约。
- 管理页面不再是功能占位页，能够真实呈现未配置、不可达、无权限、待审批、执行中、对账中、失败和成功状态。

本增量完成后仍不能声明：

- Aera Cloud 用户、设备或会话已经可以在真实环境中管理。
- 账号禁用、恢复或撤销已经完成跨服务端到端验收。
- Admin Foundation V1 已经部署或发布。
- Official Managed Agent 的后台前置门槛已经全部满足。

开始 Official Managed Agent 实现前，仍需在 `aera-cloud` 完成 Internal Admin API，并通过 mTLS、服务令牌、真实数据、幂等操作、双人审批和审计对账的跨服务验收。

## 4. 总体架构

```text
公司内部浏览器
    |
    | HTTPS / HttpOnly Admin Session / CSRF / Origin
    v
Aera Admin React
    |
    | 同源 JSON API
    v
Aera Admin Go BFF
    |-- 现有 Auth / RBAC / Audit
    |-- Cloud Control Application Service
    |-- Approval Application Service
    |-- Outbox Worker
    |-- Admin PostgreSQL / Redis
    |
    | CloudAdminClient
    | mTLS + short-lived service JWT
    v
Cloud Internal Admin API（本次仅定义消费者契约）
```

### 4.1 模块边界

建议在 Go BFF 内新增以下边界：

- `internal/cloudadmin`：Cloud 数据类型、客户端接口、HTTP Transport、错误映射和响应白名单。
- `internal/approval`：申请、审批事件、状态机、仓储和浏览器 API。
- `internal/operations`：幂等记录、Outbox、Worker、重试与对账。
- `internal/cloudcontrol`：组合 RBAC、Step-up、原因码、审批和 Cloud 客户端的应用服务。

模块不得直接读取其他模块的数据库表。HTTP Handler 只负责认证上下文、输入解析和稳定错误响应，业务约束必须位于应用服务或领域状态机中。

### 4.2 Cloud 客户端接口

Cloud 客户端至少提供以下语义方法：

- `LookupUser`
- `ListUsers`
- `GetUser`
- `ListUserDevices`
- `ListUserSessions`
- `RevokeDevice`
- `RevokeSession`
- `DisableUser`
- `EnableUser`
- `GetOperation`
- `Health`

应用服务只依赖接口，不依赖具体 HTTP 实现。测试替身只能存在于 `_test.go` 或测试包，生产构建中不提供返回演示用户或模拟成功的实现。

## 5. Cloud 服务身份

### 5.1 双重认证

启用 Cloud 管理链路时，每次请求必须同时具备：

1. 受信任的 mTLS 客户端证书。
2. 由 Admin 服务身份私钥签发的短期 JWT。

服务 JWT 至少包含：

- 固定 `iss` 与 `sub`，标识 Aera Admin 服务身份。
- 固定 `aud=aera-cloud-admin`。
- 最小权限 scope。
- `iat`、`nbf`、不超过 5 分钟的 `exp`。
- 每次签发唯一的 `jti`。

Admin 使用的是自身服务身份私钥，不得持有或复用 Aera Cloud 的用户 Token 签名私钥。证书、私钥、CA 和服务身份私钥均通过运行环境注入，不进入数据库、仓库、镜像、日志或错误响应。

### 5.2 配置模式

- Cloud 管理链路必须由显式配置启用。
- 未启用时，Admin 的认证和内部管理员管理仍可运行；所有 Cloud 路由返回稳定的 `CLOUD_NOT_CONFIGURED`，页面显示未配置状态。
- 已启用但缺少 Base URL、CA、客户端证书、客户端私钥或服务身份私钥时，进程启动失败。
- 已启用但握手、令牌或健康检查失败时，Cloud 查询和处置返回 `CLOUD_UNAVAILABLE`，不得降级为不安全连接。
- 生产 HTTP 客户端禁止跳过证书校验、禁止自动跟随到不同主机，并设置连接、TLS、响应头和总请求超时。

## 6. 浏览器 API 与数据安全

沿用父规格中的 `/api/v1/cloud-*` 与 `/api/v1/approval-requests` 路由。`api/openapi/admin.yaml` 是浏览器到 BFF 的契约来源；Admin 仓库另保存一份带版本标识的 Cloud 消费者契约快照，用于客户端和未来 Cloud 服务端 OpenAPI 的差异校验。

### 6.1 精确身份搜索

- 使用 `POST /api/v1/cloud-users/lookup` 和 JSON Body，不使用 URL Query。
- 输入只允许明确声明的 `email` 或 `phone` 类型，并在 BFF 执行格式、长度和 Unicode 规范化边界校验。
- 原始输入不得进入访问日志、结构化日志、Trace、指标、审计、错误、数据库或缓存。
- 前端使用一次性 Mutation，不将原始输入放入 TanStack Query Key、浏览器存储或持久缓存。
- 请求结束或页面卸载时清空输入；响应只保留脱敏邮箱、脱敏手机号和允许的内部业务字段。
- BFF 对 Cloud 响应执行字段白名单与脱敏格式校验；出现意外字段或未脱敏身份时拒绝整个响应并记录不含敏感值的契约错误。

### 6.2 稳定错误

除父规格已有错误码外，本增量增加：

- `CLOUD_NOT_CONFIGURED`
- `CLOUD_CONTRACT_VIOLATION`
- `IDEMPOTENCY_KEY_REUSED`
- `OPERATION_RECONCILING`

浏览器不得接收上游响应正文、TLS 错误细节、数据库错误、服务令牌内容或内部地址。

## 7. Admin 数据模型

新增迁移至少包含以下表。

### 7.1 `approval_requests`

保存：

- 申请 ID、动作、目标类型和目标内部 ID。
- 发起管理员 ID、发起时角色快照。
- 原因码、工单引用、安全校验后的有限补充说明。
- 目标脱敏快照与预期 `administrative_revision`。
- 审批状态、执行状态、operation ID。
- 24 小时过期时间、创建和更新时间、并发版本号。

审批状态：

```text
pending_review -> approved | rejected | expired | cancelled
```

执行状态：

```text
not_started -> queued -> executing -> reconciling -> succeeded | failed | conflict
```

`reconciling` 在页面显示为“状态未知，正在对账”，不能显示成功。对账后可以回到 `queued`/`executing` 或进入最终状态。

### 7.2 `approval_events`

- 只追加保存申请的每次合法状态转换。
- 保存 actor、当时角色、前后状态、稳定结果码、request ID 和时间。
- 不允许通过应用数据库角色更新或删除。
- 审批人不能修改申请正文或目标快照。

### 7.3 `admin_outbox`

- 保存 operation ID、动作、目标 ID、审批 ID、幂等键哈希、安全载荷、状态、尝试次数、下一次尝试时间和租约。
- 不保存完整邮箱、手机号、Token、证书、私钥或 Cloud 响应原文。
- Worker 使用有界批次和 `FOR UPDATE SKIP LOCKED` 领取任务。
- 每次重试复用同一 operation ID 和同一幂等语义。
- 使用有上限的指数退避和抖动；网络结果未知时先查询 operation，再决定是否重试修改命令。

### 7.4 `admin_idempotency_records`

- 以管理员、动作和幂等键哈希形成唯一约束。
- 保存请求语义摘要、operation ID、状态和安全裁剪后的最终结果。
- 相同键与相同请求返回同一 operation；相同键与不同请求返回 `IDEMPOTENCY_KEY_REUSED`。
- 记录设置明确保留期，清理任务只能删除超过保留期且已进入最终状态的记录。

## 8. 操作和审批流程

### 8.1 单个设备或会话撤销

1. BFF 校验管理会话、CSRF、Origin、RBAC 和最近 10 分钟 TOTP Step-up。
2. 校验标准原因码、可选工单引用和 `Idempotency-Key`。
3. Cloud 未配置或当前不可安全调用时，立即失败，不创建会在未来意外执行的延迟命令。
4. 在同一 Admin 数据库事务中分配 operation ID，并创建幂等记录、Outbox 和审计意图；不为此重复引入独立的本地 operation 主表。
5. Worker 调用 Cloud；只有 Cloud 返回或对账确认最终成功后，页面才显示成功。
6. 超时或断线进入 `reconciling`，重复请求返回同一 operation 状态。

### 8.2 用户禁用或恢复

1. 只有 `operator` 可以发起；创建申请前必须从 Cloud 获得目标脱敏快照与当前 revision。
2. Cloud 未配置或目标状态无法验证时，禁止创建申请。
3. 只有非发起人的 `super_admin` 可以批准或驳回。
4. 原发起人只能取消仍处于 `pending_review` 的申请。
5. 批准使用条件更新或行锁保证并发审批只有一个合法状态转换。
6. 批准事务同时追加审批事件、Admin 审计并创建 Outbox；“批准”与“执行成功”独立显示。
7. 过期、revision 冲突或目标状态冲突进入明确状态，不自动创建修改后的新申请。
8. 网络结果未知时进入对账；不得重新生成 operation ID 绕过 Cloud 幂等。

## 9. 页面设计

继续使用 React、Ant Design 和现有 Aera Token，保持紧凑的 RuoYi-Plus-Soybean 企业后台风格。

### 9.1 `/cloud/users`

- 脱敏用户列表、显式分页、筛选区和精确搜索。
- 详情抽屉包含概览、设备、会话和相关处置记录。
- 无权限、未配置、不可达、空结果和契约异常分别展示。
- 原始搜索值不进入 URL、页签标题、最近搜索、浏览器存储或错误回放。

### 9.2 `/cloud/devices`

- 以用户为上下文展示设备和会话，不提供跨租户批量列表或批量操作。
- 危险操作使用原因表单、Step-up、二次确认和 operation 状态抽屉。
- 重复点击复用同一前端幂等上下文，不能创建多个业务动作。

### 9.3 `/approvals`

- 分开展示“待我审批”“我发起的”“全部可见”三个视图，最终可见范围由 BFF 权限决定。
- 详情展示申请内容、脱敏目标、发起人、审批事件、执行状态和对账状态。
- 发起人看不到批准按钮；非超级管理员不能通过直接 API 批准。
- 批准弹窗只允许确认或拒绝，不能编辑原因、目标或 revision。

### 9.4 `/dashboard` 与 `/system/health`

- 工作台统计来自真实 BFF 数据；Cloud 不可用时不显示虚构数量。
- 健康页区分 Admin PostgreSQL、Redis、Cloud 配置、mTLS、服务令牌和上游健康状态，但不暴露主机、证书主题、密钥路径或握手错误细节。

## 10. 权限与审计

- 沿用现有固定六角色权限，不增加自定义角色编辑器。
- 菜单和按钮按权限裁剪，但所有 BFF 路由必须再次执行 RBAC。
- 设备/会话撤销、发起禁用/恢复、批准/拒绝均要求 TOTP Step-up。
- 每个本地状态转换和每次 Cloud 调用结果都追加 Admin 审计，并关联 request ID、approval ID 和 operation ID。
- 审计只保存目标内部 ID和脱敏快照，不保存搜索输入或完整身份。
- Cloud 客户端日志只允许方法、稳定动作名、结果码、耗时和 request ID；禁止记录请求或响应 Body。

## 11. 测试策略

### 11.1 Go 测试

- RBAC 表驱动测试覆盖六角色对所有新增路由的允许与拒绝。
- 审批状态机测试覆盖本人审批、错误角色、取消、过期、冲突和重复请求。
- PostgreSQL 集成测试覆盖并发批准唯一性、事务回滚、Outbox 租约和幂等唯一约束。
- Worker 测试覆盖成功、可重试错误、永久错误、超时、结果未知、对账和进程重启恢复。
- Cloud HTTP 客户端使用只存在于测试中的 TLS Server，验证双向 TLS、JWT audience/expiry/scope、超时、重定向拒绝和错误裁剪。
- 响应白名单测试向客户端注入额外敏感字段和未脱敏身份，验证 BFF 拒绝响应。
- 日志捕获测试验证完整邮箱、手机号、Token 和证书内容不会出现。

### 11.2 React 测试

- 权限路由、按钮裁剪和直接 API 403 的 UI 反馈。
- 精确搜索输入清理、Query Key 不含原始身份、脱敏响应渲染。
- Cloud 未配置、不可达、契约异常、空结果和成功结果状态。
- 设备/会话撤销的原因、Step-up、重复点击和 operation 状态。
- 审批列表、非本人审批、只读事件和执行状态。

### 11.3 端到端测试

- Playwright 使用真实 Admin BFF、PostgreSQL 和 Redis。
- Cloud 依赖由独立的测试进程按消费者契约提供，不能编译进生产二进制。
- 覆盖 operator 发起、另一名 super_admin 批准、Outbox 执行和最终审计关联。
- 覆盖 Cloud 断网、超时和状态未知时页面不显示成功。
- 覆盖 URL、浏览器存储、网络响应和应用日志的敏感信息泄漏检查。

## 12. Admin-only 验收标准

1. `/cloud/users`、`/cloud/devices` 和 `/approvals` 不再使用通用占位页。
2. 六角色对新增 API 的越权请求稳定返回 `403`。
3. 完整邮箱/手机号只存在于单次请求内，不进入 URL、存储、日志、审计或响应。
4. 所有用户身份输出保持脱敏，意外未脱敏上游响应被拒绝。
5. Cloud 未配置或不可达时，查询与修改明确失败，页面不展示演示数据或假成功。
6. 设备和会话撤销具备幂等记录、Outbox、重试和对账状态。
7. 未经另一名超级管理员批准，不会为账号禁用或恢复创建 Outbox。
8. 并发批准只有一个合法状态转换；发起人不能批准自己的申请。
9. 批准状态与执行状态分开显示；网络未知显示“对账中”。
10. request ID、approval ID 和 operation ID 能在 Admin 数据库及审计中关联。
11. 生产构建不包含返回模拟 Cloud 数据或模拟成功的实现。
12. Go、React、OpenAPI、PostgreSQL/Redis 集成和 Playwright 测试全部通过。

## 13. 交付方式

1. 先根据本设计编写独立实施计划，再开始代码实现。
2. 实现过程中按迁移与领域、Cloud 客户端、BFF、页面、Worker、测试和文档分成可审查提交。
3. 完成后分别记录本地验证、提交、推送、部署和发布状态，不能互相替代。
4. 最终代码只推送到用户指定的 `bignormal/aera-admin` 分支；不将本增量复制到其他仓库。
5. 在 `aera-cloud` 未完成对应服务端契约前，README 和交付报告必须保留“尚未完成真实 Cloud 端到端管理”的说明。
