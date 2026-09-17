'use client';

import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Accessible modal shell.
 *
 * The original overlay had no role="dialog", no aria-modal, never moved focus
 * inside, never trapped it, and never restored it on close. This does all four.
 */
export default function Modal({ open, title, onClose, children, width = 760, labelledBy, initialFocusClose = true }) {
  const panelRef = useRef(null);
  const restoreRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement;

    const panel = panelRef.current;
    if (panel) {
      const first = initialFocusClose
        ? panel.querySelector('.overlay-close') || panel.querySelector(FOCUSABLE)
        : panel.querySelector(FOCUSABLE);
      // Defer one frame so children have mounted.
      requestAnimationFrame(() => first?.focus?.());
    }

    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose?.(); return; }
      if (e.key !== 'Tab' || !panel) return;
      const nodes = [...panel.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };

    document.addEventListener('keydown', onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open, onClose, initialFocusClose]);

  if (!open) return null;

  const id = labelledBy || `modal-title-${title?.replace(/\W+/g, '-').toLowerCase() || 'x'}`;

  return (
    <div
      className="overlay-backdrop open"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        className="overlay-panel"
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        style={{ width: `min(${width}px, 94vw)` }}
      >
        <div className="overlay-head">
          <h3 id={id}>{title}</h3>
          <button type="button" className="overlay-close" onClick={onClose} aria-label="Close dialog">
            &times;
          </button>
        </div>
        <div className="overlay-body">{children}</div>
      </div>
    </div>
  );
}
