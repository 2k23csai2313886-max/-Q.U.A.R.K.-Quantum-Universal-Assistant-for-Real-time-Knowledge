# Q.U.A.R.K. on Vercel — how every feature actually works

> **Read this first.** It answers the two questions that decide whether this
> project works in a college demo: *where does the API key live?* and *how can
> a website open things on my computer?*

---

## 1. The one hard constraint

A page served from `quark.vercel.app` is **a website**. It runs inside the
browser's sandbox. It has no process, no shell, no filesystem access beyond
what the browser explicitly grants.

That is not a limitation of this project — it is the security model of the web,
and it is the reason banking, email and Google Docs can run in a browser at all.

So the honest split is:

| Q.U.A.R.K. **CAN** do | Q.U.A.R.K. **CANNOT** do |
|---|---|
| Open any URL in a new tab | Launch a native app (VS Code, Chrome, Notepad, Spotify desktop) |
| Search Google / YouTube / Maps | Read arbitrary files from your disk |
| Read GPS, battery, network, CPU, screen | List your installed programs |
| Capture camera, microphone, screen | Control the OS, volume, or other tabs |
| Read/write the clipboard | Run in the background after the tab closes |
| Save a file *you confirm*, read a file *you pick* | Access another website's data |
| Desktop notifications, timers, reminders | Make phone calls or send SMS itself |
| Fullscreen, wake-lock, native share sheet | Bypass a permission the browser denied |

**The important nuance:** *"open YouTube"* works perfectly — `window.open('https://youtube.com')`.
*"Open the YouTube desktop app"* does not, and no website ever will.
For almost every real request, opening the web version is what the user wants.

---

## 2. Request flow on Vercel

```
┌─────────────────────────── Visitor's browser ───────────────────────────┐
│                                                                         │
│   "open youtube and set a timer for 10 minutes"                         │
│         │                                                               │
│         ▼                                                               │
│   Next.js client (React 19)                                             │
│         │  POST /api/chat   ← same origin, NO key in this request       │
│         │  { contents: [...] }                                          │
└─────────┼───────────────────────────────────────────────────────────────┘
          │
          ▼
┌────────────────── Vercel serverless function (Node runtime) ────────────┐
│   app/api/chat/route.js                                                 │
│                                                                         │
│   • reads process.env.GEMINI_API_KEY   ← lives ONLY here                │
│   • checks Origin against QUARK_ALLOWED_ORIGINS                         │
│   • applies per-IP rate limit                                           │
│   • validates + trims the conversation                                  │
│   • attaches x-goog-api-key, forwards to Google                         │
│   • streams the answer back as SSE                                      │
└─────────┬───────────────────────────────────────────────────────────────┘
          │
          ▼
   generativelanguage.googleapis.com  (Gemini)
          │
          │  returns either text, or functionCall[]
          ▼
┌─────────────────────────── Back in the browser ─────────────────────────┐
│   For each functionCall:                                                │
│      1. TOOL_META says which capability it needs                        │
│      2. permission broker → HUD dialog ("you asked for X") → native     │
│         browser prompt                                                  │
│      3. the tool RUNS IN THE BROWSER (window.open, GPS, camera…)        │
│      4. result → functionResponse → POST /api/chat again                │
│   Loop max 6 rounds, then the final text is typed out and spoken.       │
└─────────────────────────────────────────────────────────────────────────┘
```

**Why the loop is client-driven:** the tools need *your* camera, *your* GPS,
*your* clipboard and *your* popup gesture. A server in `iad1` could never
execute them. The server is a dumb, authenticated pipe — and that is exactly
what keeps the key safe.

---

## 3. Where the key lives (and proof it never leaks)

| Location | Has the key? |
|---|---|
| `.env.local` (git-ignored) | ✅ yes — local dev only |
| Vercel → Settings → Environment Variables | ✅ yes — production |
| `process.env.GEMINI_API_KEY` in `app/api/chat/route.js` | ✅ yes — runtime only |
| Any file in `.next/static/**` (the JS your browser downloads) | ❌ **no** |
| Git history | ❌ **no** |

Next.js only inlines variables prefixed `NEXT_PUBLIC_` into the client bundle.
`GEMINI_API_KEY` has no prefix, so it is physically absent from browser code.

This was verified, not assumed. A sentinel key was placed in `.env.local`, the
app was rebuilt, and every client chunk was grepped:

```
$ grep -rl "AIzaSySECRET_SENTINEL_DO_NOT_LEAK_12345" .next/static/
(no matches)                                    ✅ not in any client chunk

$ grep -rl "x-goog-api-key" .next/static/
(no matches)                                    ✅ auth header is server-only
```

At runtime the browser was also checked:

```
✅ API key absent from DOM and inline scripts
✅ API key absent from every loaded JS chunk
```

Run it yourself: put a real key in `.env.local`, `npm run build`, then
`grep -r "your-key-prefix" .next/static/`.

---

## 4. Deploying to Vercel — step by step

### 4.1 Push to GitHub

```bash
cd quark
git init && git add -A && git commit -m "Q.U.A.R.K. v2 — Next.js rebuild"
git branch -M main
git remote add origin https://github.com/<you>/project-quark.git
git push -u origin main
```

`.gitignore` already excludes `.env*`. Verify before pushing:

```bash
git status --short | grep -i env      # should print nothing but .env.local.example
```

### 4.2 Import into Vercel

1. <https://vercel.com/new> → import the repo.
2. Framework preset: **Next.js** (auto-detected). Build command `npm run build`,
   output `.next` — both defaults, change nothing.
3. Node 20 or newer (the `engines` field already requires `>=20.9.0`).

### 4.3 Add the environment variable

Project → **Settings → Environment Variables**:

| Name | Value | Environments |
|---|---|---|
| `GEMINI_API_KEY` | your key from <https://aistudio.google.com/apikey> | Production, Preview, Development |
| `GEMINI_MODEL` | `gemini-2.5-flash` | all |
| `QUARK_ALLOWED_ORIGINS` | `https://your-app.vercel.app` | Production |
| `QUARK_RATE_LIMIT_PER_MIN` | `20` | all |
| `QUARK_MAX_OUTPUT_TOKENS` | `8192` *(optional — this is the default)* | all |
| `QUARK_THINKING_BUDGET` | `0` *(optional — this is the default)* | all |
| `LLM_PROVIDER` | `openai` for Groq-first, `gemini` for Gemini-first | all |
| `LLM_FALLBACK_PROVIDER` | the other one — optional but recommended | all |
| `OPENAI_API_KEY` | a free Groq key from <https://console.groq.com/keys> | all |
| `OPENAI_BASE_URL` | `https://api.groq.com/openai/v1` *(default)* | all |
| `OPENAI_MODEL` | `llama-3.3-70b-versatile` *(default — must support function calling)* | all |
| `QUARK_TOOL_BUDGET` | `14` *(optional — this is the default)* | all |

The last two matter if you switch to a **thinking model** (`gemini-2.5-pro`,
`gemini-3-*`). Those models spend part of `maxOutputTokens` on internal
reasoning, so a small budget can leave zero tokens for the actual answer and
the HUD would report an empty reply. The defaults above (8192 output tokens,
reasoning switched off) avoid that; the proxy also strips `{"thought":true}`
parts from the answer text and retries once without `thinkingConfig` if Google
rejects it for your chosen model.

The `LLM_*` / `OPENAI_*` block is the quota insurance policy: when the primary
answers 429 (Gemini's free tier is roughly 20 requests/min, Groq's is 30), the
same request is retried against the fallback automatically and the user sees an
answer, not an error. Any OpenAI-compatible host works there — Groq, OpenRouter,
Cerebras, Mistral, or a 4 GB model you host yourself with Ollama/llama.cpp.

`QUARK_TOOL_BUDGET` matters specifically on free tiers, which cap **tokens per
minute** as well as requests per day. Declaring all 37 tools costs ~4,000 tokens
per round of the tool loop; the proxy declares only the subset the turn implies
(~600 for a typical question), which turns ~2 rounds/min into ~8 on Groq's 12K
TPM. **[LOCAL_LLM.md](LOCAL_LLM.md)** has the per-model limits, which Groq models
actually support function calling, and the free-hosting walkthrough.

Click **Deploy** (or redeploy — env changes do not apply to an existing build).

### 4.4 Verify

```bash
curl https://your-app.vercel.app/api/chat
# {"service":"quark-gemini-proxy","version":"2.1.0","configured":true,
#  "provider":"gemini","fallbackProvider":"openai",...}

curl https://your-app.vercel.app/api/transcribe
# {"service":"quark-transcribe","version":"1.0.0","configured":true,...}
```

