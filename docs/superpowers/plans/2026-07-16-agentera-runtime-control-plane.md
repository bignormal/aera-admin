# AgentEra Runtime 与 Studio 控制平面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户显式授权的 Runtime/Studio 实例在不开放公网端口的情况下，主动向 Payload 注册、发送脱敏心跳并领取最小管理命令，平台管理员在 Soybean 查看和操作这些实例。

**Architecture:** Payload 保存 Runtime 实例、发布、命令和脱敏事件；管理员先创建一次性注册码，设备主动调用 `/api/control/v1/enroll` 换取只返回一次的设备密钥。客户端按 60 秒轮询 heartbeat，响应中领取与自身 capability 匹配的命令，再提交结果。Runtime 与 Studio 控制客户端均默认关闭，使用本地 0600 文件保存设备身份，不侵入 Agent 主循环。

**Tech Stack:** Payload 3、TypeScript、Vue 3、Python 3.11+ 标准库、Runtime 现有 gateway、Studio Koa/TypeScript、Vitest、Playwright。

## Global Constraints

- 用户必须在设备上显式 enroll/enable；没有配置时不创建后台任务、不进行 DNS 查询、不发送任何平台网络请求。
- 心跳只含版本、系统、架构、启动时间、能力、数量、Token/费用/错误聚合和渠道配置状态。
- 禁止上传聊天、消息、记忆、文件、工作区、提示词、回复、补丁、终端、环境变量、原始日志、Profile 原文或原始凭证。
- 设备密钥和注册码只返回/输入一次；Payload 只存 SHA-256 哈希，设备以 0600 文件保存明文。
- 第一条可执行远程命令仅为 `health_check`；版本升级、回滚、重启、任务与 Cron 命令只有在客户端后续真实实现并声明 capability 后才可创建。不要预先拼接 shell 字符串。
- HTTPS 轮询是 V1 唯一通道；不引入 WebSocket、消息队列、反向隧道或公网入站监听。
- Runtime 使用 `get_hermes_home()` 和 profile 隔离；非秘密配置进 `config.yaml`，秘密不进入 YAML 或新非秘密环境变量。
- Studio 状态只写 `config.appHome`；不混用 Hermes profile 存储。

---

## 控制协议固定形状

```ts
export type EnrollRequest = {
  enrollmentCode: string
  instanceType: 'runtime' | 'studio' | 'desktop'
  deviceId: string
  version: string
  os: string
  arch: string
  capabilities: string[]
}

export type HeartbeatRequest = {
  version: string
  os: string
  arch: string
  uptimeSeconds: number
  capabilities: string[]
  metrics: Record<string, number>
  channels: Array<{ type: string; configured: boolean; healthy?: boolean; errorCode?: string }>
  resources: {
    tasks: Array<{
      id: string
      status: string
      source: string
      model?: string
      tokens?: number
      cost?: number
      errorCode?: string
    }>
    workflows: Array<{
      id: string
      status: string
      version?: string
      nodeCount?: number
      failedNode?: string
    }>
    cron: Array<{ id: string; status: string; nextRunAt?: string; lastResult?: string }>
    codingAgents: Array<{
      id: string
      type: string
      status: string
      durationMs?: number
      changeCount?: number
      workspaceHash?: string
    }>
    devices: Array<{ id: string; type: string; status: string; lastSeenAt?: string }>
  }
}

export type RuntimeCommandType = 'health_check'
```

The first client capability is `diagnostics.health.read`. Unsupported commands are never queued for the instance.

### Task 1: 建立 Payload Runtime 集合和状态机

**Files:**

- Create: `src/collections/RuntimeInstances.ts`
- Create: `src/collections/RuntimeReleases.ts`
- Create: `src/collections/RuntimeCommands.ts`
- Create: `src/collections/RuntimeEvents.ts`
- Create: `src/domain/runtime-control.ts`
- Create: `tests/int/runtime-control-state.int.spec.ts`
- Modify: `src/payload.config.ts`

**Interfaces:**

