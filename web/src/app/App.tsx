import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from 'react-router-dom';

import { AuthProvider } from '../auth/AuthProvider';
import { createAppRouter } from './router';
import { aeraTheme } from './theme';

const router = createAppRouter();
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnReconnect: true },
    mutations: { retry: false },
  },
});

export function App() {
  return (
    <ConfigProvider locale={zhCN} theme={aeraTheme}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>
    </ConfigProvider>
  );
}
