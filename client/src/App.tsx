import { AnimatePresence, motion } from 'framer-motion';
import { useState } from 'react';
import CalendarForm from './components/CalendarForm';
import SuccessCard from './components/SuccessCard';

type State =
  | { stage: 'form' }
  | { stage: 'success'; url: string; name: string };

export default function App() {
  const [state, setState] = useState<State>({ stage: 'form' });

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
      <header className="relative z-10 flex items-center justify-center pt-10 pb-6 px-4">
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
      </header>

      {/* Main */}
      <main className="relative z-10 flex-1 flex items-start justify-center px-4 pb-16 pt-2">
        <div className="w-full max-w-md">
          <AnimatePresence mode="wait">
            {state.stage === 'form' ? (
              <CalendarForm
                key="form"
                onSuccess={(url, name) =>
                  setState({ stage: 'success', url, name })
                }
              />
            ) : (
              <SuccessCard
                key="success"
                url={state.url}
                name={state.name}
                onReset={() => setState({ stage: 'form' })}
              />
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 text-center pb-6 px-4">
        <p className="text-xs text-muted/60">
          Расписание обновляется автоматически каждые 3 часа
        </p>
      </footer>
    </div>
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
