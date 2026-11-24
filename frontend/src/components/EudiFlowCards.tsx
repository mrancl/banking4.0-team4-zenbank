import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  BriefcaseBusiness,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  MapPin,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Terminal,
  UserCheck,
} from 'lucide-react';
import { formatTitleCase } from '../format';
import type { AccountStatusCheck, AgentStage, ChatCard } from '../types';

const JOURNEY_STEPS = ['Cerere', 'EUDI', 'Confirmă', 'Gata'];

function getStepState(stage: AgentStage, index: number): 'done' | 'active' | 'pending' {
  if (stage === 'COMPLETED') {
    return 'done';
  }
  let activeIndex = 0;
  if (stage === 'AWAITING_WALLET' || stage === 'DECLINED' || stage === 'BLOCKED') {
    activeIndex = 1;
  } else if (stage === 'DIFF_READY') {
    activeIndex = 2;
  }

  if (index < activeIndex) return 'done';
  if (index === activeIndex) return 'active';
  return 'pending';
}

export function JourneyStepper({ stage }: { stage: AgentStage }) {
  return (
    <div className="journey-stepper" aria-label="Pași actualizare date">
      {JOURNEY_STEPS.map((label, idx) => {
        const state = getStepState(stage, idx);
        return (
          <div key={label} className={`step-item step-${state}`}>
            <span className="step-num">
              {state === 'done' ? <Check size={10} strokeWidth={2.75} /> : idx + 1}
            </span>
            <span className="step-label">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function getCredentialIcon(vct: string, index: number) {
  const lower = vct.toLowerCase();
  if (lower.includes('pid') || index === 0) {
    return <UserCheck size={16} color="var(--zen-primary)" />;
  }
  if (lower.includes('address') || index === 1) {
    return <MapPin size={16} color="var(--zen-primary)" />;
  }
  return <BriefcaseBusiness size={16} color="var(--zen-primary)" />;
}

function Countdown({ expiresAt }: { expiresAt: string }) {
  const [secondsLeft, setSecondsLeft] = useState<number>(() =>
    Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)),
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      setSecondsLeft(Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);

  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums' }}>
      {mins}:{secs.toString().padStart(2, '0')}
    </span>
  );
}

function WalletQrCardView({
  card,
  isActive,
}: {
  card: Extract<ChatCard, { type: 'wallet_qr' }>;
  isActive: boolean;
}) {
  const [copied, setCopied] = useState<'adb' | 'link' | null>(null);
  const adbCmd = `adb shell am start -a android.intent.action.VIEW -d '"${card.deepLink}"'`;

  const copyText = async (val: string, kind: 'adb' | 'link') => {
    await navigator.clipboard.writeText(val);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1800);
  };

  return (
    <div className="inline-card">
      <div className="card-title-row">
        <div className="card-title">
          <Smartphone size={16} color="var(--zen-primary)" />
          Verifică cu EUDI Wallet
        </div>
        <span className={`badge ${isActive ? 'badge-accent' : 'badge-neutral'}`}>
          <Clock size={12} />
          {isActive ? (
            <>
              Expiră în <Countdown expiresAt={card.expiresAt} />
            </>
          ) : (
            'Încheiat'
          )}
        </span>
      </div>

      <div className="qr-mobile-layout">
        {isActive && card.deepLink && (
          <>
            <a href={card.deepLink} className="btn btn-primary btn-block">
              <ExternalLink size={15} />
              Deschide în EUDI Wallet
            </a>
            <div className="qr-divider" aria-hidden="true">
              <span>sau scanează codul QR</span>
            </div>
          </>
        )}

        <div
          className="qr-frame"
          aria-label="Cod QR EUDI Wallet"
          dangerouslySetInnerHTML={{ __html: card.qrSvg }}
        />

        <ol className="qr-steps">
          <li>
            Apasă <strong>Deschide în EUDI Wallet</strong> pe acest dispozitiv sau scanează codul QR
          </li>
          <li>
            Verifică datele cerute în aplicația <strong>EUDI Wallet</strong>
          </li>
          <li>
            {card.sameDevice ? (
              <>
                Confirmă partajarea cu <strong>PIN-ul</strong> tău și apasă <strong>Close</strong> — revii automat în ZenBank
              </>
            ) : (
              <>
                Confirmă partajarea cu <strong>PIN-ul</strong> tău și revino în ZenBank
              </>
            )}
          </li>
        </ol>

        {isActive && (
          <div className="waiting-status">
            <span className="pulse-dot" aria-hidden="true" />
            <span>
              {card.status === 'RESPONSE_CODE_REQUIRED'
                ? 'Datele au fost trimise din EUDI Wallet — apasă Close în Wallet pentru a reveni și finaliza automat.'
                : card.status === 'REQUEST_RETRIEVED'
                  ? 'Cererea este deschisă în EUDI Wallet — aprobă cu PIN-ul tău…'
                  : 'Așteptăm confirmarea din EUDI Wallet…'}
            </span>
          </div>
        )}
      </div>

      <details className="emulator-box">
        <summary className="emulator-summary">Opțiuni testare / emulator Android</summary>
        <div className="emulator-tech-meta">
          <span>
            Profil: <span className="mono">{card.profileCode}</span>
          </span>
          <span>
            ID tranzacție: <span className="mono">{card.transactionId}</span>
          </span>
        </div>
        <div className="emulator-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void copyText(adbCmd, 'adb')}
          >
            {copied === 'adb' ? <Check size={13} color="var(--green)" /> : <Terminal size={13} />}
            {copied === 'adb' ? 'Comandă adb copiată' : 'Copiază comanda adb'}
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void copyText(card.deepLink, 'link')}
          >
            {copied === 'link' ? <Check size={13} color="var(--green)" /> : <Copy size={13} />}
            {copied === 'link' ? 'Link EUDI copiat' : 'Copiază link EUDI'}
          </button>
        </div>
      </details>
    </div>
  );
}

interface EudiCardRendererProps {
  card: ChatCard;
  loading: boolean;
  activeTransactionId: string | null;
  confirmedIds: Set<string>;
  onStartVerification: () => void;
  onConfirmUpdate: (
    pendingUpdateId: string,
    mode: 'UPDATE_PROFILE' | 'UPDATE_ADDRESS' | 'IDENTITY_ONLY',
  ) => void;
  onRetryVerification: () => void;
  doneButtonLabel: string;
  onDone: () => void;
}

export function EudiCardRenderer({
  card,
  loading,
  activeTransactionId,
  confirmedIds,
  onStartVerification,
  onConfirmUpdate,
  onRetryVerification,
  doneButtonLabel,
  onDone,
}: EudiCardRendererProps) {
  if (card.type === 'pre_consent') {
    return (
      <div className="inline-card">
        <div className="card-title-row">
          <div className="card-title">
            <ShieldCheck size={16} color="var(--zen-primary)" />
            Ce date vom verifica prin EUDI Wallet
          </div>
          <span className="badge badge-accent">{card.purpose}</span>
        </div>

        {card.profileCode && (
          <div className="profile-scope-pill">
            <span>
              {card.scope === 'address' || card.scope === 'income'
                ? 'Minimizare date activă · Profil:'
                : 'Verificare completă · Profil:'}
            </span>
            <strong className="mono">{card.profileCode}</strong>
          </div>
        )}

        <div className="cred-stack">
          {card.requestedCredentials.map((cred, idx) => (
            <div key={cred.vct} className="cred-box">
              <div className="cred-box-head">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                  {getCredentialIcon(cred.vct, idx)}
                  {cred.credential}
                </span>
              </div>
              <div className="attr-pills">
                {cred.attributes.map((attr) => (
                  <span key={attr} className="attr-pill">
                    {attr}
                  </span>
                ))}
              </div>
              <div className="cred-why">{cred.why}</div>
            </div>
          ))}
        </div>

        <div className="privacy-box">
          <div className="privacy-box-title">Ce NU cerem și NU salvăm</div>
          <ul className="privacy-box-list">
            {card.excludedItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={loading}
          onClick={onStartVerification}
        >
          Continuă cu EUDI Wallet
        </button>
      </div>
    );
  }

  if (card.type === 'wallet_qr') {
    return (
      <WalletQrCardView
        card={card}
        isActive={activeTransactionId === card.transactionId}
      />
    );
  }

  if (card.type === 'diff_confirm') {
    const diffCard = card;
    const canUpdateProfile = diffCard.canUpdateAddress || diffCard.canUpdateIncome;
    const isConfirmed = confirmedIds.has(diffCard.pendingUpdateId);
    return (
      <div className="inline-card">
        <div className="card-title-row">
          <div className="card-title">
            <CheckCircle2 size={16} color="var(--green)" />
            Verifică și confirmă modificările
          </div>
          <span className="badge badge-green">
            {diffCard.scope === 'income' && !diffCard.canConfirmIdentityOnly
              ? 'Venit verificat · EUDI Wallet'
              : diffCard.scope === 'address' && !diffCard.canConfirmIdentityOnly
                ? 'Adresă verificată · EUDI Wallet'
                : `Identitate confirmată · ${formatTitleCase(diffCard.identityName)}`}
          </span>
        </div>

        {diffCard.addressDiff && (
          <div className="mobile-diff-group">
            <div className="mobile-diff-head">Adresă de domiciliu</div>
            {diffCard.addressDiff.fields.map((f) => (
              <div key={f.field} className={`mobile-diff-row ${f.changed ? 'changed' : ''}`}>
                <div className="mobile-diff-label-row">
                  <span className="mobile-diff-label">{f.label}</span>
                  {f.changed && <span className="badge badge-accent">Nou</span>}
                </div>
                {f.changed ? (
                  <div className="mobile-diff-values">
                    <div className="diff-old">În prezent: {f.currentValue || '—'}</div>
                    <div className="diff-new">Din EUDI: {f.verifiedValue || '—'}</div>
                  </div>
                ) : (
                  <div className="diff-unchanged">
                    {f.verifiedValue || f.currentValue || '—'} · Neschimbat
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {diffCard.incomeDiff && (
          <div className="mobile-diff-group">
            <div className="mobile-diff-head">
              <div>Venit și angajator</div>
              {diffCard.verifiedIncome?.basisLabel && (
                <div className="diff-section-note">{diffCard.verifiedIncome.basisLabel}</div>
              )}
            </div>
            {diffCard.incomeDiff.fields.map((f) => (
              <div key={f.field} className={`mobile-diff-row ${f.changed ? 'changed' : ''}`}>
                <div className="mobile-diff-label-row">
                  <span className="mobile-diff-label">{f.label}</span>
                  {f.changed && <span className="badge badge-accent">Nou</span>}
                </div>
                {f.changed ? (
                  <div className="mobile-diff-values">
                    <div className="diff-old">În prezent: {f.currentValue || '—'}</div>
                    <div className="diff-new">Din EUDI: {f.verifiedValue || '—'}</div>
                  </div>
                ) : (
                  <div className="diff-unchanged">
                    {f.verifiedValue || f.currentValue || '—'} · Neschimbat
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="info-banner">
          <ShieldCheck size={15} color="var(--zen-primary)" style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{diffCard.revocationNote}</span>
        </div>

        <div className="mobile-card-actions">
          {canUpdateProfile && (
            <button
              type="button"
              className="btn btn-primary btn-block"
              disabled={loading || isConfirmed}
              onClick={() => onConfirmUpdate(diffCard.pendingUpdateId, 'UPDATE_PROFILE')}
            >
              Confirmă și actualizează
            </button>
          )}

          {diffCard.canConfirmIdentityOnly && (
            <button
              type="button"
              className="btn btn-secondary btn-block"
              disabled={loading || isConfirmed}
              onClick={() => onConfirmUpdate(diffCard.pendingUpdateId, 'IDENTITY_ONLY')}
            >
              {canUpdateProfile ? 'Păstrează datele actuale' : 'Confirmă identitatea'}
            </button>
          )}

          {!canUpdateProfile && !diffCard.canConfirmIdentityOnly && (
            <button type="button" className="btn btn-secondary btn-block" onClick={onDone}>
              {doneButtonLabel}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (card.type === 'completed') {
    const doneCard = card;
    return (
      <div className="inline-card inline-card-success">
        <div className="card-title-row">
          <div className="card-title" style={{ color: 'var(--green)' }}>
            <CheckCircle2 size={17} />
            Datele tale au fost actualizate
          </div>
          <span className="badge badge-green">Actualizat</span>
        </div>

        <div className="checklist">
          {doneCard.identityReconfirmed && (
            <div className="check-row">
              <Check size={16} /> Identitate reconfirmată
            </div>
          )}
          {doneCard.scope !== 'income' && (
            <div className="check-row">
              <Check size={16} />{' '}
              {doneCard.addressUpdated
                ? `Adresă actualizată: ${doneCard.updatedAddress.formatted}`
                : 'Adresa existentă a fost păstrată'}
            </div>
          )}
          {doneCard.scope !== 'address' && (
            <div className="check-row">
              <Check size={16} />{' '}
              {doneCard.incomeUpdated
                ? `Venit actualizat: ${doneCard.updatedIncome.employer} · ${doneCard.updatedIncome.bracket}`
                : 'Datele de venit existente au fost păstrate'}
            </div>
          )}
          {doneCard.scope === 'address' && (
            <div className="check-row">
              <Check size={16} /> Venitul și identitatea nu au fost solicitate (minimizare date)
            </div>
          )}
          {doneCard.scope === 'income' && (
            <div className="check-row">
              <Check size={16} /> Adresa și identitatea nu au fost solicitate (minimizare date)
            </div>
          )}
          {doneCard.restrictionLifted && (
            <div className="check-row">
              <Check size={16} /> Restricția pe plăți a fost ridicată
            </div>
          )}
          {doneCard.noDocumentUploadRequired && (
            <div className="check-row">
              <Check size={16} /> Fără documente încărcate
            </div>
          )}
        </div>

        <button
          type="button"
          className="btn btn-secondary btn-block"
          style={{ marginTop: 10 }}
          onClick={onDone}
        >
          {doneButtonLabel}
        </button>
      </div>
    );
  }

  const recoveryCard = card;
  const pendingId = recoveryCard.pendingUpdateId;
  const isConfirmed = pendingId ? confirmedIds.has(pendingId) : false;

  return (
    <div className="inline-card inline-card-warn">
      <div className="card-title-row">
        <div className="card-title" style={{ color: 'var(--amber)' }}>
          <AlertTriangle size={16} />
          {recoveryCard.title}
        </div>
      </div>

      <p style={{ margin: '0 0 10px', fontSize: 13.5, lineHeight: 1.5 }}>{recoveryCard.detail}</p>

      <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12.5, color: 'var(--text-muted)' }}>
        {recoveryCard.fallbackOptions.map((opt) => (
          <li key={opt}>{opt}</li>
        ))}
      </ul>

      <div className="mobile-card-actions">
        {recoveryCard.canRetryEudi && (
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={loading}
            onClick={onRetryVerification}
          >
            Reîncearcă cu EUDI Wallet
          </button>
        )}

        {recoveryCard.canConfirmIdentityOnly && pendingId && (
          <button
            type="button"
            className="btn btn-secondary btn-block"
            disabled={loading || isConfirmed}
            onClick={() => onConfirmUpdate(pendingId, 'IDENTITY_ONLY')}
          >
            Confirmă identitatea
          </button>
        )}
      </div>
    </div>
  );
}

export function AccountCheckCard({ check }: { check: AccountStatusCheck }) {
  const badgeClass = check.dataUpdateRequired
    ? check.paymentRestricted
      ? 'badge-red'
      : 'badge-amber'
    : 'badge-green';
  const badgeLabel = check.dataUpdateRequired
    ? check.paymentRestricted
      ? 'Restricție activă'
      : 'Actualizare necesară'
    : 'Profil la zi';

  return (
    <div className="inline-card account-check-card">
      <div className="card-title-row">
        <div className="card-title">
          <ShieldCheck size={16} color="var(--zen-primary)" />
          Verificare profil ZenBank
        </div>
        <span className={`badge ${badgeClass}`}>{badgeLabel}</span>
      </div>

      <div className="account-check-list">
        {check.checks.map((item) => (
          <div key={item.id} className="account-check-row">
            <div className="account-check-left">
              {item.status === 'OK' ? (
                <CheckCircle2 size={15} color="var(--green)" style={{ flexShrink: 0 }} />
              ) : item.status === 'BLOCKED' ? (
                <ShieldAlert size={15} color="var(--red)" style={{ flexShrink: 0 }} />
              ) : (
                <AlertTriangle size={15} color="var(--amber)" style={{ flexShrink: 0 }} />
              )}
              <span className="account-check-label">{item.label}</span>
            </div>
            <span className="account-check-summary">{item.summary}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
