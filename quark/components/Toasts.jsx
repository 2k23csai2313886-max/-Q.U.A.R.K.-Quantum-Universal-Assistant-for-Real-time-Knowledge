'use client';

import { useQuark } from '@/hooks/QuarkProvider';

export default function Toasts() {
  const { toasts, dismissToast } = useQuark();
  if (!toasts.length) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div className={`toast ${t.kind}`} key={t.id}>
          <div className="toast-t">
            <span>{t.title}</span>
            <button type="button" className="toast-x" onClick={() => dismissToast(t.id)} aria-label="Dismiss notification">
              &times;
            </button>
          </div>
          <div className="toast-m">{t.message}</div>
        </div>
      ))}
    </div>
  );
}
