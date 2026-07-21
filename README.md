# Aera Admin

Aera Admin 是 Aera 公司内部控制台，只允许获批的开发、运营、客服、财务和审计人员访问。它不向普通用户或 Workspace Owner 开放，也不复用普通 Aera 用户凭证。

当前安全底座已实现独立管理员身份、密码 + 强制 TOTP、一次性恢复码、固定 RBAC、管理员邀请/暂停/角色调整/会话撤销/MFA 重置，以及追加写入的哈希链审计。Cloud 用户、设备、会话和审批菜单仍是明确标注的未接入占位页，不能视为已经交付的 Cloud 管理能力。

## 本地开发

需要 Go 1.26.5、Node.js 24、pnpm 11.5.2、Docker 和 Docker Compose。

```bash
make dependencies-up
pnpm install --frozen-lockfile
make check
```

应用只从进程环境读取配置，不自动加载 `.env`。以 [`.env.example`](./.env.example) 为字段清单，为三个 key ring、Session HMAC 和 CSRF HMAC 分别生成至少 32 字节的独立随机密钥；不要提交真实值。

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

## 验收门禁

```bash
make check   # 格式、vet、Go/竞态/集成、前端、OpenAPI、release 构建
make e2e     # 隔离数据库中的真实激活、登录、RBAC、会话撤销、响应头与泄漏检查
make image   # aera-admin:security-foundation
```

`make e2e` 只删除固定的 `aera_admin_e2e` 数据库和 `aera-admin:test:*` Redis 键，并在结束时清除包含一次性凭证的临时文件。固定资源由进程锁保护，同一台机器不能并发运行两组 E2E；它不会改动开发数据库。

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
- 身份加密、精确查找 HMAC、TOTP 加密、Session HMAC 和 CSRF HMAC 使用彼此独立的密钥，并从批准的 Secret Manager/KMS 注入。轮换时先在 key ring 中保留旧读取密钥。
- PostgreSQL 使用 `verify-full` TLS 和最小权限运行身份；Redis 位于私有网络。不得把开发 Compose 密码用于生产。
- 生产模式才发送 HSTS；所有环境均发送 CSP、`frame-ancestors 'none'`、`nosniff`、`no-referrer`、跨源打开器/资源策略与权限策略。
- 日志、审计、告警和工单不得包含完整邮箱、密码、TOTP/恢复码、激活令牌、Session Cookie 或 CSRF 值。

本地通过、Git 提交、推送、部署和发布是五个独立状态；任何一个状态都不能推断后续状态已经完成。
