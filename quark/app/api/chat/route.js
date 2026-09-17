/**
 * Q.U.A.R.K. — Gemini proxy (server-side only)
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *   A browser can call api.anthropic.com / generativelanguage.googleapis.com
 *   directly, but only if the API key is embedded in the page — which means
 *   anyone can read it from View Source and burn your quota. On a public
 *   Vercel URL that happens within hours.
 *
 *   So the key lives here, in the serverless function's environment. The
 *   browser talks to /api/chat (same origin, no CORS, no key). This function
 *   adds the key and forwards to Gemini.
 *
 *   `process.env.GEMINI_API_KEY` has no NEXT_PUBLIC_ prefix, therefore Next.js
 *   never inlines it into any client chunk. It exists only in this runtime.
 *
 * Also handled here: origin allowlist, best-effort rate limiting, upstream
 * timeout, request-size cap, and typed error mapping so the HUD can explain
 * exactly what went wrong instead of silently falling back.
 */

import { NextResponse } from 'next/server';
import { TOOL_DECLARATIONS } from '@/lib/tools';
import { selectDeclarations } from '@/lib/tool-selection';
import { SYSTEM_PROMPT, GENERATION_DEFAULTS, buildSystemPrompt } from '@/lib/system-prompt';

import {
  toOpenAIRequest,
  mapOpenAIResponse,
  chunkText,
  classifyOpenAI,
} from '@/lib/llm-openai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel serverless max duration (Hobby plan caps at 60s).
export const maxDuration = 60;

const MAX_BODY_BYTES = 512 * 1024; // 512 KB of conversation is far more than enough
const MAX_MESSAGES = 60;

// ── best-effort in-memory rate limit ──────────────────────────────────────
// NOTE: Vercel serverless functions are stateless and may run on many
// instances, so this only throttles a single warm instance. For a hard
// guarantee use Upstash Redis / Vercel KV. It is still worth having: it stops
// a runaway retry loop from burning quota.
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
  // opportunistic cleanup so the map can't grow without bound
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
    // Raw copies, never exposed verbatim — used only to diagnose paste accidents
    // (trailing newlines, spaces, truncated values) in the health endpoint.
    raw: {
      geminiKey: process.env.GEMINI_API_KEY || '',
      openaiKey: process.env.OPENAI_API_KEY || '',
      openaiMaxTokens: process.env.OPENAI_MAX_TOKENS || '',
    },
    key: process.env.GEMINI_API_KEY?.trim() || '',
    model: (process.env.GEMINI_MODEL || 'gemini-2.5-flash').trim(),
    base: (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, ''),
    maxRounds: parseInt(process.env.QUARK_MAX_TOOL_ROUNDS || '6', 10),
    // Thinking models count reasoning tokens against maxOutputTokens. At the
    // old 2048 default a heavy-thinking turn could burn the entire budget and
    // return ZERO answer tokens — which surfaced as "I have nothing to report".
    maxOutputTokens: parseInt(process.env.QUARK_MAX_OUTPUT_TOKENS || '8192', 10),
    thinkingBudget: process.env.QUARK_THINKING_BUDGET != null
      ? parseInt(process.env.QUARK_THINKING_BUDGET, 10)
      : 0,
    timeoutMs: parseInt(process.env.QUARK_UPSTREAM_TIMEOUT_MS || '45000', 10),
    allowedOrigins: (process.env.QUARK_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    ratePerMin: parseInt(process.env.QUARK_RATE_LIMIT_PER_MIN || '20', 10),

    // ── provider selection ────────────────────────────────────────────────
    // 'gemini' (default) or 'openai' — the latter means any OpenAI-compatible
    // host: Groq, OpenRouter, Together, Ollama, llama.cpp, LM Studio.
    provider: (process.env.LLM_PROVIDER || 'gemini').trim().toLowerCase(),
    // Optional second provider, used automatically when the primary is
    // rate-limited (429/quota) or down (5xx). This is what keeps a demo alive
    // after the Gemini free tier's ~20 requests/minute runs out.
    fallbackProvider: (process.env.LLM_FALLBACK_PROVIDER || '').trim().toLowerCase(),
    // Per-turn tool declaration budget. Sending all 37 costs ~4.0K tokens of
    // fixed overhead per round — enough on its own to exhaust a free-tier
    // tokens-per-minute cap (Groq: 6K–12K TPM).
    toolBudget: Math.max(5, Number(process.env.QUARK_TOOL_BUDGET || 14)),
    sendAllTools: process.env.QUARK_SEND_ALL_TOOLS === '1',
    openai: {
      key: (process.env.OPENAI_API_KEY || '').trim(),
      base: (process.env.OPENAI_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
      model: (process.env.OPENAI_MODEL || 'llama-3.3-70b-versatile').trim(),
      maxTokens: parseInt(process.env.OPENAI_MAX_TOKENS || '2048', 10),
    },
  };
}

