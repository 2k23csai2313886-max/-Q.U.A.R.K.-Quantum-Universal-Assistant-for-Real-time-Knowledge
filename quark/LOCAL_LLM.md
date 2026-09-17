# Running Q.U.A.R.K. without depending on Gemini

You asked for a small (~4 GB) LLM you can host for free so the assistant is not
tied to one vendor's quota. This file gives three ways to do that, cheapest and
fastest first, with the exact environment variables for each.

**No code changes are needed for any of them.** `app/api/chat/route.js` already
speaks two protocols and can fail over between them:

| Protocol | Env | Used for |
| --- | --- | --- |
| `gemini` | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_API_BASE` | Google AI Studio / Vertex |
| `openai` | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` | **anything OpenAI-compatible** — Groq, OpenRouter, Cerebras, Mistral, GitHub Models, Ollama, LM Studio, llama.cpp, vLLM, your own server |

Selection and failover:

```
LLM_PROVIDER=gemini|openai            # primary (default: gemini)
LLM_FALLBACK_PROVIDER=openai|gemini   # used automatically on 429 / 5xx / timeout
```

The E2E suite `tests/e2e-providers.mjs` (15 checks) proves the failover works:
Gemini returns 429 → the request is retried against the fallback → the user
never sees a raw quota error.

---

## What actually needs an LLM

Worth understanding before you spend effort hosting one. Q.U.A.R.K. has three
independent brains, and only the third one needs a model:

| Layer | Runs on | Cost | Handles |
| --- | --- | --- | --- |
| Local reasoning engine (`lib/engine.js`) | Browser | Free, offline | Time, date, timers, maths, unit conversion, calculator, screen/clipboard/camera tools, greetings, capability questions, fuzzy intents, Hinglish and typos — 37 tools |
| On-device Whisper (`lib/local-stt.js`) | Browser (WASM/WebGPU) | Free, offline | **All** speech-to-text. 45 MB model, no upload, no key |
| Language model | Server → API or your host | Quota | Open-ended questions, explanations, multi-step tool plans |

So the model is only reached for genuinely open questions. That is why a 3–4 B
parameter model is a realistic fallback rather than a compromise — and why the
free tiers below are usually enough.

---

## Option A — free hosted API (5 minutes, no server)

The pragmatic answer: keep Gemini as primary and add a second free provider as
the automatic fallback. When Gemini's quota is gone, requests silently continue
on the other one.

### Groq (recommended — fastest, most generous, no card)

Get a key at <https://console.groq.com/keys>.

Q.U.A.R.K. is an **agent**, so the model must support local function calling.
That rules out two models that otherwise look like the best deal. Free-tier
limits, verified against Groq's own docs (Sept 2026):

| Model | Tools | Parallel tools | RPM | Tokens/min | Tokens/day | Requests/day |
| --- | --- | --- | --- | --- | --- | --- |
| `llama-3.3-70b-versatile` ← **default** | ✅ | ✅ | 30 | **12K** | 100K | 1,000 |
| `openai/gpt-oss-120b` | ✅ | ❌ | 30 | 8K | 200K | 1,000 |
| `openai/gpt-oss-20b` | ✅ | ❌ | 30 | 8K | 200K | 1,000 |
| `llama-3.1-8b-instant` | ✅ | ✅ | 30 | 6K | 500K | 14,400 |
| `qwen/qwen3.6-27b` | ✅ | ✅ | — | 6K | 500K | 1,000 |
| `meta-llama/llama-4-scout-17b-16e-instruct` | ❌ **no local tools** | — | 30 | 30K | 500K | 1,000 |
| `groq/compound` | ❌ **no local tools** | — | 30 | 70K | — | 250 |

**Tokens-per-minute is the limit that actually binds**, not requests-per-day —
because a tool loop makes several rounds per turn and re-sends the tool
declarations every round. So the proxy now declares only the tools a turn could
plausibly use (`lib/tool-selection.js`) and rebuilds the system prompt from the
same subset:

| | Before | After |
| --- | --- | --- |
| Tool declarations | ~4,000 tokens (all 37) | ~600 tokens (typical turn) |
| System prompt | 1,220 tokens | ~900 tokens |
| **Fixed overhead per round** | **~5,150** | **~1,500** |
| Rounds/min on `llama-3.3-70b` (12K TPM) | 2 | ~8 |
| Rounds/min on `gpt-oss-120b` (8K TPM) | 1 | ~5 |
| Turns/day on 100K TPD | ~19 | ~65 |

Without that, `llama-3.1-8b-instant` (6K TPM) would 429 on the *first* request
of a turn. Tune it with `QUARK_TOOL_BUDGET` (default 14) or disable it with
`QUARK_SEND_ALL_TOOLS=1`.

**Which model to pick:**

- `llama-3.3-70b-versatile` — default. Best tool reliability, parallel tool
  calls, highest TPM. ~65 turns/day.
- `openai/gpt-oss-120b` — 2× the daily tokens (200K) and strong reasoning; no
  parallel tool calls, which Q.U.A.R.K. does not need (it sets
  `parallel_tool_calls: false` anyway). The adapter sends
  `max_completion_tokens` for this family automatically.
- `llama-3.1-8b-instant` — most requests/day by far (14,400) but only 6K TPM
  and the weakest tool calling of the three. Fine for short factual turns.

```bash
# .env.local  (or Vercel → Settings → Environment Variables)
LLM_PROVIDER=openai
OPENAI_API_KEY=gsk_xxxxxxxxxxxx
OPENAI_BASE_URL=https://api.groq.com/openai/v1     # this is the default
OPENAI_MODEL=llama-3.3-70b-versatile               # this is the default
OPENAI_MAX_TOKENS=2048

# optional second line of defence if you also have a Gemini key
LLM_FALLBACK_PROVIDER=gemini
GEMINI_API_KEY=...
```

Groq-only is a complete setup: `LLM_FALLBACK_PROVIDER` may stay empty. If you
do add Gemini, either order works — failover triggers on 429/5xx either way.

### Other free OpenAI-compatible providers

| Provider | Free allowance (Sept 2026) | `OPENAI_BASE_URL` |
| --- | --- | --- |
| OpenRouter | 20 req/min, 50 req/day on `:free` models (1,000/day after any $10 top-up) | `https://openrouter.ai/api/v1` |
| Cerebras | 30 req/min, ~1 M tokens/day | `https://api.cerebras.ai/v1` |
| Mistral | ~1 B tokens/month, free mode, no card | `https://api.mistral.ai/v1` |
| GitHub Models | 10–15 req/min, 150–1,000 req/day | `https://models.inference.ai.azure.com` |
| Cloudflare Workers AI | 10,000 neurons/day | (not OpenAI-shaped — would need a small adapter) |
| Google AI Studio | Gemini free tier, limits shown in AI Studio | (use `LLM_PROVIDER=gemini`) |

OpenRouter needs a model id with the `:free` suffix, e.g.
`OPENAI_MODEL=meta-llama/llama-3.3-70b-instruct:free`.

**Verify in 30 seconds:**

```bash
npm run start &
curl -s localhost:3000/api/chat | python3 -m json.tool   # shows provider + fallback topology
curl -s -X POST localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Explain quicksort in two sentences"}]}'
```

---

## Option B — a 4 GB model on your own machine (free, private, offline)

Best for development and for a personal deployment. Nothing leaves your laptop.

### 1. Install one runtime

```bash
# Ollama — simplest, OpenAI-compatible server built in
curl -fsSL https://ollama.com/install.sh | sh        # Linux
# macOS/Windows: download from https://ollama.com

# or LM Studio — GUI, has a local OpenAI-compatible server toggle
# or llama.cpp — lightest, best for low-RAM machines
```

### 2. Pull a ~4 GB model

```bash
ollama pull qwen3:4b          # ~2.5 GB — best quality/size ratio, strong at tool calls
ollama pull llama3.2:3b       # ~2.0 GB — fast, good English
ollama pull phi3.5            # ~2.2 GB — good reasoning for its size
ollama pull mistral:7b        # ~4.4 GB — the upper end of your budget
```

