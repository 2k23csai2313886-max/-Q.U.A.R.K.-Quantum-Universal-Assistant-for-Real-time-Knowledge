/**
 * Q.U.A.R.K. — on-device speech-to-text
 * ─────────────────────────────────────────────────────────────────────────
 * Runs Whisper *inside the browser* via Transformers.js (ONNX Runtime Web).
 *
 *   • No API key. No server. No per-request cost. No quota.
 *   • Audio never leaves the machine — the model runs on WebGPU if the browser
 *     has it, otherwise WASM/CPU.
 *   • The weights (~45 MB, quantised) download once and are then cached by the
 *     browser's HTTP cache, so later sessions start instantly.
 *
 * This is the SECOND voice path. Order of preference in useSpeech:
 *   1. built-in SpeechRecognition (free, instant, but needs Google's servers)
 *   2. this module            (fully local, no network after the first download)
 *   3. /api/transcribe        (server-side, uses the Gemini key — last resort)
 *
 * The library is loaded from a pinned CDN URL with `webpackIgnore` so Next.js
 * never tries to bundle a 450 KB ESM blob into the client chunk graph; it is
 * fetched lazily, only when the user actually needs the fallback.
 */

const CDN_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/+esm';
export const LOCAL_STT_MODEL = 'onnx-community/whisper-tiny.en';

/**
 * Where self-hosted weights live, relative to this deployment's origin.
 * The ~41 MB of ONNX (encoder 10 MB + decoder 31 MB) plus tokenizer config is
 * committed under public/models/, so the first voice command needs no third
 * party at all. If the files are absent (e.g. a slim checkout), we fall back to
 * the Hugging Face CDN automatically.
 */
export const LOCAL_MODEL_BASE = '/models';
const WEIGHT_PROBE = `${LOCAL_MODEL_BASE}/${LOCAL_STT_MODEL}/onnx/decoder_model_merged_quantized.onnx`;

let weightsSource = null; // 'self-hosted' | 'cdn' | null

/** True when this deployment ships the ONNX weights itself. Cached per page. */
export async function selfHostedWeights() {
  if (weightsSource != null) return weightsSource === 'self-hosted';
  try {
    const r = await fetch(WEIGHT_PROBE, { method: 'HEAD' });
    weightsSource = r.ok && Number(r.headers.get('content-length') || 0) > 1_000_000
      ? 'self-hosted'
      : 'cdn';
  } catch {
    weightsSource = 'cdn';
  }
  return weightsSource === 'self-hosted';
}

let loaderPromise = null;

/** Cheap, synchronous feature check — no download implied. */
export function localSttSupported() {
  if (typeof window === 'undefined') return false;
  if (!navigator.mediaDevices?.getUserMedia) return false;
  if (typeof MediaRecorder === 'undefined') return false;
  if (typeof WebAssembly === 'undefined') return false;
  // Cross-origin isolation isn't required for WASM (only for SIMD threads),
  // so this works on a plain Vercel deployment.
  return true;
}

/**
 * `navigator.gpu` existing is NOT enough — headless Chrome, most Linux setups
 * and any browser without a GPU process expose it but return a null adapter,
 * and ONNX Runtime then fails with "no available backend found". Actually ask
 * for the adapter and fall back to WASM (CPU), which works everywhere.
 */
export async function pickDevice() {
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return 'webgpu';
    } catch { /* fall through to wasm */ }
  }
  return 'wasm';
}

/** Synchronous, best-effort hint for UI copy only. Never used to choose. */
export function hasWebGPU() {
  return typeof navigator !== 'undefined' && Boolean(navigator.gpu);
}

/**
 * Load Transformers.js and build the ASR pipeline once.
 * @param {(p:{status:string,file?:string,progress?:number,total?:number,loaded?:number})=>void} [onProgress]
 */
export function loadLocalStt(onProgress) {
  if (!loaderPromise) {
    loaderPromise = (async () => {
      const mod = await import(/* webpackIgnore: true */ CDN_URL);

      // Prefer the weights this deployment ships: no third party, works on a
      // private network, and survives the CDN being blocked or rate-limited.
      const selfHosted = await selfHostedWeights();
      mod.env.allowLocalModels = selfHosted;
      mod.env.localModelPath = selfHosted ? `${LOCAL_MODEL_BASE}/` : './models/';
      // Keep the Hub reachable for anything we did not vendor.
      mod.env.allowRemoteModels = true;
      mod.env.useBrowserCache = true;
      if (onProgress) {
        try {
          onProgress({ status: 'source', source: selfHosted ? 'self-hosted' : 'cdn' });
        } catch { /* UI callback must never break loading */ }
      }

      const device = await pickDevice();
      const pipeline = await mod.pipeline('automatic-speech-recognition', LOCAL_STT_MODEL, {
        device,
        // q8 keeps the download near 45 MB and is the recommended dtype for
        // both WebGPU and WASM on this model.
        dtype: 'q8',
        progress_callback: (p) => {
          if (!onProgress) return;
          try { onProgress(p); } catch { /* UI callback must never break loading */ }
        },
      });
      return { pipeline, device, mod };
    })().catch((err) => {
      loaderPromise = null; // allow a retry on the next click
      throw err;
    });
  }
  return loaderPromise;
}

