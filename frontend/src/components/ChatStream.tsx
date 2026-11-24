import { useEffect, useRef, useState } from 'react';
import { Lock, Send } from 'lucide-react';
import type { AgentStage, ChatMessage, FlowChannel, VerificationScope } from '../types';
import { AccountCheckCard, EudiCardRenderer, JourneyStepper } from './EudiFlowCards';

interface ChatStreamProps {
  messages: ChatMessage[];
  stage: AgentStage;
  flowChannel: FlowChannel | null;
  loading: boolean;
  activeTransactionId: string | null;
  confirmedIds: Set<string>;
  onSendChat: (
    message: string,
    quickAction?: 'START_DATA_UPDATE' | 'EXPLAIN_PAYMENT_RESTRICTION' | 'EXPLAIN_PRIVACY',
    scope?: VerificationScope,
  ) => void;
  onStartVerification: () => void;
  onConfirmUpdate: (
    pendingUpdateId: string,
    mode: 'UPDATE_PROFILE' | 'UPDATE_ADDRESS' | 'IDENTITY_ONLY',
  ) => void;
  onRetryVerification: () => void;
  onGoHome: () => void;
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('ro-RO', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function ChatStream({
  messages,
  stage,
  flowChannel,
  loading,
  activeTransactionId,
  confirmedIds,
  onSendChat,
  onStartVerification,
  onConfirmUpdate,
  onRetryVerification,
  onGoHome,
}: ChatStreamProps) {
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, loading]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    setInput('');
    onSendChat(trimmed);
  };

  const showChatStepper = flowChannel === 'chat' && stage !== 'IDLE';
  const showQuickChips = !activeTransactionId && !(flowChannel === 'chat' && stage === 'DIFF_READY');

  return (
    <div className="chat-mobile-container">
      <div className="chat-top-bar">
        {showChatStepper && <JourneyStepper stage={stage} />}

        <span className="trust-strip-pill">
          <Lock size={11} />
          <span>Date personale protejate</span>
        </span>
      </div>

      <div className="chat-stream">
        {messages.map((msg) => (
          <div key={msg.id} className={`msg-row ${msg.role}`}>
            <div className="msg-bubble">{msg.text}</div>

            {msg.accountCheck && <AccountCheckCard check={msg.accountCheck} />}

            {msg.card && (
              <EudiCardRenderer
                card={msg.card}
                loading={loading}
                activeTransactionId={activeTransactionId}
                confirmedIds={confirmedIds}
                onStartVerification={onStartVerification}
                onConfirmUpdate={onConfirmUpdate}
                onRetryVerification={onRetryVerification}
                doneButtonLabel="Vezi datele actualizate"
                onDone={onGoHome}
              />
            )}

            <span className="msg-time">{formatTime(msg.timestamp)}</span>
          </div>
        ))}
        {loading && (
          <div className="msg-row agent">
            <div className="typing-bubble" aria-label="Asistentul scrie">
              <span className="typing-dot" />
              <span className="typing-dot" />
              <span className="typing-dot" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {showQuickChips && (
        <div className="quick-chips-bar" aria-label="Întrebări frecvente">
          <button
            type="button"
            className="quick-chip"
            disabled={loading}
            onClick={() =>
              onSendChat('De ce nu pot iniția o plată?', 'EXPLAIN_PAYMENT_RESTRICTION')
            }
          >
            De ce nu pot iniția o plată?
          </button>
          <button
            type="button"
            className="quick-chip"
            disabled={loading}
            onClick={() =>
              onSendChat('Mi-am schimbat adresa', 'START_DATA_UPDATE', 'address')
            }
          >
            Mi-am schimbat adresa
          </button>
          <button
            type="button"
            className="quick-chip"
            disabled={loading}
            onClick={() =>
              onSendChat('Mi-am schimbat venitul', 'START_DATA_UPDATE', 'income')
            }
          >
            Mi-am schimbat venitul
          </button>
          <button
            type="button"
            className="quick-chip"
            disabled={loading}
            onClick={() =>
              onSendChat('Vreau să-mi actualizez tot profilul personal', 'START_DATA_UPDATE', 'full')
            }
          >
            Actualizează tot profilul
          </button>
          <button
            type="button"
            className="quick-chip"
            disabled={loading}
            onClick={() =>
              onSendChat('Ce date sunt necesare și cum sunt protejate?', 'EXPLAIN_PRIVACY')
            }
          >
            Ce date sunt necesare?
          </button>
        </div>
      )}

      <form className="chat-composer" onSubmit={submit}>
        <input
          className="chat-input"
          type="text"
          value={input}
          disabled={loading}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Întreabă asistentul ZenBank…"
        />
        <button
          type="submit"
          className="send-circle-btn"
          aria-label="Trimite"
          disabled={loading || !input.trim()}
        >
          <Send size={16} />
        </button>
      </form>
    </div>
  );
}
