import { motion, AnimatePresence } from 'framer-motion';
import { useState } from 'react';
import type { PersonOption } from '../lib/api';
import { register } from '../lib/api';

interface Props {
  persons: PersonOption[];
  fio: string;
  inviteCode: string;
  telegramId: string;
  onSuccess: (url: string, name: string) => void;
  onCancel: () => void;
}

export default function PersonPickerModal({
  persons,
  fio,
  inviteCode,
  telegramId,
  onSuccess,
  onCancel,
}: Props) {
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSelect(person: PersonOption) {
    setLoading(person.id);
    setError(null);
    try {
      const result = await register(fio, inviteCode, person.id, person.fullName, telegramId || undefined);
      if (result.status === 'success') {
        onSuccess(result.url, person.fullName);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Ошибка');
      setLoading(null);
    }
  }

  return (
    <AnimatePresence>
      {/* Overlay */}
      <motion.div
        key="overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* Modal card */}
      <motion.div
        key="modal"
        initial={{ opacity: 0, scale: 0.95, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 16 }}
        transition={{ duration: 0.25, ease: [0.25, 0.46, 0.45, 0.94] }}
        className="fixed inset-0 z-50 flex items-center justify-center px-4 pointer-events-none"
      >
        <div
          className="w-full max-w-md bg-surface rounded-2xl shadow-card border border-border p-6 sm:p-8 pointer-events-auto"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="mb-5">
            <h2 className="text-lg font-semibold text-primary mb-1">
              Найдено несколько человек
            </h2>
            <p className="text-sm text-muted">Выберите себя из списка</p>
          </div>

          {/* Person list */}
          <div className="space-y-2 mb-4">
            {persons.map(person => {
              const isLoading = loading === person.id;
              return (
                <motion.button
                  key={person.id}
                  whileTap={{ scale: 0.98 }}
                  disabled={loading !== null}
                  onClick={() => void handleSelect(person)}
                  className={[
                    'w-full text-left px-4 py-3 rounded-xl border transition-all duration-200',
                    'disabled:opacity-60 disabled:cursor-not-allowed',
                    isLoading
                      ? 'bg-accent/10 border-accent/30'
                      : 'bg-input-bg border-border hover:border-border-focus hover:bg-accent-light',
                  ].join(' ')}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-primary truncate">
                        {person.fullName}
                      </p>
                      {person.specialtyName && (
                        <p className="text-xs text-muted truncate mt-0.5">
                          {person.specialtyName}
                        </p>
                      )}
                    </div>
                    {isLoading && (
                      <div className="flex-shrink-0">
                        <Spinner />
                      </div>
                    )}
                  </div>
                </motion.button>
              );
            })}
          </div>

          {/* Error */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                animate={{ opacity: 1, height: 'auto', marginBottom: 12 }}
                exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                transition={{ duration: 0.2 }}
                className="overflow-hidden"
              >
                <div className="flex items-start gap-1.5 px-1">
                  <svg
                    className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-error"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                  >
                    <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.75 4a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-1.5 0V5zm.75 7a1 1 0 1 1 0-2 1 1 0 0 1 0 2z" />
                  </svg>
                  <p className="text-xs text-error leading-snug">{error}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Cancel */}
          <button
            onClick={onCancel}
            disabled={loading !== null}
            className="w-full py-2 text-sm text-muted hover:text-primary transition-colors duration-200 disabled:opacity-50"
          >
            Отмена
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
    >
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}
