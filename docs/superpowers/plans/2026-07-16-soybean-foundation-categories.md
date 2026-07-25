# Soybean 基础与分类管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 `agentera-admin` 仓库内增加可独立运行的 Soybean 正式后台，接通 Payload Cookie 登录，并交付智能体分类的真实完整 CRUD。

**Architecture:** 将官方 Soybean Admin 2.2.0 固定提交整体导入 `admin-web`，保留它自己的内部 pnpm workspace，根 Payload 项目不改造成 monorepo。浏览器从 Soybean 同源请求 `/api`，开发时由 Vite 直接代理到 Payload；业务请求使用原生 `fetch`，认证完全依赖 Payload HttpOnly Cookie。

**Tech Stack:** Vue 3.5、Vite 8、TypeScript 6、Pinia 3、Naive UI 2.44、UnoCSS、Vitest、Playwright、Payload 3.86、Next 16、SQLite。

## Global Constraints

- 简单路线优先：`Soybean 页面 -> Payload REST API -> 现有 Payload 集合与 SQLite`。
- Soybean 上游固定为提交 `3d3613f20cd4add3cd20fd6cc884abead165c6d2`（仓库版本 `2.2.0`）。
- 不增加 BFF、共享 contracts 包、GraphQL、新认证、新 RBAC、微服务或 Payload 目录重构。
- 不修改现有 Payload 集合字段、数据库结构和 `/admin` 路由。
- `admin-web` 使用自己的 `package.json`、`pnpm-workspace.yaml` 和 `pnpm-lock.yaml`；根目录不新增 workspace 配置。
- 前端不保存 token；所有业务请求必须使用 `credentials: 'include'`。
- Payload Admin 当前未提交的 Soybean 换肤工作保持原样，不回退、不覆盖、不混入本计划的提交。
- 本计划只交付设计规格中的第一、二步：基础、登录、响应式外壳和分类 CRUD。技能、媒体、管理员、官方智能体及平台演示页面分别在后续计划实施。
- 生产构建使用 `/admin/` 为 base path，但本计划不切换正式反向代理入口。
- E2E 后端必须使用独立 `.tmp/soybean-e2e-<pid>.db`，不得复用开发数据库或已运行的 3100 端口服务。

---

## 文件结构与职责

### 根项目修改

- `package.json`：增加 Soybean 启动、构建、测试代理脚本。
- `tsconfig.json`：排除独立的 `admin-web`，避免 Next TypeScript 扫描 Vue 工程。
- `eslint.config.mjs`：排除 `admin-web`，由 Soybean 自己的 ESLint 配置负责。
- `playwright.soybean.config.ts`：同时启动隔离的 Payload 与 Soybean 测试服务器。
- `tests/e2e-soybean/admin-web.e2e.spec.ts`：登录、外壳、分类 CRUD、移动端验收。
- `tests/helpers/seedUser.ts`：增加内容发布员测试账号，同时保留现有导出兼容性。

### `admin-web` 新工程

- `admin-web/package.json`：Soybean 依赖、Vitest 脚本；不得安装根 Git hooks。
- `admin-web/vite.config.ts`：`/api` 代理及 `/admin/` base path。
- `admin-web/src/service/http.ts`：唯一底层 `fetch`、统一错误和 401 回调。
- `admin-web/src/service/auth.ts`：Payload 管理员登录、当前用户、退出。
- `admin-web/src/service/categories.ts`：分类查询参数与 CRUD。
- `admin-web/src/store/modules/auth/index.ts`：Cookie 会话状态；不再读写 token storage。
- `admin-web/src/router/guard/route.ts`：以 `me` 恢复结果判断登录，不读取 `localStorage`。
- `admin-web/src/views/_builtin/login/index.vue`：AgentEra 登录卡片。
- `admin-web/src/views/_builtin/login/modules/pwd-login.vue`：邮箱密码表单。
- `admin-web/src/views/home/index.vue`：首期平台总览占位和真实分类入口。
- `admin-web/src/views/categories/index.vue`：分类列表、搜索、分页、排序、创建、编辑和删除。
- `admin-web/src/components/common/system-logo.vue`：使用现有 AgentEra 图标。
- `admin-web/src/typings/api/auth.d.ts`：当前管理员类型。
- `admin-web/src/locales/langs/zh-cn.ts`：品牌、登录、首页、分类中文文案。
- `admin-web/src/theme/settings.ts`：AgentEra 主色与简化外壳设置。
- `admin-web/src/service/*.test.ts`、`admin-web/src/store/modules/auth/auth.test.ts`：请求、认证和查询转换测试。

---

### Task 1: 导入固定版本 Soybean 并隔离两个工程

