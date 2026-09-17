/**
 * Q.U.A.R.K. — HUD control actions
 * ─────────────────────────────────────────────────────────────────────────
 * `display_content` is how the model "shows" things. Model output is NEVER
 * injected as HTML. It arrives as typed blocks that are validated here and
 * rendered by <ViewportBlock> using only React text nodes and allowlisted
 * attributes. That removes the XSS class of bug entirely.
 */

import { auditCapabilities, CAPABILITIES } from '../permissions.js';
import { TOOL_DECLARATIONS, CATEGORY_LABELS, toolMeta } from '../tools.js';

const ALLOWED_BLOCK_TYPES = new Set([
  'heading', 'paragraph', 'list', 'ordered_list', 'code', 'quote', 'table', 'keyvalue', 'link_row', 'image', 'audio',
]);

const clamp = (v, n) => (typeof v === 'string' ? v.slice(0, n) : v);
const str = (v, n = 4000) => (v == null ? '' : clamp(String(v), n));

/** Validate + normalise the blocks the model produced. */
export function sanitizeBlocks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 40).flatMap((b) => {
    if (!b || typeof b !== 'object') return [];
    const type = String(b.type || '').toLowerCase();
    if (!ALLOWED_BLOCK_TYPES.has(type)) return [];

    switch (type) {
      case 'heading':
      case 'paragraph':
      case 'quote':
        return b.text ? [{ type, text: str(b.text, 6000) }] : [];
      case 'code':
        return [{ type, text: str(b.text, 20000), language: str(b.language, 40) }];
      case 'list':
      case 'ordered_list': {
        const items = Array.isArray(b.items) ? b.items.map((i) => str(i, 800)).filter(Boolean).slice(0, 60) : [];
        return items.length ? [{ type, items }] : [];
      }
      case 'table': {
        const columns = Array.isArray(b.columns) ? b.columns.map((c) => str(c, 120)).slice(0, 12) : [];
        const rows = Array.isArray(b.rows)
          ? b.rows.slice(0, 120).map((r) => (Array.isArray(r) ? r.map((c) => str(c, 400)).slice(0, 12) : [str(r, 400)]))
          : [];
        return rows.length ? [{ type, columns: columns.length ? columns : rows[0].map((_, i) => `Col ${i + 1}`), rows }] : [];
      }
      case 'keyvalue': {
        const entries = Array.isArray(b.entries)
          ? b.entries.slice(0, 60).map((e) => ({ k: str(e?.k, 120), v: str(e?.v, 600) })).filter((e) => e.k)
          : [];
        return entries.length ? [{ type, entries }] : [];
      }
      case 'link_row': {
        const links = Array.isArray(b.links)
          ? b.links
              .slice(0, 12)
              .map((l) => ({ label: str(l?.label, 80) || str(l?.url, 80), url: str(l?.url, 500) }))
              .filter((l) => /^https?:\/\//i.test(l.url))
          : [];
        return links.length ? [{ type, links }] : [];
      }
      // image/audio blocks are only produced internally (camera/screen/recorder),
      // never accepted from model output — that prevents remote-tracking pixels
      // and arbitrary media loads.
      default:
        return [];
    }
  });
}

export function display_content({ title, blocks, confirm_text }, ctx) {
  const clean = sanitizeBlocks(blocks);
  if (!clean.length) {
    return { ok: false, summary: 'display_content was called with no renderable blocks — nothing was shown.' };
  }
  ctx.showViewport?.({ title: str(title, 120) || 'DISPLAY', blocks: clean, actions: [] });
  const kinds = [...new Set(clean.map((b) => b.type))].join(', ');
  return {
    ok: true,
    summary: confirm_text
      ? `${str(confirm_text, 300)} (Displayed in the HUD viewport: ${clean.length} block(s) — ${kinds}.)`
      : `Displayed "${title || 'content'}" in the HUD viewport: ${clean.length} block(s) — ${kinds}.`,
    data: { blocks: clean.length, kinds },
  };
}

export function navigate_panel({ panel }, ctx) {
  const p = String(panel || 'overview').toLowerCase();
  ctx.navigatePanel?.(p);
  return { ok: true, summary: `Switched the HUD to the ${p.toUpperCase()} panel.` };
}

