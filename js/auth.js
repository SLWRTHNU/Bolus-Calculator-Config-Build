import { storage } from './storage.js';

const GOOGLE_CLIENT_ID = '79990057872-3q4vcas2m1m99l55g8o3hg14pk601q7f.apps.googleusercontent.com';
// TEMPORARY: needed because this Client ID is a "Web application" type, which
// Google treats as a confidential client requiring a secret even with PKCE.
// This should not stay here long-term — a secret embedded in public JS can be
// read by anyone. Follow-up: switch to a client type that doesn't need one.
const GOOGLE_CLIENT_SECRET = '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';
const REDIRECT_URI = window.location.origin + window.location.pathname.replace(/\/$/, '');
const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
  'openid'
].join(' ');

function generateRandom(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function startOAuth() {
  const verifier = generateRandom(32);
  const challenge = await sha256(verifier);
  const state = generateRandom(16);

  sessionStorage.setItem('pkce_verifier', verifier);
  sessionStorage.setItem('oauth_state', state);

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent'
  });

  window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

export async function handleOAuthCallback(code, state) {
  const savedState = sessionStorage.getItem('oauth_state');
  const verifier = sessionStorage.getItem('pkce_verifier');
  console.log('[oauth] state match:', state === savedState, 'verifier present:', !!verifier);

  if (state !== savedState) throw new Error('OAuth state mismatch');

  console.log('[oauth] requesting token from Google…');
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier
    })
  });
  console.log('[oauth] token endpoint responded, status:', resp.status);

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    console.error('[oauth] token endpoint error body:', err);
    throw new Error(err.error_description || 'Token exchange failed');
  }

  const tokens = await resp.json();
  const expiry = Date.now() + tokens.expires_in * 1000;
  storage.set('google_token', {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry
  });

  sessionStorage.removeItem('pkce_verifier');
  sessionStorage.removeItem('oauth_state');

  const userInfo = await fetchUserInfo(tokens.access_token);
  if (userInfo.email) storage.set('google_email', userInfo.email);

  return tokens.access_token;
}

async function fetchUserInfo(accessToken) {
  const resp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  return resp.ok ? resp.json() : {};
}

export async function getAccessToken() {
  const stored = storage.get('google_token');
  if (!stored) return null;

  if (Date.now() < stored.expiry - 60000) return stored.access_token;

  if (!stored.refresh_token) {
    storage.remove('google_token');
    return null;
  }

  return refreshToken(stored.refresh_token);
}

async function refreshToken(refreshToken) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    })
  });

  if (!resp.ok) {
    storage.remove('google_token');
    return null;
  }

  const tokens = await resp.json();
  const stored = storage.get('google_token', {});
  storage.set('google_token', {
    ...stored,
    access_token: tokens.access_token,
    expiry: Date.now() + tokens.expires_in * 1000
  });

  return tokens.access_token;
}

export function isConnected() {
  return !!storage.get('google_token');
}

export function disconnect() {
  storage.remove('google_token');
  storage.remove('google_email');
  storage.remove('drive_folder_id');
  storage.remove('food_sheet_id');
  storage.remove('log_folder_id');
}