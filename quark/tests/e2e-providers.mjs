/**
 * Provider + failover test.
 * ─────────────────────────────────────────────────────────────────────────
 * Proves, without spending a cent:
 *   1. LLM_PROVIDER=openai drives the whole agentic loop through an
 *      OpenAI-compatible host (Groq / OpenRouter / Ollama / llama.cpp),
 *      including tool declarations, tool calls and tool results.
 *   2. When the primary (Gemini) returns HTTP 429 — the free-tier quota error
 *      the user actually hit — and LLM_FALLBACK_PROVIDER is set, the SAME turn
 *      is served by the fallback instead of failing.
 *   3. Streaming still speaks the client's SSE protocol from either provider.
 *
 * Run: node tests/e2e-providers.mjs   (needs `npm run build` first)
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const results = [];
const check = (n, p, d = '') => { results.push({ n, p, d }); console.log(`${p ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };

const APP_PORT = 3100;
const APP = `http://127.0.0.1:${APP_PORT}`;
const OPENAI_MARK = '[openai-provider]';

if (!existsSync('.next/BUILD_ID')) {
  console.error('No production build found. Run `npm run build` first.');
  process.exit(1);
}

// ── mock upstreams ──────────────────────────────────────────────────────
const geminiMock = spawn('node', ['tests/mock-gemini-server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MOCK_PORT: '9999' } });
const openaiMock = spawn('node', ['tests/mock-openai-server.mjs'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MOCK_OPENAI_PORT: '9998' } });

let app = null;
function startApp(envOverrides) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(APP_PORT)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...envOverrides, NODE_ENV: 'production', PORT: String(APP_PORT) },
    });
    let settled = false;
    const onData = (d) => {
      const s = d.toString();
      if (!settled && /Ready in|started server/i.test(s)) { settled = true; resolve(child); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    setTimeout(() => { if (!settled) { settled = true; reject(new Error('app did not start')); } }, 25000);
  });
}

async function postChat(body) {
  const r = await fetch(`${APP}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE */ }
  return { status: r.status, json, text };
}

/** Parse an SSE body into {deltas, calls, done, error}. */
function parseSSE(text) {
  const out = { deltas: [], calls: [], done: null, error: null, text: '' };
  for (const frame of text.split('\n\n')) {
    let event = 'message'; let data = '';
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) continue;
    let p; try { p = JSON.parse(data); } catch { continue; }
    if (event === 'delta') { out.deltas.push(p.text || ''); out.text += p.text || ''; }
    if (event === 'functioncall') out.calls.push(p);
    if (event === 'done') out.done = p;
    if (event === 'error') out.error = p;
  }
  return out;
}

const shutdown = () => {
  try { app?.kill('SIGKILL'); } catch { /* noop */ }
  try { geminiMock.kill('SIGKILL'); } catch { /* noop */ }
  try { openaiMock.kill('SIGKILL'); } catch { /* noop */ }
};
process.on('exit', shutdown);

await new Promise((r) => setTimeout(r, 1200)); // let the mocks bind

// ══ PHASE 1 — OpenAI-compatible provider as primary ═════════════════════
console.log('\n═══ PHASE 1 · LLM_PROVIDER=openai (Groq/Ollama-shaped) ═══');
app = await startApp({
  GEMINI_API_KEY: '',
  LLM_PROVIDER: 'openai',
  OPENAI_API_KEY: 'mock-openai-key',
  OPENAI_BASE_URL: 'http://127.0.0.1:9998/v1',
  OPENAI_MODEL: 'llama-3.3-70b-versatile',
  QUARK_ALLOWED_ORIGINS: '',
});

let health = await (await fetch(`${APP}/api/chat`)).json();
check('health reports the openai provider', health.provider === 'openai' && health.configured === true, JSON.stringify(health).slice(0, 150));
check('health reports the openai model', health.model === 'llama-3.3-70b-versatile', `model=${health.model}`);
check('health lists both provider slots', health.providers?.openai === true && health.providers?.gemini === false, JSON.stringify(health.providers));

// turn 1 → the provider must ask for a tool (proves tool-declaration mapping)
let r = await postChat({ contents: [{ role: 'user', parts: [{ text: 'compare TCP and UDP in detail' }] }], stream: false });
check('openai turn 1 returns a tool call', r.status === 200 && r.json?.functionCalls?.[0]?.name === 'get_datetime', `status=${r.status} calls=${JSON.stringify(r.json?.functionCalls || r.json?.error || '').slice(0, 120)}`);
check('the tool call carries a usable id', Boolean(r.json?.functionCalls?.[0]?.id), `id=${r.json?.functionCalls?.[0]?.id}`);

// What actually went over the wire. Declaring all 37 tools costs ~4.0K tokens
// of fixed overhead per round, which on its own can exhaust a free-tier
// tokens-per-minute cap (Groq: 6K TPM on llama-3.1-8b, 8K on gpt-oss, 12K on
// llama-3.3-70b). The proxy must send only this turn's subset.
const seen = await (await fetch('http://127.0.0.1:9998/mock/seen')).json();
const wire = (seen.requests || [])[seen.count - 1] || {};
check('only a per-turn tool subset was sent to the provider', wire.tools > 0 && wire.tools < 37, `tools=${wire.tools} of 37`);
check('the subset covers what this question needs',
  ['wikipedia_lookup', 'stackoverflow_search'].every((t) => (wire.toolNames || []).includes(t)),
  (wire.toolNames || []).join(', '));
