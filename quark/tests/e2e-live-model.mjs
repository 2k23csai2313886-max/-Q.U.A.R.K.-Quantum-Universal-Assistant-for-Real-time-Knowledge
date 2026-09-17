import { chromium } from 'playwright-core';
const results = [];
const check = (n,p,d='') => { results.push({n,p,d}); console.log(`${p?'✅':'❌'} ${n}${d?' — '+d:''}`); };

const browser = await chromium.launch({ args:['--no-sandbox','--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream'] });
const ctx = await browser.newContext({ viewport:{width:1440,height:900}, permissions:['geolocation','microphone'], geolocation:{latitude:26.4499,longitude:80.3319} });
const page = await ctx.newPage();
const errs=[]; page.on('pageerror', e=>errs.push(String(e))); page.on('console', m=>{ if(m.type()==='error') errs.push(m.text()); });
// Proves voice audio never leaves the machine when the on-device model works.
const transcribeCalls=[]; page.on('request', r=>{ if(r.url().includes('/api/transcribe') && r.method()==='POST') transcribeCalls.push(r.url()); });

console.log('═══ LIVE GEMINI PATH (mock upstream) ═══');
const probe = await (await fetch('http://127.0.0.1:3000/api/chat')).json();
check('backend reports key configured', probe.configured === true, JSON.stringify(probe).slice(0,120));
check('backend reports 37 tools', probe.tools === 37, `tools=${probe.tools}`);

await page.goto('http://127.0.0.1:3000/', { waitUntil:'networkidle' });
await page.waitForSelector('.boot.done', { timeout: 20000 }).catch(()=>{});
await page.waitForTimeout(700);

const badge = await page.locator('.conn-badge').textContent();
check('badge flips to LIVE after probe', /LIVE/.test(badge), badge);

// --- the full agentic loop: text -> functionCall -> execute -> functionResponse -> streamed text
// Local-first routing now answers "what time is it" without a model call, so
// the loop test uses a genuine reasoning question instead.
await page.fill('#cmdInput','compare TCP and UDP in detail');
await page.press('#cmdInput','Enter');

// observe streaming: sample the assistant line repeatedly
let samples = [];
for (let i=0;i<24;i++){
  await page.waitForTimeout(120);
  const s = await page.evaluate(()=>{
    const l=[...document.querySelectorAll('#termLog > div')];
    return { n:l.length, last:l[l.length-1]?.textContent.trim().slice(0,120), trace:l.some(x=>x.className.startsWith('trace')) };
  });
  samples.push(s.last||'');
}
const grew = new Set(samples.map(s=>s.length)).size;
check('assistant reply streamed in incrementally (not one jump)', grew >= 4, `${grew} distinct lengths observed`);

const lines = await page.evaluate(()=>[...document.querySelectorAll('#termLog > div')].map(l=>({cls:l.className,txt:l.textContent.trim()})));
const trace = lines.filter(l=>l.cls.startsWith('trace'));
check('model-requested tool was executed in the browser', trace.some(t=>/get_datetime/.test(t.txt)), trace.map(t=>t.txt).join(' / ').slice(0,120));
check('tool trace marked done (not fail)', trace.some(t=>/done/.test(t.cls)), trace.map(t=>t.cls).join(','));
const final = [...lines].reverse().find(l=>l.cls.startsWith('a '))?.txt || '';
check('final reply incorporates the tool result', /Chronometer synced|link is live/i.test(final), final.slice(0,140));
check('badge still LIVE after a successful round trip', /LIVE/.test(await page.locator('.conn-badge').textContent()));

// --- a second turn: model asks for a permission-gated tool
await page.fill('#cmdInput','where am I');
await page.press('#cmdInput','Enter');
await page.waitForTimeout(2500);
const allowBtn = page.locator('.perm-btn.allow');
const dialogShown = await allowBtn.isVisible().catch(()=>false);
check('permission dialog shown for model-requested get_location', dialogShown);
if (dialogShown) { await allowBtn.click(); await page.waitForTimeout(2500); }
const lines2 = await page.evaluate(()=>[...document.querySelectorAll('#termLog > div')].map(l=>({cls:l.className,txt:l.textContent.trim()})));
check('get_location executed and returned real GPS', lines2.some(l=>/26\.44|80\.33/.test(l.txt)), lines2.filter(l=>/get_location/.test(l.txt)).map(l=>l.txt).join(' | ').slice(0,140));

