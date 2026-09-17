/**
 * Q.U.A.R.K. — Clipboard, files, share & export actions
 */

export async function read_clipboard(_args, ctx) {
  const res = await ctx.ensurePermission('clipboard-read', { reason: 'to read what you have copied' });
  if (res.state !== 'granted') {
    return { ok: false, summary: `Clipboard read is ${res.state}. ${ctx.denialHelp?.('clipboard-read') || ''}`.trim() };
  }
  try {
    const text = res.data?.text ?? (await navigator.clipboard.readText());
    if (!text) return { ok: true, summary: 'The clipboard is empty.', data: { text: '' } };
    return {
      ok: true,
      summary: `Clipboard contains ${text.length} characters: "${text.slice(0, 1200)}${text.length > 1200 ? '…' : ''}"`,
      data: { length: text.length, text: text.slice(0, 8000) },
    };
  } catch (e) {
    return { ok: false, summary: `Clipboard read failed: ${e.message}` };
  }
}

export async function write_clipboard({ text }, ctx) {
  const payload = String(text ?? '');
  if (!payload) return { ok: false, summary: 'Nothing to copy — the text was empty.' };

  // Try the async API first (needs no gesture in Chrome when the doc is focused)
  try {
    await navigator.clipboard.writeText(payload);
    ctx.toast?.({ kind: 'ok', title: 'Copied', message: `${payload.length} characters on the clipboard` });
    return { ok: true, summary: `Copied ${payload.length} characters to the clipboard.` };
  } catch { /* fall through */ }

  // Fallback: hidden textarea + execCommand. Must be synchronous-ish.
  try {
    const ta = document.createElement('textarea');
    ta.value = payload;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return { ok: true, summary: `Copied ${payload.length} characters to the clipboard (legacy path).` };
  } catch { /* fall through */ }

  ctx.showViewport?.({
    title: 'CLIPBOARD // MANUAL COPY',
    blocks: [
      { type: 'paragraph', text: 'The browser blocked programmatic clipboard writes. Select and copy manually:' },
      { type: 'code', text: payload },
    ],
  });
  return {
    ok: false,
    summary: 'Clipboard write was blocked by the browser. The text is displayed in the viewport for manual copying.',
  };
}

export async function share_content({ title, text, url }, ctx) {
  const data = { title: title || 'Q.U.A.R.K.', text: text || '', url: url || '' };
  if (navigator.share) {
    try {
      await navigator.share(data);
      return { ok: true, summary: 'Shared through the system share sheet.' };
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, summary: 'The user dismissed the share sheet.' };
      // fall through to clipboard
    }
  }
  const copied = await write_clipboard({ text: [data.title, data.text, data.url].filter(Boolean).join('\n') }, ctx);
  return {
    ok: copied.ok,
    summary: copied.ok
      ? 'The Web Share API is unavailable on this device, so the content was copied to the clipboard instead.'
      : copied.summary,
  };
}

const TEXT_EXT = /\.(txt|md|markdown|json|csv|tsv|js|mjs|cjs|jsx|ts|tsx|html|css|scss|xml|yml|yaml|log|py|java|c|cpp|h|sh|sql|ini|toml|svg)$/i;

export async function save_file({ filename, content, mime }, ctx) {
  const name = String(filename || 'quark-file.txt').replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  const text = String(content ?? '');

  // Preferred path: File System Access API (Chromium) — the user picks the folder
  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'Text file', accept: { [mime || 'text/plain']: [name.includes('.') ? '.' + name.split('.').pop() : '.txt'] } }],
      });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      ctx.toast?.({ kind: 'ok', title: 'File saved', message: name });
      return { ok: true, summary: `Saved "${name}" (${text.length} characters) to the location the user chose.`, data: { name, bytes: text.length } };
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, summary: 'The user cancelled the save dialog.' };
      // fall through to download
    }
  }

  // Universal fallback: blob download
  try {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return {
      ok: true,
      summary: `Triggered a browser download of "${name}" (${text.length} characters) to the user's Downloads folder.`,
      data: { name, bytes: text.length, via: 'download' },
    };
  } catch (e) {
    return { ok: false, summary: `Could not save the file: ${e.message}` };
  }
}

export async function open_file({ accept, purpose }, ctx) {
  if (purpose) ctx.setPendingPurpose?.(purpose);

  // Preferred: File System Access API
  if (window.showOpenFilePicker) {
    try {
      const types = accept
        ? [{ description: 'Files', accept: { 'text/plain': String(accept).split(',').map((s) => s.trim()).filter((s) => s.startsWith('.')) } }]
        : undefined;
      const [handle] = await window.showOpenFilePicker({ types, multiple: false, excludeAcceptAllOption: false });
      const file = await handle.getFile();
      return await readBack(file, ctx);
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, summary: 'The user cancelled the file picker.' };
      // fall through
    }
  }

  // Universal fallback: <input type=file>
  try {
    const file = await new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      if (accept) input.accept = accept;
      input.style.display = 'none';
      input.onchange = () => resolve(input.files?.[0] || null);
      // If the user closes the picker without choosing, `cancel` fires in modern browsers
      input.oncancel = () => resolve(null);
      document.body.appendChild(input);
      input.click();
      setTimeout(() => { document.body.removeChild(input); reject(new Error('timeout')); }, 300000);
    });
    if (!file) return { ok: false, summary: 'No file was selected.' };
    return await readBack(file, ctx);
  } catch (e) {
    return { ok: false, summary: `File picker failed: ${e.message}` };
  }
}

async function readBack(file, ctx) {
  const base = { name: file.name, sizeKB: +(file.size / 1024).toFixed(1), type: file.type || 'unknown' };
  const isText = file.type.startsWith('text/') || TEXT_EXT.test(file.name) || !file.type;
  if (!isText || file.size > 2_000_000) {
    return {
      ok: true,
      summary: `Read "${file.name}" (${base.sizeKB} KB, ${base.type}). It is binary or too large, so only metadata was returned.`,
      data: { ...base, binary: true },
    };
  }
  const text = await file.text();
  ctx.showViewport?.({
    title: 'FILE // ' + file.name.toUpperCase(),
    blocks: [
      { type: 'keyvalue', entries: [
        { k: 'Name', v: file.name }, { k: 'Size', v: `${base.sizeKB} KB` },
        { k: 'Type', v: base.type }, { k: 'Characters', v: String(text.length) },
      ] },
      { type: 'code', text: text.slice(0, 20000) },
    ],
  });
  return {
    ok: true,
    summary: `Read "${file.name}" (${text.length} characters):\n${text.slice(0, 6000)}`,
    data: { ...base, text: text.slice(0, 20000) },
  };
}

export async function export_transcript({ include_tool_trace }, ctx) {
  const rows = ctx.getTranscript?.() || [];
  const withTrace = include_tool_trace !== false;
  const lines = [
    `# Q.U.A.R.K. — Session Transcript`,
    ``,
    `- Exported: ${new Date().toLocaleString()}`,
    `- Entries: ${rows.filter((r) => r.role !== 'trace').length}`,
    ``,
    `---`,
    ``,
  ];
  for (const r of rows) {
    if (r.role === 'trace') {
      if (withTrace) lines.push(`> \`tool\` **${r.name}** — ${r.status}${r.detail ? ` · ${r.detail}` : ''}`);
      continue;
    }
    lines.push(`**${r.role === 'user' ? 'USER' : 'Q.U.A.R.K.'} ›** ${r.text}`);
    lines.push('');
  }
  return save_file({ filename: `quark-transcript-${Date.now()}.md`, content: lines.join('\n') }, ctx);
}
