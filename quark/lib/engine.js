/**
 * Q.U.A.R.K. — local reasoning engine (v2)
 * ─────────────────────────────────────────────────────────────────────────
 * Why this exists
 *   1. The Gemini free tier allows ~20 requests/minute, and an agentic loop
 *      burns one request PER TOOL ROUND. Two or three questions in a row and
 *      the key is quota-blocked — which used to surface as a raw Google error.
 *   2. Most things a HUD assistant is asked are deterministic: the time, the
 *      date, GPS, maths, timers, opening a site, device sensors. Spending a
 *      paid/quota-limited model call on "date" is waste.
 *
 * So the engine is LOCAL-FIRST: every intent is matched here with a confidence
 * score. Deterministic intents score 1.0 and never touch the network. Only
 * genuinely open-ended reasoning is handed to the model — and if the model is
 * down, quota-blocked or silent, this engine still produces a real answer
 * (keyless Wikipedia for entities, keyless Stack Overflow for how-to/code).
 *
 * Design
 *   normalize()  fillers, politeness, Hinglish, typos, punctuation
 *   INTENTS      ordered, scored matchers — each returns confidence + payload
 *   route()      highest-confidence winner, multi-intent splitting
 *
 * Nothing here touches the network. Tools do.
 */

import { TEAM, JOKES, APP } from './constants.js';
import { resolveSite } from './actions/web.js';
import { calculate } from './calc.js';

// ── durations ────────────────────────────────────────────────────────────
const NUM_WORDS = {
  a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40,
  fortyfive: 45, fifty: 50, sixty: 60, ninety: 90, hundred: 100,
};
const UNIT_SECS = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
};

export function parseDuration(text) {
  const t = String(text || '').toLowerCase();
  const m = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|m|hours?|hrs?|h|s)\b/.exec(t);
  if (m) return Math.round(parseFloat(m[1]) * UNIT_SECS[m[2]]);
  const words = t.split(/\s+/).filter((w) => NUM_WORDS[w] != null);
  const unit = /\b(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/.exec(t)?.[1];
  if (words.length && unit) {
    const n = words.reduce((a, w) => a + NUM_WORDS[w], 0);
    return n * (UNIT_SECS[unit.replace(/s$/, '')] || UNIT_SECS[unit]);
  }
  if (/^\s*(\d+)\s*$/.test(t)) return parseInt(t, 10) * 60; // bare number → minutes
  return null;
}

// ── normalisation ────────────────────────────────────────────────────────

/** Hinglish → English, applied word-wise so entities keep their spelling. */
const HINGLISH = {
  kholo: 'open', khol: 'open', kholido: 'open', chalu: 'start', band: 'close',
  batao: 'tell', batado: 'tell', bata: 'tell', dikhao: 'show', dikha: 'show',
  kya: 'what', kaun: 'who', kahan: 'where', kab: 'when', kitna: 'how much',
  kitne: 'how many', abhi: 'now', aaj: 'today', kal: 'tomorrow',
  samay: 'time', waqt: 'time', tarik: 'date', tarikh: 'date', din: 'day',
  mausam: 'weather', barish: 'rain', garmi: 'heat', thand: 'cold',
  photo: 'photo', khicho: 'take', bataiye: 'tell', kijiye: 'do',
  mera: 'my', meri: 'my', tumhara: 'your', naam: 'name',
};

/** Words that carry no intent and can be stripped from the front. */
const FILLERS = [
  'please', 'plz', 'pls', 'kindly', 'could you', 'can you', 'would you', 'will you',
  'hey quark', 'hi quark', 'ok quark', 'okay quark', 'quark', 'assistant',
  'i want to know', 'i need to know', 'i want', 'i need', 'i would like',
  'tell me', 'let me know', 'gimme', 'give me', 'yo', 'ok', 'okay', 'now', 'just',
  'so', 'well', 'actually', 'basically', 'simply',
];

/** Head verbs we tolerate one typo on ("opne youtube" still opens YouTube). */
const KNOWN_VERBS = [
  'open', 'search', 'play', 'calculate', 'compute', 'set', 'cancel', 'show',
  'tell', 'take', 'record', 'copy', 'paste', 'clear', 'exit', 'locate',
  'find', 'start', 'stop', 'define', 'explain', 'navigate', 'launch',
];

