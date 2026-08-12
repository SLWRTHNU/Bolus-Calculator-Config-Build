import { storage, MEAL_SLUGS, MEAL_LABELS, getMealSettings, setMealSettings, getTodayLog, appendToLog, setTodayLog } from './storage.js';
import { calcBolus, calcNetCarbs, calcWeightFromCarbs, calcCompositeCF, formatBG, mgdlToMmol, mmolToMgdl } from './calculator.js';
import { HEALTH_CANADA_FOODS } from './fooddata.js';
import { ping, getConfig, setConfig, getFoodChart, logMeal, searchFood, addFood, getDraftState, setDraftState, snapshotDraftState, restoreDraftState, isDriveBackendActive, setDriveBackendActive } from './backend-router.js';
import { fetchBG as nsBG, fetchIOB as nsIOB, fetchCOB as nsCOB, fetchProfile as nsProfile } from './nightscout.js';
import { fetchBG as dexBG } from './dexcom.js';
import { startOAuth, handleOAuthCallback, isConnected as isDriveConnected, disconnect as disconnectDrive } from './auth.js';
import {
  showToast, applyTheme, applyColorTheme, applyMode, initTheme,
  navigate, getCurrentSection, debounce,
  createFoodDropdown, positionDropdown,
  showSpinner, hideSpinner,
  formatTime, todayStr, elapsedMMSS,
  toggleToolsDropdown, openRecipePanel, closeRecipePanel,
  openFoodSearchPanel, closeFoodSearchPanel,
  openAddFoodPanel, closeAddFoodPanel
} from './ui.js';

// ─── STATE ─────────────────────────────────────────────────────────────────── 

let state = {
  activeMeal: 'breakfast',
  meals: {},
  personalFoods: [],
  config: null,
  units: 'mmol',
  connected: false,
  bolusLockedAt: {},
  mealLockedAt: {},
  bolusTimerID: null,
  nsPollID: null,
  recipes: [],
  activeRecipeIndex: 0
};

MEAL_SLUGS.forEach(slug => {
  state.meals[slug] = {
    foods: [], currentBG: '', iob: '', cob: '',
    postBgReadings: [], notes: '', bgTimestamp: null, bgTrend: null,
    lastSyncAt: null,
    entryFood: { name: '', carbFactor: null, weightG: '', carbsG: '', absorptionRate: 3.0 }
  };
  state.bolusLockedAt[slug] = null;
  state.mealLockedAt[slug]  = null;
});

state.recipes.push(createRecipe());

function createRecipe(name = '') {
  return { name, ingredients: [], entryFood: { name: '', carbFactor: null, weightG: '', carbsG: '' } };
}

// ─── GOOGLE DRIVE OAUTH (testing — not yet used for real data) ────────────────

async function handleDriveOAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  const oauthState = params.get('state');
  console.log('[oauth] redirect check — code present:', !!code, 'state present:', !!oauthState);
  if (!code || !oauthState) return;

  console.log('[oauth] found code+state, exchanging for token…');
  try {
    await handleOAuthCallback(code, oauthState);
    console.log('[oauth] token exchange succeeded');
    showToast('Google Drive connected', 'success');
  } catch (err) {
    console.error('[oauth] token exchange FAILED:', err);
    showToast('Drive connect failed: ' + err.message, 'error');
  } finally {
    const cleanUrl = window.location.origin + window.location.pathname;
    window.history.replaceState({}, document.title, cleanUrl);
  }
}

function setupDriveConnectionUI() {
  const statusEl = document.getElementById('gdrive-status');
  const connectBtn = document.getElementById('connect-drive-btn');
  const disconnectBtn = document.getElementById('disconnect-drive-btn');
  const backendToggle = document.getElementById('use-drive-backend-toggle');
  if (!statusEl || !connectBtn || !disconnectBtn) return;

  function render() {
    const email = storage.get('google_email');
    if (isDriveConnected()) {
      statusEl.textContent = email ? `Connected as ${email}` : 'Connected';
      statusEl.className = 'drive-status drive-status--connected';
      connectBtn.hidden = true;
      disconnectBtn.hidden = false;
    } else {
      statusEl.textContent = 'Not connected';
      statusEl.className = 'drive-status';
      connectBtn.hidden = false;
      disconnectBtn.hidden = true;
    }
  }

  connectBtn.addEventListener('click', async () => {
    try {
      await startOAuth();
    } catch (err) {
      showToast('Could not start Google sign-in: ' + err.message, 'error');
      console.error('startOAuth error:', err);
    }
  });
  disconnectBtn.addEventListener('click', () => {
    disconnectDrive();
    render();
    showToast('Google Drive disconnected', 'info');
  });

  if (backendToggle) {
    backendToggle.checked = isDriveBackendActive();
    backendToggle.addEventListener('change', () => {
      setDriveBackendActive(backendToggle.checked);
      showToast(
        backendToggle.checked ? 'Switching to Drive backend…' : 'Switching to Apps Script backend…',
        'info'
      );
      setTimeout(() => window.location.reload(), 600);
    });
  }

  render();
}

// ─── INIT ────────────────────────────────────────────────────────────────────

async function init() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  }
  initTheme();
  state.units = storage.get('units', 'mmol');

  await handleDriveOAuthRedirect();
  setupDriveConnectionUI();

  renderAll();
  setupNavigation();
  setupMobileCalcTabs();
  setupTimingCard();
  setupFoodEntryRow();
  setupCustomFoodPanel();
  setupToolsMenu();
  setupRecipePanel();
  setupFoodSearchPanel();
  setupAddFoodPanel();
  setupPostMealTracker();
  setupExportTimer();
  setInterval(refreshFoodChart, 60000);
  navigate(getCurrentSection());
  setTimeout(() => window.scrollTo(0, 0), 0);

  state.connected = await ping();
  updateConnectionStatus();
  if (state.connected) await postBackendSetup();
  setupNightscoutPolling();
  setInterval(updateSyncIndicator, 1000);
}

async function postBackendSetup() {
  try {
    const config = await getConfig();
    if (config) { state.config = config; applyConfig(config); }
    state.personalFoods = await getFoodChart();

    const draft = await getDraftState();
    if (draft && draft.data && Object.keys(draft.data).length > 0) {
      applyDraftToState(draft.data);
    }
    if (draft && draft.data && draft.data.recipes && draft.data.recipes.length) {
      state.recipes = draft.data.recipes.map(r => ({
        name: r.name || '',
        ingredients: r.ingredients || [],
        entryFood: { name: '', carbFactor: null, weightG: '', carbsG: '' }
      }));
      state.activeRecipeIndex = 0;
    }

    renderAll();
    renderSettingsSection();
    setupNightscoutPolling();
    clearBolusTimer();
    startBolusTimerIfLocked();
  } catch (err) { showToast('Backend sync error: ' + err.message, 'error'); }
}

function updateConnectionStatus() {
  const statusEl = document.getElementById('backend-status');
  if (!statusEl) return;
  if (state.connected) {
    statusEl.textContent = 'Connected';
    statusEl.className = 'drive-status drive-status--connected';
  } else {
    statusEl.textContent = 'Offline — using local data';
    statusEl.className = 'drive-status';
  }
}

function triggerSnapshot() {
  if (!state.connected) return;
  snapshotDraftState();
}

function applyConfig(config) {
  if (config.units)       { state.units = config.units; storage.set('units', config.units); }
  if (config.color_theme) applyColorTheme(config.color_theme);
  if (config.mode)        applyMode(config.mode);
  if (config.theme && !config.mode && !config.color_theme) applyTheme(config.theme);
  if (config.nightscout_url) storage.set('ns_config',    { url: config.nightscout_url, secret: config.nightscout_secret });
  if (config.dexcom_user)    storage.set('dexcom_config', { user: config.dexcom_user,  pass: config.dexcom_pass, region: config.dexcom_region });
  if (config.meals) MEAL_SLUGS.forEach(slug => { if (config.meals[slug]) setMealSettings(slug, config.meals[slug]); });
}

// ─── SOURCE AUTO-DETECT ──────────────────────────────────────────────────────

function inferBGSource() {
  const dex = storage.get('dexcom_config'); if (dex?.user) return 'dexcom';
  const ns  = storage.get('ns_config');    if (ns?.url)   return 'nightscout';
  return 'manual';
}
function inferIOBSource() { const ns = storage.get('ns_config'); return ns?.url ? 'nightscout' : 'manual'; }
function inferCOBSource() { const ns = storage.get('ns_config'); return ns?.url ? 'nightscout' : 'manual'; }

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function getCurrentMeal()         { return state.meals[state.activeMeal]; }
function getCurrentMealSettings() { return getMealSettings(state.activeMeal); }

function setVal(id, value)  { const el = document.getElementById(id); if (el) el.value = value ?? ''; }
function setText(id, text)  { const el = document.getElementById(id); if (el) el.textContent = text; }
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function timeInputToDate(timeStr) {
  if (!timeStr) return null;
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  if (d > new Date()) d.setDate(d.getDate() - 1);
  return d;
}

function hhmm(date) {
  return date.toTimeString().slice(0, 5); // HH:MM for time inputs
}

