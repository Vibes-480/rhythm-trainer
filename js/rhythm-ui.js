import { generateRhythm, generateBar, TIME_SIGNATURES } from './rhythm.js';
import { renderRow, barMinWidth, setNoteClass } from './notation.js';
import { state, set, on, save, refresh } from './store.js';
import { scheduler, claim, release, isOwner } from './transport.js';
import { PlayAlong } from './playalong.js';
import { rhythmBarEvents, countInBar, sessionMeta } from './playback.js';
import { openModal, toast, escapeHtml, openSheet } from './ui.js';
import * as reading from './reading.js';

const $ = (id) => document.getElementById(id);
const gen = () => state.gen;

// Settings that change what is generated (others only affect playback).
const REGEN_KEYS = ['bars', 'complexity', 'timeSig', 'subdivision', 'triplets', 'ghostNotes', 'accents', 'space'];

export const BUILTIN_PRESETS = [
  { name: 'Beginner: quarters & 8ths', settings: { complexity: 2, subdivision: '8th', timeSig: '4/4', triplets: false, ghostNotes: false, accents: false, swing: 50, space: 10, bpm: 80, bars: 2 } },
  { name: '16th-note funk', settings: { complexity: 6, subdivision: '16th', timeSig: '4/4', triplets: false, ghostNotes: true, accents: true, swing: 50, space: 15, bpm: 90, bars: 2 } },
  { name: 'Triplet mix', settings: { complexity: 5, subdivision: '8th', timeSig: '4/4', triplets: true, ghostNotes: false, accents: false, swing: 50, space: 10, bpm: 80, bars: 2 } },
  { name: 'Swung 8ths', settings: { complexity: 4, subdivision: '8th', timeSig: '4/4', triplets: false, ghostNotes: false, accents: true, swing: 66, space: 15, bpm: 120, bars: 2 } },
  { name: '6/8 groove', settings: { complexity: 4, subdivision: '16th', timeSig: '6/8', triplets: false, ghostNotes: false, accents: false, swing: 50, space: 15, bpm: 150, bars: 2 } },
  { name: 'Odd meter 7/8', settings: { complexity: 5, subdivision: '8th', timeSig: '7/8', triplets: false, ghostNotes: false, accents: false, swing: 50, space: 10, bpm: 180, bars: 2 } },
  { name: 'Syncopation workout', settings: { complexity: 9, subdivision: '16th', timeSig: '4/4', triplets: false, ghostNotes: false, accents: false, swing: 50, space: 30, bpm: 70, bars: 2 } },
];

let rhythm = null;
let pending = null;
let version = 0;
let renderedVersion = -1;
let noteMap = new Map();
let rowEls = [];
let barsPerRow = 1;
let playing = false;
let along = null;
let lastPlaying = null;

export function current() {
  return rhythm;
}

function render() {
  const el = $('r-notation');
  const width = Math.floor(el.clientWidth || 360) - 18; // minus the row's thick edges
  // One bar per row on phones, like a printed exercise; two on wide screens if they fit.
  const need = Math.max(...rhythm.map(barMinWidth));
  barsPerRow = width >= 600 && rhythm.length > 1 && need * 2 + 30 <= width ? 2 : 1;
  el.innerHTML = '';
  noteMap = new Map();
  rowEls = [];
  try {
    for (let r = 0; r < rhythm.length; r += barsPerRow) {
      const row = document.createElement('div');
      row.className = 'nrow';
      el.append(row);
      rowEls.push(row);
      const map = renderRow(row, rhythm.slice(r, r + barsPerRow), { width, firstBarIndex: r, showTimeSig: r === 0 });
      map.forEach((v, k) => noteMap.set(k, v));
    }
  } catch (err) {
    el.innerHTML = `<div class="error">Could not draw this rhythm (${escapeHtml(err.message)}). Tap the new-rhythm button.</div>`;
    console.error(err);
  }
  renderedVersion = version;
  lastPlaying = null;
}

function newRhythm() {
  if (gen().readingMode) {
    if (session) stop();
    reading.reset();
    return;
  }
  const r = generateRhythm(gen());
  if (playing) {
    pending = r;
    toast('New rhythm starts on the next loop');
  } else {
    rhythm = r;
    version++;
    render();
  }
}

