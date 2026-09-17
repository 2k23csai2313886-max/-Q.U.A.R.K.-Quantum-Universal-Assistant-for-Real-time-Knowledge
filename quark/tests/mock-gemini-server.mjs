// Mock Gemini REST endpoint — verifies the proxy injects the key, the SSE
// stream parses, and the function-call round-trip completes.
import http from 'node:http';

const seen = [];
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const key = req.headers['x-goog-api-key'];
    seen.push({ url: req.url, hasKey: !!key, key });
    if (!key) { res.writeHead(401, {'content-type':'application/json'}); return res.end(JSON.stringify({error:{message:'x-goog-api-key header is required'}})); }

    const payload = JSON.parse(body || '{}');
    // Look only at the LAST turn — otherwise history from earlier queries
    // makes every subsequent turn look like a tool-result turn.
    const last = payload.contents?.[payload.contents.length - 1];
    const hasFnResponse = !!last?.parts?.some(p => p.functionResponse);
    const streaming = req.url.includes('streamGenerateContent');

    // ── fallback transcription (audio inlineData) ────────────────────────
    const hasAudio = (payload.contents || []).some(c => (c.parts || []).some(p => p.inlineData));
    if (hasAudio) {
      const inline = (payload.contents || []).flatMap(c => c.parts || []).find(p => p.inlineData)?.inlineData || {};
      const bytes = Math.round((inline.data || '').length * 0.75);
      if (bytes < 1500) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'NO_SPEECH' }] }, finishReason: 'STOP' }] }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'what is lion' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 4, totalTokenCount: 904 },
      }));
    }
    const lastUserText = [...(payload.contents||[])].reverse().find(c=>c.role==='user' && c.parts?.some(p=>typeof p.text==='string'))?.parts.map(p=>p.text||'').join(' ').toLowerCase() || '';

    // ── simulated free-tier quota exhaustion (HTTP 429) ─────────────────
    if (/\bquota\b/.test(lastUserText)) {
      res.writeHead(429, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: {
        code: 429,
        message: 'You exceeded your current quota, please check your plan and billing details. ' +
                 'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, ' +
                 'limit: 20, model: gemini-2.5-flash. Please retry in 25.144011759s.',
        status: 'RESOURCE_EXHAUSTED',
      } }));
    }

    // ── thinking-model simulation ───────────────────────────────────────
    // Real Gemini 2.5/3 emits {"thought":true,"text":...} reasoning parts that
    // count against maxOutputTokens. Verify the proxy strips them from the
    // answer and that a thought-only, MAX_TOKENS turn is reported honestly.
    if (/\bpsi\b/.test(lastUserText)) {
      const out = { candidates: [{ content: { role:'model', parts:[
        { thought: true, text: 'PSI could be the Greek letter, the wavefunction, or pounds per square inch. The user is on a physics HUD; lead with the wavefunction but mention the letter.' },
        { text: 'Psi is the Greek letter ψ — and in quantum mechanics, the wavefunction.' },
      ] }, finishReason:'STOP' }] };
      if (streaming) {
        res.writeHead(200,{'content-type':'text/event-stream'});
        for (const part of out.candidates[0].content.parts) {
          res.write(`data: ${JSON.stringify({candidates:[{content:{role:'model',parts:[part]}}]})}\n\n`);
        }
        res.write(`data: ${JSON.stringify({candidates:[{content:{role:'model',parts:[]},finishReason:'STOP'}]})}\n\n`);
        return res.end();
      }
      res.writeHead(200,{'content-type':'application/json'});
      return res.end(JSON.stringify(out));
    }
    if (/burn/.test(lastUserText)) {
      const out = { candidates: [{ content: { role:'model', parts:[
        { thought: true, text: 'reasoning that consumed the entire output budget…' },
      ] }, finishReason:'MAX_TOKENS' }], usageMetadata:{promptTokenCount:3000,candidatesTokenCount:8192,totalTokenCount:11192} };
      if (streaming) {
        res.writeHead(200,{'content-type':'text/event-stream'});
        res.write(`data: ${JSON.stringify({candidates:[{content:{role:'model',parts:out.candidates[0].content.parts}}]})}\n\n`);
        res.write(`data: ${JSON.stringify({candidates:[{content:{role:'model',parts:[]},finishReason:'MAX_TOKENS'}],usageMetadata:out.usageMetadata})}\n\n`);
        return res.end();
      }
      res.writeHead(200,{'content-type':'application/json'});
      return res.end(JSON.stringify(out));
    }

    const wantTool = /where am i|location|gps/.test(lastUserText) ? { name:'get_location', args:{} }
                   : /weather/.test(lastUserText) ? { name:'get_weather', args:{ location:'Kanpur' } }
                   : /youtube/.test(lastUserText) ? { name:'open_website', args:{ site_name:'youtube' } }
                   : { name:'get_datetime', args:{ part:'time' } };

    if (!hasFnResponse) {
      // Turn 1: ask for a tool
      const out = { candidates: [{ content: { role:'model', parts:[{ functionCall:{ id:'call_'+Date.now(), name:wantTool.name, args:wantTool.args } }] }, finishReason:'STOP' }],
                    usageMetadata:{ promptTokenCount:42, candidatesTokenCount:11, totalTokenCount:53 } };
      if (!streaming) { res.writeHead(200,{'content-type':'application/json'}); return res.end(JSON.stringify(out)); }
      res.writeHead(200,{'content-type':'text/event-stream'});
      res.write(`data: ${JSON.stringify(out)}\n\n`);
      return res.end();
    }

    // Turn 2: stream a text answer that incorporates the tool result
    const fnResp = payload.contents.flatMap(c=>c.parts).find(p=>p.functionResponse)?.functionResponse?.response?.summary || '';
    const answer = `Done, Commander — ${fnResp.slice(0,90)} The link is live.`;
    if (!streaming) {
      res.writeHead(200,{'content-type':'application/json'});
      return res.end(JSON.stringify({candidates:[{content:{role:'model',parts:[{text:answer}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:80,candidatesTokenCount:20,totalTokenCount:100}}));
    }
    res.writeHead(200, {'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache'});
    const chunks = answer.match(/.{1,7}/gs) || [answer];
    let i = 0;
    const tick = () => {
      if (i >= chunks.length) {
        res.write(`data: ${JSON.stringify({candidates:[{content:{role:'model',parts:[]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:80,candidatesTokenCount:20,totalTokenCount:100}})}\n\n`);
        return res.end();
      }
      res.write(`data: ${JSON.stringify({candidates:[{content:{role:'model',parts:[{text:chunks[i]}]}}]})}\n\n`);
      i++; setTimeout(tick, 25);
    };
    tick();
  });
});
server.listen(9999, '127.0.0.1', () => console.log('mock gemini on 9999'));
process.on('SIGTERM', () => process.exit(0));