function hhmmDisplay(date) {
  return date.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function serializeMealsForDraft() {
  const out = {};
  MEAL_SLUGS.forEach(slug => {
    const meal = state.meals[slug];
    out[slug] = {
      foods: meal.foods,
      currentBG: meal.currentBG,
      iob: meal.iob,
      cob: meal.cob,
      notes: meal.notes,
      postBgReadings: meal.postBgReadings,
      bgTimestamp: meal.bgTimestamp ? meal.bgTimestamp.toISOString() : null,
      bgTrend: meal.bgTrend,
      bolusLockedAt: state.bolusLockedAt[slug] ? state.bolusLockedAt[slug].toISOString() : null,
      mealLockedAt: state.mealLockedAt[slug] ? state.mealLockedAt[slug].toISOString() : null
    };
  });
  return out;
}

function serializeMealForDraft(slug) {
  const meal = state.meals[slug];
  return {
    foods: meal.foods, currentBG: meal.currentBG, cob: meal.cob, notes: meal.notes,
    postBgReadings: meal.postBgReadings,
    bgTimestamp: meal.bgTimestamp ? meal.bgTimestamp.toISOString() : null,
    bgTrend: meal.bgTrend,
    bolusLockedAt: state.bolusLockedAt[slug] ? state.bolusLockedAt[slug].toISOString() : null,
    mealLockedAt: state.mealLockedAt[slug] ? state.mealLockedAt[slug].toISOString() : null
  };
}

function applyDraftToState(draftData) {
  if (!draftData) return;
  MEAL_SLUGS.forEach(slug => {
    const d = draftData[slug];
    if (!d) return;
    const meal = state.meals[slug];
    meal.foods = d.foods || [];
    meal.currentBG = d.currentBG ?? '';
    meal.iob = d.iob ?? '';
    meal.cob = d.cob ?? '';
    meal.notes = d.notes || '';
    meal.postBgReadings = d.postBgReadings || [];
    meal.bgTimestamp = d.bgTimestamp ? new Date(d.bgTimestamp) : null;
    meal.bgTrend = d.bgTrend || null;
    state.bolusLockedAt[slug] = d.bolusLockedAt ? new Date(d.bolusLockedAt) : null;
    state.mealLockedAt[slug]  = d.mealLockedAt  ? new Date(d.mealLockedAt)  : null;
  });
}

// ─── RENDER ──────────────────────────────────────────────────────────────────

function renderAll() {
  renderMealTabs();
  renderBGPanel();
  renderMealSettingsPanel();
  renderFoodTable();
  renderBolusPanel();
  renderTimingCard();
  renderUnitsLabels();
  renderLogSection();
  setVal('meal-notes', getCurrentMeal().notes || '');
  renderPostMealTracker();
  updateSyncIndicator();
  updateMobileStatsStrip();
  // Restore per-tab entry food DOM
  const ef = getCurrentMeal().entryFood;
  const searchInput = document.getElementById('entry-food-search'); if (searchInput) searchInput.value = ef.name || '';
  const cfInput     = document.getElementById('entry-cf');          if (cfInput)     cfInput.value     = ef.carbFactor != null ? ef.carbFactor : '';
  const weightInput = document.getElementById('entry-weight');      if (weightInput) weightInput.value = ef.weightG || '';
  const carbsInput  = document.getElementById('entry-carbs');       if (carbsInput)  carbsInput.value  = ef.carbsG || '';
}

function renderMealTabs() {
  const container = document.getElementById('meal-tabs');
  if (!container) return;
  container.innerHTML = '';
  MEAL_SLUGS.forEach(slug => {
    const btn = document.createElement('button');
    btn.className = 'tab-pill' + (slug === state.activeMeal ? ' tab-pill--active' : '');
    btn.textContent = MEAL_LABELS[slug];
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', slug === state.activeMeal);
    btn.addEventListener('click', () => {
      state.activeMeal = slug;
      clearBolusTimer();
      renderAll();
      startBolusTimerIfLocked();
    });
    container.appendChild(btn);
  });
}

function renderBGPanel() {
  const meal = getCurrentMeal();
  setVal('bg-value', meal.currentBG);
  setVal('iob-value', meal.iob);
  setVal('cob-value', meal.cob);
  const unitLabel = state.units === 'mmol' ? 'mmol/L' : 'mg/dL';
  document.querySelectorAll('.bg-unit-label').forEach(el => { el.textContent = unitLabel; });
  const bgTs = document.getElementById('bg-timestamp');
  if (bgTs) {
    if (meal.bgTimestamp) { bgTs.textContent = formatTime(meal.bgTimestamp) + (meal.bgTrend ? ' ' + meal.bgTrend : ''); bgTs.hidden = false; }
    else bgTs.hidden = true;
  }
  const fetchBgBtn  = document.getElementById('fetch-bg-btn');  if (fetchBgBtn)  fetchBgBtn.hidden  = inferBGSource()  === 'manual';
  const fetchIobBtn = document.getElementById('fetch-iob-btn'); if (fetchIobBtn) fetchIobBtn.hidden = inferIOBSource() === 'manual';
  const fetchCobBtn = document.getElementById('fetch-cob-btn'); if (fetchCobBtn) fetchCobBtn.hidden = inferCOBSource() === 'manual';
}

function renderMealSettingsPanel() {
  const settings = getCurrentMealSettings();
  setVal('icr-input', settings.icr ?? '');
  setVal('isf-input', settings.isf ?? '');
  setVal('target-bg-input', settings.target_bg ?? '');
  const isfUnitStr = state.units === 'mmol' ? 'mmol/L per U' : 'mg/dL per U';
  document.querySelectorAll('.isf-unit-label').forEach(el => { el.textContent = isfUnitStr; });
  const nsBtn = document.getElementById('fetch-profile-btn');
  if (nsBtn) { const nsConfig = storage.get('ns_config'); nsBtn.hidden = !nsConfig?.url; }
}

function renderTimingCard() {
  const slug     = state.activeMeal;
  const bolusSet = state.bolusLockedAt[slug];
  const mealSet  = state.mealLockedAt[slug];

  const bolusInput = document.getElementById('bolus-time-input');
  const mealInput  = document.getElementById('meal-time-input');
  if (bolusInput && document.activeElement !== bolusInput) bolusInput.value = bolusSet ? hhmm(bolusSet) : '';
  if (mealInput  && document.activeElement !== mealInput)  mealInput.value  = mealSet  ? hhmm(mealSet)  : '';

  const lockedEl = document.getElementById('bolus-locked-indicator');
  if (lockedEl) lockedEl.hidden = !bolusSet;

  const mbEl    = document.getElementById('minutes-between');
  const mbValue = document.getElementById('minutes-between-value');
  if (bolusSet) {
    if (mbEl) mbEl.hidden = false;
    if (mealSet) {
      const diffMins = Math.floor((mealSet.getTime() - bolusSet.getTime()) / 60000);
      if (mbValue) mbValue.textContent = diffMins >= 0 ? `${diffMins} min` : `−${Math.abs(diffMins)} min`;
    } else {
      if (mbValue) mbValue.textContent = elapsedMMSS(bolusSet);
    }
  } else {
    if (mbEl) mbEl.hidden = true;
  }
}

function setupTimingCard() {
  const bolusInput  = document.getElementById('bolus-time-input');
  const bolusSetBtn = document.getElementById('bolus-set-btn');
  const mealInput   = document.getElementById('meal-time-input');
  const mealSetBtn  = document.getElementById('meal-set-btn');

  bolusInput?.addEventListener('input', e => {
    const d = timeInputToDate(e.target.value);
    state.bolusLockedAt[state.activeMeal] = d || null;
    recalcPostMealMinutes(state.activeMeal);
    renderPostMealTracker();
    persistDraftState();
    clearBolusTimer(); startBolusTimerIfLocked();
  });
  bolusInput?.addEventListener('change', e => {
    if (!e.target.value) { state.bolusLockedAt[state.activeMeal] = null; clearBolusTimer(); renderTimingCard(); }
  });

  mealInput?.addEventListener('input', e => {
    const d = timeInputToDate(e.target.value);
    state.mealLockedAt[state.activeMeal] = d || null;
    persistDraftState();
    clearBolusTimer(); startBolusTimerIfLocked();
  });
  mealInput?.addEventListener('change', e => {
    if (!e.target.value) { state.mealLockedAt[state.activeMeal] = null; clearBolusTimer(); startBolusTimerIfLocked(); }
  });

  bolusSetBtn?.addEventListener('click', () => {
    const now = new Date();
    state.bolusLockedAt[state.activeMeal] = now;
    if (bolusInput) bolusInput.value = hhmm(now);
    recalcPostMealMinutes(state.activeMeal);
    renderPostMealTracker();
    persistDraftState();
    clearBolusTimer(); startBolusTimerIfLocked();
  });

  mealSetBtn?.addEventListener('click', () => {
    const now = new Date();
    state.mealLockedAt[state.activeMeal] = now;
    if (mealInput) mealInput.value = hhmm(now);
    persistDraftState();
    clearBolusTimer(); startBolusTimerIfLocked();
  });
}

function startBolusTimerIfLocked() {
  clearBolusTimer();
  const slug     = state.activeMeal;
  const bolusSet = state.bolusLockedAt[slug];
  const mealSet  = state.mealLockedAt[slug];
  const mbEl     = document.getElementById('minutes-between');
  const mbValue  = document.getElementById('minutes-between-value');

  if (!bolusSet) { if (mbEl) mbEl.hidden = true; return; }
  if (mbEl) mbEl.hidden = false;

  if (mealSet) {
    // Both set: static floor minutes, no live timer needed
    const diffMins = Math.floor((mealSet.getTime() - bolusSet.getTime()) / 60000);
    if (mbValue) mbValue.textContent = diffMins >= 0 ? `${diffMins} min` : `−${Math.abs(diffMins)} min`;
    return;
  }

  // Only bolus set: live MM:SS elapsed
  function tick() {
    const from = state.bolusLockedAt[slug]; if (!from) return;
    if (mbValue) mbValue.textContent = elapsedMMSS(from);
  }
  tick();
  state.bolusTimerID = setInterval(tick, 1000);
}
function clearBolusTimer() { if (state.bolusTimerID) { clearInterval(state.bolusTimerID); state.bolusTimerID = null; } }

function recalcPostMealMinutes(slug) {
  const locked = state.bolusLockedAt[slug];
  const meal = state.meals[slug];
  if (!locked) return;
  meal.postBgReadings.forEach(r => {
    if (r.time) {
      const t = timeInputToDate(r.time);
      if (t) r.minSinceBolus = Math.round((t - locked) / 60000);
    }
  });
}

// ─── FOOD ENTRY ROW ──────────────────────────────────────────────────────────

function setupFoodEntryRow() {
  const searchInput = document.getElementById('entry-food-search');
  const cfInput     = document.getElementById('entry-cf');
  const weightInput = document.getElementById('entry-weight');
  const carbsInput  = document.getElementById('entry-carbs');
  const addBtn      = document.getElementById('add-food-btn');

  function onFoodSelect(food) {
    const ef = getCurrentMeal().entryFood;
    ef.name = food.name; ef.carbFactor = food.carbFactor; ef.absorptionRate = food.absorptionRate;
    if (searchInput) searchInput.value = food.name;
    if (cfInput) cfInput.value = food.carbFactor != null ? food.carbFactor : '';
    if (ef.weightG) {
      const c = calcNetCarbs(parseFloat(ef.weightG), food.carbFactor);
      ef.carbsG = c; if (carbsInput) carbsInput.value = c;
    } else if (ef.carbsG) {
      const w = calcWeightFromCarbs(parseFloat(ef.carbsG), food.carbFactor);
      ef.weightG = w; if (weightInput) weightInput.value = w;
    }
  }

  const debouncedSearch = debounce((query, el) => {
    performFoodSearch(query, el, onFoodSelect);
  }, 300);

  searchInput?.addEventListener('focus', e => {
    performFoodSearch(e.target.value, e.target, onFoodSelect);
  });
  searchInput?.addEventListener('input', e => {
    const ef = getCurrentMeal().entryFood;
    ef.name = e.target.value; ef.carbFactor = null;
    if (cfInput) cfInput.value = ''; debouncedSearch(e.target.value, e.target);
  });
  searchInput?.addEventListener('blur', () => { setTimeout(() => { document.querySelector('.food-dropdown')?.remove(); }, 150); });
  weightInput?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('recipe-add-ingredient-btn')?.click(); });
  carbsInput?.addEventListener('keydown',  e => { if (e.key === 'Enter') document.getElementById('recipe-add-ingredient-btn')?.click(); });
  searchInput?.addEventListener('keydown', e => { if (e.key === 'Enter') setTimeout(() => document.getElementById('recipe-add-ingredient-btn')?.click(), 200); });
  weightInput?.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn?.click(); });
  carbsInput?.addEventListener('keydown',  e => { if (e.key === 'Enter') addBtn?.click(); });
  searchInput?.addEventListener('keydown', e => { if (e.key === 'Enter') setTimeout(() => addBtn?.click(), 200); });

  weightInput?.addEventListener('input', e => {
    const ef = getCurrentMeal().entryFood;
    const w = parseFloat(e.target.value) || 0; ef.weightG = w || '';
    if (ef.carbFactor && w) { const c = calcNetCarbs(w, ef.carbFactor); ef.carbsG = c; if (carbsInput) carbsInput.value = c; }
  });

  carbsInput?.addEventListener('input', e => {
    const ef = getCurrentMeal().entryFood;
    const c = parseFloat(e.target.value) || 0; ef.carbsG = c || '';
    if (ef.carbFactor && c) { const w = calcWeightFromCarbs(c, ef.carbFactor); ef.weightG = w; if (weightInput) weightInput.value = w; }
  });

  addBtn?.addEventListener('click', () => {
    const ef = getCurrentMeal().entryFood;
    if (!ef.name) { showToast('Search and select a food first', 'error'); return; }
    const w = parseFloat(ef.weightG) || 0, c = parseFloat(ef.carbsG) || 0;
    if (!w && !c) { showToast('Enter weight or carbs', 'error'); return; }
    getCurrentMeal().foods.push({ name: ef.name, carbFactor: ef.carbFactor, weightG: w || calcWeightFromCarbs(c, ef.carbFactor), absorptionRate: ef.absorptionRate || 3.0 });
    getCurrentMeal().entryFood = { name: '', carbFactor: null, weightG: '', carbsG: '', absorptionRate: 3.0 };
    if (searchInput) searchInput.value = '';
    if (cfInput)     cfInput.value = '';
    if (weightInput) weightInput.value = '';
    if (carbsInput)  carbsInput.value = '';
    renderFoodTable(); updateBolusLive(); triggerSnapshot();
  });
}