- `runtime-instances`: type, name, tenantId, status, deviceIdHash, deviceSecretHash, enrollmentCodeHash, enrollmentExpiresAt, version, os, arch, capabilities, lastHeartbeatAt, healthSummary.
- `runtime-releases`: product, version, channel, minimumVersion, artifactURL, checksum, publishedAt, status.
- `runtime-commands`: instance, type, requiredCapability, idempotencyKey, state, expiresAt, claimedAt, startedAt, completedAt, resultCode, resultSummary, createdBy.
- `runtime-events`: instance, kind, severity, code, summary, occurredAt, expiresAt.

- [ ] **Step 1: 写合法迁移与状态机失败测试**

Assert these transitions:

```ts
expect(canTransitionCommand('queued', 'claimed')).toBe(true)
expect(canTransitionCommand('claimed', 'running')).toBe(true)
expect(canTransitionCommand('running', 'succeeded')).toBe(true)
expect(canTransitionCommand('running', 'failed')).toBe(true)
expect(canTransitionCommand('queued', 'expired')).toBe(true)
expect(canTransitionCommand('succeeded', 'running')).toBe(false)
expect(canTransitionCommand('queued', 'succeeded')).toBe(false)
```

Also assert duplicate `instance + idempotencyKey` fails and non-system REST clients cannot write device hashes or command state.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/runtime-control-state.int.spec.ts`.

Expected: FAIL because collections and state machine are absent.

- [ ] **Step 2: 实现集合和纯状态机**

Create this public boundary in `src/domain/runtime-control.ts`:

```ts
export const runtimeCommandStates = [
  'queued',
  'claimed',
  'running',
  'succeeded',
  'failed',
  'expired',
] as const
export type RuntimeCommandState = (typeof runtimeCommandStates)[number]

const allowedTransitions: Record<RuntimeCommandState, readonly RuntimeCommandState[]> = {
  queued: ['claimed', 'expired'],
  claimed: ['running', 'failed', 'expired'],
  running: ['succeeded', 'failed', 'expired'],
  succeeded: [],
  failed: [],
  expired: [],
}

export function canTransitionCommand(from: RuntimeCommandState, to: RuntimeCommandState): boolean {
  return allowedTransitions[from].includes(to)
}

export function hashControlSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}
```

Collection access: administrators with `runtime:read` can read; `runtime:command:create` can create commands through the service endpoint only; direct device hash fields are hidden and protected by hooks.

- [ ] **Step 3: 注册、生成类型、验证并提交**

Run:

```bash
pnpm run generate:types
pnpm vitest run --config ./vitest.config.mts tests/int/runtime-control-state.int.spec.ts
pnpm run test:int
git add src/collections src/domain/runtime-control.ts src/payload.config.ts src/payload-types.ts tests/int/runtime-control-state.int.spec.ts
git commit -m "feat: add runtime control data model"
```

Expected: schema, access and state tests pass.

### Task 2: 实现注册、心跳、命令和结果端点

**Files:**

- Create: `src/endpoints/runtime-control.ts`
- Create: `src/domain/runtime-control-service.ts`
- Create: `tests/int/runtime-control-endpoints.int.spec.ts`
- Modify: `src/payload.config.ts`

**Interfaces:**

- Admin: `POST /api/platform/v1/runtime/enrollments`, `POST /api/platform/v1/runtime/commands`.
- Device: `POST /api/control/v1/enroll`, `POST /api/control/v1/heartbeat`, `POST /api/control/v1/commands/:id/result`.
- Device auth: `Authorization: Bearer <deviceSecret>` plus instance ID header.

- [ ] **Step 1: 写一次性注册和设备鉴权失败测试**

Assert enrollment code expires, can be used once, response contains a device secret once, database never stores plaintext, wrong secret is 401, stale heartbeat marks no other instance, and request/response reject sensitive keys.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/runtime-control-endpoints.int.spec.ts`.

Expected: FAIL because endpoints are absent.

- [ ] **Step 2: 实现安全注册与常量时间鉴权**

Use `randomBytes(32).toString('base64url')` for codes/secrets. Compare hashes with fixed-length buffers and `timingSafeEqual`. The enrollment admin response is:

```ts
{ data: { instanceId: string; enrollmentCode: string; expiresAt: string }, meta: {}, requestId: string }
```

The device enrollment response is:

```ts
{ data: { instanceId: string; deviceSecret: string; heartbeatSeconds: 60 }, meta: {}, requestId: string }
```

