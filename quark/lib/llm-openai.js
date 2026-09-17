/**
 * Q.U.A.R.K. — OpenAI-compatible provider adapter
 * ─────────────────────────────────────────────────────────────────────────
 * One adapter covers every "OpenAI-shaped" host, which is where the free and
 * self-hosted models live:
 *
 *   Groq          https://api.groq.com/openai/v1        (free tier, very fast)
 *   OpenRouter    https://openrouter.ai/api/v1          (free model variants)
 *   Together      https://api.together.xyz/v1
 *   Ollama        http://127.0.0.1:11434/v1             (your own machine)
 *   llama.cpp     http://127.0.0.1:8080/v1
 *   LM Studio     http://127.0.0.1:1234/v1
 *
 * It converts our internal Gemini-shaped `contents` into OpenAI `messages` and
 * maps the reply back into the shape `lib/gemini-client.js` already expects, so
 * the browser client needs zero changes when the provider switches.
 *
 * This module never reads process.env — the route passes config in.
 */

/** Gemini JSON-Schema declarations → OpenAI `tools`. */
export function toOpenAITools(declarations) {
  return (declarations || [])
    .filter((d) => d && d.name)
    .map((d) => ({
      type: 'function',
      function: {
        name: d.name,
        description: d.description || '',
        parameters: d.parameters || { type: 'object', properties: {} },
      },
    }));
}

function safeParseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Gemini `contents` → OpenAI `messages`.
 *
 * The awkward part is tool-call identity: OpenAI requires every `tool` message
 * to reference the `tool_call_id` of the assistant call it answers. Gemini only
 * sometimes supplies ids, so when they are missing we mint deterministic ones
 * and pair calls with responses positionally (they always arrive in order).
 */
export function toOpenAIMessages(contents, systemPrompt) {
  const messages = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
  const pendingIds = [];

  for (const c of contents || []) {
    const parts = Array.isArray(c?.parts) ? c.parts : [];
    const text = parts.filter((p) => typeof p?.text === 'string').map((p) => p.text).join('\n').trim();
    const calls = parts.filter((p) => p?.functionCall);
    const responses = parts.filter((p) => p?.functionResponse);

    if (c.role === 'model') {
      if (calls.length) {
        const tool_calls = calls.map((p, i) => {
          const id = p.functionCall.id || `qk_${messages.length}_${i}`;
          pendingIds[i] = id;
          return {
            id,
            type: 'function',
            function: {
              name: p.functionCall.name,
              arguments: JSON.stringify(p.functionCall.args || {}),
            },
          };
        });
        messages.push({ role: 'assistant', content: text || null, tool_calls });
      } else if (text) {
        messages.push({ role: 'assistant', content: text });
      }
      continue;
    }

    // user turn — may be plain text, tool results, or both
    responses.forEach((p, i) => {
      messages.push({
        role: 'tool',
        tool_call_id: p.functionResponse.id || pendingIds[i] || `qk_${messages.length}_${i}`,
        content: JSON.stringify(p.functionResponse.response ?? {}),
      });
    });
    if (text) messages.push({ role: 'user', content: text });
  }

  return messages;
}

/** Build the chat-completions request body. */
export function toOpenAIRequest({ contents, systemPrompt, declarations, model, maxTokens }) {
  const tools = toOpenAITools(declarations);
  const body = {
    model,
    messages: toOpenAIMessages(contents, systemPrompt),
    temperature: 0.4,
  };
  if (tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
    body.parallel_tool_calls = false;
  }
  if (maxTokens) {
    // Groq's gpt-oss-* models take `max_completion_tokens`; older/other
    // OpenAI-compatible hosts (Ollama, llama.cpp, LM Studio) take `max_tokens`.
    // Sending the wrong one is a hard 400, so pick by model family.
    if (/gpt-oss/i.test(String(model || ''))) body.max_completion_tokens = maxTokens;
    else body.max_tokens = maxTokens;
  }
  return body;
}

const FINISH_MAP = {
  stop: 'STOP',
  length: 'MAX_TOKENS',
  tool_calls: 'STOP',
  function_call: 'STOP',
  content_filter: 'SAFETY',
};

/** OpenAI response → the shape our client already understands. */
export function mapOpenAIResponse(json) {
  const choice = json?.choices?.[0];
  const msg = choice?.message || {};
  const raw = msg.content;
  const text =
    typeof raw === 'string'
      ? raw
      : Array.isArray(raw)
        ? raw.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
        : '';

  const functionCalls = (msg.tool_calls || [])
    .filter((tc) => tc?.function?.name)
    .map((tc) => ({
      id: tc.id || null,
      name: tc.function.name,
      args: safeParseArgs(tc.function.arguments),
    }));

  const finishReason = FINISH_MAP[choice?.finish_reason] || choice?.finish_reason || null;
  const u = json?.usage;

  return {
    text: text.trim(),
    functionCalls,
    finishReason,
    blocked: finishReason === 'SAFETY',
    usage: u
      ? {
          promptTokens: u.prompt_tokens ?? 0,
          completionTokens: u.completion_tokens ?? 0,
          totalTokens: u.total_tokens ?? 0,
        }
      : null,
  };
}

/** Split text into a few pieces so the HUD still types the answer out. */
export function chunkText(text, pieces = 14) {
  const t = String(text || '');
  if (!t) return [];
  if (t.length <= 60 || pieces <= 1) return [t];
  const size = Math.ceil(t.length / pieces);
  const out = [];
  for (let i = 0; i < t.length; i += size) out.push(t.slice(i, i + size));
  return out;
}

/** Turn an upstream HTTP failure into something the HUD can explain. */
export function classifyOpenAI(status, json, model) {
  const msg = json?.error?.message || json?.message || '';
  if (status === 401 || status === 403) {
    return { code: 'unauthorized', hint: 'The OpenAI-compatible provider rejected the key (OPENAI_API_KEY).' };
  }
  if (status === 404) {
    return { code: 'bad_model', hint: `Model "${model}" was not found at OPENAI_BASE_URL.` };
  }
  if (status === 429) {
    return { code: 'rate_limited', hint: msg || 'That provider is rate-limiting this key.' };
  }
  if (status === 400) {
    return { code: 'bad_request', hint: msg || 'The provider rejected the request payload.' };
  }
  if (status >= 500) return { code: 'upstream', hint: `Provider error (HTTP ${status}).` };
  return { code: 'unknown', hint: msg || `HTTP ${status}` };
}