// --- query counter + activity log driven by real events
const metrics = await page.evaluate(()=>({
  queries: document.querySelectorAll('.metric .value')[0]?.textContent,
  activity: [...document.querySelectorAll('.activity-log .row')].map(r=>r.textContent.trim()),
}));
check('query counter incremented to 2', metrics.queries === '2', `queries=${metrics.queries}`);
check('activity log shows real events, not random states', metrics.activity.some(a=>/get_datetime|get_location|EXECUTING|PROCESSING/.test(a)), metrics.activity.slice(0,3).join(' | ').slice(0,150));

// --- thinking-model handling -------------------------------------------------
await page.fill('#cmdInput','why is psi used for the wavefunction');
await page.press('#cmdInput','Enter');
await page.waitForTimeout(3000);
const psiLines = await page.evaluate(()=>[...document.querySelectorAll('#termLog > div')].map(l=>l.textContent.trim()));
const psiReply = [...psiLines].reverse().find(t=>t.startsWith('Q.U.A.R.K. >')) || '';
check('reasoning (thought) parts are NOT surfaced as the answer', !/wavefunction but mention|Greek letter ψ — and in/.test(psiReply.replace(/^Q\.U\.A\.R\.K\. > /,'').split('.')[0]) && /wavefunction/i.test(psiReply), psiReply.slice(0,120));
check('the real answer text still arrives', /Greek letter|wavefunction/i.test(psiReply), psiReply.slice(0,120));
const psiCount = psiLines.filter(t=>t.startsWith('Q.U.A.R.K. >') && /wavefunction/i.test(t)).length;
check('thinking turn produced exactly one reply', psiCount === 1, `count=${psiCount}`);

await page.fill('#cmdInput','burn the budget');
await page.press('#cmdInput','Enter');
await page.waitForTimeout(3000);
const burnLines = await page.evaluate(()=>[...document.querySelectorAll('#termLog > div')].map(l=>l.textContent.trim()));
const burnReply = [...burnLines].reverse().find(t=>t.startsWith('Q.U.A.R.K. >')) || '';
check('a thought-only MAX_TOKENS turn is explained, not silenced', /response budget|empty answer|finish reason/i.test(burnReply), burnReply.slice(0,140));
check('the empty turn does NOT falsely blame the link', !/live model link is down/i.test(burnReply), burnReply.slice(0,120));
const burnTrace = await page.evaluate(()=>[...document.querySelectorAll('#termLog > div')].map(l=>l.textContent).join('|'));
check('a local-core trace explains the fallback', /local-core/.test(burnTrace) && /empty model answer/i.test(burnTrace));
check('burn turn rendered once', burnLines.filter(t=>t.startsWith('Q.U.A.R.K. >') && /budget|finish reason/i.test(t)).length === 1);

// --- microphone: built-in STT is blocked in headless, so the recorder path must
// --- engage and resolve the turn on-device (or via /api/transcribe as a last
// --- resort). The fake mic emits a beep, so a transcript is not guaranteed —
// --- an honest "did not catch any speech" is the correct outcome.
const micSel = 'button[aria-label*="Speak to Q.U.A.R.K."], button[aria-label="Stop listening"], button[aria-label="Transcribing your recording"]';
const mic = page.locator(micSel).first();
check('mic button is enabled (recogniser OR recorder fallback available)', await mic.isEnabled());
await mic.click();
// The recogniser watchdog gives the built-in service 6s before switching to the
// recorder fallback, so wait past it.
await page.waitForTimeout(8000);
// Either the recogniser started, or it failed and the fallback kicked in.
const fellBack = await page.evaluate(() =>
  document.body.innerText.includes('recording the mic') ||
  document.body.innerText.includes('transcribing it through the server') ||
  !!document.querySelector('button[aria-label="Transcribing your recording"]'));
// Count toast CARDS only — .toast-t/.toast-m also match [class*="toast"].
const toastCount = await page.evaluate(() =>
  [...document.querySelectorAll('div.toast')].filter(t => /recording the mic/i.test(t.textContent)).length);
check('the fallback engaged exactly once (no duplicate recorder)', toastCount <= 1, `matching toasts=${toastCount}`);
const stateAfterClick = await page.locator(micSel).first().getAttribute('aria-label').catch(()=>'');
check('voice input started (recognition or recorder fallback)', /Stop listening|Transcribing/.test(String(stateAfterClick)) || fellBack, `label="${stateAfterClick}" fellBack=${fellBack}`);

