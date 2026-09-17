/**
 * Q.U.A.R.K. — tool catalogue
 * ─────────────────────────────────────────────────────────────────────────
 * Two exports per tool:
 *
 *   TOOL_DECLARATIONS  → the Gemini `functionDeclarations` schema sent to the model
 *   TOOL_META          → runtime metadata (category, required browser capability,
 *                        whether it needs a user gesture, help text)
 *
 * Everything here executes IN THE BROWSER. That is a hard constraint, not a
 * design choice: a page served from Vercel has no access to the visitor's
 * filesystem, process list or installed applications. See DEPLOYMENT.md for
 * the full capability matrix and the native-companion escape hatch.
 */

const O = 'OBJECT';
const S = 'STRING';
const N = 'NUMBER';
const B = 'BOOLEAN';
const A = 'ARRAY';

export const TOOL_DECLARATIONS = [
  // ── WEB & NAVIGATION ──────────────────────────────────────────────────
  {
    name: 'open_website',
    description:
      'Open a well-known website by name (YouTube, Gmail, GitHub, Instagram, Amazon, IRCTC, Spotify, Wikipedia…). ' +
      'Use this whenever the user says "open X" / "launch X" / "X kholo". Resolves common aliases and typos.',
    parameters: {
      type: O,
      properties: {
        site_name: { type: S, description: 'Name of the site, e.g. "youtube", "gmail", "github".' },
      },
      required: ['site_name'],
    },
  },
  {
    name: 'open_url',
    description: 'Open an arbitrary URL in a new browser tab. Use when the user gives a link or you need a specific deep URL.',
    parameters: {
      type: O,
      properties: {
        url: { type: S, description: 'Absolute URL including https:// scheme.' },
        label: { type: S, description: 'Short human label for the launch card, e.g. "React docs".' },
      },
      required: ['url'],
    },
  },
  {
    name: 'web_search',
    description: 'Run a web search and open the results page in a new tab.',
    parameters: {
      type: O,
      properties: {
        query: { type: S, description: 'Search query.' },
        engine: {
          type: S,
          enum: ['google', 'bing', 'duckduckgo', 'yahoo', 'brave'],
          description: 'Search engine. Defaults to google.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'youtube_search',
    description: 'Search YouTube and open the results (or the top video) in a new tab.',
    parameters: {
      type: O,
      properties: {
        query: { type: S, description: 'What to search for on YouTube.' },
        play_first: { type: B, description: 'If true, open the first result directly instead of the search page.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'maps_directions',
    description: 'Open Google Maps with driving / walking / transit directions.',
    parameters: {
      type: O,
      properties: {
        destination: { type: S, description: 'Destination address or place name.' },
        origin: { type: S, description: 'Starting point. Omit to use the user’s current location.' },
        mode: { type: S, enum: ['driving', 'walking', 'bicycling', 'transit'], description: 'Travel mode.' },
      },
      required: ['destination'],
    },
  },
  {
    name: 'wikipedia_lookup',
    description:
      'Fetch a real Wikipedia summary for a topic. Returns the extract as text so you can answer from it. ' +
      'Prefer this over guessing for factual/biographical/historical questions when you are unsure.',
    parameters: {
      type: O,
      properties: {
        topic: { type: S, description: 'Article title or search term.' },
        sentences: { type: N, description: 'How many sentences of the extract to return. Default 4.' },
      },
      required: ['topic'],
    },
  },
  {
    name: 'stackoverflow_search',
    description:
      'Search Stack Overflow (no API key needed) for programming, CLI, library and how-to questions. ' +
      'Returns the top voted questions with links. Use this instead of wikipedia_lookup for anything technical.',
    parameters: {
      type: O,
      properties: {
        query: { type: S, description: 'Search terms, e.g. "linux command to find files containing text".' },
        results: { type: N, description: 'How many results to return (1-8). Default 3.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'send_email',
    description: 'Open the user’s mail client with a pre-filled draft (mailto:). Nothing is sent automatically.',
    parameters: {
      type: O,
      properties: {
        to: { type: S, description: 'Recipient email address.' },
        subject: { type: S, description: 'Email subject line.' },
        body: { type: S, description: 'Email body text.' },
      },
      required: ['to'],
    },
  },
  {
    name: 'add_calendar_event',
    description: 'Open a pre-filled Google Calendar "new event" page. The user confirms before anything is saved.',
    parameters: {
      type: O,
      properties: {
        title: { type: S, description: 'Event title.' },
        start: { type: S, description: 'Start, ISO 8601 local, e.g. 2026-09-20T14:30:00.' },
        end: { type: S, description: 'End, ISO 8601 local.' },
        location: { type: S, description: 'Optional location.' },
        details: { type: S, description: 'Optional description.' },
      },
      required: ['title', 'start'],
    },
  },

  // ── DEVICE & SENSORS ──────────────────────────────────────────────────
  {
    name: 'get_location',
    description: 'Get the device’s current GPS position. Requires location permission.',
    parameters: { type: O, properties: {} },
  },
  {
    name: 'get_weather',
    description:
      'Fetch live current weather + a 3-day forecast from Open-Meteo (no API key). ' +
      'If location is omitted it uses the device GPS, which requires location permission.',
    parameters: {
      type: O,
      properties: {
        location: { type: S, description: 'City or place name, e.g. "Kanpur". Omit for current GPS position.' },
        units: { type: S, enum: ['celsius', 'fahrenheit'], description: 'Temperature unit. Default celsius.' },
      },
    },
  },
  {
    name: 'get_device_status',
    description:
      'Read real device telemetry: battery level/charging, network type & effective speed, CPU cores, ' +
      'device memory, screen size & pixel ratio, platform, language, online status, timezone, viewport.',
    parameters: {
      type: O,
      properties: {
        aspects: {
          type: A,
          items: { type: S, enum: ['battery', 'network', 'hardware', 'display', 'browser', 'storage'] },
          description: 'Which aspects to report. Omit for all.',
        },
      },
    },
  },
  {
    name: 'show_notification',
    description: 'Send a desktop/OS notification. Requires notification permission.',
    parameters: {
      type: O,
      properties: {
        title: { type: S, description: 'Notification title.' },
        body: { type: S, description: 'Notification body.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'capture_photo',
    description:
      'Take a photo with the device camera and show it in the HUD viewport. Requires camera permission. ' +
      'Returns a data-URL reference the user can download.',
    parameters: {
      type: O,
      properties: {
        facing: { type: S, enum: ['user', 'environment'], description: 'Front or rear camera. Default user.' },
      },
    },
  },
  {
    name: 'capture_screen',
    description:
      'Grab a screenshot of a window/tab the user picks, and show it in the HUD viewport. ' +
      'Requires screen-capture permission; the browser shows its own source picker.',
    parameters: { type: O, properties: {} },
  },
  {
    name: 'record_audio',
    description: 'Record a short audio clip from the microphone and offer it for playback/download. Requires mic permission.',
    parameters: {
      type: O,
      properties: {
        duration_seconds: { type: N, description: 'Recording length in seconds. Max 60. Default 10.' },
      },
    },
  },

  // ── CLIPBOARD / SHARE / FILES ─────────────────────────────────────────
  {
    name: 'read_clipboard',
    description: 'Read the text currently on the user’s clipboard. Requires clipboard-read permission.',
    parameters: { type: O, properties: {} },
  },
  {
    name: 'write_clipboard',
    description: 'Copy text to the user’s clipboard.',
    parameters: {
      type: O,
      properties: { text: { type: S, description: 'Text to copy.' } },
      required: ['text'],
    },
  },
  {
    name: 'share_content',
    description: 'Hand content to the OS share sheet (WhatsApp, Mail, X…). Falls back to copying the link if unsupported.',
    parameters: {
      type: O,
      properties: {
        title: { type: S },
        text: { type: S },
        url: { type: S },
      },
    },
  },
  {
    name: 'save_file',
    description:
      'Write text content to a file on the user’s device. Uses the File System Access API where available, ' +
      'otherwise triggers a browser download. The user always chooses/confirms the location.',
    parameters: {
      type: O,
      properties: {
        filename: { type: S, description: 'Suggested filename, e.g. "notes.md".' },
        content: { type: S, description: 'Full text content of the file.' },
        mime: { type: S, description: 'MIME type. Default text/plain.' },
      },
      required: ['filename', 'content'],
    },
  },
  {
    name: 'open_file',
    description:
      'Let the user pick a file from their device and read its text content back to you. ' +
      'Only text-like files are read; binary files report name/size/type instead.',
    parameters: {
      type: O,
      properties: {
        accept: { type: S, description: 'Comma-separated extensions or MIME hint, e.g. ".txt,.md,.json".' },
        purpose: { type: S, description: 'One line explaining why the file is needed — shown to the user.' },
      },
    },
  },
  {
    name: 'export_transcript',
    description: 'Download the full Q.U.A.R.K. conversation transcript as a Markdown file.',
    parameters: {
      type: O,
      properties: { include_tool_trace: { type: B, description: 'Include executed tool calls. Default true.' } },
    },
  },

  // ── HUD CONTROL ───────────────────────────────────────────────────────
  {
    name: 'display_content',
    description:
      'Render structured content in the HUD viewport overlay. Use this for ANYTHING the user asks to "show", ' +
      '"display", "present", "make a table of", "write me a list/plan/report/code". Content is rendered through a ' +
      'typed allowlisted renderer — raw HTML is never injected.',
    parameters: {
      type: O,
      properties: {
        title: { type: S, description: 'Viewport title, e.g. "Study Plan — Semester 3".' },
        blocks: {
          type: A,
          description: 'Ordered content blocks.',
          items: {
            type: O,
            properties: {
              type: {
                type: S,
                enum: ['heading', 'paragraph', 'list', 'ordered_list', 'code', 'quote', 'table', 'keyvalue', 'link_row'],
                description: 'Block kind.',
              },
              text: { type: S, description: 'Text for heading/paragraph/quote/code.' },
              items: { type: A, items: { type: S }, description: 'Entries for list / ordered_list.' },
              columns: { type: A, items: { type: S }, description: 'Column headers for table.' },
              rows: { type: A, items: { type: A, items: { type: S } }, description: 'Table rows (arrays of strings).' },
              entries: { type: A, items: { type: O, properties: { k: { type: S }, v: { type: S } } }, description: 'Pairs for keyvalue.' },
              links: {
                type: A,
                items: { type: O, properties: { label: { type: S }, url: { type: S } } },
                description: 'Buttons for link_row.',
              },
              language: { type: S, description: 'Language hint for code blocks.' },
            },
            required: ['type'],
          },
        },
        confirm_text: { type: S, description: 'One-line summary spoken back to the user.' },
      },
      required: ['title', 'blocks'],
    },
  },
  {
    name: 'navigate_panel',
    description: 'Switch the HUD to an information panel.',
    parameters: {
      type: O,
      properties: {
        panel: { type: S, enum: ['overview', 'telemetry', 'protocols', 'about', 'capabilities'], description: 'Which panel to open.' },
      },
      required: ['panel'],
    },
  },
  {
    name: 'set_hud_accent',
    description: 'Re-colour the HUD accent lighting. Accepts a named colour or a hex value.',
    parameters: {
      type: O,
      properties: {
        color: {
          type: S,
          enum: ['cyan', 'magenta', 'violet', 'amber', 'green', 'red', 'ice', 'sunset'],
          description: 'Accent preset name.',
        },
        hex: { type: S, description: 'Optional explicit #rrggbb override.' },
      },
    },
  },
  {
    name: 'request_fullscreen',
    description: 'Enter or exit browser fullscreen for the HUD.',
    parameters: {
      type: O,
      properties: { enable: { type: B, description: 'true to enter fullscreen, false to exit.' } },
    },
  },
  {
    name: 'clear_terminal',
    description: 'Clear the SYSTEM_LOG transcript.',
    parameters: { type: O, properties: {} },
  },
  {
    name: 'list_capabilities',
    description:
      'Report exactly which tools/permissions work in THIS browser right now, and which are blocked. ' +
      'Call this whenever the user asks what Q.U.A.R.K. can do, or after a permission is denied.',
    parameters: { type: O, properties: {} },
  },

  // ── VOICE ─────────────────────────────────────────────────────────────
  {
    name: 'speak',
    description: 'Speak text aloud through the HUD voice, or stop current speech.',
    parameters: {
      type: O,
      properties: {
        text: { type: S, description: 'What to say. Omit or pass "" to stop speaking.' },
        rate: { type: N, description: 'Speech rate 0.5–2. Default 1.' },
        pitch: { type: N, description: 'Pitch 0–2. Default 0.85.' },
      },
    },
  },
  {
    name: 'set_voice_listening',
    description: 'Start or stop the microphone for continuous voice input.',
    parameters: {
      type: O,
      properties: { enable: { type: B, description: 'true to start listening, false to stop.' } },
      required: ['enable'],
    },
  },
  {
    name: 'set_voice_mode',
    description:
      'Choose how voice input is transcribed. "on-device" runs the Whisper model inside the browser: '
      + 'audio is never uploaded, no API key or quota is used, and it works with the network off '
      + '(after the one-time ~45 MB model download, which the browser caches). It also skips the '
      + 'browser built-in recogniser, which streams audio to a cloud service. '
      + '"auto" restores the default: built-in recogniser first, then on-device, then the server. '
      + 'Prefer "on-device" whenever the user mentions privacy, offline, no internet, no API, or not wanting audio sent anywhere.',
    parameters: {
      type: O,
      properties: {
        mode: {
          type: S,
          enum: ['on-device', 'auto'],
          description: '"on-device" = local Whisper only, nothing uploaded. "auto" = all three paths.',
        },
      },
      required: ['mode'],
    },
  },

  // ── UTILITY ───────────────────────────────────────────────────────────
  {
    name: 'calculate',
    description:
      'Evaluate a mathematical expression exactly. Supports + - * / % ^ ( ) and the functions ' +
      'sqrt, cbrt, abs, sin, cos, tan, asin, acos, atan, log, log10, ln, exp, min, max, round, floor, ceil, ' +
      'plus the constants pi and e. Prefer this over mental arithmetic for anything non-trivial.',
    parameters: {
      type: O,
      properties: { expression: { type: S, description: 'e.g. "(45*12) + sqrt(144) ^ 2".' } },
      required: ['expression'],
    },
  },
  {
    name: 'get_datetime',
    description: 'Get the current date and/or time, optionally in another IANA timezone.',
    parameters: {
      type: O,
      properties: {
        timezone: { type: S, description: 'IANA timezone, e.g. "Asia/Kolkata". Default: device timezone.' },
        part: { type: S, enum: ['both', 'time', 'date'], description: 'What to return. Default both.' },
      },
    },
  },
  {
    name: 'set_timer',
    description: 'Start a countdown timer. Fires a notification + HUD toast when it elapses.',
    parameters: {
      type: O,
      properties: {
        duration_seconds: { type: N, description: 'Length in seconds. Max 86400.' },
        label: { type: S, description: 'What the timer is for, e.g. "tea".' },
      },
      required: ['duration_seconds'],
    },
  },
  {
    name: 'set_reminder',
    description:
      'Schedule a reminder at a specific future date/time. Persisted in localStorage, so it survives a reload ' +
      'as long as the tab/site storage is kept. Fires a notification when due.',
    parameters: {
      type: O,
      properties: {
        datetime: { type: S, description: 'ISO 8601 local datetime, e.g. 2026-09-17T09:00:00.' },
        message: { type: S, description: 'Reminder text.' },
      },
      required: ['datetime', 'message'],
    },
  },
  {
    name: 'cancel_timer',
    description: 'Cancel a running timer or pending reminder by id, or all of them.',
    parameters: {
      type: O,
      properties: {
        id: { type: S, description: 'Timer/reminder id. Pass "all" to clear everything.' },
      },
    },
  },
  {
    name: 'request_permission',
    description:
      'Explicitly ask the user for a browser capability, showing the HUD permission dialog first. ' +
      'Use when a previous action was denied, or when the user says "allow X" / "grant X".',
    parameters: {
      type: O,
      properties: {
        capability: {
          type: S,
          enum: [
            'geolocation', 'camera', 'microphone', 'notifications',
            'clipboard-read', 'clipboard-write', 'screen-capture',
            'file-system', 'fullscreen', 'wake-lock', 'share',
          ],
          description: 'Which capability to request.',
        },
        reason: { type: S, description: 'One sentence explaining why — shown verbatim to the user.' },
      },
      required: ['capability'],
    },
  },
];

/** Runtime metadata keyed by tool name. */
export const TOOL_META = {
  open_website:      { category: 'web',      capability: null,              gesture: true,  opensTab: true },
  open_url:          { category: 'web',      capability: null,              gesture: true,  opensTab: true },
  web_search:        { category: 'web',      capability: null,              gesture: true,  opensTab: true },
  youtube_search:    { category: 'web',      capability: null,              gesture: true,  opensTab: true },
  maps_directions:   { category: 'web',      capability: null,              gesture: true,  opensTab: true },
  wikipedia_lookup:  { category: 'web',      capability: null,              gesture: false, opensTab: false },
  stackoverflow_search:{ category: 'web',    capability: null,              gesture: false, opensTab: false },
  send_email:        { category: 'web',      capability: null,              gesture: true,  opensTab: true },
  add_calendar_event:{ category: 'web',      capability: null,              gesture: true,  opensTab: true },

  get_location:      { category: 'device',   capability: 'geolocation',     gesture: false, opensTab: false },
  get_weather:       { category: 'device',   capability: 'geolocation',     gesture: false, opensTab: false, conditionalCapability: true },
  get_device_status: { category: 'device',   capability: null,              gesture: false, opensTab: false },
  show_notification: { category: 'device',   capability: 'notifications',   gesture: false, opensTab: false },
  capture_photo:     { category: 'media',    capability: 'camera',          gesture: false, opensTab: false },
  capture_screen:    { category: 'media',    capability: 'screen-capture',  gesture: false, opensTab: false },
  record_audio:      { category: 'media',    capability: 'microphone',      gesture: false, opensTab: false },

  read_clipboard:    { category: 'io',       capability: 'clipboard-read',  gesture: false, opensTab: false },
  write_clipboard:   { category: 'io',       capability: 'clipboard-write', gesture: true,  opensTab: false },
  share_content:     { category: 'io',       capability: 'share',           gesture: true,  opensTab: false, conditionalCapability: true },
  save_file:         { category: 'io',       capability: 'file-system',     gesture: true,  opensTab: false, conditionalCapability: true },
  open_file:         { category: 'io',       capability: 'file-system',     gesture: true,  opensTab: false },
  export_transcript: { category: 'io',       capability: null,              gesture: true,  opensTab: false },

  display_content:   { category: 'hud',      capability: null,              gesture: false, opensTab: false },
  navigate_panel:    { category: 'hud',      capability: null,              gesture: false, opensTab: false },
  set_hud_accent:    { category: 'hud',      capability: null,              gesture: false, opensTab: false },
  request_fullscreen:{ category: 'hud',      capability: 'fullscreen',      gesture: true,  opensTab: false },
  clear_terminal:    { category: 'hud',      capability: null,              gesture: false, opensTab: false },
  list_capabilities: { category: 'hud',      capability: null,              gesture: false, opensTab: false },

  speak:             { category: 'voice',    capability: null,              gesture: false, opensTab: false },
  set_voice_listening:{ category: 'voice',   capability: 'microphone',      gesture: true,  opensTab: false },
  set_voice_mode:     { category: 'voice',   capability: null,              gesture: false, opensTab: false },

  calculate:         { category: 'utility',  capability: null,              gesture: false, opensTab: false },
  get_datetime:      { category: 'utility',  capability: null,              gesture: false, opensTab: false },
  set_timer:         { category: 'utility',  capability: null,              gesture: false, opensTab: false },
  set_reminder:      { category: 'utility',  capability: null,              gesture: false, opensTab: false },
  cancel_timer:      { category: 'utility',  capability: null,              gesture: false, opensTab: false },
  request_permission:{ category: 'utility',  capability: null,              gesture: true,  opensTab: false },
};

export const CATEGORY_LABELS = {
  web: 'Web & Navigation',
  device: 'Device & Sensors',
  media: 'Camera / Mic / Screen',
  io: 'Clipboard, Files & Share',
  hud: 'HUD Control',
  voice: 'Voice',
  utility: 'Utility',
};

export const TOOL_NAMES = TOOL_DECLARATIONS.map((t) => t.name);

export function toolMeta(name) {
  return TOOL_META[name] || { category: 'utility', capability: null, gesture: false, opensTab: false };
}