// ─── CUSTOM FOOD PANEL ───────────────────────────────────────────────────────

function setupCustomFoodPanel() {
  const standardMode = document.getElementById('entry-standard-mode');
  const customMode   = document.getElementById('entry-custom-mode');
  const nameInput    = document.getElementById('custom-name');
  const cfInput      = document.getElementById('custom-cf');
  const weightInput  = document.getElementById('custom-weight');
  const carbsInput   = document.getElementById('custom-carbs');

  function enterStandardMode() {
    if (standardMode) standardMode.hidden = false;
    if (customMode)   customMode.hidden   = true;
    [nameInput, cfInput, weightInput, carbsInput].forEach(el => { if (el) el.value = ''; });
  }

  document.getElementById('custom-food-toggle-btn')?.addEventListener('click', () => {
    if (standardMode) standardMode.hidden = true;
    if (customMode)   customMode.hidden   = false;
    nameInput?.focus();
  });

  document.getElementById('custom-cancel-btn')?.addEventListener('click', enterStandardMode);

  cfInput?.addEventListener('input', () => {
    const cf = parseFloat(cfInput.value) || 0;
    const w  = parseFloat(weightInput?.value) || 0;
    if (cf && w && carbsInput) carbsInput.value = Math.round(w * cf * 10) / 10;
  });
  weightInput?.addEventListener('input', () => {
    const cf = parseFloat(cfInput?.value) || 0;
    const w  = parseFloat(weightInput.value) || 0;
    if (cf && w && carbsInput) carbsInput.value = Math.round(w * cf * 10) / 10;
  });
  carbsInput?.addEventListener('input', () => {
    const cf = parseFloat(cfInput?.value) || 0;
    const c  = parseFloat(carbsInput.value) || 0;
    if (cf && c && weightInput) weightInput.value = Math.round((c / cf) * 10) / 10;
  });

  document.getElementById('custom-add-btn')?.addEventListener('click', () => {
    const name = nameInput?.value?.trim();
    if (!name) { showToast('Enter a food name', 'error'); return; }
    const cf = parseFloat(cfInput?.value) || null;
    const w  = parseFloat(weightInput?.value) || 0;
    const c  = parseFloat(carbsInput?.value) || 0;
    if (!w && !c) { showToast('Enter weight or carbs', 'error'); return; }
    const weight = w || (cf ? Math.round((c / cf) * 10) / 10 : 0);
    getCurrentMeal().foods.push({ name, carbFactor: cf, weightG: weight, absorptionRate: 3.0 });
    enterStandardMode();
    renderFoodTable(); updateBolusLive(); triggerSnapshot();
  });
}

// ─── FOOD TABLE ──────────────────────────────────────────────────────────────

function renderFoodTable() {
  const tbody = document.getElementById('food-rows');
  if (!tbody) return;
  const meal = getCurrentMeal();
  tbody.innerHTML = '';

  meal.foods.forEach((food, i) => {
    const carbsVal = food.carbFactor && food.weightG ? calcNetCarbs(parseFloat(food.weightG), food.carbFactor) : '';
    const row = document.createElement('tr');
    row.innerHTML = `
      <td class="food-col-name">
        <input type="text" class="input input--sm food-name-input" value="${escHtml(food.name)}" autocomplete="off" data-index="${i}" />
      </td>
      <td class="food-col-cf"><span class="cf-display">${food.carbFactor != null ? food.carbFactor : '—'}</span></td>
      <td class="food-col-weight"><input type="number" class="input input--sm food-weight-input" value="${food.weightG || ''}" min="0" step="1" data-index="${i}" /></td>
      <td class="food-col-carbs"><input type="number" class="input input--sm food-carbs-input" value="${carbsVal !== '' ? carbsVal : ''}" min="0" step="0.1" data-index="${i}" /></td>
      <td class="food-col-remove"><button class="btn btn--icon food-remove-btn" aria-label="Remove">×</button></td>
    `;

    const nameInput   = row.querySelector('.food-name-input');
    const weightInput = row.querySelector('.food-weight-input');
    const carbsInput  = row.querySelector('.food-carbs-input');
    const cfDisplay   = row.querySelector('.cf-display');

    const debouncedSearch = debounce((query, el) => {
      performFoodSearch(query, el, sel => {
        const f = getCurrentMeal().foods[i];
        f.name = sel.name; f.carbFactor = sel.carbFactor; f.absorptionRate = sel.absorptionRate;
        nameInput.value = sel.name; cfDisplay.textContent = sel.carbFactor != null ? sel.carbFactor : '—';
        if (f.weightG) { const c = calcNetCarbs(parseFloat(f.weightG), sel.carbFactor); carbsInput.value = c; }
        updateBolusLive(); renderFoodTotals();
      });
    }, 300);

    nameInput.addEventListener('input', e => { const f = getCurrentMeal().foods[i]; f.name = e.target.value; debouncedSearch(e.target.value, e.target); });
    nameInput.addEventListener('blur', () => { setTimeout(() => { document.querySelector('.food-dropdown')?.remove(); }, 150); });

    weightInput.addEventListener('input', e => {
      const f = getCurrentMeal().foods[i]; const w = parseFloat(e.target.value) || 0; f.weightG = w || '';
      if (f.carbFactor && w) { carbsInput.value = calcNetCarbs(w, f.carbFactor); }
      updateBolusLive(); renderFoodTotals();
    });
    weightInput.addEventListener('change', () => triggerSnapshot());

    carbsInput.addEventListener('input', e => {
      const f = getCurrentMeal().foods[i]; const c = parseFloat(e.target.value) || 0;
      if (f.carbFactor && c) { const w = calcWeightFromCarbs(c, f.carbFactor); f.weightG = w; weightInput.value = w; }
      updateBolusLive(); renderFoodTotals();
    });

    row.querySelector('.food-remove-btn').addEventListener('click', () => {
      getCurrentMeal().foods.splice(i, 1); renderFoodTable(); updateBolusLive(); triggerSnapshot();
    });

    tbody.appendChild(row);
  });

  renderFoodTotals();
}

function renderFoodTotals() {
  const total = getCurrentMeal().foods.reduce((s, f) => s + calcNetCarbs(parseFloat(f.weightG) || 0, f.carbFactor || 0), 0);
  setText('food-total-carbs', total.toFixed(1) + ' g');
}

// ─── FOOD SEARCH ─────────────────────────────────────────────────────────────

function performFoodSearch(query, inputEl, onSelect) {
  document.querySelector('.food-dropdown')?.remove();
  const q = (query || '').toLowerCase().trim();
  let personal, builtin;
  if (!q) {
    personal = state.personalFoods.slice(0, 5).map(f => ({ name: f.name, carbFactor: f.cf, absorptionRate: f.abs, source: 'personal' }));
    builtin  = HEALTH_CANADA_FOODS.slice(0, Math.max(0, 5 - personal.length));
  } else {
    personal = state.personalFoods.filter(f => f.name.toLowerCase().includes(q))
      .map(f => ({ name: f.name, carbFactor: f.cf, absorptionRate: f.abs, source: 'personal' }));
    builtin  = HEALTH_CANADA_FOODS.filter(f => f.name.toLowerCase().includes(q));
  }
  const results = q ? [...personal, ...builtin] : [...personal, ...builtin].slice(0, 8);
  if (!results.length) return;
  const dropdown = createFoodDropdown(results, onSelect);
  if (dropdown) positionDropdown(dropdown, inputEl);
}

// ─── BOLUS PANEL ─────────────────────────────────────────────────────────────

function updateBolusLive() { renderBolusPanel(); updateMobileStatsStrip(); persistDraftState(); }

function renderBolusPanel() {
  const meal = getCurrentMeal(); const settings = getCurrentMealSettings();
  const foods = meal.foods.map(f => ({ weightG: parseFloat(f.weightG) || 0, carbFactor: f.carbFactor || 0 }));
  const result = calcBolus({ foods, currentBG: parseFloat(meal.currentBG) || null, targetBG: settings.target_bg, icr: settings.icr, isf: settings.isf, iob: 0 });
  setText('summary-carbs',      result.totalNetCarbs.toFixed(1) + ' g');
  setText('summary-carbs-hero', result.totalNetCarbs.toFixed(1));
  setText('summary-meal-bolus', result.mealBolus.toFixed(2) + ' U');
  setText('summary-correction', result.correctionBolus.toFixed(2) + ' U');
  setText('summary-iob', (parseFloat(meal.iob) || 0).toFixed(2) + ' U');
  setText('summary-total',      result.totalBolus.toFixed(2));
}

function renderUnitsLabels() {
  const unit = state.units === 'mmol' ? 'mmol/L' : 'mg/dL';
  document.querySelectorAll('[data-unit-label]').forEach(el => { el.textContent = unit; });
}

// ─── UNITS CONVERSION ────────────────────────────────────────────────────────

