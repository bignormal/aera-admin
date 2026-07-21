# Aera Admin 一期设计规格

- 状态：已批准
- 批准日期：2026-07-21
- 产品范围：Aera 公司内部后台管理
- Admin 工作目录：`/Users/zizimutou/Desktop/aera/aera-admin`
- Admin 远端仓库：`https://github.com/bignormal/aera-admin`
- Cloud 配套目录：`/Users/zizimutou/Desktop/aera/aera-cloud`
- Cloud 远端仓库：`https://github.com/bignormal/aera-cloud`

## 1. 目标

构建一套仅供 Aera 公司内部开发、运营、客服、财务和审计人员使用的后台管理系统。普通 Aera 用户、Workspace Owner 和 Workspace Member 均不得访问。

一期选择“后台安全底座 + Aera Cloud 用户、设备、会话管理”，首先解决以下问题：

1. 建立独立的内部管理员身份、强制 TOTP MFA 和固定 RBAC。
2. 以脱敏方式查询 Aera Cloud 用户、设备和会话。
3. 允许按完整邮箱或手机号精确查找用户，但原始搜索值不得进入 URL、日志、缓存、审计或响应。
4. 允许客服、运营和超级管理员带原因撤销单个设备或会话。
5. 账号禁用或恢复必须由运营发起、另一名超级管理员审批，且审批成功不等于执行成功。
6. 所有敏感操作均可审计、可对账、可幂等重试，并且不能接触 Hermes 本地数据。

## 2. 已批准的核心决策

### 2.1 产品与访问边界

- Aera Admin 是独立内部系统，不是普通用户控制台，也不是 Workspace Owner 控制台。
- Admin 不复用 Aera 普通账号体系。
- Admin 不提供普通用户模拟登录。
- Admin 不提供任意 SQL、数据库浏览器、远程命令或密钥读取能力。
- Admin 不读取或管理 Hermes/Aera Runtime 的本地记忆、会话、Profile、RuntimeBinding、Skills、文件或凭证。
- Admin 不持有 Aera Cloud 的签名私钥。

### 2.2 一期技术方案

- 前端：React 19、TypeScript、Vite。
- UI：Ant Design 5，通过 Aera Design Token 实现 RuoYi-Plus-Soybean 风格的紧凑企业后台。
- 前端状态：TanStack Query 管理服务端状态；React Hook Form 与 Zod 管理表单和校验。
- 路由：React Router。
- BFF：Go 1.26.5、Chi、pgx，与当前 `aera-cloud` 工具链保持一致。
- Admin 数据：PostgreSQL。
- 会话、登录挑战、MFA 新鲜度和限流：Redis。
- Admin 前端与 BFF 同源部署，浏览器只访问 Admin BFF。

### 2.3 视觉方向

- 深海军蓝侧栏、浅灰页面背景、白色内容卡片、Aera 蓝主色。
- 保留 RuoYi-Plus-Soybean 的侧栏、顶部栏、面包屑、可关闭页签、筛选区、紧凑表格和右侧详情抽屉。
- 使用 React 组件实现视觉语言，不引入 Vue 运行时，也不复制参考项目的业务代码。
- 默认中文界面，桌面端优先；支持 1280px 以上工作区，窄屏时侧栏折叠。
- 危险操作不只依赖颜色，必须有文字、图标、确认对话框和明确结果状态。

## 3. 系统架构与数据归属

```text
公司内部浏览器
    |
    | HTTPS / HttpOnly Admin Session
    v
Aera Admin（React + Go BFF）
    |-- Admin PostgreSQL：管理员、MFA、审批、Admin 审计
    |-- Redis：会话、挑战、限流、短期安全状态
    |
    | mTLS + 短期 audience-bound 服务令牌
    v
Aera Cloud Internal Admin API
    |
    v
Aera Cloud PostgreSQL / Redis
```

### 3.1 Admin 的职责

- 管理内部管理员、密码、TOTP、恢复码和管理会话。
- 执行固定 RBAC。
- 保存处置原因、审批状态、Outbox、Admin 审计和幂等记录。
- 调用 Cloud Internal Admin API，并将 Cloud 的真实结果呈现给操作者。
- 对 Cloud 返回的数据再次执行响应白名单和脱敏校验。

### 3.2 Cloud 的职责

- 继续作为普通用户、身份、设备、会话、个人空间和离线授权的唯一业务主数据源。
- 对身份进行规范化、HMAC 精确查询和脱敏输出。
- 原子执行会话撤销、设备撤销、账号禁用和账号恢复。
- 保存 Cloud 侧 `admin_operations` 与业务审计。
- 在业务状态发生变化时更新会话撤销缓存。