Never include `deviceSecret` in later reads.

- [ ] **Step 3: 实现脱敏 heartbeat 与原子命令领取**

Validate the body using strict allowlisted keys and size limits. In one Payload transaction or compare-and-update sequence, expire old commands, select the oldest queued command whose `requiredCapability` is present, and move it to `claimed`. A heartbeat returns at most one command:

```ts
{ data: { acceptedAt: string; nextHeartbeatSeconds: 60; command: RuntimeCommandDTO | null }, meta: {}, requestId: string }
```

Reject result submissions unless the command belongs to the authenticated instance and transition is legal.

- [ ] **Step 4: 验证并提交**

Run:

```bash
pnpm run generate:types
pnpm vitest run --config ./vitest.config.mts tests/int/runtime-control-endpoints.int.spec.ts
pnpm run test:int
git add src/endpoints/runtime-control.ts src/domain/runtime-control-service.ts src/payload.config.ts src/payload-types.ts tests/int/runtime-control-endpoints.int.spec.ts
git commit -m "feat: add outbound runtime control protocol"
```

Expected: enrollment, authentication, redaction, command ownership and idempotency tests pass.

### Task 3: 实现 Runtime 显式注册和最小控制客户端

**Repository:** `/Users/zizimutou/Desktop/agentera claw/agentera-claw-runtime`

**Files:**

- Create: `hermes_cli/platform_control.py`
- Create: `hermes_cli/platform_control_cli.py`
- Create: `hermes_cli/platform_control_summary.py`
- Create: `tests/hermes_cli/test_platform_control.py`
- Modify: `hermes_cli/config.py`
- Modify: `hermes_cli/main.py`
- Modify: `gateway/run.py`

**Interfaces:**

- Non-secret config in `config.yaml`: `platform_control.enabled`, `endpoint`, `heartbeat_seconds`.
- Secret identity at `get_hermes_home() / 'platform-control.json'`, mode 0600.
- CLI: `hermes platform enroll --url URL --code CODE`, `hermes platform status`, `hermes platform disable`.

- [ ] **Step 1: 写默认无外呼、存储权限和心跳失败测试**

Use a temporary `HERMES_HOME` and fake HTTP server. Assert default config creates no request, enroll writes a 0600 identity without retaining enrollment code, heartbeat contains only the allowed schema, each resource array is capped at 100, chat/message/prompt/file/terminal/config values never enter the body, retries use bounded exponential backoff, 401 disables further requests until re-enroll, and shutdown cancels promptly.

Run `scripts/run_tests.sh tests/hermes_cli/test_platform_control.py`.

Expected: FAIL because the module is absent.

- [ ] **Step 2: 增加默认关闭配置**

Add this to `DEFAULT_CONFIG` without a config version bump:

```py
"platform_control": {
    "enabled": False,
    "endpoint": "",
    "heartbeat_seconds": 60,
},
```

The client must read through `load_config()`/`cfg_get`; do not bridge these values into environment variables.

- [ ] **Step 3: 实现标准库客户端与 0600 身份文件**

Expose the following concrete data type; implement `PlatformControlClient.run`,
`PlatformControlClient.heartbeat_once`, `PlatformControlClient.execute`,
`enroll` and `load_identity` in the same module:

```py
@dataclass(frozen=True)
class PlatformIdentity:
    instance_id: str
    device_secret: str
```

Use `urllib.request` through `asyncio.to_thread` so no dependency is added. `platform_control_summary.py` reads existing gateway status, run/job/Cron metadata and configured channel states, returning bounded summaries without content fields; unsupported Studio-only resource arrays are empty. `execute` supports only `health_check`; its result contains gateway state, version and structured counts, never raw log text.

- [ ] **Step 4: 注册 CLI 与 gateway 生命周期**

Add an argparse `platform` command family in `hermes_cli/main.py` that dispatches to `platform_control_cli.platform_command(args)`. In `gateway/run.py`, after `runner.start()` succeeds, create the client task only when enabled and identity exists. Before gateway teardown, set its stop event and await it with a 5-second timeout.

The lifecycle code must follow this shape:

