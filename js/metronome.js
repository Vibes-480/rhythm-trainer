import { audio } from './audio.js';
import { state, set, on, save, refresh } from './store.js';
import { scheduler, claim, release, isOwner } from './transport.js';
import { toast, fmtTime, escapeHtml } from './ui.js';

const m = () => state.metronome;
const $ = (id) => document.getElementById(id);

const PAD_GAIN = { 3: 1, 2: 0.75, 1: 0.4, 0: 0 };
const PAD_VARIANT = { 3: 'accent', 2: 'normal', 1: 'sub' };

let playing = false;
let startPerf = 0;
let startCtx = 0;
let timerId = null;
let padEls = [];

function defaultPad(i) {
  const { sub, markOne } = m();
  if (i === 0 && markOne) return 3;
  return i % sub === 0 ? 2 : 1;
}

// Keep the per-click states in sync with beats x clicks-per-beat.
function ensurePads(reset = false) {
  const { num, sub } = m();
  const n = num * sub;
  const old = m().pads || [];
  if (reset || old.length !== n || m().padsSub !== sub) {
    const oldSub = m().padsSub || sub;
    m().pads = Array.from({ length: n }, (_, i) => {
      // Preserve beat-level edits when only the number of beats changed.
      if (!reset && oldSub === sub && i < old.length) return old[i];
      return defaultPad(i);
    });
    m().padsSub = sub;
    save();
  }
}

function renderPads() {
  ensurePads();
  const { num, sub, pads } = m();
  const wrap = $('m-pads');
  wrap.innerHTML = '';
  wrap.classList.toggle('many', num * sub > 16);
  padEls = [];
  // Several beats per row on wide layouts with few clicks per beat.
  for (let b = 0; b < num; b++) {
    const row = document.createElement('div');
    row.className = 'pad-beat';
    for (let s = 0; s < sub; s++) {
      const i = b * sub + s;
      const pad = document.createElement('button');
      pad.className = 'pad';
      pad.dataset.s = pads[i];
      pad.setAttribute('aria-label', `Beat ${b + 1} click ${s + 1}`);
      pad.addEventListener('click', () => {
        const next = { 3: 2, 2: 1, 1: 0, 0: 3 }[m().pads[i]];
        m().pads[i] = next;
        pad.dataset.s = next;
        save();
      });
      row.append(pad);
      padEls.push(pad);
    }
    wrap.append(row);
  }
  // Short meters with single clicks read better on one line.
  if (sub === 1 && num <= 8) {
    const line = document.createElement('div');
    line.className = 'pad-beat';
    padEls.forEach((p) => line.append(p));
    wrap.innerHTML = '';
    wrap.append(line);
  }
}

// Tempo for bar `i`, applying the stepwise trainer.
export function bpmForBar(i, elapsedSec, cfg = m()) {
  const { bpm, step } = cfg;
  if (!step.on) return bpm;
  const n = step.unit === 'seconds' ? Math.floor(elapsedSec / Math.max(1, step.every)) : Math.floor(i / Math.max(1, step.every));
  let v;
  if (step.mode === 'alt') v = n % 2 ? bpm + step.amount : bpm;
  else if (step.mode === 'down') v = Math.max(Math.min(step.target, bpm), bpm - n * step.amount);
  else v = Math.min(Math.max(step.target, bpm), bpm + n * step.amount);
  return Math.min(300, Math.max(20, v));
}

export function isMuted(i, cfg = m()) {
  const { gap } = cfg;
  if (!gap.on) return false;
  const cycle = gap.play + gap.mute;
  return i % cycle >= gap.play;
}

const source = {
  get bpm() {
    return m().bpm;
  },
  nextBar(i, barStart) {
    const cfg = m();
    if (i === 0) startCtx = barStart;
    const bpm = bpmForBar(i, barStart - startCtx, cfg);
    const muted = isMuted(i, cfg);
    const events = cfg.pads.map((s, idx) => ({
      beat: Math.floor(idx / cfg.sub) + (idx % cfg.sub) / cfg.sub,
      sound: s && !muted ? cfg.sound : null,
      variant: PAD_VARIANT[s],
      gain: PAD_GAIN[s],
      idx,
    }));
    return { beats: cfg.num, bpm, events, info: { i, bpm, muted } };
  },
};

function lightPad(idx) {
  padEls.forEach((p, i) => p.classList.toggle('lit', i === idx));
}