function changeUnits(newUnits) {
  if (newUnits === state.units) return;
  state.units = newUnits; storage.set('units', newUnits); persistConfig({ units: newUnits });

  MEAL_SLUGS.forEach(slug => {
    const meal = state.meals[slug];
    if (meal.currentBG !== '') {
      const v = parseFloat(meal.currentBG);
      if (!isNaN(v)) meal.currentBG = newUnits === 'mmol' ? mgdlToMmol(v) : mmolToMgdl(v);
    }
    const s = getMealSettings(slug);
    if (s.target_bg != null) {
      const v = newUnits === 'mmol' ? mgdlToMmol(s.target_bg) : mmolToMgdl(s.target_bg);
      setMealSettings(slug, { target_bg: newUnits === 'mmol' ? Math.round(v * 10) / 10 : Math.round(v) });
    }
    if (s.isf != null) {
      const v = newUnits === 'mmol' ? mgdlToMmol(s.isf) : mmolToMgdl(s.isf);
      setMealSettings(slug, { isf: newUnits === 'mmol' ? Math.round(v * 10) / 10 : Math.round(v) });
    }
    meal.postBgReadings.forEach(r => {
      if (r.bg !== '' && r.bg != null) {
        const v = parseFloat(r.bg);
        if (!isNaN(v)) r.bg = newUnits === 'mmol' ? mgdlToMmol(v) : mmolToMgdl(v);
      }
    });
  });

  renderAll(); renderPostMealTracker();
  showToast(`Units set to ${newUnits === 'mmol' ? 'mmol/L' : 'mg/dL'}`, 'info');
}

// ─── LOG SECTION ─────────────────────────────────────────────────────────────

function renderLogSection() {
  const container = document.getElementById('log-entries');
  if (!container) return;
  const log = getTodayLog();
  if (!log.length) { container.innerHTML = '<p class="empty-state">No meals logged today.</p>'; return; }
  const byMeal = {};
  log.forEach(e => { if (!byMeal[e.meal]) byMeal[e.meal] = []; byMeal[e.meal].push(e); });
  let html = '', grandTotal = 0;
  Object.entries(byMeal).forEach(([meal, entries]) => {
    const mt = entries.reduce((s, e) => s + (e.netCarbs || 0), 0); grandTotal += mt;
    html += `<div class="log-meal"><h3 class="log-meal__title">${escHtml(meal)} <span class="log-meal__total">${mt.toFixed(1)} g total</span></h3>
      <table class="log-table"><thead><tr><th>Food</th><th>Weight</th><th>CF</th><th>Net Carbs</th></tr></thead><tbody>
        ${entries.map(e => `<tr><td>${escHtml(e.food)}</td><td>${e.weightG||'—'} g</td><td>${e.carbFactor||'—'}</td><td>${(e.netCarbs||0).toFixed(1)} g</td></tr>`).join('')}
      </tbody></table></div>`;
  });
  html += `<div class="log-grand-total">Daily Total: <strong>${grandTotal.toFixed(1)} g</strong></div>`;
  const lastExport = storage.get('last_export_date');
  if (lastExport) html += `<p class="last-export">Last exported: ${lastExport}</p>`;
  container.innerHTML = html;
}

// ─── SETTINGS SECTION ────────────────────────────────────────────────────────

function renderSettingsSection() {
  updateConnectionStatus();
  const nsConfig = storage.get('ns_config', {}); setVal('ns-url', nsConfig.url||''); setVal('ns-secret', nsConfig.secret||'');
  const dexConfig = storage.get('dexcom_config', {}); setVal('dex-user', dexConfig.user||''); setVal('dex-pass', dexConfig.pass||''); setVal('dex-region', dexConfig.region||'us');
  const unitsSelect = document.getElementById('units-select'); if (unitsSelect) unitsSelect.value = state.units;
  const colorSelect = document.getElementById('color-theme-select'); if (colorSelect) colorSelect.value = storage.get('color_theme','custom');
  const clearTimeInput = document.getElementById('clear-time-input');
  if (clearTimeInput) clearTimeInput.value = state.config?.clear_time || '04:00';
  const nightlyEnabledInput = document.getElementById('nightly-export-enabled');
  if (nightlyEnabledInput) nightlyEnabledInput.checked = state.config?.nightly_export_enabled !== false;
  const nightlyTimeInput = document.getElementById('nightly-export-time');
  if (nightlyTimeInput) nightlyTimeInput.value = state.config?.nightly_export_time || '03:00';
}

// ─── NAVIGATION ──────────────────────────────────────────────────────────────

function setupNavigation() {
  document.querySelectorAll('[data-nav]').forEach(btn => {
    btn.addEventListener('click', () => {
      navigate(btn.dataset.nav);
      if (btn.dataset.nav === 'calculator') window.scrollTo({ top: 0, behavior: 'instant' });
      if (btn.dataset.nav === 'settings') renderSettingsSection();
      if (btn.dataset.nav === 'log')      renderLogSection();
    });
  });
  window.addEventListener('hashchange', () => {
    const section = getCurrentSection(); navigate(section);
    if (section === 'calculator') window.scrollTo({ top: 0, behavior: 'instant' });
    if (section === 'settings') renderSettingsSection();
    if (section === 'log')      renderLogSection();
  });

  document.getElementById('bg-value')?.addEventListener('input',  e => { getCurrentMeal().currentBG = e.target.value; updateBolusLive(); });
  document.getElementById('iob-value')?.addEventListener('input', e => { getCurrentMeal().iob = e.target.value; updateBolusLive(); });
  document.getElementById('cob-value')?.addEventListener('input', e => { getCurrentMeal().cob = e.target.value; persistDraftState(); });
  document.getElementById('fetch-bg-btn')?.addEventListener('click',       fetchBG);
  document.getElementById('fetch-iob-btn')?.addEventListener('click',      fetchIOB);
  document.getElementById('fetch-cob-btn')?.addEventListener('click',      fetchCOB);
  document.getElementById('fetch-profile-btn')?.addEventListener('click',  fetchNightscoutProfile);

  document.getElementById('icr-input')?.addEventListener('input',       e => { setMealSettings(state.activeMeal, { icr:      parseFloat(e.target.value)||null }); persistConfig(); updateBolusLive(); });
  document.getElementById('isf-input')?.addEventListener('input',       e => { setMealSettings(state.activeMeal, { isf:      parseFloat(e.target.value)||null }); persistConfig(); updateBolusLive(); });
  document.getElementById('target-bg-input')?.addEventListener('input', e => { setMealSettings(state.activeMeal, { target_bg: parseFloat(e.target.value)||null }); persistConfig(); updateBolusLive(); });

  document.getElementById('meal-notes')?.addEventListener('input', e => { getCurrentMeal().notes = e.target.value; persistDraftState(); });
  document.getElementById('bolus-given-btn')?.addEventListener('click', handleBolusGiven);
  document.getElementById('export-log-btn')?.addEventListener('click',  exportToDrive);

  document.getElementById('test-ns-btn')?.addEventListener('click', async e => {
    showSpinner(e.target);
    try { const { testConnection } = await import('./nightscout.js'); const ok = await testConnection(); showToast(ok ? 'Nightscout connected!' : 'Connection failed', ok ? 'success' : 'error'); }
    catch (err) { showToast('Error: ' + err.message, 'error'); } finally { hideSpinner(e.target); }
  });
  document.getElementById('test-dex-btn')?.addEventListener('click', async e => {
    showSpinner(e.target);
    try { const { testConnection } = await import('./dexcom.js'); await testConnection(); showToast('Dexcom connected!', 'success'); }
    catch (err) { showToast('Error: ' + err.message, 'error'); } finally { hideSpinner(e.target); }
  });
  document.getElementById('save-ns-btn')?.addEventListener('click', () => {
    const url = document.getElementById('ns-url')?.value?.trim(); const secret = document.getElementById('ns-secret')?.value?.trim();
    storage.set('ns_config', { url, secret }); persistConfig({ nightscout_url: url, nightscout_secret: secret });
    renderMealSettingsPanel(); setupNightscoutPolling(); showToast('Nightscout settings saved', 'success');
  });
  document.getElementById('save-dex-btn')?.addEventListener('click', () => {
    const user = document.getElementById('dex-user')?.value?.trim(); const pass = document.getElementById('dex-pass')?.value?.trim(); const region = document.getElementById('dex-region')?.value;
    storage.set('dexcom_config', { user, pass, region }); persistConfig({ dexcom_user: user, dexcom_pass: pass, dexcom_region: region }); showToast('Dexcom settings saved', 'success');
  });
  document.getElementById('units-select')?.addEventListener('change', e => { changeUnits(e.target.value); });
  document.getElementById('color-theme-select')?.addEventListener('change', e => { applyColorTheme(e.target.value); persistConfig({ color_theme: e.target.value }); });
  document.getElementById('clear-time-input')?.addEventListener('change', e => { persistConfig({ clear_time: e.target.value }); });
  document.getElementById('nightly-export-enabled')?.addEventListener('change', e => {
    persistConfig({ nightly_export_enabled: e.target.checked });
  });
  document.getElementById('nightly-export-time')?.addEventListener('change', e => {
    persistConfig({ nightly_export_time: e.target.value });
  });
  // Mobile tools button
  const mobileToolsBtn = document.getElementById('mobile-tools-btn');
  const mobileToolsDropdown = document.getElementById('mobile-tools-dropdown');
  if (mobileToolsBtn && mobileToolsDropdown) {
    mobileToolsBtn.addEventListener('click', e => {
      e.stopPropagation();
      mobileToolsDropdown.hidden = !mobileToolsDropdown.hidden;
    });
    document.addEventListener('click', () => { if (mobileToolsDropdown) mobileToolsDropdown.hidden = true; });

    // Mirror the desktop tools actions
    document.getElementById('mobile-tools-export-current')?.addEventListener('click', () => { mobileToolsDropdown.hidden = true; document.getElementById('tools-export-current')?.click(); });
    document.getElementById('mobile-tools-clear-current')?.addEventListener('click',  () => { mobileToolsDropdown.hidden = true; document.getElementById('tools-clear-current')?.click(); });
    document.getElementById('mobile-tools-export-all')?.addEventListener('click',     () => { mobileToolsDropdown.hidden = true; document.getElementById('tools-export-all')?.click(); });
    document.getElementById('mobile-tools-recipe')?.addEventListener('click',         () => { mobileToolsDropdown.hidden = true; document.getElementById('tools-recipe')?.click(); });
    document.getElementById('mobile-tools-food-search')?.addEventListener('click',    () => { mobileToolsDropdown.hidden = true; document.getElementById('tools-food-search')?.click(); });
    document.getElementById('mobile-tools-add-food')?.addEventListener('click',       () => { mobileToolsDropdown.hidden = true; document.getElementById('tools-add-food')?.click(); });
    document.getElementById('mobile-tools-tracker')?.addEventListener('click',        () => { mobileToolsDropdown.hidden = true; document.getElementById('tools-tracker')?.click(); });
    document.getElementById('mobile-tools-restore-draft')?.addEventListener('click',  () => { mobileToolsDropdown.hidden = true; document.getElementById('tools-restore-draft')?.click(); });
  };
}

// ─── MOBILE CALC TABS ────────────────────────────────────────────────────────

function setupMobileCalcTabs() {
  function switchCalcTab(tab) {
    document.body.dataset.calcTab = tab;
    document.querySelectorAll('.bottom-nav [data-calc-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.calcTab === tab && btn.dataset.nav === 'calculator');
    });
  }

  document.querySelectorAll('[data-calc-tab]').forEach(el => {
    el.addEventListener('click', () => {
      navigate('calculator');
      switchCalcTab(el.dataset.calcTab);
    });
  });

  // Default tab on load
  switchCalcTab('entry');
}

