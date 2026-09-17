'use client';

/**
 * Typed, allowlisted content renderer.
 * ─────────────────────────────────────────────────────────────────────────
 * This is the security boundary for everything the model produces.
 *
 * There is NO dangerouslySetInnerHTML anywhere in this file — or in this
 * project. Each block type maps to explicit React elements, and all text is
 * inserted as React text nodes, which are escaped automatically. The only
 * attributes that ever come from model output are `href`/`src`, and those are
 * validated against a protocol allowlist before use.
 *
 * The original project concatenated raw model output into innerHTML, which is
 * a stored-XSS sink the moment an API key is added.
 */

const SAFE_URL = /^(https?:|mailto:|tel:|sms:|\/|#)/i;
const SAFE_MEDIA = /^(data:image\/(png|jpe?g|gif|webp);base64,|blob:|https?:)/i;
const SAFE_AUDIO = /^(blob:|data:audio\/|https?:)/i;

export function safeHref(u) {
  return typeof u === 'string' && SAFE_URL.test(u.trim()) ? u.trim() : '#';
}

export default function ViewportBlock({ block }) {
  if (!block || typeof block !== 'object') return null;

  switch (block.type) {
    case 'heading':
      return <h4 className="vp-h">{block.text}</h4>;

    case 'paragraph':
      return <p className="vp-p">{block.text}</p>;

    case 'quote':
      return <blockquote className="vp-quote">{block.text}</blockquote>;

    case 'list':
      return (
        <ul className="vp-ul">
          {(block.items || []).map((it, i) => <li key={i}>{it}</li>)}
        </ul>
      );

    case 'ordered_list':
      return (
        <ol className="vp-ul">
          {(block.items || []).map((it, i) => <li key={i}>{it}</li>)}
        </ol>
      );

    case 'code':
      return (
        <figure style={{ margin: 0 }}>
          <pre className="vp-code">
            <code>{block.text}</code>
          </pre>
        </figure>
      );

    case 'table':
      return (
        <table className="vp-table">
          {block.columns?.length ? (
            <thead>
              <tr>{block.columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr>
            </thead>
          ) : null}
          <tbody>
            {(block.rows || []).map((r, i) => (
              <tr key={i}>
                {(Array.isArray(r) ? r : [r]).map((c, j) => <td key={j}>{String(c ?? '')}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      );

    case 'keyvalue':
      return (
        <div>
          {(block.entries || []).map((e, i) => (
            <div className="vp-kv" key={i}>
              <span className="k">{e.k}</span>
              <span className="v">{e.v}</span>
            </div>
          ))}
        </div>
      );

    case 'link_row':
      return (
        <div className="vp-block">
          {(block.links || []).map((l, i) => (
            <a
              key={i}
              className="vp-link"
              href={safeHref(l.url)}
              target="_blank"
              rel="noopener noreferrer nofollow"
            >
              {l.label} <span aria-hidden="true">↗</span>
            </a>
          ))}
        </div>
      );

    // Media blocks are only ever produced internally (camera / screen / recorder).
    case 'image':
      return SAFE_MEDIA.test(block.src || '')
        ? <img className="vp-img" src={block.src} alt={block.alt || 'Captured media'} />
        : null;

    case 'audio':
      return SAFE_AUDIO.test(block.src || '')
        ? <audio controls src={block.src} style={{ width: '100%', marginBottom: 12 }} />
        : null;

    case 'video':
      return SAFE_MEDIA.test(block.src || '')
        ? <video controls src={block.src} className="vp-img" />
        : null;

    default:
      return null;
  }
}
