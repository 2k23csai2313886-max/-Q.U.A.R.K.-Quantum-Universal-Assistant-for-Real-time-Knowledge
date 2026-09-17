/**
 * Q.U.A.R.K. — shared constants
 * ─────────────────────────────────────────────────────────────
 * Nothing in here is secret. The Gemini key lives ONLY in
 * app/api/chat/route.js (server runtime) and is never imported here.
 */

export const APP = {
  name: 'Q.U.A.R.K.',
  expanded: 'Quantum Universal Assistant for Real-time Knowledge',
  version: '2.0.0',
  teamId: '27_CSAI_4B_06',
  institute: 'Pranveer Singh Institute of Technology',
  department: 'Artificial Intelligence & Data Science',
  session: '2026–27',
  domain: 'AI/ML · Natural Language Processing · Agentic Tool Use',
};

export const TEAM = [
  { name: 'Gyanvikas Singh', roll: '2301641520076', role: 'Team Leader' },
  { name: 'Rupendra Singh Sengar', roll: '2301641520151', role: 'Member' },
  { name: 'Manas Mani Ojha', roll: '2301641520110', role: 'Member' },
  { name: 'Mukul Upamanyu Dwivedi', roll: '2301641520120', role: 'Member' },
  { name: 'Aryan Shukla', roll: '2301641520048', role: 'Member' },
];

/** Activity-monitor states. Driven by REAL events now, not a random timer. */
export const STATES = {
  STANDBY: 'STANDBY',
  LISTENING: 'LISTENING',
  ENTANGLED: 'ENTANGLED',
  PROCESSING: 'PROCESSING',
  RECEIVED: 'COMMAND RECEIVED',
  ACTION: 'EXECUTING',
  DENIED: 'PERMISSION DENIED',
};

export const STATE_CLASS = {
  STANDBY: 'standby',
  LISTENING: 'listening',
  ENTANGLED: 'entangled',
  PROCESSING: 'processing',
  'COMMAND RECEIVED': 'received',
  EXECUTING: 'action',
  'PERMISSION DENIED': 'denied',
};

export const PANELS = ['overview', 'telemetry', 'protocols', 'about', 'capabilities'];

export const PANEL_TITLES = {
  telemetry: 'TELEMETRY',
  protocols: 'PROTOCOLS',
  about: 'ABOUT Q.U.A.R.K.',
  capabilities: 'CAPABILITY MATRIX',
};

export const JOKES = [
  "Why did the qubit break up with the bit? It wanted more possibilities.",
  "I would tell you a joke about UDP, but you might not get it.",
  "Schrödinger's inbox: simultaneously full and empty until observed.",
  "I'd make a joke about entanglement, but it depends on your state of mind.",
  "A neutrino walks into a bar. The bartender says: we don't serve your kind. It had already left.",
  "There are 10 types of people: those who understand binary, and those who don't.",
];

/**
 * Known-site registry for the `open_website` tool.
 * Matching is fuzzy + alias driven, so "open youtube", "launch yt",
 * "take me to you tube" and "youtube kholo" all resolve.
 */
