import { generateRhythm, generateBar, TIME_SIGNATURES } from './rhythm.js';
import { renderRow, barMinWidth, setNoteClass } from './notation.js';
import { state, set, on, save, refresh } from './store.js';
import { scheduler, claim, release, isOwner } from './transport.js';
import { PlayAlong } from './playalong.js';
import { rhythmBarEvents, countInBar, sessionMeta } from './playback.js';
import { openModal, toast, escapeHtml } from './ui.js';

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
  const width = Math.floor(el.clientWidth || 360);
  const need = Math.max(...rhythm.map(barMinWidth));
  barsPerRow = Math.max(1, Math.min(4, rhythm.length, Math.floor((width - 30) / need)));
  // Avoid a lonely last bar: 3 bars per row with 4 bars -> use 2.
  if (rhythm.length % barsPerRow !== 0 && barsPerRow > 1) {
    while (barsPerRow > 1 && rhythm.length % barsPerRow !== 0) barsPerRow--;
  }
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
    el.innerHTML = `<div class="error">Could not draw this rhythm (${escapeHtml(err.message)}). Tap “New rhythm”.</div>`;
    console.error(err);
  }
  renderedVersion = version;
  lastPlaying = null;
}

function newRhythm() {
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
  if (playing) stop();
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

function start(alongMode = false) {
  if (!rhythm) newRhythm();
  claim('rhythm', () => stopUi());
  playing = true;
  clearMarks();
  if (alongMode) {
    along = new PlayAlong({
      mode: 'rhythm',
      liveEl: $('r-live'),
      onResult,
      onStopRequest: () => stop(),
      onDrill: drill,
    });
    along.start(sessionMeta(gen()));
    window.scrollTo({ top: 0 });
  }
  scheduler.start(makeSource(alongMode), {
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
      if (row && rhythm.length > barsPerRow) row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    },
    // Give the last note's timing window a moment before scoring ends.
    onEnd: () => setTimeout(() => isOwner('rhythm') && stop(), 300),
  });
  $('r-play').textContent = '■';
  $('r-play').classList.add('playing');
  $('r-along').textContent = alongMode ? 'Stop' : 'Play along';
}

function stopUi() {
  playing = false;
  showCountIn(null);
  if (lastPlaying) setNoteClass(lastPlaying, 'playing', false);
  lastPlaying = null;
  $('r-play').textContent = '▶';
  $('r-play').classList.remove('playing');
  $('r-along').textContent = 'Play along';
  const a = along;
  along = null;
  a?.end(true);
  if (pending) {
    rhythm = pending;
    pending = null;
    version++;
    render();
  }
}

export function stop() {
  if (isOwner('rhythm')) scheduler.stop();
  release('rhythm');
  if (playing) stopUi();
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
    <h2>Save preset</h2>
    <input type="text" id="preset-name" maxlength="40" placeholder="Preset name">
    <div class="row" style="justify-content:flex-end;margin-top:12px">
      <button class="btn ghost" data-close>Cancel</button><button class="btn accent" id="preset-ok">Save</button>
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
  if (!rhythm) newRhythm();
  else if (!playing) render(); // width may have changed while the tab was hidden
}

export function init() {
  $('r-timesig').innerHTML = TIME_SIGNATURES.map((t) => `<option value="${t}">${t}</option>`).join('');
  refresh('gen.timeSig');
  renderPresets();
  $('r-new').addEventListener('click', newRhythm);
  $('r-play').addEventListener('click', () => (playing ? stop() : start(false)));
  $('r-along').addEventListener('click', () => {
    if (playing) stop();
    else start(true);
  });
  $('r-presets').addEventListener('change', (e) => e.target.value && applyPreset(e.target.value));
  $('r-preset-save').addEventListener('click', savePreset);
  $('r-preset-del').addEventListener('click', deletePreset);
  on('gen', (path) => {
    const key = path.split('.')[1];
    if (REGEN_KEYS.includes(key)) {
      if (rhythm) newRhythm();
    }
    if (key === 'bpm' && playing) scheduler.setBpm(gen().bpm);
  });
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (rhythm && !$('tab-rhythm').hidden) render();
    }, 200);
  });
}

export function onDataReplaced() {
  renderPresets();
  if (!playing) newRhythm();
}

export { generateBar };
