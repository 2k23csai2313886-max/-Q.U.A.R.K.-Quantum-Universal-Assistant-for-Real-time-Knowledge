import { offlinePlan } from '../lib/offline-brain.js';
const cases = [
 'hello','hi quark','open youtube','open the github','youtube kholo','open instagram',
 'search react hooks','google quantum computing','play lofi music',
 'what time is it','sometimes I feel like a timeline','what is the date',
 'calculate 45 * 12','(3+4)*2','what is sqrt(144) + 2^10',
 'set a timer for 10 minutes','set a timer for five minutes','cancel all timers',
 'remind me to submit the report at 9:00 pm',
 'where am I','what is the weather','weather in Kanpur','how hot is it',
 'battery status','system report','take a photo','take a selfie','screenshot',
 'read my clipboard','copy this: hello world','go fullscreen','clear the terminal',
 'change accent to magenta','what can you do','show me the team','who is the team leader',
 'team members','who is Aryan Shukla','who are you','who made you',
 'directions to Delhi from Kanpur by train',
 'tell me a joke','thank you','goodbye','stop talking','start listening',
 'open https://example.com/docs','time in America/New_York',
 'quantum decoherence in superconducting qubits','open the settings',
];
let calls=0, texts=0;
for (const c of cases) {
  const r = offlinePlan(c, {});
  if (r.calls) { calls++; console.log(String(JSON.stringify(c)).padEnd(46), '=> TOOL', r.calls.map(x=>x.name+'('+JSON.stringify(x.args)+')').join(' + ')); }
  else { texts++; console.log(String(JSON.stringify(c)).padEnd(46), '=> SAY ', (r.text||'').slice(0,80)); }
}
console.log('\ntool-routed:', calls, '| text-only:', texts, '| total:', cases.length);

// ── assertions: the phrasings users actually type ────────────────────────
// `null` means "must NOT be routed to wikipedia_lookup" (identity, maths…).
const MUST = [
  ['time now', 'get_datetime'],
  ['what is time now', 'get_datetime'],
  ['current time', 'get_datetime'],
  ['date today', 'get_datetime'],
  ['what is the date', 'get_datetime'],
  ['where am I', 'get_location'],
  ['location', 'get_location'],
  ['my position', 'get_location'],
  ['gps', 'get_location'],
  ['track me', 'get_location'],
  ['what is lion', 'wikipedia_lookup'],
  ['what is psi', 'wikipedia_lookup'],
  ['who is Einstein', 'wikipedia_lookup'],
  ['define photosynthesis', 'wikipedia_lookup'],
  ['tell me about black holes', 'wikipedia_lookup'],
  // Voice mode: where the audio goes. Must never be mistaken for plain
  // "start/stop listening", and plain listening must not be hijacked by it.
  ['use offline voice', 'set_voice_mode'],
  ['voice without internet', 'set_voice_mode'],
  ["don't upload my audio", 'set_voice_mode'],
  ['switch to on device speech', 'set_voice_mode'],
  ['private voice mode', 'set_voice_mode'],
  ['use normal voice mode', 'set_voice_mode'],
  ['listen to me', 'set_voice_listening'],
  ['stop listening', 'set_voice_listening'],
  ['start listening', 'set_voice_listening'],
  ['what are you', null],
  ['explain your features', null],
  ['what is 2+2', null],
  ['who is the team leader', null],
];
console.log('\n── routing assertions ──');
let fail = 0;
for (const [q, tool] of MUST) {
  const got = offlinePlan(q, {}).calls?.[0]?.name || null;
  const ok = tool ? got === tool : got !== 'wikipedia_lookup';
  if (!ok) fail++;
  console.log(ok ? '  ✅' : '  ❌', JSON.stringify(q).padEnd(28), '→', got || '(text answer)');
}
if (fail) {
  console.error(`\n${fail} routing assertion(s) FAILED`);
  process.exit(1);
}
console.log(`\nall ${MUST.length} routing assertions passed`);