/** Which provider can actually serve a request right now? */
function availableProviders(cfg) {
  const list = [];
  if (cfg.key) list.push('gemini');
  if (cfg.openai.key) list.push('openai');
  return list;
}

/**
 * Run one turn against an OpenAI-compatible host and return either JSON or an
 * SSE stream that speaks the SAME frame protocol as the Gemini path
 * (delta / functioncall / done / error), so the browser client is unchanged.
 */
async function runOpenAI({ cfg, contents, wantStream, declarations = TOOL_DECLARATIONS, systemPrompt = SYSTEM_PROMPT }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  let res;
  try {
    res = await fetch(`${cfg.openai.base}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.openai.key}` },
      body: JSON.stringify(
        toOpenAIRequest({
          contents,
          systemPrompt,
          declarations,
          model: cfg.openai.model,
          maxTokens: cfg.openai.maxTokens,
        }),
      ),
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e?.name === 'AbortError';
    return NextResponse.json(
      {
        ok: false,
        error: aborted
          ? { code: 'timeout', message: `${cfg.openai.model} did not respond within ${Math.round(cfg.timeoutMs / 1000)}s.` }
          : { code: 'network', message: `Could not reach ${cfg.openai.base}.`, hint: e?.message || 'Check OPENAI_BASE_URL and outbound network.' },
      },
      { status: 504 },
    );
  }

  const json = await res.json().catch(() => null);
  clearTimeout(timer);

  if (!res.ok) {
    const c = classifyOpenAI(res.status, json, cfg.openai.model);
    return NextResponse.json(
      { ok: false, error: { ...c, message: c.hint, status: res.status, provider: 'openai' } },
      { status: res.status >= 500 ? 502 : res.status },
    );
  }

  const mapped = mapOpenAIResponse(json);

  if (!wantStream) {
    return NextResponse.json({ ok: true, provider: 'openai', model: cfg.openai.model, ...mapped });
  }

  const encoder = new TextEncoder();
  const send = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const stream = new ReadableStream({
    async start(ctrl) {
      try {
        for (const c of mapped.functionCalls) ctrl.enqueue(send('functioncall', { id: c.id, name: c.name, args: c.args }));
        for (const piece of chunkText(mapped.text)) {
          ctrl.enqueue(send('delta', { text: piece }));
          await new Promise((r) => setTimeout(r, 14)); // keep the HUD's typing effect
        }
        ctrl.enqueue(send('done', { ok: true, provider: 'openai', model: cfg.openai.model, ...mapped }));
      } catch (e) {
        ctrl.enqueue(send('error', { code: e?.name === 'AbortError' ? 'timeout' : 'stream', message: e?.message || 'Stream failed' }));
      } finally {
        ctrl.close();
      }
    },
  });

  return new NextResponse(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-quark-provider': 'openai',
    },
  });
}

