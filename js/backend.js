const BACKEND_URL = 'https://script.google.com/macros/s/AKfycbw28n2cHg4A9VDFuv6QwERwD34j1cXiliE93y7s7GrhZhTJhvuWTM_krX-3PUEOaXzh/exec';
const API_KEY = '7111b81a-d010-435f-a92e-7908613ee4bb';

async function backendGet(action, extraParams = {}) {
  const params = new URLSearchParams({ action, key: API_KEY, ...extraParams });
  const resp = await fetch(`${BACKEND_URL}?${params}`);
  return resp.json();
}

async function backendPost(action, body) {
  const params = new URLSearchParams({ action, key: API_KEY });
  // IMPORTANT: do NOT set a Content-Type header. Apps Script web apps don't
  // handle CORS preflight (OPTIONS), so setting Content-Type: application/json
  // triggers a preflight that fails. Sending body as a plain string with no
  // headers defaults to text/plain, which avoids preflight. Apps Script still
  // reads it correctly via JSON.parse(e.postData.contents).
  const resp = await fetch(`${BACKEND_URL}?${params}`, {
    method: 'POST',
    body: JSON.stringify(body)
  });
  return resp.json();
}

export async function ping() {
  try {
    const r = await backendGet('ping');
    return !!r.ok;
  } catch { return false; }
}

export async function restoreDraftState() {
  const r = await backendGet('restoreDraftState');
  return r.success ? r.draft : null;
}

export async function getConfig() {
  const r = await backendGet('getConfig');
  return r.success ? r.config : null;
}

export async function setConfig(config) {
  const r = await backendPost('setConfig', { config });
  return r.success ? r.config : null;
}

export async function getFoodChart() {
  const r = await backendGet('getFoodChart');
  return r.success ? r.foods : [];
}

export async function addFood(food) {
  return backendPost('addFood', food);
}

export async function searchFood(query) {
  const r = await backendGet('search', { q: query });
  return r.success ? r.rows : [];
}

export async function logMeal(payload) {
  // payload: { meals: [...] } — rich per-meal objects for pretty Doc export
  return backendPost('logMeal', payload);
}

export async function getDraftState() {
  const r = await backendGet('getDraftState');
  return r.success ? r.draft : null;
}

export async function setDraftState(slug, mealData) {
  return backendPost('setDraftState', { slug, mealData });
}

export async function snapshotDraftState() {
  if (!navigator.onLine) return;
  try { await backendGet('snapshotDraftState'); } catch {}
}
