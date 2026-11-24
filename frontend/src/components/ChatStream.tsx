import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Lock,
  RefreshCw,
  Send,
  ShieldCheck,
  Smartphone,
  Terminal,
} from 'lucide-react';
import type { ChatCard, ChatMessage } from '../types';

interface ChatStreamProps {
  messages: ChatMessage[];
  loading: boolean;
  activeTransactionId: string | null;
  onSendChat: (message: string) => void;
  onStartVerification: () => void;
  onConfirmUpdate: (
    pendingUpdateId: string,
    mode: 'UPDATE_PROFILE' | 'UPDATE_ADDRESS' | 'IDENTITY_ONLY',
  ) => void;
  onRetryVerification: () => void;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
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
    <span className="mono" style={{ fontSize: 12 }}>
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
          <Smartphone size={16} color="#0d7a6f" />
          Cerere de verificare EUDI Wallet
        </div>
        <span className={`badge ${isActive ? 'badge-accent' : 'badge-neutral'}`}>
          <Clock size={12} />
          {isActive ? (
            <>
              În așteptare · <Countdown expiresAt={card.expiresAt} />
            </>
          ) : (
            'Sesiune încheiată'
          )}
        </span>
      </div>

      <div className="qr-layout">
        <div
          className="qr-frame"
          aria-label="Cod QR EUDI Wallet"
          dangerouslySetInnerHTML={{ __html: card.qrSvg }}
        />

        <div className="qr-meta">
          <div style={{ fontSize: 13 }}>
            <strong>Profil:</strong> <span className="mono">{card.profileCode}</span>
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            Deschide EUDI Wallet pe telefon sau emulator, verifică cererea ZenBank, apasă{' '}
            <strong>Share</strong> și introdu PIN-ul wallet-ului.
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
            Tranzacție: <span className="mono">{card.transactionId}</span>
          </div>
          {isActive && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: 'var(--zen-primary)',
                fontWeight: 600,
              }}
            >
              <RefreshCw size={13} />
              Verificăm statusul live la Tremend Verifier la fiecare 2s…
            </div>
          )}
        </div>
      </div>

      <details className="emulator-box">
        <summary className="emulator-summary">
          Ajutor emulator Android (copiază comanda adb sau link-ul openid4vp://)
        </summary>
        <div className="emulator-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => void copyText(adbCmd, 'adb')}
          >
            {copied === 'adb' ? <Check size={13} color="#147a43" /> : <Terminal size={13} />}
            {copied === 'adb' ? 'Comandă adb copiată' : 'Copiază comanda adb'}
          </button>

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void copyText(card.deepLink, 'link')}
          >
            {copied === 'link' ? <Check size={13} color="#147a43" /> : <Copy size={13} />}
            {copied === 'link' ? 'deepLink copiat' : 'Copiază deepLink'}
          </button>
        </div>
      </details>
    </div>
  );
}

