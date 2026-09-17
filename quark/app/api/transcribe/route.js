import { NextResponse } from 'next/server';

/**
 * Q.U.A.R.K. — fallback speech-to-text endpoint
 * ─────────────────────────────────────────────────────────────────────────
 * The browser's built-in SpeechRecognition (Chrome/Edge) streams audio to
 * Google's *speech* servers. On a college firewall, behind a proxy, inside an
 * embedded preview frame, or on Firefox entirely, that path fails with a terse
 * `network` / `service-not-allowed` error and voice input dies.
 *
 * This route is the fallback: the client records the microphone itself with
 * MediaRecorder and POSTs the audio here, and we hand it to the SAME Gemini key
 * the chat proxy already uses (`inlineData` audio part). No new service, no new
 * secret, no new bill line — just a different upstream path that our own server
 * controls.
 *
 * The key never leaves the server, exactly as in /api/chat.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 4 MB of base64 ≈ 3 MB of audio ≈ 3+ minutes of opus. Plenty for a command. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 120;

/** Codecs MediaRecorder can actually produce, best first. */
const ACCEPTED_MIME = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
];

const buckets = new Map();

function rateLimit(key, perMinute) {
  if (!perMinute || perMinute <= 0) return { ok: true, remaining: Infinity };
  const now = Date.now();
  const windowMs = 60_000;
  let b = buckets.get(key);
  if (!b || now - b.start > windowMs) {
    b = { start: now, count: 0 };
    buckets.set(key, b);
  }
  b.count += 1;
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (now - v.start > windowMs) buckets.delete(k);
  }
  return { ok: b.count <= perMinute, remaining: Math.max(0, perMinute - b.count) };
}

function clientIp(req) {
  const fwd = req.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return req.headers.get('x-real-ip') || 'unknown';
}

function env() {
  return {
    key: process.env.GEMINI_API_KEY?.trim() || '',
    model: (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
    base: (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, ''),
    timeoutMs: parseInt(process.env.QUARK_UPSTREAM_TIMEOUT_MS || '45000', 10),
    allowedOrigins: (process.env.QUARK_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ratePerMin: parseInt(process.env.QUARK_RATE_LIMIT_PER_MIN || '20', 10),
  };
}

/** Strip a `data:...;base64,` prefix if the client sent one. */
function stripDataUrl(s) {
  const m = /^data:([^;,]+)?(;[^,]*)?,(.*)$/s.exec(s);
  return m ? { mime: m[1] || '', data: m[3] } : { mime: '', data: s };
}

export async function GET() {
  const cfg = env();
  return NextResponse.json({
    service: 'quark-transcribe',
    version: '1.0.0',
    configured: Boolean(cfg.key),
    model: cfg.model,
    maxAudioSeconds: MAX_AUDIO_SECONDS,
    acceptedMimeTypes: ACCEPTED_MIME,
    hint: 'POST { audio: "<base64 or data URL>", mimeType: "audio/webm;codecs=opus" }',
  });
}

export async function POST(req) {
  const cfg = env();

  // ── 1. origin allowlist (blocks drive-by use of your key from other sites) ──
  const origin = req.headers.get('origin');
  if (cfg.allowedOrigins.length && origin && !cfg.allowedOrigins.includes(origin)) {
    return NextResponse.json(
      { ok: false, error: { code: 'origin_blocked', message: `Origin ${origin} is not allowed.` } },
      { status: 403 },
    );
  }

  // ── 2. key present? ────────────────────────────────────────────────────
  if (!cfg.key) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'unconfigured',
          message: 'No GEMINI_API_KEY on the server, so the fallback transcriber is unavailable.',
          hint: 'Voice input still works in Chrome/Edge via the built-in recogniser.',
        },
      },
      { status: 503 },
    );
  }

  // ── 3. rate limit ──────────────────────────────────────────────────────
  const rl = rateLimit(`t:${clientIp(req)}`, Math.max(5, Math.round(cfg.ratePerMin / 2)));
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: { code: 'rate_limited', message: 'Too many transcription requests.' } },
      { status: 429, headers: { 'Retry-After': '30' } },
    );
  }

  // ── 4. parse + validate ────────────────────────────────────────────────
  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json(
        { ok: false, error: { code: 'payload_too_large', message: `Audio exceeds ${MAX_BODY_BYTES / 1024 / 1024} MB. Record a shorter command.` } },
        { status: 413 },
      );
    }
    body = JSON.parse(text || '{}');
  } catch {
    return NextResponse.json({ ok: false, error: { code: 'bad_json', message: 'Body is not valid JSON.' } }, { status: 400 });
  }

  const raw = typeof body.audio === 'string' ? body.audio.trim() : '';
  if (!raw) {
    return NextResponse.json({ ok: false, error: { code: 'no_audio', message: 'No audio was supplied.' } }, { status: 400 });
  }
  const stripped = stripDataUrl(raw);
  const mime = String(body.mimeType || stripped.mime || 'audio/webm').split(';')[0].trim().toLowerCase();
  const fullMime = String(body.mimeType || stripped.mime || 'audio/webm;codecs=opus');
  if (!/^audio\//.test(mime) || !ACCEPTED_MIME.some((a) => a.split(';')[0] === mime)) {
    return NextResponse.json(
      { ok: false, error: { code: 'bad_mime', message: `Unsupported audio type "${fullMime}".`, hint: `Accepted: ${ACCEPTED_MIME.join(', ')}` } },
      { status: 415 },
    );
  }
  if (!/^[A-Za-z0-9+/=\s]+$/.test(stripped.data)) {
    return NextResponse.json({ ok: false, error: { code: 'bad_audio', message: 'Audio is not valid base64.' } }, { status: 400 });
  }

  // ── 5. ask Gemini to transcribe ────────────────────────────────────────
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: fullMime, data: stripped.data.replace(/\s+/g, '') } },
          {
            text:
              'Transcribe this microphone recording verbatim. Reply with ONLY the spoken words — ' +
              'no quotation marks, no labels, no commentary, no translation. ' +
              'If there is no intelligible speech, reply with exactly: NO_SPEECH',
          },
        ],
      },
    ],
    // Transcription needs no reasoning and no tools; keep it cheap and fast.
    generationConfig: { temperature: 0, maxOutputTokens: 512 },
  };

  const url = `${cfg.base}/models/${cfg.model}:generateContent`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  let upstream;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.key },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e?.name === 'AbortError';
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: aborted ? 'timeout' : 'network',
          message: aborted ? `Gemini did not respond within ${cfg.timeoutMs} ms.` : 'Could not reach Gemini.',
        },
      },
      { status: 504 },
    );
  }
  clearTimeout(timer);

  const resText = await upstream.text();
  let json = null;
  try { json = JSON.parse(resText); } catch { /* handled below */ }

  if (!upstream.ok) {
    const msg = json?.error?.message || resText.slice(0, 300);
    return NextResponse.json(
      { ok: false, error: { code: 'upstream', status: upstream.status, message: msg } },
      { status: upstream.status >= 500 ? 502 : upstream.status },
    );
  }

  const cand = json?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const text = parts
    .filter((p) => typeof p?.text === 'string' && p.thought !== true)
    .map((p) => p.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text || /^NO_SPEECH$/i.test(text)) {
    return NextResponse.json({
      ok: false,
      error: { code: 'no_speech', message: 'I could not hear any words in that recording, Commander.' },
    });
  }

  return NextResponse.json({
    ok: true,
    text: text.slice(0, 2000),
    model: cfg.model,
    finishReason: cand?.finishReason || null,
  });
}
