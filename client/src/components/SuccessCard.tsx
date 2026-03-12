import { motion } from 'framer-motion';
import { useState } from 'react';

interface Props {
  url: string;
  name: string;
  onReset: () => void;
}

export default function SuccessCard({ url, name, onReset }: Props) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback for older browsers
      const el = document.createElement('textarea');
      el.value = url;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 24, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -16, scale: 0.97 }}
      transition={{ duration: 0.45, ease: [0.25, 0.46, 0.45, 0.94] }}
    >
      <div className="bg-surface rounded-2xl shadow-card border border-border p-6 sm:p-8">
        {/* Success icon */}
        <div className="flex justify-center mb-5">
          <motion.div
            initial={{ scale: 0.5, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.1, duration: 0.4, ease: [0.34, 1.56, 0.64, 1] }}
            className="w-14 h-14 rounded-full bg-success/10 border border-success/25 flex items-center justify-center"
          >
            <motion.svg
              width="26"
              height="26"
              viewBox="0 0 24 24"
              fill="none"
              stroke="#4aad6f"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ delay: 0.3, duration: 0.4, ease: 'easeOut' }}
            >
              <motion.polyline points="20 6 9 17 4 12" />
            </motion.svg>
          </motion.div>
        </div>

        {/* Heading */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.35 }}
          className="text-center mb-6"
        >
          <h2 className="text-lg font-semibold text-primary mb-1">
            Подписка создана!
          </h2>
          <p className="text-sm text-muted">
            Расписание для <span className="text-primary/90 font-medium">{name}</span>
          </p>
        </motion.div>

        {/* URL box */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.35 }}
          className="mb-6"
        >
          <p className="text-xs font-medium text-muted uppercase tracking-wider mb-2">
            Ссылка на календарь
          </p>
          <div className="flex gap-2">
            <div className="flex-1 min-w-0 px-3 py-2.5 bg-input-bg border border-border rounded-xl">
              <p className="text-sm text-accent font-mono truncate">{url}</p>
            </div>
            <motion.button
              onClick={handleCopy}
              whileTap={{ scale: 0.94 }}
              className={[
                'flex-shrink-0 px-4 py-2.5 rounded-xl text-sm font-medium transition-all duration-200',
                copied
                  ? 'bg-success/15 border border-success/30 text-success'
                  : 'bg-accent-light border border-accent/20 text-accent hover:bg-accent/15',
              ].join(' ')}
            >
              {copied ? (
                <span className="flex items-center gap-1.5">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="14 4 6 12 2 8" />
                  </svg>
                  Скопировано
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" />
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  Копировать
                </span>
              )}
            </motion.button>
          </div>
        </motion.div>

        {/* Instructions */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4, duration: 0.35 }}
          className="mb-6 p-4 bg-input-bg/60 rounded-xl border border-border/60"
        >
          <p className="text-xs font-medium text-muted uppercase tracking-wider mb-3">
            Как добавить в календарь
          </p>
          <div className="space-y-3">
            <InstructionRow
              icon="🍎"
              label="Apple Calendar"
              steps={['Файл → Новая подписка на календарь', 'Вставьте ссылку → Подписаться', 'Обновление: Каждый час']}
            />
            <InstructionRow
              icon="📅"
              label="Google Calendar"
              steps={['Другие календари → +', '"Добавить по URL"', 'Вставьте ссылку → Добавить']}
            />
          </div>
        </motion.div>

        {/* Reset */}
        <motion.button
          onClick={onReset}
          whileTap={{ scale: 0.97 }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          className="w-full py-2.5 px-4 rounded-xl text-sm font-medium text-muted border border-border hover:border-border-focus/40 hover:text-primary transition-all duration-200"
        >
          Добавить ещё одного человека
        </motion.button>
      </div>
    </motion.div>
  );
}

function InstructionRow({
  icon,
  label,
  steps,
}: {
  icon: string;
  label: string;
  steps: string[];
}) {
  return (
    <div className="flex gap-2.5">
      <span className="text-base leading-none mt-0.5 flex-shrink-0">{icon}</span>
      <div>
        <p className="text-xs font-medium text-primary/80 mb-0.5">{label}</p>
        <ol className="space-y-0.5">
          {steps.map((step, i) => (
            <li key={i} className="text-xs text-muted leading-snug">
              {i + 1}. {step}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
