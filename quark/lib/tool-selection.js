/**
 * Per-turn tool selection
 * ─────────────────────────────────────────────────────────────────────────
 * Declaring all 37 tools on every request costs ~4,000 tokens of fixed
 * overhead before a single word of conversation. That is invisible on a
 * per-day quota and brutal on a per-minute token cap — Groq's free tier allows
 * 6K–12K TPM depending on model, so one full-declaration turn can exhaust an
 * entire minute, and a multi-round tool loop multiplies it.
 *
 * So each turn declares only the tools that turn could plausibly use:
 *
 *   CORE          always declared (knowledge + navigation + clock)
 *   RULES         declared when the user's wording implies them
 *   history       any tool already called in this conversation, so the API
 *                 never sees a tool_call for an undeclared function
 *
 * The system prompt is rebuilt from the same subset, so the model is never
 * advertised a tool it cannot call.
 *
 * Escape hatch: QUARK_SEND_ALL_TOOLS=1 disables subsetting entirely.
 */

import { TOOL_DECLARATIONS, toolMeta } from './tools.js';

/** Declared on every turn: the tools an open-ended question most often needs. */
export const CORE_TOOLS = [
  'web_search',
  'wikipedia_lookup',
  'stackoverflow_search',
  'open_website',
  'get_datetime',
];

/**
 * Wording → tools. Checked in order against the latest user message.
 * Patterns are deliberately broad: a false positive costs ~100 tokens, a false
 * negative costs the user's whole request.
 */
