import { audio, SOUNDS } from './audio.js';
import { state, bindAll, on, refresh } from './store.js';
import * as metronome from './metronome.js';
import * as rhythmUi from './rhythm-ui.js';
import * as reading from './reading.js';
import * as settings from './settings.js';

export const VERSION = '1.0.0';

const tabs = { metronome, rhythm: rhythmUi, reading, settings };

function fillSoundSelects() {
  const opts = Object.entries(SOUNDS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  document.querySelectorAll('.sound-select').forEach((s) => { s.innerHTML = opts; });
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.getElementById('title').textContent = document.getElementById(`tab-${name}`).dataset.title;
  try { localStorage.setItem('rhythm-trainer.tab', name); } catch { /* ignore */ }
  window.scrollTo(0, 0);
  tabs[name].onShow?.();
}

function applyCalibration() {
  audio.latencyOffset = (state.prefs.calibrationMs || 0) / 1000;
}

function init() {
  fillSoundSelects();
  bindAll();
  metronome.init();
  rhythmUi.init();
  reading.init();
  settings.init({
    onReplaced: () => {
      metronome.onDataReplaced();
      rhythmUi.onDataReplaced();
      applyCalibration();
    },
  });
  applyCalibration();
  on('prefs.calibrationMs', applyCalibration);
  document.getElementById('s-version').textContent = `v${VERSION}`;

  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  let first = 'metronome';
  try { first = localStorage.getItem('rhythm-trainer.tab') || first; } catch { /* ignore */ }
  showTab(tabs[first] ? first : 'metronome');
  refresh();

  // Unlock audio on the first touch (required by mobile browsers).
  const unlock = () => {
    audio.ensure();
    window.removeEventListener('pointerdown', unlock, true);
  };
  window.addEventListener('pointerdown', unlock, true);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
