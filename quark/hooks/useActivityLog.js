'use client';

/**
 * Activity monitor.
 * The original picked a RANDOM state every 5.2 seconds — it would log
 * "LISTENING" while the mic was off and "PROCESSING" while idle. Every entry
 * here is produced by a real event.
 */

import { useCallback, useEffect, useState } from 'react';
import { STATES, STATE_CLASS } from '@/lib/constants';

const MAX_ROWS = 8;
const pad = (n) => String(n).padStart(2, '0');
const stamp = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

let seq = 0;

export function useActivityLog() {
  // Seeded in an effect, not in the initializer: stamp() is wall-clock
  // dependent, so an SSR initializer would mismatch the client render.
  const [rows, setRows] = useState([]);
  const [headline, setHeadline] = useState(STATES.STANDBY);

  useEffect(() => {
    setRows([{ id: `a${++seq}`, t: stamp(), state: STATES.STANDBY, detail: 'HUD initialised' }]);
  }, []);

  const push = useCallback((state, detail = '') => {
    const row = { id: `a${++seq}`, t: stamp(), state, detail: String(detail).slice(0, 60) };
    setRows((prev) => [row, ...prev].slice(0, MAX_ROWS));
    setHeadline(state);
  }, []);

  return {
    rows: rows.map((r) => ({ ...r, cls: STATE_CLASS[r.state] || 'standby' })),
    headline,
    push,
    standby: () => push(STATES.STANDBY, 'awaiting input'),
  };
}
