import { audio } from './audio.js';
import { state, set, on, save, refresh } from './store.js';
import { scheduler, claim, release, isOwner } from './transport.js';
import { toast, fmtTime, escapeHtml, openSheet } from './ui.js';

const m = () => state.metronome;
const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

const PAD_GAIN = { 3: 1, 2: 0.75, 1: 0.4, 0: 0 };
const PAD_VARIANT = { 3: 'accent', 2: 'normal', 1: 'sub' };
const MAX_BEATS = 12;
const MAX_CLICKS = 6;

let playing = false;
let startPerf = 0; // start of the current play session (performance.now)
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

// ---- Beat bars (one per click: tall = accent, medium = normal, outline = soft, flat = silent) ----
function renderPads() {
  ensurePads();
  const { pads } = m();
  const wrap = $('m-pads');
  wrap.innerHTML = '';
  wrap.classList.toggle('many', pads.length > 12);
  padEls = pads.map((s, i) => {
    const bar = document.createElement('button');
    bar.className = 'beat-bar pad';
    bar.dataset.s = s;
    bar.textContent = s === 3 ? '>' : '';
    bar.setAttribute('aria-label', `Click ${i + 1}: ${['silent', 'soft', 'normal', 'accent'][s]}`);
    bar.addEventListener('click', () => {
      const next = { 3: 2, 2: 1, 1: 0, 0: 3 }[m().pads[i]];
      m().pads[i] = next;
      bar.dataset.s = next;
      bar.textContent = next === 3 ? '>' : '';
      bar.setAttribute('aria-label', `Click ${i + 1}: ${['silent', 'soft', 'normal', 'accent'][next]}`);
      save();
    });
    wrap.append(bar);
    return bar;
  });
}

function resetBeats() {
  ensurePads(true);
  renderPads();
  toast('Beats reset');
}

// ---- Dial: number of beats (right arc), clicks per beat (left arc), drag the disk for tempo ----
const C = 180;
const pt = (deg, r) => {
  const a = (deg * Math.PI) / 180;
  return [C + r * Math.sin(a), C - r * Math.cos(a)];
};
const arcPath = (from, to, r) => {
  const [x1, y1] = pt(from, r);
  const [x2, y2] = pt(to, r);
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}`;
};
const beatAngle = (i) => 42 + i * (116 / (MAX_BEATS - 1));
const clickAngle = (i) => 266 - i * 16;

function el(tag, attrs, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.append(e);
  return e;
}

function renderDial() {
  const svg = $('m-dial');
  svg.innerHTML = '';
  el('circle', { cx: C, cy: C, r: 161, class: 'ring', 'stroke-width': 36 }, svg);
  const defs = el('defs', {}, svg);
  el('path', { id: 'arc-beats', d: arcPath(-32, 34, 156) }, defs);
  el('path', { id: 'arc-clicks', d: arcPath(270, 330, 156) }, defs);
  for (const [id, label] of [['arc-beats', '« Number of Beats'], ['arc-clicks', 'Clicks per Beat »']]) {
    const t = el('text', { class: 'lbl' }, svg);
    const tp = el('textPath', { href: `#${id}`, startOffset: '50%', 'text-anchor': 'middle' }, t);
    tp.textContent = label;
  }
  el('circle', { cx: C, cy: C, r: 138, class: 'disk', id: 'm-disk' }, svg);
  const dots = (count, value, angle, kind) => {
    for (let i = 0; i < count; i++) {
      const [x, y] = pt(angle(i), 161);
      const n = i + 1;
      const sel = n === value;
      el('circle', { cx: x, cy: y, r: sel ? 12 : 7, class: `dot${n <= value ? ' on' : ''}` }, svg);
      if (sel) {
        const t = el('text', { x, y: y + 5, 'text-anchor': 'middle', class: 'dot-num' }, svg);
        t.textContent = n;
      }
      const hit = el('circle', { cx: x, cy: y, r: 15, class: 'hit', 'data-kind': kind, 'data-value': n, role: 'button', 'aria-label': `${n} ${kind === 'num' ? 'beats' : 'clicks per beat'}` }, svg);
      hit.setAttribute('tabindex', '0');
    }
  };
  dots(MAX_BEATS, m().num, beatAngle, 'num');
  dots(MAX_CLICKS, m().sub, clickAngle, 'sub');
}