function levenshtein(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 9;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + (a[i - 1] === b[j - 1] ? 0 : 1));
      last = tmp;
    }
  }
  return prev[b.length];
}

/** Repair a single mistyped head verb: "opne youtube" → "open youtube". */
function repairTypos(l) {
  const words = l.split(' ');
  if (!words.length) return l;
  const head = words[0];
  if (head.length >= 4 && !KNOWN_VERBS.includes(head)) {
    const fix = KNOWN_VERBS.find((v) => levenshtein(head, v) <= 1);
    if (fix) words[0] = fix;
  }
  return words.join(' ');
}

/**
 * @returns {{q:string, src:string, l:string, words:string[]}}
 *   q     the raw trimmed query
 *   src   casing preserved, fillers stripped (for entities)
 *   l     lowercased, Hinglish-mapped, typo-repaired (for intent matching)
 */
export function normalize(rawQuery) {
  const q = String(rawQuery || '').trim();
  let src = q.replace(/[?!。，]+$/g, '').trim();

  let l = src.toLowerCase();
  // Hinglish first, so "time batao" becomes "time tell" and matches.
  l = l.replace(/[a-z]+/g, (w) => HINGLISH[w] || w);
  // Strip leading fillers repeatedly ("hey quark can you please tell me …").
  for (let i = 0; i < 4; i++) {
    const before = l;
    for (const f of FILLERS) {
      if (l.startsWith(f + ' ')) { l = l.slice(f.length + 1); break; }
    }
    // Also strip them from src so entities stay aligned.
    for (const f of FILLERS) {
      if (src.toLowerCase().startsWith(f + ' ')) { src = src.slice(f.length + 1).trim(); break; }
    }
    if (l === before) break;
  }
  l = repairTypos(l.trim()).replace(/[?!.,]+$/g, '').trim();
  // Repair the head verb in `src` as well, otherwise "serch react hooks" keeps
  // its typo and the extractor (which preserves casing) never matches.
  src = repairTypos(src.trim()).replace(/[?!.,]+$/g, '').trim();
  return { q, src, l, words: l.split(/\s+/).filter(Boolean) };
}

// ── intent helpers ───────────────────────────────────────────────────────
const call = (name, args = {}) => ({ calls: [{ name, args }] });
const say = (text) => ({ text });

/** Words that make a question about *us*, not about the world. */
const SELF_REF = /\b(?:you|your|yours|quark|q\.u\.a\.r\.k|this (?:app|site|page|project|hud)|team|my (?:device|system|battery|location|files?|timers?))\b/i;

/** Signals a how-to / programming question → Stack Overflow beats Wikipedia. */
const HOWTO = /\b(?:how (?:to|do i|can i|do you)|command|commands|code|snippet|syntax|error|exception|bug|fix|install|configure|setup|set up|script|function|class|library|api|css|html|javascript|js|python|java|react|node|sql|linux|unix|bash|terminal|windows|android|regex)\b/i;

/** Signals genuine reasoning the local engine should NOT pretend to do. */
const NEEDS_MODEL = /\b(?:compare|versus|vs\.?|difference between|why does|why is|pros and cons|opinion|should i|essay|poem|story|write (?:a|an|me)|summarise this|translate|joke about|design|plan (?:a|my)|recommend|best way to)\b/i;

// ── the intent table ─────────────────────────────────────────────────────
/**
 * Each matcher returns null (no match) or {confidence, ...payload}.
 * confidence 1.0 = deterministic, never call the model.
 * Order matters only for equal scores; the table is roughly most-specific first.
 */
