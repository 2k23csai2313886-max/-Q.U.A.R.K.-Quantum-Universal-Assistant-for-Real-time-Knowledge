/**
 * Mock OpenAI-compatible server (Groq / OpenRouter / Ollama shaped).
 * Used by tests/e2e-providers.mjs to prove the provider adapter and the
 * automatic quota failover work without spending real credits.
 *
 *   POST /v1/chat/completions
 *   Turn 1 (no tool result yet) → asks for the get_datetime tool
 *   Turn 2                      → answers, echoing which provider served it
 */
import http from 'node:http';

const tools0 = (payload) => (Array.isArray(payload?.tools) ? payload.tools : []);

const PORT = Number(process.env.MOCK_OPENAI_PORT || 9998);
const MARKER = '[openai-provider]';

/** Every request the proxy actually put on the wire — inspected by the tests. */
const seen = [];

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    // GET /mock/seen → what was sent (tool counts, payload size, model).
    if (req.url?.startsWith('/mock/seen')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, count: seen.length, requests: seen }));
    }
    if (req.url?.startsWith('/mock/reset')) {
      seen.length = 0;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'mock-openai', port: PORT }));
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const auth = req.headers.authorization || '';
    if (!/^Bearer\s+\S+/.test(auth)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Missing bearer token' } }));
    }

    let payload = {};
    try { payload = JSON.parse(body || '{}'); } catch { /* ignore */ }
    const messages = payload.messages || [];

    // Sanity checks the real hosts also enforce.
    if (!Array.isArray(messages) || !messages.length) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: "messages is required" } }));
    }

    seen.push({
      at: Date.now(),
      model: payload.model || null,
      tools: tools0(payload).length,
      toolNames: tools0(payload).map((t) => t?.function?.name).filter(Boolean),
      systemChars: (messages.find((m) => m.role === 'system')?.content || '').length,
      bytes: Buffer.byteLength(body || ''),
      stream: payload.stream === true,
    });

    const hasToolResult = messages.some((m) => m.role === 'tool');
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content || '';
    const tools = Array.isArray(payload.tools) ? payload.tools : [];

    if (!hasToolResult && tools.length) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: payload.model || 'mock-model',
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: 'call_mock_1',
              type: 'function',
              function: { name: 'get_datetime', arguments: JSON.stringify({ part: 'time' }) },
            }],
          },
        }],
        usage: { prompt_tokens: 500, completion_tokens: 18, total_tokens: 518 },
      }));
    }

    const toolText = messages.filter((m) => m.role === 'tool').map((m) => m.content).join(' ');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model: payload.model || 'mock-model',
      choices: [{
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: `${MARKER} Served by ${payload.model}. You asked: "${String(lastUser).slice(0, 60)}". Tool said: ${toolText.slice(0, 80)}`,
        },
      }],
      usage: { prompt_tokens: 620, completion_tokens: 40, total_tokens: 660 },
    }));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock openai-compatible provider on ${PORT}`));
