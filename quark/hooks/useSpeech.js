'use client';

/**
 * Q.U.A.R.K. — speech engine
 * ─────────────────────────────────────────────────────────────────────────
 * STT: Web Speech API SpeechRecognition (Chrome/Edge/Safari).
 * TTS: Web Speech API SpeechSynthesis (universal).
 *
 * Both are feature-detected, degrade gracefully, and the TTS preference is
 * persisted in localStorage (the original lost it on every reload).
 *
 * Chrome returns an empty voice list until `voiceschanged` fires, so the
 * voice preference is resolved lazily and re-resolved on that event — the
 * original project registered a no-op handler here and silently lost the
 * "male British voice" preference on the first reply.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { localSttSupported, transcribeLocally, LOCAL_STT_MODEL } from '@/lib/local-stt';

const PREF_KEY = 'quark.voice.enabled';
/**
 * When set, voice input never touches a network service: the browser's built-in
 * recogniser (which streams audio to Google's speech servers) is skipped, and
 * the server transcriber is never called. Only on-device Whisper runs.
 */
const LOCAL_ONLY_KEY = 'quark.voice.localOnly';
const VOICE_KEY = 'quark.voice.preferred';
const RATE_KEY = 'quark.voice.rate';

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function writePref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch { /* private mode */ }
}

/**
 * SpeechRecognition fails with terse machine codes. Each one has a real-world
 * cause the user can act on, so translate them instead of printing "network".
 */
const STT_ERRORS = {
  'not-allowed':
    'Microphone access is blocked for this page. Click the lock/tune icon in the address bar → Site settings → Microphone → Allow, then press the mic again.',
  'service-not-allowed':
    'The browser refused to start the speech service. Allow the microphone for this site, reload the page, and try again.',
  'audio-capture':
    'No microphone was found. Connect one (or enable it in your OS sound settings), then press the mic again.',
  network:
    "Speech recognition could not reach the recognition service. Chrome and Edge stream your audio to Google's servers to transcribe it, so a college firewall, proxy, ad-blocker or an embedded preview frame will block it. Typed commands still work — and so does voice output.",
  'no-speech': 'I did not catch any speech, Commander. Press the mic and try again.',
  'stt-timeout':
    'The built-in speech recogniser never responded, so I switched to recording the microphone directly. Speak, then click the mic again to stop.',
  'transcribe-network':
    'Could not reach this site\'s own transcription endpoint, so the recorded audio could not be converted to text. Check the connection and try again — typed commands still work.',
  'unsupported-recorder':
    'This browser supports neither the built-in speech recogniser nor MediaRecorder, so voice input is unavailable. Try Chrome, Edge or Firefox.',
  'language-not-supported':
    'This browser has no speech recogniser for the current page language. Switch your browser language to English and retry.',
  aborted: '',
};

/** Human reason for a SpeechRecognition failure ('' means "say nothing"). */
const LOCAL_ONLY_MSG =
  'On-device voice mode is ON, so nothing was uploaded — but the local model could not read that recording. '
  + 'Try again a little louder and closer to the mic, or say "use normal voice" to re-enable the fallbacks.';

export function explainSttError(code) {
  if (!code) return '';
  if (code === 'local-only') return LOCAL_ONLY_MSG;
  if (code in STT_ERRORS) return STT_ERRORS[code];
  const c = String(code);
  if (c.startsWith('transcribe-failed-')) {
    return `The fallback transcriber answered HTTP ${c.replace('transcribe-failed-', '')}. If no API key is set on the server this feature is unavailable — typed commands still work.`;
  }
  // The server may hand back a sentence that is already human-readable.
  if (c.length > 40 || /\s/.test(c)) return c;
  return `Speech recognition error: ${c}`;
}

/** Codecs MediaRecorder can produce, best first. Must match the server list. */
const RECORDER_MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
/**
 * Chrome's recogniser can hang forever without firing onstart OR onerror when
 * its speech service is unreachable (headless, firewall, sandboxed frame). If
 * nothing at all happens within this window we declare it dead and switch to
 * the recorder fallback — otherwise the mic button just looks broken.
 */
const STT_START_TIMEOUT_MS = 6000;

/** Hard cap on one fallback recording, so a forgotten mic cannot run forever. */
const MAX_FALLBACK_MS = 20_000;

function pickRecorderMime() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return RECORDER_MIMES[0];
  return RECORDER_MIMES.find((t) => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '';
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result).split(',')[1] || '');
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(blob);
  });
}

