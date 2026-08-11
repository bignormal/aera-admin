# Aera Admin 内部 Beta 候选与私有部署

## 交付边界

当前 Admin 唯一来源是本仓库当前代码系。候选镜像同时包含 Payload
standalone 服务、Soybean `/admin/` 静态资源和私有同源网关；部署时以同一
`ghcr.io/bignormal/aera-admin@sha256:...` digest 启动 Payload 与网关，禁止把
两个组件从不同提交拼装。

内部 Beta 的 Admin 不进入公开 Caddy 路由。网关只发布到
`127.0.0.1:19090`，测试人员通过 SSH 隧道访问；Payload 的 3000 端口只存在于
Docker 私有网络。网关同时连接一个独立的非 internal bridge，以便 Docker
在宿主机建立回环端口映射；该网络不连接 Payload，且不改变
`127.0.0.1` 的唯一发布地址。候选默认 `mutationsEnabledByDefault=false`，网关允许读取和
本地登录/TOTP 生命周期；其余非只读 `/api/*` 请求默认返回 `MUTATIONS_DISABLED`。
第一版可在部署时显式设置 `AERA_ADMIN_HEALTH_CHECKS_ENABLED=true`，仅放行
`POST /api/platform/v1/runtime/commands` 这一条健康检查入口；Payload 仍会校验后台登录、
角色能力和 `health_check` 类型，重启、升级、回滚及其他写接口继续被网关拦截。未显式设置时
健康检查入口也保持关闭。

`adminSchema=1` 表示当前独立 Admin 代码系的第一个候选数据库兼容代际，不把
Payload 自动生成的 SQLite 表数量伪装为人工 migration 编号。候选绑定 Cloud
Internal Admin API `v1`、Cloud schema `17..23` 和一个精确 Cloud source SHA。

## 生成签名候选

先把确定版本合入 `main`，等待精确 SHA 的 `CI` 工作流中 `quality` 与
`browser` 两个 job 都成功。随后确认同一批次的 Cloud 签名候选已经生成并独立
验证，再从 Admin `main` 手动运行 `Admin candidate`，填写：

- `source_sha`：Admin `main` 精确 SHA；
- `ci_run_id`：上述 SHA 的成功 Admin CI run；
- `cloud_source_sha`：已验证 Cloud 候选的精确 source SHA。

工作流重新运行交付合同、应用测试、类型检查和构建，构建一次 linux/amd64
镜像，以 GitHub OIDC 对镜像、SLSA v1 provenance 和 canonical manifest
签名，并上传 `admin-candidate-<source_sha>`。候选不得使用 tag 或本地重建镜像
替代 digest。

下载证据后，在干净的对应 SHA worktree 中设置精确 SHA 和证书身份，再执行：

```bash
export AERA_RELEASE_EXPECTED_SHA='<admin-source-sha>'
export AERA_RELEASE_EXPECTED_CLOUD_SHA='<cloud-source-sha>'
export AERA_RELEASE_CERTIFICATE_IDENTITY_REGEXP='^https://github\.com/bignormal/aera-admin/\.github/workflows/candidate\.yml@refs/heads/main$'
export AERA_RELEASE_CERTIFICATE_OIDC_ISSUER='https://token.actions.githubusercontent.com'
scripts/release/verify-manifest.sh /protected/admin-candidate/manifest.json
```

只有命令校验镜像签名、attestation、manifest 签名、SBOM/provenance digest、Admin
SHA 和 Cloud SHA 全部通过，候选才可部署。

## 主机前置条件

以下路径只描述权限和结构，不提交或打印真实值：

- owner-only Admin 环境文件，包含 `PAYLOAD_SECRET`、API 上游配置、Cloud JWT
  issuer/subject/scopes；
- owner-only PKI 目录，文件名固定为 `ca.pem`、`client.pem`、
  `client-key.pem`、`service-key.pem`；
- 已由 Cloud 栈创建的外部私有 Docker 网络
  `aera-cloud-admin-private`，Admin Payload 与 Cloud 8443 监听器只通过该网络互通；
- `/var/lib/aera/internal-beta/admin`，由部署脚本以 `0700/0600` 记录候选和状态；
- Docker Compose v2、`cosign`、`jq`、`curl`、`ss`；
- 能拉取私有 GHCR digest 的只读登录。

PKI 目录只读挂入 Payload。SQLite 和媒体分别使用命名卷；镜像根文件系统只读，
只有 `/data`、媒体卷、Next cache 和临时目录可写。

## 部署与回滚

在主机上的干净 Admin source SHA 中执行：

```bash
export AERA_ADMIN_ENV_FILE='/etc/aera/internal-beta/admin.env'
export AERA_ADMIN_PKI_DIR='/etc/aera/internal-beta/admin-pki'
export AERA_ADMIN_PRIVATE_PORT='19090'
export AERA_INTERNAL_BETA_ADMIN_EXPECTED_SHA='<admin-source-sha>'
export AERA_INTERNAL_BETA_ADMIN_EXPECTED_CLOUD_SHA='<cloud-source-sha>'
export AERA_INTERNAL_BETA_PUBLIC_ORIGIN='https://<internal-beta-ip>'
deploy/internal-beta/deploy.sh deploy /protected/admin-candidate/manifest.json
```

要启用第一版桌面健康检查，在部署同一已验证候选时额外设置：

```bash
export AERA_ADMIN_HEALTH_CHECKS_ENABLED=true
deploy/internal-beta/deploy.sh deploy /protected/admin-candidate/manifest.json
```

部署 smoke 会确认普通写接口仍返回 `MUTATIONS_DISABLED`，而健康检查入口已到达
Payload 的登录鉴权层；没有管理员会话时应返回 401/403。回滚或未设置该变量时，健康检查
入口自动恢复为关闭状态。

部署脚本先重新验证候选，按 digest 拉取同一镜像，启动 Payload 和回环网关，再
检查 Soybean、同源 API、默认写禁用，并从 Payload 容器使用真实 mTLS 客户端
证书和 Ed25519 服务 JWT 请求 Cloud 的 `/internal/admin/v1/health`。随后检查
端口绑定和公开 Cloud origin 不存在 `/admin/`。任何 Cloud 私网、TLS、JWT 或
暴露面检查失败时，只允许恢复已经记录并重新验证过的前一 digest。

回滚不接收任意 tag、镜像或 manifest：

```bash
deploy/internal-beta/deploy.sh rollback
```

## 访问与验收

测试人员在本地建立隧道：

```bash
ssh -N -L 19090:127.0.0.1:19090 aera-deploy@<internal-beta-host>
```

然后只访问 `http://127.0.0.1:19090/admin/`。健康检查为
`/health/live`、`/health/ready`；未登录 `/api/admins/me` 返回 200 或 401
都能证明 Payload 路由存活。公开 Cloud HTTPS origin 的 `/admin/` 必须是 404。

每次切换前备份 SQLite（包含 WAL 一致性）和媒体卷，记录 Admin/Cloud SHA、
候选 run URL、manifest hash、image digest、主机健康结果和回滚 digest。候选
生成、签名验证、部署、联调与真实浏览器验收是独立状态，不能互相代替。
