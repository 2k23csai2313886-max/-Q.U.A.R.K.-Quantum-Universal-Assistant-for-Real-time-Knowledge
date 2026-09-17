/**
 * Q.U.A.R.K. — Web & Navigation actions
 * ─────────────────────────────────────────────────────────────────────────
 * THE POPUP-BLOCKING PROBLEM, solved properly:
 *
 * Model replies arrive asynchronously, long after the user's click. Browsers
 * only allow window.open() during a "trusted user activation". So a tool call
 * that opens a tab is frequently blocked — silently.
 *
 * Fix: try window.open(); if it returns null, fall back to a HUD *launch card*
 * with a real <a target="_blank"> the user clicks. That click IS a trusted
 * activation, so it always works. The model is told which path happened so it
 * can phrase its reply correctly.
 */

import { KNOWN_SITES, SEARCH_ENGINES } from '../constants.js';

/** @returns {{opened:boolean, blocked:boolean, url:string}} */
export function launch(url, label, ctx) {
  let win = null;
  try {
    win = window.open(url, '_blank');
  } catch {
    win = null;
  }
  if (win) {
    try { win.opener = null; } catch { /* cross-origin, already safe */ }
    return { opened: true, blocked: false, url };
  }
  ctx?.showLaunchCard?.({ url, label: label || prettyHost(url) });
  return { opened: false, blocked: true, url };
}

export function prettyHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function encode(q) { return encodeURIComponent(String(q ?? '').trim()); }

