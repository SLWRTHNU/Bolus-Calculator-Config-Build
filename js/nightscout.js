import { storage } from './storage.js';
import { mgdlToMmol, mmolToMgdl } from './calculator.js';

async function sha1(str) {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  const hash = await crypto.subtle.digest('SHA-1', data);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function nsGet(path) {
  const config = storage.get('ns_config', {});
  const { url, secret } = config;
  if (!url) throw new Error('Nightscout URL not configured');

  const base = url.replace(/\/$/, '');
  const headers = {};
  if (secret) headers['api-secret'] = await sha1(secret);

  const resp = await fetch(`${base}${path}`, { headers });
  if (!resp.ok) throw new Error(`Nightscout error: ${resp.status}`);
  return resp.json();
}

const TREND_ARROWS = {
  TripleUp: '⤊', DoubleUp: '⇈', SingleUp: '↑', FortyFiveUp: '↗',
  Flat: '→', FortyFiveDown: '↘', SingleDown: '↓', DoubleDown: '⇊',
  TripleDown: '⤋', NotComputable: '-', RateOutOfRange: '⇕'
};

export async function fetchBG(units) {
  const data = await nsGet('/api/v1/entries/current.json');
  const entry = Array.isArray(data) ? data[0] : data;
  if (!entry) throw new Error('No BG reading');
  const mgdl = entry.sgv;
  const value = units === 'mmol' ? mgdlToMmol(mgdl) : mgdl;
  const timestamp = new Date(entry.date);
  const trend = TREND_ARROWS[entry.direction] || '';
  return { value, timestamp, raw: mgdl, trend };
}

export async function fetchIOB() {
  const data = await nsGet('/api/v1/devicestatus.json?count=1');
  const status = Array.isArray(data) ? data[0] : data;
  const iob = status?.loop?.iob?.iob ?? status?.iob?.iob ?? null;
  if (iob === null) throw new Error('IOB not available');
  return { value: Math.round(iob * 100) / 100 };
}

export async function fetchCOB() {
  const data = await nsGet('/api/v1/devicestatus.json?count=1');
  const status = Array.isArray(data) ? data[0] : data;
  const cob = status?.loop?.cob?.cob ?? status?.cob?.cob ?? null;
  if (cob === null) throw new Error('COB not available');
  return { value: Math.round(cob) };
}

export async function fetchProfile(units) {
  const data = await nsGet('/api/v1/profile.json');
  const doc = Array.isArray(data) ? data[0] : data;
  if (!doc) throw new Error('No active profile');

  const profileName = doc.defaultProfile || Object.keys(doc.store || {})[0];
  const profile = doc.store?.[profileName];
  if (!profile) throw new Error('No active profile');

  const now = new Date();
  const secondsNow = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  function getActiveValue(schedule) {
    if (!Array.isArray(schedule)) return null;
    const sorted = [...schedule].sort((a, b) => b.timeAsSeconds - a.timeAsSeconds);
    const active = sorted.find(s => s.timeAsSeconds <= secondsNow) || sorted[sorted.length - 1];
    return active?.value ?? null;
  }

  const icrRaw = getActiveValue(profile.carbratio);
  const isfRaw = getActiveValue(profile.sens);
  const targetHighRaw = getActiveValue(profile.target_high);
  const targetLowRaw = getActiveValue(profile.target_low);

  // Nightscout profiles store sens/target in whatever unit the profile itself
  // is set up in (profile.units), which may differ from the app's display
  // units. Only convert if they actually differ.
  const profileIsMmol = String(profile.units || 'mg/dl').toLowerCase().startsWith('mmol');
  const displayIsMmol = units === 'mmol';

  const convert = v => {
    if (v == null) return null;
    if (profileIsMmol && !displayIsMmol) return Math.round(mmolToMgdl(v));
    if (!profileIsMmol && displayIsMmol) return Math.round(mgdlToMmol(v) * 10) / 10;
    return displayIsMmol ? Math.round(v * 10) / 10 : Math.round(v);
  };

  return {
    icr: icrRaw,
    isf: convert(isfRaw),
    target_bg: targetHighRaw != null && targetLowRaw != null
      ? convert((targetHighRaw + targetLowRaw) / 2)
      : convert(targetHighRaw)
  };
}

export async function testConnection() {
  const data = await nsGet('/api/v1/status.json');
  return data?.status === 'ok' || !!data?.version;
}