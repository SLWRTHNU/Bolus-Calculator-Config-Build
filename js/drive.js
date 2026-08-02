import { getAccessToken } from './auth.js';
import { storage } from './storage.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

async function driveGet(path, params = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');
  const url = new URL(DRIVE_API + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!resp.ok) throw new Error(`Drive API error: ${resp.status}`);
  return resp.json();
}

async function drivePost(path, body, isUpload = false) {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');
  const base = isUpload ? DRIVE_UPLOAD : DRIVE_API;
  const resp = await fetch(base + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Drive API error: ${resp.status} ${err}`);
  }
  return resp.json();
}

export async function findOrCreateFolder(name, parentId = null) {
  const token = await getAccessToken();
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;

  const result = await driveGet('/files', { q, fields: 'files(id,name)' });
  if (result.files && result.files.length > 0) return result.files[0].id;

  const meta = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
    ...(parentId ? { parents: [parentId] } : {})
  };
  const created = await drivePost('/files', meta);
  return created.id;
}

export async function findFile(name, parentId = null) {
  let q = `name='${name}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const result = await driveGet('/files', { q, fields: 'files(id,name)' });
  return result.files && result.files.length > 0 ? result.files[0] : null;
}

export async function writeJsonFile(name, content, parentId) {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const existing = await findFile(name, parentId);
  const json = JSON.stringify(content, null, 2);
  const blob = new Blob([json], { type: 'application/json' });

  if (existing) {
    const resp = await fetch(`${DRIVE_UPLOAD}/files/${existing.id}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: blob
    });
    if (!resp.ok) throw new Error('Failed to update config');
    return existing.id;
  }

  const meta = { name, parents: [parentId] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('file', blob);

  const resp = await fetch(`${DRIVE_UPLOAD}/files?uploadType=multipart`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });
  if (!resp.ok) throw new Error('Failed to create config');
  const result = await resp.json();
  return result.id;
}

export async function readJsonFile(fileId) {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');
  const resp = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!resp.ok) throw new Error('Failed to read file');
  return resp.json();
}

export async function createSheet(name, parentId) {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated');

  const resp = await fetch(SHEETS_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ properties: { title: name } })
  });
  if (!resp.ok) throw new Error('Failed to create sheet');
  const sheet = await resp.json();

  // Drive API v3 does not accept `parents` in a PATCH body — moving a file
  // requires the addParents/removeParents query params instead.
  const moveResp = await fetch(
    `${DRIVE_API}/files/${sheet.spreadsheetId}?addParents=${parentId}&removeParents=root&fields=id,parents`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}` }
    }
  );
  if (!moveResp.ok) {
    console.error('Failed to move sheet into folder:', await moveResp.text());
  }

  return sheet.spreadsheetId;
}

const DEFAULT_CONFIG = {
  units: 'mmol',
  theme: 'system',
  bg_source: 'manual',
  iob_source: 'manual',
  cob_source: 'manual',
  nightscout_url: '',
  nightscout_secret: '',
  dexcom_user: '',
  dexcom_pass: '',
  dexcom_region: 'us',
  meals: {
    breakfast:       { icr: null, isf: null, target_bg: null },
    morning_snack:   { icr: null, isf: null, target_bg: null },
    lunch:           { icr: null, isf: null, target_bg: null },
    afternoon_snack: { icr: null, isf: null, target_bg: null },
    dinner:          { icr: null, isf: null, target_bg: null },
    evening_snack:   { icr: null, isf: null, target_bg: null }
  }
};

export async function setupDriveFolders(folderName = 'Bolus Calculator') {
  const rootId = await findOrCreateFolder(folderName);
  storage.set('drive_folder_id', rootId);

  const configFolderId = await findOrCreateFolder('Config', rootId);
  storage.set('drive_config_folder_id', configFolderId);

  const exportsFolderId = await findOrCreateFolder('Exports', rootId);
  storage.set('drive_exports_folder_id', exportsFolderId);

  const existing = await findFile('config.json', configFolderId);
  const configWasNew = !existing;
  if (!existing) {
    await writeJsonFile('config.json', DEFAULT_CONFIG, configFolderId);
  }

  const existingSheet = await findFile('Food Chart', configFolderId);
  let sheetId;
  if (existingSheet) {
    sheetId = existingSheet.id;
  } else {
    sheetId = await createSheet('Food Chart', configFolderId);
    await initFoodChartHeaders(sheetId);
  }
  storage.set('food_sheet_id', sheetId);

  return { rootId, configFolderId, exportsFolderId, sheetId, configWasNew };
}

async function initFoodChartHeaders(sheetId) {
  const token = await getAccessToken();
  await fetch(`${SHEETS_API}/${sheetId}/values/A1:C1?valueInputOption=RAW`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: [['Food Name', 'Carb Factor', 'Absorption Rate (hours)']] })
  });
}

export async function loadConfig() {
  const folderId = storage.get('drive_config_folder_id');
  if (!folderId) return null;
  const file = await findFile('config.json', folderId);
  if (!file) return null;
  return readJsonFile(file.id);
}

export async function saveConfig(config) {
  const folderId = storage.get('drive_config_folder_id');
  if (!folderId) return;
  await writeJsonFile('config.json', config, folderId);
}

export async function getDriveFileUrl(fileId) {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

export async function getSheetUrl(sheetId) {
  return `https://docs.google.com/spreadsheets/d/${sheetId}`;
}