# Aera Admin

Aera Admin 是 Aera 公司内部控制台，只允许获批的开发、运营、客服、财务和审计人员访问。它不向普通用户或 Workspace Owner 开放，也不复用普通 Aera 用户凭证。

当前仓库已完成 Aera Admin 一期功能：独立管理员认证安全底座、固定 RBAC、不可变审计查询、管理员会话与审计保留策略、动态标准原因目录，以及 Admin 侧 Cloud 用户、设备、会话、双人审批、幂等和 Outbox 工作流。Cloud 管理或标准原因目录不可达时严格失败关闭，页面不会回退到模拟数据、浏览器硬编码原因或虚假成功。

真实 `aera-cloud` 已实现独立的 Internal Admin API 监听、mTLS 与短期 Ed25519 服务令牌双重鉴权。当前跨仓库 E2E 会启动真实 Cloud、真实 Admin 和各自隔离的 PostgreSQL/Redis，验证精确身份查询的脱敏结果、Session 撤销、双人审批后的账号禁用、Outbox 重试、Cloud 最终状态与两侧审计；这仍是本地验收结果，不代表已经部署或发布。

## 本地开发

需要 Go 1.26.5、Node.js 24、pnpm 11.5.2、Docker 和 Docker Compose。

```bash
make dependencies-up
pnpm install --frozen-lockfile
make check
```

应用只从进程环境读取配置，不自动加载 `.env`。以 [`.env.example`](./.env.example) 为字段清单，为三个 key ring、Session HMAC、CSRF HMAC 和 Operation HMAC 分别生成至少 32 字节的独立随机密钥；不要提交真实值。

基础配置项：

- `AERA_ADMIN_ENVIRONMENT`
- `AERA_ADMIN_LISTEN_ADDR`
- `AERA_ADMIN_PUBLIC_URL`
- `AERA_ADMIN_DATABASE_URL`
- `AERA_ADMIN_REDIS_ADDR`
- `AERA_ADMIN_TRUSTED_PROXY_CIDRS`
- `AERA_ADMIN_IDENTITY_ENCRYPTION_KEYS`
- `AERA_ADMIN_IDENTITY_LOOKUP_KEYS`
- `AERA_ADMIN_TOTP_ENCRYPTION_KEYS`
- `AERA_ADMIN_SESSION_HMAC_KEY`
- `AERA_ADMIN_CSRF_HMAC_KEY`
- `AERA_ADMIN_OPERATION_HMAC_KEY`
- `AERA_ADMIN_CLOUD_ENABLED`

本地只验证安全底座、尚未连接 Cloud 时，将 `AERA_ADMIN_CLOUD_ENABLED` 设为 `false`；用户、设备、会话、审批和官方 Agent 查询会明确返回未配置状态，不会回退到模拟数据。

启用 Cloud 管理链路时，以下配置全部必填：

- `AERA_ADMIN_CLOUD_BASE_URL`
- `AERA_ADMIN_CLOUD_CA_FILE`
- `AERA_ADMIN_CLOUD_CLIENT_CERT_FILE`
- `AERA_ADMIN_CLOUD_CLIENT_KEY_FILE`
- `AERA_ADMIN_CLOUD_JWT_SIGNING_KEY_FILE`
- `AERA_ADMIN_CLOUD_JWT_ISSUER`
- `AERA_ADMIN_CLOUD_JWT_SUBJECT`
- `AERA_ADMIN_CLOUD_SCOPES`

CA、客户端证书、客户端私钥和 Ed25519 签名私钥必须使用仓库外的规范绝对路径，并由批准的 Secret Manager 挂载；Cloud Origin 必须使用 HTTPS，权限范围必须逐项列出，禁止通配符。

官方 Agent 链路还要求显式列出 `official_agents:read`、`official_agent_drafts:write`、`official_agent_reviews:write`、`official_agent_releases:write` 和 `official_agent_audit:read`。Admin 只按配置申请这些 scope；`aera-cloud` 的 `AGENTERA_CLOUD_OFFICIAL_AGENTS_ENABLED` 仍是最终功能开关。Cloud 未启用、不可达或返回未知状态时，Admin 必须显示不可用/待确认，不能生成模拟成功。官方请求的短期服务令牌只绑定管理员 ID、固定角色及必要的 operation/approval 标识，不携带原因、备注、Manifest、Bundle、灰度名单或任何密钥材料。

```bash
make build
./bin/aera-admin
```

首次初始化必须创建并激活两名不同的超级管理员。命令只在标准输出返回一次完整激活链接；立即通过公司批准的安全渠道转交，禁止写入工单正文、聊天记录或日志。

```bash
./bin/aera-admin-bootstrap invite-super-admin --email first@example.com --display-name 第一管理员
./bin/aera-admin-bootstrap invite-super-admin --email second@example.com --display-name 第二管理员
```