### 3.3 禁止的耦合

- Admin BFF 不直接连接 Cloud 数据库。
- 浏览器不直接调用 Cloud Internal Admin API。
- Cloud 不信任浏览器传来的角色、审批状态或管理员身份。
- Admin 不复制 Cloud 用户表形成第二份用户主数据。
- Admin 审批状态不能写进 Cloud 用户的业务状态字段。

## 4. 固定 RBAC

一期固定六个角色：

- `super_admin`
- `developer`
- `operator`
- `support`
- `finance`
- `auditor`

权限定义写入代码和数据库约束。后台可以分配角色，但不能创建自定义角色或在线修改角色权限。

| 能力 | super_admin | developer | operator | support | finance | auditor |
|---|---|---|---|---|---|---|
| 管理内部管理员及角色 | 管理 | 无 | 无 | 无 | 无 | 只读 |
| 服务健康与技术诊断 | 全部 | 全部 | 概览 | 工单相关 | 无 | 只读 |
| 按用户 ID、设备 ID 查询 | 是 | 是 | 是 | 是 | 无 | 仅审计快照 |
| 按完整邮箱/手机号精确搜索 | 是 | 否 | 是 | 是 | 否 | 否 |
| 查看脱敏用户资料 | 是 | 技术字段 | 是 | 是 | 否 | 仅审计快照 |
| 查看设备与会话 | 是 | 技术只读 | 是 | 是 | 否 | 仅审计快照 |
| 撤销单个设备或会话 | 是 | 否 | 是 | 是 | 否 | 否 |
| 发起账号禁用或恢复 | 否 | 否 | 是 | 否 | 否 | 否 |
| 审批账号禁用或恢复 | 是 | 否 | 否 | 否 | 否 | 否 |
| 查看完整 Admin 审计 | 是 | 技术事件 | 自己的处置 | 自己的处置 | 财务事件 | 全部只读 |
| 充值、额度和账单 | 后续管理 | 否 | 后续运营 | 后续工单只读 | 后续管理 | 后续只读 |

### 4.1 管理员安全限制

- 管理员不能停用自己、重置自己的 MFA 或修改自己的角色。
- 系统必须始终保留至少两名有效 `super_admin`。
- TOTP 重置必须由另一名超级管理员填写原因后执行，并撤销被重置人的所有会话。
- 账号禁用或恢复的发起人与审批人必须不同。
- `finance` 一期不获得 Cloud 用户管理权限；未上线的模块不授予占位权限。
- `auditor` 永远只读，不能通过直接 API 请求执行操作。

## 5. 管理员认证与会话

### 5.1 管理员账号生命周期

持久生命周期状态：

```text
invited -> active -> suspended
```

登录锁定是独立的临时安全状态，不与生命周期字段混用。TOTP 绑定状态也单独保存。

### 5.2 激活与登录

- 系统不提供默认账号或默认密码。
- 受限 CLI 创建首两名超级管理员邀请。
- 第二名超级管理员激活前，只开放管理员初始化能力；用户处置和 MFA 重置保持锁定。
- 邀请令牌一次性使用、短期有效，并且数据库只保存令牌哈希。
- 首次激活设置密码、绑定 TOTP，并生成一次性恢复码。
- 密码至少 12 位，允许密码管理器，不因固定周期无条件强制更换。
- 密码使用版本化 Argon2id 参数保存。
- TOTP 密钥使用部署密钥或 KMS 加密；恢复码只保存哈希。
- 登录先校验密码，再校验 TOTP；TOTP 未通过前不创建管理会话。
- 登录错误统一返回凭证无效，避免管理员账号枚举。
- 失败按账号和 IP 双维度限速，并采用渐进延迟和临时锁定。

### 5.3 管理会话

- Cookie：`Secure`、`HttpOnly`、`SameSite=Strict`。
- 所有修改请求同时校验 CSRF Token 和 Origin。
- 会话空闲 30 分钟过期，绝对生命周期 8 小时。
- 密码、MFA、角色或账号状态变化后撤销全部旧会话。
- 高风险操作要求最近 10 分钟内完成过 TOTP Step-up；否则先二次验证。
- 不提供“跳过 MFA”或“记住此设备”。
- 密码、TOTP、恢复码、Cookie 和服务令牌均不得进入日志或错误上报。

## 6. 身份搜索与脱敏