export function useSpeech({ onFinalTranscript, onInterim, onStateChange } = {}) {
  const [sttSupported, setSttSupported] = useState(false);
  const [recorderSupported, setRecorderSupported] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [modelProgress, setModelProgress] = useState(null);
  const [fallbackMode, setFallbackMode] = useState(false);
  const [ttsSupported, setTtsSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [voices, setVoices] = useState([]);
  const [voiceName, setVoiceName] = useState('');
  const [rate, setRate] = useState(1);
  const [localOnly, setLocalOnlyState] = useState(false);
  const localOnlyRef = useRef(false);

  const recognitionRef = useRef(null);
  const stopRef = useRef(false);
  const retriedRef = useRef(false);
  const recorderRef = useRef(null);
  const micStreamRef = useRef(null);
  const capTimerRef = useRef(null);
  const fallbackModeRef = useRef(false);
  const fallbackStartRef = useRef(null);
  const startedRef = useRef(false);
  const watchdogRef = useRef(null);
  const cbRef = useRef({ onFinalTranscript, onInterim, onStateChange });
  cbRef.current = { onFinalTranscript, onInterim, onStateChange };

  // ── TTS setup ──────────────────────────────────────────────────────────
  useEffect(() => {
    const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
    setTtsSupported(!!synth);
    if (!synth) return;

    setEnabled(readPref(PREF_KEY, 'true') !== 'false');
    setRate(parseFloat(readPref(RATE_KEY, '1')) || 1);
    setVoiceName(readPref(VOICE_KEY, '') || '');

    const load = () => {
      const list = synth.getVoices() || [];
      setVoices(list);
      // Resolve a sensible default only if the user has not chosen one
      setVoiceName((current) => {
        if (current && list.some((v) => v.name === current)) return current;
        const pick =
          list.find((v) => /Google UK English Male|Daniel|Microsoft Ryan|Male/i.test(v.name) && /^en/i.test(v.lang)) ||
          list.find((v) => /^en-IN/i.test(v.lang)) ||
          list.find((v) => /^en/i.test(v.lang)) ||
          list[0];
        return pick?.name || '';
      });
    };

    load(); // may be empty on first call
    synth.addEventListener?.('voiceschanged', load);
    return () => synth.removeEventListener?.('voiceschanged', load);
  }, []);

  // ── STT setup ──────────────────────────────────────────────────────────
  useEffect(() => {
    const Impl = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;
    setSttSupported(!!Impl);
    setRecorderSupported(
      typeof window !== 'undefined' &&
      typeof window.MediaRecorder !== 'undefined' &&
      Boolean(navigator.mediaDevices?.getUserMedia),
    );
    if (!Impl) return;

    const rec = new Impl();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      startedRef.current = true;
      clearTimeout(watchdogRef.current);
      retriedRef.current = false;
      setListening(true);
      cbRef.current.onStateChange?.('listening', true);
    };
    rec.onend = () => {
      clearTimeout(watchdogRef.current);
      // The recorder fallback owns the listening state now; a late recogniser
      // shutdown must not flip the UI (or double-stop) underneath it.
      if (fallbackModeRef.current && recorderRef.current) return;
      setListening(false);
      cbRef.current.onStateChange?.('listening', false);
    };
    rec.onerror = (e) => {
      const code = e?.error || 'unknown';
      clearTimeout(watchdogRef.current);
      // Already abandoned the recogniser (watchdog fired or a previous error
      // switched us over). Its late 'aborted'/'network' events are noise, and
      // acting on them would start a SECOND recorder and double-submit.
      if (fallbackModeRef.current) return;
      setListening(false);
      cbRef.current.onStateChange?.('listening', false);

      // The recogniser's uplink is flaky on restricted networks; one silent
      // retry recovers most transient 'network' failures without a scary toast.
      if (code === 'network' && !retriedRef.current && !stopRef.current) {
        retriedRef.current = true;
        cbRef.current.onStateChange?.('stt-retry', true);
        setTimeout(() => {
          if (stopRef.current) return;
          try { rec.start(); } catch { cbRef.current.onStateChange?.('stt-error', code); }
        }, 800);
        return;
      }
      // Built-in recognition is blocked at the network layer (firewall, proxy,
      // embedded frame) or by policy. Fall back to recording the mic ourselves
      // and transcribing through our own server, which we control.
      if ((code === 'network' || code === 'service-not-allowed') && !stopRef.current) {
        fallbackModeRef.current = true;
        setFallbackMode(true);
        cbRef.current.onStateChange?.('stt-fallback', code);
        setTimeout(() => { if (!stopRef.current) fallbackStartRef.current?.(); }, 300);
        return;
      }
      cbRef.current.onStateChange?.('stt-error', code);
    };
    rec.onresult = (event) => {
      let interim = '';
      let final = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (interim) cbRef.current.onInterim?.(interim);
      if (final.trim()) cbRef.current.onFinalTranscript?.(final.trim());
    };

    recognitionRef.current = rec;
    return () => {
      stopRef.current = true;
      clearTimeout(watchdogRef.current);
      clearTimeout(capTimerRef.current);
      try { rec.abort(); } catch { /* already stopped */ }
      try { micStreamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
      recognitionRef.current = null;
    };
  }, []);

  /**
   * Ask the browser for the microphone up-front. Some browsers never surface a
   * permission prompt for SpeechRecognition alone and just fail, and a denied
   * mic is indistinguishable from a network failure unless we ask explicitly.
   * The probe stream is released at once — the recogniser opens the device
   * itself. Returns true, or an STT error code explaining why not.
   */
  const ensureMic = useCallback(async () => {
    if (typeof navigator === 'undefined') return true;
    // Sandboxed iframes (embedded previews) block getUserMedia outright.
    if (typeof window !== 'undefined' && window.self !== window.top) {
      try {
        if (!navigator.permissions) return true;
      } catch { /* ignore */ }
    }
    if (!navigator.mediaDevices?.getUserMedia) return true; // nothing to probe with
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      return true;
    } catch (err) {
      const name = err?.name || '';
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'audio-capture';
      if (name === 'NotReadableError' || name === 'TrackStartError') return 'audio-capture';
      if (name === 'SecurityError') return 'not-allowed';
      return 'not-allowed';
    }
  }, []);

  /**
   * Fallback STT: record the microphone with MediaRecorder and POST the audio
   * to /api/transcribe, which hands it to the same Gemini key the chat proxy
   * uses. Works wherever getUserMedia works — including Firefox and networks
   * that block Google's speech servers.
   */
  const startFallbackListening = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      cbRef.current.onStateChange?.('stt-error', 'audio-capture');
      return false;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      cbRef.current.onStateChange?.('stt-error', 'not-allowed');
      return false;
    }
    micStreamRef.current = stream;
    const mimeType = pickRecorderMime();
    let rec;
    try {
      rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      cbRef.current.onStateChange?.('stt-error', 'audio-capture');
      return false;
    }

    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      clearTimeout(capTimerRef.current);
      setListening(false);
      cbRef.current.onStateChange?.('listening', false);
      stream.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
      recorderRef.current = null;

      const type = rec.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(chunks, { type });
      if (blob.size < 1500) { cbRef.current.onStateChange?.('stt-error', 'no-speech'); return; }

      setTranscribing(true);
      cbRef.current.onStateChange?.('stt-transcribing', true);
      try {
        // PATH 2 — on-device Whisper. No API key, no quota, no upload: the
        // audio is transcribed in this tab. Only the model weights are fetched,
        // once, and the browser caches them.
        if (localSttSupported()) {
          cbRef.current.onStateChange?.('stt-model', 'loading');
          const local = await transcribeLocally(blob, {
            onProgress: (pr) => {
              if (pr?.status === 'progress' && pr.file && pr.progress != null) {
                const info = { file: String(pr.file), pct: Math.round(pr.progress) };
                setModelProgress(info);
                cbRef.current.onStateChange?.('stt-model-progress', info);
              }
            },
          });
          setModelProgress(null);
          if (local.ok) {
            cbRef.current.onStateChange?.('stt-local', local);
            cbRef.current.onFinalTranscript?.(local.text);
            return;
          }
          if (local.error === 'no-speech') {
            cbRef.current.onStateChange?.('stt-error', 'no-speech');
            return;
          }
          // Weights blocked, no WebGPU/WASM, decode failure — try the server.
          cbRef.current.onStateChange?.('stt-local-failed', local.detail ? `${local.error}: ${local.detail}` : (local.error || 'unknown'));
        }

        // On-device mode stops here — uploading would defeat the whole point.
        if (localOnlyRef.current) {
          cbRef.current.onStateChange?.('stt-error', 'local-only');
          return;
        }

        // PATH 3 — server-side transcription using the Gemini key.
        const b64 = await blobToBase64(blob);
        const r = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ audio: b64, mimeType: type }),
        });
        const j = await r.json().catch(() => null);
        if (r.ok && j?.ok && j.text) cbRef.current.onFinalTranscript?.(j.text);
        else if (j?.error?.code === 'no_speech') cbRef.current.onStateChange?.('stt-error', 'no-speech');
        else cbRef.current.onStateChange?.('stt-error', j?.error?.message || `transcribe-failed-${r.status}`);
      } catch {
        cbRef.current.onStateChange?.('stt-error', 'transcribe-network');
      } finally {
        setModelProgress(null);
        setTranscribing(false);
        cbRef.current.onStateChange?.('stt-transcribing', false);
      }
    };

    recorderRef.current = rec;
    stopRef.current = false;
    try { rec.start(); } catch { return false; }
    setListening(true);
    cbRef.current.onStateChange?.('listening', true);
    capTimerRef.current = setTimeout(() => { try { rec.stop(); } catch { /* already stopped */ } }, MAX_FALLBACK_MS);
    return true;
  }, []);
  fallbackStartRef.current = startFallbackListening;

  const startListening = useCallback(async () => {
    if (fallbackModeRef.current) return startFallbackListening();
    // On-device mode: never hand audio to the browser's cloud recogniser.
    // Go straight to the recorder + local Whisper path.
    if (localOnlyRef.current) return startFallbackListening();
    const rec = recognitionRef.current;
    if (!rec) return startFallbackListening();
    const mic = await ensureMic();
    if (mic !== true) {
      cbRef.current.onStateChange?.('stt-error', mic);
      return false;
    }
    try {
      stopRef.current = false;
      retriedRef.current = false;
      startedRef.current = false;
      rec.start();
    } catch {
      // InvalidStateError = already running; anything else = unusable.
      return true;
    }
    clearTimeout(watchdogRef.current);
    watchdogRef.current = setTimeout(() => {
      if (startedRef.current || stopRef.current || fallbackModeRef.current) return;
      try { rec.abort(); } catch { /* noop */ }
      fallbackModeRef.current = true;
      setFallbackMode(true);
      cbRef.current.onStateChange?.('stt-fallback', 'timeout');
      fallbackStartRef.current?.();
    }, STT_START_TIMEOUT_MS);
    return true;
  }, [ensureMic, startFallbackListening]);

  const stopListening = useCallback(() => {
    stopRef.current = true;
    clearTimeout(capTimerRef.current);
    clearTimeout(watchdogRef.current);
    let stopped = false;
    try { if (recorderRef.current?.state === 'recording') { recorderRef.current.stop(); stopped = true; } } catch { /* noop */ }
    const rec = recognitionRef.current;
    try { if (rec) { rec.stop(); stopped = true; } } catch { /* noop */ }
    return stopped;
  }, []);

  const toggleListening = useCallback(() => {
    if (listening) { stopListening(); return false; }
    return startListening();
  }, [listening, startListening, stopListening]);

  const speak = useCallback(
    (text, opts = {}) => {
      const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
      if (!synth) return false;
      synth.cancel();
      const clean = String(text || '')
        .replace(/<[^>]*>/g, ' ')          // strip any markup the model tried
        .replace(/[*_`#>|]/g, ' ')         // strip markdown artefacts
        .replace(/\s+/g, ' ')
        .trim();
      if (!clean) return false;
      if (!enabled && opts.force !== true) return false;

      const utter = new SpeechSynthesisUtterance(clean.slice(0, 900));
      utter.rate = Math.min(Math.max(opts.rate ?? rate ?? 1, 0.5), 2);
      utter.pitch = opts.pitch ?? 0.85;
      const v = voices.find((x) => x.name === (opts.voiceName || voiceName));
      if (v) utter.voice = v;
      utter.onstart = () => setSpeaking(true);
      utter.onend = () => setSpeaking(false);
      utter.onerror = () => setSpeaking(false);
      synth.speak(utter);
      return true;
    },
    [enabled, rate, voices, voiceName],
  );

  const stopSpeaking = useCallback(() => {
    try { window.speechSynthesis?.cancel(); } catch { /* noop */ }
    setSpeaking(false);
  }, []);

  // Hydrate the on-device-only preference once, on mount.
  useEffect(() => {
    const on = readPref(LOCAL_ONLY_KEY, 'false') === 'true';
    localOnlyRef.current = on;
    setLocalOnlyState(on);
  }, []);

  /**
   * Turn on-device-only voice mode on or off, persisted across reloads.
   * Returns the new value so callers can report it.
   */
  const setLocalOnly = useCallback((on) => {
    const v = Boolean(on);
    localOnlyRef.current = v;
    setLocalOnlyState(v);
    writePref(LOCAL_ONLY_KEY, v ? 'true' : 'false');
    return v;
  }, []);

  const toggleVoice = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      writePref(PREF_KEY, next);
      if (!next) { try { window.speechSynthesis?.cancel(); } catch { /* noop */ } setSpeaking(false); }
      return next;
    });
  }, []);

  const chooseVoice = useCallback((name) => { setVoiceName(name); writePref(VOICE_KEY, name); }, []);
  const chooseRate = useCallback((r) => { const v = Math.min(Math.max(Number(r) || 1, 0.5), 2); setRate(v); writePref(RATE_KEY, v); }, []);

  return {
    sttSupported, ttsSupported, listening, speaking, enabled,
    recorderSupported, transcribing, fallbackMode,
    localSttSupported: localSttSupported(), localSttModel: LOCAL_STT_MODEL, modelProgress,
    voices, voiceName, rate,
    localOnly, setLocalOnly,
    startListening, startFallbackListening, stopListening, toggleListening,
    speak, stopSpeaking, toggleVoice, chooseVoice, chooseRate,
  };
}
