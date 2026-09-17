/**
 * Q.U.A.R.K. — client-side link to the server proxy
 * ─────────────────────────────────────────────────────────────────────────
 * The browser NEVER talks to Google. It talks to /api/chat on the same
 * origin, which is where GEMINI_API_KEY is applied server-side.
 *
 * Responses are streamed as SSE so the terminal can type out tokens live.
 */

const ENDPOINT = '/api/chat';

/** Parse an SSE body incrementally and invoke handlers. */
async function readSSE(response, handlers, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => { try { reader.cancel(); } catch { /* closed */ } };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        let event = 'message';
        let data = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        let parsed;
        try { parsed = JSON.parse(data); } catch { continue; }
        handlers[event]?.(parsed);
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/**
 * Send one conversation turn.
 * @returns {Promise<{ok:boolean, text:string, functionCalls:Array, usage:object|null,
 *                    finishReason:string|null, blocked:boolean, error:object|null}>}
 */
export async function sendTurn({ contents, signal, onDelta, stream = true }) {
  const empty = { ok: false, text: '', functionCalls: [], usage: null, finishReason: null, blocked: false, error: null };

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents, stream }),
      signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') return { ...empty, error: { code: 'aborted', message: 'Cancelled.' } };
    return { ...empty, error: { code: 'network', message: 'Could not reach the Q.U.A.R.K. backend.', hint: e?.message } };
  }

  // Non-2xx always comes back as JSON
  if (!res.ok || !stream || !res.body || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
    let json = null;
    try { json = await res.json(); } catch { /* ignore */ }
    if (json?.ok) {
      return {
        ok: true,
        text: json.text || '',
        functionCalls: json.functionCalls || [],
        usage: json.usage || null,
        finishReason: json.finishReason || null,
        blocked: !!json.blocked,
        error: null,
      };
    }
    return { ...empty, error: json?.error || { code: 'http_' + res.status, message: `Backend returned HTTP ${res.status}` } };
  }

  // Streaming
  let text = '';
  const calls = [];
  let done = null;
  let streamError = null;

  await readSSE(
    res,
    {
      delta: (d) => {
        if (typeof d.text === 'string') {
          text += d.text;
          onDelta?.(d.text, text);
        }
      },
      functioncall: (c) => { if (c?.name) calls.push({ id: c.id || null, name: c.name, args: c.args || {} }); },
      done: (d) => { done = d; },
      error: (e) => { streamError = e; },
    },
    signal,
  );

  if (streamError) return { ...empty, text, functionCalls: calls, error: streamError };

  return {
    ok: done?.ok !== false,
    text: (done?.text ?? text).trim(),
    functionCalls: calls,
    usage: done?.usage || null,
    finishReason: done?.finishReason || null,
    blocked: !!done?.blocked,
    error: done?.ok === false ? { code: 'stream', message: 'Stream ended without success.' } : null,
  };
}

/** Is the backend reachable and is a key configured? Powers the LIVE/OFFLINE badge. */
export async function probeBackend() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(ENDPOINT, { method: 'GET', signal: ctrl.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => null);
    if (!r.ok) return { state: 'error', configured: false, detail: `HTTP ${r.status}` };
    return {
      state: j?.configured ? 'live' : 'unconfigured',
      configured: !!j?.configured,
      model: j?.model || null,
      tools: j?.tools || 0,
      requested: j?.diagnostics?.requestedProvider || j?.requestedProvider || 'gemini',
      issues: Array.isArray(j?.diagnostics?.issues) ? j.diagnostics.issues : [],
      detail: j?.configured ? j.model : 'no provider key present',
    };
  } catch (e) {
    return { state: 'offline', configured: false, detail: e?.name === 'AbortError' ? 'timeout' : 'unreachable' };
  }
}

/** Turn a backend error into one honest sentence for the terminal. */
export function explainError(err) {
  if (!err) return 'Unknown link failure.';
  switch (err.code) {
    case 'not_configured':
      return 'No GEMINI_API_KEY on this deployment — running the local reasoning core instead. ' +
             'Add the key in .env.local (dev) or Vercel → Environment Variables (prod).';
    case 'bad_key':       return 'Google rejected the API key. Regenerate it at aistudio.google.com/apikey.';
    case 'bad_model':     return `Model not available for this key (${err.message || ''}). Set GEMINI_MODEL=gemini-2.5-flash.`;
    case 'rate_limited':  return 'Gemini quota exhausted for this minute. The free tier resets quickly — falling back to the local core.';
    case 'unauthorized':  return 'Authentication failed against the Gemini API.';
    case 'timeout':       return 'The model took too long to respond.';
    case 'network':       return 'Cannot reach the Q.U.A.R.K. backend.';
    case 'aborted':       return 'Request cancelled.';
    case 'forbidden_origin': return 'This origin is not permitted by QUARK_ALLOWED_ORIGINS.';
    default:              return err.message || err.hint || `Link error (${err.code || 'unknown'}).`;
  }
}