/** Turn any upstream failure into something the HUD can actually explain. */
function classify(status, body, cfg) {
  const msg = body?.error?.message || body?.message || '';
  if (status === 400 && /API key not valid|invalid.*api key/i.test(msg))
    return { code: 'bad_key', hint: 'GEMINI_API_KEY is set but Google rejected it. Regenerate it in AI Studio.' };
  if (status === 400 && /models\/[\w.-]+ is not found|Unknown name/i.test(msg))
    return { code: 'bad_model', hint: `GEMINI_MODEL="${cfg.model}" is not a valid model id for this key.` };
  if (status === 400) return { code: 'bad_request', hint: msg || 'Gemini rejected the request payload.' };
  if (status === 401 || status === 403)
    return { code: 'unauthorized', hint: 'Authentication failed — check GEMINI_API_KEY and that the Generative Language API is enabled.' };
  if (status === 404) return { code: 'bad_model', hint: `Model "${cfg.model}" not found. Try gemini-2.5-flash.` };
  if (status === 429)
    return { code: 'rate_limited', hint: 'Gemini quota exhausted (free tier is per-minute + per-day). Wait, or upgrade the key.' };
  if (status >= 500) return { code: 'upstream', hint: `Gemini is having a moment (HTTP ${status}).` };
  return { code: 'unknown', hint: msg || `HTTP ${status}` };
}

/**
 * Thinking control differs by generation:
 *   gemini-2.5-flash / -lite  → thinkingBudget (0 disables reasoning entirely)
 *   gemini-2.5-pro            → thinkingBudget, minimum 128
 *   gemini-3.*                → thinkingLevel (MINIMAL/LOW/MEDIUM/HIGH)
 * Unknown families get nothing, so we can never 400 on an unfamiliar model.
 */
function thinkingConfigFor(model, budget) {
  if (/^gemini-3/.test(model)) return { thinkingLevel: 'LOW' };
  if (/^gemini-2\.5/.test(model)) {
    if (/pro/.test(model)) return { thinkingBudget: Math.max(128, budget | 0) };
    return { thinkingBudget: Math.max(0, budget | 0) };
  }
  return undefined;
}

const THINKING_REJECT = /thinking[_ ]?(config|budget|level)|thinkingconfig/i;

/** Validate + trim the incoming conversation. */
function sanitizeContents(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.slice(-MAX_MESSAGES).flatMap((m) => {
    if (!m || typeof m !== 'object') return [];
    const role = m.role === 'model' ? 'model' : m.role === 'user' ? 'user' : null;
    if (!role || !Array.isArray(m.parts)) return [];
    const parts = m.parts.slice(0, 25).flatMap((p) => {
      if (!p || typeof p !== 'object') return [];
      if (typeof p.text === 'string') return [{ text: p.text.slice(0, 32_000) }];
      if (p.functionCall && typeof p.functionCall.name === 'string')
        return [{ functionCall: { name: p.functionCall.name.slice(0, 64), args: p.functionCall.args ?? {}, ...(p.functionCall.id ? { id: String(p.functionCall.id).slice(0, 64) } : {}) } }];
      if (p.functionResponse && typeof p.functionResponse.name === 'string')
        return [{ functionResponse: { name: p.functionResponse.name.slice(0, 64), response: p.functionResponse.response ?? {} , ...(p.functionResponse.id ? { id: String(p.functionResponse.id).slice(0,64) } : {}) } }];
      return []; // images/audio deliberately dropped — keeps cost + payload predictable
    });
    return parts.length ? [{ role, parts }] : [];
  });
}

// Bumped on every behaviour change to the proxy so a deployed site can be
// fingerprinted from the outside: `curl https://your-app/api/chat` and compare.
const PROXY_VERSION = '2.1.0';

/**
 * Non-secret health diagnostics.
 *
 * "My Groq key is attached but it does not work" is almost always one of:
 * the value is empty (Vercel shows a *Needs Attention* badge), it carries a
 * stray newline from copy-paste, it belongs to the wrong provider slot, or the
 * deployment was not redeployed after the change. This reports exactly which,
 * using only the value's length, a 4-char prefix and a whitespace flag — never
 * the value itself.
 */