function updateMobileStatsStrip() {
  const meal = getCurrentMeal();
  const bg = parseFloat(meal.currentBG);
  const bgEl = document.getElementById('strip-bg');
  const locked = state.bolusLockedAt[state.activeMeal];
  // Freeze BG display when bolus is locked, same as desktop
  if (bgEl && !locked) {
    bgEl.textContent = isNaN(bg) ? '—' : bg.toFixed(1);
  }
  document.getElementById('strip-carbs').textContent = (document.getElementById('summary-carbs-hero')?.textContent || '0') + ' g';
  document.getElementById('strip-bolus').textContent = (document.getElementById('summary-total')?.textContent || '0.00') + ' U';
}

// ─── TOOLS MENU ──────────────────────────────────────────────────────────────

function setupToolsMenu() {
  document.getElementById('tools-btn')?.addEventListener('click', e => {
    e.stopPropagation();
    const note = document.getElementById('guest-export-note'); if (note) note.hidden = state.connected;
    toggleToolsDropdown();
  });
  document.getElementById('tools-export-current')?.addEventListener('click', () => { document.getElementById('tools-dropdown').hidden = true; exportCurrentSheet(); });
  document.getElementById('tools-export-all')?.addEventListener('click',     () => { document.getElementById('tools-dropdown').hidden = true; exportAllSheets(); });
  document.getElementById('tools-clear-current')?.addEventListener('click',  () => { document.getElementById('tools-dropdown').hidden = true; clearCurrentMeal(); });
  document.getElementById('tools-recipe')?.addEventListener('click', () => {
    document.getElementById('tools-dropdown').hidden = true;
    const panel = document.getElementById('recipe-panel');
    if (panel?.hidden) { openRecipePanel(); renderRecipeTabs(); renderRecipePanel(); } else { closeRecipePanel(); }
  });
  document.getElementById('tools-food-search')?.addEventListener('click', () => {
    document.getElementById('tools-dropdown').hidden = true;
    const panel = document.getElementById('food-search-panel');
    if (panel?.hidden) {
      openFoodSearchPanel();
      const note = document.getElementById('food-search-offline-note');
      const input = document.getElementById('food-search-input');
      if (note) note.hidden = state.connected;
      if (input) { input.disabled = !state.connected; if (state.connected) input.focus(); }
    } else {
      closeFoodSearchPanel();
    }
  });
  document.getElementById('tools-add-food')?.addEventListener('click', () => {
    document.getElementById('tools-dropdown').hidden = true;
    const panel = document.getElementById('add-food-panel');
    if (panel?.hidden) {
      openAddFoodPanel();
      const note = document.getElementById('add-food-offline-note');
      if (note) note.hidden = state.connected;
      document.querySelectorAll('#add-food-panel input, #add-food-panel select, #add-food-panel button')
        .forEach(el => { if (el.id !== 'close-add-food-btn') el.disabled = !state.connected || el.id === 'add-food-cf'; });
      if (state.connected) document.getElementById('add-food-name')?.focus();
    } else {
      closeAddFoodPanel();
    }
  });
  document.getElementById('tools-tracker')?.addEventListener('click', () => {
    document.getElementById('tools-dropdown').hidden = true;
    const tracker = document.getElementById('post-meal-tracker');
    if (tracker) tracker.hidden = !tracker.hidden;
  });
  document.getElementById('tools-restore-draft')?.addEventListener('click', async () => {
    document.getElementById('tools-dropdown').hidden = true;
    if (!confirm('Restore state from Draft State A1? This will overwrite your current session.')) return;
    showToast('Restoring...', 'info');
    try {
      const draft = await restoreDraftState();
      if (!draft || !draft.data) { showToast('Nothing to restore', 'error'); return; }
      applyDraftToState(draft.data);
      if (draft.data.recipes && draft.data.recipes.length) {
        state.recipes = draft.data.recipes.map(r => ({
          name: r.name || '',
          ingredients: r.ingredients || [],
          entryFood: { name: '', carbFactor: null, weightG: '', carbsG: '' }
        }));
        state.activeRecipeIndex = 0;
      }
      renderAll();
      showToast('Draft restored', 'success');
    } catch (err) {
      showToast('Restore failed: ' + err.message, 'error');
    }
  });
}

// ─── FOOD SEARCH PANEL ───────────────────────────────────────────────────────

function setupFoodSearchPanel() {
  document.getElementById('close-food-search-btn')?.addEventListener('click', closeFoodSearchPanel);

  const input = document.getElementById('food-search-input');
  const debouncedSearch = debounce(async (query) => {
    const container = document.getElementById('food-search-results');
    if (!container) return;
    const q = query.trim();
    if (q.length < 2) { container.innerHTML = ''; return; }

    container.innerHTML = '<p class="empty-state">Searching…</p>';
    try {
      const rows = await searchFood(q);
      renderFoodSearchResults(rows, q);
    } catch (err) {
      container.innerHTML = `<p class="empty-state">Search failed: ${escHtml(err.message)}</p>`;
    }
  }, 300);

  input?.addEventListener('input', e => debouncedSearch(e.target.value));
}

function highlightMatch(text, query) {
  const escaped = escHtml(text);
  if (!query) return escaped;
  const safeQuery = query.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const regex = new RegExp(`(${safeQuery})`, 'gi');
  return escaped.replace(regex, '<mark>$1</mark>');
}

function renderFoodSearchResults(rows, query) {
  const container = document.getElementById('food-search-results');
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = `<p class="empty-state">No matches for "${escHtml(query)}"</p>`;
    return;
  }
  container.innerHTML = rows.map(r => {
    const date = new Date(r.date);
    const dateStr = date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    return `
      <div class="food-search-result">
        <div class="food-search-date">${dateStr}</div>
        <div class="food-search-meal">${escHtml(r.meal)}</div>
        <div class="food-search-title">${escHtml(r.food)}</div>
        <div class="food-search-stats">
          <div><span class="food-search-label">CF:</span> ${r.cf ?? '—'}</div>
          <div><span class="food-search-label">Weight:</span> ${r.wt ?? '—'} g</div>
          <div><span class="food-search-label">Net Carbs:</span> ${r.carbs ?? '—'} g</div>
        </div>
        ${r.url ? `<div class="food-search-link"><a href="${r.url}" target="_blank">View Log ↗</a></div>` : ''}
      </div>`;
  }).join('');
}

// ─── ADD FOOD PANEL ──────────────────────────────────────────────────────────

function setupAddFoodPanel() {
  document.getElementById('close-add-food-btn')?.addEventListener('click', closeAddFoodPanel);

  document.getElementById('add-food-portion')?.addEventListener('input', addFoodCalcFactor);
  document.getElementById('add-food-total-carbs')?.addEventListener('input', addFoodCalcFactor);
  document.getElementById('add-food-fiber')?.addEventListener('input', addFoodCalcFactor);
  document.getElementById('add-food-name')?.addEventListener('input', addFoodCheckName);
  document.getElementById('add-food-submit-btn')?.addEventListener('click', addFoodSubmit);

  document.addEventListener('click', e => {
    if (!e.target.closest('#add-food-name')?.parentElement?.contains?.(e.target) &&
        !e.target.closest('#add-food-matches')) {
      const m = document.getElementById('add-food-matches'); if (m) m.hidden = true;
    }
  });
}

function addFoodCalcFactor() {
  const portion = parseFloat(document.getElementById('add-food-portion')?.value) || 0;
  const carbs   = parseFloat(document.getElementById('add-food-total-carbs')?.value) || 0;
  const fiber   = parseFloat(document.getElementById('add-food-fiber')?.value) || 0;
  const net = Math.max(0, carbs - fiber);
  const raw = portion > 0 ? (net / portion) : 0;
  setVal('add-food-cf', (Math.floor(raw * 100) / 100).toFixed(2));
  addFoodValidate();
}

function addFoodCheckName() {
  const val = document.getElementById('add-food-name')?.value.trim().toLowerCase() || '';
  const matchesDiv = document.getElementById('add-food-matches');
  const statusDiv  = document.getElementById('add-food-name-status');
  if (!matchesDiv || !statusDiv) return;

  if (val.length < 2) { matchesDiv.hidden = true; statusDiv.textContent = ''; statusDiv.className = 'field-status'; addFoodValidate(); return; }

  const exact    = state.personalFoods.find(f => f.name.toLowerCase() === val);
  const partials = state.personalFoods.filter(f => f.name.toLowerCase().includes(val) && f.name.toLowerCase() !== val);

  if (exact) { statusDiv.textContent = '⚠ Food already exists'; statusDiv.className = 'field-status status-error'; }
  else       { statusDiv.textContent = ''; statusDiv.className = 'field-status'; }

  if (partials.length) {
    matchesDiv.innerHTML = partials.map(p =>
      `<div class="match-item" data-name="${escHtml(p.name)}" data-cf="${p.cf}" data-abs="${p.abs}">${escHtml(p.name)}</div>`
    ).join('');
    matchesDiv.hidden = false;
    matchesDiv.querySelectorAll('.match-item').forEach(item => {
      item.addEventListener('click', () => {
        document.getElementById('add-food-name').value = item.dataset.name;
        setVal('add-food-cf', (Math.floor(parseFloat(item.dataset.cf) * 100) / 100).toFixed(2));
        matchesDiv.hidden = true;
        addFoodCheckName();
      });
    });
  } else {
    matchesDiv.hidden = true;
  }
  addFoodValidate();
}

function addFoodValidate() {
  const name    = document.getElementById('add-food-name')?.value.trim();
  const portion = document.getElementById('add-food-portion')?.value;
  const isDupe  = document.getElementById('add-food-name-status')?.classList.contains('status-error');
  const btn = document.getElementById('add-food-submit-btn');
  if (btn) btn.disabled = !name || !portion || isDupe || !state.connected;
}

