# AgentEra 平台后台运维手册

## 边界

- 正式平台管理员界面只有 Soybean：公开地址为 `/admin/`。
- Payload 负责管理员鉴权、正式集合、审计、BFF 和 Runtime 控制协议，只监听回环或内网端口。
- `agentera-claw-api` 继续持有用户、模型渠道、套餐、订单、支付和用量；充值站独立发布、独立健康检查。
- 平台业务资源开放真实读写治理链路；高危操作统一要求 TOTP StepUp 或双人复核，不允许绕过 Payload BFF 直连上游。

## 必需配置

生产环境通过密钥管理系统注入以下变量，不提交真实值：

- `DATABASE_URL`：Payload SQLite 路径或受支持数据库连接。
- `PAYLOAD_SECRET`：长随机值；轮换会使已有登录失效。
- `NEXT_PUBLIC_SERVER_URL`：平台后台公开同源地址。
- `ADMIN_WEB_URL`：与公开 Soybean 地址同源，用于 CSRF 允许列表。
- `AGENTERA_API_URL`：充值/API 服务的内部地址。
- `AGENTERA_API_ADMIN_KEY`：API 管理密钥，仅存在于 Payload 服务端。
- `AGENTERA_API_TIMEOUT_MS`：上游请求超时，建议从 `10000` 开始。

## 首次启动与发布

1. 备份数据库和当前服务制品。
2. 执行 `pnpm install --frozen-lockfile` 与 `pnpm run build:platform`。
3. 把 `admin-web/dist/` 同步到 `/srv/agentera-admin/public/admin/`，使用新目录后原子切换软链接。
4. 启动 Payload 于 `127.0.0.1:3100`，再执行 `nginx -t` 和平滑重载。
5. 首位管理员只通过 SSH 端口转发访问内部 Payload 地址创建，随后使用公开 Soybean 登录。不要临时把原生 Payload Admin 暴露到公网。

## 健康与验收

```bash
curl -fsS https://admin.example.com/admin/ >/dev/null
curl -sS -o /dev/null -w '%{http_code}\n' https://admin.example.com/api/admins/me
```

第一条应为 200；第二条未登录时应为 401，说明同源 API 路由存活。登录后检查：

- 首页明确显示 AgentEra API 已连接或“未配置/不可用”，不伪造零值。
- 超级管理员主动点击“验证真实资源”，确认 13 个计划资源域全部健康；该检查不会返回业务记录，也不会自动随页面加载执行。
- 用户、AI 资源、套餐、订单、运营和系统页能读取现有充值/API 数据，并按角色 capability 展示允许的写操作。
- 安全中心可展示当前管理员 TOTP/StepUp 状态；超级管理员可在管理员列表重置他人 TOTP。
- 创建一次性 Runtime 注册码后，由客户端主动向平台注册和心跳；设备无需开放入站端口。
- 浏览器存储、网络响应和审计中不出现 API 管理密钥、设备明文密钥、提示词或对话正文。
- 充值站的注册、登录、支付回调和查询接口继续通过其独立探针。

### 真实读取验收

从密钥管理系统注入运行时变量，不要把值写进命令历史、`.env` 或仓库：

```bash
test -n "$AGENTERA_API_URL"
test -n "$AGENTERA_API_ADMIN_KEY"
pnpm run test:live:platform

test -n "$AGENTERA_ADMIN_LIVE_URL"
test -n "$AGENTERA_ADMIN_LIVE_EMAIL"
test -n "$AGENTERA_ADMIN_LIVE_PASSWORD"
pnpm run test:e2e:live:platform
```

第一套测试直接验证 13 个 AgentEra API 真实读取契约；第二套测试登录 Soybean，经 Payload 打开正式页面，并断言平台请求全部为 `GET`。两套测试都不执行写操作，也不允许用 fixture 结果代替真实服务。

`dataBackupJobs` 数据管理代理任务已被 AgentEra API 废弃，返回 HTTP 503，因此不列入就绪域，Soybean 也不再提供该入口。平台备份仍保留。最近一次实测证据见 `docs/verification/platform-live-read.md`。

## 模块能力清单

- 安全中心：当前管理员账号安全、TOTP 自助绑定/验证、StepUp 窗口状态、管理员 TOTP 重置与密码重置。
- 首页：业务收入、云用户/设备、运营总览、吞吐/错误/延迟图表与真实资源就绪度。
- 用户与分组：平台用户批量并发、替换分组、用户属性定义、分组统计、倍率和 RPM 覆盖。
- AI 资源：账号统计、今日统计、模型同步、定时测试结果、恢复状态、清限速、重置额度。
- 营销与商业：订单退款/退款查询、兑换码统计/导出、优惠码使用记录、联盟邀请/返利/转账只读列表。
- 运营与系统：实时并发/流量/账号可用性快照、系统更新/回滚/重启、Admin Key 再生成/删除、备份计划和备份恢复。
- 云端与官方 Agent：云用户设备平台/版本分布、云命令 `operation_id` 查询、官方 Agent 审计事件、草稿/审核/发布/回滚双人复核。

## 备份、轮换与故障处理

