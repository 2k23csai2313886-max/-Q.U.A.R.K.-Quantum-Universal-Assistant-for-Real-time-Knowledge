'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuark } from '@/hooks/QuarkProvider';

/**
 * Terminal — the conversation surface.
 *
 * SECURITY: model output and user input are rendered with React text nodes
 * only. There is no innerHTML anywhere in this project, which removes the
 * XSS sink the original had (it concatenated both into innerHTML).
 *
 * A11Y: role="log" + aria-live="polite" so screen readers announce replies —
 * the original was silent to assistive tech.
 */
export default function Terminal() {
  const { transcript, busy, conn, submit, cancel, speech } = useQuark();
  const [value, setValue] = useState('');
  const logRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript]);

  const onSubmit = (e) => {
    e.preventDefault();
    const text = value.trim();
    if (!text || busy) return;
    setValue('');
    submit(text);
  };

  const badgeClass =
    conn.state === 'live' ? 'conn-live' : conn.state === 'unknown' ? 'conn-unknown' : 'conn-offline';
  const badgeText =
    conn.state === 'live' ? 'LIVE' : conn.state === 'unknown' ? 'CONNECTING…' : 'LOCAL CORE';

  return (
    <div className="terminal">
      <div className="terminal-head">
        <span>SYSTEM_LOG // Q.U.A.R.K.</span>
        <span className={`conn-badge ${badgeClass}`} title={conn.detail || ''}>
          {badgeText}
        </span>
      </div>

      <div className="terminal-log" id="termLog" ref={logRef} role="log" aria-live="polite" aria-relevant="additions" aria-label="Conversation log">
        {transcript.map((entry) => {
          if (entry.role === 'trace') {
            return (
              <div className={`trace ${entry.status === 'done' ? 'done' : entry.status === 'fail' ? 'fail' : 'wait'}`} key={entry.id}>
                <span className="tico" aria-hidden="true">▸</span>
                <span className="tname">{entry.name}</span>
                <span className="targs">{entry.detail}</span>
              </div>
            );
          }
          if (entry.role === 'user') {
            return (
              <div className="u line" key={entry.id}>
                <span className="tag">USER &gt;</span>
                {entry.text}
              </div>
            );
          }
          return (
            <div className="a line" key={entry.id}>
              <span className="tag">Q.U.A.R.K. &gt;</span>
              {entry.text || (entry.streaming ? <span className="typing">thinking…</span> : '')}
              {entry.streaming && entry.text ? <span className="typing">▌</span> : null}
            </div>
          );
        })}
      </div>

      <form className="terminal-input" onSubmit={onSubmit}>
        <span className="caret" aria-hidden="true">&gt;</span>
        <label className="sr-only" htmlFor="cmdInput">Command Q.U.A.R.K.</label>
        <input
          id="cmdInput"
          ref={inputRef}
          type="text"
          value={value}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          placeholder={
            busy
              ? 'Working…'
              : speech.listening
                ? 'Listening — speak now…'
                : 'Ask Q.U.A.R.K. anything, or say “open youtube”…'
          }
        />
        {busy ? (
          <button type="button" className="stop" onClick={cancel}>STOP</button>
        ) : (
          <button type="submit">SEND</button>
        )}
      </form>
    </div>
  );
}
