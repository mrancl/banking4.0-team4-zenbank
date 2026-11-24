import type {
  CustomerId,
  DemoScenario,
  HealthResponse,
  SessionPublicState,
} from './types';

const SESSION_STORAGE_KEY = 'zenbank_eudi_session_id';

function getSessionId(): string {
  let existing = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (!existing) {
    existing = window.crypto.randomUUID();
    window.localStorage.setItem(SESSION_STORAGE_KEY, existing);
  }
  return existing;
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const sessionId = getSessionId();
  const res = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-Session-Id': sessionId,
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = `Cererea a eșuat (${res.status})`;
    try {
      const err = (await res.json()) as { error?: string; message?: string };
      message = err.error ?? err.message ?? message;
    } catch {
      // ignore non-json errors
    }
    throw new Error(message);
  }

  return (await res.json()) as T;
}

export const api = {
  getHealth(): Promise<HealthResponse> {
    return apiFetch('/api/health');
  },

  getSession(): Promise<SessionPublicState> {
    return apiFetch('/api/session');
  },

  sendChat(
    message: string,
    quickAction?: 'START_DATA_UPDATE' | 'EXPLAIN_PAYMENT_RESTRICTION' | 'EXPLAIN_PRIVACY',
  ): Promise<SessionPublicState> {
    return apiFetch('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ message, quickAction }),
    });
  },

  startVerification(): Promise<SessionPublicState> {
    return apiFetch('/api/verifications/start', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  pollVerification(transactionId: string): Promise<SessionPublicState> {
    return apiFetch(`/api/verifications/${encodeURIComponent(transactionId)}/poll`);
  },

  confirmUpdate(
    pendingUpdateId: string,
    mode: 'UPDATE_PROFILE' | 'UPDATE_ADDRESS' | 'IDENTITY_ONLY',
  ): Promise<SessionPublicState> {
    return apiFetch('/api/profile/confirm-update', {
      method: 'POST',
      body: JSON.stringify({ pendingUpdateId, mode }),
    });
  },

  switchScenario(
    customerId: CustomerId,
    scenario: DemoScenario,
  ): Promise<SessionPublicState> {
    return apiFetch('/api/demo/scenario', {
      method: 'POST',
      body: JSON.stringify({ customerId, scenario }),
    });
  },

  resetDemo(): Promise<SessionPublicState> {
    return apiFetch('/api/demo/reset', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  },

  simulateUnhappy(
    kind: 'DECLINED' | 'WITHHELD_ADDRESS' | 'EXPIRED' | 'WALLET_ERROR',
  ): Promise<SessionPublicState> {
    return apiFetch('/api/demo/simulate-unhappy', {
      method: 'POST',
      body: JSON.stringify({ kind }),
    });
  },
};
