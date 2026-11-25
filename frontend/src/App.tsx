import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageCircle, User, X } from 'lucide-react';
import { api } from './api';
import { ChatStream } from './components/ChatStream';
import { HeaderBar, type MobileTab } from './components/HeaderBar';
import { HomeTab } from './components/HomeTab';
import type {
  CustomerId,
  SessionPublicState,
  VerificationLaunchMode,
  VerificationScope,
} from './types';

declare global {
  interface Window {
    __zenbankHandleEudiCallback?: (
      responseCode?: string | null,
      walletError?: string | null,
    ) => void;
    __zenbankPendingEudiCallback?: {
      responseCode?: string | null;
      walletError?: string | null;
    };
  }
}

const ACTIVE_TX_STORAGE_KEY = 'zenbank_active_tx_id';

function detectAndroidWrapper(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('client') === 'android' || navigator.userAgent.includes('ZenBankAndroid')) {
      window.sessionStorage.setItem('zenbank_client', 'android');
      return true;
    }
    return window.sessionStorage.getItem('zenbank_client') === 'android';
  } catch {
    return navigator.userAgent.includes('ZenBankAndroid');
  }
}

function extractCallbackParams(): { responseCode: string | null; walletError: string | null } {
  if (typeof window === 'undefined') {
    return { responseCode: null, walletError: null };
  }
  const searchParams = new URLSearchParams(window.location.search);
  const hashRaw = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const hashQuery = hashRaw.includes('?') ? hashRaw.slice(hashRaw.indexOf('?') + 1) : hashRaw;
  const hashParams = new URLSearchParams(hashQuery);

  const responseCode =
    hashParams.get('response_code') ?? searchParams.get('response_code') ?? null;
  const walletError =
    hashParams.get('error_description') ??
    hashParams.get('error') ??
    searchParams.get('error_description') ??
    searchParams.get('error') ??
    null;

  return {
    responseCode: responseCode?.trim() || null,
    walletError: walletError?.trim() || null,
  };
}

