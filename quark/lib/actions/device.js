/**
 * Q.U.A.R.K. — Device, sensor & media actions
 * ─────────────────────────────────────────────────────────────────────────
 * Every capability here goes through ctx.ensurePermission(), which shows the
 * HUD permission dialog BEFORE the native browser prompt appears.
 */

// WMO 4677 weather interpretation codes → human text + glyph
const WMO = {
  0: ['Clear sky', '☀'], 1: ['Mainly clear', '🌤'], 2: ['Partly cloudy', '⛅'], 3: ['Overcast', '☁'],
  45: ['Fog', '🌫'], 48: ['Depositing rime fog', '🌫'],
  51: ['Light drizzle', '🌦'], 53: ['Drizzle', '🌦'], 55: ['Dense drizzle', '🌧'],
  56: ['Freezing drizzle', '🌧'], 57: ['Dense freezing drizzle', '🌧'],
  61: ['Light rain', '🌦'], 63: ['Rain', '🌧'], 65: ['Heavy rain', '🌧'],
  66: ['Freezing rain', '🌧'], 67: ['Heavy freezing rain', '🌧'],
  71: ['Light snow', '🌨'], 73: ['Snow', '❄'], 75: ['Heavy snow', '❄'], 77: ['Snow grains', '❄'],
  80: ['Light showers', '🌦'], 81: ['Showers', '🌧'], 82: ['Violent showers', '⛈'],
  85: ['Snow showers', '🌨'], 86: ['Heavy snow showers', '❄'],
  95: ['Thunderstorm', '⛈'], 96: ['Thunderstorm with hail', '⛈'], 99: ['Thunderstorm, heavy hail', '⛈'],
};
const describe = (code) => WMO[code] || ['Unknown conditions', '·'];