function mask(v) {
  const s = String(v ?? '');
  return {
    present: s.trim().length > 0,
    length: s.length,
    prefix: s.length >= 16 ? s.slice(0, 4) : '',
    hasWhitespace: /\s/.test(s),
    empty: s.length === 0,
  };
}

function diagnostics(cfg) {
  const issues = [];
  const oKey = mask(cfg.raw.openaiKey);
  const gKey = mask(cfg.raw.geminiKey);

  if (cfg.provider === 'openai' && !oKey.present) {
    issues.push('LLM_PROVIDER=openai but OPENAI_API_KEY is empty or missing, so the proxy cannot use Groq and falls back to Gemini, then to the local core. Paste the key (starts with gsk_) and redeploy.');
  }
  if (oKey.present && oKey.hasWhitespace) {
    issues.push('OPENAI_API_KEY contains spaces or line breaks — Vercel values must be a single line. Re-paste the key without surrounding whitespace.');
  }
  if (oKey.present && /groq/i.test(cfg.openai.base) && !cfg.openai.key.startsWith('gsk_')) {
    issues.push(`OPENAI_BASE_URL points at Groq but OPENAI_API_KEY starts with "${cfg.openai.key.slice(0, 4)}…", not "gsk_". Check you pasted the Groq key, not another provider's.`);
  }
  if (oKey.present && cfg.openai.key.length < 20) {
    issues.push(`OPENAI_API_KEY looks truncated (${cfg.openai.key.length} characters).`);
  }
  if (gKey.present && gKey.hasWhitespace) {
    issues.push('GEMINI_API_KEY contains spaces or line breaks. Re-paste it as a single line.');
  }
  if (cfg.raw.openaiMaxTokens !== '' && Number.isNaN(parseInt(cfg.raw.openaiMaxTokens, 10))) {
    issues.push(`OPENAI_MAX_TOKENS is not a number ("${cfg.raw.openaiMaxTokens.slice(0, 20)}") — using 2048.`);
  }
  if (cfg.raw.openaiMaxTokens === '') {
    issues.push('OPENAI_MAX_TOKENS is set to an empty value (harmless — 2048 is used) but Vercel flags it. Delete it or set 2048.');
  }
  if (cfg.fallbackProvider && !availableProviders(cfg).includes(cfg.fallbackProvider)) {
    issues.push(`LLM_FALLBACK_PROVIDER=${cfg.fallbackProvider} is set but that provider has no key, so failover is inactive.`);
  }
  if (issues.length) {
    issues.push('Reminder: on Vercel, environment changes only take effect after a new deployment.');
  }

  return {
    requestedProvider: cfg.provider || 'gemini',
    effectiveProvider: cfg.openai.key && (cfg.provider === 'openai' || !cfg.key) ? 'openai' : 'gemini',
    openai: { key: oKey, base: cfg.openai.base, model: cfg.openai.model, maxTokens: cfg.openai.maxTokens },
    gemini: { key: gKey, base: cfg.base, model: cfg.model },
    issues,
  };
}

export async function GET() {
  const cfg = env();
  return NextResponse.json({
    service: 'quark-gemini-proxy',
    version: PROXY_VERSION,
    configured: availableProviders(cfg).length > 0,
    // `provider` is the one that will actually serve the next request;
    // `requestedProvider` is what LLM_PROVIDER asks for, so a missing key is
    // obvious instead of silently looking like a different setup.
    provider: cfg.openai.key && (cfg.provider === 'openai' || !cfg.key) ? 'openai' : 'gemini',
    requestedProvider: cfg.provider || 'gemini',
    providers: {
      gemini: Boolean(cfg.key),
      openai: Boolean(cfg.openai.key),
      fallback: cfg.fallbackProvider || null,
    },
    model: cfg.openai.key && (cfg.provider === 'openai' || !cfg.key) ? cfg.openai.model : cfg.model,
    tools: TOOL_DECLARATIONS.length,
    toolBudget: cfg.toolBudget,
    maxToolRounds: cfg.maxRounds,
    maxOutputTokens: cfg.maxOutputTokens,
    thinkingBudget: cfg.thinkingBudget,
    diagnostics: diagnostics(cfg),
    hint: 'POST { contents: [{role, parts}], stream?: boolean }',
  });
}

