# AgentEra 平台后台部署

本目录只负责平台管理员后台：公开 `/admin/*` 使用 Soybean 静态文件，`/api/*` 转发 Payload。已完成的充值站保持独立部署，不复制到本服务。

1. 运行 `pnpm run build:platform`。
2. 将 `admin-web/dist/` 的内容同步到服务器 `/srv/agentera-admin/public/admin/`。
3. 在仅监听回环或内网地址的 `3100` 端口启动 Payload。
4. 将 `deploy/nginx/agentera-admin.conf` 放入 Nginx 配置，替换域名并启用 TLS。
5. 运行 `nginx -t` 后再平滑重载。

生产环境不要公开 Payload 原生 `/admin`。详细备份、验证与回滚步骤见 `docs/operations/platform-admin-runbook.md`。
