import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BriefcaseBusiness,
  CheckCircle2,
  ChevronRight,
  CreditCard,
  FileBadge2,
  Lock,
  MapPin,
  MessageCircle,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { formatRomanianDate, formatTitleCase } from '../format';
import type {
  AgentStage,
  ChatCard,
  FlowChannel,
  VerificationScope,
  ZenBankCustomerProfile,
} from '../types';
import { EudiCardRenderer, JourneyStepper } from './EudiFlowCards';

interface HomeTabProps {
  customer: ZenBankCustomerProfile;
  stage: AgentStage;
  flowChannel: FlowChannel | null;
  activeFlowCard: ChatCard | null;
  activeTransactionId: string | null;
  confirmedIds: Set<string>;
  profileFlowOpen: boolean;
  isAndroidWrapper?: boolean;
  loading: boolean;
  onStartProfileUpdate: (scope?: VerificationScope) => void;
  onCloseProfileFlow: () => void;
  onResumeProfileFlow: () => void;
  onStartVerification: () => void;
  onConfirmUpdate: (
    pendingUpdateId: string,
    mode: 'UPDATE_PROFILE' | 'UPDATE_ADDRESS' | 'IDENTITY_ONLY',
  ) => void;
  onRetryVerification: () => void;
  onOpenChat: () => void;
}

