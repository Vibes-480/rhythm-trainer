// Play-along session: tap pad input, live stats and the end-of-session summary.
import { audio } from './audio.js';
import { Scorer } from './scoring.js';
import { state, save } from './store.js';
import { renderGroup } from './notation.js';
import { openModal, escapeHtml } from './ui.js';

const pad = () => document.getElementById('tap-pad');

let active = null;

export class PlayAlong {
  constructor({ mode, liveEl, onResult, onStopRequest, onDrill }) {
    this.mode = mode;
    this.liveEl = liveEl;
    this.onResult = onResult;
    this.onStopRequest = onStopRequest;
    this.onDrill = onDrill;
    this.scorer = new Scorer(state.prefs.strictness);
    this.scorer.onChange((type, e) => {
      this.onResult?.(type, e);
      this.updateLive();
    });
    this.handleTap = this.handleTap.bind(this);
    this.handleKey = this.handleKey.bind(this);
    this.handleStop = (e) => {
      e.stopPropagation();
      this.onStopRequest?.();
    };
  }

  start(meta) {
    active?.end(false);
    active = this;
    this.meta = meta;
    this.updateLive();
    const p = pad();
    p.hidden = false;
    document.body.classList.add('along');
    p.addEventListener('pointerdown', this.handleTap);
    document.getElementById('tap-stop').addEventListener('pointerdown', this.handleStop);
    window.addEventListener('keydown', this.handleKey);
    this.advanceId = setInterval(() => this.scorer.advance(audio.heardTime()), 40);
  }

  add(ev) {
    // Taps during the count-in shouldn't count as extra taps.
    if (this.ignoreBefore === undefined) this.ignoreBefore = ev.time - 0.25;
    this.scorer.add([ev]);
  }

  handleTap(e) {
    if (e.target.closest('#tap-stop')) return;
    e.preventDefault();
    this.registerTap(e.timeStamp);
  }

  handleKey(e) {
    if (e.repeat || e.key === 'Escape' || e.key === 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
    e.preventDefault();
    this.registerTap(e.timeStamp);
  }

  registerTap(timeStamp) {
    const t = audio.eventToAudioTime(timeStamp);
    if (this.ignoreBefore === undefined || t < this.ignoreBefore) return;
    const r = this.scorer.tap(t);
    const p = pad();
    p.classList.remove('flash', 'hit', 'extra');
    void p.offsetWidth; // restart the flash
    p.classList.add('flash', r.type === 'hit' ? 'hit' : 'extra');
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => p.classList.remove('flash', 'hit', 'extra'), 90);
  }

  updateLive() {
    const s = this.scorer;
    const set = (k, v) => {
      const el = this.liveEl.querySelector(`[data-live="${k}"]`);
      if (el) el.textContent = v;
    };
    set('accuracy', `${s.hits + s.misses + s.extras ? s.accuracy : 100}%`);
    set('streak', s.streak);
    set('misses', s.misses);
  }

  // Ends the session. Returns the summary (null if nothing was played).
  end(showSummary = true) {
    if (active !== this) return null;
    active = null;
    clearInterval(this.advanceId);
    const p = pad();
    p.hidden = true;
    document.body.classList.remove('along');
    p.removeEventListener('pointerdown', this.handleTap);
    document.getElementById('tap-stop').removeEventListener('pointerdown', this.handleStop);
    window.removeEventListener('keydown', this.handleKey);
    this.scorer.finish(audio.heardTime());
    const sum = this.scorer.summary();
    if (sum.notes === 0) return null;
    state.history.unshift({
      date: Date.now(), mode: this.mode, accuracy: sum.accuracy, bestStreak: sum.bestStreak,
      notes: sum.notes, ...this.meta,
    });
    state.history.length = Math.min(state.history.length, 100);
    save();
    if (showSummary) showSummaryModal(sum, this.meta, this.onDrill);
    return sum;
  }
}

function timingText(ms) {
  if (Math.abs(ms) < 5) return 'right on time';
  return `${Math.abs(ms)} ms ${ms < 0 ? 'early' : 'late'}`;
}

export function showSummaryModal(sum, meta, onDrill) {
  const missed = sum.mostMissed;
  const html = `
    <div class="sheet-head"><button class="sheet-close" data-close>CLOSE</button></div>
    <div class="modal-pad">
      <div class="recent">MOST RECENT</div>
      <div class="stat3">
        <div><b>${sum.accuracy}%</b><span>Accuracy</span></div>
        <div><b>${sum.bestStreak}</b><span>Longest<br>Streak</span></div>
        <div><b>${sum.misses}</b><span>Misses</span></div>
      </div>
      <div class="stat-line">
        <span>${sum.hits}/${sum.notes} notes hit</span>
        <span>${sum.extras} extra taps</span>
        <span>${sum.perfect} perfect</span>
        ${sum.hits ? `<span>on average ${timingText(sum.avgOffsetMs)}</span>` : ''}
      </div>
      <p class="stat-line">${escapeHtml(meta.bpm)} BPM · ${escapeHtml(meta.timeSig)} · complexity ${escapeHtml(meta.complexity)}</p>
      ${missed.length ? `<div class="missed-title">Most Missed Groupings</div><div class="missed">${missed
        .map((m, i) => `<div><div class="notation" data-missed="${i}"></div>missed ${m.missed} of ${m.total}</div>`)
        .join('')}</div>` : '<p class="center">No missed notes. Nice!</p>'}
      <div class="modal-actions">
        ${missed.length && onDrill ? '<button class="pill ghostbtn" id="drill-btn">Drill these</button>' : ''}
        <button class="pill" data-close>Done</button>
      </div>
    </div>`;
  const { body, close } = openModal(html);
  missed.forEach((m, i) => {
    const el = body.querySelector(`[data-missed="${i}"]`);
    try {
      renderGroup(el, m.group, meta.den, m.group.lengthBeats > 1 ? 160 : 110);
    } catch {
      el.textContent = m.key;
    }
  });
  body.querySelector('#drill-btn')?.addEventListener('click', () => {
    close();
    onDrill(missed.map((m) => m.group));
  });
}
