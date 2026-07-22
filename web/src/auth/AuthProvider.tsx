import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from 'react';

import { APIError, postJSON, request, setSessionCSRF, setUnauthorizedHandler } from '../api/client';
import { isSessionDocument, type SessionDocument } from '../api/contracts';

const sessionQueryKey = ['administrator-session'] as const;

interface AuthContextValue {
  session: SessionDocument | null;
  loading: boolean;
  unavailable: boolean;
  establishSession: (session: SessionDocument) => Promise<void>;
  refreshSession: () => Promise<SessionDocument | null>;
  clearSession: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function fetchSession(signal?: AbortSignal): Promise<SessionDocument | null> {
  try {
    const document = await request<SessionDocument>('/me', { signal });
    if (!isSessionDocument(document)) throw new Error('session response is invalid');
    return document;
  } catch (error) {
    if (error instanceof APIError && error.status === 401) return null;
    throw error;
  }
}

export function AuthProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: sessionQueryKey,
    queryFn: ({ signal }) => fetchSession(signal),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });
  const session = sessionQuery.data ?? null;

  useEffect(() => {
    setSessionCSRF(session?.csrf_token ?? null);
  }, [session]);

  useEffect(
    () =>
      setUnauthorizedHandler(() => {
        void queryClient.cancelQueries({ queryKey: sessionQueryKey });
        setSessionCSRF(null);
        queryClient.setQueryData(sessionQueryKey, null);
      }),
    [queryClient],
  );

  const establishSession = useCallback(
    async (document: SessionDocument) => {
      if (!isSessionDocument(document)) throw new Error('session response is invalid');
      await queryClient.cancelQueries({ queryKey: sessionQueryKey });
      setSessionCSRF(document.csrf_token);
      queryClient.setQueryData(sessionQueryKey, document);
    },
    [queryClient],
  );

  const refreshSession = useCallback(async () => {
    const result = await queryClient.fetchQuery({
      queryKey: sessionQueryKey,
      queryFn: ({ signal }) => fetchSession(signal),
      staleTime: 0,
    });
    setSessionCSRF(result?.csrf_token ?? null);
    return result;
  }, [queryClient]);

  const clearSession = useCallback(async () => {
    await queryClient.cancelQueries();
    setSessionCSRF(null);
    queryClient.setQueryData(sessionQueryKey, null);
    for (const key of [
      'activation-preparation', 'administrators', 'admin-operation', 'approval-request',
      'approval-requests', 'audit-events', 'cloud-users', 'cloud-user', 'cloud-user-devices',
      'cloud-user-sessions', 'system-health', 'system-settings', 'reason-codes',
      'official-definitions', 'official-definition', 'official-drafts', 'official-submissions',
      'official-versions', 'official-releases', 'official-rollbacks', 'official-audit',
    ]) {
      queryClient.removeQueries({ queryKey: [key] });
    }
  }, [queryClient]);

  const logout = useCallback(async () => {
    try {
      await postJSON<{ status: string }>('/auth/logout', {});
    } finally {
      await clearSession();
    }
  }, [clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      loading: sessionQuery.isPending,
      unavailable: sessionQuery.isError,
      establishSession,
      refreshSession,
      clearSession,
      logout,
    }),
    [clearSession, establishSession, logout, refreshSession, session, sessionQuery.isError, sessionQuery.isPending],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}
