import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { RouterProvider } from 'react-router-dom';

import { createAppRouter } from './router';
import { aeraTheme } from './theme';

const router = createAppRouter();

export function App() {
  return (
    <ConfigProvider locale={zhCN} theme={aeraTheme}>
      <RouterProvider router={router} />
    </ConfigProvider>
  );
}
