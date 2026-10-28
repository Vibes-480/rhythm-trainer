// Reading Mode: rows of new bars keep scrolling in until you stop.
import { generateBar } from './rhythm.js';
import { renderRow, barMinWidth, setNoteClass } from './notation.js';
import { state } from './store.js';
import { scheduler, claim, release, isOwner } from './transport.js';
import { rhythmBarEvents, countInBar } from './playback.js';
import { escapeHtml } from './ui.js';

const $ = (id) => document.getElementById(id);
const VISIBLE_ROWS = 4;

let bars = [];
let rows = []; // { start, count, el }
let firstVisible = 0;
let noteMap = new Map();
let playing = false;
let lastPlaying = null;
let width = 360;
let hooks = {};

function bar(i) {
  while (bars.length <= i) bars.push(generateBar(state.gen));
  return bars[i];
}

// One bar per row on phones (like a printed reading sheet); more on wide screens.
function maxPerRow() {
  return width >= 600 ? 2 : 1;
}

function row(r) {
  while (rows.length <= r) {
    const prev = rows[rows.length - 1];
    const start = prev ? prev.start + prev.count : 0;
    let count = 0;
    let used = start === 0 ? 30 : 0;
    while (count < maxPerRow()) {
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

export function reset() {
  const container = $('rd-notation');
  width = Math.floor(container.clientWidth || 360) - 18; // minus the row's thick edges
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
  const el = $('r-countin');
  el.hidden = n == null;
  if (n != null) el.textContent = n;
}

function makeSource(along) {
  const silent = along && !state.prefs.hearRhythm;
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
      while (rowOfBar(idx) < 0) row(rows.length);
      const b = bar(idx);
      const out = { beats: b.num, bpm: g.bpm, events: rhythmBarEvents(b, g, { silent }), info: { barIndex: idx } };
      if (along) {
        out.onSchedule = (ev, t) => {
          if (ev.note) along.add({ time: t, key: ev.key, groupData: b.groups[ev.group], ref: `${idx}:${ev.group}:${ev.slot}` });
        };
      }
      return out;
    },
  };
}

export function onResult(type, e) {
  if (type === 'extra') return;
  const n = noteMap.get(e.ref);
  if (!n) return;
  setNoteClass(n, 'playing', false);
  if (type === 'miss') setNoteClass(n, 'miss');
  else setNoteClass(n, e.grade === 'perfect' || e.grade === 'good' ? 'hit' : 'off');
}

export function isPlaying() {
  return playing;
}

// along: a PlayAlong session or null. h.onStopped is called however playback ends.
export function start(along, h = {}) {
  hooks = h;
  if (firstVisible > 0 || !rows.length) reset();
  claim('reading', () => stopUi());
  playing = true;
  scheduler.start(makeSource(along), {
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
      hooks.onBar?.(info);
    },
  });
}

function stopUi() {
  if (!playing) return;
  playing = false;
  showCountIn(null);
  if (lastPlaying) setNoteClass(lastPlaying, 'playing', false);
  lastPlaying = null;
  const h = hooks;
  hooks = {};
  h.onStopped?.();
}

export function stop() {
  if (isOwner('reading')) scheduler.stop();
  release('reading');
  stopUi();
}

export function needsRedraw() {
  return !rows.length || Math.floor($('rd-notation').clientWidth) - 18 !== width;
}

export function invalidate() {
  rows = [];
}
