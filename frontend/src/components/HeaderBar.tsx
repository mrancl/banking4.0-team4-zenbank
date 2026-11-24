import { RotateCcw, ShieldCheck } from 'lucide-react';
import type { CustomerId, DemoScenario, TrustCheckItem } from '../types';

interface HeaderBarProps {
  customerId: CustomerId;
  scenario: DemoScenario;
  trustChecks: TrustCheckItem[];
  verifierMode?: 'live' | 'mock';
  profileCode?: string;
  loading: boolean;
  onSwitchScenario: (customerId: CustomerId, scenario: DemoScenario) => void;
  onReset: () => void;
  onOpenInspector: () => void;
}

export function HeaderBar({
  customerId,
  scenario,
  trustChecks,
  verifierMode,
  profileCode,
  loading,
  onSwitchScenario,
  onReset,
  onOpenInspector,
}: HeaderBarProps) {
  const passCount = trustChecks.filter((c) => c.status === 'PASS').length;
  const failCount = trustChecks.filter((c) => c.status === 'FAIL').length;

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">ZB</span>
        <div>
          <h1 className="brand-title">ZenBank · Actualizare date EUDI</h1>
          <div className="brand-sub">
            Același ZenBank. Aceeași nevoie. Aceeași experiență digitală — indiferent de documentul de
            identitate
            {verifierMode ? ` · ${verifierMode.toUpperCase()} (${profileCode})` : ''}
          </div>
        </div>
      </div>

      <div className="topbar-controls">
        <label className="select-pill">
          <span>Client:</span>
          <select
            value={customerId}
            disabled={loading}
            onChange={(e) => onSwitchScenario(e.target.value as CustomerId, scenario)}
          >
            <option value="radu">Radu Stan (Pașaport UE · Wallet live)</option>
            <option value="alex">Alex Popescu (Profil Starter Pack)</option>
            <option value="maria">Maria Ionescu (Test neconcordanță)</option>
          </select>
        </label>

        <label className="select-pill">
          <span>Scenariu:</span>
          <select
            value={scenario}
            disabled={loading}
            onChange={(e) => onSwitchScenario(customerId, e.target.value as DemoScenario)}
          >
            <option value="data_update">Actualizare date (Flux principal)</option>
            <option value="payment_restricted">Plăți restricționate (Demo chat)</option>
          </select>
        </label>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={loading}
          onClick={onReset}
          title="Resetează profilul clientului și conversația"
        >
          <RotateCcw size={14} />
          Resetează demo
        </button>

        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={onOpenInspector}
        >
          <ShieldCheck size={14} color={failCount > 0 ? '#c62828' : '#147a43'} />
          Verificare &amp; Audit
          {trustChecks.length > 0 && (
            <span className={`badge ${failCount > 0 ? 'badge-red' : 'badge-green'}`}>
              {passCount}/{trustChecks.length}
            </span>
          )}
        </button>
      </div>
    </header>
  );
}