/** Require http(s) only — blocks javascript:, data:, file: and friends. */
export function safeUrl(raw) {
  try {
    const u = new URL(String(raw).trim());
    if (!['http:', 'https:', 'mailto:', 'tel:', 'sms:'].includes(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// ── fuzzy site resolution ────────────────────────────────────────────────
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function resolveSite(input) {
  const q = normalize(input);
  if (!q) return null;

  // 1. exact alias
  for (const s of KNOWN_SITES) if (s.aliases.includes(q) || normalize(s.name) === q) return s;
  // 2. alias starts with / contains query
  for (const s of KNOWN_SITES) if (s.aliases.some((a) => a.startsWith(q) || q.startsWith(a))) return s;
  // 3. token overlap (handles "you tube", "youtube kholo", "open the github")
  const qt = new Set(q.split(' '));
  let best = null, bestScore = 0;
  for (const s of KNOWN_SITES) {
    const names = [normalize(s.name), ...s.aliases];
    for (const n of names) {
      const nt = n.split(' ');
      let score = 0;
      for (const t of nt) if (qt.has(t)) score += t.length;
      // edit-distance-ish tolerance for typos
      if (!score && nt.length === 1) {
        const cand = nt[0];
        for (const t of qt) if (levenshtein(cand, t) <= 2 && cand.length > 3) score = cand.length * 0.6;
      }
      if (score > bestScore) { bestScore = score; best = s; }
    }
  }
  return bestScore >= 3 ? best : null;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// ── actions ──────────────────────────────────────────────────────────────

export function open_website({ site_name }, ctx) {
  const site = resolveSite(site_name);
  if (!site) {
    // Unknown name → fall back to a web search so the user still gets somewhere
    const q = encode(site_name);
    const url = SEARCH_ENGINES.google + q;
    const r = launch(url, site_name, ctx);
    return {
      ok: true,
      summary: `"${site_name}" is not in the known-site registry, so a Google search for it was ` +
        (r.opened ? 'opened in a new tab' : 'prepared as a launch card (popup blocked)'),
      data: { url, fallback: 'search', ...r },
    };
  }
  const r = launch(site.url, site.name, ctx);
  return {
    ok: true,
    summary: r.opened
      ? `Opened ${site.name} (${site.url}) in a new browser tab.`
      : `The browser blocked the automatic popup for ${site.name}. A launch card is now on screen — ` +
        `the user taps it to open ${site.url}.`,
    data: { site: site.name, url: site.url, ...r },
  };
}

export function open_url({ url, label }, ctx) {
  const clean = safeUrl(url);
  if (!clean) {
    return { ok: false, summary: `Refused to open "${url}" — only http/https/mailto/tel/sms URLs are allowed.` };
  }
  const r = launch(clean, label, ctx);
  return {
    ok: true,
    summary: r.opened
      ? `Opened ${clean} in a new tab.`
      : `Popup blocked for ${clean}; a launch card is displayed for the user to click.`,
    data: r,
  };
}

export function web_search({ query, engine }, ctx) {
  const base = SEARCH_ENGINES[String(engine || 'google').toLowerCase()] || SEARCH_ENGINES.google;
  const url = base + encode(query);
  const r = launch(url, `${query} — search`, ctx);
  return {
    ok: true,
    summary: r.opened
      ? `Ran a web search for "${query}" and opened the results in a new tab.`
      : `Search results for "${query}" are ready in a launch card (popup was blocked).`,
    data: { query, url, ...r },
  };
}

export function youtube_search({ query, play_first }, ctx) {
  const url = play_first
    ? `https://www.youtube.com/results?search_query=${encode(query)}&sp=EgIQAQ%253D%253D`
    : `https://www.youtube.com/results?search_query=${encode(query)}`;
  const r = launch(url, `YouTube — ${query}`, ctx);
  return {
    ok: true,
    summary: r.opened
      ? `Opened YouTube results for "${query}" in a new tab.`
      : `YouTube search for "${query}" is waiting in a launch card (popup blocked).`,
    data: { query, url, ...r },
  };
}

export async function maps_directions({ destination, origin, mode }, ctx) {
  let from = origin;
  // No origin given → try GPS (permission broker handles the ask)
  if (!from) {
    const res = await ctx.ensurePermission('geolocation', {
      reason: 'to use your current position as the starting point for directions',
    });
    if (res.state === 'granted' && res.data) from = `${res.data.latitude},${res.data.longitude}`;
  }

  const params = new URLSearchParams({ api: '1', destination });
  if (from) params.set('origin', from);
  if (mode) params.set('travelmode', mode);
  const url = `https://www.google.com/maps/dir/?${params}`;
  const r = launch(url, `Directions → ${destination}`, ctx);
  return {
    ok: true,
    summary:
      `Google Maps directions to "${destination}"${from ? ` from ${from}` : ' from your current location'}` +
      `${mode ? ` by ${mode}` : ''} — ` + (r.opened ? 'opened in a new tab.' : 'ready in a launch card.'),
    data: { destination, origin: from || 'current location', mode: mode || 'driving', url, ...r },
  };
}

export async function wikipedia_lookup({ topic, sentences }) {
  const n = Math.min(Math.max(parseInt(sentences, 10) || 4, 1), 12);
  const api = 'https://en.wikipedia.org/w/api.php';
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);
  try {
    // 1. resolve the title
    const searchUrl =
      `${api}?action=query&format=json&origin=*&list=search&srsearch=${encode(topic)}&srlimit=1`;
    const sr = await fetch(searchUrl, { signal: ctrl.signal });
    if (!sr.ok) throw new Error('search HTTP ' + sr.status);
    const sj = await sr.json();
    const hit = sj?.query?.search?.[0];
    if (!hit) return { ok: false, summary: `No Wikipedia article found for "${topic}".` };

    // 2. fetch the plain-text extract
    const exUrl =
      `${api}?action=query&format=json&origin=*&prop=extracts&exintro=1&explaintext=1&redirects=1&titles=${encode(hit.title)}`;
    const er = await fetch(exUrl, { signal: ctrl.signal });
    if (!er.ok) throw new Error('extract HTTP ' + er.status);
    const ej = await er.json();
    const page = Object.values(ej?.query?.pages || {})[0];
    const extract = (page?.extract || '').trim();
    if (!extract) return { ok: false, summary: `"${hit.title}" exists but has no introductory extract.` };

    const parts = extract.split(/(?<=[.!?])\s+/).filter(Boolean);
    const trimmed = parts.slice(0, n).join(' ');
    return {
      ok: true,
      summary: trimmed,
      data: {
        title: hit.title,
        url: `https://en.wikipedia.org/wiki/${encode(hit.title.replace(/ /g, '_'))}`,
        sentences: parts.length,
      },
    };
  } catch (e) {
    return { ok: false, summary: `Wikipedia lookup failed: ${e.name === 'AbortError' ? 'request timed out' : e.message}` };
  } finally {
    clearTimeout(to);
  }
}

/**
 * Keyless Stack Overflow search.
 * Wikipedia is authoritative for ENTITIES but useless for how-to/programming
 * questions ("linux command for search" → an article about `env`). The Stack
 * Exchange API needs no key, sends `Access-Control-Allow-Origin: *`, and ranks
 * by votes, so the top hit is usually the canonical answer.
 */
export async function stackoverflow_search({ query, results }) {
  const n = Math.min(Math.max(parseInt(results, 10) || 3, 1), 8);
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);
  try {
    const url =
      'https://api.stackexchange.com/2.3/search/advanced' +
      // sort=relevance, NOT votes: voting-sorted full-text search surfaces
      // famous-but-unrelated questions ("technology podcasts") for a query
      // like "linux command for search". Relevance returns the exact duplicate.
      `?q=${encode(query)}&site=stackoverflow&order=desc&sort=relevance&pagesize=${n}` +
      '&filter=default';
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const items = (j.items || []).slice(0, n);
    if (!items.length) return { ok: false, summary: `No Stack Overflow results for "${query}".` };

    const lines = items.map((it, i) => {
      const votes = it.score ?? 0;
      const answers = it.answer_count ?? 0;
      const solved = it.is_answered ? `${answers} answer${answers === 1 ? '' : 's'}` : 'unanswered';
      return `${i + 1}. ${it.title} — ${votes} votes, ${solved}. ${it.link}`;
    });
    const top = items[0];
    return {
      ok: true,
      summary:
        `Top Stack Overflow result for "${query}": ${top.title} ` +
        `(${top.score ?? 0} votes, ${top.answer_count ?? 0} answers) — ${top.link}` +
        (items.length > 1 ? `\n\nAlso: ${items.slice(1).map((it) => `${it.title} (${it.link})`).join(' | ')}` : ''),
      data: {
        query,
        source: 'stackoverflow',
        results: items.map((it) => ({ title: it.title, url: it.link, votes: it.score ?? 0, answers: it.answer_count ?? 0, tags: it.tags || [] })),
        lines,
      },
    };
  } catch (e) {
    return { ok: false, summary: `Stack Overflow search failed: ${e.name === 'AbortError' ? 'request timed out' : e.message}` };
  } finally {
    clearTimeout(to);
  }
}

export function send_email({ to, subject, body }) {
  const params = new URLSearchParams();
  if (subject) params.set('subject', subject);
  if (body) params.set('body', body);
  const qs = params.toString();
  const url = `mailto:${encode(to)}${qs ? '?' + qs : ''}`;
  // mailto: navigation is not popup-blocked the same way, but use location for reliability
  try { window.location.href = url; } catch { /* ignore */ }
  return {
    ok: true,
    summary: `Opened the mail client with a draft to ${to}. The user reviews and presses send — nothing was sent automatically.`,
    data: { to, subject: subject || '', url },
  };
}

/** Google Calendar's public TEMPLATE endpoint — no OAuth needed, user confirms in Google's UI. */
export function add_calendar_event({ title, start, end, location, details }, ctx) {
  const toUtcBasic = (iso) => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  };
  const dates = toUtcBasic(start);
  if (!dates) return { ok: false, summary: `Could not parse the start time "${start}".` };
  const dateEnd = end ? toUtcBasic(end) : toUtcBasic(new Date(new Date(start).getTime() + 3600e3).toISOString());

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${dates}/${dateEnd || dates}`,
  });
  if (location) params.set('location', location);
  if (details) params.set('details', details);
  const url = `https://calendar.google.com/calendar/render?${params}`;
  const r = launch(url, `Calendar — ${title}`, ctx);
  return {
    ok: true,
    summary: `A pre-filled Google Calendar event "${title}" starting ${start} is ` +
      (r.opened ? 'open in a new tab for the user to save.' : 'ready in a launch card.'),
    data: { title, start, end: dateEnd, url, ...r },
  };
}