### 6.1 精确搜索流程

1. 有权限的管理员在受控输入框输入完整邮箱或手机号。
2. 前端通过 `POST` JSON 请求发送，不使用查询字符串。
3. Admin BFF 验证角色、类型、长度和格式，但不持久化原始输入。
4. Cloud 使用当前注册流程相同的 `NormalizeIdentity` 和 HMAC 候选索引进行精确匹配。
5. Cloud 只返回脱敏身份与允许的业务字段。
6. Admin BFF 对响应执行白名单校验后返回浏览器。
7. 前端在提交完成或页面卸载时清除原始输入。

现有 Cloud `identities` 表已经包含密文、`lookup_key_id` 和唯一 `lookup_hmac`，一期应复用现有实现，不能增加明文身份列。

### 6.2 禁止泄漏的位置

完整搜索值不得进入：

- URL 和浏览器历史
- LocalStorage、SessionStorage、IndexedDB
- TanStack Query Key 或持久缓存
- 前端埋点、错误回放、Breadcrumb
- 网关、Admin、Cloud 访问日志和结构化日志
- Trace 名称、Span 属性和指标标签
- Admin 审计与 Cloud 审计正文
- API 响应

搜索审计只保存管理员 ID、搜索类型、命中数量，以及命中后的内部用户 ID。未命中时不保存可反推身份的值。

### 6.3 输出规则

- 邮箱示例：`a***@example.com`
- 手机示例：`138****1234`
- 用户响应使用字段白名单，不能序列化完整身份对象后再靠前端隐藏。
- IP 默认保存 HMAC 或网络区域，不在页面展示完整地址。
- 用户详情不返回设备公钥、Token 哈希、身份密文或加密元数据。

## 7. 一期页面

| 路由 | 页面 | 主要内容 |
|---|---|---|
| `/login` | 管理员登录 | 密码、TOTP、锁定状态 |
| `/activate` | 首次激活 | 密码、TOTP、恢复码 |
| `/dashboard` | 工作台 | 待审批、近期处置、Cloud 健康、账号与设备统计 |
| `/security/admins` | 内部管理员 | 邀请、角色、暂停、撤销会话、重置 MFA |
| `/security/roles` | 角色与权限 | 六角色只读权限矩阵 |
| `/cloud/users` | Cloud 用户 | 脱敏列表、精确搜索、筛选、详情抽屉 |
| `/cloud/devices` | 设备与会话 | 设备、会话、单项撤销 |
| `/approvals` | 处置审批 | 禁用和恢复申请、审批与执行结果 |
| `/audit` | 审计记录 | 人员、动作、目标 ID、结果、时间筛选 |
| `/system/health` | 服务健康 | Admin、PostgreSQL、Redis、Cloud 状态 |
| `/system/settings` | 安全设置 | 会话策略、原因码、审计保留策略 |

### 7.1 用户列表与详情

列表字段：

- `user_id`
- 脱敏邮箱和手机号
- Cloud 账号状态
- 设备总数和有效设备数
- 活跃会话数
- 创建时间和最后 Cloud 活动时间
- 是否存在待处理禁用或恢复申请

详情抽屉：

1. 概览：脱敏身份、Cloud 状态、管理派生状态、创建时间。
2. 设备：设备 ID、显示名、平台、客户端版本、授权状态、最后活动。
3. 会话：短格式会话 ID、设备、签发、过期、撤销和重放状态。
4. 处置记录：与该用户有关的脱敏管理操作。

### 7.2 状态映射

Cloud 原始状态保持现有模型：

- 用户：`active | pending_deletion | disabled`
- 设备：`active | inactive | revoked`
- 会话派生：`active | rotated | expired | revoked | replay_detected`

Admin 的“待禁用”和“待恢复”只由审批单派生，不能写进 Cloud 用户状态。

只有 `status=disabled AND administratively_disabled=true AND deletion_finalized_at IS NULL` 的账号可以执行后台恢复。

## 8. 处置流程

### 8.1 撤销单个会话

- 允许角色：`support`、`operator`、`super_admin`。
- 必填标准原因码；补充说明可选。
- 操作前检查 Step-up 新鲜度。
- Admin 生成 `operation_id` 与幂等键。
- Cloud 撤销目标会话的整个 refresh family，并同步访问状态缓存。
- 页面只在查询到 Cloud 最终成功状态后显示成功。

### 8.2 撤销单个设备

- 允许角色：`support`、`operator`、`super_admin`。
- Cloud 以用户生命周期锁保护设备变更。
- 将设备标为 `revoked`。
- 撤销该设备关联的所有会话与离线授权签发记录。
- 一期不提供批量撤销。