export function App() {
  const [session, setSession] = useState<SessionPublicState | null>(null);
  const [sessionReady, setSessionReady] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<MobileTab>('home');
  const [profileFlowOpen, setProfileFlowOpen] = useState(false);
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(() => new Set());
  const [isAndroidWrapper] = useState<boolean>(() => detectAndroidWrapper());
  const [webReturnUriConfigured, setWebReturnUriConfigured] = useState(false);
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return window.localStorage.getItem('zenbank_theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem('zenbank_theme', theme);
    } catch {
      // ignore storage errors
    }
  }, [theme]);

  const activeTxId = session?.activeVerification?.transactionId ?? null;
  const activeTxRef = useRef<string | null>(null);
  activeTxRef.current = activeTxId;
  const pollErrorRef = useRef(false);

  useEffect(() => {
    try {
      if (activeTxId) {
        window.localStorage.setItem(ACTIVE_TX_STORAGE_KEY, activeTxId);
      } else if (session) {
        window.localStorage.removeItem(ACTIVE_TX_STORAGE_KEY);
      }
    } catch {
      // ignore storage errors
    }
  }, [activeTxId, session]);

  const runAction = useCallback(async (fn: () => Promise<SessionPublicState>) => {
    setLoading(true);
    setError(null);
    pollErrorRef.current = false;
    try {
      const next = await fn();
      setSession(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operațiunea a eșuat');
    } finally {
      setLoading(false);
    }
  }, []);

  const handleCancelFlow = useCallback(() => {
    pollErrorRef.current = false;
    void runAction(async () => {
      const next = await api.cancelFlow('USER_CANCELLED');
      try {
        window.localStorage.removeItem(ACTIVE_TX_STORAGE_KEY);
      } catch {
        // ignore storage errors
      }
      if (next.flowChannel === null) {
        setProfileFlowOpen(false);
      }
      return next;
    });
  }, [runAction]);

  const handleEudiCallback = useCallback(
    (responseCode?: string | null, walletError?: string | null) => {
      const code = responseCode?.trim();
      const errMsg = walletError?.trim();
      const savedTxId = (() => {
        if (activeTxRef.current) return activeTxRef.current;
        try {
          return window.localStorage.getItem(ACTIVE_TX_STORAGE_KEY) || undefined;
        } catch {
          return undefined;
        }
      })();

      if (code) {
        void runAction(async () => {
          const next = await api.claimVerification(code, savedTxId);
          try {
            window.localStorage.removeItem(ACTIVE_TX_STORAGE_KEY);
          } catch {
            // ignore storage errors
          }
          if (next.flowChannel === 'profile') {
            setProfileFlowOpen(true);
            setActiveTab('home');
          } else if (next.flowChannel === 'chat') {
            setProfileFlowOpen(false);
            setActiveTab('chat');
          }
          return next;
        });
        return;
      }

      if (errMsg) {
        void runAction(async () => {
          let next = savedTxId
            ? await api.pollVerification(savedTxId).catch(() => null)
            : null;
          if (!next || next.stage === 'AWAITING_WALLET') {
            next = await api.cancelFlow('WALLET_DECLINED', `EUDI Wallet: ${errMsg}`);
          }
          try {
            window.localStorage.removeItem(ACTIVE_TX_STORAGE_KEY);
          } catch {
            // ignore storage errors
          }
          if (next.flowChannel === 'profile') {
            setProfileFlowOpen(true);
            setActiveTab('home');
          } else if (next.flowChannel === 'chat') {
            setProfileFlowOpen(false);
            setActiveTab('chat');
          }
          return next;
        });
        return;
      }

      if (savedTxId) {
        void api
          .pollVerification(savedTxId)
          .then((next) => {
            if (pollErrorRef.current) {
              pollErrorRef.current = false;
              setError(null);
            }
            setSession(next);
          })
          .catch((err) => {
            pollErrorRef.current = true;
            setError(err instanceof Error ? err.message : 'Verificarea statusului a eșuat');
          });
      }
    },
    [runAction],
  );

  const callbackRef = useRef(handleEudiCallback);
  callbackRef.current = handleEudiCallback;

  useEffect(() => {
    if (!sessionReady) {
      return;
    }
    window.__zenbankHandleEudiCallback = (responseCode, walletError) => {
      callbackRef.current(responseCode, walletError);
    };
    const pending = window.__zenbankPendingEudiCallback;
    if (pending) {
      delete window.__zenbankPendingEudiCallback;
      callbackRef.current(pending.responseCode, pending.walletError);
    }
    return () => {
      delete window.__zenbankHandleEudiCallback;
    };
  }, [sessionReady]);

  useEffect(() => {
    void (async () => {
      try {
        const [health, s] = await Promise.all([
          api.getHealth().catch(() => null),
          api.getSession(),
        ]);
        if (health) {
          setWebReturnUriConfigured(Boolean(health.webReturnUriConfigured));
        }
        setSession(s);
        setSessionReady(true);

        const { responseCode, walletError } = extractCallbackParams();
        if (responseCode || walletError) {
          window.history.replaceState({}, '', isAndroidWrapper ? '/?client=android' : '/');
          callbackRef.current(responseCode, walletError);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Conexiunea la server a eșuat');
      }
    })();
  }, [isAndroidWrapper]);

  useEffect(() => {
    if (!activeTxId) {
      return;
    }

    let cancelled = false;
    let inFlight = false;

    const poll = async () => {
      if (cancelled || inFlight) {
        return;
      }
      inFlight = true;
      try {
        const next = await api.pollVerification(activeTxId);
        if (!cancelled) {
          if (pollErrorRef.current) {
            pollErrorRef.current = false;
            setError(null);
          }
          setSession(next);
        }
      } catch (err) {
        if (!cancelled && document.visibilityState !== 'hidden') {
          pollErrorRef.current = true;
          setError(err instanceof Error ? err.message : 'Verificarea statusului a eșuat');
        }
      } finally {
        inFlight = false;
      }
    };

    const handleResume = () => {
      if (document.visibilityState === 'visible') {
        void poll();
      }
    };

    const handleFocus = () => {
      void poll();
    };

    const intervalId = window.setInterval(() => {
      void poll();
    }, 2000);

    document.addEventListener('visibilitychange', handleResume);
    window.addEventListener('focus', handleFocus);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleResume);
      window.removeEventListener('focus', handleFocus);
    };
  }, [activeTxId]);

  const launchMode: VerificationLaunchMode = isAndroidWrapper
    ? 'same_device_native'
    : webReturnUriConfigured && /android/i.test(navigator.userAgent)
      ? 'same_device_web'
      : 'cross_device';

  if (!session) {
    return (
      <div className="viewport-stage">
        <div className="mobile-frame">
          <div className="mobile-loading">
            {error ? (
              <div className="restriction-card" style={{ width: '100%' }}>
                {error}
              </div>
            ) : (
              <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Se încarcă ZenBank…</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  const hasOngoingStep = Boolean(activeTxId) || session.stage === 'DIFF_READY';
  const hasProfileAttention =
    session.flowChannel === 'profile' && hasOngoingStep && activeTab !== 'home';
  const hasChatAttention =
    session.flowChannel === 'chat' && hasOngoingStep && activeTab !== 'chat';

  return (
    <div className="viewport-stage">
      <div className="mobile-frame">
        <HeaderBar
          customerId={session.customer.id}
          activeTab={activeTab}
          theme={theme}
          loading={loading}
          onToggleTheme={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
          onSwitchCustomer={(cid: CustomerId) => {
            setConfirmedIds(new Set());
            setProfileFlowOpen(false);
            setActiveTab('home');
            void runAction(() => api.switchScenario(cid, 'data_update'));
          }}
          onReset={() => {
            setConfirmedIds(new Set());
            setProfileFlowOpen(false);
            setActiveTab('home');
            void runAction(() => api.resetDemo());
          }}
        />

        {error && (
          <div className="mobile-error-banner" role="alert">
            <span>
              <strong>Eroare:</strong> {error}
            </span>
            <button
              type="button"
              className="error-dismiss-btn"
              aria-label="Închide eroarea"
              onClick={() => setError(null)}
            >
              <X size={14} />
            </button>
          </div>
        )}

        <main className="mobile-body">
          {activeTab === 'home' && (
            <HomeTab
              customer={session.customer}
              stage={session.stage}
              flowChannel={session.flowChannel}
              activeFlowCard={session.activeFlowCard}
              activeTransactionId={activeTxId}
              confirmedIds={confirmedIds}
              profileFlowOpen={profileFlowOpen}
              isAndroidWrapper={isAndroidWrapper}
              loading={loading}
              onStartProfileUpdate={(scope?: VerificationScope) => {
                void runAction(async () => {
                  const next = await api.startProfileUpdate(scope);
                  setProfileFlowOpen(true);
                  return next;
                });
              }}
              onCloseProfileFlow={() => setProfileFlowOpen(false)}
              onResumeProfileFlow={() => setProfileFlowOpen(true)}
              onStartVerification={() => void runAction(() => api.startVerification(launchMode))}
              onConfirmUpdate={(pendingUpdateId, mode) => {
                void runAction(async () => {
                  const next = await api.confirmUpdate(pendingUpdateId, mode);
                  if (next.stage !== 'DIFF_READY') {
                    setConfirmedIds((prev) => new Set(prev).add(pendingUpdateId));
                  }
                  return next;
                });
              }}
              onRetryVerification={() => void runAction(() => api.startVerification(launchMode))}
              onCancelFlow={handleCancelFlow}
              onOpenChat={() => {
                setProfileFlowOpen(false);
                setActiveTab('chat');
              }}
            />
          )}

          {activeTab === 'chat' && (
            <ChatStream
              messages={session.messages}
              stage={session.stage}
              flowChannel={session.flowChannel}
              loading={loading}
              activeTransactionId={activeTxId}
              confirmedIds={confirmedIds}
              isAndroidWrapper={isAndroidWrapper}
              onSendChat={(message, quickAction, scope) => {
                setProfileFlowOpen(false);
                void runAction(() => api.sendChat(message, quickAction, scope));
              }}
              onStartVerification={() => void runAction(() => api.startVerification(launchMode))}
              onConfirmUpdate={(pendingUpdateId, mode) => {
                void runAction(async () => {
                  const next = await api.confirmUpdate(pendingUpdateId, mode);
                  if (next.stage !== 'DIFF_READY') {
                    setConfirmedIds((prev) => new Set(prev).add(pendingUpdateId));
                  }
                  return next;
                });
              }}
              onRetryVerification={() => void runAction(() => api.startVerification(launchMode))}
              onCancelFlow={handleCancelFlow}
              onGoHome={() => {
                setProfileFlowOpen(false);
                setActiveTab('home');
              }}
            />
          )}
        </main>

        <nav className="mobile-tabbar" aria-label="Navigare aplicație">
          <button
            type="button"
            className={`tab-btn ${activeTab === 'home' ? 'active' : ''}`}
            onClick={() => setActiveTab('home')}
          >
            <span className="tab-icon-wrap">
              <User size={20} />
              {hasProfileAttention && <span className="tab-dot" aria-hidden="true" />}
            </span>
            <span>Datele mele</span>
          </button>

          <button
            type="button"
            className={`tab-btn ${activeTab === 'chat' ? 'active' : ''}`}
            onClick={() => setActiveTab('chat')}
          >
            <span className="tab-icon-wrap">
              <MessageCircle size={20} />
              {hasChatAttention && <span className="tab-dot" aria-hidden="true" />}
            </span>
            <span>Chat</span>
          </button>
        </nav>
      </div>
    </div>
  );
}

export default App;