const INTENTS = [
  // ── arithmetic ────────────────────────────────────────────────────────
  {
    id: 'calc',
    match: ({ l }) => {
      const ARITHMETIC = /^[\s\d+\-*/%^().!,]+$/;
      const HAS_FUNC = /\b(sqrt|cbrt|abs|sin|cos|tan|asin|acos|atan|log10|log2|log|ln|exp|min|max|pow|hypot|round|floor|ceil|fact)\s*\(|\bpi\b|\btau\b|\bphi\b/i;
      const ARITH_WORDS = /(?:what(?:'s| is)|calculate|compute|evaluate|solve)\s+([-\d\s+\-*/%^().!,a-z]+)/i;
      if (ARITHMETIC.test(l) || HAS_FUNC.test(l)) {
        const expr = ARITHMETIC.test(l) ? l : (ARITH_WORDS.exec(l)?.[1] || l);
        const r = calculate(expr);
        if (r.ok) return { confidence: 1, ...say(`${expr.trim()} resolves to ${r.display}, Commander.`) };
      }
      const m = ARITH_WORDS.exec(l);
      if (m) {
        const r = calculate(m[1]);
        if (r.ok) return { confidence: 1, ...say(`That resolves to ${r.display}, Commander.`) };
      }
      // "<number> percent of <number>", "<a> plus <b>"
      const pct = /(\d+(?:\.\d+)?)\s*(?:%|percent|per\s+cent)\s*(?:of)?\s*(\d+(?:\.\d+)?)/.exec(l);
      if (pct) {
        const v = (parseFloat(pct[1]) / 100) * parseFloat(pct[2]);
        return { confidence: 1, ...say(`${pct[1]}% of ${pct[2]} is ${Number.isInteger(v) ? v : v.toFixed(2)}, Commander.`) };
      }
      return null;
    },
  },

  // ── timers / reminders ────────────────────────────────────────────────
  {
    id: 'timer',
    match: ({ l }) => {
      const timerM = /\b(?:set|start|make)\s+(?:a\s+|an\s+)?(?:timer|countdown|alarm)\b(?:\s+(?:for|of|to)\s+(.+?))?(?:\s+(?:called|named|labelled|for)\s+["']?(.+?)["']?)?$/i.exec(l);
      if (timerM) {
        const secs = parseDuration(timerM[1] || '');
        if (secs) return { confidence: 1, ...call('set_timer', { duration_seconds: secs, label: timerM[2] || 'Timer' }) };
        return { confidence: 1, ...say('How long should the timer run, Commander? Try "10 minutes".') };
      }
      if (/\b(?:cancel|stop|clear|kill)\s+(?:the\s+|all\s+|my\s+)?(?:timer|timers|alarm|alarms|reminder|reminders|countdown)\b/.test(l)) {
        return { confidence: 1, ...call('cancel_timer', { id: 'all' }) };
      }
      const remindM = /\bremind\s+me\b(?:\s+(?:to|about)\s+(.+?))?\s*(?:\s+(?:at|on|in)\s+(.+))?$/i.exec(l);
      if (remindM) {
        const msg = remindM[1] || 'Reminder';
        const when = remindM[2];
        if (when) {
          const hhmm = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(when.trim());
          if (hhmm) {
            let h = parseInt(hhmm[1], 10);
            const ap = (hhmm[3] || '').toLowerCase();
            if (ap === 'pm' && h < 12) h += 12;
            if (ap === 'am' && h === 12) h = 0;
            const d = new Date();
            d.setHours(h, parseInt(hhmm[2], 10), 0, 0);
            if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
            return { confidence: 1, ...call('set_reminder', { datetime: d.toISOString(), message: msg }) };
          }
          const secs = parseDuration(when);
          if (secs) return { confidence: 1, ...call('set_timer', { duration_seconds: secs, label: msg }) };
        }
        return { confidence: 0.9, ...say(`Noted — "${msg}". What time should I raise it, Commander?`) };
      }
      return null;
    },
  },

  // ── voice control ─────────────────────────────────────────────────────
  {
    id: 'voice',
    match: ({ l }) => {
      // Where the audio goes. Checked first: "listen offline" must not be read
      // as a plain "start listening".
      const VOICE_NOUN = /\b(?:voice|speech|mic(?:rophone)?|listening|transcri(?:be|ption|pt)|audio|dictation|whisper)\b/;
      const LOCALISH = /\b(?:offline|on[- ]?device|on[- ]?phone|locally|local|private(?:ly)?|no[- ]?(?:api|internet|cloud|upload|network|server)|without\s+(?:any\s+)?(?:api|internet|cloud|network|server|upload(?:ing)?)|don'?t\s+(?:upload|send)|never\s+(?:upload|send)|stop\s+(?:uploading|sending)|whisper)\b/;
      const BACK_TO_AUTO = /\b(?:normal|default|auto(?:matic)?|standard|cloud|usual|all\s+(?:paths|options)|everything)\b/;
      const TURN_ON = /\b(?:use|switch\s+to|enable|turn\s+on|activate|set|make\s+it|keep\s+it|go)\b/;
      if (VOICE_NOUN.test(l) && LOCALISH.test(l) && !/\bnot\b/.test(l)) {
        return { confidence: 0.95, ...call('set_voice_mode', { mode: 'on-device' }) };
      }
      if (VOICE_NOUN.test(l) && BACK_TO_AUTO.test(l) && TURN_ON.test(l)) {
        return { confidence: 0.9, ...call('set_voice_mode', { mode: 'auto' }) };
      }
      if (/\b(?:stop|don'?t|do\s+not|never)\b.*\b(?:upload|send|transmit)\b.*\b(?:my\s+)?(?:audio|voice|recording|speech)\b/.test(l)) {
        return { confidence: 0.95, ...call('set_voice_mode', { mode: 'on-device' }) };
      }
      if (/\b(?:stop\s+(?:talking|speaking)|be\s+quiet|shut\s+up|silence|quiet|mute\s+yourself)\b/.test(l)) return { confidence: 1, ...call('speak', { text: '' }) };
      if (/^(?:start|begin|resume)?\s*(?:listening|listen)\b/.test(l) || /\b(?:listen\s+to\s+me|wake\s+up|mic\s+on|voice\s+on)\b/.test(l)) {
        return { confidence: 1, ...call('set_voice_listening', { enable: true }) };
      }
      if (/\b(?:stop\s+listening|mic\s+off|voice\s+off|stop\s+the\s+mic)\b/.test(l)) return { confidence: 1, ...call('set_voice_listening', { enable: false }) };
      return null;
    },
  },

  // ── time / date (bare words included: "date", "time now") ─────────────
  {
    id: 'datetime',
    match: ({ l, src }) => {
      const NOT_TIME = /\b(?:timer|timers|sometimes|timeline|sometime|lifetime|downtime|overtime|runtime|bedtime|update|candidate|mandate|validate|outdated|date of birth)\b/;
      const tzM = /\b(?:time|clock)\b.*?\bin\s+([A-Za-z_]+\/[A-Za-z_]+)\b/.exec(src);
      const bare = /^(?:the\s+|current\s+|present\s+)?(?:time|date|day|clock)(?:\s+(?:now|please|kya|batao|today|aaj))?$/i.test(src.trim());
      const wantsTime = /\b(?:time|clock|o'?clock)\b/.test(l) && !NOT_TIME.test(l);
      const wantsDate = /\b(?:date|what\s+day\s+is\s+it|today'?s?\s+(?:date|day))\b/.test(l) && !NOT_TIME.test(l);
      if (bare || wantsTime || wantsDate) {
        const part = wantsTime && !wantsDate ? 'time' : wantsDate && !wantsTime ? 'date' : 'both';
        const args = tzM ? { timezone: tzM[1], part } : { part };
        return { confidence: 1, ...call('get_datetime', args) };
      }
      return null;
    },
  },

  // ── location ──────────────────────────────────────────────────────────
  {
    id: 'location',
    match: ({ l, src }) => {
      if (/\b(?:where\s+(?:am\s+i|are\s+we|i\s+am)|my\s+(?:current\s+)?(?:location|position|coordinates|coords)|gps|(?:get|fetch|show|find|read|give|check|detect)\s+(?:my\s+|the\s+)?(?:current\s+)?(?:location|position|coordinates|coords)|(?:locate|track|ping)\s+me|(?:current|present|this)\s+location|location\s+now|my\s+whereabouts)\b/.test(l)) {
        return { confidence: 1, ...call('get_location', {}) };
      }
      if (/^(?:my\s+|the\s+)?(?:location|position|coordinates|coords|gps)(?:\s+(?:now|please))?$/.test(src.trim().toLowerCase())) {
        return { confidence: 1, ...call('get_location', {}) };
      }
      return null;
    },
  },

  // ── weather ───────────────────────────────────────────────────────────
  {
    id: 'weather',
    match: ({ l, src }) => {
      if (NEEDS_MODEL.test(l)) return null;   // "write a poem about rain" is not a forecast
      if (/\b(?:weather|temperature|forecast|how\s+(?:hot|cold|warm)\s+is\s+it|rain)\b/.test(l)) {
        const cityM = /\b(?:in|at|for|of)\s+([A-Za-z][A-Za-z .'-]{2,40})$/i.exec(src);
        return { confidence: 1, ...call('get_weather', cityM ? { location: cityM[1].trim() } : {}) };
      }
      return null;
    },
  },

  // ── device / sensors ──────────────────────────────────────────────────
  {
    id: 'device',
    match: ({ l }) => {
      if (/\b(?:battery|power\s+level|charging|how\s+much\s+(?:charge|power))\b/.test(l)) return { confidence: 1, ...call('get_device_status', { aspects: ['battery'] }) };
      if (/\b(?:system\s+(?:info|specs|status|report)|device\s+(?:info|specs)|hardware|diagnostics|network\s+(?:info|status)|status\s+report|diagnostic)\b/.test(l)) return { confidence: 1, ...call('get_device_status', {}) };
      if (/^(?:status|report)$/i.test(l)) return { confidence: 0.9, ...call('get_device_status', {}) };
      if (/\b(?:take\s+a\s+(?:photo|picture|selfie)|capture\s+(?:a\s+)?(?:photo|image)|camera)\b/.test(l)) return { confidence: 1, ...call('capture_photo', {}) };
      if (/\b(?:screenshot|screen\s+capture|capture\s+(?:my\s+)?screen)\b/.test(l)) return { confidence: 1, ...call('capture_screen', {}) };
      if (/\b(?:record\s+(?:audio|voice|sound|me)|start\s+recording)\b/.test(l)) {
        return { confidence: 1, ...call('record_audio', { duration_seconds: parseDuration(l) || 10 }) };
      }
      if (/\b(?:read|paste|show)\s+(?:my\s+|the\s+)?clipboard\b/.test(l)) return { confidence: 1, ...call('read_clipboard', {}) };
      return null;
    },
  },

  // ── clipboard write ───────────────────────────────────────────────────
  {
    id: 'clipboard',
    match: ({ q }) => {
      const copyM = /^(?:copy\s+this|copy\s+the\s+following|copy|put\s+(?:this|it)\s+(?:on|in)\s+(?:the\s+)?clipboard)\s*(?::)?\s*(?:this\s*(?::)?\s*)?([\s\S]+)$/i.exec(q.trim());
      if (copyM && copyM[1].trim()) return { confidence: 1, ...call('write_clipboard', { text: copyM[1].trim() }) };
      return null;
    },
  },

  // ── open a site / URL ─────────────────────────────────────────────────
  {
    id: 'open',
    match: ({ l, src }) => {
      const openM = /^(?:open|launch|start|load|visit|go\s+to|take\s+me\s+to)\s+(.+?)\s*$/i.exec(l);
      if (openM) {
        const target = openM[1].trim();
        const panelMap = { telemetry: 'telemetry', protocols: 'protocols', about: 'about', capabilities: 'capabilities', settings: 'capabilities', panel: 'overview', terminal: 'overview', viewport: 'overview' };
        const bare = target.replace(/^the\s+/, '');
        if (panelMap[bare]) return { confidence: 1, ...call('navigate_panel', { panel: panelMap[bare] }) };
        if (/^(file|files|folder)$/.test(bare)) return { confidence: 1, ...call('open_file', { purpose: 'You asked to open a file.' }) };
        const site = resolveSite(target);
        if (site) return { confidence: 1, ...call('open_website', { site_name: site.name }) };
        if (/^https?:\/\//i.test(src.slice(src.toLowerCase().indexOf(target)))) return { confidence: 1, ...call('open_url', { url: target }) };
        if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(target)) return { confidence: 0.95, ...call('open_url', { url: `https://${target}` }) };
        return { confidence: 0.8, ...call('web_search', { query: target }) };
      }
      // "<site> open" / "<site> kholo" (already mapped to "open") — reversed order
      const reversed = /^(.+?)\s+(?:open|launch|start)$/i.exec(src);
      if (reversed) {
        const rs = resolveSite(reversed[1]);
        if (rs) return { confidence: 1, ...call('open_website', { site_name: rs.name }) };
        if (/^https?:\/\//i.test(reversed[1])) return { confidence: 1, ...call('open_url', { url: reversed[1].trim() }) };
      }
      // bare site name: "youtube", "gmail"
      const bareSite = resolveSite(src.trim());
      if (bareSite && src.trim().split(/\s+/).length <= 2) return { confidence: 0.85, ...call('open_website', { site_name: bareSite.name }) };
      return null;
    },
  },

  // ── play / youtube ────────────────────────────────────────────────────
  {
    id: 'media',
    match: ({ l, src }) => {
      const playM = /^(?:play|put\s+on|start\s+playing)\s+(.+?)\s*$/i.exec(src);
      if (playM) return { confidence: 1, ...call('youtube_search', { query: playM[1].trim(), play_first: true }) };
      const ytM = /\b(?:youtube|yt)\b\s*(?:search\s+)?(?:for\s+)?(.*)/i.exec(src);
      if (ytM) {
        // "youtube kholo" arrives here as "youtube open" — that is an OPEN
        // request, not a search for the word "open".
        const rest = ytM[1].trim().replace(/^(?:open|launch|start|kholo|khol\s+do)\b/i, '').trim();
        if (rest) return { confidence: 1, ...call('youtube_search', { query: rest }) };
        return { confidence: 1, ...call('open_website', { site_name: 'youtube' }) };
      }
      if (/\b(?:youtube|yt)\b/.test(l)) return { confidence: 1, ...call('open_website', { site_name: 'youtube' }) };
      return null;
    },
  },

  // ── web search ────────────────────────────────────────────────────────
  {
    id: 'search',
    match: ({ l, src }) => {
      const searchM = /^(?:search|google|look\s+up|find|bing)\s+(?:for\s+|up\s+)?(.+?)\s*$/i.exec(src);
      if (searchM && !/^(my|the)\s+(location|files?|timers?)$/i.test(searchM[1])) {
        return { confidence: 1, ...call('web_search', { query: searchM[1].trim() }) };
      }
      if (/^(?:images?|photos?)\s+of\s+(.+)/i.test(l)) return { confidence: 1, ...call('web_search', { query: l }) };
      return null;
    },
  },

  // ── directions ────────────────────────────────────────────────────────
  {
    id: 'directions',
    match: ({ src }) => {
      const dirM = /(?:directions?|navigate|route|how\s+(?:do|can)\s+i\s+(?:get|go))\s+(?:to|for)\s+(.+?)(?:\s+from\s+(.+?))?(?:\s+by\s+(car|walk|walking|bus|train|transit|bike|bicycle))?\s*$/i.exec(src);
      if (dirM) {
        const modeMap = { car: 'driving', walk: 'walking', walking: 'walking', bus: 'transit', train: 'transit', transit: 'transit', bike: 'bicycling', bicycle: 'bicycling' };
        return {
          confidence: 1,
          ...call('maps_directions', {
            destination: dirM[1].trim(),
            origin: dirM[2]?.trim() || undefined,
            mode: modeMap[(dirM[3] || '').toLowerCase()] || undefined,
          }),
        };
      }
      return null;
    },
  },

  // ── HUD control ───────────────────────────────────────────────────────
  {
    id: 'hud',
    match: ({ l }) => {
      if (/\b(?:full\s?screen)\b/.test(l)) return { confidence: 1, ...call('request_fullscreen', { enable: !/\b(exit|leave|stop)\b/.test(l) }) };
      if (/\b(?:clear|reset|wipe)\s+(?:the\s+)?(?:terminal|log|screen|chat|history)\b/.test(l)) return { confidence: 1, ...call('clear_terminal', {}) };
      const accentM = /\b(?:accent|theme|colour|color|hud)\s+(?:to\s+)?(cyan|magenta|violet|amber|green|red|ice|sunset)\b/i.exec(l)
        || /\b(set|change|make)\b.*\b(cyan|magenta|violet|amber|green|red|ice|sunset)\b/i.exec(l);
      if (accentM) return { confidence: 1, ...call('set_hud_accent', { color: (accentM[2] || accentM[1]).toLowerCase() }) };
      if (/\b(?:what\s+can\s+you\s+do|capabilities|commands|protocols|help|features|what\s+are\s+your\s+powers)\b/.test(l)) return { confidence: 1, ...call('list_capabilities', {}) };
      if (/\b(?:show\s+(?:me\s+)?(?:the\s+)?(?:telemetry|about|team))\b/.test(l)) {
        return { confidence: 1, ...call('navigate_panel', { panel: /about|team/.test(l) ? 'about' : 'telemetry' }) };
      }
      return null;
    },
  },

  // ── identity / team ───────────────────────────────────────────────────
  {
    id: 'identity',
    match: ({ l }) => {
      if (/\b(?:team\s+lead(?:er)?|who\s+(?:is|leads)\s+the\s+team|captain)\b/.test(l)) {
        const lead = TEAM.find((m) => m.role === 'Team Leader');
        return { confidence: 1, ...say(`The team leader is ${lead.name} — roll number ${lead.roll}, Commander.`) };
      }
      if (/\b(?:team\s+members|who\s+(?:is|are)\s+(?:on|in)\s+(?:the\s+)?(?:your\s+)?team|full\s+team|project\s+team|our\s+team)\b/.test(l)) {
        return { confidence: 1, ...say(`Team ${APP.teamId}: ${TEAM.map((m) => `${m.name}${m.role === 'Team Leader' ? ' (leader)' : ''}`).join(', ')}.`) };
      }
      const member = TEAM.find((m) => {
        const full = m.name.toLowerCase();
        const first = full.split(' ')[0];
        return new RegExp(`\\b${full.replace(/\s+/g, '\\s+')}\\b`).test(l) || (first.length > 3 && new RegExp(`\\b${first}\\b`).test(l));
      });
      if (member && /\bwho\b|\babout\b|\broll\b/.test(l)) {
        return { confidence: 1, ...say(`${member.name} — roll number ${member.roll}, ${member.role}, team ${APP.teamId}.`) };
      }
      if (/\b(?:who\s+(?:made|built|created|developed)\s+you|your\s+(?:team|creators|developers|makers))\b/.test(l)) {
        return { confidence: 1, ...say(`I was built by team ${APP.teamId} at ${APP.institute}: ${TEAM.map((m) => m.name).join(', ')}.`) };
      }
      if (/\b(?:who\s+are\s+you|what\s+are\s+you|your\s+name|who\s+am\s+i\s+talking\s+to|introduce\s+yourself)\b/.test(l)) {
        return { confidence: 1, ...say(`I am ${APP.name} — ${APP.expanded}. An ${APP.department} project from ${APP.institute}, team ${APP.teamId}.`) };
      }
      return null;
    },
  },

  // ── small talk ────────────────────────────────────────────────────────
  {
    id: 'smalltalk',
    match: ({ l }) => {
      if (/^(?:hi|hello|hey|yo|namaste|namaskar|hola|good\s+(?:morning|afternoon|evening))\b/.test(l)) return { confidence: 1, ...say('Systems nominal. Standing by, Commander.') };
      if (/\b(?:how\s+are\s+you|how('s| is)\s+it\s+going|what'?s\s+up)\b/.test(l)) return { confidence: 1, ...say('All subsystems green and the probability space is wide open. What do you need, Commander?') };
      if (/\b(?:thank(?:s| you)|shukriya|dhanyavad|appreciate\s+it)\b/.test(l)) return { confidence: 1, ...say('Always, Commander.') };
      if (/\b(?:bye|goodbye|see\s+you|good\s+night|shut\s+down|power\s+down|exit|sleep)\b/.test(l)) return { confidence: 1, ...say('Standing by. Call on me anytime, Commander.') };
      if (/\b(?:joke|funny|make\s+me\s+laugh)\b/.test(l)) return { confidence: 1, ...say(JOKES[Math.floor(Math.random() * JOKES.length)]) };
      return null;
    },
  },

  // ── knowledge: entities → Wikipedia ───────────────────────────────────
  {
    id: 'knowledge_entity',
    match: ({ l, src }) => {
      if (NEEDS_MODEL.test(l)) return null;
      const ask = src.trim().replace(/[?.!]+$/, '');
      const m = /\b(?:what(?:'s|\s+is|\s+are|\s+was|\s+were|\s+does|\s+do)?|who(?:'s|\s+is|\s+was|\s+are|\s+were)?|whom|which|define|definition\s+of|meaning\s+of|tell\s+me\s+about|information\s+(?:on|about)|info\s+(?:on|about)|summary\s+of|wikipedia)\s+(.+)$/i.exec(ask);
      let topic = null;
      let confidence = 0.9;
      if (m) {
        topic = m[1];
      } else if (!/\b(?:explain|describe|elaborate)\b/.test(l)) {
        // Bare noun phrase: "dinosaurs", "quantum entanglement", "PSIT Kanpur".
        const words = ask.trim().split(/\s+/);
        const looksLikeEntity = words.length >= 1 && words.length <= 6
          && !/\b(?:how|why|can|could|should|would|do|does|did|is|are|was|were|the|my|your|me|i)\b/i.test(ask.trim())
          && /^[A-Za-z0-9][A-Za-z0-9 .'\-()]*$/.test(ask.trim());
        // 0.88 clears LOCAL_FIRST_THRESHOLD: a bare topic is answered from
        // Wikipedia locally instead of spending a quota-limited model call.
        if (looksLikeEntity) { topic = ask.trim(); confidence = 0.88; }
      }
      if (!topic) return null;
      topic = topic.trim()
        .replace(/^(?:the|a|an)\s+/i, '')
        .replace(/\s+(?:mean|means|meaning|in english|kya hai)$/i, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (topic.length < 2 || topic.length > 80) return null;
      if (SELF_REF.test(topic)) return null;
      if (/^[\d\s+\-*/^().,%]+$/.test(topic)) return null;
      // How-to/technical questions are answered far better by Stack Overflow.
      if (HOWTO.test(l) && confidence < 0.9) return null;
      return { confidence, ...call('wikipedia_lookup', { topic, sentences: 4 }) };
    },
  },

  // ── knowledge: how-to / code → Stack Overflow (keyless) ───────────────
  {
    id: 'knowledge_howto',
    match: ({ l, src }) => {
      if (NEEDS_MODEL.test(l)) return null;
      if (!HOWTO.test(l)) return null;
      if (SELF_REF.test(src)) return null;
      const topic = src.trim().replace(/[?.!]+$/, '')
        .replace(/^(?:how (?:to|do i|can i|do you)|what is the|what is|tell me|show me)\s+/i, '')
        .trim();
      if (topic.length < 3 || topic.length > 90) return null;
      return { confidence: 0.85, ...call('stackoverflow_search', { query: topic }) };
    },
  },
];

/**
 * Route a query to the best local intent.
 * @returns {{intent:string, confidence:number, calls?:Array, text?:string, gaveUp?:boolean}}
 */
export function route(rawQuery, _ctx = {}) {
  const n = normalize(rawQuery);
  if (!n.l) return { intent: 'empty', confidence: 1, ...say('I did not catch that, Commander.') };

  let best = null;
  for (const intent of INTENTS) {
    let hit = null;
    try { hit = intent.match(n); } catch { hit = null; }
    if (hit && (!best || hit.confidence > best.confidence)) {
      best = { intent: intent.id, ...hit };
    }
  }

  if (best) {
    const { intent, confidence, calls, text } = best;
    return { intent, confidence, calls, text, local: confidence >= 0.85 };
  }

  // Nothing matched. If the model is available we hand it over (local:false).
  // If it is NOT, a real web search beats a dead-end paragraph — so offer that
  // at low confidence, and only as a last resort.
  if (n.words.length >= 2) {
    return { intent: 'unknown_search', confidence: 0.4, local: false, ...call('web_search', { query: n.src }) };
  }

  return {
    intent: 'unknown',
    confidence: 0,
    local: false,
    gaveUp: true,
    text:
      "I could not resolve that locally. I can open sites, search the web, do maths, set timers, " +
      "read sensors, look up any topic on Wikipedia and pull how-to answers from Stack Overflow — " +
      'try "what is <topic>" or "how to <task>".',
  };
}

/**
 * Back-compatible shim: the provider and the tests call `offlinePlan`.
 * Multi-intent queries ("open youtube and search lofi") are split here.
 */
export function offlinePlan(rawQuery, ctx = {}) {
  const src = String(rawQuery || '').trim();
  const parts = src.split(/\s+(?:and then|then|and also|also|aur|and)\s+/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 1);

  if (parts.length > 1) {
    const calls = [];
    const texts = [];
    let gaveUp = false;
    for (const part of parts) {
      const r = route(part, ctx);
      if (r.calls?.length) calls.push(...r.calls);
      else if (r.text) texts.push(r.text);
      if (r.gaveUp) gaveUp = true;
    }
    if (calls.length) return { calls, text: texts.join(' ') || undefined, gaveUp: gaveUp && !calls.length };
    if (texts.length) return { text: texts.join(' '), gaveUp };
  }

  const r = route(src, ctx);
  const out = {};
  if (r.calls?.length) out.calls = r.calls;
  if (r.text) out.text = r.text;
  if (r.gaveUp) out.gaveUp = true;
  return out;
}

/** Confidence above which we answer locally and never spend a model call. */
export const LOCAL_FIRST_THRESHOLD = 0.85;

/** A one-line human reason for the badge, shown in the Telemetry panel. */
export function offlineReason(err) {
  if (!err) return 'Local core engaged by choice.';
  return err.hint || err.message || err.code || 'Unknown';
}
