import { useEffect, useState } from 'react';
import { Check, Moon, RotateCcw, SlidersHorizontal, Sun, X } from 'lucide-react';
import type { CustomerId } from '../types';

export type MobileTab = 'home' | 'chat';

interface HeaderBarProps {
  customerId: CustomerId;
  activeTab: MobileTab;
  theme: 'dark' | 'light';
  loading: boolean;
  onToggleTheme: () => void;
  onSwitchCustomer: (customerId: CustomerId) => void;
  onReset: () => void;
}

const CUSTOMER_OPTIONS: Array<{ id: CustomerId; name: string; subtitle: string }> = [
  { id: 'radu', name: 'Radu Stan', subtitle: 'Client principal · Wallet live' },
  { id: 'alex', name: 'Alex Popescu', subtitle: 'Blocat de bancă · Fără EUDI self-service' },
  { id: 'maria', name: 'Maria Ionescu', subtitle: 'Test identitate diferită' },
];

export function HeaderBar({
  customerId,
  activeTab,
  theme,
  loading,
  onToggleTheme,
  onSwitchCustomer,
  onReset,
}: HeaderBarProps) {
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    if (!sheetOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSheetOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [sheetOpen]);

  const subtitle = activeTab === 'home' ? 'Datele mele' : 'Chat suport ZenBank';

  return (
    <>
      <header className="mobile-header">
        <div className="brand">
          <span className="brand-mark">ZB</span>
          <div>
            <h1 className="brand-title">ZenBank</h1>
            <div className="brand-sub">{subtitle}</div>
          </div>
        </div>

        <div className="header-actions">
          <button
            type="button"
            className="icon-circle-btn"
            aria-label={theme === 'dark' ? 'Comută la modul luminos' : 'Comută la modul întunecat'}
            title={theme === 'dark' ? 'Mod luminos' : 'Mod întunecat'}
            onClick={onToggleTheme}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>

          <button
            type="button"
            className="demo-trigger-pill"
            aria-expanded={sheetOpen}
            aria-haspopup="dialog"
            disabled={loading}
            onClick={() => setSheetOpen(true)}
          >
            <SlidersHorizontal size={13} />
            <span>Demo</span>
          </button>
        </div>
      </header>

      {sheetOpen && (
        <div className="sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <section
            className="bottom-sheet"
            role="dialog"
            aria-label="Configurare scenarii demo"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sheet-handle" aria-hidden="true" />
            <div className="sheet-header">
              <strong>Configurare demonstrație</strong>
              <button
                type="button"
                className="sheet-close-btn"
                aria-label="Închide"
                onClick={() => setSheetOpen(false)}
              >
                <X size={16} />
              </button>
            </div>

            <div className="sheet-section">
              <div className="sheet-label">Client autentificat</div>
              <div className="sheet-option-list">
                {CUSTOMER_OPTIONS.map((opt) => {
                  const selected = customerId === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={`sheet-option-btn ${selected ? 'selected' : ''}`}
                      disabled={loading}
                      onClick={() => {
                        onSwitchCustomer(opt.id);
                        setSheetOpen(false);
                      }}
                    >
                      <div>
                        <div className="sheet-option-title">{opt.name}</div>
                        <div className="sheet-option-sub">{opt.subtitle}</div>
                      </div>
                      {selected && <Check size={16} color="var(--zen-primary)" />}
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              type="button"
              className="btn btn-secondary btn-block"
              disabled={loading}
              onClick={() => {
                setSheetOpen(false);
                onReset();
              }}
            >
              <RotateCcw size={15} />
              Resetează conversația
            </button>
          </section>
        </div>
      )}
    </>
  );
}
