'use client';

import { useEffect, useState } from 'react';
import { useQuark } from '@/hooks/QuarkProvider';
import { IconBattery, IconNetwork, IconUplink, IconEntangle, IconTimer } from './Icons';

/**
 * LEFT COLUMN — Location · System Status · Activity Monitor · Timers
 *
 * Every value here is now REAL or explicitly tagged SIMULATED. The original
 * hardcoded "Bengaluru / 93% / 5G / 10h uptime" and presented it as live.
 */
export default function LeftColumn() {
  return (
    <div className="col">
      <LocationPanel />
      <SystemStatusPanel />
      <ActivityMonitor />
      <TimersPanel />
    </div>
  );
}

function LocationPanel() {
  const { location, setLocation, ensurePermission, toast, weather } = useQuark();

  const fix = async () => {
    const res = await ensurePermission('geolocation', { reason: 'to pin your position on the HUD' });
    if (res.state === 'granted' && res.data) {
      setLocation(res.data);
      toast({ kind: 'ok', title: 'Position locked', message: `±${res.data.accuracyMeters} m` });
    } else {
      toast({ kind: 'warn', title: 'No position', message: `Geolocation is ${res.state}.` });
    }
  };

  return (
    <section className="panel" aria-labelledby="loc-title">
      <div className="panel-title" id="loc-title">
        <span>LOCATION</span>
        <span className={`sim-tag${location ? ' live' : ''}`}>{location ? 'GPS FIX' : 'NO FIX'}</span>
      </div>

      {location ? (
        <>
          <div className="location-name">{weather.place || 'Position acquired'}</div>
          <div className="location-sub">
            ±{location.accuracyMeters} m · {new Date(location.timestamp).toLocaleTimeString()}
          </div>
          <div className="location-coords">
            LAT {location.latitude.toFixed(4)}° &nbsp;LNG {location.longitude.toFixed(4)}°
          </div>
        </>
      ) : (
        <>
          <div className="location-name" style={{ fontSize: 15 }}>No GPS fix</div>
          <div className="location-sub">
            Location is never assumed. Say <em>“where am I”</em> or grant access to pin it.
          </div>
          <button type="button" className="cap-btn" style={{ marginTop: 12 }} onClick={fix}>
            ACQUIRE POSITION
          </button>
        </>
      )}
    </section>
  );
}

function SystemStatusPanel() {
  const { conn, caps } = useQuark();
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine);
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  const granted = caps.filter((c) => c.state === 'granted').length;

  return (
    <section className="panel" aria-labelledby="sys-title">
      <div className="panel-title" id="sys-title"><span>SYSTEM STATUS</span></div>
      <div className="stat-grid">
        <div className="stat-cell">
          <IconUplink width={15} height={15} />
          <div>
            <span className="label">MODEL LINK</span>
            <span className="value">{conn.state === 'live' ? 'LIVE' : conn.state === 'unknown' ? '…' : 'LOCAL'}</span>
          </div>
        </div>
        <div className="stat-cell">
          <IconNetwork width={15} height={15} />
          <div>
            <span className="label">NETWORK</span>
            <span className="value">{online ? 'ONLINE' : 'OFFLINE'}</span>
          </div>
        </div>
        <div className="stat-cell">
          <IconEntangle width={15} height={15} />
          <div>
            <span className="label">TOOLS</span>
            <span className="value">{conn.tools || 0}</span>
          </div>
        </div>
        <div className="stat-cell">
          <IconBattery width={15} height={15} />
          <div>
            <span className="label">PERMISSIONS</span>
            <span className="value">{granted} GRANTED</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function ActivityMonitor() {
  const { activity } = useQuark();
  return (
    <section className="panel" aria-labelledby="act-title">
      <div className="panel-title" id="act-title">
        <span>ACTIVITY MONITOR</span>
        <span className="pulse" aria-hidden="true" />
      </div>
      <div className="activity-state">
        <div className="glyph" aria-hidden="true">&bull;</div>
        <div className="txt">{activity.headline}</div>
      </div>
      <div className="activity-log" role="log" aria-label="Activity monitor log">
        {activity.rows.map((r) => (
          <div className="row" key={r.id}>
            <span className="t">{r.t}</span>
            <span className={`s ${r.cls}`}>
              &rarr; {r.state}
              {r.detail ? ` · ${r.detail}` : ''}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function TimersPanel() {
  const { timers } = useQuark();
  return (
    <section className="panel" aria-labelledby="tim-title">
      <div className="panel-title" id="tim-title">
        <span>TIMERS &amp; REMINDERS</span>
        <span className={`sim-tag${timers.items.length ? ' live' : ''}`}>{timers.items.length}</span>
      </div>
      {timers.items.length === 0 ? (
        <p className="empty-hint">
          None active. Say “set a timer for 10 minutes” or “remind me at 9pm to submit the report”.
        </p>
      ) : (
        <div className="timer-list">
          {timers.items.map((t) => (
            <div className={`timer-row${t.due ? ' due' : ''}`} key={t.id}>
              <IconTimer width={13} height={13} style={{ flexShrink: 0, color: 'var(--warn)' }} />
              <span className="tl" title={t.label}>{t.label}</span>
              <span className="tv">{t.remainingLabel}</span>
              <button type="button" className="timer-x" aria-label={`Cancel ${t.label}`} onClick={() => timers.cancel(t.id)}>
                &times;
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