export const RULES = [
  { tools: ['youtube_search'], re: /\b(youtube|yt|video|song|music|playlist|lofi|podcast)\b|\b(play|watch)\b/i },
  { tools: ['maps_directions'], re: /\b(direction|directions|route|navigate|navigation|distance|nearest|closest|how (do|can) i (get|reach|go))\b|\bmaps?\b/i },
  { tools: ['send_email'], re: /\b(e-?mail|gmail|inbox|write to .+@|mail)\b/i },
  { tools: ['add_calendar_event'], re: /\b(calendar|event|meeting|appointment|schedule (a|an|the))\b/i },
  { tools: ['get_weather'], re: /\b(weather|temperature|forecast|rain|raining|humidity|wind|heatwave|climate)\b/i },
  { tools: ['get_location'], re: /\b(where am i|my location|location|gps|coordinates|latitude|longitude|my position|track me|nearby)\b/i },
  { tools: ['get_device_status'], re: /\b(battery|charging|device|storage|disk space|memory|network|online|offline|system status|telemetry|signal)\b/i },
  { tools: ['show_notification'], re: /\b(notif(y|ication)|alert me|ping me|remind me with a (popup|notification))\b/i },
  { tools: ['capture_photo'], re: /\b(photo|picture|selfie|camera|snap|webcam)\b/i },
  { tools: ['capture_screen'], re: /\b(screenshot|screen ?capture|screen ?shot|capture (the )?screen|my screen)\b/i },
  { tools: ['record_audio'], re: /\b(record(ing)? (audio|voice|sound|me)|voice note|audio (clip|note)|dictate)\b/i },
  { tools: ['read_clipboard', 'write_clipboard'], re: /\b(clipboard|copy|paste|copied)\b/i },
  { tools: ['share_content'], re: /\b(share|whatsapp|telegram|twitter|x\.com|linkedin|send this)\b/i },
  { tools: ['save_file'], re: /\b(save|download|write to (a )?file|export as|\.json|\.txt|\.csv|\.md)\b/i },
  { tools: ['open_file'], re: /\b(open (a )?file|read (a )?file|load (a )?file|pick a file|upload)\b/i },
  { tools: ['export_transcript'], re: /\b(transcript|conversation history|chat (history|log)|export (the )?(chat|conversation|session))\b/i },
  { tools: ['display_content'], re: /\b(show|display|present|render|plan|summar(y|ise|ize)|table|comparison|compare|draft|structured|blocks?|slide|report|write (me )?(a|some) (code|program|script)|code)\b/i },
  { tools: ['navigate_panel'], re: /\b(panel|tab|switch to|overview|telemetry|protocols|capabilities panel|about (page|panel|section))\b/i },
  { tools: ['set_hud_accent'], re: /\b(colou?r|theme|accent|neon|palette|hud (style|look)|vibe)\b/i },
  { tools: ['request_fullscreen'], re: /\b(full ?screen|immersive|theatre|theater mode)\b/i },
  { tools: ['clear_terminal'], re: /\b(clear|reset|wipe|clean (the )?(screen|terminal|log))\b/i },
  { tools: ['list_capabilities'], re: /\b(what can you do|capabilit(y|ies)|features|what are your (tools|commands)|help|commands|what do you (know|do))\b/i },
  { tools: ['speak'], re: /\b(speak|say (it|this)|read (it|this)? ?(out loud|aloud)|voice (output|reply)|announce|tts|tell me out loud)\b/i },
  { tools: ['set_voice_listening'], re: /\b(listen(ing)?|start listening|voice input|hands ?free|mic(rophone)? (on|off))\b/i },
  { tools: ['set_voice_mode'], re: /\b(offline voice|voice mode|on-?device|whisper|private voice|local(ly)? (voice|speech|stt)|don'?t (upload|send) (my )?(audio|voice)|no (api|internet|cloud)|without (internet|api|cloud)|speech mode)\b/i },
  { tools: ['calculate'], re: /\b(calculate|compute|math|maths|arithmetic|percent(age)?|square root|factorial|how much is)\b|\d+\s*[-+*/^×÷]\s*\d+/i },
  { tools: ['set_timer'], re: /\b(timer|countdown|alarm|in \d+ ?(s|sec|second|m|min|minute|h|hr|hour)s?)\b/i },
  { tools: ['set_reminder'], re: /\b(remind(er)? me|reminder|at \d{1,2}(:\d{2})? ?(am|pm)|don'?t let me forget)\b/i },
  { tools: ['cancel_timer'], re: /\b(cancel|stop|delete|remove) (the |my )?(timer|reminder|alarm|countdown)\b/i },
  { tools: ['request_permission'], re: /\b(permission|allow|grant|deny|denied|blocked|access (to )?(the )?(mic|camera|location|clipboard)|site settings)\b/i },
  { tools: ['open_url'], re: /\b(url|link|website address|https?:\/\/|www\.)\b/i },
  { tools: ['web_search'], re: /\b(search|google|find|look (up|for)|latest|news|who won|current)\b/i },
  { tools: ['wikipedia_lookup'], re: /\b(what (is|are|was|were)|who (is|are|was|were)|define|definition|meaning of|tell me about|explain|history of|wiki)\b/i },
  { tools: ['stackoverflow_search'], re: /\b(how (do|to|can|does)|command|code|error|bug|fix|script|function|syntax|install|linux|terminal|shell|api|regex|programming|developer|stackoverflow|stack overflow|why does)\b/i },
  { tools: ['open_website'], re: /\b(open|launch|visit|go to|load|start)\b/i },
  { tools: ['get_datetime'], re: /\b(time|date|day|clock|today|tomorrow|yesterday|now|timezone|ist)\b/i },
];

/** Default ceiling on declared tools per turn. */
export const DEFAULT_TOOL_BUDGET = 14;

const namesOf = (decls) => decls.map((d) => d.name);

/** Rough token weight of a declaration set (JSON chars / 3.6). */
export const estimateTokens = (decls) => Math.round(JSON.stringify(decls || []).length / 3.6);

/**
 * Pick the declarations for one turn.
 *
 * @param {object}  o
 * @param {string}  o.text      latest user message
 * @param {Array}   o.contents  conversation history (Gemini or OpenAI shape)
 * @param {Array}   o.all       full declaration list
 * @param {number}  o.max       tool budget
 * @returns {{declarations: Array, names: string[], reason: string, tokens: number}}
 */
export function selectDeclarations({ text = '', contents = [], all = TOOL_DECLARATIONS, max = DEFAULT_TOOL_BUDGET } = {}) {
  const byName = new Map(all.map((d) => [d.name, d]));
  const picked = new Set();
  const matched = [];

  // 1. Tools already used in this conversation must stay declared, or the
  //    provider sees a tool_call/tool response for an unknown function.
  const usedBefore = new Set(toolNamesInHistory(contents));
  usedBefore.forEach((n) => { if (byName.has(n)) picked.add(n); });

  // 2. Core set.
  CORE_TOOLS.forEach((n) => { if (byName.has(n)) picked.add(n); });

  // 3. Wording matches, in rule order (earlier rules win the remaining budget).
  const t = String(text || '');
  for (const rule of RULES) {
    if (!t || !rule.re.test(t)) continue;
    for (const n of rule.tools) {
      if (!byName.has(n) || picked.has(n)) continue;
      picked.add(n);
      matched.push(n);
    }
  }

  // 4. Enforce the budget. History and CORE are never dropped; matched tools are
  //    trimmed from the end (lowest-priority rules).
  const locked = new Set([...usedBefore, ...CORE_TOOLS].filter((n) => byName.has(n)));
  let names = [...picked];
  if (names.length > max) {
    const keepLocked = names.filter((n) => locked.has(n));
    const trimmable = names.filter((n) => !locked.has(n));
    names = [...keepLocked, ...trimmable.slice(0, Math.max(0, max - keepLocked.length))];
  }

  // Preserve the canonical tool order for stable, cacheable payloads.
  const ordered = all.filter((d) => names.includes(d.name));
  return {
    declarations: ordered,
    names: namesOf(ordered),
    tokens: estimateTokens(ordered),
    reason: matched.length ? `matched: ${matched.join(', ')}` : 'core only',
  };
}

/** Every function name referenced by the conversation so far. */
export function toolNamesInHistory(contents = []) {
  const names = [];
  const visit = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Array.isArray(obj)) { obj.forEach(visit); return; }
    // Gemini shape: parts[].functionCall.name / functionResponse.name
    if (obj.functionCall?.name) names.push(obj.functionCall.name);
    if (obj.functionResponse?.name) names.push(obj.functionResponse.name);
    // OpenAI shape: message.tool_calls[].function.name
    if (Array.isArray(obj.tool_calls)) {
      obj.tool_calls.forEach((c) => { if (c?.function?.name) names.push(c.function.name); });
    }
    Object.values(obj).forEach((v) => { if (v && typeof v === 'object') visit(v); });
  };
  visit(contents);
  return [...new Set(names)];
}

/** All 36 declarations, for callers that want the full set. */
export function allDeclarations() {
  return TOOL_DECLARATIONS;
}

/** Category counts of a subset — used by the health endpoint and tests. */
export function selectionSummary(decls) {
  const out = {};
  decls.forEach((d) => {
    const c = toolMeta(d.name).category;
    out[c] = (out[c] || 0) + 1;
  });
  return out;
}
