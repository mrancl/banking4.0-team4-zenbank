import { useEffect, useState } from 'react';
import { api } from './api';
import { ChatStream } from './components/ChatStream';
import { HeaderBar } from './components/HeaderBar';
import { InspectorDrawer } from './components/InspectorDrawer';
import { ProfileSidebar } from './components/ProfileSidebar';
import type {
  CustomerId,
  DemoScenario,
  HealthResponse,
  SessionPublicState,
} from './types';

export function App() {
  const [session, setSession] = useState<SessionPublicState | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const [h, s] = await Promise.all([api.getHealth(), api.getSession()]);
        setHealth(h);
        setSession(s);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Conexiunea la server a eșuat');
      }
    })();
  }, []);

  const activeTxId = session?.activeVerification?.transactionId ?? null;

  useEffect(() => {
    if (!activeTxId) {
      return;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const next = await api.pollVerification(activeTxId);
        if (!cancelled) {
          setSession(next);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Verificarea statusului a eșuat');
        }
      }
    };

    const intervalId = window.setInterval(() => {
      void poll();
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeTxId]);

  const runAction = async (fn: () => Promise<SessionPublicState>) => {
    setLoading(true);
    setError(null);
    try {
      const next = await fn();
      setSession(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Operațiunea a eșuat');
    } finally {
      setLoading(false);
    }
  };

  if (!session) {
    return (
      <div className="app-shell" style={{ padding: 40, textAlign: 'center' }}>
        {error ? (
          <div className="restriction-alert" style={{ maxWidth: 480, margin: '0 auto' }}>
            {error}
          </div>
        ) : (
          <p>Se încarcă spațiul ZenBank EUDI…</p>
        )}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <HeaderBar
        customerId={session.customer.id}
        scenario={session.scenario}
        trustChecks={session.lastTrustChecks}
        verifierMode={health?.verifierMode}
        profileCode={health?.profileCode}
        loading={loading}
        onSwitchScenario={(cid: CustomerId, sc: DemoScenario) =>
          void runAction(() => api.switchScenario(cid, sc))
        }
        onReset={() => void runAction(() => api.resetDemo())}
        onOpenInspector={() => setInspectorOpen(true)}
      />

      {error && (
        <div
          className="restriction-alert"
          style={{ maxWidth: 1240, margin: '12px auto 0', width: 'calc(100% - 40px)' }}
        >
          <strong>Eroare:</strong> {error}
        </div>
      )}

      <main className="workspace">
        <ProfileSidebar
          customer={session.customer}
          loading={loading}
          onQuickPrompt={(message, quickAction) =>
            void runAction(() => api.sendChat(message, quickAction))
          }
        />

        <ChatStream
          messages={session.messages}
          loading={loading}
          activeTransactionId={activeTxId}
          onSendChat={(message) => void runAction(() => api.sendChat(message))}
          onStartVerification={() => void runAction(() => api.startVerification())}
          onConfirmUpdate={(pendingUpdateId, mode) =>
            void runAction(() => api.confirmUpdate(pendingUpdateId, mode))
          }
          onRetryVerification={() => void runAction(() => api.startVerification())}
        />
      </main>

      <InspectorDrawer
        open={inspectorOpen}
        onClose={() => setInspectorOpen(false)}
        trustChecks={session.lastTrustChecks}
        zeroPiiContext={session.lastZeroPiiContext}
        auditLog={session.auditLog}
        securityBadges={session.securityBadges}
        loading={loading}
        onSimulateUnhappy={(kind) =>
          void runAction(async () => {
            const next = await api.simulateUnhappy(kind);
            setInspectorOpen(false);
            return next;
          })
        }
      />
    </div>
  );
}

export default App;
