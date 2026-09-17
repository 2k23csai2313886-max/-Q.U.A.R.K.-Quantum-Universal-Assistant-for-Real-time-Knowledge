'use client';

import { QuarkProvider, useQuark } from '@/hooks/QuarkProvider';
import { Specks, CornerBrackets } from '@/components/Backdrop';
import TopBar from '@/components/TopBar';
import QuantumOrb from '@/components/QuantumOrb';
import LeftColumn from '@/components/LeftColumn';
import RightColumn from '@/components/RightColumn';
import Terminal from '@/components/Terminal';
import InfoOverlay from '@/components/InfoOverlay';
import Viewport from '@/components/Viewport';
import PermissionDialog from '@/components/PermissionDialog';
import Toasts from '@/components/Toasts';
import BootScreen from '@/components/BootScreen';

export default function Page() {
  return (
    <QuarkProvider>
      <Hud />
    </QuarkProvider>
  );
}

function Hud() {
  const { clock, coreStatus, busy, transcript } = useQuark();

  // Re-excite the orb whenever the assistant produces a new entry.
  const exciteSignal = transcript.length;

  return (
    <>
      <BootScreen />
      <CornerBrackets />
      <Specks />
      <Toasts />

      <TopBar />

      <main className="stage">
        <LeftColumn />

        <div className="core">
          <div className={`core-status${busy ? ' active' : ''}`} aria-hidden="true">
            {coreStatus}
          </div>
          <QuantumOrb exciteSignal={exciteSignal} />
          <div className="greeting">
            <h2>{clock.greeting}, Commander</h2>
            <p>Q.U.A.R.K. — Quantum Universal Assistant for Real-time Knowledge</p>
          </div>
        </div>

        <RightColumn />
      </main>

      <Terminal />

      <InfoOverlay />
      <Viewport />
      <PermissionDialog />

      <span className="sr-only" role="status" aria-live="polite">
        {busy ? 'Q.U.A.R.K. is working' : 'Q.U.A.R.K. is idle'}
      </span>
    </>
  );
}
