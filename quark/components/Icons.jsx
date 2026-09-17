/** Shared inline SVG icons — no icon dependency, no external requests. */

const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' };

export const IconVolume = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M11 5 6 9H2v6h4l5 4V5z" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
  </svg>
);

export const IconMic = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
  </svg>
);

export const IconDots = (p) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p} style={{ opacity: 0.5, ...p.style }}>
    <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
  </svg>
);

export const IconBattery = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <rect x="2" y="7" width="16" height="10" rx="2" /><path d="M18 10v4" />
  </svg>
);

export const IconNetwork = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M2 20h20M4 20v-4M9 20v-8M14 20v-11M19 20v-15" />
  </svg>
);

export const IconUplink = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M4 8a8 8 0 0 1 16 0M7 11a5 5 0 0 1 10 0M12 14v7" />
  </svg>
);

export const IconEntangle = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M7 7l10 10-5 5V2l5 5L7 17" />
  </svg>
);

export const IconSun = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
  </svg>
);

export const IconPin = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z" /><circle cx="12" cy="10" r="2.5" />
  </svg>
);

export const IconShield = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" /><path d="M9 12l2 2 4-4" />
  </svg>
);

export const IconChip = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <rect x="7" y="7" width="10" height="10" rx="1" />
    <path d="M10 2v3M14 2v3M10 19v3M14 19v3M2 10h3M2 14h3M19 10h3M19 14h3" />
  </svg>
);

export const IconTimer = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <circle cx="12" cy="13" r="8" /><path d="M12 9v4l2.5 2M9 2h6" />
  </svg>
);

export const IconExternal = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);

export const IconTool = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}>
    <path d="M14.5 6.5a4 4 0 0 0 5 5L21 21l-9-3-3-9 5.5-2.5z" /><circle cx="16.5" cy="8.5" r="1" />
  </svg>
);

export const IconClose = (p) => (
  <svg viewBox="0 0 24 24" {...base} {...p}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
