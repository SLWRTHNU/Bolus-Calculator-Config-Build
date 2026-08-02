// Drop-in replacement for backend.js — same function signatures, but backed
// by the signed-in user's own Google Drive instead of a shared Apps Script
// deployment. Swap the import in app.js from './backend.js' to
// './drive-backend.js' to switch over.

import { getAccessToken, isConnected } from './auth.js';
import {
  setupDriveFolders, loadConfig, saveConfig, findFile, writeJsonFile,
  readJsonFile, createSheet, findOrCreateFolder
} from './drive.js';
import { storage, MEAL_SLUGS, getMealSettings } from './storage.js';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

let setupDone = false;

function buildConfigSnapshotFromLocalStorage() {
  const meals = {};
  MEAL_SLUGS.forEach(slug => { meals[slug] = getMealSettings(slug); });
  const ns = storage.get('ns_config') || {};
  const dex = storage.get('dexcom_config') || {};
  return {
    units: storage.get('units', 'mmol'),
    color_theme: storage.get('color_theme', 'custom'),
    mode: storage.get('mode', 'system'),
    nightscout_url: ns.url || '',
    nightscout_secret: ns.secret || '',
    dexcom_user: dex.user || '',
    dexcom_pass: dex.pass || '',
    dexcom_region: dex.region || 'us',
    meals
  };
}

async function ensureSetup() {
  if (setupDone) return;
  const result = await setupDriveFolders();
  if (result.configWasNew) {
    // First time this Drive folder is being set up — seed config.json with
    // the user's CURRENT local settings instead of leaving Drive's blank
    // defaults, so nothing already configured gets wiped out.
    await saveConfig(buildConfigSnapshotFromLocalStorage());
  }
  setupDone = true;
}

// Returns the sheet ID for the month a given date falls in, creating the
// year folder (e.g. "2026") and month sheet (e.g. "2026-07") inside Exports
// if they don't exist yet. Mirrors the old Apps Script year/month layout.
async function ensureMealLogSheetForDate(dateStr) {
  const [year, month] = dateStr.split('-');
  const cacheKey = `meal_log_sheet_${year}_${month}`;
  const cached = storage.get(cacheKey);
  if (cached) return cached;

  const exportsFolderId = storage.get('drive_exports_folder_id');
  const yearFolderId = await findOrCreateFolder(year, exportsFolderId);

  const sheetName = `${year}-${month}`;
  const existing = await findFile(sheetName, yearFolderId);
  let sheetId;
  if (existing) {
    sheetId = existing.id;
  } else {
    sheetId = await createSheet(sheetName, yearFolderId);
    const token = await getAccessToken();
    await fetch(`${SHEETS_API}/${sheetId}/values/A1:G1?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [['Date', 'Meal', 'Food', 'Carb Factor', 'Weight (g)', 'Net Carbs (g)', 'Notes']] })
    });
  }
  storage.set(cacheKey, sheetId);
  return sheetId;
}

export async function ping() {
  return isConnected();
}

export async function getConfig() {
  if (!isConnected()) return null;
  await ensureSetup();
  return loadConfig();
}

export async function setConfig(config) {
  if (!isConnected()) return null;
  await ensureSetup();
  await saveConfig(config);
  return config;
}

export async function getFoodChart() {
  if (!isConnected()) return [];
  await ensureSetup();
  const sheetId = storage.get('food_sheet_id');
  const token = await getAccessToken();
  const resp = await fetch(`${SHEETS_API}/${sheetId}/values/A2:C1000`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  return (data.values || [])
    .map(row => ({
      name: row[0] || '',
      cf: parseFloat(row[1]) || null,
      abs: parseFloat(row[2]) || null
    }))
    .filter(f => f.name);
}

export async function addFood(food) {
  if (!isConnected()) return { success: false };
  await ensureSetup();
  const sheetId = storage.get('food_sheet_id');
  const token = await getAccessToken();
  const resp = await fetch(`${SHEETS_API}/${sheetId}/values/A:C:append?valueInputOption=RAW`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [[food.name, food.cf, food.abs]] })
  });
  return { success: resp.ok };
}

export async function searchFood(query) {
  // No dedicated search endpoint needed — filter the food chart directly.
  const chart = await getFoodChart();
  const q = query.toLowerCase();
  return chart.filter(f => f.name.toLowerCase().includes(q));
}

export async function logMeal(payload) {
  if (!isConnected()) return { success: false };
  await ensureSetup();
  const token = await getAccessToken();

  let rows = [];
  if (Array.isArray(payload)) {
    // Already flattened row arrays (from entriesToRows()) — each row carries
    // its own date already, so just group by date below.
    rows = payload;
  } else if (payload && Array.isArray(payload.meals)) {
    // payload.date lets the nightly export pass the actual day being
    // exported (yesterday), instead of defaulting to today's date.
    const date = payload.date || new Date().toISOString().slice(0, 10);
    payload.meals.forEach(m => (m.foods || []).forEach(f => {
      rows.push([date, m.name, f.name, f.carbFactor ?? '', f.weightGiven, f.netCarbs, m.notes || '']);
    }));
  }

  if (rows.length === 0) return { success: true };

  // Group rows by the month they belong to, in case a batch spans a month
  // boundary, then append each group to its own month's sheet.
  const byMonth = {};
  for (const row of rows) {
    const dateStr = String(row[0] || '').slice(0, 7); // "YYYY-MM"
    if (!byMonth[dateStr]) byMonth[dateStr] = [];
    byMonth[dateStr].push(row);
  }

  let allOk = true;
  for (const monthKey of Object.keys(byMonth)) {
    const fullDate = byMonth[monthKey][0][0]; // "YYYY-MM-DD"
    const sheetId = await ensureMealLogSheetForDate(fullDate);
    const resp = await fetch(`${SHEETS_API}/${sheetId}/values/A:G:append?valueInputOption=RAW`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: byMonth[monthKey] })
    });
    if (!resp.ok) allOk = false;
  }
  return { success: allOk };
}

async function loadDraftFile() {
  const folderId = storage.get('drive_config_folder_id');
  if (!folderId) return {};
  const file = await findFile('draft.json', folderId);
  if (!file) return {};
  return (await readJsonFile(file.id)) || {};
}

export async function getDraftState() {
  if (!isConnected()) return null;
  await ensureSetup();
  const data = await loadDraftFile();
  return { success: true, draft: { data } };
}

export async function setDraftState(slug, mealData) {
  if (!isConnected()) return { success: false };
  await ensureSetup();
  const folderId = storage.get('drive_config_folder_id');
  const current = await loadDraftFile();
  current[slug] = mealData;
  await writeJsonFile('draft.json', current, folderId);
  return { success: true };
}

export async function snapshotDraftState() {
  // Drive writes happen immediately in setDraftState, so there's nothing to
  // separately snapshot — kept as a no-op for interface compatibility.
  return { success: true };
}

export async function restoreDraftState() {
  const result = await getDraftState();
  return result ? result.draft : null;
}