### 8.3 禁用或恢复账号

审批状态与执行状态分开保存：

```text
approval_status:
pending_review -> approved | rejected | expired | cancelled

execution_status:
not_started -> executing -> succeeded | failed | conflict
```

规则：

- 只有 `operator` 可以发起。
- 只有非发起人的 `super_admin` 可以批准或驳回。
- 申请保存目标用户 ID、脱敏快照、原因、预期 Cloud revision 和 24 小时有效期。
- 审批人不能编辑申请内容；需要修改时重新发起。
- 过期、目标状态变化或 revision 冲突时不能执行。
- 禁用应继续复用 Cloud 现有事务：禁用用户和个人空间，撤销设备、会话和离线授权记录。
- 恢复只恢复账号和个人空间的登录资格，不恢复旧会话、设备或离线授权。
- 已签发且当前离线的本地授权不能被伪装成瞬时断开；页面必须显示“Cloud 已禁用，离线设备待联机校验/本地授权到期”。

## 9. API 合约

### 9.1 Admin 浏览器 API

```text
POST /api/v1/auth/login
POST /api/v1/auth/totp/verify
POST /api/v1/auth/step-up
POST /api/v1/auth/logout
GET  /api/v1/me

GET  /api/v1/admin-users
POST /api/v1/admin-users/invitations
PUT  /api/v1/admin-users/{id}/role
POST /api/v1/admin-users/{id}/suspend
POST /api/v1/admin-users/{id}/sessions/revoke
POST /api/v1/admin-users/{id}/totp/reset

GET  /api/v1/cloud-users
POST /api/v1/cloud-users/lookup
GET  /api/v1/cloud-users/{userID}
GET  /api/v1/cloud-users/{userID}/devices
GET  /api/v1/cloud-users/{userID}/sessions
POST /api/v1/cloud-devices/{deviceID}/revoke
POST /api/v1/cloud-sessions/{sessionID}/revoke

POST /api/v1/approval-requests
GET  /api/v1/approval-requests
GET  /api/v1/approval-requests/{id}
POST /api/v1/approval-requests/{id}/approve
POST /api/v1/approval-requests/{id}/reject
POST /api/v1/approval-requests/{id}/cancel

GET  /api/v1/audit-events
GET  /api/v1/system/health
```

### 9.2 Cloud Internal Admin API

Internal API 必须运行在独立内部监听端口，不挂载到 Cloud 公网 Router：

```text
POST /internal/admin/v1/users/lookup
GET  /internal/admin/v1/users
GET  /internal/admin/v1/users/{userID}
GET  /internal/admin/v1/users/{userID}/devices
GET  /internal/admin/v1/users/{userID}/sessions
GET  /internal/admin/v1/users/{userID}/audit-events

POST /internal/admin/v1/devices/{deviceID}/revoke
POST /internal/admin/v1/sessions/{sessionID}/revoke
POST /internal/admin/v1/users/{userID}/disable
POST /internal/admin/v1/users/{userID}/enable
GET  /internal/admin/v1/operations/{operationID}
```

### 9.3 通用 API 约束

- JSON、UTF-8、UTC RFC3339 时间。
- 列表采用稳定游标分页，不使用高偏移分页。
- 所有响应设置 `Cache-Control: no-store`。
- 所有修改接口要求 CSRF Token、`Idempotency-Key` 和原因码。
- 使用稳定机器错误码，不把数据库或加密组件的原始错误发给浏览器。
- Cloud 修改接口要求预期 `administrative_revision`。
- OpenAPI 文档是 Admin 与 Cloud 的契约来源，CI 运行契约测试。

统一错误结构：

```json
{
  "error": {
    "code": "APPROVAL_STATE_CONFLICT",
    "message": "申请状态已变化，请刷新后重试",
    "request_id": "req_xxx"
  }
}
```

稳定错误码至少包括：

```text
AUTH_INVALID_CREDENTIALS
AUTH_MFA_REQUIRED
AUTH_STEP_UP_REQUIRED
AUTH_ACCOUNT_LOCKED
PERMISSION_DENIED
USER_NOT_FOUND
USER_STATE_CONFLICT
DEVICE_ALREADY_REVOKED
SESSION_ALREADY_REVOKED
APPROVAL_EXPIRED
APPROVAL_SELF_REVIEW_FORBIDDEN
APPROVAL_STATE_CONFLICT
CLOUD_UNAVAILABLE
OPERATION_STATUS_UNKNOWN
RATE_LIMITED
```