**Files:**
- Create: `admin-web/**`（由固定上游提交归档导入）
- Modify: `admin-web/package.json`
- Modify: `admin-web/.env`
- Modify: `admin-web/.env.test`
- Modify: `admin-web/.env.prod`
- Modify: `admin-web/vite.config.ts`
- Modify: `admin-web/src/typings/vite-env.d.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `eslint.config.mjs`

**Interfaces:**
- Consumes: 官方 Soybean Admin 提交 `3d3613f20cd4add3cd20fd6cc884abead165c6d2`。
- Produces: `pnpm dev:admin`、`pnpm build:admin`、`pnpm test:admin`；开发时 `/api/*` 原样代理至 `VITE_PAYLOAD_PROXY_TARGET`。

- [ ] **Step 1: 验证导入前边界**

Run:

```bash
test ! -e admin-web
git status --short
```

Expected: `admin-web` 不存在；输出中可以看到既有 Payload WIP，但没有本任务产生的文件。

- [ ] **Step 2: 从固定提交机械导入官方工程，不带嵌套 `.git`**

Run:

```bash
reference_dir=$(mktemp -d /tmp/agentera-soybean.XXXXXX)
git -C "$reference_dir" init
git -C "$reference_dir" remote add origin https://github.com/soybeanjs/soybean-admin.git
git -C "$reference_dir" fetch --depth 1 origin 3d3613f20cd4add3cd20fd6cc884abead165c6d2
test "$(git -C "$reference_dir" rev-parse FETCH_HEAD)" = "3d3613f20cd4add3cd20fd6cc884abead165c6d2"
mkdir admin-web
git -C "$reference_dir" archive FETCH_HEAD | tar -x -C admin-web
test ! -e admin-web/.git
```

Expected: `admin-web/package.json` 存在，且 `admin-web/.git` 不存在。

- [ ] **Step 3: 调整前端包脚本，禁用上游 Git hooks 并加入 Vitest**

Apply this exact `admin-web/package.json` patch:

```diff
-  "name": "soybean-admin",
+  "name": "agentera-admin-web",
@@
     "preview": "vite preview",
+    "test": "vitest run",
+    "test:watch": "vitest",
@@
-    "prepare": "simple-git-hooks",
@@
     "@vitejs/plugin-vue-jsx": "5.1.5",
+    "@vue/test-utils": "2.4.6",
@@
+    "jsdom": "28.0.0",
@@
     "vite": "8.0.12",
+    "vitest": "4.0.18",
```

Do not remove the internal `packages/*` workspace dependencies; Soybean uses them for layout, hooks and UnoCSS.

- [ ] **Step 4: 固定 `/admin/` base path 和 Payload 代理**

Replace the application-specific values in `admin-web/.env` with:

```dotenv
VITE_BASE_URL=/admin/
VITE_APP_TITLE=AgentEra 管理系统
VITE_APP_DESC=AgentEra 平台管理员正式后台
VITE_ICON_PREFIX=icon
VITE_ICON_LOCAL_PREFIX=icon-local
VITE_AUTH_ROUTE_MODE=static
VITE_ROUTE_HOME=home
VITE_MENU_ICON=mdi:menu
VITE_HTTP_PROXY=N
VITE_SERVICE_BASE_URL=/api
VITE_SERVICE_SUCCESS_CODE=0000
VITE_SERVICE_LOGOUT_CODES=
VITE_SERVICE_MODAL_LOGOUT_CODES=
VITE_SERVICE_EXPIRED_TOKEN_CODES=
VITE_OTHER_SERVICE_BASE_URL={}
VITE_STATIC_SUPER_ROLE=super_admin
VITE_SOURCE_MAP=N
VITE_STORAGE_PREFIX=AGENTERA_ADMIN_
VITE_AUTOMATICALLY_DETECT_UPDATE=N
VITE_PROXY_LOG=N
VITE_DEVTOOLS_LAUNCH_EDITOR=code
```

Replace `admin-web/.env.test` with:

```dotenv
VITE_PAYLOAD_PROXY_TARGET=http://127.0.0.1:3100
```

Replace `admin-web/.env.prod` with:

```dotenv
VITE_PAYLOAD_PROXY_TARGET=
```

In `admin-web/src/typings/vite-env.d.ts`, add:

```ts
readonly VITE_PAYLOAD_PROXY_TARGET?: string;
```

In `admin-web/vite.config.ts`, remove the `createViteProxy` import and replace the server proxy definition with:

```ts
const payloadProxyTarget =
  process.env.VITE_PAYLOAD_PROXY_TARGET || viteEnv.VITE_PAYLOAD_PROXY_TARGET || 'http://127.0.0.1:3100';

// inside server
proxy: {
  '/api': {
    target: payloadProxyTarget,
    changeOrigin: true
  }
}
```

The proxy must not rewrite `/api`; Payload owns that prefix.

- [ ] **Step 5: 增加根命令并隔离根 TypeScript/ESLint**

Add to root `package.json` scripts:

```json
"build:admin": "pnpm --dir admin-web build",
"dev:admin": "pnpm --dir admin-web dev",
"dev:payload": "pnpm dev --port 3100",
"test:admin": "pnpm --dir admin-web test",
"test:e2e:admin": "cross-env NODE_OPTIONS=\"--no-deprecation --import=tsx/esm\" playwright test --config=playwright.soybean.config.ts"
```

Change the root `tsconfig.json` exclusion to:

```json
"exclude": ["node_modules", "admin-web"]
```

Add `admin-web/**` to the existing `ignores` array in `eslint.config.mjs`.

- [ ] **Step 6: 安装、生成锁文件并验证两个工程互不污染**

Run:

```bash
pnpm --dir admin-web install
pnpm --dir admin-web typecheck
pnpm --dir admin-web build
pnpm run test:int
git status --short
```

Expected: Soybean typecheck/build 成功；Payload 集成测试成功；根目录没有 `pnpm-workspace.yaml`；新增依赖只写入 `admin-web/pnpm-lock.yaml`。

- [ ] **Step 7: 仅提交脚手架和根隔离配置**

```bash
git add admin-web package.json tsconfig.json eslint.config.mjs
git commit -m "feat: add isolated Soybean admin app"
```

Before committing, verify `git diff --cached --name-only` does not include existing Payload WIP paths under `src/app/(payload)` or `src/components/admin`.

---

### Task 2: 建立原生 Fetch 请求层与 Payload 服务

**Files:**
- Create: `admin-web/src/service/http.ts`
- Create: `admin-web/src/service/http.test.ts`
- Create: `admin-web/src/service/auth.ts`
- Create: `admin-web/src/service/auth.test.ts`
- Create: `admin-web/src/service/categories.ts`
- Create: `admin-web/src/service/categories.test.ts`
- Create: `admin-web/vitest.config.ts`

**Interfaces:**
- Consumes: 浏览器同源 `/api`，Payload REST 错误体。
- Produces: `apiRequest<T>()`、`setUnauthorizedHandler()`、`loginAdmin()`、`getCurrentAdmin()`、`logoutAdmin()`、`listCategories()`、`createCategory()`、`updateCategory()`、`deleteCategory()`。

- [ ] **Step 1: 先写请求层失败测试**

Create `admin-web/src/service/http.test.ts` with tests that assert:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiRequest, setUnauthorizedHandler } from './http';

afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(undefined);
});

describe('apiRequest', () => {
  it('sends cookies and parses JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiRequest<{ ok: boolean }>('/health')).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/health', expect.objectContaining({ credentials: 'include' }));
  });

  it('maps Payload field errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [
              {
                message: '以下字段无效：稳定标识',
                data: { errors: [{ path: 'key', message: '稳定标识已存在' }] }
              }
            ]
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    await expect(apiRequest('/expert-categories')).rejects.toMatchObject({
      status: 400,
      fieldErrors: { key: '稳定标识已存在' }
    });
  });

  it('notifies on 401 but not on network failure', async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
    await expect(apiRequest('/admins/me')).rejects.toBeInstanceOf(ApiError);
    expect(unauthorized).toHaveBeenCalledOnce();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    await expect(apiRequest('/admins/me')).rejects.toMatchObject({ status: 0 });
    expect(unauthorized).toHaveBeenCalledOnce();
  });
});
```

Create `admin-web/vitest.config.ts`:

```ts
import { URL, fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { environment: 'jsdom', clearMocks: true }
});
```

- [ ] **Step 2: 运行请求层测试并确认红灯**

Run:

```bash
pnpm --dir admin-web test -- src/service/http.test.ts
```

Expected: FAIL because `./http` does not exist.

- [ ] **Step 3: 实现唯一底层请求函数**

Create `admin-web/src/service/http.ts`:

```ts
export type FieldErrors = Record<string, string>;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly fieldErrors?: FieldErrors
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type ApiRequestOptions = Omit<RequestInit, 'body'> & {
  body?: BodyInit | Record<string, unknown>;
};

type PayloadErrorBody = {
  message?: string;
  errors?: Array<{
    message?: string;
    field?: string;
    data?: {
      field?: string;
      path?: string;
      errors?: Array<{ field?: string; path?: string; message?: string }>;
    };
  }>;
};

let unauthorizedHandler: (() => void) | undefined;

export function setUnauthorizedHandler(handler: (() => void) | undefined) {
  unauthorizedHandler = handler;
}

function getFieldErrors(body: PayloadErrorBody): FieldErrors | undefined {
  const entries = (body.errors || []).flatMap(error => {
    const nested = error.data?.errors || [];
    if (nested.length) {
      return nested.flatMap(item => {
        const field = item.field || item.path;
        return field && item.message ? [[field, item.message] as const] : [];
      });
    }
    const field = error.field || error.data?.field || error.data?.path;
    return field && error.message ? [[field, error.message] as const] : [];
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}

async function readBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const headers = new Headers(options.headers);
  let body = options.body as BodyInit | undefined;

  if (body && !(body instanceof FormData) && typeof body !== 'string') {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...options,
      body,
      credentials: 'include',
      headers
    });
  } catch {
    throw new ApiError(0, '网络连接失败，请稍后重试');
  }

  const responseBody = await readBody(response);
  if (response.ok) return responseBody as T;

  const errorBody =
    responseBody && typeof responseBody === 'object' ? (responseBody as PayloadErrorBody) : {};
  const message = errorBody.message || errorBody.errors?.[0]?.message || `请求失败 (${response.status})`;

  if (response.status === 401) unauthorizedHandler?.();
  throw new ApiError(response.status, message, getFieldErrors(errorBody));
}
```

- [ ] **Step 4: 为认证和分类服务写失败测试**

Create `admin-web/src/service/auth.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './http';
import { getCurrentAdmin, loginAdmin, logoutAdmin } from './auth';

vi.mock('./http', () => ({ apiRequest: vi.fn() }));

const admin = {
  id: 7,
  email: 'admin@agentera.local',
  displayName: '测试管理员',
  role: 'super_admin' as const
};

describe('Payload administrator service', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());

  it('uses Payload login, me and logout endpoints', async () => {
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({ user: admin })
      .mockResolvedValueOnce({ user: admin })
      .mockResolvedValueOnce({ message: 'ok' });

    await expect(loginAdmin('admin@agentera.local', 'secret')).resolves.toEqual(admin);
    await expect(getCurrentAdmin()).resolves.toEqual(admin);
    await expect(logoutAdmin()).resolves.toBeUndefined();

    expect(apiRequest).toHaveBeenNthCalledWith(1, '/admins/login', {
      method: 'POST',
      body: { email: 'admin@agentera.local', password: 'secret' }
    });
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/admins/me');
    expect(apiRequest).toHaveBeenNthCalledWith(3, '/admins/logout', { method: 'POST' });
  });

  it('returns null for an anonymous me response', async () => {
    vi.mocked(apiRequest).mockResolvedValueOnce({ user: null });
    await expect(getCurrentAdmin()).resolves.toBeNull();
  });
});
```

Create `admin-web/src/service/categories.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiRequest } from './http';
import {
  buildCategorySearchParams,
  createCategory,
  deleteCategory,
  updateCategory
} from './categories';

vi.mock('./http', () => ({ apiRequest: vi.fn() }));

const input = {
  key: 'content',
  name: '内容',
  englishName: 'Content',
  description: '内容智能体',
  sortOrder: 12,
  active: true
};
const category = {
  id: 12,
  ...input,
  createdAt: '2026-07-16T00:00:00.000Z',
  updatedAt: '2026-07-16T00:00:00.000Z'
};

describe('category service', () => {
  beforeEach(() => vi.mocked(apiRequest).mockReset());

  it('builds Payload list query parameters', () => {
    expect(
      buildCategorySearchParams({ page: 2, pageSize: 20, search: '内容', sort: '-sortOrder' }).toString()
    ).toBe('page=2&limit=20&sort=-sortOrder&where%5Bname%5D%5Bcontains%5D=%E5%86%85%E5%AE%B9');
  });

  it('unwraps Payload mutation documents', async () => {
    vi.mocked(apiRequest)
      .mockResolvedValueOnce({ doc: category, message: 'created' })
      .mockResolvedValueOnce({ doc: category, message: 'updated' })
      .mockResolvedValueOnce({ doc: category, message: 'deleted' });

    await expect(createCategory(input)).resolves.toEqual(category);
    await expect(updateCategory(12, input)).resolves.toEqual(category);
    await expect(deleteCategory(12)).resolves.toEqual(category);

    expect(apiRequest).toHaveBeenNthCalledWith(1, '/expert-categories', {
      method: 'POST',
      body: input
    });
    expect(apiRequest).toHaveBeenNthCalledWith(2, '/expert-categories/12', {
      method: 'PATCH',
      body: input
    });
    expect(apiRequest).toHaveBeenNthCalledWith(3, '/expert-categories/12', {
      method: 'DELETE'
    });
  });
});
```

- [ ] **Step 5: 运行服务测试并确认红灯**

Run:

```bash
pnpm --dir admin-web test -- src/service/auth.test.ts src/service/categories.test.ts
```

Expected: FAIL because both service modules do not exist.

- [ ] **Step 6: 实现认证服务**

Create `admin-web/src/service/auth.ts`:

```ts
import { apiRequest } from './http';

export type AdminRole = 'publisher' | 'super_admin';

export interface AdminUser {
  id: number | string;
  email: string;
  displayName: string;
  role: AdminRole;
}

type AuthResponse = { user: AdminUser };
type MeResponse = { user: AdminUser | null };

export async function loginAdmin(email: string, password: string): Promise<AdminUser> {
  const result = await apiRequest<AuthResponse>('/admins/login', {
    method: 'POST',
    body: { email, password }
  });
  return result.user;
}

export async function getCurrentAdmin(): Promise<AdminUser | null> {
  const result = await apiRequest<MeResponse>('/admins/me');
  return result.user;
}

export async function logoutAdmin(): Promise<void> {
  await apiRequest('/admins/logout', { method: 'POST' });
}
```

- [ ] **Step 7: 实现分类服务**

Create `admin-web/src/service/categories.ts`:

```ts
import { apiRequest } from './http';

export interface Category {
  id: number | string;
  key: string;
  name: string;
  englishName?: string | null;
  description?: string | null;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CategoryInput {
  key: string;
  name: string;
  englishName: string;
  description: string;
  sortOrder: number;
  active: boolean;
}

export interface CategoryQuery {
  page: number;
  pageSize: number;
  search: string;
  sort: 'name' | '-name' | 'sortOrder' | '-sortOrder';
}

export interface Paginated<T> {
  docs: T[];
  totalDocs: number;
  limit: number;
  totalPages: number;
  page: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

type MutationResponse<T> = { doc: T; message: string };

export function buildCategorySearchParams(query: CategoryQuery): URLSearchParams {
  const params = new URLSearchParams({
    page: String(query.page),
    limit: String(query.pageSize),
    sort: query.sort
  });
  if (query.search.trim()) params.set('where[name][contains]', query.search.trim());
  return params;
}

export function listCategories(query: CategoryQuery): Promise<Paginated<Category>> {
  return apiRequest(`/expert-categories?${buildCategorySearchParams(query)}`);
}

export async function createCategory(input: CategoryInput): Promise<Category> {
  const result = await apiRequest<MutationResponse<Category>>('/expert-categories', {
    method: 'POST',
    body: input
  });
  return result.doc;
}

export async function updateCategory(id: Category['id'], input: CategoryInput): Promise<Category> {
  const result = await apiRequest<MutationResponse<Category>>(`/expert-categories/${id}`, {
    method: 'PATCH',
    body: input
  });
  return result.doc;
}

export async function deleteCategory(id: Category['id']): Promise<Category> {
  const result = await apiRequest<MutationResponse<Category>>(`/expert-categories/${id}`, {
    method: 'DELETE'
  });
  return result.doc;
}
```

- [ ] **Step 8: 运行测试、类型检查并提交请求边界**

Run:

```bash
pnpm --dir admin-web test -- src/service/http.test.ts src/service/auth.test.ts src/service/categories.test.ts
pnpm --dir admin-web typecheck
```

Expected: all service tests PASS and typecheck exits 0.

Commit:

```bash
git add admin-web/src/service admin-web/vitest.config.ts
git commit -m "feat: connect Soybean services to Payload"
```

---

### Task 3: 将 Soybean 认证状态改为 Payload Cookie 会话

**Files:**
- Modify: `admin-web/src/typings/api/auth.d.ts`
- Modify: `admin-web/src/store/modules/auth/index.ts`
- Create: `admin-web/src/store/modules/auth/auth.test.ts`
- Modify: `admin-web/src/router/guard/route.ts`
- Modify: `admin-web/src/layouts/modules/global-header/components/user-avatar.vue`
- Delete: `admin-web/src/store/modules/auth/shared.ts`

**Interfaces:**
- Consumes: `loginAdmin(email, password)`、`getCurrentAdmin()`、`logoutAdmin()`、`setUnauthorizedHandler()`。
- Produces: `useAuthStore()` with `userInfo`, `initialized`, `isLogin`, `isStaticSuper`, `login()`, `initUserInfo()`, `logout()`, `resetStore()`。

- [ ] **Step 1: 写 Cookie 会话 store 的失败测试**

Create `admin-web/src/store/modules/auth/auth.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { ApiError } from '@/service/http';
import { getCurrentAdmin, loginAdmin, logoutAdmin } from '@/service/auth';
import { useAuthStore } from './index';

const mocks = vi.hoisted(() => ({
  toLogin: vi.fn(),
  redirectFromLogin: vi.fn(),
  resetRoutes: vi.fn(),
  initAuthRoute: vi.fn(),
  clearTabs: vi.fn(),
  setUnauthorizedHandler: vi.fn()
}));

vi.mock('@/service/auth', () => ({
  getCurrentAdmin: vi.fn(),
  loginAdmin: vi.fn(),
  logoutAdmin: vi.fn()
}));
vi.mock('@/service/http', async importOriginal => ({
  ...(await importOriginal<typeof import('@/service/http')>()),
  setUnauthorizedHandler: mocks.setUnauthorizedHandler
}));
vi.mock('@/hooks/common/router', () => ({
  useRouterPush: () => ({ toLogin: mocks.toLogin, redirectFromLogin: mocks.redirectFromLogin })
}));
vi.mock('@/store/modules/route', () => ({
  useRouteStore: () => ({ resetStore: mocks.resetRoutes, initAuthRoute: mocks.initAuthRoute })
}));
vi.mock('@/store/modules/tab', () => ({
  useTabStore: () => ({ clearTabs: mocks.clearTabs })
}));

const admin = {
  id: 7,
  email: 'admin@agentera.local',
  displayName: '测试管理员',
  role: 'super_admin' as const
};

describe('Payload cookie auth store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('logs in without storing a token', async () => {
    vi.mocked(loginAdmin).mockResolvedValue(admin);
    const store = useAuthStore();

    await store.login('admin@agentera.local', 'secret', false);

    expect(store.userInfo).toMatchObject({
      userId: '7',
      userName: '测试管理员',
      email: 'admin@agentera.local',
      role: 'super_admin',
      roles: ['super_admin']
    });
    expect(localStorage.getItem('token')).toBeNull();
    expect(mocks.initAuthRoute).toHaveBeenCalledOnce();
    expect(mocks.redirectFromLogin).toHaveBeenCalledWith(false);
  });

  it('restores the current user only once', async () => {
    vi.mocked(getCurrentAdmin).mockResolvedValue(admin);
    const store = useAuthStore();

    await store.initUserInfo();
    await store.initUserInfo();

    expect(getCurrentAdmin).toHaveBeenCalledOnce();
    expect(store.isLogin).toBe(true);
  });

  it('logs out through Payload then clears local state', async () => {
    vi.mocked(getCurrentAdmin).mockResolvedValue(admin);
    vi.mocked(logoutAdmin).mockResolvedValue(undefined);
    const store = useAuthStore();
    await store.initUserInfo();

    await store.logout();

    expect(logoutAdmin).toHaveBeenCalledOnce();
    expect(store.isLogin).toBe(false);
    expect(mocks.toLogin).toHaveBeenCalledOnce();
  });

  it('does not convert a network failure into remote logout', async () => {
    vi.mocked(getCurrentAdmin).mockRejectedValue(new ApiError(0, '网络连接失败，请稍后重试'));
    const store = useAuthStore();

    await store.initUserInfo();

    expect(logoutAdmin).not.toHaveBeenCalled();
    expect(mocks.toLogin).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行 store 测试并确认红灯**

Run:

```bash
pnpm --dir admin-web test -- src/store/modules/auth/auth.test.ts
```

Expected: FAIL because the upstream store still expects local tokens and mock login responses.

- [ ] **Step 3: 定义 Payload 管理员类型**

Replace `admin-web/src/typings/api/auth.d.ts` with:

```ts
declare namespace Api {
  namespace Auth {
    type AdminRole = 'publisher' | 'super_admin';

    interface UserInfo {
      userId: string;
      userName: string;
      email: string;
      role: AdminRole | '';
      roles: AdminRole[];
      buttons: string[];
    }
  }
}
```

- [ ] **Step 4: 实现 Cookie auth store**

Replace `admin-web/src/store/modules/auth/index.ts` with:

```ts
import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import { useRouterPush } from '@/hooks/common/router';
import { ApiError, setUnauthorizedHandler } from '@/service/http';
import { getCurrentAdmin, loginAdmin, logoutAdmin } from '@/service/auth';
import type { AdminUser } from '@/service/auth';
import { SetupStoreId } from '@/enum';
import { useRouteStore } from '@/store/modules/route';
import { useTabStore } from '@/store/modules/tab';

export const useAuthStore = defineStore(SetupStoreId.Auth, () => {
  const routeStore = useRouteStore();
  const tabStore = useTabStore();
  const { toLogin, redirectFromLogin } = useRouterPush(false);

const initialized = ref(false);
const loginLoading = ref(false);
const userInfo = reactive<Api.Auth.UserInfo>({
  userId: '',
  userName: '',
  email: '',
  role: '',
  roles: [],
  buttons: []
});

const isLogin = computed(() => Boolean(userInfo.userId));
const isStaticSuper = computed(() => userInfo.role === 'super_admin');

function applyUser(user: AdminUser | null) {
  Object.assign(userInfo, user
    ? {
        userId: String(user.id),
        userName: user.displayName,
        email: user.email,
        role: user.role,
        roles: [user.role],
        buttons: []
      }
    : { userId: '', userName: '', email: '', role: '', roles: [], buttons: [] });
}

async function clearSession(redirect = true) {
  applyUser(null);
  initialized.value = true;
  tabStore.clearTabs();
  await routeStore.resetStore();
  if (redirect) await toLogin();
}

async function resetStore() {
  await clearSession(true);
}

async function login(email: string, password: string, redirect = true) {
  loginLoading.value = true;
  try {
    const user = await loginAdmin(email, password);
    applyUser(user);
    initialized.value = true;
    await routeStore.initAuthRoute();
    await redirectFromLogin(redirect);
    window.$notification?.success({
      title: '登录成功',
      content: `欢迎回来，${user.displayName}`,
      duration: 3000
    });
  } catch (error) {
    if (error instanceof ApiError) window.$message?.error(error.message);
  } finally {
    loginLoading.value = false;
  }
}

async function initUserInfo() {
  if (initialized.value) return;
  try {
    applyUser(await getCurrentAdmin());
  } catch (error) {
    if (error instanceof ApiError && error.status !== 401) {
      window.$message?.error(error.message);
    }
  } finally {
    initialized.value = true;
  }
}

async function logout() {
  try {
    await logoutAdmin();
    await clearSession(true);
  } catch (error) {
    if (error instanceof ApiError) window.$message?.error(error.message);
  }
}

setUnauthorizedHandler(() => {
  void resetStore();
});

return {
  initialized,
  isLogin,
  isStaticSuper,
  loginLoading,
  userInfo,
  initUserInfo,
  login,
  logout,
  resetStore
};
});
```

Delete `src/store/modules/auth/shared.ts`; no auth code may read or write `token` or `refreshToken`.

- [ ] **Step 5: 修改路由守卫和退出菜单**

In `router/guard/route.ts`:

- remove the `localStg` import;
- call `await authStore.initUserInfo()` before deciding whether a route requires login;
- replace every `Boolean(localStg.get('token'))` with `authStore.isLogin`;
- keep route role filtering based on `authStore.userInfo.roles`.

In `user-avatar.vue`, make the confirm callback async and call:

```ts
await authStore.logout();
```

- [ ] **Step 6: 验证不再存在 token 认证并提交**

Run:

```bash
pnpm --dir admin-web test -- src/store/modules/auth/auth.test.ts
pnpm --dir admin-web typecheck
rg -n "localStg\.(get|set)\('(token|refreshToken)'" admin-web/src
```

Expected: tests and typecheck PASS; `rg` returns no matches.

Commit:

```bash
git add admin-web/src/typings/api/auth.d.ts admin-web/src/store/modules/auth admin-web/src/router/guard/route.ts admin-web/src/layouts/modules/global-header/components/user-avatar.vue
git commit -m "feat: use Payload cookie authentication"
```

---

### Task 4: 交付 AgentEra 登录页和响应式 Soybean 外壳

**Files:**
- Modify: `admin-web/src/components/common/system-logo.vue`
- Modify: `admin-web/src/layouts/modules/global-logo/index.vue`
- Modify: `admin-web/src/views/_builtin/login/index.vue`
- Modify: `admin-web/src/views/_builtin/login/modules/pwd-login.vue`
- Delete: `admin-web/src/views/_builtin/login/modules/code-login.vue`
- Delete: `admin-web/src/views/_builtin/login/modules/register.vue`
- Delete: `admin-web/src/views/_builtin/login/modules/reset-pwd.vue`
- Delete: `admin-web/src/views/_builtin/login/modules/bind-wechat.vue`
- Modify: `admin-web/src/views/home/index.vue`
- Delete: `admin-web/src/views/home/modules/**`
- Modify: `admin-web/src/locales/langs/zh-cn.ts`
- Modify: `admin-web/src/theme/settings.ts`
- Create: `admin-web/public/agentera-icon.png`（复制自根 `src/app/icon.png`）
- Create: `playwright.soybean.config.ts`
- Create: `tests/e2e-soybean/admin-web.e2e.spec.ts`

**Interfaces:**
- Consumes: `useAuthStore().login()`、Soybean base layout。
- Produces: `/admin/login`、`/admin/home`，以及 `data-testid="agentera-admin-shell"`、`agentera-login-form`、`agentera-brand`。

- [ ] **Step 1: 先建立隔离 E2E 配置和失败验收**

Create `playwright.soybean.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';
import { mkdirSync } from 'node:fs';

mkdirSync('.tmp', { recursive: true });
process.env.DATABASE_URL = `file:./.tmp/soybean-e2e-${process.pid}.db`;
process.env.PAYLOAD_SECRET = 'agentera-soybean-e2e-secret';
process.env.NEXT_PUBLIC_SERVER_URL = 'http://127.0.0.1:3101';

export default defineConfig({
  testDir: './tests/e2e-soybean',
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:9527',
    trace: 'on-first-retry'
  },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
  webServer: [
    {
      command: 'pnpm dev --port 3101',
      url: 'http://127.0.0.1:3101/api/admins/me',
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command:
        'cross-env VITE_PAYLOAD_PROXY_TARGET=http://127.0.0.1:3101 pnpm --dir admin-web dev --host 127.0.0.1 --port 9527',
      url: 'http://127.0.0.1:9527/admin/login',
      reuseExistingServer: false,
      timeout: 120_000
    }
  ]
});
```

Start `tests/e2e-soybean/admin-web.e2e.spec.ts` with these tests:

```ts
import { expect, type Page, test } from '@playwright/test';
import { cleanupTestUser, seedTestUser, testUser } from '../helpers/seedUser';

async function loginViaUi(page: Page, user: { email: string; password: string } = testUser) {
  await page.goto('/admin/login');
  await page.getByTestId('admin-email').fill(user.email);
  await page.getByTestId('admin-password').fill(user.password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL(/\/admin\/home/);
}

test.beforeAll(async () => seedTestUser());
test.afterAll(async () => cleanupTestUser());

test('redirects anonymous administrators to AgentEra login', async ({ page }) => {
  await page.goto('/admin/home');
  await expect(page).toHaveURL(/\/admin\/login/);
  await expect(page.getByTestId('agentera-login-form')).toBeVisible();
});

test('logs in with Payload and renders the Soybean shell', async ({ page }) => {
  await loginViaUi(page);
  await expect(page.getByTestId('agentera-brand')).toContainText('AgentEra 管理系统');
  await expect(page.getByTestId('agentera-admin-shell')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('token'))).toBeNull();
});
```

- [ ] **Step 2: 运行外壳 E2E 并确认红灯**

Run:

```bash
pnpm test:e2e:admin --grep "anonymous|Soybean shell"
```

Expected: FAIL because the upstream login form, branding and test IDs have not been replaced yet.

- [ ] **Step 3: 替换品牌图标和标题**

Copy the existing project-owned icon mechanically:

```bash
cp src/app/icon.png admin-web/public/agentera-icon.png
```

Replace `system-logo.vue` with an image using the configured base:

```vue
<script setup lang="ts">
const logoUrl = `${import.meta.env.BASE_URL}agentera-icon.png`;
</script>

<template>
  <img :src="logoUrl" alt="AgentEra" class="block size-full object-contain" />
</template>
```

Add `data-testid="agentera-brand"` to the root link in `global-logo/index.vue`.

- [ ] **Step 4: 简化登录页为唯一邮箱密码入口**

Replace `login/index.vue` with:

```vue
<script setup lang="ts">
import { computed } from 'vue';
import { getPaletteColorByNumber, mixColor } from '@sa/color';
import { useThemeStore } from '@/store/modules/theme';
import PwdLogin from './modules/pwd-login.vue';

defineOptions({ name: 'LoginPage' });

const themeStore = useThemeStore();
const bgThemeColor = computed(() =>
  themeStore.darkMode ? getPaletteColorByNumber(themeStore.themeColor, 600) : themeStore.themeColor
);
const bgColor = computed(() => mixColor('#ffffff', themeStore.themeColor, themeStore.darkMode ? 0.5 : 0.2));
</script>

<template>
  <div class="relative size-full flex-center overflow-hidden" :style="{ backgroundColor: bgColor }">
    <WaveBg :theme-color="bgThemeColor" />
    <NCard
      data-testid="agentera-login-form"
      :bordered="false"
      class="relative z-4 w-auto rd-12px"
    >
      <div class="w-400px lt-sm:w-300px">
        <header class="flex-y-center gap-12px" data-testid="agentera-brand">
          <SystemLogo class="size-56px lt-sm:size-44px" />
          <div>
            <h1 class="m-0 text-26px text-primary font-600 lt-sm:text-22px">AgentEra 管理系统</h1>
            <p class="mb-0 mt-4px text-13px text-gray-500">平台管理员正式后台</p>
          </div>
        </header>
        <main class="pt-28px">
          <h2 class="m-0 text-18px text-primary font-500">管理员登录</h2>
          <div class="pt-20px"><PwdLogin /></div>
        </main>
      </div>
    </NCard>
  </div>
</template>
```

Replace `pwd-login.vue` with:

```vue
<script setup lang="ts">
import { reactive, ref } from 'vue';
import type { FormInst, FormRules } from 'naive-ui';
import { useAuthStore } from '@/store/modules/auth';

defineOptions({ name: 'PwdLogin' });

interface FormModel {
  email: string;
  password: string;
}

const authStore = useAuthStore();
const formRef = ref<FormInst | null>(null);
const model = reactive<FormModel>({ email: '', password: '' });
const rules: FormRules = {
  email: [
    { required: true, message: '请输入管理员邮箱', trigger: ['input', 'blur'] },
    { type: 'email', message: '请输入有效邮箱', trigger: ['input', 'blur'] }
  ],
  password: [{ required: true, message: '请输入密码', trigger: ['input', 'blur'] }]
};

async function handleSubmit() {
  await formRef.value?.validate();
  await authStore.login(model.email, model.password);
}
</script>

<template>
  <NForm ref="formRef" :model="model" :rules="rules" size="large" :show-label="false" @keyup.enter="handleSubmit">
    <NFormItem path="email">
      <NInput
        v-model:value="model.email"
        :input-props="{ 'data-testid': 'admin-email' }"
        autocomplete="username"
        placeholder="请输入管理员邮箱"
      />
    </NFormItem>
    <NFormItem path="password">
      <NInput
        v-model:value="model.password"
        :input-props="{ 'data-testid': 'admin-password' }"
        autocomplete="current-password"
        type="password"
        show-password-on="click"
        placeholder="请输入密码"
      />
    </NFormItem>
    <NButton type="primary" size="large" round block :loading="authStore.loginLoading" @click="handleSubmit">
      登录
    </NButton>
  </NForm>
</template>
```

Delete the four unused login Vue files. Keep the upstream route parameter compatible for now; every accepted login module renders this same password page, so no extra public workflow remains.

- [ ] **Step 5: 简化首页和主题**

Replace `home/index.vue` with:

```vue
<script setup lang="ts">
defineOptions({ name: 'HomePage' });
</script>

<template>
  <div data-testid="agentera-admin-shell">
    <NCard :bordered="false" class="card-wrapper">
      <h1 class="m-0 text-24px font-600">AgentEra 平台总览</h1>
      <p class="mb-0 text-14px text-gray-500">正式管理后台正在按真实模块逐步迁移。</p>
    </NCard>
  </div>
</template>
```

Delete `views/home/modules/**`.

Set these theme values in `theme/settings.ts`:

```ts
themeColor: '#646ced',
themeRadius: 10,
header: {
  height: 64,
  breadcrumb: { visible: true, showIcon: false },
  multilingual: { visible: false },
  globalSearch: { visible: false }
},
tab: { visible: false, cache: false, height: 44, mode: 'chrome', closeTabByMiddleClick: false },
footer: { visible: false, fixed: false, height: 48, right: true },
```

Change Chinese locale values:

```ts
system.title = 'AgentEra 管理系统';
route.home = '平台总览';
page.login.common.userNamePlaceholder = '请输入管理员邮箱';
page.login.pwdLogin.title = '管理员登录';
```

- [ ] **Step 6: 验证登录、桌面和移动外壳**

Add one mobile E2E assertion:

```ts
await page.setViewportSize({ width: 390, height: 844 });
await loginViaUi(page);
expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
```

Run:

```bash
pnpm --dir admin-web typecheck
pnpm --dir admin-web build
pnpm test:e2e:admin --grep "anonymous|Soybean shell|mobile"
```

Expected: typecheck/build PASS; all three E2E tests PASS.

- [ ] **Step 7: 提交认证外壳**

```bash
git add admin-web playwright.soybean.config.ts tests/e2e-soybean/admin-web.e2e.spec.ts
git commit -m "feat: add AgentEra Soybean login shell"
```

---

### Task 5: 交付智能体分类完整 CRUD

**Files:**
- Create: `admin-web/src/views/categories/index.vue`
- Modify: `admin-web/src/locales/langs/zh-cn.ts`
- Modify: `admin-web/build/plugins/router.ts`
- Modify: generated files under `admin-web/src/router/elegant/` and `admin-web/src/typings/elegant-router.d.ts` (由 Vite Elegant Router 插件生成)
- Modify: `tests/e2e-soybean/admin-web.e2e.spec.ts`
- Modify: `tests/helpers/seedUser.ts`

**Interfaces:**
- Consumes: Task 2 `categories.ts` API and Task 3 authenticated shell.
- Produces: `/admin/categories`；真实 Payload 分类查询、创建、编辑、删除；`super_admin` 与 `publisher` 均可进入。

- [ ] **Step 1: 扩充 E2E 测试账号且保持旧测试兼容**

Add to `tests/helpers/seedUser.ts`:

```ts
export const publisherUser = {
  displayName: '测试发布员',
  email: 'publisher@agentera.local',
  password: 'agentera-publisher-password',
  role: 'publisher' as const
};

export async function seedPublisherUser(): Promise<void> {
  const payload = await getPayload({ config });
  await payload.delete({
    collection: 'admins',
    overrideAccess: true,
    where: { email: { equals: publisherUser.email } }
  });
  await payload.create({ collection: 'admins', data: publisherUser, overrideAccess: true });
}

export async function cleanupPublisherUser(): Promise<void> {
  const payload = await getPayload({ config });
  await payload.delete({
    collection: 'admins',
    overrideAccess: true,
    where: { email: { equals: publisherUser.email } }
  });
}
```

Do not rename or remove `testUser`, `seedTestUser`, or `cleanupTestUser` because existing Payload E2E imports them.

- [ ] **Step 2: 先写分类 CRUD 和发布员访问的失败 E2E**

Extend the E2E imports and lifecycle:

```ts
import {
  cleanupPublisherUser,
  cleanupTestUser,
  publisherUser,
  seedPublisherUser,
  seedTestUser,
  testUser
} from '../helpers/seedUser';

test.beforeAll(async () => {
  await seedTestUser();
  await seedPublisherUser();
});

test.afterAll(async () => {
  await cleanupPublisherUser();
  await cleanupTestUser();
});
```

Replace the earlier single-user lifecycle hooks rather than registering them twice. Add these complete tests:

```ts
test('creates, edits and deletes a real category', async ({ page }) => {
  await loginViaUi(page);
  await page.goto('/admin/categories');
  await page.getByTestId('category-create').click();
  await page.getByTestId('category-key').fill('codex-e2e');
  await page.getByTestId('category-name').fill('Codex 测试分类');
  await page.getByTestId('category-sort-order').fill('12');
  await page.getByRole('button', { name: '保存' }).click();

  let row = page.getByRole('row').filter({ hasText: 'Codex 测试分类' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '编辑 Codex 测试分类' }).click();
  await page.getByTestId('category-name').fill('Codex 已更新分类');
  await page.getByRole('button', { name: '保存' }).click();

  row = page.getByRole('row').filter({ hasText: 'Codex 已更新分类' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '删除 Codex 已更新分类' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(row).toHaveCount(0);
});

test('allows a publisher to manage categories', async ({ page }) => {
  await loginViaUi(page, publisherUser);
  await page.goto('/admin/categories');
  await expect(page.getByTestId('category-create')).toBeVisible();
});

test('contains the category table inside the mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginViaUi(page);
  await page.goto('/admin/categories');
  await expect(page.getByRole('heading', { name: '智能体分类' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
```

- [ ] **Step 3: 运行分类 E2E 并确认红灯**

Run:

```bash
pnpm test:e2e:admin --grep "category|publisher"
```

Expected: FAIL because `/admin/categories` does not exist.

- [ ] **Step 4: 创建分类页面状态和表格**

Create `admin-web/src/views/categories/index.vue` with this complete implementation:

```vue
<script setup lang="ts">
import { computed, h, onMounted, reactive, ref } from 'vue';
import type { DataTableColumns, DataTableSortState, FormInst, FormRules } from 'naive-ui';
import { NButton, NSpace, NTag } from 'naive-ui';
import {
  createCategory,
  deleteCategory,
  listCategories,
  updateCategory
} from '@/service/categories';
import type { Category, CategoryInput, CategoryQuery } from '@/service/categories';
import { ApiError } from '@/service/http';

defineOptions({ name: 'CategoriesPage' });

const loading = ref(false);
const saving = ref(false);
const rows = ref<Category[]>([]);
const total = ref(0);
const query = reactive<CategoryQuery>({ page: 1, pageSize: 10, search: '', sort: 'sortOrder' });
const showEditor = ref(false);
const editingId = ref<Category['id']>();
const formRef = ref<FormInst | null>(null);
const form = reactive<CategoryInput>({
  key: '',
  name: '',
  englishName: '',
  description: '',
  sortOrder: 0,
  active: true
});
const fieldErrors = ref<Record<string, string>>({});

const rules: FormRules = {
  key: [{ required: true, message: '请输入稳定标识', trigger: ['input', 'blur'] }],
  name: [{ required: true, message: '请输入中文名称', trigger: ['input', 'blur'] }],
  sortOrder: [{ type: 'number', required: true, message: '请输入排序值', trigger: ['input', 'blur'] }]
};

const pagination = computed(() => ({
  page: query.page,
  pageSize: query.pageSize,
  itemCount: total.value,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  onChange(page: number) {
    query.page = page;
    void load();
  },
  onUpdatePageSize(pageSize: number) {
    query.page = 1;
    query.pageSize = pageSize;
    void load();
  }
}));

const columns = computed<DataTableColumns<Category>>(() => [
  {
    title: '中文名称',
    key: 'name',
    sorter: 'default',
    sortOrder: query.sort === 'name' ? 'ascend' : query.sort === '-name' ? 'descend' : false
  },
  { title: '稳定标识', key: 'key' },
  { title: '英文名称', key: 'englishName', render: row => row.englishName || '—' },
  {
    title: '排序',
    key: 'sortOrder',
    sorter: 'default',
    sortOrder: query.sort === 'sortOrder' ? 'ascend' : query.sort === '-sortOrder' ? 'descend' : false
  },
  {
    title: '状态',
    key: 'active',
    render: row => h(NTag, { type: row.active ? 'success' : 'default', bordered: false }, () => row.active ? '启用' : '停用')
  },
  {
    title: '更新时间',
    key: 'updatedAt',
    render: row => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(row.updatedAt))
  },
  {
    title: '操作',
    key: 'actions',
    fixed: 'right',
    width: 150,
    render: row => h(NSpace, { size: 4 }, () => [
      h(NButton, { text: true, type: 'primary', 'aria-label': `编辑 ${row.name}`, onClick: () => openEdit(row) }, () => '编辑'),
      h(NButton, { text: true, type: 'error', 'aria-label': `删除 ${row.name}`, onClick: () => confirmDelete(row) }, () => '删除')
    ])
  }
]);

function resetForm() {
  Object.assign(form, {
    key: '',
    name: '',
    englishName: '',
    description: '',
    sortOrder: 0,
    active: true
  });
  fieldErrors.value = {};
}

function openCreate() {
  editingId.value = undefined;
  resetForm();
  showEditor.value = true;
}

function openEdit(category: Category) {
  editingId.value = category.id;
  Object.assign(form, {
    key: category.key,
    name: category.name,
    englishName: category.englishName || '',
    description: category.description || '',
    sortOrder: category.sortOrder,
    active: category.active
  });
  fieldErrors.value = {};
  showEditor.value = true;
}

async function load() {
  loading.value = true;
  try {
    const result = await listCategories(query);
    rows.value = result.docs;
    total.value = result.totalDocs;
  } catch (error) {
    if (error instanceof ApiError) window.$message?.error(error.message);
  } finally {
    loading.value = false;
  }
}

function search() {
  query.page = 1;
  void load();
}

function handleSorterChange(sorter: DataTableSortState | DataTableSortState[] | null) {
  const current = Array.isArray(sorter) ? sorter[0] : sorter;
  if (!current?.order || (current.columnKey !== 'name' && current.columnKey !== 'sortOrder')) {
    query.sort = 'sortOrder';
  } else {
    const prefix = current.order === 'descend' ? '-' : '';
    query.sort = `${prefix}${current.columnKey}` as CategoryQuery['sort'];
  }
  query.page = 1;
  void load();
}

async function save() {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }

  const creating = editingId.value === undefined;
  saving.value = true;
  fieldErrors.value = {};
  try {
    if (creating) await createCategory({ ...form });
    else await updateCategory(editingId.value!, { ...form });
    showEditor.value = false;
    window.$message?.success(creating ? '分类已创建' : '分类已更新');
    await load();
  } catch (error) {
    if (error instanceof ApiError) {
      fieldErrors.value = error.fieldErrors || {};
      window.$message?.error(error.message);
    }
  } finally {
    saving.value = false;
  }
}

function confirmDelete(category: Category) {
  window.$dialog?.warning({
    title: '删除分类',
    content: `确认删除“${category.name}”吗？`,
    positiveText: '删除',
    negativeText: '取消',
    async onPositiveClick() {
      try {
        await deleteCategory(category.id);
        window.$message?.success('分类已删除');
        if (rows.value.length === 1 && query.page > 1) query.page -= 1;
        await load();
      } catch (error) {
        if (error instanceof ApiError) window.$message?.error(error.message);
      }
    }
  });
}

onMounted(load);
</script>

<template>
  <NSpace vertical :size="16">
    <div class="flex-y-center justify-between gap-12px lt-sm:flex-col lt-sm:items-stretch">
      <div>
        <h1 class="m-0 text-24px font-600">智能体分类</h1>
        <p class="mb-0 mt-6px text-14px text-gray-500">维护官方智能体的分类与排序</p>
      </div>
      <NButton data-testid="category-create" type="primary" @click="openCreate">创建分类</NButton>
    </div>

    <NCard :bordered="false" class="card-wrapper">
      <div class="mb-16px flex gap-8px lt-sm:flex-col">
        <NInput
          v-model:value="query.search"
          :input-props="{ 'data-testid': 'category-search' }"
          clearable
          placeholder="搜索中文名称"
          @clear="search"
          @keyup.enter="search"
        />
        <NButton @click="search">搜索</NButton>
      </div>
      <div class="max-w-full overflow-x-auto">
        <NDataTable
          remote
          :columns="columns"
          :data="rows"
          :loading="loading"
          :pagination="pagination"
          :row-key="row => row.id"
          :scroll-x="960"
          @update:sorter="handleSorterChange"
        />
      </div>
    </NCard>

    <NModal v-model:show="showEditor" preset="card" :title="editingId === undefined ? '创建分类' : '编辑分类'" class="w-600px max-w-[calc(100vw-32px)]">
      <NForm ref="formRef" :model="form" :rules="rules" label-placement="top">
        <NGrid :cols="2" :x-gap="16" responsive="screen" item-responsive>
          <NFormItemGi span="2 s:1" label="稳定标识" path="key" :validation-status="fieldErrors.key ? 'error' : undefined" :feedback="fieldErrors.key">
            <NInput v-model:value="form.key" :input-props="{ 'data-testid': 'category-key' }" placeholder="例如 marketing" />
          </NFormItemGi>
          <NFormItemGi span="2 s:1" label="中文名称" path="name" :validation-status="fieldErrors.name ? 'error' : undefined" :feedback="fieldErrors.name">
            <NInput v-model:value="form.name" :input-props="{ 'data-testid': 'category-name' }" />
          </NFormItemGi>
          <NFormItemGi span="2 s:1" label="英文名称" path="englishName">
            <NInput v-model:value="form.englishName" :input-props="{ 'data-testid': 'category-english-name' }" />
          </NFormItemGi>
          <NFormItemGi span="2 s:1" label="排序" path="sortOrder">
            <NInputNumber
              :value="form.sortOrder"
              :input-props="{ 'data-testid': 'category-sort-order' }"
              class="w-full"
              @update:value="value => form.sortOrder = value ?? 0"
            />
          </NFormItemGi>
          <NFormItemGi :span="2" label="分类说明" path="description">
            <NInput v-model:value="form.description" :input-props="{ 'data-testid': 'category-description' }" type="textarea" :rows="3" />
          </NFormItemGi>
          <NFormItemGi :span="2" label="状态" path="active">
            <NCheckbox v-model:checked="form.active" data-testid="category-active">启用</NCheckbox>
          </NFormItemGi>
        </NGrid>
      </NForm>
      <template #footer>
        <div class="flex justify-end gap-8px">
          <NButton @click="showEditor = false">取消</NButton>
          <NButton type="primary" :loading="saving" @click="save">保存</NButton>
        </div>
      </template>
    </NModal>
  </NSpace>
</template>
```

- [ ] **Step 5: 检查创建、编辑、删除和字段错误边界**

Run the service tests again and inspect the page implementation:

```bash
pnpm --dir admin-web test -- src/service/http.test.ts src/service/categories.test.ts
rg -n "data-testid=\"category-(create|search|key|name|english-name|description|sort-order|active)\"" admin-web/src/views/categories/index.vue
```

Expected: service tests PASS and all eight stable selectors are present. Delete occurs only inside the confirmation callback; no optimistic row removal exists.

- [ ] **Step 6: 生成并检查静态路由**

Run:

```bash
pnpm --dir admin-web build
rg -n "categories" admin-web/src/router/elegant/routes.ts admin-web/src/router/elegant/imports.ts admin-web/src/typings/elegant-router.d.ts
```

Expected: build succeeds; generated route path is `/categories` and appears in all three generated route artifacts.

Add `route.categories = '智能体分类'` to Chinese locales.
Add this exact branch to `onRouteMetaGen` in `admin-web/build/plugins/router.ts` before returning `meta`:

```ts
if (key === 'home') meta.icon = 'mdi:monitor-dashboard';
if (key === 'categories') meta.icon = 'material-symbols:folder-outline';
```

- [ ] **Step 7: 验证真实 CRUD、发布员权限和移动端**

Run:

```bash
pnpm --dir admin-web test
pnpm --dir admin-web typecheck
pnpm test:e2e:admin --grep "category|publisher|mobile"
pnpm run test:int
```

Expected: all Soybean unit tests PASS; category E2E creates, edits, deletes real SQLite data; publisher can manage categories; mobile document width is at most 390; existing Payload integration tests PASS.

- [ ] **Step 8: 提交分类垂直切片**

```bash
git add admin-web/src/views/categories admin-web/src/locales/langs/zh-cn.ts admin-web/build/plugins/router.ts admin-web/src/router/elegant admin-web/src/typings/elegant-router.d.ts tests/e2e-soybean/admin-web.e2e.spec.ts tests/helpers/seedUser.ts
git commit -m "feat: manage categories in Soybean admin"
```

---

### Task 6: 完整验证并记录后续复用入口

**Files:**
- Create: `admin-web/AGENTERA.md`

**Interfaces:**
- Consumes: completed foundation and categories slice.
- Produces: reproducible local commands and a green handoff baseline for subsequent skill/media/admin/agent plans.

- [ ] **Step 1: 写最短维护说明**

Create `admin-web/AGENTERA.md`:

```markdown
# AgentEra Admin Web

## Local development

Terminal 1: `pnpm dev:payload`

Terminal 2: `pnpm dev:admin`

Open `http://localhost:9527/admin/`.

## Verification

- Unit: `pnpm test:admin`
- Typecheck: `pnpm --dir admin-web typecheck`
- Build: `pnpm build:admin`
- Isolated E2E: `pnpm test:e2e:admin`

## Backend boundary

Pages call the small modules in `src/service/`. Those modules call Payload REST under `/api` with HttpOnly Cookie authentication. Do not add a BFF or store auth tokens in browser storage.
```

- [ ] **Step 2: 运行最终验证矩阵**

Run in this order:

```bash
pnpm test:admin
pnpm --dir admin-web typecheck
pnpm build:admin
pnpm run test:int
pnpm test:e2e:admin
pnpm lint
pnpm build
git diff --check
```

Expected: every command exits 0. `pnpm test:e2e:admin` starts its own ports 3101/9527 and isolated `.tmp` database. Any unrelated pre-existing WIP failure must be reported separately and must not be hidden by changing assertions.

If a command exposes a defect in Tasks 1–5, stop this task, fix it in the owning task's files with a focused test, commit that fix separately, then restart this verification matrix from the first command.

- [ ] **Step 3: 核对架构禁区**

Run:

```bash
test ! -e pnpm-workspace.yaml
rg -n "localStorage.*(token|refreshToken)|sessionStorage.*(token|refreshToken)" admin-web/src || true
find admin-web -maxdepth 2 -name .git -print
git status --short
```

Expected: root workspace file absent; no token storage matches; no nested `.git`; Git status only contains known pre-existing Payload WIP or intentional uncommitted verification fixes.

- [ ] **Step 4: 提交维护说明和必要验证修复**

```bash
git add admin-web/AGENTERA.md
git commit -m "docs: document Soybean admin workflow"
```

Do not stage or commit the pre-existing Payload styling WIP.

---

## 后续计划边界

本计划通过后，按同一“页面 + service + 单元测试 + 隔离 E2E”模式依次创建三个独立计划：

1. 技能目录、媒体上传、管理员管理；
2. 官方智能体、草稿、发布、下架和版本恢复；
3. 平台总览与明确标记的只读演示模块，以及最终生产 `/admin` 入口切换。

不在第一阶段提前为这些模块建立抽象；只有发现两个真实页面重复相同逻辑后才抽取复用组件。
