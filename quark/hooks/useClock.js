'use client';

import { useEffect, useState } from 'react';

const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const pad = (n) => String(n).padStart(2, '0');

export function useClock() {
  // `mounted` gate: the clock is prerendered at BUILD time, so rendering the
  // real time during SSR guarantees a hydration mismatch (React error #418).
  // Until the first client effect runs we emit a stable placeholder.
  const [mounted, setMounted] = useState(false);
  const [now, setNow] = useState(() => new Date(0));

  useEffect(() => {
    setMounted(true);
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    // Re-sync immediately when the tab becomes visible again — setInterval is
    // throttled to 1/min in background tabs, so the clock would drift.
    const onVisible = () => { if (!document.hidden) setNow(new Date()); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  const h = now.getHours();
  const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';

  if (!mounted) {
    return {
      now, mounted: false,
      hours: '--', minutes: '--', seconds: '--',
      dateLabel: '—',
      greeting: 'Welcome',
      timezone: '—',
    };
  }

  return {
    now, mounted: true,
    hours: pad(h),
    minutes: pad(now.getMinutes()),
    seconds: pad(now.getSeconds()),
    dateLabel: `${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}`,
    greeting,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