RAM/disk rule of thumb: a Q4 quantised model needs roughly its file size + 2 GB
of free RAM. A 4 GB model runs comfortably in 8 GB RAM on CPU; a GPU just makes
it faster.

### 3. Point Q.U.A.R.K. at it

```bash
LLM_PROVIDER=openai
LLM_FALLBACK_PROVIDER=gemini          # optional: cloud backup
OPENAI_API_KEY=ollama                 # any non-empty string; Ollama ignores it
OPENAI_BASE_URL=http://127.0.0.1:11434/v1
OPENAI_MODEL=qwen3:4b
OPENAI_MAX_TOKENS=2048                # small models need less; keeps replies tight
```

LM Studio uses `http://127.0.0.1:1234/v1`; a raw `llama.cpp` server uses
`http://127.0.0.1:8080/v1`. Confirm the port from the runtime's own startup
output — Ollama has historically used 11434.

### 4. The one catch

`localhost` on your laptop is **not** reachable from Vercel. This setup works
for `npm run dev` / `npm run start` locally. To use your own model from the
deployed site you must expose it:

```bash
# Cloudflare Tunnel — free, no port forwarding, gives you HTTPS
cloudflared tunnel --url http://127.0.0.1:11434
# → https://something-random.trycloudflare.com
```

Then `OPENAI_BASE_URL=https://something-random.trycloudflare.com/v1`.

⚠️ **That makes your model public.** Anyone with the URL can use it. If you do
this, put a reverse proxy in front that requires a header (Caddy/nginx checking
`Authorization: Bearer <your token>`) and set `OPENAI_API_KEY` to that token.
Tunnelling is fine for a demo; do not leave it running unattended. For 24/7 use
Option C instead.

---

## Option C — free 24/7 cloud host for the model

If you want the deployed site to use *your* model with no laptop involved.

### Oracle Cloud Always Free (the realistic choice)

Genuinely free, not a trial: **Ampere A1 ARM — up to 4 OCPU + 24 GB RAM +
200 GB disk**. That is more than enough for a 4 GB model on CPU
(roughly 5–15 tokens/s, which is fine because Q.U.A.R.K. streams).

```bash
# 1. Create the VM: Oracle Cloud → Compute → Instances → Create.
#    Image: Ubuntu 24.04 (aarch64). Shape: VM.Standard.A1.Flex, 4 OCPU / 24 GB.
#    Save the private key you are given; add an ingress rule for port 443.

# 2. On the VM:
ssh ubuntu@<public-ip>
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3:4b
sudo systemctl enable --now ollama          # survives reboots

# 3. TLS + a bearer token in front of it (Caddy is one binary, free certs):
sudo apt install -y caddy
sudo tee /etc/caddy/Caddyfile >/dev/null <<'CADDY'
llm.yourdomain.com {
    @authed header Authorization "Bearer PUT-A-LONG-RANDOM-SECRET-HERE"
    handle @authed { reverse_proxy 127.0.0.1:11434 }
    respond 401
}
CADDY
sudo systemctl reload caddy
```

Then in Vercel:

```bash
LLM_PROVIDER=openai
OPENAI_BASE_URL=https://llm.yourdomain.com/v1
OPENAI_API_KEY=PUT-A-LONG-RANDOM-SECRET-HERE
OPENAI_MODEL=qwen3:4b
```

Notes, honestly stated: Always Free ARM capacity is sometimes unavailable in
popular regions ("out of capacity" on create) — retry, or pick a less busy
region. Free-tier VMs can be reclaimed if idle; keep a lightweight cron or
health check hitting it. And a domain name costs ~$10/year unless you use a
free one, so if that matters, prefer Option A.

### Other free hosts

