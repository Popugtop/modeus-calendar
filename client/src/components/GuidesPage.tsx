import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import guidesData from '../data/guides.json';

interface Step {
  title: string;
  content: string;
  image: string | null;
}

interface Guide {
  id: string;
  title: string;
  icon: string;
  description: string;
  steps: Step[];
}

export default function GuidesPage() {
  const [openId, setOpenId] = useState<string | null>(null);

  const guides = guidesData.guides as Guide[];

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -12 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
    >
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-primary mb-1">Как подключить календарь</h2>
        <p className="text-sm text-muted leading-relaxed">
          Выберите платформу и следуйте инструкции.
        </p>
      </div>

      <div className="space-y-2">
        {guides.map(guide => (
          <GuideCard
            key={guide.id}
            guide={guide}
            isOpen={openId === guide.id}
            onToggle={() => setOpenId(openId === guide.id ? null : guide.id)}
          />
        ))}
      </div>
    </motion.div>
  );
}

function GuideCard({
  guide,
  isOpen,
  onToggle,
}: {
  guide: Guide;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="bg-surface rounded-2xl border border-border overflow-hidden shadow-card">
      {/* Header */}
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-white/[0.02] transition-colors duration-150"
      >
        <div className="flex items-center gap-3">
          <span className="text-2xl leading-none">{guide.icon}</span>
          <div>
            <div className="font-medium text-primary text-sm">{guide.title}</div>
            <div className="text-xs text-muted mt-0.5">{guide.description}</div>
          </div>
        </div>
        <motion.div
          animate={{ rotate: isOpen ? 90 : 0 }}
          transition={{ duration: 0.2 }}
          className="text-muted flex-shrink-0 ml-3"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 3 11 8 6 13" />
          </svg>
        </motion.div>
      </button>

      {/* Steps */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="px-5 pb-5 pt-1 border-t border-border">
              <ol className="space-y-5 mt-3">
                {guide.steps.map((step, idx) => (
                  <li key={idx} className="flex gap-3">
                    {/* Step number */}
                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-accent/15 border border-accent/25 flex items-center justify-center mt-0.5">
                      <span className="text-accent text-xs font-semibold">{idx + 1}</span>
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-primary mb-1">{step.title}</div>
                      {/* HTML content — controlled by developer-edited JSON, not user input */}
                      <div
                        className="text-sm text-muted leading-relaxed guide-content"
                        dangerouslySetInnerHTML={{ __html: step.content }}
                      />
                      {step.image && (
                        <div className="mt-3 rounded-xl overflow-hidden border border-border">
                          <img
                            src={step.image}
                            alt={step.title}
                            className="w-full h-auto block"
                            loading="lazy"
                          />
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
