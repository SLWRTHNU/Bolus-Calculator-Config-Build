import { storage } from './storage.js';
import { mgdlToMmol } from './calculator.js';

const ENDPOINTS = {
  us:            'https://share2.dexcom.com',
  international: 'https://shareous1.dexcom.com'
};

const APP_ID = 'd8665ade-9673-4e27-9ff6-92db4ce13d13';

// Newer Dexcom Share responses return Trend as a string (e.g. "Flat").
// Older responses (and some regions/accounts) return the old numeric 1-7 code.
// This map handles both.
const TREND_MAP = {
  1: '⇈', 2: '↑', 3: '↗', 4: '→', 5: '↘', 6: '↓', 7: '⇊',
  DoubleUp: '⇈', SingleUp: '↑', FortyFiveUp: '↗', Flat: '→',
  FortyFiveDown: '↘', SingleDown: '↓', DoubleDown: '⇊',
  NotComputable: '?', RateOutOfRange: '?', None: '?'
};

let sessionId = null;

async function dexFetch(base, path, bodyObj) {
  const resp = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: bodyObj ? JSON.stringify(bodyObj) : undefined
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${path} failed: HTTP ${resp.status} — ${text}`);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${path} returned non-JSON: ${text}`); }
  return parsed;
}

async function loginByName(base, user, pass) {
  const id = await dexFetch(base, '/ShareWebServices/Services/General/LoginPublisherAccountByName', {
    accountName: user, password: pass, applicationId: APP_ID
  });
  if (!id || id === '00000000-0000-0000-0000-000000000000') {
    throw new Error('LoginPublisherAccountByName returned an empty session');
  }
  return id;
}

// Fallback flow: some accounts (confirmed: phone/email-based accounts on the
// international region) don't return a session from LoginPublisherAccountByName
// and need this two-step flow instead.
async function loginByAuthenticateThenId(base, user, pass) {
  const accountId = await dexFetch(base, '/ShareWebServices/Services/General/AuthenticatePublisherAccount', {
    accountName: user, password: pass, applicationId: APP_ID
  });
  if (!accountId || accountId === '00000000-0000-0000-0000-000000000000') {
    throw new Error('AuthenticatePublisherAccount returned an empty account ID');
  }
  const sid = await dexFetch(base, '/ShareWebServices/Services/General/LoginPublisherAccountById', {
    accountId, password: pass, applicationId: APP_ID
  });
  if (!sid || sid === '00000000-0000-0000-0000-000000000000') {
    throw new Error('LoginPublisherAccountById returned an empty session');
  }
  return sid;
}

async function getSession() {
  const config = storage.get('dexcom_config', {});
  const { user, pass, region = 'us' } = config;
  if (!user || !pass) throw new Error('Dexcom credentials not configured');

  const base = ENDPOINTS[region] || ENDPOINTS.us;

  try {
    sessionId = await loginByName(base, user, pass);
  } catch (e1) {
    sessionId = await loginByAuthenticateThenId(base, user, pass);
  }
  return sessionId;
}

function parseDexDate(field) {
  if (!field) return null;
  // Handles both "Date(1234567890)" and "\/Date(1234567890)\/" formats.
  const m = field.match(/Date\((-?\d+)/);
  return m ? new Date(parseInt(m[1], 10)) : null;
}

export async function fetchBG(units) {
  const config = storage.get('dexcom_config', {});
  const base = ENDPOINTS[config.region || 'us'];

  if (!sessionId) await getSession();

  let readings;
  try {
    readings = await dexFetch(
      base,
      `/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${sessionId}&minutes=1440&maxCount=2`,
      null
    );
  } catch (e) {
    // Session likely expired — re-login once and retry.
    sessionId = null;
    await getSession();
    readings = await dexFetch(
      base,
      `/ShareWebServices/Services/Publisher/ReadPublisherLatestGlucoseValues?sessionId=${sessionId}&minutes=1440&maxCount=2`,
      null
    );
  }

  if (!readings || readings.length === 0) throw new Error('No Dexcom reading available');

  const r = readings[0];
  const prev = readings[1];
  const mgdl = r.Value;
  const value = units === 'mmol' ? mgdlToMmol(mgdl) : mgdl;
  const timestamp = parseDexDate(r.WT);
  const delta = prev ? r.Value - prev.Value : null;
  const deltaOut = delta === null ? null : (units === 'mmol' ? mgdlToMmol(Math.abs(delta)) * Math.sign(delta) : delta);

  return {
    value,
    delta: deltaOut,
    timestamp,
    trend: TREND_MAP[r.Trend] || '→',
    raw: mgdl
  };
}

export async function testConnection() {
  await getSession();
  return true;
}
