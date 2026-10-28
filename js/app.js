import { audio, METRO_SOUNDS, RHYTHM_SOUNDS } from './audio.js';
import { state, bindAll, on, refresh, save } from './store.js';
import * as metronome from './metronome.js';
import * as rhythmUi from './rhythm-ui.js';
import * as settings from './settings.js';
import { initSheets } from './ui.js';

export const VERSION = '1.2.1';

const tabs = { rhythm: rhythmUi, metronome, menu: settings };

function fillSoundSelects() {
  const opts = (list) => Object.entries(list).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
  document.querySelectorAll('.metro-sound-select').forEach((s) => { s.innerHTML = opts(METRO_SOUNDS); });
  document.querySelectorAll('.rhythm-sound-select').forEach((s) => { s.innerHTML = opts(RHYTHM_SOUNDS); });
  // Play the chosen sound once so it can be auditioned while picking.
  document.querySelectorAll('.metro-sound-select, .rhythm-sound-select').forEach((s) => {
    s.addEventListener('change', () => audio.play(s.value, 'normal', 0));
  });
}

// Sight-reading and metronome sounds are separate lists since v1.1; fix older saved choices.
function migrateSounds() {
  if (!(state.gen.sound in RHYTHM_SOUNDS)) state.gen.sound = 'snare';
  if (!(state.gen.clickSound in METRO_SOUNDS)) state.gen.clickSound = 'click';
  if (!(state.metronome.sound in METRO_SOUNDS)) state.metronome.sound = 'click';
  save();
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${name}`; });
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  document.body.classList.toggle('metro-on', name === 'metronome');
  settings.applyTheme();
  try { localStorage.setItem('rhythm-trainer.tab', name); } catch { /* ignore */ }
  window.scrollTo(0, 0);
  tabs[name].onShow?.();
}

function applyCalibration() {
  audio.latencyOffset = (state.prefs.calibrationMs || 0) / 1000;
}

function init() {
  migrateSounds();
  fillSoundSelects();
  initSheets();
  bindAll();
  metronome.init();
  rhythmUi.init();
  settings.init({
    onReplaced: () => {
      migrateSounds();
      metronome.onDataReplaced();
      rhythmUi.onDataReplaced();
      applyCalibration();
    },
  });
  applyCalibration();
  on('prefs.calibrationMs', applyCalibration);
  document.getElementById('s-version').textContent = `v${VERSION}`;

  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  let first = 'rhythm';
  try { first = localStorage.getItem('rhythm-trainer.tab') || first; } catch { /* ignore */ }
  showTab(tabs[first] ? first : 'rhythm');
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
