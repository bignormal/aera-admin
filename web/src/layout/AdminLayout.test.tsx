import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { AdminLayout } from './AdminLayout';

describe('AdminLayout', () => {
  it('renders the approved phase-one navigation', () => {
    render(
      <MemoryRouter>
        <AdminLayout />
      </MemoryRouter>,
    );

    const menu = within(screen.getByRole('menu'));
    for (const label of [
      '工作台',
      '内部管理员',
      '角色与权限',
      '用户与访问',
      '设备与会话',
      '处置审批',
      '审计记录',
      '服务健康',
    ]) {
      expect(menu.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText('Aera Admin')).toBeInTheDocument();
    expect(screen.getByText('内部运营控制台')).toBeInTheDocument();
  });
});
