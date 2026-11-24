import {
  AlertTriangle,
  ArrowRight,
  BriefcaseBusiness,
  CheckCircle2,
  CreditCard,
  FileBadge2,
  MapPin,
  ShieldAlert,
} from 'lucide-react';
import type { ZenBankCustomerProfile } from '../types';

interface ProfileSidebarProps {
  customer: ZenBankCustomerProfile;
  loading: boolean;
  onQuickPrompt: (
    message: string,
    quickAction?: 'START_DATA_UPDATE' | 'EXPLAIN_PAYMENT_RESTRICTION' | 'EXPLAIN_PRIVACY',
  ) => void;
}

export function ProfileSidebar({ customer, loading, onQuickPrompt }: ProfileSidebarProps) {
  const initials = `${customer.givenName[0] ?? ''}${customer.familyName[0] ?? ''}`;
  const isUpToDate = customer.kycStatus === 'UP_TO_DATE';

  return (
    <aside className="sidebar">
      <section className="panel profile-card">
        <div className="profile-header">
          <div className="profile-identity">
            <div className="avatar">{initials}</div>
            <div>
              <div className="profile-name">
                {customer.givenName} {customer.familyName}
              </div>
              <div className="profile-meta">
                {customer.citizenshipLabel} · Data nașterii {customer.birthdate}
              </div>
            </div>
          </div>
        </div>

        <div className="kv-list">
          <div className="kv-row">
            <span className="kv-label">Document înregistrat</span>
            <span className="kv-val">
              <span className="badge badge-neutral">
                <FileBadge2 size={12} />
                Pașaport UE ({customer.documentNumberMasked})
              </span>
            </span>
          </div>

          <div className="kv-row">
            <span className="kv-label">Status profil KYC</span>
            <span className="kv-val">
              {isUpToDate ? (
                <span className="badge badge-green">
                  <CheckCircle2 size={12} />
                  Actualizat
                </span>
              ) : (
                <span className="badge badge-amber">
                  <AlertTriangle size={12} />
                  {customer.kycStatus === 'INCOMPLETE_UPDATE'
                    ? 'Actualizare incompletă'
                    : 'Necesită reconfirmare'}
                </span>
              )}
            </span>
          </div>

          <div className="kv-row">
            <span className="kv-label">Plăți efectuate</span>
            <span className="kv-val">
              {customer.paymentRestricted ? (
                <span className="badge badge-red">
                  <ShieldAlert size={12} />
                  Restricționate
                </span>
              ) : (
                <span className="badge badge-green">
                  <CreditCard size={12} />
                  Active
                </span>
              )}
            </span>
          </div>
        </div>

        <div className={`address-box ${isUpToDate ? 'updated' : ''}`}>
          <div className="address-box-label">
            <MapPin size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Adresa curentă înregistrată la ZenBank
          </div>
          <div style={{ fontWeight: 600 }}>{customer.currentAddress.streetAddress}</div>
          <div style={{ color: 'var(--text-muted)' }}>
            {customer.currentAddress.postalCode} {customer.currentAddress.locality},{' '}
            {customer.currentAddress.country}
          </div>
        </div>

        <div className={`address-box ${isUpToDate ? 'updated' : ''}`}>
          <div className="address-box-label">
            <BriefcaseBusiness size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Venit și sursă fonduri (KYC)
          </div>
          <div style={{ fontWeight: 600 }}>
            {customer.currentIncome.source} · {customer.currentIncome.employer}
          </div>
          <div style={{ color: 'var(--text-muted)' }}>{customer.currentIncome.bracket}</div>
        </div>

        {customer.paymentRestricted && customer.restrictionReason && (
          <div className="restriction-alert">
            <strong>Restricție activă:</strong> {customer.restrictionReason}
          </div>
        )}
      </section>

      <section className="panel quick-actions">
        <h3>Acțiuni ZenBank</h3>
        <div className="action-stack">
          <button
            type="button"
            className="action-chip action-chip-primary"
            disabled={loading}
            onClick={() =>
              onQuickPrompt('Vreau să-mi actualizez datele personale', 'START_DATA_UPDATE')
            }
          >
            <span>Actualizează-mi datele personale</span>
            <ArrowRight size={15} color="#0d7a6f" />
          </button>

          <button
            type="button"
            className="action-chip"
            disabled={loading}
            onClick={() =>
              onQuickPrompt('De ce nu pot face plăți?', 'EXPLAIN_PAYMENT_RESTRICTION')
            }
          >
            <span>De ce nu pot face plăți?</span>
            <ArrowRight size={14} />
          </button>

          <button
            type="button"
            className="action-chip"
            disabled={loading}
            onClick={() =>
              onQuickPrompt('De ce aveți nevoie de PID, Adresă și Venit?', 'EXPLAIN_PRIVACY')
            }
          >
            <span>De ce aveți nevoie de PID, Adresă și Venit?</span>
            <ArrowRight size={14} />
          </button>
        </div>
      </section>
    </aside>
  );
}
