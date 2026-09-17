/**
 * Q.U.A.R.K. — Utility actions: calculation, date/time, timers, reminders,
 * and the explicit permission request tool.
 */

import { calculate, CALC_HELP } from '../calc.js';
import { CAPABILITIES } from '../permissions.js';

export function _calculate({ expression }) {
  const r = calculate(expression);
  if (!r.ok) return { ok: false, summary: `I could not evaluate "${expression}": ${r.error}. ${CALC_HELP}` };
  return {
    ok: true,
    summary: `${expression} = ${r.display}`,
    data: { expression, value: r.value, display: r.display },
  };
}

export function get_datetime({ timezone, part }) {
  const tz = timezone && Intl.supportedValuesOf?.('timeZone')?.includes(timezone) ? timezone :
             (timezone ? safeTz(timezone) : undefined) || undefined;
  const opts = { timeZone: tz, hour12: false };
  let resolvedTz;
  try {
    resolvedTz = new Intl.DateTimeFormat('en-GB', { ...opts, timeZoneName: 'shortOffset' })
      .resolvedOptions().timeZone;
  } catch {
    resolvedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  const fmt = (o) => new Intl.DateTimeFormat('en-GB', { ...o, timeZone: resolvedTz }).format(new Date());

  const time = fmt({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const date = fmt({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const iso = new Date().toISOString();

  const out = part === 'time' ? { time } : part === 'date' ? { date } : { time, date };
  return {
    ok: true,
    summary: `${Object.entries(out).map(([k, v]) => `${k[0].toUpperCase() + k.slice(1)}: ${v}`).join(' · ')} (timezone ${resolvedTz}, ISO ${iso})`,
    data: { ...out, timezone: resolvedTz, iso, unix: Math.floor(Date.now() / 1000) },
  };
}

function safeTz(tz) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz; } catch { return undefined; }
}

// ── timers & reminders ───────────────────────────────────────────────────
export function set_timer({ duration_seconds, label }, ctx) {
  const secs = Math.min(Math.max(Math.round(Number(duration_seconds) || 0), 1), 86400);
  if (!secs) return { ok: false, summary: 'set_timer needs a positive duration_seconds.' };
  const t = ctx.timers.add({ kind: 'timer', seconds: secs, label: String(label || 'Timer').slice(0, 80) });
  return {
    ok: true,
    summary: `Timer "${t.label}" started for ${humanDuration(secs)} (id ${t.id}). I will alert you when it elapses.`,
    data: t,
  };
}

export function set_reminder({ datetime, message }, ctx) {
  const when = new Date(datetime);
  if (Number.isNaN(when.getTime())) {
    return { ok: false, summary: `Could not parse the datetime "${datetime}". Use ISO 8601, e.g. 2026-09-17T09:00:00.` };
  }
  const ms = when.getTime() - Date.now();
  if (ms <= 0) {
    return { ok: false, summary: `That time (${when.toLocaleString()}) is already in the past.` };
  }
  if (ms > 1000 * 60 * 60 * 24 * 366) {
    return { ok: false, summary: 'Reminders more than a year out are not supported.' };
  }
  const t = ctx.timers.add({ kind: 'reminder', at: when.toISOString(), label: String(message || 'Reminder').slice(0, 160) });
  return {
    ok: true,
    summary:
      `Reminder "${t.label}" set for ${when.toLocaleString()} (${humanDuration(Math.round(ms / 1000))} from now, id ${t.id}). ` +
      `It is stored in localStorage and will fire a notification if this site is open.`,
    data: t,
  };
}

export function cancel_timer({ id }, ctx) {
  if (!id || String(id).toLowerCase() === 'all') {
    const n = ctx.timers.clearAll();
    return { ok: true, summary: n ? `Cancelled all ${n} timers/reminders.` : 'There were no active timers to cancel.' };
  }
  const ok = ctx.timers.cancel(String(id));
  return ok
    ? { ok: true, summary: `Cancelled timer ${id}.` }
    : { ok: false, summary: `No active timer with id "${id}". ${ctx.timers.list().map((t) => t.id).join(', ') || 'None are running.'}` };
}

export function humanDuration(secs) {
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ── explicit permission request ──────────────────────────────────────────
export async function request_permission({ capability, reason }, ctx) {
  const id = String(capability || '').toLowerCase();
  if (!CAPABILITIES[id]) {
    return {
      ok: false,
      summary: `Unknown capability "${capability}". Valid: ${Object.keys(CAPABILITIES).join(', ')}.`,
    };
  }
  const res = await ctx.ensurePermission(id, { reason: reason || `to use the ${CAPABILITIES[id].label} capability` });
  const label = CAPABILITIES[id].label;
  if (res.state === 'granted') return { ok: true, summary: `${label} access granted. Ready to use.` };
  if (res.state === 'denied') return { ok: false, summary: `${label} access was denied. ${ctx.denialHelp?.(id) || ''}`.trim() };
  if (res.state === 'unsupported') return { ok: false, summary: `${label} is not supported by this browser.` };
  return { ok: false, summary: `${label} access is unavailable: ${res.error || res.state}.` };
}