function updateTimers() {
  const elapsed = playing ? (performance.now() - startPerf) / 1000 : 0;
  $('m-elapsed').textContent = fmtTime(elapsed);
  const cd = m().countdown * 60;
  if (!cd) {
    $('m-countdown').textContent = '–';
    return;
  }
  const left = Math.max(0, cd - elapsed);
  $('m-countdown').textContent = fmtTime(Math.ceil(left));
  if (playing && left <= 0) {
    stop();
    // Three short beeps to say time's up.
    const t = audio.ensure().currentTime + 0.05;
    [0, 0.18, 0.36].forEach((d) => audio.play('beep', 'accent', t + d, 0.9));
    toast("Time's up");
  }
}

export function start() {
  ensurePads();
  claim('metronome', () => stopUi());
  playing = true;
  startPerf = performance.now();
  scheduler.start(source, {
    onEvent: (ev) => lightPad(ev.idx),
    onBar: (info) => {
      const parts = [];
      if (m().step.on) parts.push(`Now ${info.bpm} BPM`);
      if (info.muted) parts.push('silent bar');
      $('m-live-bpm').textContent = parts.join(' · ');
    },
  });
  $('m-play').textContent = '■';
  $('m-play').classList.add('playing');
  $('m-play').setAttribute('aria-label', 'Stop metronome');
  clearInterval(timerId);
  timerId = setInterval(updateTimers, 250);
  updateTimers();
}

function stopUi() {
  playing = false;
  clearInterval(timerId);
  lightPad(-1);
  $('m-play').textContent = '▶';
  $('m-play').classList.remove('playing');
  $('m-play').setAttribute('aria-label', 'Start metronome');
  $('m-live-bpm').textContent = '';
}

export function stop() {
  if (isOwner('metronome')) scheduler.stop();
  release('metronome');
  stopUi();
}

// ---- Tap tempo ----
let taps = [];
function tapTempo(e) {
  const t = e.timeStamp || performance.now();
  if (taps.length && t - taps[taps.length - 1] > 2000) taps = [];
  taps.push(t);
  if (taps.length > 7) taps.shift();
  if (taps.length >= 2) {
    const gaps = taps.slice(1).map((x, i) => x - taps[i]);
    const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    set('metronome.bpm', Math.min(300, Math.max(20, Math.round(60000 / avg))));
  }
}

// ---- Setlist ----
function renderSetlist() {
  const ul = $('m-setlist');
  const items = state.setlist;
  if (!items.length) {
    ul.innerHTML = '<li class="empty">Nothing saved yet.</li>';
    return;
  }
  ul.innerHTML = items
    .map((it, i) => `<li><span class="grow"><b>${escapeHtml(it.name)}</b><br><span class="muted small">${it.data.bpm} BPM · ${it.data.num}/${it.data.den}</span></span>
      <button class="btn" data-load="${i}">Load</button><button class="btn ghost" data-del="${i}" aria-label="Delete">✕</button></li>`)
    .join('');
}

function saveToSetlist() {
  const name = $('m-set-name').value.trim() || `Setup ${state.setlist.length + 1}`;
  const data = JSON.parse(JSON.stringify(m()));
  state.setlist.push({ name, data });
  $('m-set-name').value = '';
  save();
  renderSetlist();
  toast(`Saved "${name}"`);
}

function loadFromSetlist(i) {
  const it = state.setlist[i];
  if (!it) return;
  const wasPlaying = playing;
  if (wasPlaying) stop();
  Object.assign(state.metronome, JSON.parse(JSON.stringify(it.data)));
  save();
  refresh();
  renderPads();
  updateTarget();
  toast(`Loaded "${it.name}"`);
  if (wasPlaying) start();
}

function updateTarget() {
  $('m-target-field').hidden = m().step.mode === 'alt';
}

export function init() {
  ensurePads();
  renderPads();
  renderSetlist();
  updateTarget();
  updateTimers();
  $('m-play').addEventListener('click', () => (playing ? stop() : start()));
  $('m-tap').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    tapTempo(e);
  });
  $('m-set-save').addEventListener('click', saveToSetlist);
  $('m-setlist').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.load) loadFromSetlist(Number(b.dataset.load));
    if (b.dataset.del) {
      state.setlist.splice(Number(b.dataset.del), 1);
      save();
      renderSetlist();
    }
  });

  on('metronome.bpm', (_, v) => {
    if (playing && !m().step.on) scheduler.setBpm(v);
  });
  on('metronome.num', () => { renderPads(); });
  on('metronome.sub', () => { ensurePads(true); renderPads(); });
  on('metronome.markOne', (_, v) => {
    m().pads[0] = v ? 3 : 2;
    save();
    renderPads();
  });
  on('metronome.step.mode', updateTarget);
  on('metronome.countdown', updateTimers);
}

export function onDataReplaced() {
  renderPads();
  renderSetlist();
  updateTarget();
}
