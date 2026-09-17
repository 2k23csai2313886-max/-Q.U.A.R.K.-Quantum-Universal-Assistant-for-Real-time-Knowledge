/**
 * On-device speech-to-text suite.
 * ─────────────────────────────────────────────────────────────────────────
 * Proves the requirement "listen and process audio WITHOUT the model API":
 *
 *   PART A — integration: the mic button records, the on-device model is used,
 *            and nothing is uploaded. The fake microphone emits a beep rather
 *            than speech, so the acceptable outcomes are a transcript or an
 *            honest "no speech" — never a crash and never a server upload.
 *   PART B — accuracy: real speech (tests/fixtures/speech-16k.wav) is decoded
 *            and transcribed inside the browser with the exact model and
 *            options lib/local-stt.js uses, and the text must be correct.
 *
 * Both parts run with NO API key configured, which is the whole point.
 *
 *   node tests/e2e-local-stt.mjs
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'speech-16k.wav');
const SEED_USER_LINES = 1; // the provider seeds one demo USER line on boot

const results = [];
const check = (n, p, d = '') => { results.push({ n, p, d }); console.log(`${p ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };

const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['microphone'] });
const page = await ctx.newPage();

const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

const uploads = [];
page.on('request', (r) => { if (r.url().includes('/api/transcribe') && r.method() === 'POST') uploads.push(r.url()); });

// Where do the model weights come from? The repo vendors them under
// public/models/, so a healthy deployment must never pull .onnx or tokenizer
// files from Hugging Face.
const modelTraffic = { self: [], thirdParty: [] };
page.on('request', (r) => {
  const u = r.url();
  if (!/\.(onnx|json)(\?|$)/.test(u)) return;
  if (!/models\/onnx-community|resolve\/main/.test(u)) return;
  if (u.startsWith('http://127.0.0.1:3000/')) modelTraffic.self.push(u.split('/').pop());
  else if (/huggingface\.co|hf\.co/.test(u)) modelTraffic.thirdParty.push(u);
});
const chatCalls = [];
page.on('request', (r) => { if (r.url().includes('/api/chat') && r.method() === 'POST') chatCalls.push(r.url()); });

// Toasts auto-dismiss after 5 s, so record every one that is ever added.
const seenToasts = [];
const watchToasts = () => page.evaluate(() => {
  window.__toasts = [];
  new MutationObserver((muts) => {
    for (const m of muts) {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === 1 && (n.classList?.contains('toast') || n.querySelector?.('.toast'))) {
          window.__toasts.push((n.textContent || '').replace('×', '').trim());
        }
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
});
const readToasts = async () => {
  const t = await page.evaluate(() => window.__toasts || []);
  t.forEach((x) => { if (!seenToasts.includes(x)) seenToasts.push(x); });
  return seenToasts;
};
const userLines = () => page.evaluate(() => [...document.querySelectorAll('#termLog > div')]
  .map((l) => l.textContent.trim()).filter((t) => /^USER >/.test(t)));

console.log('═══ ON-DEVICE SPEECH-TO-TEXT ═══');
const health = await (await fetch('http://127.0.0.1:3000/api/chat')).json();
check('server has NO model key (proves API independence)', health.configured === false, `configured=${health.configured}`);

// ── PART A — mic integration ─────────────────────────────────────────────
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
await page.waitForSelector('.boot.done', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(700);
await watchToasts();
check('only the seeded demo line is present', (await userLines()).length === SEED_USER_LINES);

await page.click('button[aria-label*="Speak to Q.U.A.R.K."]');
for (let i = 0; i < 20; i++) { await page.waitForTimeout(500); await readToasts(); }
const label = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /stop listening|transcrib/i.test(x.getAttribute('aria-label') || ''));
  return b ? b.getAttribute('aria-label') : null;
});
check('recorder fallback engaged (browser speech service is blocked here)', /Stop listening|Transcribing/.test(String(label)), `label="${label}"`);

await page.waitForTimeout(3000);
await page.locator('button[aria-label="Stop listening"]').first().click().catch(() => {});

const t0 = Date.now();
let finished = false;
while (Date.now() - t0 < 150000) {
  await page.waitForTimeout(800);
  const t = await readToasts();
  if ((await userLines()).length > SEED_USER_LINES || t.some((x) => /did not catch any speech|could not run/i.test(x))) { finished = true; break; }
}
const partA = ((Date.now() - t0) / 1000).toFixed(1);
const toasts = await readToasts();
const lines = await userLines();

check('the on-device model path was attempted', toasts.some((t) => /On-device speech model|Loading Whisper/i.test(t)), `${toasts.length} toasts`);
check('no audio was uploaded to any server', uploads.length === 0, `POST /api/transcribe = ${uploads.length}`);
check('no model API call was made for the voice turn', chatCalls.length === 0, `POST /api/chat = ${chatCalls.length}`);
check('the local model did not fail to load or run',
  !toasts.some((t) => /model-load-failed|inference-failed|decode-failed/i.test(t)),
  toasts.find((t) => /could not run/i.test(t))?.slice(0, 120) || 'clean');
check('a beep tone yields a transcript or an honest "no speech" — never a dead end',
  finished && (lines.length > SEED_USER_LINES || toasts.some((t) => /did not catch any speech/i.test(t))),
  lines.length > SEED_USER_LINES ? lines[lines.length - 1].slice(0, 80) : `${partA}s, no-speech reported`);

// ── PART B — real speech accuracy ────────────────────────────────────────
console.log('\n── real-speech accuracy (8 s clip, in-browser WASM) ──');
const wavB64 = readFileSync(FIXTURE).toString('base64');
const tb = Date.now();
const stt = await page.evaluate(async (b64) => {
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: 'audio/wav' });
    // Mirrors lib/local-stt.js exactly: same CDN build, model, device, dtype and
    // generation options (no task/language — the .en checkpoint rejects them).
    const T = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/+esm');
    T.env.allowLocalModels = false;
    const asr = await T.pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny.en', { device: 'wasm', dtype: 'q8' });
    const ac = new AudioContext({ sampleRate: 16000 });
    const buf = await ac.decodeAudioData(await blob.arrayBuffer());
    const audio = buf.getChannelData(0);
    const out = await asr(audio, { chunk_length_s: 30, stride_length_s: 5 });
    return { ok: true, text: String(out?.text || '').trim(), seconds: audio.length / 16000 };
  } catch (e) { return { ok: false, error: String(e?.message || e).slice(0, 200) }; }
}, wavB64);
const partB = ((Date.now() - tb) / 1000).toFixed(1);

check('Whisper ran fully inside the browser', stt.ok === true, stt.ok ? `${stt.seconds}s of audio in ${partB}s (incl. model load)` : stt.error);
check('the transcript is accurate real speech', /fellow americans/i.test(stt.text || '') && /country/i.test(stt.text || ''), `"${(stt.text || '').slice(0, 110)}"`);
check('no API key, upload or quota was involved', uploads.length === 0 && chatCalls.length === 0, `transcribe=${uploads.length} chat=${chatCalls.length}`);
check('the ~41 MB of weights were served by THIS deployment, not a CDN',
  modelTraffic.self.length >= 2 && modelTraffic.thirdParty.length === 0,
  `self=${modelTraffic.self.length} files (${[...new Set(modelTraffic.self)].slice(0, 3).join(', ')}) third-party=${modelTraffic.thirdParty.length}`);

// ── PART C — on-device-only mode skips every cloud path ──────────────────
// The browser's built-in recogniser streams audio to a cloud service, so
// "voice without an API" means skipping it too, not just skipping our server.
console.log('\n── on-device-only voice mode ──');
await page.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle' });
await page.waitForSelector('.boot.done', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(600);
await watchToasts();
seenToasts.length = 0;
uploads.length = 0;

const type = async (text) => {
  await page.fill('#cmdInput', text);
  await page.press('#cmdInput', 'Enter');
  await page.waitForTimeout(2500);
};
await type('use offline voice');

check('the mode switch is handled locally (no API call)', chatCalls.length === 0, `POST /api/chat = ${chatCalls.length}`);
check('the preference is persisted',
  (await page.evaluate(() => localStorage.getItem('quark.voice.localOnly'))) === 'true',
  await page.evaluate(() => String(localStorage.getItem('quark.voice.localOnly'))));
const confirmText = await page.evaluate(() => {
  const l = [...document.querySelectorAll('#termLog > div')].map((x) => x.textContent.trim());
  return (l.find((t) => /on-device voice mode ON/i.test(t)) || '').slice(0, 70);
});
check('the HUD confirms what changed', Boolean(confirmText), confirmText || 'no confirmation line');

// Instrument the cloud recogniser: if it is ever started, this counts it.
await page.evaluate(() => {
  window.__recStarts = 0;
  const R = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (R?.prototype?.start) {
    const orig = R.prototype.start;
    R.prototype.start = function (...args) { window.__recStarts++; return orig.apply(this, args); };
  }
  window.__hasRec = Boolean(R);
});
const hasRec = await page.evaluate(() => window.__hasRec);

await page.click('button[aria-label*="Speak to Q.U.A.R.K."]');
const clickAt = Date.now();
let engagedAt = null;
for (let i = 0; i < 24; i++) {
  await page.waitForTimeout(250);
  const on = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /stop listening|transcrib/i.test(x.getAttribute('aria-label') || ''));
    return Boolean(b) || [...document.querySelectorAll('div.toast')].some((t) => /recording the mic/i.test(t.textContent));
  });
  if (on) { engagedAt = Date.now() - clickAt; break; }
}
check('the recorder engages immediately (no 6 s cloud-recogniser wait)',
  engagedAt !== null && engagedAt < 4000, engagedAt === null ? 'never engaged' : `${engagedAt} ms`);
check(`the cloud recogniser was never started${hasRec ? '' : ' (none in this browser)'}`,
  !hasRec || (await page.evaluate(() => window.__recStarts)) === 0,
  `starts=${await page.evaluate(() => window.__recStarts)}`);

await page.waitForTimeout(2500);
await page.locator('button[aria-label="Stop listening"]').first().click().catch(() => {});
const tc = Date.now();
while (Date.now() - tc < 90000) {
  await page.waitForTimeout(800);
  const t = await readToasts();
  if (t.some((x) => /nothing was uploaded|did not catch any speech|could not read that recording/i.test(x))) break;
  if ((await userLines()).length > SEED_USER_LINES) break;
}
const toastsC = await readToasts();
check('a beep is never uploaded to the server as a last resort', uploads.length === 0, `POST /api/transcribe = ${uploads.length}`);
check('the outcome is honest — on-device result or a clear explanation',
  toastsC.some((t) => /nothing was uploaded|did not catch any speech|could not read that recording/i.test(t))
    || (await userLines()).length > SEED_USER_LINES,
  toastsC.map((t) => t.slice(0, 60)).join(' / ').slice(0, 150));

// and it switches back
await type('use normal voice mode');
check('switching back to AUTO works',
  (await page.evaluate(() => localStorage.getItem('quark.voice.localOnly'))) === 'false',
  await page.evaluate(() => String(localStorage.getItem('quark.voice.localOnly'))));

const csp = errs.filter((e) => /Content Security Policy|violates the following/i.test(e));
check('no CSP violations while running the local model', csp.length === 0, csp[0]?.slice(0, 140) || 'clean');

await browser.close();
const passed = results.filter((r) => r.p).length;
console.log(`\n${'═'.repeat(34)}\n  ${passed}/${results.length} on-device STT checks passed\n${'═'.repeat(34)}`);
if (passed !== results.length) {
  console.log('\nFailed:');
  results.filter((r) => !r.p).forEach((r) => console.log(` • ${r.n} — ${r.d}`));
  console.log('\nToasts seen:');
  seenToasts.forEach((t) => console.log(`   - ${t.slice(0, 150)}`));
}
process.exit(passed === results.length ? 0 : 1);