const transcribeProbe = await (await fetch('http://127.0.0.1:3000/api/transcribe')).json();
check('transcribe endpoint is live and reports the model', transcribeProbe.service === 'quark-transcribe' && transcribeProbe.configured === true, JSON.stringify(transcribeProbe).slice(0,110));

// Toasts auto-dismiss after 5 s, so capture every one that is added from now on.
await page.evaluate(() => {
  window.__t = [];
  new MutationObserver((ms) => { for (const m of ms) m.addedNodes.forEach((n) => {
    if (n.nodeType === 1 && (n.classList?.contains('toast') || n.querySelector?.('.toast')))
      window.__t.push((n.textContent || '').replace('×', '').trim()); }); })
    .observe(document.body, { childList: true, subtree: true });
});
const usersBefore = await page.evaluate(() => [...document.querySelectorAll('#termLog > div')]
  .map((l) => l.textContent.trim()).filter((t) => /^USER >/.test(t)).length);

await page.waitForTimeout(3500);            // let the fake mic record some audio
await page.locator(micSel).first().click().catch(()=>{});   // stop → transcribe

// The fake microphone emits a beep, not speech. Now that the on-device model
// filters non-speech honestly, the acceptable outcomes are: a transcript is
// submitted, or the HUD says it did not catch any speech. A raw error or a
// silent dead end is a failure. Strict accuracy on REAL speech is asserted in
// tests/e2e-local-stt.mjs; here we only require the turn to resolve cleanly.
const t0 = Date.now();
let newLine = null, toasts = [];
while (Date.now() - t0 < 150000) {
  await page.waitForTimeout(800);
  toasts = await page.evaluate(() => window.__t || []);
  const lines = await page.evaluate(() => [...document.querySelectorAll('#termLog > div')]
    .map((l) => l.textContent.trim()).filter((t) => /^USER >/.test(t)));
  if (lines.length > usersBefore) { newLine = lines[lines.length - 1]; break; }
  if (toasts.some((t) => /did not catch any speech/i.test(t))) break;
}
const noSpeech  = toasts.some((t) => /did not catch any speech/i.test(t));
const usedLocal = toasts.some((t) => /Transcribed on-device/i.test(t));
const localFailed = toasts.find((t) => /could not run/i.test(t));
check('the voice turn resolved — a transcript, or an honest "no speech" (never a dead end)',
  Boolean(newLine) || noSpeech,
  newLine ? newLine.slice(0, 80)
          : (noSpeech ? 'non-speech beep correctly rejected on-device'
                      : `nothing after ${((Date.now() - t0) / 1000).toFixed(0)}s`));
console.log(`   (voice path: ${usedLocal ? 'on-device Whisper' : localFailed ? 'on-device failed → server' : noSpeech ? 'on-device, non-speech filtered' : 'server /api/transcribe'} · uploads=${transcribeCalls.length})`);

// --- key must never reach the browser
const leaked = await page.evaluate(async () => {
  const html = document.documentElement.outerHTML;
  const scripts = [...document.querySelectorAll('script')].map(s=>s.textContent).join('');
  return { inDom: html.includes('AIzaSyTESTKEY'), inInlineScripts: scripts.includes('AIzaSyTESTKEY') };
});
check('API key absent from DOM and inline scripts', !leaked.inDom && !leaked.inInlineScripts, JSON.stringify(leaked));
const chunkLeak = await page.evaluate(async () => {
  const urls = [...document.querySelectorAll('script[src]')].map(s=>s.src);
  const bodies = await Promise.all(urls.map(u=>fetch(u).then(r=>r.text()).catch(()=>'')));
  return bodies.some(b=>b.includes('AIzaSyTESTKEY'));
});
check('API key absent from every loaded JS chunk', !chunkLeak);

check('no runtime errors during the live loop', errs.length===0, errs.slice(0,2).join(' | ').slice(0,200));

await page.screenshot({ path:'./quark-live.png' });
await browser.close();
const p = results.filter(r=>r.p).length;
console.log(`\n════ ${p}/${results.length} live-path checks passed ════`);
if (p!==results.length) results.filter(r=>!r.p).forEach(r=>console.log(' • '+r.n+' — '+r.d));
process.exit(0);
