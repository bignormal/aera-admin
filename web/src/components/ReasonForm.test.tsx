import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ReasonForm } from './ReasonForm';

describe('ReasonForm', () => {
  it.each([
    ['工单编号', 'owner@example.test'],
    ['工单编号', '13800138000'],
    ['补充说明', 'Bearer secret-canary'],
  ])('rejects sensitive text in %s', async (label, value) => {
    const onSubmit = vi.fn();
    render(<ReasonForm category="device" submitLabel="确认撤销" onSubmit={onSubmit} />);
    const user = userEvent.setup();

    await user.click(screen.getByLabelText('标准原因'));
    await user.click(await screen.findByText('设备遗失'));
    await user.type(screen.getByLabelText(label), value);
    await user.click(screen.getByRole('button', { name: '确认撤销' }));

    expect(await screen.findByText('请勿填写邮箱、手机号、令牌、Cookie 或私钥')).toBeVisible();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