async function fetchJSON(url, ms = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ── location ─────────────────────────────────────────────────────────────
export async function get_location(_args, ctx) {
  const res = await ctx.ensurePermission('geolocation', { reason: 'to report your current position' });
  if (res.state !== 'granted' || !res.data) {
    return {
      ok: false,
      summary: `Location permission is ${res.state}. ${ctx.denialHelp?.('geolocation') || ''}`.trim(),
      data: { state: res.state, error: res.error },
    };
  }
  const d = res.data;
  return {
    ok: true,
    summary:
      `Current position: latitude ${d.latitude.toFixed(5)}, longitude ${d.longitude.toFixed(5)}, ` +
      `±${d.accuracyMeters} m accuracy.`,
    data: { ...d, mapsUrl: `https://www.google.com/maps?q=${d.latitude},${d.longitude}` },
  };
}

// ── weather (Open-Meteo: free, keyless, CORS-enabled) ────────────────────
export async function get_weather({ location, units }, ctx) {
  const unit = units === 'fahrenheit' ? 'fahrenheit' : 'celsius';
  const unitSym = unit === 'fahrenheit' ? '°F' : '°C';
  let lat, lon, label;

  if (location && location.trim()) {
    try {
      const g = await fetchJSON(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location.trim())}&count=1&language=en&format=json`,
      );
      const hit = g?.results?.[0];
      if (!hit) return { ok: false, summary: `I could not find a place called "${location}".` };
      lat = hit.latitude; lon = hit.longitude;
      label = [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
    } catch (e) {
      return { ok: false, summary: `Geocoding "${location}" failed: ${e.message}` };
    }
  } else {
    const res = await ctx.ensurePermission('geolocation', {
      reason: 'to fetch the weather for wherever you are right now',
    });
    if (res.state !== 'granted' || !res.data) {
      return {
        ok: false,
        summary:
          `I need either a city name or location permission to get live weather. ` +
          `Location is currently ${res.state}.`,
      };
    }
    lat = res.data.latitude; lon = res.data.longitude; label = 'your current position';
  }

  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,wind_speed_10m,wind_direction_10m,pressure_msl` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&timezone=auto&forecast_days=3&temperature_unit=${unit}&wind_speed_unit=kmh`;
    const w = await fetchJSON(url, 15000);
    const c = w.current;
    const [desc] = describe(c.weather_code);

    const days = (w.daily?.time || []).map((date, i) => ({
      date,
      condition: describe(w.daily.weather_code[i])[0],
      max: Math.round(w.daily.temperature_2m_max[i]),
      min: Math.round(w.daily.temperature_2m_min[i]),
      rainChance: w.daily.precipitation_probability_max?.[i] ?? null,
    }));

    const summary =
      `${label}: ${Math.round(c.temperature_2m)}${unitSym}, ${desc.toLowerCase()}. ` +
      `Feels like ${Math.round(c.apparent_temperature)}${unitSym}, humidity ${c.relative_humidity_2m}%, ` +
      `wind ${Math.round(c.wind_speed_10m)} km/h. ` +
      days.slice(1).map((d) => `${d.date.slice(5)}: ${d.max}/${d.min}${unitSym} ${d.condition.toLowerCase()}`).join('; ');

    ctx.setWeather?.({ temp: `${Math.round(c.temperature_2m)}${unitSym}`, cond: desc, place: label });

    return {
      ok: true,
      summary,
      data: {
        place: label, lat, lon, unit,
        current: { tempC: c.temperature_2m, feelsLike: c.apparent_temperature, humidity: c.relative_humidity_2m,
                   windKmh: c.wind_speed_10m, windDir: c.wind_direction_10m, pressure: c.pressure_msl,
                   condition: desc, isDay: !!c.is_day },
        forecast: days,
      },
    };
  } catch (e) {
    return { ok: false, summary: `Weather lookup failed: ${e.message}` };
  }
}

// ── real device telemetry ────────────────────────────────────────────────
export async function get_device_status({ aspects }) {
  const want = new Set((aspects || ['battery', 'network', 'hardware', 'display', 'browser', 'storage']).map(String));
  const out = {};

  if (want.has('hardware')) {
    out.hardware = {
      cpuCores: navigator.hardwareConcurrency ?? 'unknown',
      deviceMemoryGB: navigator.deviceMemory ?? 'not exposed',
      platform: navigator.platform || navigator.userAgentData?.platform || 'unknown',
      languages: navigator.languages?.join(', ') || navigator.language,
      cookieEnabled: navigator.cookieEnabled,
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
    };
  }

  if (want.has('display')) {
    out.display = {
      screen: `${screen.width}×${screen.height}`,
      viewport: `${window.innerWidth}×${window.innerHeight}`,
      devicePixelRatio: window.devicePixelRatio || 1,
      colorDepth: screen.colorDepth,
      orientation: screen.orientation?.type || 'unknown',
    };
  }

  if (want.has('browser')) {
    const ua = navigator.userAgentData;
    out.browser = {
      brands: ua?.brands?.map((b) => `${b.brand} ${b.version}`).join(', ') || 'not exposed (UA-CH unavailable)',
      mobile: ua?.mobile ?? /Mobi|Android/i.test(navigator.userAgent),
      userAgent: navigator.userAgent.slice(0, 220),
      online: navigator.onLine,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      installedAsApp: window.matchMedia?.('(display-mode: standalone)').matches ?? false,
      secureContext: window.isSecureContext,
    };
  }

  if (want.has('battery')) {
    if (navigator.getBattery) {
      try {
        const b = await navigator.getBattery();
        out.battery = {
          levelPercent: Math.round(b.level * 100),
          charging: b.charging,
          chargingTimeMin: Number.isFinite(b.chargingTime) && b.chargingTime > 0 ? Math.round(b.chargingTime / 60) : null,
          dischargingTimeMin: Number.isFinite(b.dischargingTime) && b.dischargingTime < Infinity ? Math.round(b.dischargingTime / 60) : null,
        };
      } catch { out.battery = { error: 'Battery API refused' }; }
    } else {
      out.battery = { supported: false, note: 'Battery Status API is unavailable in this browser (Firefox/Safari removed it).' };
    }
  }

  if (want.has('network')) {
    const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    out.network = c
      ? { effectiveType: c.effectiveType, downlinkMbps: c.downlink, rttMs: c.rtt, saveData: !!c.saveData, type: c.type || 'unknown' }
      : { supported: false, online: navigator.onLine, note: 'Network Information API unavailable — only online/offline is known.' };
  }

  if (want.has('storage')) {
    if (navigator.storage?.estimate) {
      try {
        const e = await navigator.storage.estimate();
        out.storage = {
          usedMB: +(e.usage / 1048576).toFixed(1),
          quotaMB: +(e.quota / 1048576).toFixed(1),
          persistent: (await navigator.storage.persisted?.()) ?? false,
        };
      } catch { out.storage = { error: 'estimate() refused' }; }
    } else out.storage = { supported: false };
  }

  const flat = Object.entries(out).flatMap(([k, v]) => Object.entries(v).map(([kk, vv]) => `${k}.${kk}=${JSON.stringify(vv)}`));
  return {
    ok: true,
    summary: `Device telemetry (${out && Object.keys(out).join(', ')}): ${flat.join('; ').slice(0, 1600)}`,
    data: out,
  };
}

// ── notifications ────────────────────────────────────────────────────────
export async function show_notification({ title, body }, ctx) {
  const res = await ctx.ensurePermission('notifications', { reason: 'to send you this alert' });
  if (res.state !== 'granted') {
    ctx.toast?.({ kind: 'warn', title: 'Notification blocked', message: title });
    return {
      ok: false,
      summary: `Notification permission is ${res.state}, so I showed it as an in-HUD toast instead.`,
    };
  }
  try {
    const n = new Notification(String(title).slice(0, 120), {
      body: String(body || '').slice(0, 400),
      icon: '/favicon.svg',
      tag: 'quark',
    });
    n.onclick = () => { window.focus(); n.close(); };
    return { ok: true, summary: `Notification sent: "${title}".` };
  } catch (e) {
    return { ok: false, summary: `Notification failed: ${e.message}` };
  }
}

// ── camera ───────────────────────────────────────────────────────────────
export async function capture_photo({ facing }, ctx) {
  const res = await ctx.ensurePermission('camera', { reason: 'to take the photo you asked for' });
  if (res.state !== 'granted' || !res.data?.stream) {
    return { ok: false, summary: `Camera access is ${res.state}; no photo was taken. ${ctx.denialHelp?.('camera') || ''}`.trim() };
  }
  const stream = res.data.stream;
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    // let auto-exposure settle
    await new Promise((r) => setTimeout(r, 700));

    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.88);

    ctx.showViewport?.({
      title: 'CAPTURE // CAMERA',
      blocks: [
        { type: 'image', src: dataUrl, alt: 'Photo captured by Q.U.A.R.K.' },
        { type: 'keyvalue', entries: [
          { k: 'Resolution', v: `${w} × ${h}` },
          { k: 'Facing', v: facing === 'environment' ? 'rear' : 'front' },
          { k: 'Captured', v: new Date().toLocaleString() },
          { k: 'Size', v: `${Math.round((dataUrl.length * 3) / 4 / 1024)} KB` },
        ] },
      ],
      actions: [
        { kind: 'download', label: 'DOWNLOAD', href: dataUrl, download: `quark-${Date.now()}.jpg` },
        { kind: 'copy-image-note', label: 'COPY NOTE' },
      ],
    });
    return {
      ok: true,
      summary: `Photo captured (${w}×${h}) and displayed in the HUD viewport with a download button.`,
      data: { width: w, height: h, bytes: Math.round((dataUrl.length * 3) / 4) },
    };
  } catch (e) {
    return { ok: false, summary: `Capture failed: ${e.message}` };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

// ── screen capture ───────────────────────────────────────────────────────
export async function capture_screen(_args, ctx) {
  const res = await ctx.ensurePermission('screen-capture', { reason: 'to capture the screen you choose' });
  if (res.state !== 'granted' || !res.data?.stream) {
    return { ok: false, summary: `Screen capture is ${res.state}; nothing was captured.` };
  }
  const stream = res.data.stream;
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => setTimeout(r, 500));
    const w = video.videoWidth, h = video.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/png');

    ctx.showViewport?.({
      title: 'CAPTURE // SCREEN',
      blocks: [
        { type: 'image', src: dataUrl, alt: 'Screen capture' },
        { type: 'keyvalue', entries: [
          { k: 'Resolution', v: `${w} × ${h}` },
          { k: 'Captured', v: new Date().toLocaleString() },
        ] },
      ],
      actions: [{ kind: 'download', label: 'DOWNLOAD PNG', href: dataUrl, download: `quark-screen-${Date.now()}.png` }],
    });
    return { ok: true, summary: `Screen captured (${w}×${h}) and shown in the viewport with a download button.` };
  } catch (e) {
    return { ok: false, summary: `Screen capture failed: ${e.message}` };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

// ── audio recording ──────────────────────────────────────────────────────
export async function record_audio({ duration_seconds }, ctx) {
  const secs = Math.min(Math.max(parseInt(duration_seconds, 10) || 10, 1), 60);
  const res = await ctx.ensurePermission('microphone', { reason: `to record ${secs} seconds of audio` });
  if (res.state !== 'granted') {
    return { ok: false, summary: `Microphone access is ${res.state}; nothing was recorded.` };
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    return { ok: false, summary: `Could not open the microphone: ${e.message}` };
  }

  if (typeof MediaRecorder === 'undefined') {
    stream.getTracks().forEach((t) => t.stop());
    return { ok: false, summary: 'MediaRecorder is not supported in this browser.' };
  }

  return new Promise((resolve) => {
    const chunks = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      const url = URL.createObjectURL(blob);
      ctx.showViewport?.({
        title: 'CAPTURE // AUDIO',
        blocks: [
          { type: 'audio', src: url },
          { type: 'keyvalue', entries: [
            { k: 'Duration', v: `${secs}s requested` },
            { k: 'Format', v: rec.mimeType || 'audio/webm' },
            { k: 'Size', v: `${Math.round(blob.size / 1024)} KB` },
          ] },
        ],
        actions: [{ kind: 'download', label: 'DOWNLOAD', href: url, download: `quark-audio-${Date.now()}.webm` }],
      });
      resolve({ ok: true, summary: `Recorded ${secs}s of audio (${Math.round(blob.size / 1024)} KB); it is playing in the viewport.` });
    };
    rec.start();
    ctx.toast?.({ kind: 'ok', title: 'Recording', message: `${secs}s — microphone live` });
    setTimeout(() => { try { rec.stop(); } catch { /* already stopped */ } }, secs * 1000);
  });
}