## 10. Admin 数据模型

一期 Admin PostgreSQL 至少包含：

```text
admin_users
admin_password_credentials
admin_totp_credentials
admin_recovery_codes
admin_sessions
admin_invitations
approval_requests
approval_events
admin_outbox
admin_audit_events
admin_audit_checkpoints
admin_idempotency_records
reason_codes
```

约束：

- 管理员登录身份也采用密文加 HMAC 索引，不保存可查询明文副本。
- 密码、恢复码和会话令牌只保存哈希。
- TOTP 密钥加密保存。
- 审批只保存用户 ID 和脱敏快照，不保存完整普通用户身份。
- 自由文本说明限制长度；服务端拒绝邮箱、手机号、Token、私钥等敏感内容模式。工单使用独立 `ticket_reference` 字段。
- 审计表的数据库角色只允许追加，应用 API 不提供更新或删除。

## 11. Cloud 配套改动

复用现有 `internal/admin` 领域，不在 HTTP Handler 中复制 SQL。现有能力包括账号禁用、账号恢复、会话 family 撤销和脱敏审计查询。

需要补充：

- 独立 Internal Admin HTTP Listener。
- mTLS 与服务令牌认证中间件；令牌固定 `aud=aera-cloud-admin` 和最小 scope。
- 脱敏用户列表、精确查询、设备和会话读取服务。
- `RevokeDevice` 管理命令。
- `users.administrative_revision` 及并发前置检查。
- `admin_operations`，保存 operation、幂等键哈希、调用方、动作、目标、状态和结果。
- 将现有 `operator string` 扩展为结构化管理员 ID、原因码、审批 ID、request ID 和 operation ID。
- Cloud 修改和 Cloud 审计保持同一数据库事务。
- Redis 会话状态同步和 operation 状态查询。

## 12. 审计与可观测性

### 12.1 Admin 审计字段

- 事件 ID、发生时间
- 管理员 ID 与当时角色快照
- 动作、目标类型、内部目标 ID
- 原因码、工单引用和经过安全校验的补充说明
- 审批 ID、request ID、operation ID
- 安全裁剪的前后状态
- 结果和稳定错误码
- 来源 IP HMAC 或网络区域
- 截断且清洗后的 User-Agent
- 前序事件哈希

### 12.2 审计禁区

禁止记录完整邮箱、手机号、IP、密码、TOTP、恢复码、Token、Cookie、搜索输入、身份密文、设备公钥、服务密钥或数据库连接信息。

### 12.3 防篡改与保留

- Admin 审计通过前序哈希形成链。
- 每日生成外部签名检查点。
- 默认保留 730 天，部署时可根据公司合规政策配置。
- 后台不提供删除入口。
- 指标标签采用动作和结果等低基数字段，禁止使用用户 ID、邮箱、手机号或 operation ID 作为指标标签。

## 13. 跨服务一致性与故障策略

跨服务操作采用 Outbox、至少一次投递和 Cloud 幂等执行：

1. Admin 在一个事务内保存审批结果、审计意图和 Outbox。
2. Worker 使用固定 operation ID 与幂等键调用 Cloud。
3. Cloud 在一个事务内保存 `admin_operations`、业务变更和 Cloud 审计。
4. Admin 保存最终结果并完成本侧审计。
5. 网络结果未知时查询 operation 状态，再决定是否重试。

故障规则：

- Cloud 不可用：敏感修改失败关闭；不显示虚假成功。
- Cloud 已成功、Admin 写回失败：Outbox 根据 operation ID 对账恢复。
- Cloud 审计失败：Cloud 业务变更回滚。
- Admin PostgreSQL 不可用：停止登录、审批和处置。
- Redis 不可用：停止登录、MFA、Step-up 和敏感操作；不得降级为仅密码。
- 读取请求不跨请求缓存敏感用户数据。
- 页面区分“已批准”“执行中”“执行失败”“状态未知”和“执行成功”。

## 14. 部署与密钥边界

- React 静态资源嵌入 Admin Go 二进制，同源提供页面与 API。
- Admin 入口位于公司 VPN、Zero Trust 网关或固定出口白名单之后。
- Admin BFF、Admin PostgreSQL 和 Redis 位于内部网络。
- Cloud Internal Admin API 使用独立内部端口和私有网络策略。
- Admin 数据库账号无权访问 Cloud 数据库，Cloud 数据库账号也不访问 Admin 数据库。
- 密码 Pepper、TOTP 加密密钥、Cookie 密钥、HMAC 密钥和 mTLS 私钥通过部署密钥系统注入，不进入仓库、镜像或日志。
- `/health/live` 仅报告进程存活；`/health/ready` 检查依赖，但不暴露连接信息。
- 数据库备份加密保存，并定期执行恢复验证。