const ACCENTS = {
  cyan:    { a: '#4deaff', b: '#ff4fc3' },
  magenta: { a: '#ff4fc3', b: '#8b6bff' },
  violet:  { a: '#8b6bff', b: '#4deaff' },
  amber:   { a: '#ffb84d', b: '#ff4fc3' },
  green:   { a: '#4dffa6', b: '#4deaff' },
  red:     { a: '#ff6b7d', b: '#ffb84d' },
  ice:     { a: '#a8e9ff', b: '#e2d6ff' },
  sunset:  { a: '#ff8a5b', b: '#ff4fc3' },
};

export function set_hud_accent({ color, hex }, ctx) {
  let a = null, b = null;
  const explicit = /^#([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (explicit) { a = explicit[0]; b = ACCENTS[color]?.b || '#ff4fc3'; }
  else if (color && ACCENTS[String(color).toLowerCase()]) { ({ a, b } = ACCENTS[String(color).toLowerCase()]); }
  if (!a) {
    return { ok: false, summary: `Unknown accent "${color || hex}". Valid presets: ${Object.keys(ACCENTS).join(', ')}, or a #rrggbb hex.` };
  }
  ctx.setAccent?.(a, b);
  return { ok: true, summary: `HUD accent lighting set to ${a}.` };
}

export async function request_fullscreen({ enable }) {
  const wantOn = enable !== false;
  try {
    if (wantOn) {
      if (document.fullscreenElement) return { ok: true, summary: 'The HUD is already fullscreen.' };
      await document.documentElement.requestFullscreen();
      return { ok: true, summary: 'Entered fullscreen.' };
    }
    if (document.fullscreenElement) await document.exitFullscreen();
    return { ok: true, summary: 'Exited fullscreen.' };
  } catch (e) {
    return { ok: false, summary: `Fullscreen ${wantOn ? 'entry' : 'exit'} failed: ${e.message}. It normally needs a direct user click.` };
  }
}

export function clear_terminal(_args, ctx) {
  const n = ctx.clearTerminal?.() ?? 0;
  return { ok: true, summary: `Cleared the SYSTEM_LOG (${n} entries removed).` };
}

export async function list_capabilities(_args, ctx) {
  const caps = await auditCapabilities();
  const byState = (s) => caps.filter((c) => c.state === s);

  const toolGroups = {};
  for (const t of TOOL_DECLARATIONS) {
    const cat = toolMeta(t.name).category;
    (toolGroups[cat] ||= []).push(t.name);
  }

  ctx.showViewport?.({
    title: 'CAPABILITY MATRIX // LIVE',
    blocks: [
      { type: 'paragraph', text:
        'Q.U.A.R.K. runs entirely inside your browser. It can drive the web and every browser-exposed ' +
        'device capability — but it cannot launch native desktop applications or read arbitrary files. ' +
        'Here is the exact live status on this device:' },
      { type: 'table',
        columns: ['Capability', 'State'],
        rows: caps.map((c) => [c.label, c.state.toUpperCase()]) },
      { type: 'heading', text: `Tools available (${TOOL_DECLARATIONS.length})` },
      ...Object.entries(toolGroups).map(([cat, names]) => ({
        type: 'keyvalue',
        entries: [{ k: CATEGORY_LABELS[cat] || cat, v: names.join(', ') }],
      })),
    ],
  });

  return {
    ok: true,
    summary:
      `${TOOL_DECLARATIONS.length} tools across ${Object.keys(toolGroups).length} categories. ` +
      `Permissions — granted: ${byState('granted').map((c) => c.label).join(', ') || 'none'}; ` +
      `awaiting user choice: ${byState('prompt').map((c) => c.label).join(', ') || 'none'}; ` +
      `denied: ${byState('denied').map((c) => c.label).join(', ') || 'none'}; ` +
      `unsupported in this browser: ${byState('unsupported').map((c) => c.label).join(', ') || 'none'}. ` +
      `Hard limits: cannot open native desktop apps, cannot read arbitrary files, cannot control other tabs or the OS. ` +
      `Full matrix shown in the viewport.`,
    data: { capabilities: caps, tools: TOOL_DECLARATIONS.length, categories: toolGroups },
  };
}

export { ACCENTS, CAPABILITIES };
