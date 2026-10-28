// Endless sight-reading: rows of new bars keep scrolling in until you stop.
import { generateBar } from './rhythm.js';
import { renderRow, barMinWidth, setNoteClass } from './notation.js';
import { state, on } from './store.js';
import { scheduler, claim, release, isOwner } from './transport.js';
import { PlayAlong } from './playalong.js';
import { rhythmBarEvents, countInBar, sessionMeta } from './playback.js';
import { escapeHtml } from './ui.js';

const $ = (id) => document.getElementById(id);
const VISIBLE_ROWS = 3;

let bars = [];
let rows = []; // { start, count, el }
let firstVisible = 0;
let noteMap = new Map();
let playing = false;
let along = null;
let lastPlaying = null;
let width = 360;

function bar(i) {
  while (bars.length <= i) bars.push(generateBar(state.gen));
  return bars[i];
}

// Rows are filled greedily with as many bars as fit the screen width.
function row(r) {
  while (rows.length <= r) {
    const prev = rows[rows.length - 1];
    const start = prev ? prev.start + prev.count : 0;
    let count = 0;
    let used = start === 0 ? 30 : 0;
    while (count < 4) {
      const need = barMinWidth(bar(start + count));
      if (count > 0 && used + need > width) break;
      used += need;
      count++;
    }
    rows.push({ start, count, el: null });
  }
  return rows[r];
}

function drawRow(r) {
  const info = row(r);
  const el = document.createElement('div');
  el.className = 'nrow ahead';
  try {
    const map = renderRow(el, bars.slice(info.start, info.start + info.count), {
      width, firstBarIndex: info.start, showTimeSig: info.start === 0,
    });
    map.forEach((v, k) => noteMap.set(k, v));
  } catch (err) {
    el.innerHTML = `<div class="error">${escapeHtml(err.message)}</div>`;
  }
  info.el = el;
  return el;
}

function reset() {
  const container = $('rd-notation');
  width = Math.floor(container.clientWidth || 360);
  bars = [];
  rows = [];
  firstVisible = 0;
  noteMap = new Map();
  lastPlaying = null;
  container.innerHTML = '';
  for (let r = 0; r < VISIBLE_ROWS; r++) container.append(drawRow(r));
  markCurrent(0);
}

function markCurrent(r) {
  rows.forEach((x, i) => {
    if (!x.el) return;
    x.el.classList.toggle('current', i === r);
    x.el.classList.toggle('ahead', i !== r);
  });
}

function rowOfBar(i) {
  for (let r = 0; r < rows.length; r++) {
    if (i >= rows[r].start && i < rows[r].start + rows[r].count) return r;
  }
  return -1;
}

// Called when bar `i` starts sounding: keep the current row on top.
function advanceTo(i) {
  const r = rowOfBar(i);
  if (r < 0) return;
  const container = $('rd-notation');
  while (firstVisible < r) {
    const old = rows[firstVisible];
    // Forget notes of rows that scrolled away.
    for (let b = old.start; b < old.start + old.count; b++) {
      for (const k of noteMap.keys()) if (k.startsWith(`${b}:`)) noteMap.delete(k);
    }
    old.el?.remove();
    old.el = null;
    firstVisible++;
    container.append(drawRow(firstVisible + VISIBLE_ROWS - 1));
  }
  markCurrent(r);
}

function showCountIn(n) {
  const el = $('rd-countin');
  el.hidden = n == null;
  if (n != null) el.textContent = n;
}

function makeSource(alongMode) {
  const silent = alongMode && !state.prefs.hearRhythm;
  let countDone = false;
  let i = 0;
  return {
    get bpm() {
      return state.gen.bpm;
    },
    nextBar() {
      const g = state.gen;
      const b0 = bar(0);
      if (!countDone) {
        countDone = true;
        return countInBar(g, b0.num, b0.den);
      }
      const idx = i++;
      // Make sure the row holding this bar (and the ones after it) exist.
      while (rowOfBar(idx) < 0) row(rows.length);
      const b = bar(idx);
      const out = { beats: b.num, bpm: g.bpm, events: rhythmBarEvents(b, g, { silent }), info: { barIndex: idx } };
      if (along) {
        const a = along;
        out.onSchedule = (ev, t) => {
          if (ev.note) a.add({ time: t, key: ev.key, groupData: b.groups[ev.group], ref: `${idx}:${ev.group}:${ev.slot}` });
        };
      }
      return out;
    },
  };
}

function onResult(type, e) {
  if (type === 'extra') return;
  const n = noteMap.get(e.ref);
  if (!n) return;
  setNoteClass(n, 'playing', false);
  if (type === 'miss') setNoteClass(n, 'miss');
  else setNoteClass(n, e.grade === 'perfect' || e.grade === 'good' ? 'hit' : 'off');
}

function start(alongMode) {
  // A page that was already read is replaced with fresh bars.
  if (firstVisible > 0 || !rows.length) reset();
  claim('reading', () => stopUi());
  playing = true;
  if (alongMode) {
    along = new PlayAlong({ mode: 'reading', liveEl: $('rd-live'), onResult, onStopRequest: () => stop() });
    along.start(sessionMeta(state.gen));
    window.scrollTo({ top: 0 });
  }
  scheduler.start(makeSource(alongMode), {
    onEvent: (ev, info) => {
      if (ev.countIn != null) {
        showCountIn(ev.countIn);
        return;
      }
      if (!ev.note || !info) return;
      const n = noteMap.get(`${info.barIndex}:${ev.group}:${ev.slot}`);
      if (lastPlaying && lastPlaying !== n) setNoteClass(lastPlaying, 'playing', false);
      if (n) setNoteClass(n, 'playing');
      lastPlaying = n;
    },
    onBar: (info) => {
      if (info?.countIn) return;
      showCountIn(null);
      advanceTo(info.barIndex);
    },
  });
  $('rd-play').textContent = '■';
  $('rd-play').classList.add('playing');
  $('rd-along').textContent = alongMode ? 'Stop' : 'Play along';
}

function stopUi() {
  playing = false;
  showCountIn(null);
  if (lastPlaying) setNoteClass(lastPlaying, 'playing', false);
  lastPlaying = null;
  $('rd-play').textContent = '▶';
  $('rd-play').classList.remove('playing');
  $('rd-along').textContent = 'Play along';
  const a = along;
  along = null;
  a?.end(true);
}

export function stop() {
  if (isOwner('reading')) scheduler.stop();
  release('reading');
  if (playing) stopUi();
}

export function onShow() {
  if (!playing && (!rows.length || Math.floor($('rd-notation').clientWidth) !== width)) reset();
}

export function init() {
  $('rd-new').addEventListener('click', () => {
    if (playing) stop();
    reset();
  });
  $('rd-play').addEventListener('click', () => (playing ? stop() : start(false)));
  $('rd-along').addEventListener('click', () => (playing ? stop() : start(true)));
  on('gen', (path) => {
    const key = path.split('.')[1];
    if (key === 'bpm' && playing && isOwner('reading')) scheduler.setBpm(state.gen.bpm);
    else if (!playing && rows.length && !['bpm', 'click', 'clickSound', 'sound', 'swing', 'passes', 'loop', 'countIn'].includes(key)) {
      if (!$('tab-reading').hidden) reset();
      else rows = [];
    }
  });
}
