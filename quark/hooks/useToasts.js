'use client';

import { useCallback, useRef, useState } from 'react';

let seq = 0;

/** HUD toast stack — transient, non-blocking notifications inside the page. */
export function useToasts(max = 4) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle) { clearTimeout(handle); timers.current.delete(id); }
  }, []);

  const push = useCallback(
    ({ kind = 'ok', title = 'Q.U.A.R.K.', message = '', ttl = 5000 }) => {
      const id = `t${++seq}`;
      setToasts((prev) => [...prev.slice(-(max - 1)), { id, kind, title, message }]);
      if (ttl > 0) timers.current.set(id, setTimeout(() => dismiss(id), ttl));
      return id;
    },
    [dismiss, max],
  );

  return { toasts, push, dismiss };
}