| Host | Free spec | Good for | Catch |
| --- | --- | --- | --- |
| Hugging Face Spaces (Docker) | 2 vCPU / 16 GB CPU basic | A public demo endpoint | Sleeps when idle; public by default |
| Google Colab (free) | T4 GPU | Fast experiments | Dies when the notebook closes; needs a tunnel |
| Kaggle Notebooks | 30 h/week GPU (P100/T4) | Weekend testing | Ephemeral, not a service |
| Google Cloud e2-micro | 1 vCPU / 1 GB | Too small | Cannot fit a 4 GB model |
| Render / Fly.io free tiers | Spin down or gone | Not for inference | Cold starts of minutes |

### Why not host it on Vercel itself

Worth stating plainly, since the app lives there:

- Serverless functions have a **250 MB** deployment bundle limit — a 4 GB model
  cannot ship with the app.
- No writable persistent filesystem, so the weights cannot be cached between
  invocations.
- ~1 GB memory and a hard execution timeout — a cold model load alone would
  exceed it.
- Cold starts on every invocation.

Vercel is the right place for the **proxy** (`/api/chat`), which is exactly what
Q.U.A.R.K. does: the key stays server-side, the browser never talks to a model
vendor directly, and the model itself lives wherever you choose.

---

## Recommended setup (Groq primary)

This is exactly what `.env.local` in this repo is pre-filled with — only the key
is missing.

```bash
# Primary: Groq free tier — fast (500+ tok/s), no card, OpenAI-compatible
LLM_PROVIDER=openai
OPENAI_API_KEY=gsk_...                      # https://console.groq.com/keys
OPENAI_BASE_URL=https://api.groq.com/openai/v1
OPENAI_MODEL=llama-3.3-70b-versatile
OPENAI_MAX_TOKENS=2048

# Optional second line of defence (fails over on Groq's 30 req/min cap)
LLM_FALLBACK_PROVIDER=gemini
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash

# Keeps a turn inside the free tokens-per-minute budget
QUARK_TOOL_BUDGET=14

# Everything else is already free and local:
#   - deterministic answers, tools, fuzzy intents → lib/engine.js (browser)
#   - speech-to-text → Whisper on-device (browser, 45 MB)
```

Result: a query is answered by the browser when it can be, by Groq when it needs
a model, and by Gemini if Groq is rate-limited — with no raw error ever reaching
the user. Add Ollama on your laptop or an Oracle VM as a third layer whenever
you want fully self-hosted inference.

**Going live on Vercel:** add the same names under Project → Settings →
Environment Variables, set `QUARK_ALLOWED_ORIGINS=https://your-app.vercel.app`,
and redeploy (env changes never apply to an existing build). Then confirm with:

```bash
curl https://your-app.vercel.app/api/chat
# "provider":"openai", "model":"llama-3.3-70b-versatile",
# "providers":{"openai":true,...}, "toolBudget":14
```

## Security checklist

- Keys go in `.env.local` (git-ignored) or Vercel env vars — never in
  `NEXT_PUBLIC_*`, never in client code. `/api/chat` is the only place that
  reads them.
- Set `QUARK_ALLOWED_ORIGINS` to your deployed origin so nobody else can spend
  your quota through your proxy.
- Any self-hosted OpenAI-compatible endpoint must require a bearer token.
- Rotate a key immediately if it ever lands in a commit or a screenshot.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `503 not_configured` | No usable key. Set `GEMINI_API_KEY` or `OPENAI_API_KEY`. |
| Fallback never triggers | `LLM_FALLBACK_PROVIDER` unset, or its key missing. `curl localhost:3000/api/chat` shows the resolved topology. |
| `Could not reach <base>` | Wrong `OPENAI_BASE_URL`, or a serverless function cannot reach a `localhost`/LAN address. |
| Tool calls misfire on a small model | Use a stronger model (`qwen3:4b` and up handle Q.U.A.R.K.'s 37 tools; 1–2 B models often invent arguments). Reduce `QUARK_MAX_TOOL_ROUNDS`. |
| Very slow first reply | Model cold start. Keep it warm with a health-check cron. |
| Replies truncated | Raise `OPENAI_MAX_TOKENS` / `QUARK_MAX_OUTPUT_TOKENS`. |
