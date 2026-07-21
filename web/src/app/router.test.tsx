import { render, screen } from '@testing-library/react';
import { RouterProvider } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { createAppRouter } from './router';

describe('application router', () => {
  it('renders the security-foundation dashboard without invented metrics', () => {
    render(<RouterProvider router={createAppRouter(['/dashboard'])} />);

    expect(screen.getByRole('heading', { name: '内部运营工作台' })).toBeInTheDocument();
    expect(screen.getByText('管理员安全底座')).toBeInTheDocument();
    expect(screen.getByText('Aera Cloud 管理链路')).toBeInTheDocument();
    expect(screen.getByText('尚未接入')).toBeInTheDocument();
    expect(screen.queryByText(/活跃用户数/)).not.toBeInTheDocument();
  });
});
