'use client';

import { useEffect, useState } from 'react';
import { useQuark } from '@/hooks/QuarkProvider';
import { IconSun } from './Icons';

/**
 * RIGHT COLUMN — System Info · Chronometer · Weather · Metrics
 *
 * The indicator rows reflect REAL runtime state. The original showed six
 * hardcoded green dots including "WAKE DETECT" for a feature it didn't have.
 */
export default function RightColumn() {
  return (
    <div className="col">
      <SystemInfoPanel />
      <ChronometerPanel />
    </div>
  );
}

function SystemInfoPanel() {
  const { conn, speech, caps } = useQuark();
  const [online, setOnline] = useState(true);

  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const capState = (id) => caps.find((c) => c.id === id)?.state || 'prompt';
  const dot = (state) =>
    state === 'granted' ? 'ok' : state === 'denied' ? 'err' : state === 'unsupported' || state === 'unavailable' ? 'off' : 'warn';

  const rows = [
    ['CORE ONLINE', online ? 'ok' : 'err'],
    ['MODEL LINK', conn.state === 'live' ? 'ok' : conn.state === 'unknown' ? 'warn' : 'off'],
    ['LOCAL CORE', 'ok'],
    ['MICROPHONE', dot(capState('microphone'))],
    ['VOICE SYNTH', speech.ttsSupported ? (speech.enabled ? 'ok' : 'warn') : 'off'],
    ['SPEECH INPUT', speech.sttSupported ? 'ok' : 'off'],
    ['GEOLOCATION', dot(capState('geolocation'))],
    ['CAMERA', dot(capState('camera'))],
    ['NOTIFICATIONS', dot(capState('notifications'))],
    ['FILE SYSTEM', dot(capState('file-system'))],
  ];

  return (
    <section className="panel" aria-labelledby="info-title">
      <div className="panel-title" id="info-title">
        <span>SYSTEM_INFO</span>
        <span className="pulse" aria-hidden="true" />
      </div>
      <div className="status-list">
        {rows.map(([label, state]) => (
          <div className="status-row" key={label}>
            <span className="slabel">{label}</span>
            <span className={`indicator ${state}`} aria-hidden="true" />
            <span className="sr-only">{state}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function ChronometerPanel() {
  const { clock, weather, queryCount, conn, timers } = useQuark();

  return (
    <section className="panel" aria-labelledby="chron-title">
      <div className="panel-title" id="chron-title"><span>CHRONOMETER</span></div>

      <div className="clock-time">
        {clock.hours}:{clock.minutes}
        <span className="secs">:{clock.seconds}</span>
      </div>
      <div className="clock-date">
        {clock.dateLabel} · {clock.timezone}
      </div>

      <div className="weather-row">
        <IconSun width={20} height={20} />
        <div>
          <div className="weather-temp">{weather.temp}</div>
          <div className="weather-cond">
            {weather.cond}
            {weather.live ? '' : ' · ask “what’s the weather”'}
          </div>
        </div>
      </div>

      <div className="metrics-row">
        <div className="metric">
          <div className="label">QUERIES</div>
          <div className="value">{queryCount}</div>
        </div>
        <div className="metric">
          <div className="label">ACTIVE TIMERS</div>
          <div className="value">{timers.items.length}</div>
        </div>
        <div className="metric">
          <div className="label">LINK</div>
          <div className="value" style={{ fontSize: 13 }}>{conn.state === 'live' ? 'LIVE' : 'LOCAL'}</div>
        </div>
      </div>
    </section>
  );
}