## 15. 测试与验收

### 15.1 自动化层级

- React 组件、表单、权限路由和脱敏展示测试。
- Go 认证、TOTP、RBAC、审批、审计、幂等和脱敏单元测试。
- PostgreSQL 与 Redis 集成测试。
- Admin 与 Cloud OpenAPI 契约测试。
- 并发审批、重复处置、网络超时和 Outbox 恢复测试。
- Playwright 六角色端到端流程测试。
- URL、浏览器存储、网络请求和日志中的敏感数据泄漏测试。
- 内部测试环境部署冒烟。

### 15.2 必须通过的验收项

1. 六角色对无权 API 的直接请求返回 `403`，不能只依赖隐藏菜单。
2. 未完成 TOTP 不能获得管理会话。
3. 密码、MFA、角色或账号状态变化后旧会话立即失效。
4. 完整身份可以精确命中，但原始值不会出现在 URL、存储、日志、审计或响应。
5. 所有普通用户身份响应保持脱敏。
6. 单设备和单会话撤销支持幂等重试。
7. 未经另一名超级管理员批准，运营申请不能调用 Cloud。
8. 并发审批只有一次合法状态转换。
9. 禁用阻止登录、刷新和新设备绑定；离线状态不虚假宣称即时断开。
10. 恢复不恢复旧会话、设备或离线授权。
11. Cloud 超时或断网不显示成功。
12. Admin 与 Cloud 可通过 request ID、approval ID 和 operation ID 对账。
13. 审计更新和删除在数据库权限层被拒绝。
14. 页面刷新、重复点击和 Worker 重试不产生重复业务动作。
15. Internal Admin API 无法通过公网入口访问。

## 16. 分阶段实施顺序

### 阶段 1：仓库与工程底座

- 初始化 Admin 工程、目录结构、CI、迁移、Docker 和本地开发环境。
- 建立 OpenAPI、配置加载、日志白名单和测试框架。

### 阶段 2：管理员安全底座

- 管理员邀请、激活、密码、TOTP、恢复码、会话和限流。
- 六角色 RBAC。
- 管理员暂停、角色分配、会话撤销、MFA 重置。
- Admin 追加式审计。

### 阶段 3：Cloud 只读管理链路

- Cloud Internal Admin Listener 和服务身份认证。
- 用户精确查询、脱敏列表、详情、设备和会话查询。
- Admin 工作台、用户页、设备页和健康页。

### 阶段 4：单项处置

- 复用 Cloud 会话撤销。
- 新增 Cloud 设备管理撤销。
- operation、幂等、Outbox 和状态查询。
- Admin 单项处置交互。

### 阶段 5：双人审批

- 禁用和恢复申请。
- 非本人审批、过期、冲突和取消。
- 执行恢复、对账和审批页面。

### 阶段 6：安全收口与上线

- 自动化测试和敏感数据泄漏检查。
- 权限矩阵验收和内部环境冒烟。
- 监控告警、备份恢复和上线手册。

## 17. 一期明确不做

- Workspace、成员、Agent 和 ExperienceCandidate 管理。
- `aera-api` 充值、余额、模型、账单和财务操作。
- 普通用户模拟登录或密码代改。
- 完整身份展示、复制或导出。
- 批量用户、设备或会话处置。
- Hermes Runtime 本地数据访问。
- 官网内容管理。
- 桌面客户端功能修改。
- SSO；独立账号加密码和强制 TOTP 是一期基线，SSO 留待后续。

## 18. 仓库与交付约束

- Aera Admin 产品代码、迁移、测试、部署文件和文档只进入 `bignormal/aera-admin`。
- Aera Cloud Internal Admin API 和 Cloud 生命周期改动只进入 `bignormal/aera-cloud`，不得复制进 Admin 仓库。
- `aera-api`、`aera-runtime`、`aera` 和 `aera-guanwang` 一期不修改。
- 本地验证、提交、推送、部署和发布是不同状态，交付报告必须分别说明。
- Admin 开发和验收完成后，推送到用户指定的 `bignormal/aera-admin`。
- 不提交 `.superpowers/` 视觉协作临时文件、密钥、环境变量或本地数据库。

