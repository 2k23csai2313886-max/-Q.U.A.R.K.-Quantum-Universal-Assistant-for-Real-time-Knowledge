'use client';

import { useState } from 'react';
import { useQuark } from '@/hooks/QuarkProvider';
import { PANEL_TITLES, TEAM, APP } from '@/lib/constants';
import { TOOL_DECLARATIONS, CATEGORY_LABELS, TOOL_META } from '@/lib/tools';
import Modal from './Modal';

/**
 * Telemetry · Protocols · Capabilities · About
 *
 * Every row here describes something that actually exists. The original's
 * Telemetry panel advertised "Claude (Anthropic API)" and "GitHub Actions
 * CI/CD" while neither was wired up.
 */
export default function InfoOverlay() {
  const { panel, setPanel } = useQuark();
  const open = panel !== 'overview';
  return (
    <Modal open={open} title={PANEL_TITLES[panel] || ''} onClose={() => setPanel('overview')} width={780}>
      {panel === 'telemetry' && <TelemetryPanel />}
      {panel === 'protocols' && <ProtocolsPanel />}
      {panel === 'capabilities' && <CapabilitiesPanel />}
      {panel === 'about' && <AboutPanel />}
    </Modal>
  );
}

/* ── TELEMETRY ─────────────────────────────────────────────────────────── */
function TelemetryPanel() {
  const { conn, speech, queryCount, transcript, caps, clock } = useQuark();
  const granted = caps.filter((c) => c.state === 'granted').length;
  const denied = caps.filter((c) => c.state === 'denied').length;
  const toolTurns = transcript.filter((t) => t.role === 'trace').length;

  return (
    <>
      <h4>System Stack</h4>
      <Spec k="Framework" v="Next.js 16 (App Router) · React 19" />
      <Spec k="Language" v="JavaScript (JSX) · ES2022" />
      <Spec k="Visualization" v="Canvas 2D particle field · DPR-aware" />
      <Spec k="Language model" v={conn.model || 'Gemini (see link state)'} />
      <Spec k="Model transport" v="Server-side proxy at /api/chat · SSE streaming" />
      <Spec k="Key handling" v="GEMINI_API_KEY — server env only, never bundled" />
      <Spec k="Tool protocol" v="Gemini function calling · client-executed" />
      <Spec k="Tools registered" v={`${TOOL_DECLARATIONS.length}`} />
      <Spec
        k="Speech input"
        v={
          speech.sttSupported && speech.recorderSupported
            ? `Web Speech API${speech.fallbackMode ? ' (blocked — using server transcription)' : ', with server-side recorder fallback'}`
            : speech.sttSupported
              ? 'Web Speech API — SpeechRecognition'
              : speech.recorderSupported
                ? 'MediaRecorder → /api/transcribe (no built-in recogniser in this browser)'
                : 'Unsupported in this browser'
        }
      />
      <Spec k="Speech output" v={speech.ttsSupported ? `Web Speech API — SpeechSynthesis (${speech.voices.length} voices)` : 'Unsupported in this browser'} />
      <Spec k="Weather data" v="Open-Meteo (keyless, CORS-enabled)" />
      <Spec k="Rendering safety" v="No innerHTML anywhere · typed block renderer" />
      <Spec k="Deployment" v="Vercel serverless (Node runtime)" />

      <h4>Live Session</h4>
      <Spec k="Model link" v={conn.state === 'live' ? 'LIVE' : conn.state === 'unknown' ? 'PROBING' : 'LOCAL CORE'} tone={conn.state === 'live' ? 'good' : 'bad'} />
      <Spec k="Link detail" v={conn.detail || '—'} />
      <Spec k="Queries this session" v={String(queryCount)} />
      <Spec k="Tool invocations" v={String(toolTurns)} />
      <Spec k="Transcript entries" v={String(transcript.length)} />
      <Spec k="Permissions granted" v={`${granted} · denied ${denied}`} />
      <Spec k="Spoken replies" v={speech.enabled ? 'Enabled' : 'Muted'} />
      <Spec k="Voice" v={speech.voiceName || 'system default'} />
      <Spec k="Timezone" v={clock.timezone} />
      <Spec k="Secure context (HTTPS)" v={typeof window !== 'undefined' && window.isSecureContext ? 'Yes' : 'No — camera/mic will be disabled'} tone={typeof window !== 'undefined' && window.isSecureContext ? 'good' : 'bad'} />

      <h4>Why a proxy?</h4>
      <p>
        A browser page cannot hold an API secret — anything in the client bundle is readable by
        every visitor. <code>/api/chat</code> runs as a Vercel serverless function, reads{' '}
        <code>GEMINI_API_KEY</code> from the environment there, and forwards the request to Google.
        The browser only ever sees same-origin traffic with no key in it.
      </p>
    </>
  );
}