The `diagnostics` object in that response is the fastest way to debug a
"the key is attached but it does not work" report: it tells you whether each key
is present, its length, whether it carries a stray newline from copy-paste, and
lists the exact misconfiguration in one sentence — never the key itself.

`version` is the fingerprint of the deployed build. If a fix does not seem to
have landed, check this first — Vercel keeps serving the previous build until a
new one finishes, and **environment variable changes need a redeploy**.

`"configured": true` means a key reached the function, and `provider` /
`fallbackProvider` show the resolved topology — check these after any env
change. In the HUD, the terminal badge should read **LIVE**.

---

### 4.5 The self-hosted speech model (~41 MB)

`public/models/onnx-community/whisper-tiny.en/` holds the quantised Whisper
weights (encoder 10 MB + decoder 31 MB) and tokenizer config. They are served as
ordinary static files, so on-device speech needs no third party — not even on
first use. If a Vercel deployment ever rejects the slug for size, delete that
directory: the loader detects the absence and falls back to the Hugging Face CDN
automatically, and the browser then caches the weights after first load.

## 5. HTTPS is not optional

Camera, microphone, geolocation, clipboard-read and screen capture are
**disabled by the browser on insecure origins**. Vercel gives you HTTPS
automatically, so production is fine. Locally, `http://localhost:3000` is
treated as secure too.

What will *not* work: opening the dev server over `http://192.168.x.x:3000`
from your phone. Those APIs silently vanish. Use the Vercel URL, or an
`ngrok`/`cloudflared` tunnel.

`lib/permissions.js` detects this and reports `unavailable` rather than
pretending the capability exists.

---

## 6. How each permission actually behaves

The broker in `lib/permissions.js` runs five steps for every gated tool:

```
detect  →  query  →  explain  →  trigger  →  report
```

1. **detect** — is the API present? (`'geolocation' in navigator`)
2. **query** — has the user already answered? (`navigator.permissions.query`)
   If `granted`, skip straight to the action — never nag twice.
3. **explain** — show the HUD dialog naming the capability, the reason, and
   **the user's own words** that caused it.
4. **trigger** — only now does the native browser prompt appear.
5. **report** — a structured result goes back to the model, so it can say
   *"Location is blocked — click the lock icon in the address bar"* instead of
   failing silently.

| Capability | Native API | Prompt style | Browsers |
|---|---|---|---|
| Location | `navigator.geolocation` | banner | all |
| Camera | `getUserMedia({video})` | banner | all (HTTPS) |
| Microphone | `getUserMedia({audio})` / SpeechRecognition | banner | all (HTTPS) |
| Notifications | `Notification.requestPermission()` | banner | all |
| Clipboard read | `navigator.clipboard.readText()` | banner | Chromium, Firefox |
| Screen capture | `getDisplayMedia()` | **OS source picker** | Chromium, Firefox |
| File save | `showSaveFilePicker()` | **native save dialog** | Chromium only → falls back to a download |
| File open | `showOpenFilePicker()` | **native file picker** | Chromium only → falls back to `<input type=file>` |
| Fullscreen | `requestFullscreen()` | none — needs a user gesture | all |
| Wake lock | `navigator.wakeLock` | none | Chromium |
| Share | `navigator.share()` | OS share sheet | mobile, some desktop |

Every "Chromium only" row has a working fallback. Nothing hard-fails.

---

## 7. The popup-blocking problem (and its fix)

Browsers only allow `window.open()` during a **trusted user activation**.
A model reply arrives seconds after the click, so activation has expired and
the popup is blocked — silently, in every browser.

`lib/actions/web.js` handles it:

```js
const win = window.open(url, '_blank');
if (win) { win.opener = null; return { opened: true }; }
ctx.showLaunchCard({ url, label });      // fallback
return { opened: false, blocked: true };
```

When blocked, the HUD shows a **launch card** with a real link. Clicking it *is*
a trusted activation, so it always works. The model is told which path happened,
so it says *"tap the card on screen"* rather than falsely claiming the tab opened.

Verified in a real browser: `✅ "open youtube" opened a tab OR showed a launch card`.

---

## 8. What happens when the key is missing, the quota runs out, or the network dies

Nothing breaks, and the degradation is graded rather than binary:

1. **A second provider is configured** → the request is retried there
   automatically on 429/5xx. The HUD shows one calm toast; no raw upstream error.
