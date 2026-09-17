'use client';

/**
 * Q.U.A.R.K. — orchestrator
 * ─────────────────────────────────────────────────────────────────────────
 * Owns the agentic loop:
 *
 *   user text/voice
 *        │
 *        ▼
 *   POST /api/chat  ──(server adds GEMINI_API_KEY)──▶  Gemini
 *        │
 *        ├─ text            → render + speak
 *        └─ functionCall[]  → executeTool() IN THE BROWSER
 *                                 │  (permission broker gates sensitive ones)
 *                                 ▼
 *                            functionResponse[] → back to /api/chat → loop
 *
 * The loop is client-driven on purpose: the tools need the *user's* browser
 * (their camera, their GPS, their clipboard, their popup gesture). A server
 * could never execute them.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { APP, STATES } from '@/lib/constants';
import { TOOL_DECLARATIONS } from '@/lib/tools';
import { executeTool, registerRuntimeTools, toFunctionResponse } from '@/lib/executor';
import { CAPABILITIES, PERM_STATE, auditCapabilities, denialHelp, queryPermission } from '@/lib/permissions';
import { offlinePlan, route as routeLocal, normalize as normalizeQuery, LOCAL_FIRST_THRESHOLD } from '@/lib/engine';
import { sendTurn, probeBackend, explainError } from '@/lib/gemini-client';
import { useClock } from './useClock';
import { useToasts } from './useToasts';
import { useTimers } from './useTimers';
import { useActivityLog } from './useActivityLog';
import { useSpeech, explainSttError } from './useSpeech';

const MAX_ROUNDS = 6;
const MAX_TURNS = 40; // keep the context window bounded
const BOOT_LINES = [
  'Mounting HUD lattice',
  'Loading design tokens',
  'Calibrating quantum orb',
  'Registering tool catalogue',
  'Auditing browser capabilities',
  'Handshaking with Gemini proxy',
];

const Ctx = createContext(null);
export const useQuark = () => useContext(Ctx);

let idSeq = 0;
const nid = (p) => `${p}${Date.now().toString(36)}${(++idSeq).toString(36)}`;

export function QuarkProvider({ children }) {
  // ── transcript ────────────────────────────────────────────────────────
  const [transcript, setTranscript] = useState([
    { id: nid('m'), role: 'user', text: 'hello quark' },
    { id: nid('m'), role: 'assistant', text: 'Systems nominal. Standing by, Commander.' },
  ]);

  const [busy, setBusy] = useState(false);
  const [coreStatus, setCoreStatus] = useState('IDLE');
  const [conn, setConn] = useState({ state: 'unknown', detail: 'probing…', model: null, tools: TOOL_DECLARATIONS.length });
  const [queryCount, setQueryCount] = useState(0);
  const [panel, setPanel] = useState('overview');
  const [accent, setAccentState] = useState({ a: '#4deaff', b: '#ff4fc3' });
  const [weather, setWeather] = useState({ temp: '—', cond: 'awaiting reading', place: null, live: false });
  const [location, setLocation] = useState(null);
  const [bootProgress, setBootProgress] = useState(0);
  const [bootLog, setBootLog] = useState([]);
  const [booted, setBooted] = useState(false);
  const [caps, setCaps] = useState([]);

  // ── overlays ──────────────────────────────────────────────────────────
  const [viewport, setViewport] = useState({ open: false, title: '', blocks: [], actions: [], kind: 'content' });
  const [permRequest, setPermRequest] = useState(null); // {capability, reason, label, summary}
  const permResolver = useRef(null);

  // ── refs ──────────────────────────────────────────────────────────────
  const contentsRef = useRef([]);
  const abortRef = useRef(null);
  const busyRef = useRef(false);
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const lastUserText = useRef('');

  // ── sub-hooks ─────────────────────────────────────────────────────────
  const clock = useClock();
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
  const activity = useActivityLog();
  const speech = useSpeech({
    onFinalTranscript: (t) => { submitRef.current?.(t); },
    onInterim: () => {},
    onStateChange: (kind, val) => {
      if (kind === 'listening' && val) activity.push(STATES.LISTENING, 'speech-to-text active');
      if (kind === 'stt-retry') {
        pushToast({ kind: 'info', title: 'Microphone', message: 'Speech service unreachable — retrying once…' });
      }
      if (kind === 'stt-fallback') {
        activity.push(STATES.LISTENING, 'recorder fallback engaged');
        pushToast({
          kind: 'info',
          title: 'Microphone',
          message: 'Your browser\'s built-in speech service is blocked here, so I am recording the mic and transcribing it through the server instead. Click the mic when you have finished speaking.',
        });
      }
      if (kind === 'stt-transcribing' && val) {
        activity.push(STATES.PROCESSING, 'transcribing audio');
      }
      if (kind === 'stt-model') {
        pushToast({
          kind: 'info',
          title: 'On-device speech model',
          message: 'Loading Whisper (≈45 MB) into this browser. It runs entirely on your machine — no upload, no API key, no quota. This download happens once and is then cached.',
        });
      }
      if (kind === 'stt-model-progress') {
        activity.push(STATES.PROCESSING, `speech model ${val.pct}%`);
      }
      if (kind === 'stt-local') {
        pushToast({
          kind: 'ok',
          title: 'Transcribed on-device',
          message: `Whisper (${val.device}) transcribed your command in ${Number(val.seconds || 0).toFixed(1)}s. Nothing was uploaded.`
            + (val.source === 'self-hosted' ? ' Model weights came from this site.' : ''),
        });
      }
      if (kind === 'stt-local-failed') {
        pushToast({
          kind: 'info',
          title: 'On-device transcription unavailable',
          message: `The local model could not run (${val}), so the recording is being transcribed by the server instead.`,
        });
      }
      if (kind === 'stt-error') {
        const msg = explainSttError(val);
        if (msg) pushToast({ kind: 'err', title: 'Microphone', message: msg });
      }
    },
  });

  // `timers` cannot be referenced inside its own onDue callback (TDZ), so the
  // cancel goes through a ref that is assigned immediately after creation.
  const timersRef = useRef(null);
  const timers = useTimers({
    onDue: useCallback((t) => {
      const msg = t.kind === 'reminder' ? `Reminder: ${t.label}` : `Timer complete: ${t.label}`;
      pushToast({ kind: 'warn', title: t.kind === 'reminder' ? 'Reminder' : 'Timer', message: t.label, ttl: 12000 });
      speech.speak(msg, { force: true });
      activity.push(STATES.RECEIVED, t.label);
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification(t.kind === 'reminder' ? 'Q.U.A.R.K. reminder' : 'Q.U.A.R.K. timer', { body: t.label, tag: t.id }); } catch { /* ignore */ }
      }
      timersRef.current?.cancel(t.id);
    }, [pushToast, activity, speech]),
  });
  timersRef.current = timers;

  // ── transcript helpers ────────────────────────────────────────────────
  const addEntry = useCallback((entry) => {
    const e = { id: nid('m'), ...entry };
    setTranscript((prev) => [...prev, e]);
    return e.id;
  }, []);
  const updateEntry = useCallback((id, patch) => {
    setTranscript((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);
  const removeEntry = useCallback((id) => {
    setTranscript((prev) => prev.filter((e) => e.id !== id));
  }, []);

  // ── accent ────────────────────────────────────────────────────────────
  const setAccent = useCallback((a, b) => {
    setAccentState({ a, b: b || a });
    try {
      document.documentElement.style.setProperty('--accent', a);
      document.documentElement.style.setProperty('--accent-2', b || a);
    } catch { /* SSR */ }
  }, []);

  useEffect(() => {
    try {
      document.documentElement.style.setProperty('--accent', accent.a);
      document.documentElement.style.setProperty('--accent-2', accent.b);
    } catch { /* SSR */ }
  }, [accent]);

  // ── viewport / launch card ────────────────────────────────────────────
  const showViewport = useCallback((v) => setViewport({ open: true, kind: 'content', actions: [], blocks: [], title: '', ...v }), []);
  const closeViewport = useCallback(() => setViewport((p) => ({ ...p, open: false })), []);
  const showLaunchCard = useCallback(({ url, label }) => {
    setViewport({
      open: true,
      kind: 'launch',
      title: 'LAUNCH CONFIRMATION',
      blocks: [
        { type: 'paragraph', text: 'Your browser blocked the automatic popup — this is normal for pages opened from an AI response. Confirm the launch below.' },
        { type: 'keyvalue', entries: [{ k: 'Target', v: label || url }, { k: 'URL', v: url }] },
      ],
      actions: [{ kind: 'launch', label: 'OPEN NOW', url }],
    });
  }, []);

  // ── permission broker ─────────────────────────────────────────────────
  const askUser = useCallback(
    (capability, reason) =>
      new Promise((resolve) => {
        const cap = CAPABILITIES[capability];
        permResolver.current = resolve;
        setPermRequest({
          capability,
          label: cap?.label || capability,
          summary: cap?.summary || '',
          reason: reason || 'to complete the action you requested',
          askedFor: lastUserText.current || '(direct tool call)',
        });
      }),
    [],
  );

  const resolvePermission = useCallback((allowed) => {
    setPermRequest(null);
    const r = permResolver.current;
    permResolver.current = null;
    r?.(allowed);
  }, []);

  const ensurePermission = useCallback(
    async (capability, { reason } = {}) => {
      const cap = CAPABILITIES[capability];
      if (!cap) return { state: 'unsupported', error: `Unknown capability "${capability}"` };

      // 1. Is the API even there?
      const probed = typeof cap.probe === 'function' ? await cap.probe() : null;
      if (probed === PERM_STATE.UNSUPPORTED) return { state: PERM_STATE.UNSUPPORTED };
      if (probed === PERM_STATE.UNAVAILABLE)
        return { state: PERM_STATE.UNAVAILABLE, error: 'This capability needs a secure (HTTPS) context.' };

      // 2. Already answered?
      if (probed === PERM_STATE.GRANTED) return cap.request();
      if (probed === PERM_STATE.DENIED) return { state: PERM_STATE.DENIED };

      const queried = cap.permissionName ? await queryPermission(cap.permissionName) : null;
      if (queried === 'denied') return { state: PERM_STATE.DENIED };
      if (queried === 'granted') return cap.request();

      // 3. Ask in-HUD, then fire the native prompt
      const allowed = await askUser(capability, reason);
      if (!allowed) {
        activity.push(STATES.DENIED, cap.label);
        return { state: PERM_STATE.DENIED, byUser: true };
      }
      activity.push(STATES.PROCESSING, `${cap.label} permission`);
      const res = await cap.request();
      if (res.state === PERM_STATE.GRANTED) setCaps(await auditCapabilities());
      return res;
    },
    [askUser, activity],
  );

  // ── runtime tools (voice) ─────────────────────────────────────────────
  useEffect(() => {
    registerRuntimeTools({
      speak: ({ text, rate, pitch }) => {
        if (!text || !String(text).trim()) {
          speech.stopSpeaking();
          return { ok: true, summary: 'Stopped speaking.' };
        }
        const said = speech.speak(text, { rate, pitch });
        return {
          ok: said,
          summary: said
            ? `Spoke "${String(text).slice(0, 120)}" aloud.`
            : 'Voice output is muted or unsupported in this browser, so nothing was spoken. The text is still in the transcript.',
        };
      },
      setVoiceListening: async ({ enable }) => {
        if (!speech.sttSupported && !speech.recorderSupported) {
          return { ok: false, summary: 'This browser exposes neither speech recognition nor audio recording, so voice input is unavailable. Typed commands still work.' };
        }
        if (enable) {
          const started = await speech.startListening();
          return {
            ok: Boolean(started),
            summary: started
              ? 'Microphone is live — speak your command.'
              : 'Could not start the microphone. See the toast for the reason, Commander.',
          };
        }
        speech.stopListening();
        return { ok: true, summary: 'Stopped listening.' };
      },
      setVoiceMode: ({ mode }) => {
        const on = String(mode || '').trim().toLowerCase() !== 'auto';
        if (on && !speech.localSttSupported) {
          return {
            ok: false,
            summary: 'This browser cannot run the on-device speech model (it needs WebAssembly), so on-device mode is unavailable. Voice stays in AUTO.',
          };
        }
        speech.setLocalOnly(on);
        return {
          ok: true,
          summary: on
            ? 'On-device voice mode ON. Speech is transcribed by Whisper inside this browser: nothing is uploaded, no API key or quota is used, and the browser recogniser that streams audio to a cloud service is skipped. The ~45 MB model downloads once and is then cached.'
            : 'Voice mode set to AUTO: the browser recogniser is tried first, then on-device Whisper, then the server transcriber.',
        };
      },
    });
  }, [speech]);

  // ── build the tool execution context ──────────────────────────────────
  const buildCtx = useCallback(() => ({
    ensurePermission,
    denialHelp,
    showViewport,
    showLaunchCard,
    closeViewport,
    toast: pushToast,
    navigatePanel: setPanel,
    setAccent,
    setWeather: (w) => setWeather({ ...w, live: true }),
    setLocation,
    setPendingPurpose: () => {},
    clearTerminal: () => {
      const n = transcriptRef.current.length;
      setTranscript([]);
      contentsRef.current = [];
      return n;
    },
    getTranscript: () => transcriptRef.current,
    timers,
    logActivity: (state, detail) => activity.push(state, detail),
    onToolStart: () => setCoreStatus('EXECUTING'),
    onToolEnd: () => {},
    refreshCapabilities: async () => setCaps(await auditCapabilities()),
  }), [ensurePermission, showViewport, showLaunchCard, closeViewport, pushToast, setAccent, timers, activity]);

  const ctxRef = useRef(null);
  ctxRef.current = buildCtx();

  // ── the agentic loop ──────────────────────────────────────────────────
  const submit = useCallback(
    async (rawText) => {
      const text = String(rawText || '').trim();
      if (!text || busyRef.current) return;

      busyRef.current = true;
      setBusy(true);
      lastUserText.current = text;
      setQueryCount((c) => c + 1);
      speech.stopSpeaking();
      activity.push(STATES.RECEIVED, text.slice(0, 48));

      addEntry({ role: 'user', text });
      contentsRef.current = [...contentsRef.current, { role: 'user', parts: [{ text }] }].slice(-MAX_TURNS);

      const controller = new AbortController();
      abortRef.current = controller;
      const ctx = ctxRef.current;
      let finalText = '';
      let assistantId = null;
      // Guards against double-posting: the in-loop branches commit the final
      // assistant entry themselves and null out assistantId, so the post-loop
      // fallback must not add it a second time. (This caused every reply to
      // render twice in the deployed build.)
      let posted = false;

      /** Execute a plan from the local engine: run its tool calls, then speak. */
      const runPlan = async (plan) => {
        const summaries = [];
        if (plan.calls?.length) {
          for (const c of plan.calls) {
            const traceId = addEntry({ role: 'trace', name: c.name, status: 'run', detail: '' });
            const out = await executeTool({ ...c, id: c.id }, ctx);
            updateEntry(traceId, {
              status: out.result.ok ? 'done' : 'fail',
              detail: String(out.result.summary || '').slice(0, 90),
            });
            summaries.push(String(out.result.summary || ''));
          }
        }
        return plan.text || summaries.filter(Boolean).join(' ') ||
          'Local engine could not resolve that, Commander.';
      };

      // `keepBadge` is used when the link itself is healthy but the model
      // returned nothing: the LIVE badge stays on, because it is telling the
      // truth — only this one answer had to be resolved locally.
      const runOffline = async (err, { keepBadge = false, emptyReason = '' } = {}) => {
        if (!keepBadge) {
          setConn((c) => ({ ...c, state: 'offline', detail: explainError(err) }));
        }
        activity.push(STATES.PROCESSING, 'local core engaged');
        const plan = offlinePlan(text, ctx);
        finalText = await runPlan(plan);

        // The give-up text blames the link. When the link is actually fine and
        // the model merely returned nothing, that would be a lie — report the
        // real reason instead.
        if (plan.gaveUp && emptyReason) {
          finalText =
            `${emptyReason} I could not resolve it locally either. Try rephrasing, ` +
            'or ask something I can act on — "what time is it", "where am I", "open YouTube", "calculate 45*12".';
        }
        return finalText;
      };

      // ── local-first routing ──────────────────────────────────────────
      // Deterministic intents (time, date, GPS, maths, timers, opening sites,
      // HUD, sensors) and knowledge lookups are answered HERE, with no model
      // call at all. That is faster, free, works offline, and stops the Gemini
      // free-tier quota from being burned on questions we can already answer.
      let handledLocally = false;
      const cacheKey = normalizeQuery(text).l;
      const cached = cacheGet(cacheKey);
      if (cached) {
        handledLocally = true;
        activity.push(STATES.PROCESSING, 'answered from cache');
        addEntry({ role: 'trace', name: 'cache-hit', status: 'done', detail: 'no model call needed' });
        finalText = cached;
      } else {
        const local = routeLocal(text, ctx);
        if (local.local && local.confidence >= LOCAL_FIRST_THRESHOLD) {
          handledLocally = true;
          activity.push(STATES.PROCESSING, `local engine · ${local.intent}`);
          addEntry({
            role: 'trace',
            name: 'local-engine',
            status: 'done',
            detail: `${local.intent} · confidence ${local.confidence.toFixed(2)} · no model call`,
          });
          finalText = await runPlan(local);
          cacheSet(cacheKey, finalText);
        }
      }

      try {
        for (let round = 0; round < MAX_ROUNDS && !handledLocally; round++) {
          if (controller.signal.aborted) break;
          setCoreStatus('PROCESSING');
          activity.push(STATES.PROCESSING, round ? `tool round ${round + 1}` : 'awaiting model');

          assistantId = addEntry({ role: 'assistant', text: '', streaming: true });

          const res = await sendTurn({
            contents: contentsRef.current,
            signal: controller.signal,
            onDelta: (_chunk, full) => updateEntry(assistantId, { text: full }),
          });

          // ── link failure → local core ────────────────────────────────
          if (!res.ok) {
            removeEntry(assistantId);
            assistantId = null;
            if (res.error?.code === 'aborted') { finalText = 'Cancelled, Commander.'; break; }
            const blob = `${res.error?.code || ''} ${res.error?.message || ''} ${res.error?.hint || ''}`;
            if (/quota|rate.?limit|\b429\b/i.test(blob)) {
              const secs = /retry in ([\d.]+)\s*s/i.exec(blob)?.[1];
              const wait = secs ? Math.ceil(parseFloat(secs)) : null;
              pushToast({
                kind: 'err',
                title: 'Gemini quota reached',
                message: wait
                  ? `The free tier allows ~20 requests/minute. It refills in about ${wait}s — answering from the local engine meanwhile.`
                  : 'The free-tier quota is exhausted. Answering from the local engine; the link will recover on its own.',
              });
              setConn((c) => ({ ...c, state: 'offline', detail: wait ? `quota refills in ~${wait}s` : 'quota exhausted' }));
            }
            finalText = await runOffline(res.error);
            break;
          }

          setConn({ state: 'live', detail: res.model || conn.model, model: res.model, tools: conn.tools });

          // ── tool calls ───────────────────────────────────────────────
          if (res.functionCalls?.length) {
            if (res.text) updateEntry(assistantId, { text: res.text, streaming: false });
            else removeEntry(assistantId);
            assistantId = null;

            contentsRef.current = [
              ...contentsRef.current,
              {
                role: 'model',
                parts: res.functionCalls.map((c) => ({
                  functionCall: { name: c.name, args: c.args || {}, ...(c.id ? { id: c.id } : {}) },
                })),
              },
            ].slice(-MAX_TURNS);

            const responses = [];
            for (const c of res.functionCalls) {
              const traceId = addEntry({ role: 'trace', name: c.name, status: 'run', detail: summarizeArgs(c.args) });
              activity.push(STATES.PROCESSING, c.name);
              const out = await executeTool(c, ctx);
              updateEntry(traceId, {
                status: out.result.ok ? 'done' : 'fail',
                detail: String(out.result.summary || '').slice(0, 110),
              });
              responses.push(toFunctionResponse(out));
            }

            contentsRef.current = [...contentsRef.current, { role: 'user', parts: responses }].slice(-MAX_TURNS);
            continue;
          }

          // ── plain text answer ────────────────────────────────────────
          if (!res.text) {
            // The model handed back a candidate with NO answer text — thinking
            // budget exhausted, an over-eager safety stop, or a truncated
            // stream. Never dead-end on it: the local core can still resolve
            // the time, the date, GPS, web actions, maths, timers and even
            // open-ended questions via keyless Wikipedia.
            removeEntry(assistantId);
            assistantId = null;
            const why = emptyAnswerMessage(res);
            addEntry({ role: 'trace', name: 'local-core', status: 'done', detail: `empty model answer → ${why.slice(0, 70)}` });
            activity.push(STATES.PROCESSING, 'empty model answer · local engine');
            // Only accept a LOCAL answer we are confident in. Otherwise an
            // opaque query would trigger a speculative web search and a new
            // tab, when the honest thing is to explain the empty answer.
            const local = routeLocal(text, ctx);
            if (local.confidence >= LOCAL_FIRST_THRESHOLD) {
              finalText = await runPlan(local);
            } else {
              finalText =
                `${why} I could not resolve it locally either. Try rephrasing, or ask something I can act on — ` +
                '"what time is it", "where am I", "open YouTube", "what is <topic>", "how to <task>".';
            }
            // Deliberately NOT setting `posted`: the post-loop fallback commits
            // this answer as the single assistant entry.
            contentsRef.current = [...contentsRef.current, { role: 'model', parts: [{ text: finalText }] }].slice(-MAX_TURNS);
            break;
          }

          finalText = res.text;
          if (res.blocked) finalText = 'That request was stopped by the safety filter, Commander.';
          else cacheSet(cacheKey, finalText);
          updateEntry(assistantId, { text: finalText, streaming: false });
          posted = true;
          assistantId = null;
          contentsRef.current = [...contentsRef.current, { role: 'model', parts: [{ text: finalText }] }].slice(-MAX_TURNS);
          break;
        }

        if (!posted) {
          if (!finalText) {
            finalText =
              `I hit the ${MAX_ROUNDS}-round tool limit without settling on an answer. ` +
              'Try breaking the request into smaller steps, Commander.';
          }
          addEntry({ role: 'assistant', text: finalText });
        } else if (assistantId) {
          updateEntry(assistantId, { text: finalText, streaming: false });
        }

        activity.push(STATES.STANDBY, 'reply delivered');
        setCoreStatus('IDLE');
        if (finalText) speech.speak(finalText);
      } catch (e) {
        setCoreStatus('IDLE');
        const msg = `Unexpected error: ${e?.message || e}`;
        addEntry({ role: 'assistant', text: msg });
        pushToast({ kind: 'err', title: 'Link error', message: msg });
      } finally {
        busyRef.current = false;
        setBusy(false);
        abortRef.current = null;
      }
    },
    [activity, addEntry, updateEntry, removeEntry, conn, pushToast, speech],
  );

  const submitRef = useRef(submit);
  submitRef.current = submit;

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    speech.stopListening();
    speech.stopSpeaking();
  }, [speech]);

  // ── boot sequence ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let i = 0; i < BOOT_LINES.length; i++) {
        if (cancelled) return;
        setBootLog((prev) => [...prev.slice(-4), BOOT_LINES[i]]);
        setBootProgress(Math.round(((i + 1) / BOOT_LINES.length) * 100));
        await new Promise((r) => setTimeout(r, 160));
      }
      if (cancelled) return;

      const [probe, capAudit] = await Promise.all([probeBackend(), auditCapabilities()]);
      if (cancelled) return;
      setCaps(capAudit);
      setConn({
        state: probe.state === 'live' ? 'live' : probe.state === 'unconfigured' ? 'offline' : 'offline',
        detail: probe.state === 'live' ? `${probe.model} · ${probe.tools} tools` : probe.detail,
        model: probe.model,
        tools: probe.tools || TOOL_DECLARATIONS.length,
        configured: probe.configured,
      });
      if (probe.state !== 'live') {
        const wants = probe.requested === 'openai' ? 'the OpenAI-compatible provider (Groq)' : 'Gemini';
        pushToast({
          kind: 'warn',
          title: probe.state === 'unconfigured' ? 'No API key' : 'Offline',
          message:
            probe.state === 'unconfigured'
              ? // The proxy explains the exact misconfiguration in one sentence —
                // surface it verbatim instead of a generic "add your key".
                (probe.issues?.[0]
                  || `No key for ${wants} — running on the local reasoning core. Add OPENAI_API_KEY or GEMINI_API_KEY in .env.local or Vercel env vars, then redeploy.`)
              : `Cannot reach the model proxy (${probe.detail}). Local core engaged.`,
          ttl: 12000,
        });
      }
      setBooted(true);
      setTimeout(() => setBootProgress(100), 50);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // keep the capability audit fresh when the tab regains focus
  useEffect(() => {
    const onVisible = async () => { if (!document.hidden) setCaps(await auditCapabilities()); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // network status → badge
  useEffect(() => {
    const off = () => setConn((c) => ({ ...c, state: 'offline', detail: 'browser is offline' }));
    const on = async () => {
      const p = await probeBackend();
      setConn((c) => ({ ...c, state: p.state === 'live' ? 'live' : 'offline', detail: p.state === 'live' ? p.model : p.detail }));
    };
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => { window.removeEventListener('offline', off); window.removeEventListener('online', on); };
  }, []);

  // Escape closes the topmost overlay
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (permRequest) { resolvePermission(false); return; }
      if (viewport.open) { closeViewport(); return; }
      if (panel !== 'overview') setPanel('overview');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [permRequest, viewport.open, panel, resolvePermission, closeViewport]);

  const value = useMemo(
    () => ({
      app: APP,
      clock, transcript, busy, coreStatus, conn, queryCount,
      panel, setPanel, accent, setAccent, weather, setWeather, location,
      bootProgress, bootLog, booted, caps, refreshCaps: async () => setCaps(await auditCapabilities()),
      viewport, showViewport, closeViewport, showLaunchCard,
      permRequest, resolvePermission, ensurePermission,
      toasts, toast: pushToast, dismissToast,
      timers, activity, speech,
      submit, cancel,
      toolCount: TOOL_DECLARATIONS.length,
    }),
    [clock, transcript, busy, coreStatus, conn, queryCount, panel, accent, setAccent, weather, location,
     bootProgress, bootLog, booted, caps, viewport, showViewport, closeViewport, showLaunchCard,
     permRequest, resolvePermission, ensurePermission, toasts, pushToast, dismissToast, timers,
     activity, speech, submit, cancel],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Gemini can return a candidate with NO answer text — most commonly when a
 * thinking model spends its whole output budget on internal reasoning
 * (finishReason MAX_TOKENS). "I have nothing to report" hid that; say what
 * actually happened instead.
 */
/**
 * Small LRU answer cache. The Gemini free tier allows ~20 requests/minute and
 * an agentic loop spends one per tool round, so repeating a question — or a
 * whole demo run-through — can exhaust it in seconds. Knowledge answers are
 * stable, so we keep them for a while and never re-ask.
 */
const ANSWER_CACHE = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 60;

function cacheGet(key) {
  const hit = ANSWER_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) { ANSWER_CACHE.delete(key); return null; }
  ANSWER_CACHE.delete(key);          // re-insert → most-recently-used
  ANSWER_CACHE.set(key, hit);
  return hit.text;
}
function cacheSet(key, text) {
  if (!text || text.length < 12) return;
  ANSWER_CACHE.set(key, { text, at: Date.now() });
  while (ANSWER_CACHE.size > CACHE_MAX) ANSWER_CACHE.delete(ANSWER_CACHE.keys().next().value);
}

function emptyAnswerMessage(res) {
  const reason = res?.finishReason;
  if (reason === 'MAX_TOKENS') {
    return 'The model used its entire response budget on internal reasoning and produced no answer. ' +
           'Set QUARK_MAX_OUTPUT_TOKENS higher (or QUARK_THINKING_BUDGET lower) and ask again, Commander.';
  }
  if (reason === 'SAFETY' || reason === 'PROHIBITED_CONTENT') {
    return 'That request was stopped by the safety filter, Commander.';
  }
  if (reason) return `The model returned an empty answer (finish reason: ${reason}). Try rephrasing, Commander.`;
  return 'I have nothing to report on that, Commander.';
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const entries = Object.entries(args).slice(0, 3);
  return entries.map(([k, v]) => `${k}=${typeof v === 'string' ? `"${v.slice(0, 30)}"` : JSON.stringify(v)}`).join(' ');
}
