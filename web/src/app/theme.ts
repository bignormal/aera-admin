import type { ThemeConfig } from 'antd';

export const aeraTheme: ThemeConfig = {
  token: {
    colorPrimary: '#1677ff',
    colorBgLayout: '#f5f7fb',
    colorText: '#182230',
    colorTextSecondary: '#667085',
    borderRadius: 6,
    fontSize: 14,
    controlHeight: 34,
  },
  components: {
    Layout: {
      bodyBg: '#f5f7fb',
      headerBg: '#ffffff',
      siderBg: '#0b1426',
    },
    Menu: {
      darkItemBg: '#0b1426',
      darkItemSelectedBg: '#1677ff',
      darkItemHoverBg: '#17233b',
      itemHeight: 42,
    },
    Table: {
      cellPaddingBlock: 10,
      cellPaddingInline: 12,
      headerBg: '#f8fafc',
    },
  },
};