export function setRhythm(bars) {
  if (session) stop();
  if (gen().readingMode) set('gen.readingMode', false);
  rhythm = bars;
  version++;
  render();
}

function clearMarks() {
  noteMap.forEach((n) => ['playing', 'hit', 'off', 'miss'].forEach((c) => setNoteClass(n, c, false)));
  lastPlaying = null;
}

function showCountIn(n) {
  const el = $('r-countin');
  el.hidden = n == null;
  if (n != null) el.textContent = n;
}

function makeSource(alongMode) {
  const g0 = gen();
  const countIn = g0.countIn || alongMode; // always count in before play-along
  const passes = alongMode ? g0.passes : g0.loop ? 0 : 1;
  const silent = alongMode && !state.prefs.hearRhythm;
  let patternBar = 0;
  let pass = 0;
  let countDone = !countIn;
  return {
    get bpm() {
      return gen().bpm;
    },
    nextBar() {
      const g = gen();
      if (!countDone) {
        countDone = true;
        return countInBar(g, rhythm[0].num, rhythm[0].den);
      }
      if (patternBar >= rhythm.length) {
        patternBar = 0;
        pass++;
      }
      if (passes && pass >= passes) return null;
      let swapped = false;
      if (patternBar === 0 && pending) {
        rhythm = pending;
        pending = null;
        version++;
        swapped = true;
      }
      const bar = rhythm[patternBar];
      const info = { patternBar, pass, version, swapped };
      const out = { beats: bar.num, bpm: g.bpm, events: rhythmBarEvents(bar, g, { silent }), info };
      if (along) {
        const a = along;
        const v = version;
        const pb = patternBar;
        out.onSchedule = (ev, t) => {
          if (!ev.note) return;
          a.add({ time: t, key: ev.key, groupData: bar.groups[ev.group], version: v, ref: `${pb}:${ev.group}:${ev.slot}` });
        };
      }
      patternBar++;
      return out;
    },
  };
}

function onResult(type, e) {
  if (type === 'extra' || e.version !== renderedVersion) return;
  const n = noteMap.get(e.ref);
  if (!n) return;
  setNoteClass(n, 'playing', false);
  if (type === 'miss') setNoteClass(n, 'miss');
  else setNoteClass(n, e.grade === 'perfect' || e.grade === 'good' ? 'hit' : 'off');
}

function startRhythm(alongSession) {
  if (!rhythm) newRhythm();
  claim('rhythm', () => stopUi());
  playing = true;
  along = alongSession;
  clearMarks();
  scheduler.start(makeSource(!!alongSession), {
    onEvent: (ev, info) => {
      if (ev.countIn != null) {
        showCountIn(ev.countIn);
        return;
      }
      if (!ev.note || !info || info.version !== renderedVersion) return;
      const n = noteMap.get(`${info.patternBar}:${ev.group}:${ev.slot}`);
      if (lastPlaying && lastPlaying !== n) setNoteClass(lastPlaying, 'playing', false);
      if (n) setNoteClass(n, 'playing');
      lastPlaying = n;
    },
    onBar: (info) => {
      if (info?.countIn) return;
      showCountIn(null);
      if (info.swapped || info.version !== renderedVersion) render();
      else if (info.patternBar === 0 && info.pass > 0) clearMarks();
      const row = rowEls[Math.floor(info.patternBar / barsPerRow)];
      if (row && rhythm.length > 2) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      onSessionBar(info);
    },
    // Give the last note's timing window a moment before scoring ends.
    onEnd: () => setTimeout(() => isOwner('rhythm') && stop(), 300),
  });
}

function stopUi() {
  if (!playing) return;
  playing = false;
  along = null;
  showCountIn(null);
  if (lastPlaying) setNoteClass(lastPlaying, 'playing', false);
  lastPlaying = null;
  if (pending) {
    rhythm = pending;
    pending = null;
    version++;
    render();
  }
  sessionEnded();
}

function stopRhythm() {
  if (isOwner('rhythm')) scheduler.stop();
  release('rhythm');
  stopUi();
}

// ---- Session controller: one play button for normal playback, Reading Mode and Play Along ----
let session = null;
let sessionTimer = null;

