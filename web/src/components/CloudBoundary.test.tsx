import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { APIError } from '../api/client';
import { CloudBoundary } from './CloudBoundary';

describe('CloudBoundary', () => {
  it.each([
    ['CLOUD_NOT_CONFIGURED', 'Cloud 管理服务尚未配置'],
    ['CLOUD_UNAVAILABLE', 'Cloud 管理服务暂时不可用'],
    ['CLOUD_CONTRACT_VIOLATION', 'Cloud 安全契约异常'],
  ])('renders %s without metric children', (code, message) => {
    render(
      <CloudBoundary error={new APIError(503, code, 'safe')} empty={false} onRetry={vi.fn()}>
        <span>42</span>
      </CloudBoundary>,
    );
    expect(screen.getByText(message)).toBeVisible();
    expect(screen.queryByText('42')).not.toBeInTheDocument();
  });

  it('renders children only for a successful non-empty result', () => {
    render(
      <CloudBoundary error={null} empty={false} onRetry={vi.fn()}>
        <span>安全结果</span>
      </CloudBoundary>,
    );
    expect(screen.getByText('安全结果')).toBeVisible();
  });

  it('renders the explicit empty state', () => {
    render(
      <CloudBoundary error={null} empty onRetry={vi.fn()}>
        <span>42</span>
      </CloudBoundary>,
    );
    expect(screen.getByText('没有符合条件的数据')).toBeVisible();
    expect(screen.queryByText('42')).not.toBeInTheDocument();
  });
});
