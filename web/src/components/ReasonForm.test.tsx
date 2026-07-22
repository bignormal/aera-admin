import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReasonInput, ReasonUsage } from '../api/contracts';
import { ReasonForm } from './ReasonForm';

afterEach(() => vi.unstubAllGlobals());

describe('ReasonForm', () => {
  it('uses only the active server catalog for the requested usage', async () => {
    stubReasonCatalog('account', [
      reason('customer_request', 'account', '客户请求'),
      reason('security_incident', 'security', '安全事件处置'),
      { ...reason('inactive_reason', 'account', '已停用原因'), active: false },
    ]);
    const onSubmit = vi.fn();
    renderReasonForm('account', onSubmit);
    const user = userEvent.setup();

    const select = await screen.findByLabelText('标准原因');
    await waitFor(() => expect(select).toBeEnabled());
    await user.click(select);
    const customerOption = (await screen.findAllByText('客户请求')).at(-1)!;
    const securityOption = screen.getAllByText('安全事件处置').at(-1)!;
    expect(customerOption).toBeInTheDocument();
    expect(securityOption).toBeInTheDocument();
    expect(screen.queryByText('已停用原因')).not.toBeInTheDocument();
    expect(screen.queryByText('设备遗失')).not.toBeInTheDocument();

    await user.click(securityOption);
    await user.click(screen.getByRole('button', { name: '提交申请' }));
    expect(onSubmit).toHaveBeenCalledWith(
      { reason_code: 'security_incident', ticket_reference: '', note: '' },
      expect.anything(),
    );
  });

  it.each([
    ['工单编号', 'owner@example.test'],
    ['工单编号', '13800138000'],
    ['补充说明', 'Bearer secret-canary'],
  ])('rejects sensitive text in %s', async (label, value) => {
    stubReasonCatalog('device', [reason('lost_device', 'device', '设备遗失')]);
    const onSubmit = vi.fn();
    renderReasonForm('device', onSubmit);
    const user = userEvent.setup();

    const select = await screen.findByLabelText('标准原因');
    await waitFor(() => expect(select).toBeEnabled());
    await user.click(select);
    await user.click(await screen.findByText('设备遗失'));
    await user.type(screen.getByLabelText(label), value);
    await user.click(screen.getByRole('button', { name: '确认撤销' }));

    expect(await screen.findByText('请勿填写邮箱、手机号、令牌、Cookie 或私钥')).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('fails closed when the reason service is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'SETTINGS_UNAVAILABLE', message: '原因服务暂时不可用' } }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )));
    renderReasonForm('session', vi.fn());

    expect(await screen.findByText('标准原因暂时不可用，当前操作已禁止提交')).toBeVisible();
    expect(screen.getByRole('button', { name: '确认撤销' })).toBeDisabled();
  });

  it('fails closed when the allowed catalog is empty', async () => {
    stubReasonCatalog('session', []);
    renderReasonForm('session', vi.fn());

    expect(await screen.findByText('暂无适用于此操作的有效标准原因，当前操作已禁止提交')).toBeVisible();
    expect(screen.getByRole('button', { name: '确认撤销' })).toBeDisabled();
  });
});

function renderReasonForm(usage: ReasonUsage, onSubmit: (value: ReasonInput) => void | Promise<void>): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ReasonForm usage={usage} submitLabel={usage === 'account' ? '提交申请' : '确认撤销'} onSubmit={onSubmit} />
    </QueryClientProvider>,
  );
}

function stubReasonCatalog(usage: ReasonUsage, items: unknown[]): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`/api/v1/system/reason-codes?usage=${usage}`);
      return new Response(JSON.stringify({ items, settings_revision: 4 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

function reason(code: string, category: string, label: string) {
  return {
    code,
    category,
    label,
    active: true,
    revision: 1,
    created_at: '2026-07-22T08:00:00Z',
    updated_at: '2026-07-22T08:00:00Z',
  };
}