export function HomeTab({
  customer,
  stage,
  flowChannel,
  activeFlowCard,
  activeTransactionId,
  confirmedIds,
  profileFlowOpen,
  isAndroidWrapper = false,
  loading,
  onStartProfileUpdate,
  onCloseProfileFlow,
  onResumeProfileFlow,
  onStartVerification,
  onConfirmUpdate,
  onRetryVerification,
  onOpenChat,
}: HomeTabProps) {
  if (profileFlowOpen && flowChannel === 'profile' && activeFlowCard) {
    return (
      <div className="flow-sub-screen">
        <div className="flow-sub-bar">
          <button type="button" className="back-link-btn" onClick={onCloseProfileFlow}>
            <ArrowLeft size={16} />
            <span>Datele mele</span>
          </button>
          <strong style={{ fontSize: 13.5 }}>Actualizare date</strong>
        </div>

        <div className="chat-top-bar">
          <JourneyStepper stage={stage} />
          <span className="trust-strip-pill">
            <Lock size={11} />
            <span>Date personale protejate</span>
          </span>
        </div>

        <div className="mobile-scroll-view">
          <EudiCardRenderer
            card={activeFlowCard}
            loading={loading}
            activeTransactionId={activeTransactionId}
            confirmedIds={confirmedIds}
            isAndroidWrapper={isAndroidWrapper}
            onStartVerification={onStartVerification}
            onConfirmUpdate={onConfirmUpdate}
            onRetryVerification={onRetryVerification}
            onStartFallbackScope={onStartProfileUpdate}
            doneButtonLabel="Înapoi la datele mele"
            onDone={onCloseProfileFlow}
          />
        </div>
      </div>
    );
  }

  const fullName = formatTitleCase(`${customer.givenName} ${customer.familyName}`);
  const initials = `${customer.givenName[0] ?? ''}${customer.familyName[0] ?? ''}`;
  const isUpToDate = customer.kycStatus === 'UP_TO_DATE';
  const addressUpdatedFlag = isUpToDate || Boolean(customer.addressVerified);
  const incomeUpdatedFlag = isUpToDate || Boolean(customer.incomeVerified);
  const citizenshipShort = customer.citizenshipLabel.split('·')[0]?.trim() || customer.citizenshipLabel;
  const hasResumableProfileFlow =
    flowChannel === 'profile' && (Boolean(activeTransactionId) || stage === 'DIFF_READY');

  return (
    <div className="mobile-scroll-view home-view">
      <section className="zen-hero-card">
        <div className="hero-eyebrow">
          <span className="hero-eyebrow-label">ZENBANK · PERSONAL</span>
          <span className={`hero-status-pill ${isUpToDate ? 'ok' : 'warn'}`}>
            {isUpToDate ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
            {isUpToDate
              ? 'La zi'
              : customer.kycStatus === 'INCOMPLETE_UPDATE'
                ? 'Incomplet'
                : 'De actualizat'}
          </span>
        </div>

        <div className="hero-top-row">
          <div className="hero-identity">
            <div className="hero-avatar">{initials}</div>
            <div>
              <div className="hero-name">{fullName}</div>
              <div className="hero-meta">
                {citizenshipShort} · Născut la {formatRomanianDate(customer.birthdate)}
              </div>
            </div>
          </div>
        </div>

        <div className="hero-chips">
          <span className="hero-chip">
            <FileBadge2 size={12} />
            Act de identitate · {customer.documentNumberMasked}
          </span>
          {(customer.paymentRestricted || isUpToDate) && (
            <span className={`hero-chip ${customer.paymentRestricted ? 'danger' : ''}`}>
              {customer.paymentRestricted ? <ShieldAlert size={12} /> : <CreditCard size={12} />}
              {customer.paymentRestricted ? 'Plăți: Blocate' : 'Plăți: Active'}
            </span>
          )}
        </div>
      </section>

      {hasResumableProfileFlow && (
        <div className="resume-banner">
          <div>
            <div style={{ fontWeight: 700, fontSize: 13 }}>Actualizare EUDI în curs</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {stage === 'DIFF_READY'
                ? 'Datele verificate așteaptă confirmarea ta.'
                : 'Scanează codul QR pentru a finaliza verificarea.'}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={onResumeProfileFlow}
          >
            Continuă
            <ArrowRight size={14} />
          </button>
        </div>
      )}

      {customer.paymentRestricted && customer.restrictionReason && (
        <section className="restriction-card">
          <div className="restriction-card-head">
            <ShieldAlert size={18} color="var(--red)" style={{ flexShrink: 0, marginTop: 1 }} />
            <div>
              <div className="restriction-card-title">Plăți blocate temporar</div>
              <p className="restriction-card-text">{customer.restrictionReason}</p>
            </div>
          </div>
          <button
            type="button"
            className="btn btn-danger-soft btn-block"
            disabled={loading}
            onClick={onOpenChat}
          >
            <MessageCircle size={15} />
            <span>Întreabă în Chat</span>
          </button>
        </section>
      )}

      <section className="mobile-section">
        <div className="mobile-section-title">Datele tale în ZenBank</div>
        <div className="mobile-group">
          <button
            type="button"
            disabled={loading}
            className={`mobile-group-row mobile-group-row-interactive ${addressUpdatedFlag ? 'updated' : ''}`}
            onClick={() => onStartProfileUpdate('address')}
          >
            <div className="group-icon">
              <MapPin size={17} color="var(--zen-primary)" />
            </div>
            <div className="group-content">
              <div className="group-label-row">
                <span className="group-label">Adresa de domiciliu</span>
                {addressUpdatedFlag ? (
                  <span className="badge badge-green">Actualizat</span>
                ) : (
                  <span className="group-action-hint">Actualizează</span>
                )}
              </div>
              <div className="group-primary">{customer.currentAddress.streetAddress}</div>
              <div className="group-secondary">
                {customer.currentAddress.postalCode} {customer.currentAddress.locality},{' '}
                {customer.currentAddress.country}
              </div>
            </div>
            <ChevronRight size={16} color="var(--text-muted)" />
          </button>

          <button
            type="button"
            disabled={loading}
            className={`mobile-group-row mobile-group-row-interactive ${incomeUpdatedFlag ? 'updated' : ''}`}
            onClick={() => onStartProfileUpdate('income')}
          >
            <div className="group-icon">
              <BriefcaseBusiness size={17} color="var(--zen-primary)" />
            </div>
            <div className="group-content">
              <div className="group-label-row">
                <span className="group-label">Venit și angajator</span>
                {incomeUpdatedFlag ? (
                  <span className="badge badge-green">Actualizat</span>
                ) : (
                  <span className="group-action-hint">Actualizează</span>
                )}
              </div>
              <div className="group-primary">
                {customer.currentIncome.source} · {customer.currentIncome.employer}
              </div>
              <div className="group-secondary">{customer.currentIncome.bracket}</div>
            </div>
            <ChevronRight size={16} color="var(--text-muted)" />
          </button>
        </div>
      </section>

      <button
        type="button"
        className="cta-feature-card"
        disabled={loading}
        onClick={() => onStartProfileUpdate('full')}
      >
        <div className="cta-feature-icon">
          <ShieldCheck size={22} color="var(--zen-primary)" />
        </div>
        <div className="cta-feature-body">
          <div className="cta-feature-title">Actualizează-mi datele personale</div>
          <div className="cta-feature-sub">Rapid cu EUDI Wallet · Fără documente</div>
        </div>
        <ChevronRight size={18} color="var(--text-muted)" />
      </button>
    </div>
  );
}