function dialPointer() {
  const svg = $('m-dial');
  let drag = null;
  const toSvg = (e) => {
    const r = svg.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 360, ((e.clientY - r.top) / r.height) * 360];
  };
  const angleOf = ([x, y]) => (Math.atan2(x - C, C - y) * 180) / Math.PI;
  svg.addEventListener('click', (e) => {
    const hit = e.target.closest('.hit');
    if (!hit) return;
    set(`metronome.${hit.dataset.kind}`, Number(hit.dataset.value));
  });
  svg.addEventListener('keydown', (e) => {
    const hit = e.target.closest('.hit');
    if (hit && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      set(`metronome.${hit.dataset.kind}`, Number(hit.dataset.value));
    }
  });
  // Turning the white disk like a knob changes the tempo: 1 BPM per 5 degrees.
  svg.addEventListener('pointerdown', (e) => {
    const p = toSvg(e);
    const r = Math.hypot(p[0] - C, p[1] - C);
    if (e.target.closest('.hit') || r > 140 || r < 62) return;
    drag = { last: angleOf(p), acc: 0 };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const a = angleOf(toSvg(e));
    let d = a - drag.last;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    drag.last = a;
    drag.acc += d;
    const steps = Math.trunc(drag.acc / 5);
    if (steps) {
      drag.acc -= steps * 5;
      set('metronome.bpm', Math.min(300, Math.max(20, m().bpm + steps)));
    }
  });
  const end = () => { drag = null; };
  svg.addEventListener('pointerup', end);
  svg.addEventListener('pointercancel', end);
}

// ---- Tempo logic ----
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
    const vol = (cfg.volume ?? 80) / 100;
    const events = cfg.pads.map((s, idx) => ({
      beat: Math.floor(idx / cfg.sub) + (idx % cfg.sub) / cfg.sub,
      sound: s && !muted && vol > 0 ? cfg.sound : null,
      variant: PAD_VARIANT[s],
      gain: PAD_GAIN[s] * vol,
      idx,
    }));
    return { beats: cfg.num, bpm, events, info: { i, bpm, muted } };
  },
};

function lightPad(idx) {
  padEls.forEach((p, i) => p.classList.toggle('lit', i === idx));
}

// ---- Practice timer: accumulates across sessions until you hold it to reset ----
const sessionSec = () => (playing ? (performance.now() - startPerf) / 1000 : 0);

function updateTimers() {
  const total = (m().elapsed || 0) + sessionSec();
  $('m-elapsed').textContent = fmtTime(total).padStart(5, '0');
  const cd = m().countdown * 60;
  const cdEl = $('m-countdown');
  if (!cd) {
    cdEl.hidden = true;
    $('m-timer-hint').hidden = false;
    $('m-countdown').textContent = '';
    return;
  }
  const left = Math.max(0, cd - sessionSec());
  cdEl.hidden = false;
  $('m-timer-hint').hidden = true;
  cdEl.textContent = `Stops in ${fmtTime(Math.ceil(left))}`;
  if (playing && left <= 0) {
    stop();
    $('m-countdown').textContent = 'Stops in 0:00';
    // Three short beeps to say time's up.
    const t = audio.ensure().currentTime + 0.05;
    [0, 0.18, 0.36].forEach((d) => audio.play('beep', 'accent', t + d, 0.9));
    toast("Time's up");
  }
}

function resetTimer() {
  m().elapsed = 0;
  if (playing) startPerf = performance.now();
  save();
  updateTimers();
  const t = $('m-timer');
  t.classList.remove('resetting');
  void t.offsetWidth;
  t.classList.add('resetting');
}