export const KNOWN_SITES = [
  { name: 'YouTube', url: 'https://www.youtube.com', aliases: ['youtube', 'yt', 'you tube', 'utube', 'video'] },
  { name: 'YouTube Music', url: 'https://music.youtube.com', aliases: ['youtube music', 'yt music'] },
  { name: 'Google', url: 'https://www.google.com', aliases: ['google', 'ggl'] },
  { name: 'Gmail', url: 'https://mail.google.com', aliases: ['gmail', 'mail', 'email'] },
  { name: 'Google Drive', url: 'https://drive.google.com', aliases: ['drive', 'google drive'] },
  { name: 'Google Maps', url: 'https://maps.google.com', aliases: ['maps', 'google maps', 'map'] },
  { name: 'Google Translate', url: 'https://translate.google.com', aliases: ['translate', 'translator'] },
  { name: 'Google Classroom', url: 'https://classroom.google.com', aliases: ['classroom'] },
  { name: 'Google Calendar', url: 'https://calendar.google.com', aliases: ['calendar'] },
  { name: 'GitHub', url: 'https://github.com', aliases: ['github', 'git hub', 'gh'] },
  { name: 'Wikipedia', url: 'https://www.wikipedia.org', aliases: ['wikipedia', 'wiki'] },
  { name: 'ChatGPT', url: 'https://chat.openai.com', aliases: ['chatgpt', 'chat gpt'] },
  { name: 'Claude', url: 'https://claude.ai', aliases: ['claude'] },
  { name: 'Gemini', url: 'https://gemini.google.com', aliases: ['gemini', 'bard'] },
  { name: 'Stack Overflow', url: 'https://stackoverflow.com', aliases: ['stackoverflow', 'stack overflow'] },
  { name: 'MDN', url: 'https://developer.mozilla.org', aliases: ['mdn', 'mozilla'] },
  { name: 'LeetCode', url: 'https://leetcode.com', aliases: ['leetcode', 'leet code'] },
  { name: 'Codeforces', url: 'https://codeforces.com', aliases: ['codeforces'] },
  { name: 'HackerRank', url: 'https://hackerrank.com', aliases: ['hackerrank'] },
  { name: 'LinkedIn', url: 'https://www.linkedin.com', aliases: ['linkedin', 'linked in'] },
  { name: 'X / Twitter', url: 'https://x.com', aliases: ['twitter', 'x', 'tweet'] },
  { name: 'Instagram', url: 'https://www.instagram.com', aliases: ['instagram', 'insta', 'ig'] },
  { name: 'Facebook', url: 'https://www.facebook.com', aliases: ['facebook', 'fb'] },
  { name: 'WhatsApp Web', url: 'https://web.whatsapp.com', aliases: ['whatsapp', 'whats app', 'wa'] },
  { name: 'Telegram Web', url: 'https://web.telegram.org', aliases: ['telegram', 'tg'] },
  { name: 'Discord', url: 'https://discord.com/app', aliases: ['discord'] },
  { name: 'Reddit', url: 'https://www.reddit.com', aliases: ['reddit'] },
  { name: 'Spotify', url: 'https://open.spotify.com', aliases: ['spotify'] },
  { name: 'Netflix', url: 'https://www.netflix.com', aliases: ['netflix'] },
  { name: 'Prime Video', url: 'https://www.primevideo.com', aliases: ['prime video', 'prime', 'amazon prime'] },
  { name: 'Amazon', url: 'https://www.amazon.in', aliases: ['amazon'] },
  { name: 'Flipkart', url: 'https://www.flipkart.com', aliases: ['flipkart'] },
  { name: 'Myntra', url: 'https://www.myntra.com', aliases: ['myntra'] },
  { name: 'Swiggy', url: 'https://www.swiggy.com', aliases: ['swiggy'] },
  { name: 'Zomato', url: 'https://www.zomato.com', aliases: ['zomato'] },
  { name: 'IRCTC', url: 'https://www.irctc.co.in', aliases: ['irctc', 'railway', 'train'] },
  { name: 'Canva', url: 'https://www.canva.com', aliases: ['canva'] },
  { name: 'Figma', url: 'https://www.figma.com', aliases: ['figma'] },
  { name: 'Notion', url: 'https://www.notion.so', aliases: ['notion'] },
  { name: 'Vercel', url: 'https://vercel.com/dashboard', aliases: ['vercel'] },
  { name: 'Google AI Studio', url: 'https://aistudio.google.com', aliases: ['ai studio', 'aistudio'] },
  { name: 'Kaggle', url: 'https://www.kaggle.com', aliases: ['kaggle'] },
  { name: 'Coursera', url: 'https://www.coursera.org', aliases: ['coursera'] },
  { name: 'NPTEL', url: 'https://nptel.ac.in', aliases: ['nptel'] },
  { name: 'News — Google News', url: 'https://news.google.com', aliases: ['news', 'google news'] },
];

export const SEARCH_ENGINES = {
  google: 'https://www.google.com/search?q=',
  bing: 'https://www.bing.com/search?q=',
  duckduckgo: 'https://duckduckgo.com/?q=',
  yahoo: 'https://search.yahoo.com/search?p=',
  brave: 'https://search.brave.com/search?q=',
};

/** Protocol-handler actions. These are the ONLY ways a website can hand off
 *  to a native application — the OS decides what opens. */
export const PROTOCOL_ACTIONS = {
  mail: 'mailto:',
  sms: 'sms:',
  tel: 'tel:',
  maps: 'https://maps.google.com/?q=',
  calendar: 'https://calendar.google.com/calendar/render?action=TEMPLATE',
};
