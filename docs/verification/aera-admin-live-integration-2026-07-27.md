# Aera Admin 真实上游联调记录（2026-07-27）

## 边界与版本

- Admin 实现提交：`574bc1d9cd385ae4290e345d88adeef20bb1fc88`
- Aera API 本地服务进程：`b5f712d79960c5160bef9911c5ae9ff98af36518`
- Aera API 当前审计分支：`b7b311e5c18341d41869f12f80840feb3b41dc23`
- Aera Cloud：`0d6bf281268bd093c5c9b8874b4866453be953b5`

本次只执行 GET/health 类联调，没有执行用户、设备、会话、支付或官方
Agent mutation。管理密钥、JWT 私钥、mTLS 私钥和数据库凭据均通过本地
环境注入，没有写入 Git、测试输出或本文。

## Aera API

先恢复已存在但停止的本地 Postgres 与 Redis 开发容器，确认二者
`healthy` 后，再通过 Admin 的 `requestUpstream` 对真实 8080 服务执行
13 个只读资源域契约：

```text
tests/live/platform-read.live.spec.ts
Test Files  1 passed (1)
Tests       13 passed (13)
```

覆盖用户、上游账号、模型分组、代理、渠道、计费、订单、订阅、运营、
告警、风控、用量与系统设置。所有响应均满足真实成功信封和预期数据形状。

本地 8080 进程是在 API checkout 仍为 `b5f712d...` 时启动的。尝试从当前
`b7b311e...` 重新编译 18080 临时实例时，`proxy.golang.org` 的 IPv6
连接超时，未形成新监听，因此没有把该尝试记为当前 SHA 的本地运行证明。
当前 API SHA 的代码、依赖与安全结论由以下远端工作流覆盖：

- CI：`30213310757`，success
- Security Scan：`30213310746`，success

## Aera Cloud

Admin 使用当前 `aera-admin/deploy/dev-pki` 中的开发证书连接
`https://127.0.0.1:18443`。证书与私钥文件权限为 `0600`，Cloud 使用
mTLS 与 Ed25519 服务 JWT 双重验证。

```text
tests/live/cloud-admin.live.spec.ts
Test Files  1 passed (1)
Tests       3 passed (3)
```

三项证明分别是：

1. `/internal/admin/v1/health` 通过 mTLS 与服务 JWT，并返回 healthy；
2. `/internal/admin/v1/stats` 返回真实、非负且不含个人信息的计数；
3. `/internal/admin/v1/official-agent-definitions` 以绑定管理员声明的 JWT
   返回真实平台官方 Agent 列表，未执行 mutation。

## Admin 本地质量门禁

```text
Payload lint                         passed
Payload integration                 121 passed, 1 existing skip
Payload production build            passed
Admin Web typecheck                 passed
Admin Web unit tests                85 passed
Admin Web production build          passed
Payload Playwright                  11 passed
Soybean Playwright full run         14 passed, 1 strict-locator failure
Soybean repaired-test rerun         1 passed
```

Soybean 的最后一处失败是两个上游同时“未配置”后，旧断言仍要求单一元素。
断言已改为明确要求两个 fail-closed 状态；根级 GitHub CI 将对最终提交重新
执行完整 15 用例，远端工作流终态才作为完整套件的最终证明。

## CI 与非结论

根目录新增 `.github/workflows/ci.yml`，包含：

- Payload lint、集成测试与生产构建；
- Admin Web typecheck、单测与生产构建；
- Payload 与 Soybean 两套 Chrome Playwright。

真实上游测试不会在缺少专用凭据与隔离环境的公共 runner 上伪运行。本记录
只证明本地真实 API/Cloud 联调和分支质量门禁；不代表 Admin 已部署到生产。
