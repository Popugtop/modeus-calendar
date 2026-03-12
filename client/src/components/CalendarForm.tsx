import { motion, AnimatePresence } from 'framer-motion';
import { useState, useRef } from 'react';
import { validateFio } from '../lib/validate';
import { register } from '../lib/api';

interface Props {
  onSuccess: (url: string, name: string) => void;
}

export default function CalendarForm({ onSuccess }: Props) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [touched, setTouched] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setValue(e.target.value);
    if (touched) {
      setError(validateFio(e.target.value));
    }
  }

  function handleBlur() {
    setTouched(true);
    setError(validateFio(value));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(true);
    const validationError = validateFio(value);
    if (validationError) {
      setError(validationError);
      setShakeKey(k => k + 1);
      inputRef.current?.focus();
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await register(value.trim());
      onSuccess(result.url, value.trim());
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Неизвестная ошибка';
      setError(msg);
      setShakeKey(k => k + 1);
    } finally {
      setLoading(false);
    }
  }

  const hasError = !!error;

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -16, scale: 0.97 }}
      transition={{ duration: 0.45, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      {/* Card */}
      <div className="bg-surface rounded-2xl shadow-card border border-border p-6 sm:p-8">
        {/* Title */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-primary mb-1">
            Подписка на расписание
          </h2>
          <p className="text-sm text-muted leading-relaxed">
            Введите полное ФИО — получите личную ссылку для добавления
            в&nbsp;Apple Calendar или Google Calendar.
          </p>
        </div>

        <form onSubmit={handleSubmit} noValidate>
          {/* Input group */}
          <div className="mb-5">
            <label
              htmlFor="fio-input"
              className="block text-sm font-medium text-primary/80 mb-2"
            >
              Полное ФИО
            </label>

            <motion.div
              key={shakeKey}
              animate={
                shakeKey > 0 && hasError
                  ? { x: [0, -10, 10, -7, 7, -4, 4, 0] }
                  : {}
              }
              transition={{ duration: 0.4 }}
            >
              <input
                ref={inputRef}
                id="fio-input"
                type="text"
                autoComplete="name"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Иванов Иван Иванович"
                value={value}
                onChange={handleChange}
                onBlur={handleBlur}
                disabled={loading}
                className={[
                  'w-full px-4 py-3 rounded-xl text-base text-primary placeholder-muted/50',
                  'bg-input-bg border transition-all duration-200',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  hasError
                    ? 'border-error focus:border-error focus:shadow-[0_0_0_3px_rgba(224,85,85,0.2)]'
                    : 'border-border focus:border-border-focus focus:shadow-glow-accent',
                ].join(' ')}
              />
            </motion.div>

            {/* Error message */}
            <AnimatePresence>
              {hasError && (
                <motion.div
                  initial={{ opacity: 0, height: 0, marginTop: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginTop: 8 }}
                  exit={{ opacity: 0, height: 0, marginTop: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="flex items-start gap-1.5">
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
          </div>

          {/* Hint */}
          <p className="text-xs text-muted/70 mb-5 leading-relaxed">
            Например: <span className="text-muted">Иванов Иван Иванович</span> —
            фамилия, имя и отчество полностью, с заглавных букв.
          </p>

          {/* Submit */}
          <motion.button
            type="submit"
            disabled={loading}
            whileTap={{ scale: loading ? 1 : 0.97 }}
            className={[
              'w-full py-3 px-6 rounded-xl font-medium text-sm',
              'transition-all duration-200',
              'flex items-center justify-center gap-2',
              loading
                ? 'bg-accent/60 cursor-not-allowed text-white/70'
                : 'bg-accent hover:bg-accent-hover active:bg-accent-hover text-white shadow-sm',
            ].join(' ')}
          >
            {loading ? (
              <>
                <Spinner />
                <span>Создаём подписку…</span>
              </>
            ) : (
              <>
                <span>Получить ссылку</span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="3" y1="8" x2="13" y2="8" />
                  <polyline points="9 4 13 8 9 12" />
                </svg>
              </>
            )}
          </motion.button>
        </form>
      </div>
    </motion.div>
  );
}

function Spinner() {
  return (
    <svg
      className="animate-spin"
      width="16"
      height="16"
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
