/**
 * Tool-selection unit tests.
 * ─────────────────────────────────────────────────────────────────────────
 * Subsetting tools saves ~3.4K tokens per round, which is what makes a
 * free-tier tokens-per-minute cap survivable. The risk is dropping a tool the
 * user actually needs, so the contract tested here is:
 *
 *   1. every one of the 37 tools is reachable from natural wording
 *   2. tools already used in the conversation are never dropped
 *   3. the budget is respected and the payload really is smaller
 *   4. the system prompt only advertises what is declared
 *
 *   node tests/unit-tool-selection.mjs
 */
import { selectDeclarations, toolNamesInHistory, CORE_TOOLS, estimateTokens, allDeclarations } from '../lib/tool-selection.js';
import { TOOL_DECLARATIONS, toolMeta } from '../lib/tools.js';
import { buildSystemPrompt, SYSTEM_PROMPT } from '../lib/system-prompt.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) { pass++; } else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
};

// ── 1. every tool is reachable ───────────────────────────────────────────
const QUERIES = {
  open_website: 'open youtube',
  open_url: 'go to this url https://example.com',
  web_search: 'search for the latest news on ISRO',
  youtube_search: 'play some lofi music',
  maps_directions: 'give me directions to the nearest railway station',
  wikipedia_lookup: 'who is Einstein',
  stackoverflow_search: 'linux command to find a file',
  send_email: 'send an email to my professor',
  add_calendar_event: 'add a calendar event for tomorrow',
  get_location: 'where am I right now',
  get_weather: 'what is the weather in Kanpur',
  get_device_status: 'how much battery is left',
  show_notification: 'show me a notification when it is done',
  capture_photo: 'take a photo with the camera',
  capture_screen: 'take a screenshot of my screen',
  record_audio: 'record audio for ten seconds',
  read_clipboard: 'read my clipboard',
  write_clipboard: 'copy this to the clipboard',
  share_content: 'share this on whatsapp',
  save_file: 'save this as a json file',
  open_file: 'open a file from my disk',
  export_transcript: 'export the transcript of this conversation',
  display_content: 'show me a structured study plan',
  navigate_panel: 'switch to the telemetry panel',
  set_hud_accent: 'change the hud colour to neon',
  request_fullscreen: 'go fullscreen please',
  clear_terminal: 'clear the terminal',
  list_capabilities: 'what can you do',
  speak: 'speak the answer out loud',
  set_voice_listening: 'start listening to my voice',
  set_voice_mode: 'use offline voice mode, do not upload my audio',
  calculate: 'calculate 45*12 + 15 percent',
  get_datetime: 'what is the date today',
  set_timer: 'set a timer for 10 minutes',
  set_reminder: 'remind me at 9am to submit the form',
  cancel_timer: 'cancel the timer',
  request_permission: 'grant microphone permission',
};

console.log('── every tool reachable from natural wording ──');
check('all 37 tools have a probe query', Object.keys(QUERIES).length === TOOL_DECLARATIONS.length,
  `${Object.keys(QUERIES).length} queries vs ${TOOL_DECLARATIONS.length} tools`);
check('probe queries cover exactly the real tool names',
  Object.keys(QUERIES).every((t) => TOOL_DECLARATIONS.some((d) => d.name === t)));

for (const [tool, query] of Object.entries(QUERIES)) {
  const sel = selectDeclarations({ text: query });
  check(`"${query}" → ${tool}`, sel.names.includes(tool), `got [${sel.names.join(', ')}]`);
}

// ── 2. core + history guarantees ─────────────────────────────────────────
console.log('\n── core and history guarantees ──');
const bare = selectDeclarations({ text: 'hmm' });
check('CORE tools are always declared', CORE_TOOLS.every((t) => bare.names.includes(t)), bare.names.join(', '));
check('an unmatched query still gets a usable set', bare.names.length >= CORE_TOOLS.length, `${bare.names.length} tools`);

