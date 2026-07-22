import { useQuery } from '@tanstack/react-query';

import {
  newIdempotencyKey,
  postIdempotentJSON,
  putIdempotentJSON,
  request,
} from './client';
import type {
  CreateReasonCodeInput,
  ReasonCategory,
  ReasonCodeMutationResult,
  ReasonCodePage,
  ReasonUsage,
  SecurityPolicy,
  SecurityPolicyMutationResult,
  UpdateReasonCodeInput,
  UpdateSecurityPolicyInput,
} from './contracts';

interface ReasonCodeQuery {
  usage?: ReasonUsage;
  category?: ReasonCategory;
  includeInactive?: boolean;
}

export function listReasonCodes(query: ReasonCodeQuery): Promise<ReasonCodePage> {
  const parameters = new URLSearchParams();
  if (query.usage) parameters.set('usage', query.usage);
  if (query.category) parameters.set('category', query.category);
  if (query.includeInactive) parameters.set('include_inactive', 'true');
  const encoded = parameters.toString();
  return request<ReasonCodePage>(`/system/reason-codes${encoded ? `?${encoded}` : ''}`);
}

export function useReasonCodes(usage: ReasonUsage, enabled = true) {
  return useQuery({
    queryKey: ['reason-codes', usage],
    queryFn: () => listReasonCodes({ usage }),
    enabled,
    retry: false,
    staleTime: 30_000,
  });
}

export function getSecurityPolicy(): Promise<SecurityPolicy> {
  return request<SecurityPolicy>('/system/settings');
}

export function updateSecurityPolicy(
  input: UpdateSecurityPolicyInput,
  idempotencyKey = newIdempotencyKey(),
): Promise<SecurityPolicyMutationResult> {
  return putIdempotentJSON<SecurityPolicyMutationResult>(
    '/system/settings/security-policy',
    input,
    idempotencyKey,
  );
}

export function createReasonCode(
  input: CreateReasonCodeInput,
  idempotencyKey = newIdempotencyKey(),
): Promise<ReasonCodeMutationResult> {
  return postIdempotentJSON<ReasonCodeMutationResult>(
    '/system/reason-codes',
    input,
    idempotencyKey,
  );
}

export function updateReasonCode(
  code: string,
  input: UpdateReasonCodeInput,
  idempotencyKey = newIdempotencyKey(),
): Promise<ReasonCodeMutationResult> {
  return putIdempotentJSON<ReasonCodeMutationResult>(
    `/system/reason-codes/${encodeURIComponent(code)}`,
    input,
    idempotencyKey,
  );
}
