# Aera 平台后台部署

本目录只负责平台管理员后台：公开 `/admin/*` 使用 Soybean 静态文件，`/api/*` 转发 Payload。已完成的充值站保持独立部署，不复制到本服务。

1. 运行 `pnpm run build:platform`。
2. 将 `admin-web/dist/` 的内容同步到服务器 `/srv/agentera-admin/public/admin/`。
3. 在仅监听回环或内网地址的 `3100` 端口启动 Payload。
4. 将 `deploy/nginx/agentera-admin.conf` 放入 Nginx 配置，替换域名并启用 TLS。
5. 运行 `nginx -t` 后再平滑重载。

生产环境不要公开 Payload 原生 `/admin`。详细备份、验证与回滚步骤见 `docs/operations/platform-admin-runbook.md`。

公司内部 Beta 不使用上面的公网 Nginx 拓扑。它只接受
`Admin candidate` 工作流签出的不可变 GHCR digest，并通过
`deploy/compose.internal-beta.yaml` 把 Soybean 网关绑定到主机回环地址；
Payload 仍只在 Docker 私有网络。完整候选、校验、SSH 隧道和回滚步骤见
`docs/operations/internal-beta-delivery.md`。