- SQLite 使用 WAL 时优先用 `sqlite3 "$DB" '.backup backup.db'` 或停服后复制主库、`-wal`、`-shm` 三个文件。
- 数据迁移前必须完成可恢复备份；后台备份恢复入口仅限具备 `system:backup:restore` capability 且通过 TOTP StepUp 的管理员使用。
- 轮换 API 管理密钥时先在 API 创建新密钥，再更新 Payload 环境并验证，最后撤销旧密钥。
- 轮换 `PAYLOAD_SECRET` 前通知管理员重新登录，并保留旧服务制品以便回滚。
- 上游操作超时按“结果未知”处理，先查询业务状态，不自动重复支付、退款或履约操作。

## 回滚

1. 停止新 Payload 实例，保留日志和请求 ID。
2. 将静态目录软链接切回上一版 Soybean 制品。
3. 若包含数据库迁移，按迁移说明确认兼容性；不兼容时停服并恢复发布前备份。
4. 启动上一版 Payload，执行健康与登录检查。
5. 单独验证充值站和支付回调；后台回滚不得切换或覆盖充值站制品。

每次发布记录代码 SHA、数据库备份位置、验证结果和回滚点。未实际部署时不得把本地验证记为生产切换完成。

公司内部 Beta 的签名候选、私有回环部署、公开暴露面检查和按 digest 回滚使用
`docs/operations/internal-beta-delivery.md`；不得把本节的公网 Nginx 示例直接
用于内部 Beta，也不得把本地 `pnpm run build:platform` 当成签名候选。

## aera-cloud 内部管理上游（云用户 / 官方 Agent）

后台通过 Payload BFF 的 `/api/cloud/v1/:operation` 调用 aera-cloud 的 `/internal/admin/v1/*`：

- 传输层：mTLS（TLS 1.3，双向证书）；应用层：Ed25519 服务 JWT（`aud=aera-cloud-admin`，5 分钟寿命）。
- 官方 Agent 变更由 BFF 生成 `operation_id` 并包装 `officialMutationEnvelope`，`Idempotency-Key` 与 `operation_id` 一致；审计事件通过官方 Agent 工作台只读查询。
- 云用户命令（撤销设备/会话、禁用/启用、强制重置密码）由 BFF 包装 `admin.Command`；`expected_revision` 取用户详情的 `administrative_revision`，命令提交后可用 `operation_id` 查询状态。

### 本地接线

1. 在 agentera-admin 根执行 `scripts/dev-pki.sh`，生成 `deploy/dev-pki/`（已 gitignore，含私钥，勿提交）。
2. 按脚本输出配置 agentera-admin 的 `.env`（`AGENTERA_CLOUD_ADMIN_*` 全套，含 `_SCOPES` JSON 数组）。
3. 以 `AGENTERA_CLOUD_INTERNAL_ADMIN_*` 环境变量启动 aera-cloud（监听 `127.0.0.1:18443`，另需 `_HMAC_ACTIVE_KEY_ID` / `_HMAC_KEYS`，见 `aera-cloud/cmd/aera-cloud/internal_admin.go`）。
4. 校验：登录后台后打开总览页，`aeraCloud` 探针应为 `healthy`（`/api/platform/v1/status`）。

### 高危操作与 TOTP StepUp

- `resetCloudUserPassword`、`rollbackOfficialRelease` 以及 aera-api 侧标记 `requiresReauthentication` 的操作，要求 5 分钟内完成过 TOTP 二次验证，否则返回 `428 STEP_UP_REQUIRED`（未绑定时 `TOTP_NOT_ENROLLED`）。
- 绑定与验证端点：`POST /api/security/totp/enroll` → `POST /api/security/totp/confirm` → `POST /api/security/step-up`；前端弹窗会自动引导。
- TOTP 秘钥用 `PAYLOAD_SECRET` 派生密钥 AES-256-GCM 加密存储；轮换 `PAYLOAD_SECRET` 会使已绑定的 TOTP 失效，需要管理员重新绑定。

### 官方 Agent 回滚双人复核

1. 发起人在「发布中心 → 官方 Agent 工作台 → 发布」点击“发起回滚”，创建审批记录（requested）。
2. 另一名有 `official-agents:release:write` 的管理员在「回滚审批」页批准或拒绝（不能自批）。
3. 批准人执行回滚（需 StepUp）；BFF 以 `approval_id` + `requester_admin_id` 声明调用云端，云端强制执行人 ≠ 发起人。
4. 执行成功后审批记录标记 executed 并记录云端 `operation_id`；全过程写入本地审计日志。

### 联调已知事项（2026-07 本地验证结论）

- 云端对官方 Agent 变更强制职责分离（`internal/admin/control_model.go` 的 `officialRoleAllowed`）：草稿类动作要求 `developer`、审核与回滚要求 `super_admin`、发布操作要求 `operator`。BFF 按操作注册表的 `dutyRole` 签发对应角色声明，本地 capability 才是真正的授权门。
- aera-cloud 迁移 `000020_admin_operations_missing_actions.sql` 修复了 `admin_operations` CHECK 约束缺少 `force_password_reset` / `revoke_all_sessions` 的问题（此前这两类命令一律 503）。部署新环境前确认该迁移已应用。
- dev CA 必须携带 `basicConstraints=CA:TRUE` 与 `keyUsage=keyCertSign`（`scripts/dev-pki.sh` 已内置），否则云端 `LoadTLSConfig` 会以 "internal admin client CA is invalid" 拒绝启动。
- 本地一键启动 aera-cloud（含内部管理监听与官方 Agent 面）：`aera-cloud/.tmp-internal-admin-dev.sh`。