async function addFoodSubmit() {
  const name = document.getElementById('add-food-name')?.value.trim();
  const cf   = parseFloat(document.getElementById('add-food-cf')?.value) || 0;
  const abs  = 3.0;
  const btn = document.getElementById('add-food-submit-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
  try {
    const result = await addFood({ name, cf, abs });
    if (!result?.success) throw new Error(result?.error || 'Add failed');
    state.personalFoods = await getFoodChart();
    showToast(`${name} added to Food Chart`, 'success');
    addFoodClearFields();
  } catch (err) {
    showToast('Error: ' + err.message, 'error');
  } finally {
    if (btn) btn.textContent = 'Add to Food Chart';
    addFoodValidate();
  }
}

function addFoodClearFields() {
  ['add-food-name','add-food-portion','add-food-total-carbs','add-food-fiber']
    .forEach(id => setVal(id, ''));
  setVal('add-food-cf', '0.00');
  const status = document.getElementById('add-food-name-status'); if (status) { status.textContent = ''; status.className = 'field-status'; }
  addFoodValidate();
}

async function refreshFoodChart() {
  if (!state.connected) return;
  try { state.personalFoods = await getFoodChart(); } catch {}
}

// ─── EXPORT PAYLOAD BUILDERS ─────────────────────────────────────────────────

function buildMealExportPayload(slug) {
  const meal = state.meals[slug];
  const settings = getMealSettings(slug);
  const bolusTimeAt = state.bolusLockedAt[slug];
  const eatTimeAt   = state.mealLockedAt[slug];

  const bolus = calcBolus({
    foods: meal.foods,
    currentBG: parseFloat(meal.currentBG) || null,
    targetBG: settings.target_bg,
    icr: settings.icr,
    isf: settings.isf,
    iob: parseFloat(meal.iob) || 0
  });

  return {
    name: MEAL_LABELS[slug],
    foods: meal.foods.map(f => ({
      name: f.name,
      source: f.source || '',
      carbFactor: f.carbFactor,
      absorptionRate: f.absorptionRate,
      weightGiven: f.weightG,
      netCarbs: calcNetCarbs(parseFloat(f.weightG) || 0, f.carbFactor || 0),
      recipeIngredients: f.recipeIngredients || null
    })),
    carbRatio: settings.icr,
    target: settings.target_bg,
    isf: settings.isf,
    currentBG: meal.currentBG,
    totalNetCarbs: bolus.totalNetCarbs,
    iob: meal.iob,
    cob: meal.cob,
    mealBolus: bolus.mealBolus,
    correctionBolus: bolus.correctionBolus,
    totalBolus: bolus.totalBolus,
    bolusTime: bolusTimeAt ? hhmmDisplay(bolusTimeAt) : '',
    eatTime: eatTimeAt ? hhmmDisplay(eatTimeAt) : '',
    postMealReadings: (meal.postBgReadings || [])
      .filter(r => r.time || r.bg)
      .map(r => ({
        time: r.time, minSinceBolus: r.minSinceBolus,
        bg: r.bg, trend: r.trend, delta: r.delta
      })),
    notes: meal.notes || ''
  };
}

function buildDayExportPayload(slugs) {
  const meals = slugs
    .map(buildMealExportPayload)
    .filter(m => m.foods.length > 0);
  return meals;
}

function flattenToCSVRows(meals) {
  const date = todayStr();
  const rows = [];
  meals.forEach(m => m.foods.forEach(f => {
    rows.push([date, m.name, f.name, f.carbFactor, f.weightGiven, f.netCarbs, m.notes]);
  }));
  return rows;
}

function downloadCSV(rows) {
  const headers = ['Date', 'Meal', 'Food', 'Carb Factor', 'Weight (g)', 'Net Carbs (g)', 'Notes'];
  const csv = [headers, ...rows].map(row =>
    row.map(val => `"${String(val ?? '').replace(/"/g, '""')}"`).join(',')
  ).join('\r\n');

  const date = new Date();
  const monthName = date.toLocaleString('en-CA', { month: 'long' });
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  const filename = `Bolus Calculator - ${monthName} ${day} ${year}.csv`;

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

// ─── BOLUS GIVEN ─────────────────────────────────────────────────────────────

function handleBolusGiven() {
  const slug = state.activeMeal;
  if (state.bolusLockedAt[slug] && !confirm('Update bolus time to now?')) return;
  const now = new Date();
  state.bolusLockedAt[slug] = now;
  const input = document.getElementById('bolus-time-input');
  if (input) input.value = hhmm(now);
  recalcPostMealMinutes(slug);
  renderPostMealTracker();
  persistDraftState();
  clearBolusTimer(); startBolusTimerIfLocked();
  showToast('Bolus time set to now', 'success'); triggerSnapshot();
}

// ─── EXPORT ──────────────────────────────────────────────────────────────────

function downloadLocalCSV(entries, dateStr) {
  const headers = ['Date', 'Meal', 'Food', 'Carb Factor', 'Weight (g)', 'Net Carbs (g)', 'Notes'];
  const rows = entries.map(e => [e.date, e.meal, e.food, e.carbFactor ?? '', e.weightG, e.netCarbs, e.notes || '']);
  const csv = [headers, ...rows].map(row =>
    row.map(val => `"${String(val ?? '').replace(/"/g, '""')}"`).join(',')
  ).join('\r\n');

  const date = new Date(dateStr + 'T12:00:00');
  const monthName = date.toLocaleString('en-CA', { month: 'long' });
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  const filename = `Bolus Calculator - ${monthName} ${day} ${year}.csv`;

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  document.body.removeChild(a); URL.revokeObjectURL(url);
}

function buildLogEntries(slug, meal) {
  return meal.foods.filter(f => f.name && f.weightG).map(f => ({
    date: todayStr(), meal: MEAL_LABELS[slug], food: f.name, carbFactor: f.carbFactor,
    weightG: parseFloat(f.weightG) || 0, netCarbs: calcNetCarbs(parseFloat(f.weightG) || 0, f.carbFactor || 0), notes: meal.notes || ''
  }));
}

function entriesToRows(entries) {
  return entries.map(e => [e.date, e.meal, e.food, e.carbFactor ?? '', e.weightG, e.netCarbs, e.notes || '']);
}

function clearMeal(slug) {
  state.meals[slug].foods = [];
  state.meals[slug].notes = '';
  state.meals[slug].postBgReadings = [];
  state.bolusLockedAt[slug] = null;
  state.mealLockedAt[slug] = null;
  renderAll();
  updateBolusLive();
  persistDraftState(slug);
}

function clearCurrentMeal() {
  const slug = state.activeMeal;
  if (!confirm(`Clear ${MEAL_LABELS[slug]} without exporting? This cannot be undone.`)) return;
  clearMeal(slug);
  showToast(`${MEAL_LABELS[slug]} cleared`, 'info');
}

async function exportCurrentSheet() {
  const slug = state.activeMeal;
  const meals = buildDayExportPayload([slug]);
  if (meals.length === 0) { showToast('No foods to export for ' + MEAL_LABELS[slug], 'error'); return; }

  try {
    if (state.connected) {
      showToast('Exporting…', 'info');
      const result = await logMeal({ meals, units: state.units });
      if (!result?.success) throw new Error(result?.error || 'Export failed');
      storage.set('last_export_date', todayStr());
      showToast('Exported to Drive', 'success'); renderLogSection();
    } else {
      throw new Error('offline');
    }
  } catch (err) {
    console.error('Export failed:', err);
    downloadCSV(flattenToCSVRows(meals));
    showToast('Saved locally (offline)', 'info'); renderLogSection();
  }
}

async function exportAllSheets() {
  const meals = buildDayExportPayload(MEAL_SLUGS);
  if (meals.length === 0) { showToast('No foods to export', 'error'); return; }

  try {
    if (state.connected) {
      showToast('Exporting all meals…', 'info');
      const result = await logMeal({ meals, units: state.units });
      if (!result?.success) throw new Error(result?.error || 'Export failed');
      storage.set('last_export_date', todayStr());
      showToast('Exported to Drive', 'success'); renderLogSection();
    } else {
      throw new Error('offline');
    }
  } catch (err) {
    console.error('Export failed:', err);
    downloadCSV(flattenToCSVRows(meals));
    showToast('Saved locally (offline)', 'info'); renderLogSection();
  }
}

async function exportToDrive() {
  const btn = document.getElementById('export-log-btn'); if (btn) showSpinner(btn);
  try {
    const log = getTodayLog(); if (!log.length) throw new Error('Nothing to export');
    const dateStr = todayStr();
    if (state.connected) {
      const result = await logMeal(entriesToRows(log));
      if (!result?.success) throw new Error(result?.error || 'Export failed');
      storage.set('last_export_date', dateStr); showToast('Exported to Drive', 'success'); renderLogSection();
    } else {
      downloadLocalCSV(log, dateStr); showToast('Saved locally (offline)', 'info');
    }
  } catch (err) {
    const log = getTodayLog();
    if (log.length) { downloadLocalCSV(log, todayStr()); showToast('Saved locally (offline)', 'info'); }
    else showToast('Export failed: ' + err.message, 'error');
  } finally { if (btn) hideSpinner(btn); }
}

// ─── POST-MEAL BG TRACKER ────────────────────────────────────────────────────

function setupPostMealTracker() {
  document.getElementById('close-tracker-btn')?.addEventListener('click', () => {
    const el = document.getElementById('post-meal-tracker'); if (el) el.hidden = true;
  });
  document.getElementById('generate-times-btn')?.addEventListener('click', () => {
    const slug = state.activeMeal; const locked = state.bolusLockedAt[slug];
    const interval = parseInt(document.getElementById('tracking-interval')?.value || '30');
    if (!locked) { showToast('Lock the bolus time first', 'error'); return; }
    const rows = getCurrentMeal().postBgReadings;
    rows.forEach((r, i) => { const t = new Date(locked.getTime() + (i+1) * interval * 60000); r.time = hhmmDisplay(t); r.minSinceBolus = (i+1) * interval; });
    renderPostMealTracker();
    persistDraftState();
  });
  document.getElementById('add-bg-row-btn')?.addEventListener('click', () => {
    getCurrentMeal().postBgReadings.push({ time: '', minSinceBolus: '', bg: '', trend: '→', delta: '' });
    renderPostMealTracker();
    persistDraftState();
    triggerSnapshot();
  });
}

function renderPostMealTracker() {
  const tbody = document.getElementById('post-bg-rows'); if (!tbody) return;
  const meal = getCurrentMeal(); tbody.innerHTML = '';
  meal.postBgReadings.forEach((r, i) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td><input type="time" class="input input--sm" value="${r.time||''}" data-field="time" data-index="${i}" /></td>
      <td><span class="post-min">${r.minSinceBolus||'—'}</span></td>
      <td><input type="number" class="input input--sm" value="${r.bg||''}" placeholder="${state.units==='mmol'?'mmol/L':'mg/dL'}" step="${state.units==='mmol'?'0.1':'1'}" data-field="bg" data-index="${i}" /></td>
      <td><select class="input input--sm" data-field="trend" data-index="${i}">
        <option value="→" ${r.trend==='→'?'selected':''}>→ Flat</option>
        <option value="↗" ${r.trend==='↗'?'selected':''}>↗ Rising Slightly</option>
        <option value="↘" ${r.trend==='↘'?'selected':''}>↘ Falling Slightly</option>
        <option value="↑" ${r.trend==='↑'?'selected':''}>↑ Rising</option>
        <option value="↓" ${r.trend==='↓'?'selected':''}>↓ Falling</option>
        <option value="⇈" ${r.trend==='⇈'?'selected':''}>⇈ Rising Rapidly</option>
        <option value="⇊" ${r.trend==='⇊'?'selected':''}>⇊ Falling Rapidly</option>
      </select></td>
      <td><span class="post-delta">${r.delta!==''&&r.delta!=null?(r.delta>0?'+':'')+r.delta:'—'}</span></td>
      <td><button class="btn btn--icon" data-remove="${i}">×</button></td>`;
    row.querySelector('[data-field="time"]').addEventListener('input', e => {
      const rd = getCurrentMeal().postBgReadings[i]; rd.time = e.target.value;
      const locked = state.bolusLockedAt[state.activeMeal];
      if (locked && e.target.value) { const rd2 = timeInputToDate(e.target.value); if (rd2) rd.minSinceBolus = Math.round((rd2 - locked) / 60000); row.querySelector('.post-min').textContent = rd.minSinceBolus; }
      persistDraftState();
    });
    row.querySelector('[data-field="bg"]').addEventListener('input', e => {
        const rd = getCurrentMeal().postBgReadings[i]; rd.bg = parseFloat(e.target.value)||'';
        if (i > 0) { const prev = getCurrentMeal().postBgReadings[i-1]; if (prev.bg!=='' && rd.bg!=='') { const delta = Math.round((rd.bg-prev.bg)*10)/10; rd.delta = delta; row.querySelector('.post-delta').textContent = (delta>0?'+':'')+delta; } }
        persistDraftState(); triggerSnapshot();
      });
    row.querySelector('[data-field="trend"]').addEventListener('change', e => { getCurrentMeal().postBgReadings[i].trend = e.target.value; persistDraftState(); });
    row.querySelector('[data-remove]').addEventListener('click', () => { getCurrentMeal().postBgReadings.splice(i, 1); renderPostMealTracker(); persistDraftState(); });
    tbody.appendChild(row);
  });
}

// ─── RECIPE BUILDER ──────────────────────────────────────────────────────────

function calcRecipeCompositeCF(recipe) {
  const totalWeight = recipe.ingredients.reduce((s, i) => s + (parseFloat(i.weightG)||0), 0);
  const totalCarbs  = recipe.ingredients.reduce((s, i) => s + calcNetCarbs(parseFloat(i.weightG)||0, i.carbFactor||0), 0);
  return calcCompositeCF(totalCarbs, totalWeight);
}

function setupRecipePanel() {
  document.getElementById('close-recipe-btn')?.addEventListener('click', closeRecipePanel);
  document.getElementById('clear-recipe-btn')?.addEventListener('click', () => {
    const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
    if (!confirm(`Delete "${recipe.name || `Recipe ${state.activeRecipeIndex + 1}`}"?`)) return;
    state.recipes.splice(state.activeRecipeIndex, 1);
    if (state.recipes.length === 0) state.recipes.push(createRecipe());
    state.activeRecipeIndex = Math.min(state.activeRecipeIndex, state.recipes.length - 1);
    renderRecipeTabs(); renderRecipePanel();
    persistRecipeDraft();
  });
  document.getElementById('new-recipe-btn')?.addEventListener('click', () => {
    state.recipes.push(createRecipe()); state.activeRecipeIndex = state.recipes.length - 1;
    renderRecipeTabs(); renderRecipePanel();
    persistRecipeDraft();
  });
  document.getElementById('recipe-add-ingredient-btn')?.addEventListener('click', () => {
    const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
    const ef = recipe.entryFood;
    if (!ef.name || ef.carbFactor == null) { showToast('Select a food first', 'error'); return; }
    const w = parseFloat(ef.weightG)||0, c = parseFloat(ef.carbsG)||0;
    if (!w && !c) { showToast('Enter weight or carbs', 'error'); return; }
    recipe.ingredients.push({ name: ef.name, carbFactor: ef.carbFactor, weightG: w || calcWeightFromCarbs(c, ef.carbFactor), absorptionRate: ef.absorptionRate||3.0 });
    recipe.entryFood = { name:'', carbFactor:null, weightG:'', carbsG:'' };
    ['recipe-search-input','recipe-entry-cf','recipe-entry-weight','recipe-entry-carbs'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
    renderRecipeIngredients(); renderRecipeComposite();
    persistRecipeDraft();
  });
  setupRecipeEntryRow();

  document.getElementById('recipe-portion-weight')?.addEventListener('input', e => {
    const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
    const cf = calcRecipeCompositeCF(recipe); const w = parseFloat(e.target.value)||0;
    const portionCarbsEl = document.getElementById('recipe-portion-carbs');
    if (portionCarbsEl) portionCarbsEl.value = cf ? Math.round(w * cf * 10) / 10 : '';
  });
  document.getElementById('recipe-portion-carbs')?.addEventListener('input', e => {
    const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
    const cf = calcRecipeCompositeCF(recipe); const c = parseFloat(e.target.value)||0;
    const portionWeightEl = document.getElementById('recipe-portion-weight');
    if (portionWeightEl) portionWeightEl.value = cf ? Math.round((c/cf)*10)/10 : '';
  });
  document.getElementById('recipe-add-to-meal-btn')?.addEventListener('click', () => {
    const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
    const cf = calcRecipeCompositeCF(recipe);
    const w  = parseFloat(document.getElementById('recipe-portion-weight')?.value)||0;
    const c  = parseFloat(document.getElementById('recipe-portion-carbs')?.value)||0;
    if (!w && !c) { showToast('Enter portion weight or carbs', 'error'); return; }
    const weight = w || (cf ? Math.round((c/cf)*10)/10 : 0);
    getCurrentMeal().foods.push({
      name: recipe.name||'Recipe',
      carbFactor: cf,
      weightG: weight,
      absorptionRate: 3.0,
      recipeIngredients: recipe.ingredients.map(ing => ({
        name: ing.name,
        carbFactor: ing.carbFactor,
        weightG: ing.weightG
      }))
    });
    renderFoodTable(); updateBolusLive(); showToast('Recipe added to meal', 'success'); triggerSnapshot();
  });
  document.getElementById('recipe-name-input')?.addEventListener('input', e => {
    const recipe = state.recipes[state.activeRecipeIndex]; if (recipe) recipe.name = e.target.value;
    const tabs = document.querySelectorAll('.recipe-tab-pill');
    if (tabs[state.activeRecipeIndex]) tabs[state.activeRecipeIndex].textContent = e.target.value || `Recipe ${state.activeRecipeIndex+1}`;
    persistRecipeDraft();
  });
}

function setupRecipeEntryRow() {
  const searchInput = document.getElementById('recipe-search-input');
  const cfInput     = document.getElementById('recipe-entry-cf');
  const weightInput = document.getElementById('recipe-entry-weight');
  const carbsInput  = document.getElementById('recipe-entry-carbs');
  const debouncedSearch = debounce((query, el) => {
    performFoodSearch(query, el, food => {
      const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
      recipe.entryFood.name = food.name; recipe.entryFood.carbFactor = food.carbFactor; recipe.entryFood.absorptionRate = food.absorptionRate;
      if (searchInput) searchInput.value = food.name; if (cfInput) cfInput.value = food.carbFactor != null ? food.carbFactor : '';
      if (recipe.entryFood.weightG) { const c = calcNetCarbs(parseFloat(recipe.entryFood.weightG), food.carbFactor); recipe.entryFood.carbsG = c; if (carbsInput) carbsInput.value = c; }
    });
  }, 300);
  searchInput?.addEventListener('input', e => {
    const recipe = state.recipes[state.activeRecipeIndex];
    if (recipe) { recipe.entryFood.name = e.target.value; recipe.entryFood.carbFactor = null; }
    if (cfInput) cfInput.value = ''; debouncedSearch(e.target.value, e.target);
  });
  searchInput?.addEventListener('blur', () => { setTimeout(() => { document.querySelector('.food-dropdown')?.remove(); }, 150); });
  weightInput?.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('recipe-add-ingredient-btn')?.click(); });
  carbsInput?.addEventListener('keydown',  e => { if (e.key === 'Enter') document.getElementById('recipe-add-ingredient-btn')?.click(); });
  searchInput?.addEventListener('keydown', e => { if (e.key === 'Enter') setTimeout(() => document.getElementById('recipe-add-ingredient-btn')?.click(), 200); });
  weightInput?.addEventListener('input', e => {
    const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
    const w = parseFloat(e.target.value)||0; recipe.entryFood.weightG = w||'';
    if (recipe.entryFood.carbFactor && w) { const c = calcNetCarbs(w, recipe.entryFood.carbFactor); recipe.entryFood.carbsG = c; if (carbsInput) carbsInput.value = c; }
  });
  carbsInput?.addEventListener('input', e => {
    const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
    const c = parseFloat(e.target.value)||0; recipe.entryFood.carbsG = c||'';
    if (recipe.entryFood.carbFactor && c) { const w = calcWeightFromCarbs(c, recipe.entryFood.carbFactor); recipe.entryFood.weightG = w; if (weightInput) weightInput.value = w; }
  });
}

function renderRecipeTabs() {
  const container = document.getElementById('recipe-tabs'); if (!container) return;
  container.innerHTML = '';
  state.recipes.forEach((r, i) => {
    const btn = document.createElement('button');
    btn.className = 'recipe-tab-pill' + (i === state.activeRecipeIndex ? ' recipe-tab-pill--active' : '');
    btn.textContent = r.name || `Recipe ${i+1}`;
    btn.addEventListener('click', () => { state.activeRecipeIndex = i; renderRecipeTabs(); renderRecipePanel(); });
    container.appendChild(btn);
  });
}

function renderRecipePanel() {
  const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
  const nameInput = document.getElementById('recipe-name-input'); if (nameInput) nameInput.value = recipe.name||'';
  document.getElementById('recipe-search-input').value = recipe.entryFood.name||'';
  document.getElementById('recipe-entry-cf').value     = recipe.entryFood.carbFactor||'';
  document.getElementById('recipe-entry-weight').value = recipe.entryFood.weightG||'';
  document.getElementById('recipe-entry-carbs').value  = recipe.entryFood.carbsG||'';
  renderRecipeIngredients(); renderRecipeComposite();
}

function renderRecipeIngredients() {
  const tbody = document.getElementById('recipe-ingredient-rows'); if (!tbody) return;
  const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
  tbody.innerHTML = '';
  recipe.ingredients.forEach((ing, i) => {
    const carbsVal = calcNetCarbs(parseFloat(ing.weightG) || 0, ing.carbFactor || 0);
    const row = document.createElement('tr');
    row.innerHTML = `<td>${escHtml(ing.name)}</td><td>${ing.carbFactor!=null?ing.carbFactor:'—'}</td>
      <td><input type="number" class="input input--sm ing-weight" value="${ing.weightG||''}" min="0" step="1" /></td>
      <td><input type="number" class="input input--sm ing-carbs" value="${carbsVal||''}" min="0" step="0.1" /></td>
      <td><button class="btn btn--icon">×</button></td>`;

    const weightInput = row.querySelector('.ing-weight');
    const carbsInput  = row.querySelector('.ing-carbs');

    weightInput.addEventListener('input', e => {
      const w = parseFloat(e.target.value) || 0;
      recipe.ingredients[i].weightG = w;
      if (ing.carbFactor) carbsInput.value = calcNetCarbs(w, ing.carbFactor);
      renderRecipeComposite();
    });
    carbsInput.addEventListener('input', e => {
      const c = parseFloat(e.target.value) || 0;
      if (ing.carbFactor) {
        const w = calcWeightFromCarbs(c, ing.carbFactor);
        recipe.ingredients[i].weightG = w;
        weightInput.value = w;
      }
      renderRecipeComposite();
    });
    row.querySelector('button').addEventListener('click', () => {
      recipe.ingredients.splice(i, 1); renderRecipeIngredients(); renderRecipeComposite();
      persistRecipeDraft();
    });

    tbody.appendChild(row);
  });
}

function renderRecipeComposite() {
  const recipe = state.recipes[state.activeRecipeIndex]; if (!recipe) return;
  const totalWeight = recipe.ingredients.reduce((s, i) => s+(parseFloat(i.weightG)||0), 0);
  const totalCarbs  = recipe.ingredients.reduce((s, i) => s+calcNetCarbs(parseFloat(i.weightG)||0, i.carbFactor||0), 0);
  const cf          = calcCompositeCF(totalCarbs, totalWeight);
  setText('recipe-total-weight', totalWeight.toFixed(1)+' g');
  setText('recipe-total-carbs',  totalCarbs.toFixed(1)+' g');
  setText('recipe-composite-cf', cf ? cf.toFixed(4) : '—');
  const pw = parseFloat(document.getElementById('recipe-portion-weight')?.value)||0;
  if (pw && cf) { const portionCarbsEl = document.getElementById('recipe-portion-carbs'); if (portionCarbsEl) portionCarbsEl.value = Math.round(pw*cf*10)/10; }
}

// ─── BG/IOB/COB FETCH ────────────────────────────────────────────────────────

async function fetchBG() {
  const btn = document.getElementById('fetch-bg-btn'); if (btn) showSpinner(btn);
  try {
    const bgSrc = inferBGSource();
    let result;
    if (bgSrc === 'nightscout')    result = await nsBG(state.units);
    else if (bgSrc === 'dexcom') result = await dexBG(state.units);
    else return;
    const meal = getCurrentMeal(); meal.currentBG = result.value; meal.bgTimestamp = result.timestamp; meal.bgTrend = result.trend||null;
    setVal('bg-value', result.value); renderBGPanel(); updateBolusLive();
    showToast(`BG: ${formatBG(result.value, state.units)} ${state.units==='mmol'?'mmol/L':'mg/dL'}`, 'success');
  } catch (err) { showToast('BG fetch failed: ' + err.message, 'error'); } finally { if (btn) hideSpinner(btn); }
}

async function fetchIOB() {
  const btn = document.getElementById('fetch-iob-btn'); if (btn) showSpinner(btn);
  try { const result = await nsIOB(); getCurrentMeal().iob = result.value; setVal('iob-value', result.value); updateBolusLive(); showToast(`IOB: ${result.value} U`, 'success'); }
  catch (err) { showToast('IOB fetch failed: ' + err.message, 'error'); } finally { if (btn) hideSpinner(btn); }
}

async function fetchCOB() {
  const btn = document.getElementById('fetch-cob-btn'); if (btn) showSpinner(btn);
  try { const result = await nsCOB(); getCurrentMeal().cob = result.value; setVal('cob-value', result.value); showToast(`COB: ${result.value} g`, 'success'); }
  catch (err) { showToast('COB fetch failed: ' + err.message, 'error'); } finally { if (btn) hideSpinner(btn); }
}

async function fetchNightscoutProfile() {
  const btn = document.getElementById('fetch-profile-btn'); if (btn) showSpinner(btn);
  try {
    const profile = await nsProfile(state.units);
    if (profile.icr)       { setMealSettings(state.activeMeal, { icr: profile.icr });             setVal('icr-input',       profile.icr); }
    if (profile.isf)       { setMealSettings(state.activeMeal, { isf: profile.isf });             setVal('isf-input',       profile.isf); }
    if (profile.target_bg) { setMealSettings(state.activeMeal, { target_bg: profile.target_bg }); setVal('target-bg-input', profile.target_bg); }
    persistConfig(); updateBolusLive(); showToast('Profile loaded from Nightscout', 'success');
  } catch (err) { showToast('Profile fetch failed: ' + err.message, 'error'); } finally { if (btn) hideSpinner(btn); }
}

// ─── EXPORT TIMER ────────────────────────────────────────────────────────────

function setupExportTimer() {
  let lastCheck = todayStr();
  setInterval(async () => {
    const today = todayStr();
    if (today !== lastCheck) {
      const yesterday = lastCheck; lastCheck = today;
      const lastExport = storage.get('last_export_date');
      if (lastExport !== yesterday) {
        const meals = buildDayExportPayload(MEAL_SLUGS);
        if (meals.length > 0) {
          try {
            if (state.connected) {
              const result = await logMeal({ meals, units: state.units, date: yesterday });
              if (result?.success) {
                storage.set('last_export_date', yesterday);
                MEAL_SLUGS.forEach(clearMeal);
                showToast("Yesterday's log exported automatically", 'success');
                return;
              }
            }
            downloadCSV(flattenToCSVRows(meals));
            MEAL_SLUGS.forEach(clearMeal);
            showToast("Yesterday's log saved locally (offline)", 'info');
          } catch (err) {
     		  console.error('Export failed:', err);
              downloadCSV(flattenToCSVRows(meals));
            MEAL_SLUGS.forEach(clearMeal);
            showToast("Yesterday's log saved locally (offline)", 'info');
          }
        }
      }
    }
  }, 60000);
}

// ─── PERSIST CONFIG ──────────────────────────────────────────────────────────

const _debouncedSetConfig = debounce(async (config) => {
  try { await setConfig(config); } catch {}
}, 1000);

const _debouncedDraftSavers = {};
function persistDraftState(slug) {
  if (!state.connected) return;
  if (!slug) slug = state.activeMeal;
  if (!_debouncedDraftSavers[slug]) {
    _debouncedDraftSavers[slug] = debounce(async (s) => {
      try { await setDraftState(s, serializeMealForDraft(s)); }
      catch (err) { console.error('setDraftState failed for', s, err); }
    }, 1000);
  }
  _debouncedDraftSavers[slug](slug);
}

function serializeRecipesForDraft() {
  return state.recipes.map(r => ({
    name: r.name,
    ingredients: r.ingredients
  }));
}

const _debouncedRecipeDraftSave = debounce(async () => {
  if (!state.connected) return;
  const payload = serializeRecipesForDraft();
  // Guard: never let an empty/all-deleted recipe list overwrite previously
  // saved recipes (prevents a stale idle device from wiping real data).
  const hasContent = payload.some(r => r.ingredients && r.ingredients.length);
  if (!hasContent) return;
  try { await setDraftState('recipes', payload); }
  catch (err) { console.error('setDraftState failed for recipes', err); }
}, 1000);

function persistRecipeDraft() {
  if (!state.connected) return;
  _debouncedRecipeDraftSave();
}

// ─── NIGHTSCOUT POLLING ──────────────────────────────────────────────────────

async function pollNightscout() {
  const ns = storage.get('ns_config');
  if (!ns?.url) return;

  const [bgRes, iobRes, cobRes, profileRes] = await Promise.allSettled([
    nsBG(state.units), nsIOB(), nsCOB(), nsProfile(state.units)
  ]);

  const bg      = bgRes.status === 'fulfilled'      ? bgRes.value      : null;
  const iob     = iobRes.status === 'fulfilled'     ? iobRes.value     : null;
  const cob     = cobRes.status === 'fulfilled'     ? cobRes.value     : null;
  const profile = profileRes.status === 'fulfilled' ? profileRes.value : null;

  const now = new Date();
  const activeEl = document.activeElement;

  MEAL_SLUGS.forEach(slug => {
    const meal = state.meals[slug];
    const lockedAt = state.bolusLockedAt[slug];

    if (lockedAt) {
      if (bg) recordAutoPostMealReading(slug, lockedAt, bg, now);
      return;
    }

    const isActive = slug === state.activeMeal;

    if (bg && !(isActive && activeEl?.id === 'bg-value')) {
      meal.currentBG = bg.value; meal.bgTimestamp = bg.timestamp; meal.bgTrend = bg.trend || null;
    }
    if (iob && !(isActive && activeEl?.id === 'iob-value')) meal.iob = iob.value;
    if (cob && !(isActive && activeEl?.id === 'cob-value')) meal.cob = cob.value;

    if (profile) {
      const updates = {};
      if (profile.icr != null       && !(isActive && activeEl?.id === 'icr-input'))       updates.icr = profile.icr;
      if (profile.isf != null       && !(isActive && activeEl?.id === 'isf-input'))       updates.isf = profile.isf;
      if (profile.target_bg != null && !(isActive && activeEl?.id === 'target-bg-input')) updates.target_bg = profile.target_bg;
      if (Object.keys(updates).length) setMealSettings(slug, updates);
    }

    meal.lastSyncAt = now;
  });

  renderBGPanel();
  renderMealSettingsPanel();
  updateBolusLive();
  persistConfig();
}

function recordAutoPostMealReading(slug, lockedAt, bg, now) {
  const meal = state.meals[slug];
  const minSinceBolus = (now.getTime() - lockedAt.getTime()) / 60000;
  if (minSinceBolus < 0 || minSinceBolus > 300) return;

  const roundedMin = Math.round(minSinceBolus / 5) * 5;
  const maxRecorded = meal.postBgReadings
    .filter(r => typeof r.minSinceBolus === 'number')
    .reduce((max, r) => Math.max(max, r.minSinceBolus), -1);

  if (roundedMin <= maxRecorded || roundedMin > 300) return;

  const prevBg = meal.postBgReadings.length
    ? meal.postBgReadings[meal.postBgReadings.length - 1].bg
    : (parseFloat(meal.currentBG) || null);
  const delta = (prevBg != null && bg.value != null)
    ? Math.round((bg.value - prevBg) * 10) / 10
    : '';

  meal.postBgReadings.push({
    time: hhmmDisplay(now),
    minSinceBolus: roundedMin,
    bg: bg.value,
    trend: bg.trend || '',
    delta
  });
  persistDraftState(slug);

  if (slug === state.activeMeal) renderPostMealTracker();
}

function setupNightscoutPolling() {
  if (state.nsPollID) clearInterval(state.nsPollID);
  const ns = storage.get('ns_config');
  if (!ns?.url) return;
  pollNightscout();
  state.nsPollID = setInterval(pollNightscout, 60000);
}

function updateSyncIndicator() {
  const el    = document.getElementById('factors-sync-status');
  const agoEl = document.getElementById('sync-ago');
  if (!el || !agoEl) return;

  const ns     = storage.get('ns_config');
  const meal   = getCurrentMeal();
  const locked = state.bolusLockedAt[state.activeMeal];

  if (!ns?.url || locked || !meal.lastSyncAt) { el.hidden = true; return; }

  el.hidden = false;
  const secs = Math.floor((Date.now() - meal.lastSyncAt.getTime()) / 1000);
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  agoEl.textContent = `${mm}:${String(ss).padStart(2, '0')}`;
}

function persistConfig(overrides = {}) {
  const meals = {}; MEAL_SLUGS.forEach(slug => { meals[slug] = getMealSettings(slug); });
  const config = {
    units: state.units,
    color_theme: storage.get('color_theme', 'custom'),
    mode: storage.get('mode', 'system'),
    nightscout_url: (storage.get('ns_config') || {}).url || '',
    nightscout_secret: (storage.get('ns_config') || {}).secret || '',
    dexcom_user: (storage.get('dexcom_config') || {}).user || '',
    dexcom_pass: (storage.get('dexcom_config') || {}).pass || '',
    dexcom_region: (storage.get('dexcom_config') || {}).region || 'us',
    meals,
    ...overrides
  };
  if (state.connected) _debouncedSetConfig(config);
}

document.addEventListener('DOMContentLoaded', init);