check('the whole request fits a free-tier minute budget',
  wire.bytes > 0 && Math.round(wire.bytes / 4) < 3000,
  `${wire.bytes} bytes ≈ ${Math.round(wire.bytes / 4)} tokens`);

// turn 2 → send the tool result back (proves functionResponse → role:'tool')
const callId = r.json?.functionCalls?.[0]?.id || 'call_mock_1';
r = await postChat({
  contents: [
    { role: 'user', parts: [{ text: 'compare TCP and UDP in detail' }] },
    { role: 'model', parts: [{ functionCall: { name: 'get_datetime', args: { part: 'time' }, id: callId } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'get_datetime', response: { summary: 'Time: 10:00:00' }, id: callId } }] },
  ],
  stream: false,
});
check('openai turn 2 accepts the tool result and answers', r.status === 200 && String(r.json?.text || '').includes(OPENAI_MARK), `status=${r.status} text=${String(r.json?.text || JSON.stringify(r.json?.error || '')).slice(0, 120)}`);
check('usage is mapped from the openai shape', r.json?.usage?.totalTokens === 660, JSON.stringify(r.json?.usage));

// streaming must still speak the client's SSE protocol
r = await postChat({
  contents: [
    { role: 'user', parts: [{ text: 'compare TCP and UDP in detail' }] },
    { role: 'model', parts: [{ functionCall: { name: 'get_datetime', args: { part: 'time' }, id: callId } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'get_datetime', response: { summary: 'Time: 10:00:00' }, id: callId } }] },
  ],
  stream: true,
});
const sse = parseSSE(r.text);
check('openai streaming emits delta frames', sse.deltas.length >= 1 && sse.text.includes(OPENAI_MARK), `frames=${sse.deltas.length}`);
check('openai streaming emits a done frame', sse.done?.ok === true && sse.done?.model === 'llama-3.3-70b-versatile', JSON.stringify(sse.done || sse.error || '').slice(0, 130));

app.kill('SIGKILL');
await new Promise((r2) => setTimeout(r2, 800));

// ══ PHASE 2 — Gemini primary, automatic failover on quota ═══════════════
console.log('\n═══ PHASE 2 · Gemini primary → 429 quota → openai fallback ═══');
app = await startApp({
  GEMINI_API_KEY: 'mock-gemini-key',
  GEMINI_API_BASE: 'http://127.0.0.1:9999/v1beta',
  GEMINI_MODEL: 'gemini-2.5-flash',
  LLM_PROVIDER: 'gemini',
  LLM_FALLBACK_PROVIDER: 'openai',
  OPENAI_API_KEY: 'mock-openai-key',
  OPENAI_BASE_URL: 'http://127.0.0.1:9998/v1',
  OPENAI_MODEL: 'llama-3.1-8b-instant',
  QUARK_ALLOWED_ORIGINS: '',
});

health = await (await fetch(`${APP}/api/chat`)).json();
check('health reports gemini primary with an openai fallback', health.provider === 'gemini' && health.providers?.fallback === 'openai', JSON.stringify(health.providers));

// A normal turn must still be served by Gemini.
r = await postChat({ contents: [{ role: 'user', parts: [{ text: 'compare TCP and UDP in detail' }] }], stream: false });
check('healthy turns still use gemini (no needless failover)', r.status === 200 && !String(r.json?.text || '').includes(OPENAI_MARK) && r.json?.functionCalls?.length >= 0, `status=${r.status}`);

// The quota turn: Gemini mock 429s, the fallback must serve it.
r = await postChat({ contents: [{ role: 'user', parts: [{ text: 'quota check please' }] }], stream: false });
const servedByFallback = r.status === 200 && (r.json?.functionCalls?.length > 0 || String(r.json?.text || '').includes(OPENAI_MARK));
check('a 429 quota error fails over to the second provider', servedByFallback, `status=${r.status} body=${JSON.stringify(r.json || '').slice(0, 140)}`);
check('the failover response is a valid turn, not an error', r.json?.ok !== false && !r.json?.error, JSON.stringify(r.json?.error || 'no error').slice(0, 120));

app.kill('SIGKILL');
await new Promise((r2) => setTimeout(r2, 500));

// ══ PHASE 3 — no provider configured ════════════════════════════════════
console.log('\n═══ PHASE 3 · nothing configured ═══');
app = await startApp({ GEMINI_API_KEY: '', OPENAI_API_KEY: '', LLM_PROVIDER: 'gemini', LLM_FALLBACK_PROVIDER: '', QUARK_ALLOWED_ORIGINS: '' });
r = await postChat({ contents: [{ role: 'user', parts: [{ text: 'hello' }] }] });
check('with no key at all the proxy says so (503, actionable hint)', r.status === 503 && r.json?.error?.code === 'not_configured' && /OPENAI_BASE_URL|GEMINI_API_KEY/.test(r.json?.error?.hint || ''), `status=${r.status} ${r.json?.error?.hint?.slice(0, 80)}`);
health = await (await fetch(`${APP}/api/chat`)).json();
check('health reports configured:false', health.configured === false, JSON.stringify(health).slice(0, 120));

shutdown();
const passed = results.filter((r2) => r2.p).length;
console.log(`\n${'═'.repeat(34)}\n  ${passed}/${results.length} provider checks passed\n${'═'.repeat(34)}`);
if (passed !== results.length) {
  console.log('\nFailed:');
  results.filter((r2) => !r2.p).forEach((r2) => console.log(` • ${r2.n} — ${r2.d}`));
}
process.exit(passed === results.length ? 0 : 1);
