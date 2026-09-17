/**
 * Q.U.A.R.K. — permission broker (logic layer)
 * ─────────────────────────────────────────────────────────────────────────
 * A website on Vercel runs inside the browser sandbox. It can NEVER silently
 * reach the operating system. Every sensitive capability must be granted by
 * the user, through the browser's own prompt.
 *
 * This module adds a layer *in front of* those native prompts:
 *
 *   1. detect   → is the API even available in this browser?
 *   2. query    → has the user already answered? (navigator.permissions)
 *   3. explain  → show the HUD dialog: WHAT is being requested and WHY,
 *                 quoting the user's own words back at them
 *   4. trigger  → fire the native browser prompt
 *   5. report   → structured result the model can reason about
 *
 * That way Q.U.A.R.K. never surprises the user with a bare OS dialog.
 */

export const PERM_STATE = {
  GRANTED: 'granted',
  DENIED: 'denied',
  PROMPT: 'prompt',
  UNSUPPORTED: 'unsupported',
  UNAVAILABLE: 'unavailable',
};

const hasNav = () => typeof navigator !== 'undefined';
const isSecure = () =>
  typeof window !== 'undefined' &&
  (window.isSecureContext ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1');

/** Async wrapper around navigator.permissions.query that never throws. */
export async function queryPermission(name) {
  if (!hasNav() || !navigator.permissions?.query) return null;
  try {
    const status = await navigator.permissions.query({ name });
    return status.state; // 'granted' | 'denied' | 'prompt'
  } catch {
    return null; // Firefox/Safari reject many names — that's fine
  }
}

/**
 * Capability registry. `probe()` reports the CURRENT state without prompting.
 * `request()` performs the action that causes the native prompt to appear.
 */
export const CAPABILITIES = {
  geolocation: {
    label: 'Location',
    permissionName: 'geolocation',
    summary: 'Read this device’s approximate geographic position.',
    probe: () => (hasNav() && 'geolocation' in navigator ? null : PERM_STATE.UNSUPPORTED),
    async request() {
      return new Promise((resolve) => {
        if (!hasNav() || !navigator.geolocation) return resolve({ ok: false, state: PERM_STATE.UNSUPPORTED });
        navigator.geolocation.getCurrentPosition(
          (pos) =>
            resolve({
              ok: true,
              state: PERM_STATE.GRANTED,
              data: {
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                accuracyMeters: Math.round(pos.coords.accuracy ?? 0),
                altitude: pos.coords.altitude ?? null,
                speed: pos.coords.speed ?? null,
                timestamp: new Date(pos.timestamp).toISOString(),
              },
            }),
          (err) =>
            resolve({
              ok: false,
              state: err.code === err.PERMISSION_DENIED ? PERM_STATE.DENIED : PERM_STATE.UNAVAILABLE,
              error: err.message || 'Location unavailable',
              code: err.code,
            }),
          { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 },
        );
      });
    },
  },

  camera: {
    label: 'Camera',
    permissionName: 'camera',
    summary: 'Capture a still image or video from this device’s camera.',
    probe: async () => {
      if (!hasNav() || !navigator.mediaDevices?.getUserMedia) return PERM_STATE.UNSUPPORTED;
      if (!isSecure()) return PERM_STATE.UNAVAILABLE; // non-HTTPS → API disabled
      return null;
    },
    async request() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
        return { ok: true, state: PERM_STATE.GRANTED, data: { stream } };
      } catch (e) {
        return {
          ok: false,
          state: e?.name === 'NotAllowedError' ? PERM_STATE.DENIED : PERM_STATE.UNAVAILABLE,
          error: e?.message || String(e),
        };
      }
    },
  },

  microphone: {
    label: 'Microphone',
    permissionName: 'microphone',
    summary: 'Listen to your voice so you can speak commands instead of typing.',
    probe: () => {
      const SR = hasNav() && (window.SpeechRecognition || window.webkitSpeechRecognition);
      const gum = hasNav() && navigator.mediaDevices?.getUserMedia;
      if (!SR && !gum) return PERM_STATE.UNSUPPORTED;
      if (!isSecure()) return PERM_STATE.UNAVAILABLE;
      return null;
    },
    async request() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        return { ok: true, state: PERM_STATE.GRANTED };
      } catch (e) {
        return {
          ok: false,
          state: e?.name === 'NotAllowedError' ? PERM_STATE.DENIED : PERM_STATE.UNAVAILABLE,
          error: e?.message || String(e),
        };
      }
    },
  },

  notifications: {
    label: 'Notifications',
    permissionName: 'notifications',
    summary: 'Show desktop alerts — used for timers, reminders and completed actions.',
    probe: () => {
      if (!hasNav() || typeof Notification === 'undefined') return PERM_STATE.UNSUPPORTED;
      return Notification.permission === 'granted'
        ? PERM_STATE.GRANTED
        : Notification.permission === 'denied'
          ? PERM_STATE.DENIED
          : null;
    },
    async request() {
      if (typeof Notification === 'undefined') return { ok: false, state: PERM_STATE.UNSUPPORTED };
      try {
        const result = await Notification.requestPermission();
        return { ok: result === 'granted', state: result };
      } catch {
        // Legacy callback-style browsers
        return new Promise((resolve) => {
          Notification.requestPermission((r) => resolve({ ok: r === 'granted', state: r }));
        });
      }
    },
  },

  'clipboard-read': {
    label: 'Clipboard (read)',
    permissionName: 'clipboard-read',
    summary: 'Read text currently on your clipboard.',
    probe: () => (hasNav() && navigator.clipboard?.readText ? null : PERM_STATE.UNSUPPORTED),
    async request() {
      try {
        const text = await navigator.clipboard.readText();
        return { ok: true, state: PERM_STATE.GRANTED, data: { text } };
      } catch (e) {
        return {
          ok: false,
          state: e?.name === 'NotAllowedError' ? PERM_STATE.DENIED : PERM_STATE.UNAVAILABLE,
          error: e?.message || String(e),
        };
      }
    },
  },

  'clipboard-write': {
    label: 'Clipboard (write)',
    permissionName: 'clipboard-write',
    summary: 'Copy text to your clipboard.',
    probe: () => (hasNav() && navigator.clipboard?.writeText ? null : PERM_STATE.UNSUPPORTED),
    async request() {
      try {
        await navigator.clipboard.writeText('');
        return { ok: true, state: PERM_STATE.GRANTED };
      } catch {
        // writeText generally needs no prompt; a rejection here is a gesture issue
        return { ok: true, state: PERM_STATE.GRANTED, note: 'Write requires a user gesture at call time.' };
      }
    },
  },

  'screen-capture': {
    label: 'Screen capture',
    permissionName: 'display-capture',
    summary: 'Record or screenshot a window/tab you choose. The browser shows its own picker.',
    probe: () => (hasNav() && navigator.mediaDevices?.getDisplayMedia ? null : PERM_STATE.UNSUPPORTED),
    async request() {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        return { ok: true, state: PERM_STATE.GRANTED, data: { stream } };
      } catch (e) {
        return {
          ok: false,
          state: e?.name === 'NotAllowedError' ? PERM_STATE.DENIED : PERM_STATE.UNAVAILABLE,
          error: e?.message || String(e),
        };
      }
    },
  },

  'file-system': {
    label: 'File access',
    permissionName: undefined, // no Permissions API name — the picker IS the prompt
    summary: 'Read or write a file you explicitly choose. Chromium only.',
    probe: () =>
      hasNav() && (window.showOpenFilePicker || window.showSaveFilePicker) ? null : PERM_STATE.UNSUPPORTED,
    async request() {
      return { ok: true, state: PERM_STATE.GRANTED, note: 'Picker is shown per-operation.' };
    },
  },

  fullscreen: {
    label: 'Fullscreen',
    summary: 'Expand the HUD to fill the screen.',
    probe: () => (typeof document !== 'undefined' && document.documentElement.requestFullscreen ? null : PERM_STATE.UNSUPPORTED),
    async request() {
      try {
        await document.documentElement.requestFullscreen();
        return { ok: true, state: PERM_STATE.GRANTED };
      } catch (e) {
        return { ok: false, state: PERM_STATE.UNAVAILABLE, error: e?.message || String(e) };
      }
    },
  },

  'wake-lock': {
    label: 'Keep screen awake',
    permissionName: 'screen-wake-lock',
    summary: 'Prevent the display from sleeping while Q.U.A.R.K. is active.',
    probe: () => (hasNav() && 'wakeLock' in navigator ? null : PERM_STATE.UNSUPPORTED),
    async request() {
      try {
        const lock = await navigator.wakeLock.request('screen');
        return { ok: true, state: PERM_STATE.GRANTED, data: { lock } };
      } catch (e) {
        return { ok: false, state: PERM_STATE.DENIED, error: e?.message || String(e) };
      }
    },
  },

  share: {
    label: 'Native share',
    summary: 'Hand content to the OS share sheet (mobile / supported desktop).',
    probe: () => (hasNav() && navigator.share ? null : PERM_STATE.UNSUPPORTED),
    async request() {
      return { ok: true, state: PERM_STATE.GRANTED };
    },
  },
};

/** Snapshot of every capability's current state — powers the Capability Matrix panel. */
export async function auditCapabilities() {
  const out = [];
  for (const [id, cap] of Object.entries(CAPABILITIES)) {
    let state;
    const probed = typeof cap.probe === 'function' ? await cap.probe() : null;
    if (probed) {
      state = probed;
    } else {
      const queried = cap.permissionName ? await queryPermission(cap.permissionName) : null;
      state = queried || PERM_STATE.PROMPT;
    }
    out.push({
      id,
      label: cap.label,
      summary: cap.summary,
      state,
      canRequest: state !== PERM_STATE.UNSUPPORTED && state !== PERM_STATE.UNAVAILABLE,
    });
  }
  return out;
}

/** Human-readable remediation hint when a permission was previously denied. */
export function denialHelp(id) {
  const label = CAPABILITIES[id]?.label ?? id;
  return (
    `${label} access was blocked earlier. Click the lock/site-settings icon at the ` +
    `left of the address bar, find "${label}", set it to Allow, then reload this tab.`
  );
}