```py
platform_stop = asyncio.Event()
platform_task = start_platform_control_if_enabled(platform_stop)
try:
    await runner.wait_for_shutdown()
finally:
    platform_stop.set()
    if platform_task is not None:
        await asyncio.wait_for(platform_task, timeout=5)
```

- [ ] **Step 5: 验证并提交 Runtime 改动**

Run:

```bash
scripts/run_tests.sh tests/hermes_cli/test_platform_control.py
scripts/run_tests.sh tests/hermes_cli/test_config.py
git diff --check
git add hermes_cli/platform_control.py hermes_cli/platform_control_cli.py hermes_cli/platform_control_summary.py hermes_cli/config.py hermes_cli/main.py gateway/run.py tests/hermes_cli/test_platform_control.py
git commit -m "feat: add opt-in platform control client"
```

Expected: default-no-network, enrollment, heartbeat, health command and shutdown tests pass.

### Task 4: 实现 Studio 显式注册和最小控制客户端

**Repository:** `/Users/zizimutou/Desktop/agentera claw/hermes-studio`

**Files:**

- Create: `packages/server/src/services/platform-control-client.ts`
- Create: `packages/server/src/services/platform-control-settings.ts`
- Create: `packages/server/src/services/platform-control-summary.ts`
- Create: `packages/server/src/controllers/platform-control.ts`
- Create: `packages/server/src/routes/platform-control.ts`
- Create: `tests/server/platform-control-client.test.ts`
- Create: `tests/server/platform-control-routes.test.ts`
- Modify: `packages/server/src/routes/index.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `packages/server/src/services/shutdown.ts`

**Interfaces:**

- Local authenticated routes: `GET /api/platform-control`, `POST /api/platform-control/enroll`, `POST /api/platform-control/disable`.
- Settings/identity file: `resolve(config.appHome, 'platform-control.json')`, atomic write then chmod 0600.
- Remote capability: `diagnostics.health.read` only.

- [ ] **Step 1: 写显式 opt-in、0600 和 local-auth 失败测试**

Assert startup without a settings file creates no request, enroll requires the existing Studio user JWT middleware, invalid URL is rejected, the enrollment code is not stored, the file is mode 0600 on POSIX, heartbeat contains only bounded task/workflow/Cron/Coding Agent/device/channel metadata, content and workspace paths are absent, and shutdown aborts in-flight fetch.

Run `npm run test -- tests/server/platform-control-client.test.ts tests/server/platform-control-routes.test.ts`.

Expected: FAIL because files are absent.

- [ ] **Step 2: 实现 settings 与客户端**

Use this persisted type:

```ts
export type PlatformControlSettings = {
  enabled: boolean
  endpoint: string
  instanceId: string
  deviceSecret: string
  heartbeatSeconds: number
}
```

Write through `safeFileStore.writeText`, immediately call `chmod(path, 0o600)`, and redact `deviceSecret` from `GET /api/platform-control`. The client uses native fetch and `AbortController`; `platform-control-summary.ts` gathers APP_VERSION, OS/arch, process uptime plus bounded metadata from existing jobs, workflow-run, coding-agent and device stores. It hashes workspace identifiers locally and never selects conversation/message/file/log columns.

- [ ] **Step 3: 注册本地 route、启动和关闭**

Keep route thin: route -> controller -> settings/client service. After `listenWithFallback` succeeds, call `startPlatformControlClient()`. Add `stopPlatformControlClient()` near the start of the existing shutdown sequence so no heartbeat outlives database/server teardown.

- [ ] **Step 4: 验证并提交 Studio 改动**

Run:

```bash
npm run test -- tests/server/platform-control-client.test.ts tests/server/platform-control-routes.test.ts tests/server/shutdown.test.ts
npm run harness
npm run build
git diff --check
git add packages/server/src tests/server/platform-control-client.test.ts tests/server/platform-control-routes.test.ts
git commit -m "feat: add opt-in studio platform control"
```

Expected: local consent, remote protocol, safe storage, shutdown, harness and build pass.

### Task 5: 在最小协议稳定后增加真实版本与重启命令适配器

**Repositories:**

- `/Users/zizimutou/Desktop/agentera claw/agentera-claw-runtime`
- `/Users/zizimutou/Desktop/agentera claw/hermes-studio`
- `/Users/zizimutou/Desktop/agentera claw/agentera-admin`

**Files:**

- Modify: `hermes_cli/platform_control.py`
- Modify: `gateway/run.py`
- Modify: `tests/hermes_cli/test_platform_control.py`
- Create: `packages/server/src/services/platform-control-version-commands.ts`
- Modify: `packages/server/src/services/platform-control-client.ts`
- Create: `tests/server/platform-control-version-commands.test.ts`
- Modify: `src/domain/runtime-control.ts`
- Modify: `src/domain/runtime-control-service.ts`
- Modify: `tests/int/runtime-control-endpoints.int.spec.ts`

**Interfaces:**

- Runtime advertises `gateway.restart` only when `GatewayRunner.request_restart` callback is wired.
- Studio advertises `runtime.version.upgrade` and `runtime.version.rollback` by reusing `runtime-version-manager.ts`.
- Command types become `health_check | gateway_restart | runtime_upgrade | runtime_rollback`.
- These commands are implemented and testable here, but the admin creation endpoint keeps them high-risk locked until phase 6 reauthentication is present.

- [ ] **Step 1: 写固定参数、幂等和 capability 失败测试**

Assert a Runtime restart calls only the injected restart callback, Studio upgrade calls `startRuntimeVersionDownload` then activates the verified installed version, rollback can target only an already installed version, duplicate command ID returns the cached result, and arbitrary executable/path/URL arguments are rejected.

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-claw-runtime'
scripts/run_tests.sh tests/hermes_cli/test_platform_control.py

cd '/Users/zizimutou/Desktop/agentera claw/hermes-studio'
npm run test -- tests/server/platform-control-version-commands.test.ts
```

