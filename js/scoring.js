// Play-along scoring. Pure module: times are in seconds on the audio clock.

export const STRICTNESS = {
  relaxed: { window: 0.15, perfect: 0.04, good: 0.08 },
  normal: { window: 0.11, perfect: 0.03, good: 0.06 },
  strict: { window: 0.075, perfect: 0.02, good: 0.04 },
};

export class Scorer {
  constructor(strictness = 'normal') {
    this.cfg = STRICTNESS[strictness] || STRICTNESS.normal;
    this.expected = []; // { time, key, id, state: 'pending'|'hit'|'miss', offset }
    this.hits = 0;
    this.misses = 0;
    this.extras = 0;
    this.perfect = 0;
    this.good = 0;
    this.streak = 0;
    this.bestStreak = 0;
    this.offsets = [];
    this.groupStats = new Map(); // key -> { total, missed, group }
    this.listeners = [];
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  emit(type, data) {
    this.listeners.forEach((fn) => fn(type, data));
  }

  // Add expected note onsets (must be added in time order).
  add(events) {
    for (const e of events) {
      this.expected.push({ ...e, state: 'pending' });
      if (e.key) {
        const s = this.groupStats.get(e.key) || { total: 0, missed: 0, group: e.groupData };
        s.total++;
        this.groupStats.set(e.key, s);
      }
    }
    this.expected.sort((a, b) => a.time - b.time);
  }

  // Matching window for a note: never more than half the gap to its neighbours,
  // so that fast passages don't steal taps from adjacent notes.
  windowFor(i) {
    const e = this.expected[i];
    let w = this.cfg.window;
    const prev = this.expected[i - 1];
    const next = this.expected[i + 1];
    if (prev) w = Math.min(w, (e.time - prev.time) / 2);
    if (next) w = Math.min(w, (next.time - e.time) / 2);
    return Math.max(w, 0.025);
  }

  tap(time) {
    let best = -1;
    let bestDist = Infinity;
    // Search only nearby candidates.
    for (let i = 0; i < this.expected.length; i++) {
      const e = this.expected[i];
      if (e.time > time + 0.5) break;
      if (e.state !== 'pending') continue;
      const d = Math.abs(time - e.time);
      if (d <= this.windowFor(i) && d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    if (best === -1) {
      this.extras++;
      this.streak = 0;
      this.emit('extra', { time });
      return { type: 'extra' };
    }
    const e = this.expected[best];
    e.state = 'hit';
    e.offset = time - e.time;
    this.hits++;
    this.offsets.push(e.offset);
    const grade = bestDist <= this.cfg.perfect ? 'perfect' : bestDist <= this.cfg.good ? 'good' : e.offset < 0 ? 'early' : 'late';
    if (grade === 'perfect') this.perfect++;
    else if (grade === 'good') this.good++;
    e.grade = grade;
    this.streak++;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    this.emit('hit', e);
    return { type: 'hit', grade, offset: e.offset, event: e };
  }

  // Mark notes whose window has fully passed as missed.
  advance(now) {
    for (let i = 0; i < this.expected.length; i++) {
      const e = this.expected[i];
      if (e.time > now) break;
      if (e.state === 'pending' && now > e.time + this.windowFor(i)) {
        e.state = 'miss';
        this.misses++;
        this.streak = 0;
        const s = this.groupStats.get(e.key);
        if (s) s.missed++;
        this.emit('miss', e);
      }
    }
  }

  // Drop expected notes that never became due (e.g. user stopped early).
  finish(now) {
    this.advance(now);
    const pending = this.expected.filter((e) => e.state === 'pending');
    for (const e of pending) {
      const s = this.groupStats.get(e.key);
      if (s) s.total--;
    }
    this.expected = this.expected.filter((e) => e.state !== 'pending');
  }

  get accuracy() {
    const denom = this.hits + this.misses + this.extras;
    return denom ? Math.round((this.hits / denom) * 100) : 0;
  }

  summary() {
    const avg = this.offsets.length ? this.offsets.reduce((a, b) => a + b, 0) / this.offsets.length : 0;
    const avgAbs = this.offsets.length ? this.offsets.reduce((a, b) => a + Math.abs(b), 0) / this.offsets.length : 0;
    const mostMissed = [...this.groupStats.entries()]
      .filter(([, s]) => s.missed > 0)
      .map(([key, s]) => ({ key, missed: s.missed, total: s.total, rate: s.missed / s.total, group: s.group }))
      .sort((a, b) => b.missed - a.missed || b.rate - a.rate)
      .slice(0, 3);
    return {
      accuracy: this.accuracy,
      notes: this.hits + this.misses,
      hits: this.hits,
      misses: this.misses,
      extras: this.extras,
      perfect: this.perfect,
      good: this.good,
      bestStreak: this.bestStreak,
      avgOffsetMs: Math.round(avg * 1000),
      avgAbsOffsetMs: Math.round(avgAbs * 1000),
      mostMissed,
    };
  }
}