/** Decode a recorded Blob to the mono 16 kHz Float32Array Whisper expects. */
async function decodeTo16k(blob) {
  const AC = typeof AudioContext !== 'undefined' ? AudioContext : window.webkitAudioContext;
  if (!AC) throw new Error('Web Audio is unavailable in this browser');
  const ac = new AC({ sampleRate: 16000 });
  try {
    const buf = await blob.arrayBuffer();
    const decoded = await ac.decodeAudioData(buf);
    const channel = decoded.getChannelData(0);
    if (decoded.sampleRate === 16000) return channel;
    // decodeAudioData usually honours the context rate; resample if it did not.
    const ratio = decoded.sampleRate / 16000;
    const out = new Float32Array(Math.floor(channel.length / ratio));
    for (let i = 0; i < out.length; i++) out[i] = channel[Math.floor(i * ratio)];
    return out;
  } finally {
    try { await ac.close(); } catch { /* already closed */ }
  }
}

/**
 * Whisper hallucinates subtitle-credits and boilerplate on non-speech audio
 * (silence, hums, beeps). These are never real commands, so they are dropped.
 * Short single words like "hello" are deliberately NOT filtered — they are
 * perfectly plausible voice commands.
 */
const HALLUCINATION =
  /^(?:\s*(?:subtitles?|captions?|transcript|transcribed)\s+(?:by|from)|amara\.org|\[.*\]|♪+|music|applause|\s)*$/i;
const BOILERPLATE =
  /(thanks? for watching|thank you for (?:watching|listening)|please (?:subscribe|like)|like and subscribe|subscribe (?:to )?(?:my|the) channel|see you (?:next time|in the next)|until next time|ご視聴|中文字幕|뉴스|자막)/i;

/** Root-mean-square energy gate: near-silent recordings are not worth inferencing. */
function rms(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  const step = Math.max(1, Math.floor(samples.length / 20000)); // cap the work
  let n = 0;
  for (let i = 0; i < samples.length; i += step) { sum += samples[i] * samples[i]; n++; }
  return Math.sqrt(sum / Math.max(1, n));
}
const SILENCE_RMS = 0.004;

/**
 * Single-word outputs Whisper emits on non-speech noise. Deliberately narrow:
 * real one-word commands ("time", "date", "hello", "thanks") must still pass.
 */
const FILLER_WORDS = new Set([
  'you', 'your', 'yours', 'the', 'a', 'an', 'and', 'of', 'to', 'in', 'is', 'it',
  'ok', 'okay', 'uh', 'um', 'hmm', 'yeah', 'yay', 'oh', 'ah', 'hey?', 'so',
  'subtitles', 'subtitle', 'caption', 'captions', 'transcript', 'blank', 'silence',
]);

/** True when the whole transcript is one meaningless token. */
function isFillerOnly(text) {
  const t = String(text || '').toLowerCase().replace(/[^a-z'\s]/g, '').trim();
  if (!t || t.includes(' ')) return false;
  return FILLER_WORDS.has(t);
}

/**
 * Transcribe a recorded audio Blob entirely on-device.
 * @returns {Promise<{ok:true,text:string,device:string,seconds:number}|{ok:false,error:string,detail?:string}>}
 */
export async function transcribeLocally(blob, { onProgress } = {}) {
  const started = Date.now();
  let pipeline;
  let device = 'wasm';
  try {
    ({ pipeline, device } = await loadLocalStt(onProgress));
  } catch (e) {
    return { ok: false, error: 'model-load-failed', detail: e?.message || String(e) };
  }

  let audio;
  try {
    audio = await decodeTo16k(blob);
  } catch (e) {
    return { ok: false, error: 'decode-failed', detail: e?.message || String(e) };
  }
  if (!audio || audio.length < 3200) return { ok: false, error: 'no-speech' }; // <0.2 s

  // Skip inference entirely on a near-silent clip: it is the single biggest
  // source of Whisper hallucinations, and it also saves seconds of CPU.
  const level = rms(audio);
  if (level < SILENCE_RMS) return { ok: false, error: 'no-speech', detail: `rms=${level.toFixed(5)}` };

  try {
    // The `.en` checkpoints are English-only: Transformers.js v4 throws
    // "Cannot specify `task` or `language` for an English-only model" when they
    // are passed. Only multilingual checkpoints accept those options.
    const multilingual = !/\.en(?![a-z])/i.test(LOCAL_STT_MODEL);
    const out = await pipeline(audio, {
      chunk_length_s: 30,
      stride_length_s: 5,
      ...(multilingual ? { language: 'english', task: 'transcribe' } : {}),
    });
    const text = String(out?.text || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length < 2 || isFillerOnly(text) || HALLUCINATION.test(text) || BOILERPLATE.test(text)) {
      return { ok: false, error: 'no-speech', detail: text ? `filtered: "${text.slice(0, 40)}"` : 'empty' };
    }
    return { ok: true, text, device, seconds: (Date.now() - started) / 1000, rms: Number(level.toFixed(4)), source: weightsSource || 'cdn' };
  } catch (e) {
    return { ok: false, error: 'inference-failed', detail: e?.message || String(e) };
  }
}
