/**
 * Q.U.A.R.K. — tool executor
 * ─────────────────────────────────────────────────────────────────────────
 * Bridges Gemini's `functionCall` parts to the browser implementations.
 *
 * Contract for every tool result:
 *   { ok:boolean, summary:string, data?:any, meta?:any }
 *
 * `summary` is what goes back to the model as the function response — it must
 * be a complete, self-contained sentence the model can turn into speech.
 */

import * as web from './actions/web.js';
import * as device from './actions/device.js';
import * as io from './actions/io.js';
import * as hud from './actions/hud.js';
import * as util from './actions/utility.js';
import { TOOL_META, TOOL_NAMES } from './tools.js';
import { PERM_STATE, denialHelp } from './permissions.js';

const REGISTRY = {
  // web
  open_website: web.open_website,
  open_url: web.open_url,
  web_search: web.web_search,
  youtube_search: web.youtube_search,
  maps_directions: web.maps_directions,
  wikipedia_lookup: web.wikipedia_lookup,
  stackoverflow_search: web.stackoverflow_search,
  send_email: web.send_email,
  add_calendar_event: web.add_calendar_event,
  // device
  get_location: device.get_location,
  get_weather: device.get_weather,
  get_device_status: device.get_device_status,
  show_notification: device.show_notification,
  capture_photo: device.capture_photo,
  capture_screen: device.capture_screen,
  record_audio: device.record_audio,
  // io
  read_clipboard: io.read_clipboard,
  write_clipboard: io.write_clipboard,
  share_content: io.share_content,
  save_file: io.save_file,
  open_file: io.open_file,
  export_transcript: io.export_transcript,
  // hud
  display_content: hud.display_content,
  navigate_panel: hud.navigate_panel,
  set_hud_accent: hud.set_hud_accent,
  request_fullscreen: hud.request_fullscreen,
  clear_terminal: hud.clear_terminal,
  list_capabilities: hud.list_capabilities,
  // voice  (wired in at runtime — needs the speech engine)
  speak: null,
  set_voice_listening: null,
  set_voice_mode: null,
  // utility
  calculate: util._calculate,
  get_datetime: util.get_datetime,
  set_timer: util.set_timer,
  set_reminder: util.set_reminder,
  cancel_timer: util.cancel_timer,
  request_permission: util.request_permission,
};

/** Tools that call ensurePermission() themselves (they need the permission's
 *  return VALUE, not just a yes/no), so the executor must not pre-gate them. */
const SELF_GATED = new Set([
  'get_location', 'get_weather', 'show_notification', 'capture_photo',
  'capture_screen', 'record_audio', 'read_clipboard', 'request_permission',
]);

/** Voice tools are supplied by the React layer (they need the speech engine). */
export function registerRuntimeTools({ speak, setVoiceListening, setVoiceMode }) {
  if (speak) REGISTRY.speak = speak;
  if (setVoiceListening) REGISTRY.set_voice_listening = setVoiceListening;
  if (setVoiceMode) REGISTRY.set_voice_mode = setVoiceMode;
}

export function hasTool(name) {
  return typeof REGISTRY[name] === 'function';
}

export function toolNames() {
  return TOOL_NAMES;
}

/**
 * Execute one function call.
 * @param {{name:string, args:object, id?:string}} call
 * @param {object} ctx  the runtime context built by useQuark()
 */
export async function executeTool(call, ctx) {
  const { name, args = {}, id } = call;
  const started = performance.now();
  const meta = TOOL_META[name] || {};

  if (!hasTool(name)) {
    return {
      id, name,
      result: { ok: false, summary: `No such tool: "${name}". Available tools: ${TOOL_NAMES.join(', ')}.` },
      ms: 0, permission: null,
    };
  }

  ctx.logActivity?.('EXECUTING', name);
  ctx.onToolStart?.({ name, args, id });

  // ── permission gate ──────────────────────────────────────────────────
  let permission = null;
  if (meta.capability && !SELF_GATED.has(name)) {
    permission = await ctx.ensurePermission(meta.capability, {
      reason: `to run the ${name.replace(/_/g, ' ')} action`,
    });
    if (permission.state !== PERM_STATE.GRANTED) {
      const summary =
        `${name} could not run: ${meta.capability} permission is "${permission.state}". ` +
        (permission.state === PERM_STATE.DENIED ? denialHelp(meta.capability) : '');
      const result = { ok: false, summary, data: { permission: permission.state } };
      ctx.logActivity?.('PERMISSION DENIED', meta.capability);
      ctx.onToolEnd?.({ name, args, id, result, ms: 0, permission: permission.state });
      return { id, name, result, ms: 0, permission: permission.state };
    }
  }

  // ── run ──────────────────────────────────────────────────────────────
  let result;
  try {
    result = await Promise.race([
      Promise.resolve(REGISTRY[name](args, ctx)),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('tool timed out after 120s')), 120000),
      ),
    ]);
    if (!result || typeof result.summary !== 'string') {
      result = { ok: false, summary: `${name} returned a malformed result.` };
    }
  } catch (e) {
    result = { ok: false, summary: `${name} threw an error: ${e?.message || String(e)}` };
  }

  const ms = Math.round(performance.now() - started);
  ctx.onToolEnd?.({ name, args, id, result, ms, permission: permission?.state ?? null });
  return { id, name, result, ms, permission: permission?.state ?? null };
}

/** Shape a tool result into a Gemini `functionResponse` part. */
export function toFunctionResponse({ id, name, result }) {
  return {
    functionResponse: {
      name,
      // Gemini wants a JSON object here. Keep it small and text-first.
      response: {
        status: result.ok ? 'success' : 'failed',
        summary: String(result.summary || '').slice(0, 8000),
        ...(result.data ? { data: truncateDeep(result.data) } : {}),
      },
      ...(id ? { id } : {}),
    },
  };
}

/** Keep tool payloads from ballooning the context window. */
function truncateDeep(value, depth = 0) {
  if (depth > 4) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 40).map((v) => truncateDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) {
      // never ship media payloads back to the model
      if (typeof v === 'string' && (v.startsWith('data:') || v.startsWith('blob:'))) out[k] = '[media omitted]';
      else out[k] = truncateDeep(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.slice(0, 4000);
  return value;
}