const Spec = ({ k, v, tone }) => (
  <div className="spec-row">
    <span className="k">{k}</span>
    <span className={`v${tone ? ' ' + tone : ''}`}>{v}</span>
  </div>
);

/* ── PROTOCOLS ─────────────────────────────────────────────────────────── */
const PROTOCOL_GROUPS = [
  {
    title: 'Open & navigate the web',
    chips: ['open youtube', 'open github', 'search react server components', 'play lofi hip hop',
            'instagram kholo', 'directions to Delhi from Kanpur by train', 'open https://nextjs.org/docs'],
  },
  {
    title: 'Device & sensors',
    chips: ['where am I', "what's the weather", 'weather in Kanpur', 'battery status', 'system report',
            'take a photo', 'screenshot my screen', 'record 10 seconds of audio'],
  },
  {
    title: 'Display & create',
    chips: ['show me a study plan for final semester', 'make a table comparing React and Vue',
            'write a python quicksort and display it', 'draft a leave application to my HOD',
            'display the agenda for our project review'],
  },
  {
    title: 'Time & reminders',
    chips: ['what time is it', "what's today's date", 'time in America/New_York',
            'set a timer for 10 minutes', 'remind me to submit the report at 9pm', 'cancel all timers'],
  },
  {
    title: 'Files & clipboard',
    chips: ['read my clipboard', 'copy this: deploy to vercel', 'save this transcript to a file',
            'export the transcript', 'open a file'],
  },
  {
    title: 'Utility',
    chips: ['calculate (45*12) + sqrt(144)^2', 'tell me a joke', 'who are you', 'who is the team leader',
            'what can you do', 'change accent to magenta', 'go fullscreen'],
  },
  {
    title: 'Permissions',
    chips: ['allow notifications', 'grant camera access', 'list capabilities', 'why was that denied'],
  },
];

function ProtocolsPanel() {
  const { submit, setPanel, busy } = useQuark();
  const run = (text) => { setPanel('overview'); setTimeout(() => submit(text), 120); };

  return (
    <>
      <p>
        Q.U.A.R.K. understands natural language — these are illustrative phrasings, not a fixed grammar.
        Tap any chip to run it. English and Hinglish both resolve.
      </p>
      {PROTOCOL_GROUPS.map((g) => (
        <div className="cmd-group" key={g.title}>
          <h4>{g.title}</h4>
          {g.chips.map((c) => (
            <button type="button" className="cmd-chip" key={c} disabled={busy} onClick={() => run(c)}>
              {c}
            </button>
          ))}
        </div>
      ))}

      <h4>How a command actually executes</h4>
      <ol className="vp-ul">
        <li>Your text (or voice transcript) is sent to <code>/api/chat</code>.</li>
        <li>The server adds <code>GEMINI_API_KEY</code> and forwards it to Gemini with all {TOOL_DECLARATIONS.length} tool schemas.</li>
        <li>Gemini replies with either text or one or more <code>functionCall</code> parts.</li>
        <li>Tool calls execute <strong>in your browser</strong>. Sensitive ones open the permission dialog first.</li>
        <li>Results go back as <code>functionResponse</code> parts and the loop repeats (max 6 rounds).</li>
        <li>The final text is typed into the terminal and spoken aloud.</li>
      </ol>

      <h4>Fallback behaviour</h4>
      <p>
        If the model link fails — no key, no network, quota exhausted — the badge switches from{' '}
        <strong>LIVE</strong> to <strong>LOCAL CORE</strong> and an on-device intent engine takes over.
        It still executes real tools, so <em>open youtube</em>, <em>set a timer</em> and{' '}
        <em>calculate</em> keep working offline. Only open-ended knowledge questions degrade.
      </p>
    </>
  );
}

