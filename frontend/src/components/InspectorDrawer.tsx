import { CheckCircle2, Info, Lock, ShieldAlert, X, XCircle } from 'lucide-react';
import type { AuditEvent, TrustCheckItem, ZeroPiiAgentContext } from '../types';

interface InspectorDrawerProps {
  open: boolean;
  onClose: () => void;
  trustChecks: TrustCheckItem[];
  zeroPiiContext: ZeroPiiAgentContext | null;
  auditLog: AuditEvent[];
  securityBadges: {
    llmPiiExposed: false;
    geminiStoreEnabled: false;
    rawTokensLogged: false;
  };
  loading: boolean;
  onSimulateUnhappy: (kind: 'DECLINED' | 'WITHHELD_ADDRESS' | 'EXPIRED' | 'WALLET_ERROR') => void;
}

function StatusIcon({ status }: { status: TrustCheckItem['status'] }) {
  if (status === 'PASS') return <CheckCircle2 size={14} color="#147a43" />;
  if (status === 'FAIL') return <XCircle size={14} color="#c62828" />;
  if (status === 'WARN') return <ShieldAlert size={14} color="#b35c00" />;
  return <Info size={14} color="#5a6475" />;
}

export function InspectorDrawer({
  open,
  onClose,
  trustChecks,
  zeroPiiContext,
  auditLog,
  securityBadges,
  loading,
  onSimulateUnhappy,
}: InspectorDrawerProps) {
  if (!open) return null;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <strong style={{ fontSize: 15 }}>Inspector Verificare &amp; Zero-PII</strong>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <div className="drawer-body">
          <div className="drawer-section">
            <h4>Garanții de securitate și confidențialitate</h4>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className="badge badge-green">
                <Lock size={11} /> llm_pii_exposed: {String(securityBadges.llmPiiExposed)}
              </span>
              <span className="badge badge-green">
                gemini_store: {String(securityBadges.geminiStoreEnabled)}
              </span>
              <span className="badge badge-green">
                raw_tokens_logged: {String(securityBadges.rawTokensLogged)}
              </span>
            </div>
          </div>

          <div className="drawer-section">
            <h4>Verificări criptografice și reguli bancare</h4>
            {trustChecks.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                Nicio verificare procesată încă în această sesiune.
              </div>
            ) : (
              trustChecks.map((check) => (
                <div key={check.id} className="trust-item">
                  <div className="trust-item-head">
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <StatusIcon status={check.status} />
                      {check.label}
                    </span>
                    <span
                      className={`badge ${
                        check.status === 'PASS'
                          ? 'badge-green'
                          : check.status === 'FAIL'
                            ? 'badge-red'
                            : check.status === 'WARN'
                              ? 'badge-amber'
                              : 'badge-neutral'
                      }`}
                    >
                      {check.status}
                    </span>
                  </div>
                  <div className="trust-item-detail">{check.detail}</div>
                </div>
              ))
            )}
          </div>

          <div className="drawer-section">
            <h4>Contextul exact fără PII trimis către Gemini</h4>
            <pre className="code-block mono">
              {JSON.stringify(zeroPiiContext, null, 2)}
            </pre>
          </div>

          <div className="drawer-section">
            <h4>Jurnal de audit anonimizat (pii_stored: false)</h4>
            {auditLog
              .slice()
              .reverse()
              .map((ev) => (
                <div key={ev.id} className="trust-item">
                  <div className="trust-item-head">
                    <span>{ev.action}</span>
                    <span className="badge badge-neutral mono">{ev.category}</span>
                  </div>
                  <div className="trust-item-detail">{ev.detail}</div>
                </div>
              ))}
          </div>

          <details className="drawer-section">
            <summary
              style={{
                cursor: 'pointer',
                fontSize: 12,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                color: 'var(--text-muted)',
              }}
            >
              Simulează scenarii negative (doar pentru demo)
            </summary>
            <div className="sim-grid" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={loading}
                onClick={() => onSimulateUnhappy('DECLINED')}
              >
                Refuzat în wallet
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={loading}
                onClick={() => onSimulateUnhappy('WITHHELD_ADDRESS')}
              >
                Adresă nepartajată
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={loading}
                onClick={() => onSimulateUnhappy('EXPIRED')}
              >
                Expirat (5 min)
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={loading}
                onClick={() => onSimulateUnhappy('WALLET_ERROR')}
              >
                Eroare wallet
              </button>
            </div>
          </details>
        </div>
      </aside>
    </div>
  );
}