const fmtClock = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

function setPlayingUi(on, withAlong) {
  $('r-play').dataset.playing = on;
  $('r-play').setAttribute('aria-label', on ? 'Stop' : 'Play');
  $('r-along-top').hidden = !withAlong;
  $('r-progress').hidden = !withAlong;
  $('tap-pad').hidden = !withAlong;
  $('r-modes').hidden = withAlong;
  $('r-along-time').textContent = '00:00';
  $('r-progress-bar').style.width = '0%';
}

function updateSessionClock() {
  if (!session?.along) return;
  const elapsed = session.t0 ? (performance.now() - session.t0) / 1000 : 0;
  const limit = session.mode === 'reading' ? gen().readingMinutes * 60 : 0;
  if (limit) {
    $('r-along-time').textContent = fmtClock(limit - elapsed);
    $('r-progress-bar').style.width = `${Math.min(100, (elapsed / limit) * 100)}%`;
    if (elapsed >= limit) stop();
  } else {
    $('r-along-time').textContent = fmtClock(elapsed);
  }
}

function onSessionBar(info) {
  if (!session) return;
  if (!session.t0) session.t0 = performance.now();
  session.bars++;
  if (session.mode === 'rhythm' && session.along) {
    const passes = gen().passes;
    const total = rhythm.length * (passes || 1);
    const done = passes ? session.bars : ((session.bars - 1) % rhythm.length) + 1;
    $('r-progress-bar').style.width = `${Math.min(100, (done / total) * 100)}%`;
  }
}

function sessionEnded() {
  const s = session;
  if (!s) return;
  session = null;
  clearInterval(sessionTimer);
  setPlayingUi(false, false);
  s.along?.end(true);
}

export function play() {
  if (session) {
    stop();
    return;
  }
  const mode = gen().readingMode ? 'reading' : 'rhythm';
  let alongSession = null;
  if (gen().playAlong) {
    alongSession = new PlayAlong({
      mode: mode === 'reading' ? 'reading' : 'rhythm',
      liveEl: $('tab-rhythm'),
      onResult: (type, e) => (mode === 'reading' ? reading.onResult(type, e) : onResult(type, e)),
      onStopRequest: () => stop(),
      onDrill: mode === 'rhythm' ? drill : null,
    });
  }
  session = { mode, along: alongSession, t0: 0, bars: 0 };
  setPlayingUi(true, !!alongSession);
  if (alongSession) {
    alongSession.start(sessionMeta(gen()));
    window.scrollTo({ top: 0 });
  }
  if (mode === 'reading') reading.start(alongSession, { onStopped: sessionEnded, onBar: onSessionBar });
  else startRhythm(alongSession);
  clearInterval(sessionTimer);
  sessionTimer = setInterval(updateSessionClock, 200);
}

export function stop() {
  if (!session) return;
  if (session.mode === 'reading') reading.stop();
  else stopRhythm();
}

export function isPlaying() {
  return !!session;
}

function showMode() {
  const readingOn = gen().readingMode;
  $('r-notation').hidden = readingOn;
  $('rd-notation').hidden = !readingOn;
  if (readingOn) reading.reset();
  else if (rhythm) render();
  const hints = [];
  if (readingOn) hints.push('Reading Mode: new bars keep coming until you stop.');
  if (gen().playAlong) hints.push('Play Along: after the count-in, tap the big pad in time with the notes.');
  if (!hints.length) hints.push('Tap play to hear the rhythm, or the arrow button for a new one.');
  $('r-hint').textContent = hints.join(' ');
}

// Build a rhythm that repeats the groupings missed most often.
function drill(groups) {
  const g = gen();
  const den = Number(g.timeSig.split('/')[1]);
  const bars = generateRhythm(g).map((bar) => {
    bar.groups = bar.groups.map((grp) => {
      const fits = groups.filter((m) => m.lengthBeats === grp.lengthBeats && bar.den === den && (m.res === grp.res || m.kind === 'triplet'));
      if (!fits.length || Math.random() > 0.75) return grp;
      const pick = fits[Math.floor(Math.random() * fits.length)];
      return { ...JSON.parse(JSON.stringify(pick)), startBeat: grp.startBeat };
    });
    return bar;
  });
  setRhythm(bars);
  document.querySelector('[data-tab="rhythm"]').click();
  toast('Drilling your most missed groupings');
}

