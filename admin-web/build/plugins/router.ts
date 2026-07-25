import type { RouteMeta } from 'vue-router';
import ElegantVueRouter from '@elegant-router/vue/vite';
import type { RouteKey } from '@elegant-router/types';

export function setupElegantRouter() {
  return ElegantVueRouter({
    layouts: {
      base: 'src/layouts/base-layout/index.vue',
      blank: 'src/layouts/blank-layout/index.vue'
    },
    routePathTransformer(routeName, routePath) {
      const key = routeName as RouteKey;

      if (key === 'login') {
        const modules: UnionKey.LoginModule[] = ['pwd-login', 'code-login', 'register', 'reset-pwd', 'bind-wechat'];

        const moduleReg = modules.join('|');

        return `/login/:module(${moduleReg})?`;
      }

      return routePath;
    },
    onRouteMetaGen(routeName) {
      const key = routeName as RouteKey;

      const constantRoutes: RouteKey[] = ['login', '403', '404', '500'];

      const meta: Partial<RouteMeta> = {
        title: key,
        i18nKey: `route.${key}` as App.I18n.I18nKey
      };

      if (constantRoutes.includes(key)) {
        meta.constant = true;
      }

      const routeMeta: Record<string, Partial<RouteMeta>> = {
        home: { capability: 'dashboard:read', icon: 'mdi:monitor-dashboard', order: 1 },
        agents: { capability: 'content:agents:read', icon: 'mdi:robot-outline', order: 10 },
        categories: { capability: 'content:categories:read', icon: 'material-symbols:folder-outline', order: 11 },
        skills: { capability: 'content:skills:read', icon: 'mdi:puzzle-star-outline', order: 12 },
        plugins: { capability: 'content:plugins:read', icon: 'mdi:power-plug-outline', order: 13 },
        media: { capability: 'content:media:read', icon: 'mdi:image-multiple-outline', order: 14 },
        pets: { capability: 'content:pets:read', icon: 'mdi:cat', order: 15 },
        publishing: { capability: 'content:publish:read', icon: 'mdi:rocket-launch-outline', order: 16 },
        operations: { capability: 'operations:read', icon: 'mdi:chart-timeline-variant', order: 40 },
        operations_overview: { capability: 'operations:read' },
        operations_traffic: { capability: 'operations:read' },
        operations_diagnostics: { capability: 'operations:read' },
        operations_alerts: { capability: 'operations:read' },
        'operations_usage-logs': { capability: 'operations:read' },
        security: { capability: 'operations:read', icon: 'mdi:shield-lock-outline', order: 50 },
        security_risk: { capability: 'operations:read' },
        runtime: { capability: 'runtime:read', icon: 'mdi:server-outline', order: 60 },
        runtime_commands: { capability: 'runtime:read' },
        runtime_events: { capability: 'runtime:read' },
        runtime_instances: { capability: 'runtime:read' },
        runtime_operations: { capability: 'runtime:read' },
        runtime_releases: { capability: 'runtime:read' },
        audit: { capability: 'audit:read', icon: 'mdi:history', order: 70 },
        system: { capability: 'system:read', icon: 'mdi:cog-outline', order: 80 },
        system_data: { capability: 'system:read' },
        system_settings: { capability: 'system:read' },
        admins: { capability: 'admins:read', icon: 'mdi:shield-account-outline', order: 90 }
      };
      Object.assign(meta, routeMeta[key]);

      return meta;
    }
  });
}
