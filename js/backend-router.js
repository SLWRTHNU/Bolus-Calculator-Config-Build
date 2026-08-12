// Routes every backend call to either the existing Apps Script backend or
// the new Drive-based one, depending on a Settings toggle. This lets us test
// drive-backend.js safely without touching the working Apps Script path.
// Once Drive is confirmed solid, app.js can import drive-backend.js directly
// and this file (and backend.js) can be removed.

import * as appsScriptBackend from './backend.js';
import * as driveBackend from './drive-backend.js';
import { storage } from './storage.js';

function activeBackend() {
  return storage.get('use_drive_backend', false) ? driveBackend : appsScriptBackend;
}

export const ping                = (...args) => activeBackend().ping(...args);
export const getConfig           = (...args) => activeBackend().getConfig(...args);
export const setConfig           = (...args) => activeBackend().setConfig(...args);
export const getFoodChart        = (...args) => activeBackend().getFoodChart(...args);
export const addFood             = (...args) => activeBackend().addFood(...args);
export const searchFood          = (...args) => activeBackend().searchFood(...args);
export const logMeal             = (...args) => activeBackend().logMeal(...args);
export const getDraftState       = (...args) => activeBackend().getDraftState(...args);
export const setDraftState       = (...args) => activeBackend().setDraftState(...args);
export const snapshotDraftState  = (...args) => activeBackend().snapshotDraftState(...args);
export const restoreDraftState   = (...args) => activeBackend().restoreDraftState(...args);

export function isDriveBackendActive() {
  return storage.get('use_drive_backend', false);
}

export function setDriveBackendActive(on) {
  storage.set('use_drive_backend', !!on);
}
