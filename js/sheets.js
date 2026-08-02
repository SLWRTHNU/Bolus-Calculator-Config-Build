import { getAccessToken } from './auth.js';
import { storage } from './storage.js';

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export async function readFoodChart() {
  const sheetId = storage.get('food_sheet_id');
  if (!sheetId) return [];
  const token = await getAccessToken();
  if (!token) return [];

  const resp = await fetch(`${SHEETS_API}/${sheetId}/values/A2:C1000`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) return [];
  const data = await resp.json();
  if (!data.values) return [];

  return data.values
    .filter(row => row[0] && row[1])
    .map(row => ({
      name: row[0].trim(),
      carbFactor: parseFloat(row[1]) || 0,
      absorptionRate: parseFloat(row[2]) || 3.0,
      source: 'personal'
    }));
}

export async function appendFoodToChart(food) {
  const sheetId = storage.get('food_sheet_id');
  if (!sheetId) throw new Error('No food chart configured');
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const resp = await fetch(
    `${SHEETS_API}/${sheetId}/values/A:C:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[food.name, food.carbFactor, food.absorptionRate]] })
    }
  );
  if (!resp.ok) throw new Error('Failed to append food');
}

export async function exportLogToSheet(dateStr, logEntries) {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const logFolderId = storage.get('log_folder_id');
  if (!logFolderId) throw new Error('Log folder not configured');

  const date = new Date(dateStr + 'T12:00:00');
  const year = date.getFullYear().toString();
  const monthName = date.toLocaleString('en-CA', { month: 'long' });
  const day = date.getDate().toString().padStart(2, '0');
  const fileName = `${monthName} ${day} - ${year}`;

  const yearFolderId = await ensureFolder(year, logFolderId, token);
  const monthFolderId = await ensureFolder(monthName, yearFolderId, token);

  const existingFile = await findSheetInFolder(fileName, monthFolderId, token);
  let sheetId;

  if (existingFile) {
    sheetId = existingFile.id;
  } else {
    sheetId = await createNewLogSheet(fileName, monthFolderId, token);
  }

  const headers = ['Date', 'Meal', 'Food', 'Carb Factor', 'Weight (g)', 'Net Carbs (g)', 'Notes'];
  const rows = logEntries.map(e => [
    e.date, e.meal, e.food, e.carbFactor, e.weightG, e.netCarbs, e.notes || ''
  ]);

  await fetch(`${SHEETS_API}/${sheetId}/values/A1:G${rows.length + 1}?valueInputOption=RAW`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [headers, ...rows] })
  });

  return sheetId;
}

async function ensureFolder(name, parentId, token) {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`;
  const resp = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await resp.json();
  if (data.files && data.files.length > 0) return data.files[0].id;

  const createResp = await fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] })
  });
  const folder = await createResp.json();
  return folder.id;
}

async function findSheetInFolder(name, parentId, token) {
  const q = `name='${name}' and '${parentId}' in parents and trashed=false`;
  const resp = await fetch(`${DRIVE_API}/files?q=${encodeURIComponent(q)}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await resp.json();
  return data.files && data.files.length > 0 ? data.files[0] : null;
}

async function createNewLogSheet(name, parentId, token) {
  const resp = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties: { title: name }, sheets: [{ properties: { title: 'Food Log' } }] })
  });
  const sheet = await resp.json();
  const sheetId = sheet.spreadsheetId;

  await fetch(`${DRIVE_API}/files/${sheetId}/parents?removeParents=root&addParents=${parentId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }
  });

  return sheetId;
}