/** Text of the most recent user turn, used to pick this turn's tool subset. */
function lastUserText(contents) {
  for (let i = contents.length - 1; i >= 0; i--) {
    const c = contents[i];
    if (c?.role !== 'user') continue;
    const t = (c.parts || []).map((p) => p?.text || '').join(' ').trim();
    if (t) return t;
  }
  return '';
}

export async function POST(req) {
  const cfg = env();

  // ── 1. at least one provider configured? ─────────────────────────────
  if (!availableProviders(cfg).length) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'not_configured',
          message: `No model provider is configured on this deployment` +
            (cfg.provider === 'openai'
              ? ' — LLM_PROVIDER asks for the OpenAI-compatible provider (Groq), but OPENAI_API_KEY is empty.'
              : '.'),
          hint: 'Set OPENAI_API_KEY (free Groq key at https://console.groq.com/keys) or GEMINI_API_KEY ' +
                '(https://aistudio.google.com/apikey), then REDEPLOY — env changes never apply to a running build. ' +
                'GET /api/chat returns a "diagnostics" object that says exactly what is missing.',
        },
      },
      { status: 503 },
    );
  }

  // ── 2. origin allowlist ──────────────────────────────────────────────
  if (cfg.allowedOrigins.length) {
    const origin = req.headers.get('origin');
    const host = req.headers.get('host');
    const allowed =
      (origin && cfg.allowedOrigins.some((o) => origin === o || origin.startsWith(o))) ||
      (host && cfg.allowedOrigins.some((o) => o.includes(host))) ||
      !origin; // non-browser clients (curl, tests) send no Origin
    if (!allowed) {
      return NextResponse.json(
        { ok: false, error: { code: 'forbidden_origin', message: `Origin ${origin} is not in QUARK_ALLOWED_ORIGINS.` } },
        { status: 403 },
      );
    }
  }

  // ── 3. rate limit ────────────────────────────────────────────────────
  const ip = clientIp(req);
  const rl = rateLimit(ip, cfg.ratePerMin);
  if (!rl.ok) {
    return NextResponse.json(
      { ok: false, error: { code: 'rate_limited', message: 'Too many requests from this IP.', hint: `Limit is ${cfg.ratePerMin}/minute.` } },
      { status: 429, headers: { 'Retry-After': '30' } },
    );
  }

  // ── 4. parse + validate body ─────────────────────────────────────────
  let body;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json(
        { ok: false, error: { code: 'payload_too_large', message: `Request exceeds ${MAX_BODY_BYTES / 1024} KB.` } },
        { status: 413 },
      );
    }
    body = JSON.parse(text || '{}');
  } catch {
    return NextResponse.json({ ok: false, error: { code: 'bad_json', message: 'Request body is not valid JSON.' } }, { status: 400 });
  }

  const contents = sanitizeContents(body.contents);
  if (!contents || !contents.length) {
    return NextResponse.json(
      { ok: false, error: { code: 'empty_conversation', message: 'No valid messages were supplied.' } },
      { status: 400 },
    );
  }

  const wantStream = body.stream === true;

  // ── 4a. per-turn tool selection ──────────────────────────────────────
  // Computed ONCE per request so every round of the tool loop declares the
  // same set, and tools already called in this conversation stay declared
  // (otherwise the provider sees a tool_call for an unknown function).
  const selection = cfg.sendAllTools
    ? {
        declarations: TOOL_DECLARATIONS,
        names: TOOL_DECLARATIONS.map((d) => d.name),
        tokens: 0,
        reason: 'QUARK_SEND_ALL_TOOLS=1',
      }
    : selectDeclarations({
        text: lastUserText(contents),
        contents,
        max: cfg.toolBudget,
      });
  const systemPrompt = buildSystemPrompt(selection.declarations);

  // ── 4b. provider selection ───────────────────────────────────────────
  // Explicit LLM_PROVIDER=openai, or Gemini absent while another key exists.
  const preferOpenAI =
    cfg.openai.key && (cfg.provider === 'openai' || !cfg.key);
  if (preferOpenAI) {
    const r = await runOpenAI({ cfg, contents, wantStream, declarations: selection.declarations, systemPrompt });
    // A quota/outage on the secondary is recoverable by the primary.
    if (r.status < 400 || !cfg.key || cfg.fallbackProvider !== 'gemini') return r;
  }

  const payload = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    tools: [{ functionDeclarations: selection.declarations }],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
    generationConfig: {
      temperature: GENERATION_DEFAULTS.temperature,
      topP: GENERATION_DEFAULTS.topP,
      maxOutputTokens: cfg.maxOutputTokens,
      ...(body.temperature != null ? { temperature: Number(body.temperature) } : {}),
    },
    ...(thinkingConfigFor(cfg.model, cfg.thinkingBudget)
      ? { thinkingConfig: thinkingConfigFor(cfg.model, cfg.thinkingBudget) }
      : {}),
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  const upstream = `${cfg.base}/models/${cfg.model}:${wantStream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  const callUpstream = (body) =>
    fetch(upstream, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': cfg.key },
      body: JSON.stringify(body),
    });

  let res;
  try {
    res = await callUpstream(payload);

    // Some model families reject thinkingConfig shapes they don't recognise.
    // Rather than fail the turn, drop the field and retry exactly once.
    if (res.status === 400 && payload.thinkingConfig) {
      const peek = await res.clone().json().catch(() => null);
      if (THINKING_REJECT.test(peek?.error?.message || '')) {
        delete payload.thinkingConfig;
        res = await callUpstream(payload);
      }
    }
  } catch (e) {
    clearTimeout(timer);
    const aborted = e?.name === 'AbortError';
    return NextResponse.json(
      {
        ok: false,
        error: aborted
          ? { code: 'timeout', message: `Gemini did not respond within ${Math.round(cfg.timeoutMs / 1000)}s.`, hint: 'Try a shorter prompt or a faster model.' }
          : { code: 'network', message: 'Could not reach the Gemini API.', hint: e?.message || 'Check outbound network / DNS.' },
      },
      { status: 504 },
    );
  }

  // ── 4c. automatic provider fallback ──────────────────────────────────
  // Gemini's free tier is ~20 requests/minute. When it 429s (or 5xxs) and a
  // second provider is configured, serve the turn from there instead of
  // showing the user a quota error.
  if (!res.ok && (res.status === 429 || res.status >= 500) && cfg.openai.key && cfg.fallbackProvider === 'openai') {
    clearTimeout(timer);
    return runOpenAI({ cfg, contents, wantStream });
  }

  // ── 5a. non-streaming path ───────────────────────────────────────────
  if (!wantStream) {
    let json;
    try { json = await res.json(); } catch { json = null; }
    clearTimeout(timer);

    if (!res.ok) {
      const c = classify(res.status, json, cfg);
      return NextResponse.json({ ok: false, error: { ...c, message: c.hint, status: res.status } }, { status: res.status >= 500 ? 502 : res.status });
    }

    const cand = json?.candidates?.[0];
    const parts = cand?.content?.parts || [];
    // `thought: true` parts are the model's internal reasoning — never surface
    // them as the answer, and never let them be the ONLY text we keep.
    const text = parts.filter((p) => !p.thought).map((p) => p.text || '').join('').trim();
    const functionCalls = parts
      .filter((p) => p.functionCall)
      .map((p) => ({ id: p.functionCall.id || null, name: p.functionCall.name, args: p.functionCall.args || {} }));

    const blocked = cand?.finishReason === 'SAFETY' || cand?.finishReason === 'PROHIBITED_CONTENT';

    return NextResponse.json({
      ok: true,
      model: cfg.model,
      text,
      functionCalls,
      finishReason: cand?.finishReason || null,
      blocked,
      usage: json?.usageMetadata
        ? {
            promptTokens: json.usageMetadata.promptTokenCount ?? 0,
            completionTokens: json.usageMetadata.candidatesTokenCount ?? 0,
            totalTokens: json.usageMetadata.totalTokenCount ?? 0,
          }
        : null,
    });
  }

  // ── 5b. streaming path (SSE passthrough, parsed) ─────────────────────
  if (!res.ok || !res.body) {
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    clearTimeout(timer);
    const c = classify(res.status, json, cfg);
    return NextResponse.json({ ok: false, error: { ...c, message: c.hint, status: res.status } }, { status: res.status >= 500 ? 502 : res.status });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const send = (event, data) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const stream = new ReadableStream({
    async start(ctrl) {
      let buffer = '';
      let text = '';
      /** @type {Map<string, {id:string|null,name:string,argsText:string,args:object|null}>} */
      const calls = new Map();
      let usage = null;
      let finishReason = null;
      let callSeq = 0;

      const flushCalls = () => {
        for (const [k, c] of calls) {
          if (!c.sent) {
            c.sent = true;
            let args = c.args;
            if (args == null) {
              try { args = c.argsText ? JSON.parse(c.argsText) : {}; } catch { args = {}; }
            }
            ctrl.enqueue(send('functioncall', { id: c.id, name: c.name, args }));
          }
          calls.delete(k);
        }
      };

      try {
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const line = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            const raw = line.slice(5).trim();
            if (!raw || raw === '[DONE]') continue;

            let json;
            try { json = JSON.parse(raw); } catch { continue; }

            if (json.usageMetadata) {
              usage = {
                promptTokens: json.usageMetadata.promptTokenCount ?? 0,
                completionTokens: json.usageMetadata.candidatesTokenCount ?? 0,
                totalTokens: json.usageMetadata.totalTokenCount ?? 0,
              };
            }

            const cand = json.candidates?.[0];
            if (!cand) continue;
            if (cand.finishReason) finishReason = cand.finishReason;

            for (const p of cand.content?.parts || []) {
              if (typeof p.text === 'string' && p.text && !p.thought) {
                text += p.text;
                ctrl.enqueue(send('delta', { text: p.text }));
              } else if (p.functionCall) {
                // Args can arrive complete (object) or fragmented (string).
                const key = p.functionCall.id || `${p.functionCall.name}#${callSeq++}`;
                const existing = calls.get(key);
                if (existing) {
                  if (typeof p.functionCall.args === 'string') existing.argsText += p.functionCall.args;
                  else if (p.functionCall.args) existing.args = { ...(existing.args || {}), ...p.functionCall.args };
                  if (p.functionCall.id) existing.id = p.functionCall.id;
                } else {
                  calls.set(key, {
                    id: p.functionCall.id || null,
                    name: p.functionCall.name,
                    args: typeof p.functionCall.args === 'object' ? p.functionCall.args : null,
                    argsText: typeof p.functionCall.args === 'string' ? p.functionCall.args : '',
                    sent: false,
                  });
                }
              }
            }
          }
        }

        flushCalls();
        ctrl.enqueue(
          send('done', {
            ok: true,
            model: cfg.model,
            text: text.trim(),
            finishReason,
            blocked: finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT',
            usage,
          }),
        );
      } catch (e) {
        ctrl.enqueue(send('error', { code: e?.name === 'AbortError' ? 'timeout' : 'stream', message: e?.message || 'Stream failed' }));
      } finally {
        clearTimeout(timer);
        ctrl.close();
      }
    },
    cancel() {
      clearTimeout(timer);
      try { controller.abort(); } catch { /* already done */ }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
