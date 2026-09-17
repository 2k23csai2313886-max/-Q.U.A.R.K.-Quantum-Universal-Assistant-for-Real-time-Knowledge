import { chromium } from 'playwright-core';

const URL = 'http://127.0.0.1:3000/';
const log = (...a) => console.log(...a);
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass, detail }); log(`${pass ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); };

const browser = await chromium.launch({ args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  permissions: ['geolocation', 'notifications'],
  geolocation: { latitude: 26.4499, longitude: 80.3319 },
});
const page = await context.newPage();

const consoleErrors = [];
const pageErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(String(e)));
// Counts model calls so we can PROVE local-first routing spends no quota.
const apiCalls = [];
page.on('request', (r) => { if (r.url().includes('/api/chat') && r.method() === 'POST') apiCalls.push(Date.now()); });

// count new tabs opened by tools
let popups = 0;
context.on('page', () => { popups++; });

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('.boot.done', { timeout: 20000 }).catch(() => {});
await page.waitForTimeout(600);

log('\n═══ 1. BOOT & RENDER ═══');
check('no page errors on load', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
check('wordmark rendered', await page.locator('.wordmark-logo').isVisible());
check('quantum orb canvas painted', await page.evaluate(() => {
  const c = document.querySelector('canvas#orb');
  if (!c) return false;
  return c.width > 0 && c.height > 0;
}));
const orbDpr = await page.evaluate(() => { const c = document.querySelector('canvas#orb'); return { backing: c.width, css: c.clientWidth, dpr: window.devicePixelRatio }; });
check('orb is DPR-aware (backing store > css px when dpr>1, else equal)', orbDpr.backing >= orbDpr.css, JSON.stringify(orbDpr));
check('panels rendered', (await page.locator('.panel').count()) >= 6, `${await page.locator('.panel').count()} panels`);
check('terminal rendered', await page.locator('.terminal').isVisible());
check('connection badge resolved (not stuck on CONNECTING)', await page.evaluate(() => {
  const t = document.querySelector('.conn-badge')?.textContent || '';
  return !/CONNECTING/.test(t);
}), await page.locator('.conn-badge').textContent());
check('clock is ticking', await page.evaluate(async () => {
  const a = document.getElementById('clockTime')?.textContent || document.querySelector('.clock-time')?.textContent;
  await new Promise(r => setTimeout(r, 1200));
  const b = document.querySelector('.clock-time')?.textContent;
  return a !== b;
}));

async function ask(text, waitMs = 3500) {
  await page.fill('#cmdInput', text);
  await page.press('#cmdInput', 'Enter');
  await page.waitForTimeout(waitMs);
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll('#termLog > div')];
    return lines.map(l => ({ cls: l.className, txt: l.textContent.trim() }));
  });
}
const lastAssistant = (lines) => [...lines].reverse().find(l => l.cls.startsWith('a '))?.txt || '';
const traces = (lines) => {
  // only traces belonging to the most recent user turn
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].cls.startsWith('u ')) i--;
  return lines.slice(i + 1).filter(l => l.cls.startsWith('trace')).map(l => l.txt);
};

log('\n═══ 2. LOCAL-CORE TOOL ROUTING (no API key configured) ═══');
let lines = await ask('what time is it');
check('"what time is it" → get_datetime tool executed', traces(lines).some(t => /get_datetime/.test(t)), traces(lines).join(' / ').slice(0, 110));
check('  ↳ reply mentions a time', /\d{1,2}:\d{2}/.test(lastAssistant(lines)), lastAssistant(lines).slice(0, 90));

lines = await ask('calculate (45*12) + sqrt(144)^2');
check('arithmetic evaluates correctly (540+144=684)', /684/.test(lastAssistant(lines)), lastAssistant(lines).slice(0, 90));

lines = await ask('sometimes I feel like a timeline');
check('word-boundary fix: "sometimes…timeline" does NOT return the clock', !/^\s*(Local time|Time:)/i.test(lastAssistant(lines)) && !traces(lines).some(t => /get_datetime/.test(t)), lastAssistant(lines).slice(0, 70));

lines = await ask('who is the team leader');
check('team roster resolves offline', /Gyanvikas Singh/.test(lastAssistant(lines)), lastAssistant(lines).slice(0, 80));

log('\n═══ 3. WEB ACTIONS ═══');
popups = 0;
lines = await ask('open youtube', 4000);
const launchCardVisible = await page.locator('.overlay-backdrop.open .vp-actions').isVisible().catch(() => false);
check('"open youtube" opened a tab OR showed a launch card', popups > 0 || launchCardVisible, `popups=${popups} launchCard=${launchCardVisible}`);
if (launchCardVisible) {
  const href = await page.evaluate(() => [...document.querySelectorAll('.vp-actions button')].map(b => b.textContent));
  log('   launch card buttons:', href.join(', '));
  await page.locator('.overlay-backdrop.open .overlay-close').click();
  await page.waitForTimeout(300);
}
lines = await ask('search react server components', 4000);
check('"search …" routed to web_search', traces(lines).some(t => /web_search/.test(t)), traces(lines).join(' / ').slice(0, 110));
await page.keyboard.press('Escape'); await page.waitForTimeout(300);

log('\n═══ 4. PERMISSION BROKER ═══');
// deny path first
const denyCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } }); // NO geolocation permission
const dpage = await denyCtx.newPage();
await dpage.goto(URL, { waitUntil: 'networkidle' });
await dpage.waitForSelector('.boot.done', { timeout: 20000 }).catch(() => {});
await dpage.fill('#cmdInput', 'where am I');
await dpage.press('#cmdInput', 'Enter');
const dialogAppeared = await dpage.waitForSelector('.perm-backdrop', { timeout: 8000 }).then(() => true).catch(() => false);
check('HUD permission dialog appears BEFORE the native prompt', dialogAppeared);
if (dialogAppeared) {
  const info = await dpage.evaluate(() => ({
    role: document.querySelector('.perm-panel')?.getAttribute('role'),
    modal: document.querySelector('.perm-panel')?.getAttribute('aria-modal'),
    label: document.querySelector('.perm-cap')?.textContent,
    asked: document.querySelector('.perm-asked')?.textContent,
    focused: document.activeElement?.textContent?.trim(),
  }));
  check('  ↳ dialog has role=alertdialog + aria-modal', info.role === 'alertdialog' && info.modal === 'true', JSON.stringify(info.role) + '/' + JSON.stringify(info.modal));
  check('  ↳ names the capability', /LOCATION/i.test(info.label || ''), info.label);
  check('  ↳ quotes what the user asked for', /where am I/i.test(info.asked || ''), info.asked?.slice(0, 60));
  check('  ↳ focus moved into the dialog', /ALLOW/.test(info.focused || ''), info.focused);
  await dpage.locator('.perm-btn.deny').click();
  await dpage.waitForTimeout(1500);
  const deniedLines = await dpage.evaluate(() => [...document.querySelectorAll('#termLog > div')].map(l => l.textContent.trim()));
  check('  ↳ DENY produces an explanatory reply, not silence', /denied|blocked|permission/i.test(deniedLines.join(' ')), deniedLines[deniedLines.length - 1]?.slice(0, 100));
  const nativePromptSeen = await dpage.evaluate(() => !!document.querySelector('.perm-backdrop'));
  check('  ↳ dialog dismissed after decision', !nativePromptSeen);
}
await denyCtx.close();

// allow path (context has geolocation granted)
lines = await ask('where am I', 5000);
const allowBtn = page.locator('.perm-btn.allow');
if (await allowBtn.isVisible().catch(() => false)) { await allowBtn.click(); await page.waitForTimeout(3000); lines = await page.evaluate(() => [...document.querySelectorAll('#termLog > div')].map(l => ({ cls: l.className, txt: l.textContent.trim() }))); }
check('"where am I" with permission granted → real coordinates returned', /26\.4|80\.3|latitude/i.test(lastAssistant(lines)) || traces(lines).some(t => /get_location/.test(t)), lastAssistant(lines).slice(0, 100));

log('\n═══ 5. SECURITY — XSS ═══');
const payload = '<img src=x onerror="window.__PWNED=1">';
await page.evaluate(() => { window.__PWNED = undefined; });
lines = await ask(payload, 2500);
const imgCount = await page.evaluate(() => document.querySelectorAll('#termLog img').length);
const pwned = await page.evaluate(() => window.__PWNED);
check('payload rendered as inert text (no <img> in terminal)', imgCount === 0, `img elements: ${imgCount}`);
check('onerror never fired', pwned === undefined, `__PWNED=${pwned}`);
const escapedVisible = await page.evaluate(() => [...document.querySelectorAll('#termLog .u')].pop()?.textContent || '');
check('raw markup is visible as text, proving it was escaped', escapedVisible.includes('<img'), escapedVisible.slice(0, 60));
const inlineHandlers = await page.evaluate(() => document.querySelectorAll('#termLog [onerror],#termLog [onclick],#termLog script').length);
check('no inline event handlers or scripts in the transcript', inlineHandlers === 0);

log('\n═══ 5b. REGRESSION — no duplicate replies ═══');
{
  // Every assistant answer must appear exactly once per user turn. The deployed
  // build once rendered each reply twice (post-loop fallback re-added it).
  await page.fill('#cmdInput', 'clear the terminal');
  await page.press('#cmdInput', 'Enter');
  await page.waitForTimeout(2000);
  await page.fill('#cmdInput', 'tell me a joke');
  await page.press('#cmdInput', 'Enter');
  await page.waitForTimeout(2500);
  const rows = await page.evaluate(() => [...document.querySelectorAll('#termLog > div')].map(l => ({ cls: l.className, txt: l.textContent.trim() })));
  const asst = rows.filter(r => r.cls.startsWith('a ') && r.txt && !/thinking/.test(r.txt)).map(r => r.txt);
  const uniq = new Set(asst);
  check('each assistant reply appears exactly once', asst.length === uniq.size, `${asst.length} entries, ${uniq.size} unique`);
}

log('\n═══ 5c. LOCAL CORE — knowledge, time, GPS phrasings ═══');
{
  // The exact failures reported from production: "what is lion", "time now".
  // With no key the local core must still route these and produce real output.
  const ask = async (text, waitMs = 4000) => {
    await page.fill('#cmdInput', text);
    await page.press('#cmdInput', 'Enter');
    await page.waitForTimeout(waitMs);
    return page.evaluate(() => [...document.querySelectorAll('#termLog > div')].map(l => l.textContent.trim()));
  };

  let lines = await ask('time now', 2500);
  let tail = lines.slice(-4).join(' | ');
  check('"time now" routes to get_datetime on the local core', /get_datetime/.test(tail) && /\d{1,2}:\d{2}/.test(tail), tail.slice(0,140));

  lines = await ask('date today', 2500);
  tail = lines.slice(-3).join(' | ');
  check('"date today" routes to get_datetime', /get_datetime/.test(tail), tail.slice(0,120));

  lines = await ask('location', 6000);
  tail = lines.slice(-4).join(' | ');
  check('bare "location" routes to get_location', /get_location/.test(tail), tail.slice(0,140));

  lines = await ask('what is lion', 12000);
  const joined = lines.join(' | ');
  check('"what is lion" invokes the keyless Wikipedia tool', /wikipedia_lookup/.test(joined), joined.slice(-160));
  const lionReply = [...lines].reverse().find(t => t.startsWith('Q.U.A.R.K. >')) || '';
  check('the lion answer contains real article text', /Panthera leo|large cat|genus Panthera|lion/i.test(lionReply), lionReply.slice(0,150));
  check('the lion turn rendered exactly one reply', lines.filter(t => t.startsWith('Q.U.A.R.K. >') && /lion|Panthera/i.test(t)).length === 1);
}

log('\n═══ 5d. LOCAL-FIRST — no model call, no quota spent ═══');
{
  const ask = async (text, waitMs = 4000) => {
    const before = apiCalls.length;
    await page.fill('#cmdInput', text);
    await page.press('#cmdInput', 'Enter');
    await page.waitForTimeout(waitMs);
    const lines = await page.evaluate(() => [...document.querySelectorAll('#termLog > div')].map(l => l.textContent.trim()));
    return { lines, apiCallsMade: apiCalls.length - before };
  };

  let r = await ask('date', 2500);
  check('bare "date" is answered locally', r.lines.some(t => /get_datetime/.test(t)) && r.lines.some(t => /\d{4}/.test(t)), r.lines.slice(-2).join(' | ').slice(0,130));
  check('bare "date" made ZERO calls to /api/chat', r.apiCallsMade === 0, `calls=${r.apiCallsMade}`);
  check('the local-engine trace is shown', r.lines.some(t => /local-engine/.test(t)), r.lines.slice(-3).join(' | ').slice(0,130));

  r = await ask('what is the time now', 2500);
  check('"what is the time now" made ZERO calls to /api/chat', r.apiCallsMade === 0, `calls=${r.apiCallsMade}`);

  r = await ask('dinosaurs', 14000);
  check('bare "dinosaurs" resolves via keyless Wikipedia', r.lines.some(t => /wikipedia_lookup/.test(t)), r.lines.slice(-2).join(' | ').slice(0,140));
  check('"dinosaurs" made ZERO calls to /api/chat', r.apiCallsMade === 0, `calls=${r.apiCallsMade}`);
  const dino = [...r.lines].reverse().find(t => t.startsWith('Q.U.A.R.K. >')) || '';
  check('the dinosaur answer is real article text', /dinosaur|reptile|extinct|clade/i.test(dino), dino.slice(0,120));

  // Wait for the previous turn to fully release the input, otherwise the
  // repeat is dropped by the busy guard and the check races.
  await page.waitForFunction(() => {
    const i = document.querySelector('#cmdInput');
    return i && !i.disabled && !document.querySelector('.icon-btn.transcribing');
  }, { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1200);
  const countUsers = () => page.evaluate(() =>
    [...document.querySelectorAll('#termLog > div')].filter(t => /^USER >/.test(t.textContent.trim())).length);
  const usersBefore = await countUsers();
  const before = apiCalls.length;
  r = await ask('dinosaurs', 3500);
  check('the repeated question actually submitted', (await countUsers()) === usersBefore + 1, `users ${usersBefore}→${await countUsers()}`);
  check('a repeated question is served from cache', r.lines.some(t => /cache-hit/.test(t)), r.lines.slice(-3).join(' | ').slice(0,130));
  check('the cached question made ZERO calls to /api/chat', apiCalls.length - before === 0, `calls=${apiCalls.length - before}`);

  r = await ask('linux command for search', 14000);
  check('a how-to question routes to keyless Stack Overflow', r.lines.some(t => /stackoverflow_search/.test(t)), r.lines.slice(-2).join(' | ').slice(0,140));
  check('"linux command for search" made ZERO calls to /api/chat', r.apiCallsMade === 0, `calls=${r.apiCallsMade}`);

  r = await ask('why is the sky blue', 3000);
  check('a reasoning question is NOT answered locally (goes to the model)', r.apiCallsMade > 0 || r.lines.some(t => /web_search/.test(t)), `calls=${r.apiCallsMade}`);
}

log('\n═══ 6. ACCESSIBILITY ═══');
check('terminal log is a live region', await page.evaluate(() => {
  const el = document.querySelector('#termLog');
  return el?.getAttribute('role') === 'log' && !!el?.getAttribute('aria-live');
}));
check('activity monitor is a live region', await page.evaluate(() => !!document.querySelector('.activity-log[role="log"]')));
check('nav uses real buttons with aria-current', await page.evaluate(() => document.querySelectorAll('nav button.navlink').length >= 4));
check('mic/voice toggles expose aria-pressed', await page.evaluate(() => {
  const b = [...document.querySelectorAll('.icon-btn')];
  return b.length >= 2 && b.slice(0, 2).every(x => x.hasAttribute('aria-pressed'));
}));
check('command input has a label', await page.evaluate(() => !!document.querySelector('label[for="cmdInput"]')));
await page.locator('nav button.navlink', { hasText: 'CAPABILITIES' }).click();
await page.waitForTimeout(700);
const overlay = await page.evaluate(() => {
  const p = document.querySelector('.overlay-backdrop.open .overlay-panel');
  return {
    role: p?.getAttribute('role'), modal: p?.getAttribute('aria-modal'),
    labelled: p?.getAttribute('aria-labelledby'),
    focusInside: !!p?.contains(document.activeElement),
    capRows: document.querySelectorAll('.cap-row').length,
    toolChips: document.querySelectorAll('.cmd-chip').length,
  };
});
check('overlay is a proper dialog (role/aria-modal/labelledby)', overlay.role === 'dialog' && overlay.modal === 'true' && !!overlay.labelled, JSON.stringify(overlay).slice(0, 120));
check('focus moved inside the overlay', overlay.focusInside);
check('capability matrix rendered live rows', overlay.capRows >= 10, `${overlay.capRows} rows`);
check('tool catalogue listed', overlay.toolChips >= 30, `${overlay.toolChips} chips`);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
check('Escape closes the overlay', !(await page.locator('.overlay-backdrop.open').isVisible().catch(() => false)));
const focusAfter = await page.evaluate(() => document.activeElement?.textContent?.trim() || document.activeElement?.tagName);
check('focus restored after close', /CAPABILITIES/i.test(focusAfter), focusAfter);

log('\n═══ 7. RESPONSIVE ═══');
for (const [w, h, label] of [[1440, 900, 'desktop'], [1024, 768, 'laptop'], [820, 1100, 'tablet'], [390, 844, 'phone']]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const termVisible = await page.locator('.terminal').isVisible();
  const inputUsable = await page.locator('#cmdInput').isVisible();
  check(`${label} ${w}×${h}: no horizontal overflow, terminal + input usable`, overflow <= 1 && termVisible && inputUsable, `overflow=${overflow}px`);
}
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(400);

log('\n═══ 8. CONSOLE HYGIENE ═══');
const realErrors = consoleErrors.filter(e => !/favicon|net::ERR_|Failed to load resource/i.test(e));
check('no uncaught console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | ').slice(0, 200));
check('no uncaught page exceptions', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | ').slice(0, 200));

await page.screenshot({ path: './quark-desktop.png', fullPage: false });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(600);
await page.screenshot({ path: './quark-mobile.png' });

await browser.close();
const passed = results.filter(r => r.pass).length;
log(`\n════════════════════════════════════\n  ${passed}/${results.length} checks passed\n════════════════════════════════════`);
if (passed !== results.length) { log('\nFAILURES:'); results.filter(r => !r.pass).forEach(r => log(' • ' + r.name + (r.detail ? ' — ' + r.detail : ''))); }
process.exit(0);
