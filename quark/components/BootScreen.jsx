'use client';

import { useQuark } from '@/hooks/QuarkProvider';

/** Boot sequence — cosmetic, but it also hides the capability audit + backend
 *  probe so the HUD never flashes half-initialised state. */
export default function BootScreen() {
  const { bootProgress, bootLog, booted } = useQuark();

  return (
    <div className={`boot${booted ? ' done' : ''}`} aria-hidden={booted} role="status" aria-live="polite">
      <div className="boot-mark">Q.U.A.R.K.</div>
      <div className="boot-bar">
        <div className="boot-fill" style={{ width: `${bootProgress}%` }} />
      </div>
      <div className="boot-log">
        {[...bootLog].reverse().map((l, i) => (
          <div key={`${l}-${i}`}>
            <b>✓</b> {l}
          </div>
        ))}
      </div>
      {booted ? <span className="sr-only">Q.U.A.R.K. ready</span> : null}
    </div>
  );
}
