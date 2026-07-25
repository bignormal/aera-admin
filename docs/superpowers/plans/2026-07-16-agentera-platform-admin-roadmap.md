# AgentEra 平台总后台实施路线图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按最简单、可回滚的顺序，把 AgentEra 四个仓库的真实管理能力统一到 Soybean 正式后台，同时保留每个后端的数据所有权。

**Architecture:** Soybean 只连接同源 Payload；Payload 负责管理员 Cookie、固定 capability、内容集合、审计、受控 BFF 和 Runtime 控制协议；`agentera-claw-api` 继续拥有已完成的大模型充值站及其用户、支付、订单、渠道和运维数据；Runtime/Studio 仅在用户显式启用后向平台主动注册、心跳和拉取命令。

**Tech Stack:** Payload 3、Next.js 16、SQLite、Vue 3、Soybean Admin、Naive UI、TypeScript、Vitest、Playwright、Go、Gin、Ent、PostgreSQL、Python 3.11+。

## Global Constraints

- 正式平台管理前端只有 Soybean；Payload 原生 Admin 只保留为内部应急入口。
- `agentera-claw-api` 的大模型充值网站已经完成。本计划不重做用户充值前台、不替换支付流程、不复制订单或支付表。
- 浏览器只持有 Payload HttpOnly Cookie；`AGENTERA_API_ADMIN_KEY` 只能存在于 Payload 服务端。
- Payload 自有内容继续走标准 REST；外部业务通过 allowlist BFF 操作调用，不实现任意路径反向代理。
- Runtime/Studio 控制客户端默认关闭，必须由用户显式启用；不上传聊天、记忆、文件、提示词、回复、补丁、终端或原始凭证。
- 不采用 iframe、微前端、GraphQL 聚合、第一版消息队列、动态 RBAC、共享数据库或跨服务外键。
- 每阶段只有真实接口、权限、错误态、测试和构建全部通过后才把菜单加入正式导航。
- 测试不得连接生产支付服务，不得修改真实用户、订单、实例和管理密钥。

---

## 阶段文档与交付门

| 顺序 | 实施计划                                              | 真实数据源                        | 交付门                                                               |
| ---- | ----------------------------------------------------- | --------------------------------- | -------------------------------------------------------------------- |
| 1    | `2026-07-16-agentera-admin-foundation-content.md`     | Payload                           | Soybean 可完成管理员、智能体、分类、技能、媒体、插件、宠物和发布管理 |
| 2    | `2026-07-16-agentera-admin-api-core.md`               | `agentera-claw-api`               | 用户与 AI 资源可真实管理，服务端完成脱敏与 capability 校验           |
| 3    | `2026-07-16-agentera-admin-commerce-ops.md`           | `agentera-claw-api`               | 已完成充值站背后的商业、营销、运维能力统一进入 Soybean               |
| 4    | `2026-07-16-agentera-runtime-control-plane.md`        | Payload + Runtime/Studio 本地数据 | 显式启用的 NAT 后实例可注册、心跳并安全执行最小命令                  |
| 5    | `2026-07-16-agentera-platform-tenants-aggregation.md` | API + Payload 聚合                | 租户、审核、实例、套餐、用量和异常可按稳定外部 ID 关联               |
| 6    | `2026-07-16-agentera-admin-hardening-cutover.md`      | 全部                              | 高风险重认证、审计完整性、生产同源路由和旧演示页面清理完成           |

任何阶段失败时停止进入下一阶段；已上线的前一阶段保持可用，不以半成品菜单代替验收。

## 跨阶段固定契约

### 管理员角色

```ts
export const adminRoles = [
  'super_admin',
  'operations_admin',
  'publisher',
  'finance_admin',
  'auditor',
] as const

export type AdminRole = (typeof adminRoles)[number]
```

### BFF 响应

```ts
export type PlatformSuccess<T, M extends Record<string, unknown> = Record<string, never>> = {
  data: T
  meta: M
  requestId: string
}

export type PlatformFailure = {
  error: { code: string; message: string }
  requestId: string
}
```

### Runtime 命令状态

```ts
export const runtimeCommandStates = [
  'queued',
  'claimed',
  'running',
  'succeeded',
  'failed',
  'expired',
] as const
```

### 环境边界

```dotenv
AGENTERA_API_URL=http://127.0.0.1:8080/api/v1
```

`AGENTERA_API_ADMIN_KEY` 由部署环境的秘密存储注入，不在示例文件中设置值，也不得写入任何已跟踪 `.env`、Soybean 环境变量、浏览器响应、日志或错误详情。

## 分支与提交策略

- 在当前 `personal-dev` 之上执行，每个阶段开始前确认工作树，不覆盖用户已有修改。
- 每个任务按“失败测试、最小实现、通过测试、提交”闭环；提交前只暂存该任务文件。
- 涉及多个仓库时分别提交，不创建跨仓库伪原子提交。
- Runtime/Studio 现有发布与下载工作若占用同一文件，使用各自独立 worktree，控制平面不得顺手修改发布来源。

## 总体验证顺序

- [ ] **Step 1: 完成 Payload 与 Soybean 全量验证**

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-admin'
pnpm run generate:types
pnpm run test:int
pnpm run test:admin
pnpm --dir admin-web typecheck
pnpm --dir admin-web lint
pnpm run build
pnpm run build:admin
pnpm run test:e2e:admin
```

Expected: 所有命令退出码为 0；E2E 使用隔离数据库且浏览器请求中没有 API 管理密钥。

- [ ] **Step 2: 完成业务 API 验证**

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-claw-api'
make -C backend generate
make test-backend
make test-frontend
make build
```

Expected: Ent 生成文件无未提交漂移，Go 测试、lint、现有充值站关键测试和前后端构建全部通过。

- [ ] **Step 3: 完成 Runtime 验证**

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-claw-runtime'
scripts/run_tests.sh tests/hermes_cli/test_platform_control.py
scripts/run_tests.sh tests
```

Expected: 控制客户端专项测试和 Runtime 测试套件通过；未配置时不产生任何平台网络请求。

- [ ] **Step 4: 完成 Studio 验证**

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/hermes-studio'
npm run test -- tests/server/platform-control-client.test.ts
npm run harness
npm run build
```

Expected: 显式启用、秘密存储、心跳和命令测试通过；harness 与生产构建通过。

- [ ] **Step 5: 执行跨系统冒烟并记录证据**

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-admin'
pnpm run test:e2e:admin
git diff --check
rg -n "AGENTERA_API_ADMIN_KEY|deviceSecret" admin-web dist .next --glob '!**/*.map'
```

Expected: E2E 通过、`git diff --check` 无输出、产物扫描不包含管理密钥值或设备密钥字段响应。

- [ ] **Step 6: 提交总体验收记录**

Create `docs/superpowers/verification/2026-07-16-agentera-platform-admin-verification.md` with this exact heading structure:

```md
# AgentEra 平台总后台验收记录

## 仓库提交

## 自动化验证

## 浏览器验证

## 安全边界验证

## 已知但不阻塞的问题

## 回滚点
```

Run:

```bash
git add docs/superpowers/verification/2026-07-16-agentera-platform-admin-verification.md
git commit -m "docs: record platform admin verification"
```

Expected: 验收记录只引用真实命令输出和实际提交 SHA，不把计划项当成完成证据。
