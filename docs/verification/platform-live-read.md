# AgentEra 平台真实读取验证

验证日期：2026-07-16（Asia/Shanghai）

## 结论

Phase 1 真实读取链路已通过本地验收：Soybean 管理页经 Payload 鉴权与 BFF，读取真实 AgentEra API 数据。13 个计划资源域全部就绪，浏览器验收覆盖 8 个正式页面，期间只发送 `GET` 请求，没有拦截平台 API，也没有执行 mutation。

本结论只覆盖真实读取，不代表平台后台全部后端功能已经完成。普通写操作、高风险二次认证、审计完整性与生产容量验证仍属于后续阶段。

## 验证对象

- 管理后台读取功能 SHA：`1bd382834029f0dfd537f9c7c7fc94447bb1eb30`
- 本次验收脚本与废弃入口清理：见本文件所在提交
- AgentEra API SHA：`b5f712d79960c5160bef9911c5ae9ff98af36518`
- Soybean：`http://127.0.0.1:9527/admin/`
- Payload：`http://127.0.0.1:3100`
- AgentEra API：`http://127.0.0.1:8080`

账号、密码和 API 管理密钥均通过运行时环境注入，没有写入代码、测试或本记录。

## 验证结果

| 门禁                              | 结果                                 |
| --------------------------------- | ------------------------------------ |
| `pnpm run test:int`               | 23 个文件、90 个测试通过             |
| `pnpm --dir admin-web test`       | 22 个文件、75 个测试通过             |
| `pnpm --dir admin-web typecheck`  | 通过                                 |
| `pnpm --dir admin-web build`      | 通过                                 |
| `pnpm run test:live:platform`     | 1 个文件、13 个真实 API 契约测试通过 |
| `pnpm run test:e2e:live:platform` | 1 个无 fixture 浏览器测试通过        |

真实 API 契约测试使用 `AGENTERA_API_URL` 和 `AGENTERA_API_ADMIN_KEY`。浏览器测试使用 `AGENTERA_ADMIN_LIVE_URL`、`AGENTERA_ADMIN_LIVE_EMAIL` 和 `AGENTERA_ADMIN_LIVE_PASSWORD`。完整命令见运维手册，不在文档中保存真实值。

## 资源域就绪度

首页由超级管理员主动点击“验证真实资源”后检查以下域；全部返回“健康”：

| 资源域   | 状态 |
| -------- | ---- |
| 平台用户 | 健康 |
| AI 账号  | 健康 |
| 资源分组 | 健康 |
| 代理资源 | 健康 |
| 模型渠道 | 健康 |
| 商业总览 | 健康 |
| 支付订单 | 健康 |
| 订阅     | 健康 |
| 运营总览 | 健康 |
| 告警事件 | 健康 |
| 风险状态 | 健康 |
| 用量日志 | 健康 |
| 系统版本 | 健康 |

浏览器进一步打开并检查了平台用户、上游账号、模型分组、订单中心、运营总览、风控中心、系统设置、数据与备份 8 个正式页面。测试记录 `/api/platform/v1/*` 请求并断言全部方法为 `GET`。

## 明确排除项

AgentEra API 的 `dataBackupJobs`（数据管理代理任务）端点已废弃，真实请求返回 HTTP `503`、业务码 `503`，消息为 `data management feature is deprecated`。该端点不属于 13 个就绪域，Soybean 中对应“数据代理任务”页签已移除；仍可用的“平台备份”保留并通过真实页面验收。