Expected: FAIL because only `health_check` is implemented.

- [ ] **Step 2: 实现 Runtime 固定重启回调**

Pass `runner.request_restart` into the control client; `gateway_restart` accepts no free-form command or shell argument. After the callback accepts the restart request, return `{ status: 'succeeded', code: 'RESTART_ACCEPTED' }`. Persist the last 100 command IDs and sanitized results under `get_hermes_home()` with mode 0600 so delivery retries cannot restart twice.

- [ ] **Step 3: 实现 Studio 版本命令适配器**

Use only these existing functions from `packages/server/src/services/runtime-version-manager.ts`:

```ts
startRuntimeVersionDownload(version, source)
getVersionDownloadJob(id)
activateInstalledRuntimeVersion(version)
listInstalledRuntimeVersions()
```

Validate version as a strict semantic version and source as `github | cf`. Upgrade waits for the existing verified download job, then activates; rollback requires the target in `listInstalledRuntimeVersions()`. Store a bounded 100-entry command-result cache at `config.appHome/platform-control-command-cache.json` with mode 0600.

- [ ] **Step 4: 扩展 Payload 类型但保持高风险锁**

Map command types to exact required capabilities and mark restart/upgrade/rollback as high risk. Reject creation when the instance lacks capability or when no reauthentication grant is supplied; phase 6 replaces the local lock with real grant consumption.

- [ ] **Step 5: 验证并分别提交三个仓库**

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-claw-runtime'
scripts/run_tests.sh tests/hermes_cli/test_platform_control.py
git add hermes_cli/platform_control.py gateway/run.py tests/hermes_cli/test_platform_control.py
git commit -m "feat: add idempotent platform restart command"

cd '/Users/zizimutou/Desktop/agentera claw/hermes-studio'
npm run test -- tests/server/platform-control-client.test.ts tests/server/platform-control-version-commands.test.ts
npm run harness
npm run build
git add packages/server/src/services/platform-control-client.ts packages/server/src/services/platform-control-version-commands.ts tests/server/platform-control-version-commands.test.ts
git commit -m "feat: add controlled runtime version commands"