2. **The question is answerable locally** → it never reaches a provider at all.
   `lib/engine.js` scores the intent and, at confidence ≥ 0.85, answers in the
   browser: zero network, zero quota.
3. **Neither** → the badge flips **LIVE → LOCAL CORE** and the engine still emits
   **real tool calls**:

```
"date" / "time now"                → get_datetime    (bare one-word queries work)
"open youtube"                     → open_website
"search react hooks"               → web_search
"calculate (45*12) + sqrt(144)^2"  → 684
"set a timer for 10 minutes"       → set_timer(600)
"where am I"                       → get_location    (permission dialog still runs)
"weather in Kanpur"                → get_weather     (Open-Meteo, keyless)
"take a photo"                     → capture_photo
"what is lion"                     → wikipedia_lookup (keyless, real article text)
"linux command for search"         → stackoverflow_search (keyless, real answers)
"who is the team leader"           → answered from the local roster
```

Only genuinely open-ended questions degrade, and the reply says so explicitly
instead of returning a blank bubble or guessing with a speculative search.

**Voice keeps working with no key at all.** Speech-to-text runs on-device:
`whisper-tiny.en` (≈45 MB) is loaded once into the browser via Transformers.js
and executed on WebGPU when a real adapter is available, otherwise WASM. The
audio is never uploaded and no quota is spent. `/api/transcribe` (which does use
the Gemini key) is now the *third* fallback, not the second.

That makes the demo **safe to present on bad college Wi-Fi**.

### If a live reply comes back empty

With a real key, a thinking model (`gemini-2.5-pro`, `gemini-3-*`) can spend the
entire output budget on internal reasoning and return no answer text at all. The
proxy defends against this three ways: `maxOutputTokens` defaults to **8192**,
reasoning is switched off by default (`thinkingBudget: 0`, or `thinkingLevel:
LOW` on gemini-3), and `{"thought":true}` parts are stripped from the answer. If
it ever does happen you get an explicit message naming the finish reason and the
env var to raise — not a silent blank line.

---

## 9. Cost

Default model `gemini-2.5-flash` has a free tier. Rough numbers per turn
(system prompt ≈ 1.1k tokens + 35 tool schemas ≈ 2.5k tokens):

| | Tokens | Cost |
|---|---|---|
| Simple chat turn | ~4k in / 60 out | ≈ $0.0014 |
| One tool call (2 round-trips) | ~8k in / 150 out | ≈ $0.0029 |

A full live demo of 30 commands ≈ **$0.09**. The free tier comfortably covers
it. Switch `GEMINI_MODEL` to `gemini-3.5-flash-lite` to cut that ~5×.

Set `QUARK_RATE_LIMIT_PER_MIN` and `QUARK_ALLOWED_ORIGINS` so nobody else can
drive your key from their own page.

> The in-memory rate limiter is per-instance. Vercel runs many instances, so it
> is a quota seatbelt, not a hard guarantee. For a real one use Upstash Redis.

---

## 10. If you genuinely need desktop control

Ship a **companion app** and keep this exact tool protocol:

- **Tauri** (Rust, ~4 MB binary) or **Electron** — register the same 35 tool
  names, but implement them with native APIs: `tauri-plugin-shell` to launch
  apps, `std::fs` for files, `enigo` for input.
- The React UI, the system prompt, the Gemini schemas and the permission broker
  all stay identical. Only the executor swaps.
- Distribute it signed, and have the website detect it via a localhost
  WebSocket handshake.

That is a genuine final-year extension, and `list_capabilities` already gives
you the UI to show what each mode supports.

---

## 11. Production hardening checklist

- [ ] `QUARK_ALLOWED_ORIGINS` set to your exact Vercel domain
- [ ] `QUARK_RATE_LIMIT_PER_MIN` set (default 20)
- [ ] Gemini key restricted in Google Cloud Console → **Application restrictions:
      None needed** (it is server-side), but set **API restrictions** to
      *Generative Language API* only
- [ ] Set a **budget alert** in Google Cloud Billing
- [ ] Vercel → Settings → **Deployment Protection** on for the preview URL
- [ ] Consider Upstash Redis for a real distributed rate limit
- [ ] Add `@vercel/analytics` if you want demo traffic stats

CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` and a
`Permissions-Policy` are already set in `next.config.mjs`.
