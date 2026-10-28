import { audio } from './audio.js';
import { state, set, save, saveNow, replaceState, refresh, on } from './store.js';
import { scheduler, claim, release } from './transport.js';
import { openModal, toast, escapeHtml } from './ui.js';

const $ = (id) => document.getElementById(id);

// ---- Calibration ----
// Plays a count-in bar and three bars of clicks at 100 BPM; the median
// difference between taps and clicks becomes the latency offset.
const CAL_BPM = 100;
const CAL_BARS = 4;

export function medianOffset(taps, clicks, maxDist = 0.25) {
  const diffs = [];
  for (const t of taps) {
    let best = null;
    for (const c of clicks) {
      const d = t - c;
      if (Math.abs(d) <= maxDist && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
    if (best !== null) diffs.push(best);
  }
  if (diffs.length < 6) return null;
  diffs.sort((a, b) => a - b);
  const mid = Math.floor(diffs.length / 2);
  return diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
}

function calibrate() {
  const clicks = [];
  const taps = [];
  const saved = audio.latencyOffset;
  audio.latencyOffset = 0;
  let finished = false;

  const { body, close } = openModal(`
    <h2>Calibrate</h2>
    <p class="small">Listen to the first 4 clicks, then tap the big button exactly with each click.</p>
    <button class="btn accent" id="cal-pad" style="width:100%;height:38vh;font-size:28px;border-radius:16px">Get ready…</button>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-close>Cancel</button></div>`, () => {
    if (!finished) {
      scheduler.stop();
      release('calibration');
      audio.latencyOffset = saved;
    }
  });
  const pad = body.querySelector('#cal-pad');
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    taps.push(audio.eventToAudioTime(e.timeStamp));
    pad.style.opacity = 0.7;
    setTimeout(() => { pad.style.opacity = 1; }, 70);
  });

  claim('calibration', () => close());
  scheduler.start({
    bpm: CAL_BPM,
    nextBar(i) {
      if (i >= CAL_BARS) return null;
      const events = [0, 1, 2, 3].map((b) => ({ beat: b, sound: 'click', variant: b === 0 ? 'accent' : 'normal', gain: 0.9 }));
      return {
        beats: 4,
        events,
        info: { i },
        onSchedule: (ev, t) => { if (i > 0) clicks.push(t); },
      };
    },
  }, {
    onBar: (info) => { pad.textContent = info.i === 0 ? 'Listen…' : 'Tap!'; },
    onEnd: () => setTimeout(() => {
      finished = true;
      release('calibration');
      const ignoreBefore = clicks[0] - 0.25;
      const off = medianOffset(taps.filter((t) => t >= ignoreBefore), clicks);
      if (off === null) {
        audio.latencyOffset = saved;
        body.innerHTML = '<h2>Calibrate</h2><p>Not enough taps lined up with the clicks. Try again and tap along with every click.</p><div class="row" style="justify-content:flex-end"><button class="btn accent" data-close>OK</button></div>';
      } else {
        const ms = Math.max(-250, Math.min(250, Math.round(off * 1000)));
        set('prefs.calibrationMs', ms);
        body.innerHTML = `<h2>Calibrated</h2><p>Your taps arrived <b>${Math.abs(ms)} ms ${ms >= 0 ? 'after' : 'before'}</b> the clicks. Play-along now corrects for this on this device.</p><div class="row" style="justify-content:flex-end"><button class="btn accent" data-close>Done</button></div>`;
        $('s-cal-out').textContent = `Offset ${ms} ms`;
      }
      body.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close()));
    }, 300),
  });
}

// ---- History ----
function renderHistory() {
  const ul = $('s-history');
  if (!state.history.length) {
    ul.innerHTML = '<li class="empty">Play-along results show up here.</li>';
    return;
  }
  ul.innerHTML = state.history.slice(0, 30).map((h) => {
    const d = new Date(h.date);
    const when = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return `<li><span class="grow"><b>${h.accuracy}%</b> · ${escapeHtml(h.mode)} · ${escapeHtml(h.timeSig)} · ${h.bpm} BPM · lvl ${h.complexity}<br>
      <span class="muted small">${when} · best streak ${h.bestStreak} · ${h.notes} notes</span></span></li>`;
  }).join('');
}

// ---- Backup ----
function exportData() {
  saveNow();
  const blob = new Blob([JSON.stringify({ app: 'rhythm-trainer', version: 1, data: state }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rhythm-trainer-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function importData(file, onReplaced) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      const data = parsed.data || parsed;
      if (!data || typeof data !== 'object' || !('gen' in data || 'metronome' in data)) throw new Error('not a backup');
      replaceState(data);
      refresh();
      onReplaced();
      toast('Backup restored');
    } catch {
      toast('That file is not a Rhythm Trainer backup');
    }
  };
  reader.readAsText(file);
}

export function applyTheme() {
  const t = state.prefs.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = dark ? '#101216' : '#f4f5f7';
}

export function init({ onReplaced }) {
  $('s-calibrate').addEventListener('click', calibrate);
  $('s-export').addEventListener('click', exportData);
  $('s-import').addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) importData(f, () => {
      renderHistory();
      applyTheme();
      onReplaced();
    });
    e.target.value = '';
  });
  $('s-history-clear').addEventListener('click', () => {
    state.history = [];
    save();
    renderHistory();
  });
  on('prefs.theme', applyTheme);
  applyTheme();
  renderHistory();
}

export function onShow() {
  renderHistory();
  const ms = state.prefs.calibrationMs;
  $('s-cal-out').textContent = ms ? `Offset ${ms} ms` : 'Not calibrated yet';
}