每人访问各自的 `/activate#token=...` 链接，创建独立密码、绑定 TOTP 并保存八个一次性恢复码。两人完成激活前，管理员变更保持关闭。

## 一期权限与安全策略

审计记录通过 `/audit` 查询，服务端按固定角色强制数据范围：超级管理员和审计员可查看全部记录，运营与客服只能查看本人记录，开发与财务无权访问。接口支持稳定游标分页，以及操作人、事件、对象、结果、标准原因和时间范围的精确筛选；响应不包含完整身份、来源 IP 摘要、User-Agent 或审计哈希链字段。每次成功查询本身也会写入审计，但只记录筛选类别，不记录筛选值。

`/system/settings` 由超级管理员管理，审计员只读。所有设置写入都要求最近一次 TOTP Step-up、同源 Origin、CSRF、`Idempotency-Key`、预期修订号和有效的安全类标准原因。修改会话空闲时长或绝对有效期会撤销所有管理员会话（包括修改者），页面收到成功结果后清理内存会话并返回登录页；仅修改审计保留期限不会撤销会话。

`audit_retention_days` 是部署与合规操作必须满足的最低保留策略。Admin 运行时不会删除或归档审计记录，页面也不提供删除入口；物理生命周期处理需要另行授权的维护流程，不属于一期运行时能力。

标准原因由服务端版本化目录统一提供。管理员、账号、设备、会话和设置表单按操作用途获取允许的有效原因；目录不可用或没有匹配原因时提交按钮保持关闭。原因码和分类创建后不可修改，记录不会删除，受保护的安全原因及每个分类最后一个有效原因不能停用。

## 验收门禁

```bash
make verify  # 格式、vet、Go/竞态/集成、前端、OpenAPI、E2E 类型与 release 构建
AERA_ADMIN_E2E_CLOUD_REPO=/Users/zizimutou/Desktop/aera/aera-cloud make e2e
make image   # aera-admin:security-foundation
```

`AERA_ADMIN_E2E_CLOUD_REPO` 必须指向包含配套 Internal Admin API 的真实 aera-cloud 工作区；运行器会先验证 Go module 和两仓 OpenAPI 文件逐字节一致。`make e2e` 临时生成 CA、服务端/客户端证书、Ed25519 服务密钥与两个隔离的 Compose project，通过动态 loopback 端口启动真实 Cloud 和 Admin。应用端口由进程锁保护，同一台机器不能并发运行两组 E2E；结束时会停止进程、销毁两组测试卷，并清除一次性凭证、测试 PKI 和 fixture，不会删除或复用日常开发数据库。

跨仓库 E2E 通过只证明当前两个工作区在本机完成验证。Git 提交、分支推送、合并、私有环境部署和生产发布仍是彼此独立的交付状态。

## 容器

多阶段镜像只包含无 CGO 的服务端和初始化二进制，不包含源码、Node 包缓存或构建密钥。

```bash
docker build -t aera-admin:security-foundation .
docker run --rm --env-file /secure/path/aera-admin.env -p 127.0.0.1:8080:8080 aera-admin:security-foundation
```

初始化作业可在同一镜像中临时覆盖入口为 `/aera-admin-bootstrap`。生产环境应由密钥管理系统直接注入环境变量，不应长期保存包含明文密钥的 env 文件。

## 生产安全边界

- 只通过公司身份网络或零信任访问层暴露；禁止直接面向公网或普通用户路由。
- `AERA_ADMIN_PUBLIC_URL` 必须是实际 HTTPS Origin。TLS 终止代理网段必须逐项写入 `AERA_ADMIN_TRUSTED_PROXY_CIDRS`；部署审查必须拒绝 `0.0.0.0/0`、`::/0` 等全网信任配置。
- 身份加密、精确查找 HMAC、TOTP 加密、Session HMAC、CSRF HMAC 和 Operation HMAC 使用彼此独立的密钥，并从批准的 Secret Manager/KMS 注入。轮换时先在 key ring 中保留旧读取密钥。
- Cloud 管理只允许独立 mTLS 客户端身份和 audience/scope 受限的短期 Ed25519 服务令牌；不得关闭证书校验、跟随重定向或把私钥放入镜像。
- PostgreSQL 使用 `verify-full` TLS 和最小权限运行身份；Redis 位于私有网络。不得把开发 Compose 密码用于生产。
- 生产模式才发送 HSTS；所有环境均发送 CSP、`frame-ancestors 'none'`、`nosniff`、`no-referrer`、跨源打开器/资源策略与权限策略。
- 日志、审计、告警和工单不得包含完整邮箱、密码、TOTP/恢复码、激活令牌、Session Cookie 或 CSRF 值。

本地通过、Git 提交、推送、部署和发布是五个独立状态；任何一个状态都不能推断后续状态已经完成。
