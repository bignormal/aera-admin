# AgentEra Soybean + Payload 正式后台简化设计

日期：2026-07-16
状态：已确认，简单路线优先

## 1. 核心决定

正式平台后台使用 Soybean Admin，现有 Payload 保留为数据和管理后端。

本项目的最高优先级是路线简单。第一阶段只建立一条最短链路：

```text
Soybean 页面 -> Payload REST API -> 现有 Payload 集合与 SQLite
```

不增加 BFF、共享 contracts 包、新权限系统、GraphQL、微服务或 Payload 目录重构。

## 2. 目标

- 面向平台管理员的正式页面全部使用 Soybean Admin。
- Payload 继续负责登录、权限、数据、上传、草稿、版本和发布。
- Soybean 直接调用 Payload 已有 REST API。
- 保留 Payload Admin 作为内部维护入口，但不再继续扩展它的正式产品页面。
- 按模块逐步替换，任何阶段都能继续使用 Payload Admin 维护真实数据。

## 3. 非目标

- 不移动现有 Payload/Next 源码目录。
- 不修改数据库结构。
- 不重写认证或权限。
- 不建立 pnpm 根工作区或公共类型包。
- 不修改 Payload Admin 当前 `/admin` 路由。
- 不一次迁移所有模块后才验证。
- 不接入尚未存在的用户、租户、计费或 Runtime 服务接口。

## 4. 最简单的仓库结构

```text
agentera-claw-admin/
├── admin-web/               # 独立 Soybean Admin 前端
│   ├── package.json
│   ├── pnpm-lock.yaml
│   └── src/
├── src/                     # 现有 Payload/Next 后端，保持不动
├── package.json             # 现有 Payload 脚本，保持兼容
└── tests/
```

`admin-web` 是仓库内的独立前端工程。它使用自己的依赖和锁文件，不要求把现有 Payload 项目改造成 monorepo。

根 `package.json` 只增加方便启动的代理脚本，例如：

- `dev:payload`：启动现有 Payload；
- `dev:admin`：进入 `admin-web` 启动 Soybean；
- `build:admin`：构建 Soybean。

## 5. Soybean 接入方式

以官方 Soybean Admin 当前版本为基础，保留其现成能力：

- Vue 3、Vite、TypeScript；
- Soybean 布局和主题；
- Pinia；
- Naive UI 与 UnoCSS；
- 文件路由、登录页、异常页和移动端布局。

只删除明显无关的演示菜单和 Mock 请求，不进行大规模框架改造。首期不设计上游同步工具，依赖由 `admin-web/pnpm-lock.yaml` 固定。

保留 Soybean 的 MIT 许可证与版权声明。

## 6. 开发和生产路由

### 6.1 本地开发

- Payload：`http://localhost:3100`
- Soybean：独立 Vite 端口
- Soybean 的 Vite 配置把 `/api` 代理到 `http://localhost:3100`
- 正式页面从 Soybean 端口打开
- Payload 内部后台仍可从 `http://localhost:3100/admin` 打开

这样不需要修改 Payload Admin 路由，也不会发生本地路由冲突。

### 6.2 生产部署

生产环境通过反向代理保持同源：

```text
/admin/* -> Soybean 静态页面
/api/*   -> Payload/Next
```

Payload Admin 不通过正式 `/admin` 入口对外暴露。需要兜底时，通过内部地址直接访问 Payload 服务原有 `/admin`。

迁移期间 Soybean 先使用独立预览地址验证，不提前占用生产 `/admin`。登录、分类、技能、媒体、管理员和官方智能体等真实管理模块迁移完成并通过验收后，再一次性把正式 `/admin` 切换到 Soybean；切换前 Payload Admin 仍是正式入口。

第一阶段只准备可部署构建，不实现具体云平台发布脚本。

## 7. 认证

Soybean 直接使用 Payload 已有管理员认证接口：

- 登录：`POST /api/admins/login`
- 当前管理员：`GET /api/admins/me`
- 退出：`POST /api/admins/logout`

规则：

- 使用 Payload 设置的 HttpOnly Cookie；
- 所有请求使用 `credentials: 'include'`；
- 前端不把 token 写入 `localStorage`；
- 应用启动时调用 `me` 恢复登录状态；
- `401` 跳转登录，`403` 显示无权限提示；
- 网络错误不伪装成退出登录。

开发环境通过 Vite 同源代理访问 `/api`，因此首期不增加额外跨域认证方案。

## 8. 权限

首期直接使用现有角色字段和服务端访问控制：

- `super_admin`：全部真实管理模块；
- `publisher`：官方智能体、分类、技能和媒体；
- 管理员管理只对 `super_admin` 展示。