// ---- Presets ----
function renderPresets() {
  const sel = $('r-presets');
  const user = state.presets;
  sel.innerHTML = `<option value="">Choose…</option>
    <optgroup label="Built in">${BUILTIN_PRESETS.map((p, i) => `<option value="b${i}">${escapeHtml(p.name)}</option>`).join('')}</optgroup>
    ${user.length ? `<optgroup label="Mine">${user.map((p, i) => `<option value="u${i}">${escapeHtml(p.name)}</option>`).join('')}</optgroup>` : ''}`;
  $('r-preset-del').hidden = !user.length;
}

function applyPreset(value) {
  const list = value[0] === 'b' ? BUILTIN_PRESETS : state.presets;
  const p = list[Number(value.slice(1))];
  if (!p) return;
  Object.assign(state.gen, p.settings);
  save();
  refresh();
  newRhythm();
  toast(`Preset: ${p.name}`);
}

function savePreset() {
  const { body, close } = openModal(`
    <div class="sheet-head"><button class="sheet-close" data-close>CLOSE</button></div>
    <div class="modal-pad">
      <h3>Save preset</h3>
      <input type="text" id="preset-name" maxlength="40" placeholder="Preset name">
      <div class="modal-actions"><button class="pill" id="preset-ok">Save</button></div>
    </div>`);
  const input = body.querySelector('#preset-name');
  input.focus();
  const ok = () => {
    const name = input.value.trim() || `Preset ${state.presets.length + 1}`;
    const { passes, ...settings } = gen();
    state.presets.push({ name, settings: JSON.parse(JSON.stringify(settings)) });
    save();
    renderPresets();
    $('r-presets').value = `u${state.presets.length - 1}`;
    close();
    toast(`Saved preset "${name}"`);
  };
  body.querySelector('#preset-ok').addEventListener('click', ok);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && ok());
}

function deletePreset() {
  const v = $('r-presets').value;
  if (!v.startsWith('u')) {
    toast('Pick one of your own presets to delete');
    return;
  }
  const [removed] = state.presets.splice(Number(v.slice(1)), 1);
  save();
  renderPresets();
  toast(`Deleted "${removed.name}"`);
}

export function onShow() {
  if (gen().readingMode) {
    if (!session && reading.needsRedraw()) reading.reset();
  } else if (!rhythm) newRhythm();
  else if (!session) render(); // width may have changed while the tab was hidden
}

export function init() {
  $('r-timesig').innerHTML = TIME_SIGNATURES.map((t) => `<option value="${t}">${t}</option>`).join('');
  $('r-complexity-select').innerHTML = Array.from({ length: 10 }, (_, i) => `<option value="${i + 1}">Level ${i + 1}</option>`).join('');
  refresh('gen.timeSig');
  refresh('gen.complexity');
  renderPresets();
  $('r-new').addEventListener('click', newRhythm);
  $('r-play').addEventListener('click', play);
  $('r-all').addEventListener('click', () => openSheet('r-sheet'));
  document.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => openSheet('r-pick', 'data-pick-pane', b.dataset.pick)));
  $('r-presets').addEventListener('change', (e) => e.target.value && applyPreset(e.target.value));
  $('r-preset-save').addEventListener('click', savePreset);
  $('r-preset-del').addEventListener('click', deletePreset);
  on('gen', (path) => {
    const key = path.split('.')[1];
    if (key === 'readingMode' || key === 'playAlong') {
      if (session) stop();
      showMode();
      return;
    }
    if (REGEN_KEYS.includes(key)) {
      if (gen().readingMode) {
        if (!session && !$('tab-rhythm').hidden) reading.reset();
        else reading.invalidate();
      } else if (rhythm) newRhythm();
    }
    if (key === 'bpm' && session) scheduler.setBpm(gen().bpm);
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!$('tab-rhythm').hidden && !session) onShow();
    }, 200);
  });
  showMode();
}

export function onDataReplaced() {
  renderPresets();
  if (session) stop();
  rhythm = null;
  newRhythm();
  showMode();
}

export { generateBar };
