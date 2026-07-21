import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActivatePage } from './ActivatePage';

function LocationProbe() {
  const location = useLocation();
  return <output aria-label="当前地址">{`${location.pathname}${location.search}${location.hash}`}</output>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
});

describe('ActivatePage', () => {
  it('extracts and clears the fragment before preparing a masked activation', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) !== '/api/v1/auth/activation/prepare') {
          throw new Error(`unexpected request: ${String(input)}`);
        }
        if (typeof init?.body === 'string') bodies.push(init.body);
        return new Response(
          JSON.stringify({
            admin_id: '019f0000-0000-7000-8000-000000000001',
            display_name: '安全管理员',
            masked_identity: 'a***@example.com',
            purpose: 'activation',
            provisioning_uri: 'otpauth://totp/Aera%20Admin:a%2A%2A%2A%40example.com?secret=ABC123&issuer=Aera%20Admin',
            expires_at: '2026-07-21T11:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/activate#token=raw-invitation-token']}>
          <Routes>
            <Route
              path="/activate"
              element={
                <>
                  <ActivatePage />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('a***@example.com')).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText('当前地址')).toHaveTextContent('/activate'));
    expect(screen.getByLabelText('当前地址')).not.toHaveTextContent('raw-invitation-token');
    expect(bodies).toEqual([JSON.stringify({ token: 'raw-invitation-token' })]);
    expect(window.localStorage).toHaveLength(0);
    expect(window.sessionStorage).toHaveLength(0);
  });

  it('clears submitted secrets and displays recovery codes exactly once', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input);
        if (path === '/api/v1/auth/activation/prepare') {
          return new Response(
            JSON.stringify({
              admin_id: '019f0000-0000-7000-8000-000000000001',
              display_name: '安全管理员',
              masked_identity: 'a***@example.com',
              purpose: 'activation',
              provisioning_uri: 'otpauth://totp/Aera%20Admin:masked?secret=ABC123&issuer=Aera%20Admin',
              expires_at: '2026-07-21T11:00:00Z',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (path === '/api/v1/auth/activate') {
          return new Response(
            JSON.stringify({
              admin_id: '019f0000-0000-7000-8000-000000000001',
              recovery_codes: ['recovery-one', 'recovery-two'],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        throw new Error(`unexpected request: ${path}`);
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('clipboard denied')) },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/activate#token=raw-invitation-token']}>
          <Routes><Route path="/activate" element={<ActivatePage />} /></Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await user.type(await screen.findByLabelText('创建独立密码'), 'correct horse battery staple');
    await user.type(screen.getByLabelText('确认密码'), 'correct horse battery staple');
    await user.type(screen.getByLabelText('动态验证码'), '123456');
    await user.click(screen.getByRole('button', { name: /完\s*成\s*安\s*全\s*激\s*活/ }));

    expect(await screen.findByText('recovery-one')).toBeVisible();
    expect(screen.getByText('recovery-two')).toBeVisible();
    expect(screen.queryByLabelText('创建独立密码')).not.toBeInTheDocument();
    expect(window.localStorage).toHaveLength(0);
    expect(window.sessionStorage).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: /复制全部恢复码/ }));
    expect(await screen.findByText('复制失败，请手动选择并保存恢复码')).toBeVisible();
  });
});