function timerPress() {
  const t = $('m-timer');
  let hold = null;
  let held = false;
  t.addEventListener('pointerdown', () => {
    held = false;
    hold = setTimeout(() => {
      held = true;
      resetTimer();
    }, 650);
  });
  const cancel = () => clearTimeout(hold);
  t.addEventListener('pointerup', cancel);
  t.addEventListener('pointerleave', cancel);
  t.addEventListener('pointercancel', cancel);
  t.addEventListener('click', () => {
    if (!held) openSheet('m-sheet', 'data-msheet-pane', 'timer');
    held = false;
  });
}

// ---- Transport ----
function setPlayButton(on) {
  $('m-play').dataset.playing = on;
  $('m-play').setAttribute('aria-label', on ? 'Stop metronome' : 'Start metronome');
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
  setPlayButton(true);
  clearInterval(timerId);
  timerId = setInterval(updateTimers, 250);
  updateTimers();
}

function stopUi() {
  if (playing) m().elapsed = (m().elapsed || 0) + sessionSec();
  playing = false;
  save();
  clearInterval(timerId);
  lightPad(-1);
  setPlayButton(false);
  $('m-live-bpm').textContent = '';
  updateTimers();
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
    .map((it, i) => `<li><span class="grow"><b>${escapeHtml(it.name)}</b><br><span class="hint">${it.data.bpm} BPM · ${it.data.num} beats · ${it.data.sub} per beat</span></span>
      <button class="pill" data-load="${i}">Load</button><button class="x" data-del="${i}" aria-label="Delete">✕</button></li>`)
    .join('');
}

function saveToSetlist() {
  const name = $('m-set-name').value.trim() || `Setup ${state.setlist.length + 1}`;
  const { elapsed, ...data } = JSON.parse(JSON.stringify(m()));
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
  const { elapsed, ...data } = JSON.parse(JSON.stringify(it.data));
  Object.assign(state.metronome, data);
  save();
  refresh();
  renderPads();
  renderDial();
  updateButtons();
  toast(`Loaded "${it.name}"`);
  if (wasPlaying) start();
}

function updateButtons() {
  $('m-target-field').hidden = m().step.mode === 'alt';
  $('m-gap-btn').classList.toggle('on', !!m().gap.on);
  $('m-step-btn').classList.toggle('on', !!m().step.on);
  $('m-markone').classList.toggle('on', !!m().markOne);
  $('m-markone').setAttribute('aria-pressed', !!m().markOne);
}

export function init() {
  ensurePads();
  renderPads();
  renderDial();
  dialPointer();
  timerPress();
  renderSetlist();
  updateButtons();
  updateTimers();
  setPlayButton(false);
  $('m-play').addEventListener('click', () => (playing ? stop() : start()));
  $('m-tap').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    tapTempo(e);
  });
  $('m-reset-beats').addEventListener('click', resetBeats);
  $('m-markone').addEventListener('click', () => set('metronome.markOne', !m().markOne));
  document.querySelectorAll('[data-msheet]').forEach((b) => b.addEventListener('click', () => openSheet('m-sheet', 'data-msheet-pane', b.dataset.msheet)));
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
  $('m-timer-reset').addEventListener('click', resetTimer);

  on('metronome.bpm', (_, v) => {
    if (playing && !m().step.on) scheduler.setBpm(v);
  });
  on('metronome.num', () => { renderPads(); renderDial(); });
  on('metronome.sub', () => { ensurePads(true); renderPads(); renderDial(); });
  on('metronome.markOne', (_, v) => {
    m().pads[0] = v ? 3 : 2;
    save();
    renderPads();
    updateButtons();
  });
  on('metronome.gap', updateButtons);
  on('metronome.step', updateButtons);
  on('metronome.countdown', updateTimers);
}

export function onDataReplaced() {
  renderPads();
  renderDial();
  renderSetlist();
  updateButtons();
  updateTimers();
}