Soybean 中只维护一个简单的菜单角色映射。Payload 服务端现有 `access` 函数继续决定每个 API 请求是否允许。

不在首期接入 `/api/access` 生成动态菜单，也不建立新的 RBAC 编辑器。需要更细权限时再单独升级。

## 9. API 代码边界

前端只增加一个小型请求层：

```text
admin-web/src/service/
├── http.ts                  # fetch、credentials、JSON 和统一错误
├── auth.ts                  # login、me、logout
├── categories.ts            # 分类 CRUD
├── skills.ts                # 技能 CRUD
├── media.ts                 # 媒体 CRUD 与上传
├── admins.ts                # 管理员 CRUD
└── agents.ts                # 智能体、草稿、发布和版本
```

页面不直接散落 `fetch`。每个 service 只定义当前页面真正需要的 TypeScript 输入输出，不提前建设通用 SDK 或代码生成系统。

统一错误格式仅在 `http.ts` 内转换为：

```ts
type ApiError = {
  status: number
  message: string
  fieldErrors?: Record<string, string>
}
```

## 10. 页面结构

```text
admin-web/src/
├── layouts/                 # Soybean 布局
├── router/                  # 页面路由和简单角色守卫
├── store/                   # 登录管理员和主题状态
├── service/                 # Payload REST 请求
├── views/
│   ├── auth/
│   ├── dashboard/
│   ├── categories/
│   ├── skills/
│   ├── media/
│   ├── admins/
│   ├── agents/
│   └── platform-demo/
└── components/              # 真正复用后再抽取的组件
```

不提前设计复杂领域层。只有当两个页面出现相同逻辑时才抽取复用代码。

## 11. 最简单的迁移顺序

### 第一步：可运行基础

- 引入并启动 Soybean；
- 删除无关演示菜单；
- 应用 AgentEra 标志、名称和现有导航；
- 接通 Payload 登录、`me` 和退出；
- 保证桌面和移动端外壳可用。

### 第二步：分类完整 CRUD

- 分类列表；
- 搜索、分页和排序；
- 创建、编辑和删除；
- Payload 字段错误展示；
- `super_admin` 与 `publisher` 都可正常管理。

分类是首个真实切片。它能用最少字段验证完整登录、查询、表单和写入链路。

### 第三步：标准模块

- 技能目录；
- 媒体资源和上传；
- 管理员与账户。

### 第四步：官方智能体

- 列表与状态；
- 分类、技能和媒体关联；
- 草稿、发布、下架；
- 版本查看与恢复。

### 第五步：平台页面

- 迁移现有平台总览；
- 迁移只读演示模块；
- 保留明确的“演示数据”标记。

## 12. 测试

保持测试数量适中，只覆盖高价值边界。

### Payload

- 保留现有集成测试；
- 不因 Soybean 重写已有后端测试。

### Soybean

- `http.ts` 的 401、403、字段错误转换；
- auth store 的登录、恢复和退出；
- 分类查询参数和表单数据转换。

### 端到端

- 匿名用户进入登录页；
- 登录后进入 Soybean 外壳；
- 分类创建、编辑和删除；
- 发布员看不到管理员管理；
- 手机宽度下菜单和页面无整体横向溢出；
- Payload 内部后台仍可直接访问。

E2E 必须使用独立 `.tmp` SQLite 数据库，不能复用真实开发数据库服务器。

## 13. 当前未提交工作处理

当前 Payload Soybean 换肤改动完整保留，不回退、不覆盖。它继续改善内部 Payload Admin 的可用性，但不再扩展为正式后台。

新 Soybean 工程只写入 `admin-web` 和必要的根启动脚本，避免与现有 Payload UI 文件混改。

## 14. 成功标准

- 可以用一个命令分别启动 Payload 和 Soybean；
- 管理员能通过 Soybean 登录 Payload；
- 分类 CRUD 使用真实 SQLite 数据；
- 服务端权限继续有效；
- Payload Admin 仍可作为内部兜底；
- 没有 BFF、公共 contracts 包、新认证或新权限系统；
- 后续模块只需重复清晰的“页面 + service”模式。

## 15. 参考

- Soybean Admin：<https://github.com/soybeanjs/soybean-admin>
- Soybean 文档：<https://docs.soybeanjs.cn/>
- Payload Cookie 认证：<https://payloadcms.com/docs/authentication/cookies>
- Payload 认证操作：<https://payloadcms.com/docs/authentication/operations>
- Payload REST API：<https://payloadcms.com/docs/rest-api/overview>