export function ChatStream({
  messages,
  loading,
  activeTransactionId,
  onSendChat,
  onStartVerification,
  onConfirmUpdate,
  onRetryVerification,
}: ChatStreamProps) {
  const [input, setInput] = useState('');
  const [confirmedIds, setConfirmedIds] = useState<Set<string>>(() => new Set());
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    setInput('');
    onSendChat(trimmed);
  };

  const handleConfirm = (
    id: string,
    mode: 'UPDATE_PROFILE' | 'UPDATE_ADDRESS' | 'IDENTITY_ONLY',
  ) => {
    setConfirmedIds((prev) => new Set(prev).add(id));
    onConfirmUpdate(id, mode);
  };

  return (
    <section className="panel chat-panel">
      <div className="chat-header">
        <div className="chat-header-title">
          <ShieldCheck size={18} color="#0d7a6f" />
          Asistent ZenBank
        </div>
        <span className="badge badge-green">
          <Lock size={11} />
          Limită Zero-PII LLM
        </span>
      </div>

      <div className="chat-stream">
        {messages.map((msg) => (
          <div key={msg.id} className={`msg-row ${msg.role}`}>
            <div className="msg-bubble">{msg.text}</div>

            {msg.card?.type === 'pre_consent' && (
              <div className="inline-card">
                <div className="card-title-row">
                  <div className="card-title">
                    <ShieldCheck size={16} color="#0d7a6f" />
                    ZenBank solicită atribute verificate
                  </div>
                  <span className="badge badge-accent">Scop: {msg.card.purpose}</span>
                </div>

                <div className="cred-grid">
                  {msg.card.requestedCredentials.map((cred) => (
                    <div key={cred.vct} className="cred-box">
                      <div className="cred-box-head">
                        <span>{cred.credential}</span>
                        <span className="badge badge-neutral mono">{cred.vct}</span>
                      </div>
                      <div className="cred-attrs mono">{cred.attributes.join(', ')}</div>
                      <div className="cred-why">{cred.why}</div>
                    </div>
                  ))}
                </div>

                <div className="excluded-note">
                  <strong>Excluse (minimizarea datelor):</strong> {msg.card.excludedItems.join(' · ')}
                </div>

                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={loading}
                  onClick={onStartVerification}
                >
                  Continuă cu EUDI Wallet
                </button>
              </div>
            )}

            {msg.card?.type === 'wallet_qr' && (
              <WalletQrCardView
                card={msg.card}
                isActive={activeTransactionId === msg.card.transactionId}
              />
            )}

            {msg.card?.type === 'diff_confirm' && (() => {
              const card = msg.card;
              const canUpdateProfile = card.canUpdateAddress || card.canUpdateIncome;
              return (
                <div className="inline-card">
                  <div className="card-title-row">
                    <div className="card-title">
                      <CheckCircle2 size={16} color="#147a43" />
                      Identitate verificată și comparație date
                    </div>
                    <span className="badge badge-green">
                      {card.identityName} · {card.identityBirthdate}
                    </span>
                  </div>

                  <table className="diff-table">
                    <thead>
                      <tr>
                        <th>Atribut</th>
                        <th>Date curente ZenBank</th>
                        <th>Date verificate EUDI</th>
                      </tr>
                    </thead>
                    <tbody>
                      {card.addressDiff && (
                        <>
                          <tr className="diff-section-row">
                            <td colSpan={3}>Adresă de domiciliu</td>
                          </tr>
                          {card.addressDiff.fields.map((f) => (
                            <tr key={f.field} className={f.changed ? 'diff-changed' : ''}>
                              <td>{f.label}</td>
                              <td>{f.currentValue || '—'}</td>
                              <td>
                                {f.verifiedValue || '—'}{' '}
                                {f.changed && <span className="badge badge-accent">Modificat</span>}
                              </td>
                            </tr>
                          ))}
                        </>
                      )}

                      {card.incomeDiff && (
                        <>
                          <tr className="diff-section-row">
                            <td colSpan={3}>
                              Sursă venit și angajator ({card.verifiedIncome?.basisLabel})
                            </td>
                          </tr>
                          {card.incomeDiff.fields.map((f) => (
                            <tr key={f.field} className={f.changed ? 'diff-changed' : ''}>
                              <td>{f.label}</td>
                              <td>{f.currentValue || '—'}</td>
                              <td>
                                {f.verifiedValue || '—'}{' '}
                                {f.changed && <span className="badge badge-accent">Modificat</span>}
                              </td>
                            </tr>
                          ))}
                        </>
                      )}
                    </tbody>
                  </table>

                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
                    <strong>Verificare regulă:</strong> Partajarea din wallet nu modifică automat
                    profilul ZenBank. {card.revocationNote}
                  </div>

                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {canUpdateProfile && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={loading || confirmedIds.has(card.pendingUpdateId)}
                        onClick={() => handleConfirm(card.pendingUpdateId, 'UPDATE_PROFILE')}
                      >
                        Confirmă actualizarea
                      </button>
                    )}

                    {card.canConfirmIdentityOnly && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={loading || confirmedIds.has(card.pendingUpdateId)}
                        onClick={() => handleConfirm(card.pendingUpdateId, 'IDENTITY_ONLY')}
                      >
                        {canUpdateProfile
                          ? 'Păstrează datele curente (doar reconfirmare identitate)'
                          : 'Confirmă reconfirmarea identității'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}

            {msg.card?.type === 'completed' && (
              <div className="inline-card" style={{ borderColor: '#98d8b4', background: '#f7fcf9' }}>
                <div className="card-title-row">
                  <div className="card-title" style={{ color: 'var(--green)' }}>
                    <CheckCircle2 size={17} />
                    Actualizarea profilului ZenBank a fost finalizată
                  </div>
                  <span className="badge badge-green">Status: FINALIZAT</span>
                </div>

                <div className="checklist">
                  {msg.card.identityReconfirmed && (
                    <div className="check-row">
                      <Check size={16} /> Identitate reconfirmată
                    </div>
                  )}
                  <div className="check-row">
                    <Check size={16} />{' '}
                    {msg.card.addressUpdated
                      ? `Adresă actualizată la ${msg.card.updatedAddress.formatted}`
                      : 'Adresa înregistrată la ZenBank a fost păstrată'}
                  </div>
                  <div className="check-row">
                    <Check size={16} />{' '}
                    {msg.card.incomeUpdated
                      ? `Sursă venit și angajator actualizate (${msg.card.updatedIncome.employer} · ${msg.card.updatedIncome.bracket})`
                      : 'Datele de venit existente au fost păstrate'}
                  </div>
                  {msg.card.restrictionLifted && (
                    <div className="check-row">
                      <Check size={16} /> Restricția pe plăți a fost ridicată
                    </div>
                  )}
                  {msg.card.noPassportUploadRequired && (
                    <div className="check-row">
                      <Check size={16} /> Nu a fost necesară încărcarea pașaportului sau a adeverinței de venit
                    </div>
                  )}
                </div>
              </div>
            )}

            {msg.card?.type === 'recovery' && (() => {
              const card = msg.card;
              const pendingId = card.pendingUpdateId;
              return (
                <div className="inline-card" style={{ borderColor: '#f3c18c', background: '#fffcf7' }}>
                  <div className="card-title-row">
                    <div className="card-title" style={{ color: 'var(--amber)' }}>
                      <AlertTriangle size={16} />
                      {card.title}
                    </div>
                    <span className="badge badge-amber mono">{card.code}</span>
                  </div>

                  <p style={{ margin: '0 0 10px', fontSize: 13 }}>{card.detail}</p>

                  <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12.5, color: 'var(--text-muted)' }}>
                    {card.fallbackOptions.map((opt) => (
                      <li key={opt}>{opt}</li>
                    ))}
                  </ul>

                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {card.canRetryEudi && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={loading}
                        onClick={onRetryVerification}
                      >
                        Reîncearcă cu EUDI Wallet
                      </button>
                    )}

                    {card.canConfirmIdentityOnly && pendingId && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={loading || confirmedIds.has(pendingId)}
                        onClick={() => handleConfirm(pendingId, 'IDENTITY_ONLY')}
                      >
                        Confirmă doar reconfirmarea identității
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}

            <span className="msg-time">{formatTime(msg.timestamp)}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      <form className="chat-composer" onSubmit={submit}>
        <input
          className="chat-input"
          type="text"
          value={input}
          disabled={loading}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Scrie o întrebare (ex. „De ce nu pot face plăți?” sau „De ce aveți nevoie de aceste date?”)"
        />
        <button type="submit" className="btn btn-primary" disabled={loading || !input.trim()}>
          <Send size={15} />
          Trimite
        </button>
      </form>
    </section>
  );
}
