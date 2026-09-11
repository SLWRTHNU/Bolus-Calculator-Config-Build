// Drop-in replacement for backend.js — same function signatures, but backed
// by the signed-in user's own Google Drive instead of a shared Apps Script
// deployment. Swap the import in app.js from './backend.js' to
// './drive-backend.js' to switch over.

import { getAccessToken, isConnected } from './auth.js';
import {
  setupDriveFolders, loadConfig, saveConfig, findFile, writeJsonFile,
  readJsonFile, createSheet, findOrCreateFolder
} from './drive.js';
import { getOrCreateDoc, clearDoc, writeDayDoc } from './drive-docs.js';
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

// The "Food Search Index" sheet lives alongside the Food Chart in the Config
// folder — one row per food eaten, appended on every successful day export,
// so the food search panel can look up past meals without touching the
// per-day export Docs themselves.
async function ensureFoodSearchIndexSheet() {
  const cacheKey = 'food_search_index_sheet_id';
  const cached = storage.get(cacheKey);
  if (cached) return cached;

  const configFolderId = storage.get('drive_config_folder_id');
  const existing = await findFile('Food Search Index', configFolderId);
  let sheetId;
  if (existing) {
    sheetId = existing.id;
  } else {
    sheetId = await createSheet('Food Search Index', configFolderId);
    const token = await getAccessToken();
    await fetch(`${SHEETS_API}/${sheetId}/values/A1:G1?valueInputOption=RAW`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [['Date', 'Meal', 'Food', 'Carb Factor', 'Weight', 'Net Carbs', 'Doc URL']] })
    });
  }
  storage.set(cacheKey, sheetId);
  return sheetId;
}

async function appendFoodSearchIndexRows(meals, dateStr, docUrl) {
  const rows = [];
  meals.forEach(m => {
    if (!m.hasData) return;
    (m.foods || []).forEach(f => {
      rows.push([dateStr, m.name, f.name, f.carbFactor ?? '', f.weightGiven ?? '', f.netCarbs ?? '', docUrl]);
    });
  });
  if (!rows.length) return;

  const sheetId = await ensureFoodSearchIndexSheet();
  const token = await getAccessToken();
  await fetch(`${SHEETS_API}/${sheetId}/values/A:G:append?valueInputOption=RAW`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: rows })
  });
}

// Exports/{year}/{MM - MonthName}/{MonthName DD - YYYY} — the Doc name and
// its two containing folders, reusing findOrCreateFolder for both levels.
async function ensureExportDocForDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const localDate = new Date(year, month - 1, day);
  const monthName = localDate.toLocaleString('en-CA', { month: 'long' });
  const monthNum = String(month).padStart(2, '0');
  const dayNum = String(day).padStart(2, '0');

  const exportsFolderId = storage.get('drive_exports_folder_id');
  const yearFolderId = await findOrCreateFolder(String(year), exportsFolderId);
  const monthFolderId = await findOrCreateFolder(`${monthNum} - ${monthName}`, yearFolderId);
  const docName = `${monthName} ${dayNum} - ${year}`;
  const docId = await getOrCreateDoc(docName, monthFolderId);

  const dayLabel = localDate.toLocaleDateString('en-CA', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  return { docId, dayLabel };
}

function formatFoodLine(f) {
  const details = [];
  if (f.carbFactor != null && f.carbFactor !== '') details.push(`CF: ${f.carbFactor}`);
  if (f.absorptionRate != null && f.absorptionRate !== '') details.push(`Absorption: ${f.absorptionRate}h`);
  if (f.weightGiven != null && f.weightGiven !== '') details.push(`Weight: ${f.weightGiven}g`);
  if (f.netCarbs != null && f.netCarbs !== '') details.push(`Net Carbs: ${f.netCarbs}g`);
  let line = details.length ? `${f.name} — ${details.join(' | ')}` : f.name;
  if (f.recipeIngredients && f.recipeIngredients.length) {
    line += `\n  Ingredients: ${f.recipeIngredients.map(i => `${i.name} (${i.weightG}g)`).join(', ')}`;
  }
  return line;
}

// One of three states per meal: no data at all, data with a bolus locked in
// (foods + notes + the full calc breakdown), or data with no bolus given yet
// (foods + notes only). No charts, graphs, or post-meal BG tables — those
// never belong in the export Doc.
function buildMealSection(meal) {
  if (!meal.hasData) {
    return { heading: meal.name, body: '-No Meal Data Entered-' };
  }

  const lines = (meal.foods || []).map(formatFoodLine);

  if (meal.bolusLocked) {
    lines.push(`Carb Ratio: ${meal.carbRatio ?? '—'} | Target: ${meal.target ?? '—'} | ISF: ${meal.isf ?? '—'}`);
    lines.push(`Current BG: ${meal.currentBG || '—'} | Total Net Carbs: ${meal.totalNetCarbs ?? '—'}`);
    lines.push(`IOB: ${meal.iob || 0} | COB: ${meal.cob || 0}`);
    lines.push(`Meal Bolus: ${meal.mealBolus ?? 0} U`);
    lines.push(`Correction Bolus: ${meal.correctionBolus ?? 0} U`);
    lines.push(`Total Bolus: ${meal.totalBolus ?? 0} U`);
    lines.push(`Bolus Time: ${meal.bolusTime || '—'} | Eat Time: ${meal.eatTime || '—'}`);
  }

  if (meal.notes && meal.notes.trim()) {
    lines.push('-- Notes --');
    lines.push(meal.notes.trim());
  }

  return { heading: meal.name, body: lines.join('\n') };
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
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store'
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
  if (!isConnected()) return [];
  await ensureSetup();
  const sheetId = await ensureFoodSearchIndexSheet();
  const token = await getAccessToken();
  const resp = await fetch(`${SHEETS_API}/${sheetId}/values/A2:G5000`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store'
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  const q = (query || '').toLowerCase();
  return (data.values || [])
    .map(row => ({
      date: row[0] || '',
      meal: row[1] || '',
      food: row[2] || '',
      cf: row[3] !== '' && row[3] != null ? parseFloat(row[3]) : null,
      wt: row[4] !== '' && row[4] != null ? parseFloat(row[4]) : null,
      carbs: row[5] !== '' && row[5] != null ? parseFloat(row[5]) : null,
      url: row[6] || ''
    }))
    .filter(r => r.food && r.food.toLowerCase().includes(q))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 50);
}

// payload: { meals, date, units } where meals is all 6 slots (see
// buildDayExportPayload in app.js), each carrying a `hasData`/`bolusLocked`
// flag. Writes one Google Doc per day — replacing the old flat-row monthly
// sheet — and appends every logged food to the Food Search Index sheet.
export async function logMeal(payload) {
  if (!isConnected()) return { success: false };
  await ensureSetup();
  if (!payload || !Array.isArray(payload.meals)) return { success: false };

  const dateStr = payload.date || new Date().toISOString().slice(0, 10);

  try {
    const { docId, dayLabel } = await ensureExportDocForDate(dateStr);
    await clearDoc(docId);
    await writeDayDoc(docId, dayLabel, payload.meals.map(buildMealSection));

    const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
    await appendFoodSearchIndexRows(payload.meals, dateStr, docUrl);

    return { success: true, docId, docUrl };
  } catch (err) {
    console.error('logMeal (Docs export) failed:', err);
    return { success: false, error: err.message };
  }
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