cd '/Users/zizimutou/Desktop/agentera claw/agentera-admin'
pnpm vitest run --config ./vitest.config.mts tests/int/runtime-control-endpoints.int.spec.ts
git add src/domain/runtime-control.ts src/domain/runtime-control-service.ts tests/int/runtime-control-endpoints.int.spec.ts
git commit -m "feat: register capability-gated runtime commands"
```

Expected: client adapters are real and idempotent while platform execution remains locked pending phase 6.

### Task 6: 完成 Runtime/Studio Soybean 管理页面

**Repository:** `/Users/zizimutou/Desktop/agentera claw/agentera-admin`

**Files:**

- Create: `admin-web/src/service/runtime.ts`
- Create: `admin-web/src/service/runtime.test.ts`
- Create: `admin-web/src/views/runtime/instances/index.vue`
- Create: `admin-web/src/views/runtime/instances/modules/instance-detail-drawer.vue`
- Create: `admin-web/src/views/runtime/releases/index.vue`
- Create: `admin-web/src/views/runtime/commands/index.vue`
- Create: `admin-web/src/views/runtime/events/index.vue`
- Create: `admin-web/src/views/runtime/operations/index.vue`
- Modify: `admin-web/src/router/elegant/routes.ts`
- Modify: `admin-web/src/router/elegant/imports.ts`

**Interfaces:**

- Uses Payload standard REST for runtime collections and explicit platform endpoints for enrollment/command creation.
- Only shows command types present in the selected instance's capabilities.

- [ ] **Step 1: 写状态、离线和 capability 失败测试**

Assert online/offline derives from server timestamps, unsupported commands cannot be submitted, enrollment code is shown once then discarded from component state, device secret never appears, task/workflow/Cron/Coding Agent/device tables accept only bounded metadata, events have no raw body, and failed command displays request ID and sanitized summary.

Run `pnpm --dir admin-web vitest run src/service/runtime.test.ts`.

Expected: FAIL because runtime service/pages are absent.

- [ ] **Step 2: 实现实例、版本、命令和事件页面**

Instances provide filters, detail drawer, device/channel tabs, create enrollment and `health_check`. The operations page combines task, workflow, Cron and Coding Agent metadata in tabs with instance/status filters. Releases manage metadata and compatibility; restart/upgrade/rollback controls render only for matching client capabilities and remain disabled with a “需要高风险重新验证” explanation until phase 6. Commands show lifecycle; events show sanitized structured data with retention date.

- [ ] **Step 3: 生成路由、验证并提交**

Run:

```bash
pnpm --dir admin-web gen-route
pnpm --dir admin-web fmt
pnpm --dir admin-web test
pnpm --dir admin-web typecheck
git add admin-web/src
git commit -m "feat: add soybean runtime control pages"
```

Expected: page actions match actual instance capabilities without demo controls.

### Task 7: 跨仓库协议、E2E 与阶段验收

**Files:**

- Create: `tests/int/runtime-client-contract.int.spec.ts`
- Create: `tests/e2e-soybean/runtime-control.e2e.spec.ts`
- Modify: `playwright.soybean.config.ts`

- [ ] **Step 1: 用两个真实客户端 fixture 验证协议**

Start Payload with an isolated DB, enroll one Python Runtime fixture and one Studio Node fixture, capture one heartbeat, queue `health_check`, submit results, stop heartbeat and advance the clock past offline threshold.

Run `pnpm vitest run --config ./vitest.config.mts tests/int/runtime-client-contract.int.spec.ts`.

Expected: both clients follow the same envelope/auth/state contract.

- [ ] **Step 2: 验证浏览器全流程与隐私边界**

E2E covers one-time enrollment display, online/offline, instance drawer, device/channel state, task/workflow/Cron/Coding Agent metadata, health command success/failure/expiry, release metadata and unsupported command absence. Inspect DB and network payloads for forbidden content keys.

Run `pnpm run test:e2e:admin -- tests/e2e-soybean/runtime-control.e2e.spec.ts`.

Expected: NAT-style outbound control works with no inbound device listener.

- [ ] **Step 3: 各仓库最终验证与提交**

Run:

```bash
cd '/Users/zizimutou/Desktop/agentera claw/agentera-admin'
pnpm run test:int
pnpm run test:admin
pnpm --dir admin-web typecheck
pnpm run build
pnpm run build:admin
pnpm run test:e2e:admin
git diff --check
git add tests/int/runtime-client-contract.int.spec.ts tests/e2e-soybean/runtime-control.e2e.spec.ts playwright.soybean.config.ts
git commit -m "test: verify runtime control plane"
```

Expected: admin, Runtime and Studio commits independently pass their repository verification and the cross-system control flow is proven.
