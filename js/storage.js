const PREFIX = 'lbc_';

export const storage = {
  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch {}
  },
  remove(key) { localStorage.removeItem(PREFIX + key); },
  clear(prefix = '') {
    Object.keys(localStorage)
      .filter(k => k.startsWith(PREFIX + prefix))
      .forEach(k => localStorage.removeItem(k));
  }
};

export const MEAL_SLUGS = [
  'breakfast', 'morning_snack', 'lunch', 'afternoon_snack', 'dinner', 'evening_snack'
];

export const MEAL_LABELS = {
  breakfast: 'Breakfast',
  morning_snack: 'Morning Snack',
  lunch: 'Lunch',
  afternoon_snack: 'Afternoon Snack',
  dinner: 'Dinner',
  evening_snack: 'Evening Snack'
};

export function getMealSettings(slug) {
  return {
    icr: storage.get(`meal_${slug}_icr`),
    isf: storage.get(`meal_${slug}_isf`),
    target_bg: storage.get(`meal_${slug}_target_bg`)
  };
}

export function setMealSettings(slug, settings) {
  if (settings.icr !== undefined) storage.set(`meal_${slug}_icr`, settings.icr);
  if (settings.isf !== undefined) storage.set(`meal_${slug}_isf`, settings.isf);
  if (settings.target_bg !== undefined) storage.set(`meal_${slug}_target_bg`, settings.target_bg);
}

export function getTodayLog() { return storage.get('today_log', []); }
export function setTodayLog(log) { storage.set('today_log', log); }

export function appendToLog(entry) {
  const log = getTodayLog();
  log.push(entry);
  setTodayLog(log);
}