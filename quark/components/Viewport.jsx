'use client';

import { useQuark } from '@/hooks/QuarkProvider';
import Modal from './Modal';
import ViewportBlock, { safeHref } from './ViewportBlock';

/**
 * The HUD viewport — where Q.U.A.R.K. *presents* things: generated reports,
 * tables, code, captured photos, screen grabs, audio recordings and launch
 * confirmations.
 */
export default function Viewport() {
  const { viewport, closeViewport, toast } = useQuark();
  if (!viewport.open) return null;

  const runAction = async (action) => {
    switch (action.kind) {
      case 'launch': {
        // This click IS a trusted user activation, so the popup cannot be blocked.
        const w = window.open(safeHref(action.url), '_blank');
        if (w) { try { w.opener = null; } catch {} closeViewport(); }
        else toast({ kind: 'err', title: 'Blocked', message: 'The browser still refused the popup. Check the address-bar icon.' });
        break;
      }
      case 'download': {
        const a = document.createElement('a');
        a.href = action.href;
        a.download = action.download || 'quark-file';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        toast({ kind: 'ok', title: 'Download started', message: action.download || 'file' });
        break;
      }
      case 'copy-image-note': {
        try {
          await navigator.clipboard.writeText('Captured with Q.U.A.R.K.');
          toast({ kind: 'ok', title: 'Copied', message: 'Note on the clipboard' });
        } catch {
          toast({ kind: 'warn', title: 'Clipboard', message: 'Write was blocked by the browser.' });
        }
        break;
      }
      default:
        break;
    }
  };

  return (
    <Modal open title={viewport.title || 'DISPLAY'} onClose={closeViewport} width={820}>
      <div className="vp-body">
        {(viewport.blocks || []).map((b, i) => <ViewportBlock key={i} block={b} />)}
      </div>

      {viewport.actions?.length ? (
        <div className="vp-actions">
          {viewport.actions.map((a, i) => (
            <button key={i} type="button" className="cap-btn" style={{ padding: '8px 16px' }} onClick={() => runAction(a)}>
              {a.label}
            </button>
          ))}
          <button type="button" className="cap-btn" style={{ padding: '8px 16px' }} onClick={closeViewport}>
            CLOSE
          </button>
        </div>
      ) : null}
    </Modal>
  );
}