/* ── CAPABILITIES ──────────────────────────────────────────────────────── */
function CapabilitiesPanel() {
  const { caps, ensurePermission, refreshCaps, toast } = useQuark();
  const [busyCap, setBusyCap] = useState(null);

  const request = async (id) => {
    setBusyCap(id);
    const res = await ensurePermission(id, { reason: 'you requested it from the capability matrix' });
    setBusyCap(null);
    await refreshCaps();
    toast({
      kind: res.state === 'granted' ? 'ok' : 'warn',
      title: res.state === 'granted' ? 'Granted' : 'Not granted',
      message: `${id} → ${res.state}`,
    });
  };

  const grouped = Object.entries(
    TOOL_DECLARATIONS.reduce((acc, t) => {
      const cat = TOOL_META[t.name]?.category || 'utility';
      (acc[cat] ||= []).push(t);
      return acc;
    }, {}),
  );

  return (
    <>
      <h4>Browser permissions — live status</h4>
      <div className="cap-grid">
        <div className="cap-row head">
          <span>Capability</span><span>State</span><span>Action</span>
        </div>
        {caps.map((c) => (
          <div className="cap-row" key={c.id}>
            <span className="cap-name">
              {c.label}
              <small>{c.summary}</small>
            </span>
            <span className={`cap-state ${c.state}`}>{c.state.toUpperCase()}</span>
            <button
              type="button"
              className="cap-btn"
              disabled={!c.canRequest || busyCap === c.id}
              onClick={() => request(c.id)}
            >
              {busyCap === c.id ? '…' : c.state === 'granted' ? 'RE-CHECK' : 'REQUEST'}
            </button>
          </div>
        ))}
      </div>

      <h4>Tool catalogue ({TOOL_DECLARATIONS.length})</h4>
      {grouped.map(([cat, tools]) => (
        <div className="cmd-group" key={cat}>
          <h4 style={{ marginTop: 14 }}>{CATEGORY_LABELS[cat] || cat}</h4>
          {tools.map((t) => (
            <span className="cmd-chip" key={t.name} title={t.description} style={{ cursor: 'default' }}>
              {t.name}
            </span>
          ))}
        </div>
      ))}

      <h4>Hard limits of a website</h4>
      <ul>
        <li><strong>Cannot</strong> launch native desktop applications (VS Code, Chrome, Notepad, Spotify desktop).</li>
        <li><strong>Cannot</strong> read arbitrary files — only ones you explicitly pick, or write ones you confirm.</li>
        <li><strong>Cannot</strong> control the OS, other tabs, other origins, or the window manager.</li>
        <li><strong>Cannot</strong> run in the background once the tab is closed.</li>
        <li><strong>Can</strong> open any URL, which covers most &ldquo;open X&rdquo; requests.</li>
        <li><strong>Can</strong> drive every browser-exposed device API, with your permission.</li>
      </ul>
      <p>
        Need real desktop control? Ship the same tool schemas to a Tauri or Electron companion that
        executes them natively — the protocol does not change. See <code>DEPLOYMENT.md</code>.
      </p>
    </>
  );
}

/* ── ABOUT ─────────────────────────────────────────────────────────────── */
function AboutPanel() {
  return (
    <>
      <span className="about-badge">Team ID: {APP.teamId}</span>
      <p>
        <strong>{APP.name}</strong> — {APP.expanded}. A voice-and-text HUD assistant that pairs a live
        language model with an agentic tool layer running entirely in the browser.
      </p>
      <p>
        Version {APP.version} rebuilds the original single-file prototype as a production React
        application: the design system is preserved exactly, the model call now goes through a
        server-side proxy so the API key is never exposed, and the assistant can actually{' '}
        <em>do</em> things — {TOOL_DECLARATIONS.length} tools across web navigation, device sensors,
        camera/microphone/screen capture, clipboard, files, timers and HUD control.
      </p>

      <h4>Team Details</h4>
      <table className="team-table">
        <thead>
          <tr><th scope="col">Name</th><th scope="col">Roll No.</th><th scope="col">Role</th></tr>
        </thead>
        <tbody>
          {TEAM.map((m) => (
            <tr key={m.roll}>
              <td>{m.name}</td>
              <td>{m.roll}</td>
              <td className="role">{m.role}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h4>Programme</h4>
      <Spec k="Institute" v={APP.institute} />
      <Spec k="Department" v={APP.department} />
      <Spec k="Session" v={APP.session} />
      <Spec k="Domain" v={APP.domain} />

      <h4>What changed from the prototype</h4>
      <ul>
        <li>Gemini key moved server-side behind <code>/api/chat</code> — was missing entirely, so the live path never worked.</li>
        <li>Streaming responses, an abortable request, and typed error messages instead of a silent fallback.</li>
        <li>XSS sink removed — no <code>innerHTML</code> anywhere; model output goes through a typed block renderer.</li>
        <li>Permission broker explains <em>what</em> and <em>why</em> before the native prompt fires.</li>
        <li>Real device telemetry replaces hardcoded values; simulated panels are explicitly tagged.</li>
        <li>Canvas is DPR-aware, pauses in hidden tabs, and honours <code>prefers-reduced-motion</code>.</li>
        <li>Dialog semantics, focus trapping, focus restore, <code>aria-live</code> logs and visible focus rings.</li>
        <li>Intent matching uses word boundaries — &ldquo;sometimes I feel like a timeline&rdquo; no longer returns the clock.</li>
      </ul>
    </>
  );
}
