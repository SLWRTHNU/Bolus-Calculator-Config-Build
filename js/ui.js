import { storage } from './storage.js';

let toastTimer = null;

export function showToast(message, type = 'info', duration = 3000) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast toast--${type} toast--visible`;
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, duration);
}

export function showSpinner(el) {
  el.disabled = true;
  el.dataset.originalText = el.innerHTML;
  el.innerHTML = '<span class="spinner"></span>';
}

export function hideSpinner(el) {
  el.disabled = false;
  el.innerHTML = el.dataset.originalText || '';
}

// Colour theme (green / amber / purple / slate / rose)
export function applyColorTheme(colorTheme) {
  document.documentElement.setAttribute('data-theme', colorTheme);
  storage.set('color_theme', colorTheme);
}

// Light / dark mode (dark | light | system)
export function applyMode(mode) {
  let resolved = mode;
  if (mode === 'system') {
    resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-mode', resolved);
  storage.set('mode', mode);
}

// Legacy shim – called by config restore path in app.js
export function applyTheme(value) {
  if (value === 'dark' || value === 'light' || value === 'system') {
    applyMode(value);
  } else {
    applyColorTheme(value);
  }
}

export function initTheme() {
  const savedColor = storage.get('color_theme', 'custom');
  const savedMode  = storage.get('mode', 'system');
  applyColorTheme(savedColor);
  applyMode(savedMode);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (storage.get('mode', 'system') === 'system') applyMode('system');
  });
}

export function formatTime(date) {
  return date.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit', hour12: true });
}

export function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayStr() {
  return formatDate(new Date());
}

export function navigate(sectionId) {
  document.querySelectorAll('.section').forEach(s => s.hidden = true);
  const target = document.getElementById(sectionId);
  if (target) target.hidden = false;

  document.querySelectorAll('[data-nav]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.nav === sectionId);
  });

  window.location.hash = '#' + sectionId;
}

export function getCurrentSection() {
  const hash = window.location.hash.replace('#', '');
  const valid = ['calculator','log','how-to','contact','donate','settings'];
  return valid.includes(hash) ? hash : 'calculator';
}

export function showError(el, message) {
  el.textContent = message;
  el.hidden = false;
}

export function clearError(el) {
  el.textContent = '';
  el.hidden = true;
}

export function debounce(fn, delay) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

export function createFoodDropdown(results, onSelect) {
  const existing = document.querySelector('.food-dropdown');
  if (existing) existing.remove();

  if (!results.length) return null;

  const dropdown = document.createElement('ul');
  dropdown.className = 'food-dropdown';
  dropdown.setAttribute('role', 'listbox');

  results.forEach(food => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('tabindex', '0');
    li.innerHTML = `
      <span class="food-name">${escHtml(food.name)}</span>
      <span class="food-badge food-badge--${food.source === 'personal' ? 'personal' : 'hc'}">
        ${food.source === 'personal' ? 'Personal' : 'HC'}
      </span>
      <span class="food-absorption">${food.absorptionRate}h</span>
    `;
    li.addEventListener('mousedown', e => { e.preventDefault(); onSelect(food); dropdown.remove(); });
    li.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { onSelect(food); dropdown.remove(); }
      if (e.key === 'ArrowDown') { const n = li.nextElementSibling; if (n) n.focus(); }
      if (e.key === 'ArrowUp')   { const p = li.previousElementSibling; if (p) p.focus(); }
    });
    dropdown.appendChild(li);
  });

  return dropdown;
}

export function positionDropdown(dropdown, referenceEl) {
  if (!dropdown || !referenceEl) return;
  const rect = referenceEl.getBoundingClientRect();
  dropdown.style.position = 'fixed';
  dropdown.style.top  = (rect.bottom + 2) + 'px';
  dropdown.style.left = rect.left + 'px';
  dropdown.style.width = Math.max(rect.width, 260) + 'px';
  document.body.appendChild(dropdown);
}

// ── Tools dropdown ──────────────────────────────────────────────────────────

export function toggleToolsDropdown() {
  const dd = document.getElementById('tools-dropdown');
  if (!dd) return;
  const isOpen = !dd.hidden;
  dd.hidden = isOpen;
  if (!isOpen) {
    // Close when clicking outside
    const close = e => {
      if (!dd.contains(e.target) && e.target.id !== 'tools-btn') {
        dd.hidden = true;
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 0);
  }
}

// ── Elapsed timer helpers ───────────────────────────────────────────────────

export function elapsedMMSS(fromDate) {
  const diff = Math.max(0, Math.floor((Date.now() - fromDate.getTime()) / 1000));
  const m = Math.floor(diff / 60).toString().padStart(2, '0');
  const s = (diff % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

// ── Recipe panel ─────────────────────────────────────────────────────────────

export function openRecipePanel() {
  closeFoodSearchPanel();
  closeAddFoodPanel();
  const panel = document.getElementById('recipe-panel');
  if (panel) panel.hidden = false;
  document.getElementById('calculator-layout')?.classList.add('recipe-open');
}

export function closeRecipePanel() {
  const panel = document.getElementById('recipe-panel');
  if (panel) panel.hidden = true;
  document.getElementById('calculator-layout')?.classList.remove('recipe-open');
}

export function openFoodSearchPanel() {
  closeRecipePanel();
  closeAddFoodPanel();
  const panel = document.getElementById('food-search-panel');
  if (panel) panel.hidden = false;
  document.getElementById('calculator-layout')?.classList.add('recipe-open');
}

export function closeFoodSearchPanel() {
  const panel = document.getElementById('food-search-panel');
  if (panel) panel.hidden = true;
  document.getElementById('calculator-layout')?.classList.remove('recipe-open');
}

export function openAddFoodPanel() {
  closeRecipePanel();
  closeFoodSearchPanel();
  const panel = document.getElementById('add-food-panel');
  if (panel) panel.hidden = false;
  document.getElementById('calculator-layout')?.classList.add('recipe-open');
}

export function closeAddFoodPanel() {
  const panel = document.getElementById('add-food-panel');
  if (panel) panel.hidden = true;
  document.getElementById('calculator-layout')?.classList.remove('recipe-open');
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
