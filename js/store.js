// App state persisted to localStorage, plus declarative bindings between
// form controls and state paths (data-bind / data-show / data-step).
import { DEFAULT_SETTINGS } from './rhythm.js';

const KEY = 'rhythm-trainer.v1';

export function defaults() {
  return {
    metronome: {
      bpm: 120, num: 4, den: 4, sub: 1, markOne: true, sound: 'recorded', pads: null, countdown: 0, volume: 80, elapsed: 0,
      gap: { on: false, play: 2, mute: 2 },
      step: { on: false, mode: 'up', amount: 5, every: 4, unit: 'bars', target: 160 },
    },
    gen: { ...DEFAULT_SETTINGS, passes: 2, readingMode: false, playAlong: false, readingMinutes: 1 },
    presets: [],
    setlist: [],
    history: [],
    prefs: { calibrationMs: 0, strictness: 'normal', hearRhythm: false, keepAwake: true, theme: 'auto' },
  };
}

// Deep-merge saved data over defaults so new settings get sane values.
function merge(base, saved) {
  if (Array.isArray(base) || base === null || typeof base !== 'object') return saved === undefined ? base : saved;
  const out = { ...base };
  if (saved && typeof saved === 'object') {
    for (const k of Object.keys(saved)) out[k] = k in base ? merge(base[k], saved[k]) : saved[k];
  }
  return out;
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return merge(defaults(), JSON.parse(raw));
  } catch { /* storage unavailable or corrupt */ }
  return defaults();
}

export const state = load();

let saveTimer = null;
export function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
export function saveNow() {
  clearTimeout(saveTimer);
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch { /* quota or private mode */ }
}
window.addEventListener('pagehide', saveNow);

export function replaceState(data) {
  const next = merge(defaults(), data);
  for (const k of Object.keys(state)) delete state[k];
  Object.assign(state, next);
  saveNow();
}

export function get(path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), state);
}

export function set(path, value) {
  const keys = path.split('.');
  const last = keys.pop();
  const obj = keys.reduce((o, k) => o[k], state);
  if (obj[last] === value) return;
  obj[last] = value;
  save();
  emit(path, value);
}

// Display formatters for data-show="..." data-format="...".
const FORMATS = {
  swing: (v) => `${Math.round((v - 50) * 4)}%`,
};

const listeners = [];
// Subscribe to changes of any path starting with `prefix`.
export function on(prefix, fn) {
  listeners.push({ prefix, fn });
}
function emit(path, value) {
  for (const l of listeners) if (path === l.prefix || path.startsWith(l.prefix + '.')) l.fn(path, value);
  refresh(path);
}

function clampFor(path, v) {
  const el = document.querySelector(`[data-bind="${path}"][min], [data-bind="${path}"][max]`);
  if (!el) return v;
  const min = el.min !== '' ? Number(el.min) : -Infinity;
  const max = el.max !== '' ? Number(el.max) : Infinity;
  return Math.min(max, Math.max(min, v));
}

// Write state values into all bound controls (optionally only one path).
export function refresh(path) {
  const sel = path ? `[data-bind="${path}"]` : '[data-bind]';
  document.querySelectorAll(sel).forEach((el) => {
    const v = get(el.dataset.bind);
    if (el.classList.contains('seg')) {
      el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', String(v) === b.dataset.value));
    } else if (el.type === 'checkbox') {
      el.checked = !!v;
    } else if (el.tagName === 'SELECT') {
      el.value = String(v);
    } else if (document.activeElement !== el || el.type === 'range') {
      el.value = v;
    }
  });
  const showSel = path ? `[data-show="${path}"]` : '[data-show]';
  document.querySelectorAll(showSel).forEach((el) => {
    const v = get(el.dataset.show);
    const fmt = FORMATS[el.dataset.format];
    el.textContent = (fmt ? fmt(v) : v) + (el.dataset.suffix || '');
  });
}

export function bindAll(root = document) {
  root.querySelectorAll('[data-bind]').forEach((el) => {
    const path = el.dataset.bind;
    if (el.classList.contains('seg')) {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        e.preventDefault();
        set(path, 'num' in el.dataset ? Number(b.dataset.value) : b.dataset.value);
      });
      return;
    }
    const read = () => {
      if (el.type === 'checkbox') return el.checked;
      if ('bool' in el.dataset) return el.value === 'true';
      if (el.type === 'range' || el.type === 'number' || 'num' in el.dataset) {
        const n = Number(el.value);
        return Number.isFinite(n) ? clampFor(path, n) : get(path);
      }
      return el.value;
    };
    const evt = el.type === 'range' ? 'input' : 'change';
    el.addEventListener(evt, () => {
      set(path, read());
      if (el.type === 'number') el.value = get(path);
    });
  });
  root.querySelectorAll('[data-step]').forEach((btn) => {
    const path = btn.dataset.step;
    const delta = Number(btn.dataset.delta);
    const stepOnce = () => set(path, clampFor(path, Number(get(path)) + delta));
    // Press and hold repeats.
    let holdTimer = null;
    let repeatTimer = null;
    const stop = () => {
      clearTimeout(holdTimer);
      clearInterval(repeatTimer);
    };
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      stepOnce();
      holdTimer = setTimeout(() => { repeatTimer = setInterval(stepOnce, 70); }, 400);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => btn.addEventListener(t, stop));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      // Keyboard activation (pointer handled above).
      if (e.detail === 0) stepOnce();
    });
  });
  refresh();
}
