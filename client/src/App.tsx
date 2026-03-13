import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import CalendarForm from './components/CalendarForm';
import SuccessCard from './components/SuccessCard';
import PersonPickerModal from './components/PersonPickerModal';
import GuidesPage from './components/GuidesPage';
import type { PersonOption } from './lib/api';

type FormState =
  | { stage: 'form' }
  | { stage: 'selecting'; persons: PersonOption[]; fio: string; inviteCode: string; telegramId: string }
  | { stage: 'success'; url: string; name: string };

type Page = 'main' | 'guides';

export default function App() {
  const [page, setPage]       = useState<Page>('main');
  const [form, setForm]       = useState<FormState>({ stage: 'form' });

  function switchPage(p: Page) {
    setPage(p);
    // Reset form when switching away
    if (p !== 'main') setForm({ stage: 'form' });
  }

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      {/* Background gradient */}
      <div
        className="fixed inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(217,119,87,0.07) 0%, transparent 70%)',
        }}
      />

      {/* Header */}
      <header className="relative z-10 flex flex-col items-center pt-10 pb-4 px-4 gap-4">
        <motion.div
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="flex items-center gap-3"
        >
          <CalendarIcon />
          <div>
            <h1 className="text-xl font-semibold text-primary leading-tight">
              Modeus Calendar
            </h1>
            <p className="text-sm text-muted">Расписание ТюмГУ в вашем календаре</p>
          </div>
        </motion.div>

        {/* Tab navigation */}
        <nav className="flex items-center gap-1 bg-surface border border-border rounded-xl p-1">
          <TabButton active={page === 'main'}   onClick={() => switchPage('main')}>
            Подписка
          </TabButton>
          <TabButton active={page === 'guides'} onClick={() => switchPage('guides')}>
            Гайды
          </TabButton>
        </nav>
      </header>

      {/* Main */}
      <main className="relative z-10 flex-1 flex items-start justify-center px-4 pb-16 pt-4">
        <div className="w-full max-w-md">
          <AnimatePresence mode="wait">
            {page === 'guides' ? (
              <GuidesPage key="guides" />
            ) : form.stage === 'form' || form.stage === 'selecting' ? (
              <CalendarForm
                key="form"
                onSuccess={(url, name) => setForm({ stage: 'success', url, name })}
                onMultiple={(persons, fio, inviteCode, telegramId) =>
                  setForm({ stage: 'selecting', persons, fio, inviteCode, telegramId })
                }
              />
            ) : (
              <SuccessCard
                key="success"
                url={form.url}
                name={form.name}
                onReset={() => setForm({ stage: 'form' })}
                onGoToGuides={() => switchPage('guides')}
              />
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Person picker modal */}
      {form.stage === 'selecting' && page === 'main' && (
        <PersonPickerModal
          persons={form.persons}
          fio={form.fio}
          inviteCode={form.inviteCode}
          telegramId={form.telegramId}
          onSuccess={(url, name) => setForm({ stage: 'success', url, name })}
          onCancel={() => setForm({ stage: 'form' })}
        />
      )}

      {/* Footer */}
      <footer className="relative z-10 text-center pb-6 px-4">
        <p className="text-xs text-muted/60">
          Расписание обновляется автоматически каждые 3 часа
        </p>
      </footer>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'px-4 py-1.5 rounded-lg text-sm font-medium transition-all duration-200',
        active
          ? 'bg-accent text-white shadow-sm'
          : 'text-muted hover:text-primary',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function CalendarIcon() {
  return (
    <div className="w-10 h-10 rounded-xl bg-accent-light border border-accent/20 flex items-center justify-center flex-shrink-0">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#d97757"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="4" width="18" height="18" rx="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
        <line x1="8" y1="14" x2="8" y2="14" />
        <line x1="12" y1="14" x2="12" y2="14" />
        <line x1="16" y1="14" x2="16" y2="14" />
      </svg>
    </div>
  );
}
