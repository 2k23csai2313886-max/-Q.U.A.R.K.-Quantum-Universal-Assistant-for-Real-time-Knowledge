'use client';

import { useQuark } from '@/hooks/QuarkProvider';
import { PANELS } from '@/lib/constants';
import { IconVolume, IconMic, IconDots } from './Icons';

const LABELS = {
  overview: 'OVERVIEW',
  telemetry: 'TELEMETRY',
  protocols: 'PROTOCOLS',
  capabilities: 'CAPABILITIES',
  about: 'ABOUT',
};

export default function TopBar() {
  const { panel, setPanel, speech } = useQuark();
  const { listening, speaking, enabled, sttSupported, ttsSupported, recorderSupported, transcribing, fallbackMode, modelProgress, toggleListening, toggleVoice } = speech;
  // Voice input works if the browser recogniser OR our own recorder fallback is
  // available — so Firefox and firewall-blocked networks still get voice.
  const voiceAvailable = Boolean(sttSupported || recorderSupported);

  return (
    <header className="topbar">
      <div className="wordmark-logo">
        <span className="dot" aria-hidden="true" />
        <span><span className="q">Q</span>.U.A.R.K.</span>
      </div>

      {/* Real buttons, not <a href="#"> — these don't navigate. */}
      <nav aria-label="HUD sections">
        {PANELS.map((p) => (
          <button
            key={p}
            type="button"
            className={`navlink${panel === p ? ' active' : ''}`}
            aria-current={panel === p ? 'page' : undefined}
            onClick={() => setPanel(p)}
          >
            {LABELS[p]}
          </button>
        ))}
      </nav>

      <div className="topbar-icons">
        <button
          type="button"
          className={`icon-btn${enabled ? '' : ' muted'}`}
          onClick={toggleVoice}
          disabled={!ttsSupported}
          aria-pressed={enabled}
          aria-label={enabled ? 'Mute spoken replies' : 'Unmute spoken replies'}
          title={ttsSupported ? (enabled ? 'Spoken replies: ON' : 'Spoken replies: OFF') : 'Speech synthesis unsupported in this browser'}
          style={!ttsSupported ? { opacity: 0.35 } : undefined}
        >
          <IconVolume width={16} height={16} />
        </button>

        <button
          type="button"
          className={`icon-btn${listening ? ' listening' : ''}${speaking ? ' speaking' : ''}${transcribing ? ' transcribing' : ''}`}
          onClick={toggleListening}
          disabled={!voiceAvailable || transcribing}
          aria-pressed={listening}
          aria-label={transcribing ? 'Transcribing your recording' : listening ? 'Stop listening' : 'Speak to Q.U.A.R.K.'}
          title={
            transcribing ? (modelProgress ? `Downloading on-device speech model ${modelProgress.pct}%` : 'Transcribing on-device…')
            : !voiceAvailable ? 'Voice input is unsupported in this browser (no SpeechRecognition and no MediaRecorder)'
            : listening ? (fallbackMode ? 'Recording — click to stop and transcribe' : 'Listening — click to stop')
            : fallbackMode ? 'Speak to Q.U.A.R.K. (recorder fallback — built-in speech service is blocked)'
            : 'Speak to Q.U.A.R.K.'
          }
          style={!voiceAvailable ? { opacity: 0.35 } : undefined}
        >
          <IconMic width={16} height={16} />
        </button>

        <IconDots width={16} height={16} aria-hidden="true" />
      </div>
    </header>
  );
}
