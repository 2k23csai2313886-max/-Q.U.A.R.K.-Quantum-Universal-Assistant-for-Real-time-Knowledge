'use client';

import { useEffect, useRef } from 'react';
import { useQuark } from '@/hooks/QuarkProvider';
import { IconShield } from './Icons';

/**
 * Permission broker dialog.
 * ─────────────────────────────────────────────────────────────────────────
 * Browsers show their own terse permission prompt with no context. This dialog
 * runs FIRST and explains:
 *
 *   • WHAT capability is being requested
 *   • WHY  (the tool's own reason string)
 *   • WHAT THE USER ACTUALLY ASKED FOR — their verbatim words
 *
 * Only when they press ALLOW does the native browser prompt fire. Pressing
 * DENY short-circuits it entirely and the model is told permission was
 * refused, so it can respond conversationally instead of failing silently.
 */
export default function PermissionDialog() {
  const { permRequest, resolvePermission } = useQuark();
  const allowRef = useRef(null);

  useEffect(() => {
    if (permRequest) requestAnimationFrame(() => allowRef.current?.focus?.());
  }, [permRequest]);

  if (!permRequest) return null;

  return (
    <div className="perm-backdrop" role="presentation">
      <div
        className="perm-panel"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="perm-title"
        aria-describedby="perm-reason"
      >
        <div className="perm-scan" aria-hidden="true" />
        <div className="perm-body">
          <div className="perm-kicker">
            <span className="pdot" aria-hidden="true" />
            <IconShield width={12} height={12} />
            Permission required
          </div>

          <h2 className="perm-title" id="perm-title">
            Q.U.A.R.K. requests access
          </h2>
          <p className="perm-cap">{permRequest.label.toUpperCase()}</p>

          <p className="perm-reason" id="perm-reason">
            {permRequest.summary} Needed {permRequest.reason}.
          </p>

          <p className="perm-asked">
            You asked: <b>“{permRequest.askedFor}”</b>
          </p>

          <p className="perm-note">
            Pressing ALLOW opens your browser&rsquo;s own permission prompt — the browser, not this site,
            makes the final decision. Pressing DENY cancels the action and Q.U.A.R.K. will tell you what
            it could not do. You can change this later from the site-settings icon in the address bar,
            or from the CAPABILITIES panel.
          </p>

          <div className="perm-actions">
            <button type="button" className="perm-btn deny" onClick={() => resolvePermission(false)}>
              DENY
            </button>
            <button type="button" className="perm-btn allow" ref={allowRef} onClick={() => resolvePermission(true)}>
              ALLOW
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