const history = [
  { role: 'user', parts: [{ text: 'take a photo' }] },
  { role: 'model', parts: [{ functionCall: { name: 'capture_photo', args: {} } }] },
  { role: 'user', parts: [{ functionResponse: { name: 'capture_photo', response: { ok: true } } }] },
];
const withHistory = selectDeclarations({ text: 'what is the weather', contents: history });
check('a tool already called in the conversation stays declared',
  withHistory.names.includes('capture_photo'), withHistory.names.join(', '));
check('history parser reads Gemini-shaped functionCall/functionResponse',
  toolNamesInHistory(history).includes('capture_photo'));
check('history parser reads OpenAI-shaped tool_calls',
  toolNamesInHistory([{ role: 'assistant', tool_calls: [{ function: { name: 'save_file' } }] }]).includes('save_file'));

// ── 3. budget + payload size ─────────────────────────────────────────────
console.log('\n── budget and payload size ──');
const kitchenSink = 'open youtube, take a photo and a screenshot, record audio, read and copy the clipboard, share it on whatsapp, save a json file, export the transcript, show a table, go fullscreen, clear the terminal, set a timer and a reminder, cancel the timer, change the colour, speak it, start listening, grant permission, calculate 2+2, what is the weather, where am I, directions home, send an email, add a calendar event, show a notification, battery status, what can you do, search linux commands, define entropy';
const capped = selectDeclarations({ text: kitchenSink });
check('the tool budget is respected even on a query naming everything',
  capped.names.length <= 14 + CORE_TOOLS.length, `${capped.names.length} declared`);
check('a maximal query still stays far below the full declaration set',
  capped.names.length < TOOL_DECLARATIONS.length, `${capped.names.length} < ${TOOL_DECLARATIONS.length}`);

const fullTokens = estimateTokens(allDeclarations());
const typical = selectDeclarations({ text: 'explain the difference between TCP and UDP' });
check('typical turn declares <1.2K tokens of tools (was ~3.9K)',
  typical.tokens < 1200, `${typical.tokens} vs ${fullTokens} full`);
const totalWithPrompt = typical.tokens + Math.round(buildSystemPrompt(typical.declarations).length / 4);
const totalBefore = fullTokens + Math.round(SYSTEM_PROMPT.length / 4);
check('total fixed overhead per round is at least 2.5x smaller',
  totalWithPrompt * 2.5 < totalBefore, `${totalWithPrompt} now vs ${totalBefore} before`);
console.log(`   fixed overhead/round: ${totalBefore} → ${totalWithPrompt} tokens (${(totalBefore / totalWithPrompt).toFixed(1)}x smaller)`);

// ── 4. prompt matches the declared set ───────────────────────────────────
console.log('\n── prompt/declaration consistency ──');
const sel = selectDeclarations({ text: 'what is the capital of France' });
const prompt = buildSystemPrompt(sel.declarations);
check('the prompt states the subset count, not 37',
  prompt.includes(`You have ${sel.names.length} real tools available on this turn`), `count=${sel.names.length}`);
const undeclared = TOOL_DECLARATIONS.map((d) => d.name).filter((n) => !sel.names.includes(n));
check('no undeclared tool appears in the prompt tool index',
  undeclared.every((n) => !prompt.includes(`: ${n}`) && !prompt.includes(`, ${n}`)),
  undeclared.filter((n) => prompt.includes(n)).slice(0, 4).join(', ') || 'clean');
check('no few-shot example demonstrates an undeclared tool',
  !/→ call (capture_photo|set_timer|get_weather|list_capabilities)\(/.test(prompt), 'example leaked');
check('the full-set prompt still advertises all 37',
  SYSTEM_PROMPT.includes('You have 37 real tools available on this turn'));

// ── 5. categories stay sane ──────────────────────────────────────────────
console.log('\n── sanity ──');
check('every declared name is a real tool',
  sel.names.every((n) => TOOL_DECLARATIONS.some((d) => d.name === n)));
check('declaration order is stable across calls',
  JSON.stringify(selectDeclarations({ text: 'open youtube' }).names) ===
  JSON.stringify(selectDeclarations({ text: 'open youtube' }).names));
check('all 37 tools still exist and have a category',
  TOOL_DECLARATIONS.length === 37 && TOOL_DECLARATIONS.every((d) => toolMeta(d.name).category));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
