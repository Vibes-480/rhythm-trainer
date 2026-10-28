// Audio engine: synthesized sounds, sample-accurate lookahead scheduler,
// and a mapping from tap timestamps to the audio clock.

export const SOUNDS = {
  click: 'Click',
  woodblock: 'Woodblock',
  beep: 'Beep',
  rim: 'Rim click',
  cowbell: 'Cowbell',
  snare: 'Snare',
  hihat: 'Hi-hat',
  kick: 'Kick',
};

// Pitch factor per variant for pitched sounds.
const VARIANT_PITCH = { accent: 1.3, normal: 1, sub: 0.8, ghost: 1 };

function noiseGen(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s / 2147483647) * 2 - 1;
  };
}

function synth(name, variant, sr) {
  const p = VARIANT_PITCH[variant] || 1;
  const TWO_PI = Math.PI * 2;
  const noise = noiseGen(12345);
  let len = 0.08;
  let fn;
  switch (name) {
    case 'click': {
      const f = 1500 * p;
      len = 0.04;
      fn = (t) => Math.sin(TWO_PI * f * t) * Math.exp(-t / 0.008);
      break;
    }
    case 'beep': {
      const f = 880 * p;
      len = 0.09;
      fn = (t) => Math.sin(TWO_PI * f * t) * Math.min(1, t / 0.002) * Math.exp(-t / 0.03) * 0.8;
      break;
    }
    case 'woodblock': {
      const f = 820 * p;
      len = 0.07;
      fn = (t) => (Math.sin(TWO_PI * f * t) + 0.35 * Math.sin(TWO_PI * f * 2.6 * t)) * Math.exp(-t / 0.018) * 0.75;
      break;
    }
    case 'rim': {
      const f = 1750 * p;
      len = 0.05;
      fn = (t) => (Math.sin(TWO_PI * f * t) * 0.6 + noise() * 0.5 * Math.exp(-t / 0.004)) * Math.exp(-t / 0.012);
      break;
    }
    case 'cowbell': {
      const f1 = 545 * p;
      const f2 = 815 * p;
      len = 0.25;
      fn = (t) => {
        const sq = (f) => Math.sin(TWO_PI * f * t) + Math.sin(TWO_PI * 3 * f * t) / 3;
        return (sq(f1) + sq(f2)) * 0.3 * Math.exp(-t / 0.06);
      };
      break;
    }
    case 'snare': {
      len = 0.2;
      fn = (t) => noise() * 0.6 * Math.exp(-t / 0.05) + Math.sin(TWO_PI * 185 * t) * 0.5 * Math.exp(-t / 0.025);
      break;
    }
    case 'hihat': {
      len = 0.06;
      let prev = 0;
      fn = (t) => {
        const n = noise();
        const hp = n - prev; // crude high-pass
        prev = n;
        return hp * 0.45 * Math.exp(-t / 0.015);
      };
      break;
    }
    case 'kick': {
      len = 0.3;
      let phase = 0;
      fn = (t) => {
        const f = 50 + 90 * Math.exp(-t / 0.03);
        phase += (TWO_PI * f) / sr;
        return Math.sin(phase) * Math.exp(-t / 0.12);
      };
      break;
    }
    default:
      return synth('click', variant, sr);
  }
  const n = Math.floor(len * sr);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = fn(i / sr);
  // Short fade-out to avoid a click at the end of the buffer.
  const fade = Math.min(64, n);
  for (let i = 0; i < fade; i++) data[n - 1 - i] *= i / fade;
  return data;
}

// Worker-based ticker: keeps ticking more reliably than setInterval on the main thread.
function makeTicker(intervalMs, cb) {
  try {
    const src = `let id=null;onmessage=(e)=>{if(e.data==='start'){clearInterval(id);id=setInterval(()=>postMessage(0),${intervalMs});}else{clearInterval(id);id=null;}}`;
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    const w = new Worker(url);
    w.onmessage = cb;
    return { start: () => w.postMessage('start'), stop: () => w.postMessage('stop') };
  } catch {
    let id = null;
    return { start: () => { clearInterval(id); id = setInterval(cb, intervalMs); }, stop: () => clearInterval(id) };
  }
}

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.master = null;
    this.latencyOffset = 0; // seconds, from calibration (tap - heard)
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state !== 'running') this.ctx.resume();
    return this.ctx;
  }

  buffer(name, variant = 'normal') {
    const key = `${name}|${variant}`;
    let b = this.buffers.get(key);
    if (!b) {
      const data = synth(name, variant, this.ctx.sampleRate);
      b = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
      b.copyToChannel(data, 0);
      this.buffers.set(key, b);
    }
    return b;
  }

  play(name, variant, time, gain = 1) {
    const ctx = this.ensure();
    const src = ctx.createBufferSource();
    src.buffer = this.buffer(name, variant);
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.master);
    src.start(Math.max(time, ctx.currentTime));
    return src;
  }

  // Context time of the sound currently coming out of the speaker.
  heardTime() {
    const ctx = this.ctx;
    if (!ctx) return 0;
    if (ctx.getOutputTimestamp) {
      const ts = ctx.getOutputTimestamp();
      if (ts.contextTime > 0 && ts.performanceTime > 0) {
        return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
      }
    }
    return ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
  }

  // Convert an event timestamp (performance.now() timebase) to "heard" audio time,
  // corrected by the calibration offset.
  eventToAudioTime(perfTimeMs) {
    const nowHeard = this.heardTime();
    return nowHeard - (performance.now() - perfTimeMs) / 1000 - this.latencyOffset;
  }
}

export const audio = new AudioEngine();

// Scheduler: walks bars from a source and schedules events slightly ahead of time.
// source.nextBar(index) -> { beats, events: [{ beat, sound, variant, gain, data }], info } | null
// source.bpm -> current tempo (read at bar start; live changes via setBpm()).
export class Scheduler {
  constructor() {
    this.lookahead = 0.15;
    this.ticker = makeTicker(25, () => this.tick());
    this.running = false;
    this.visualQueue = [];
    this.sources = [];
    this.raf = null;
  }

  start(source, { onEvent, onBar, onEnd } = {}) {
    this.stop();
    const ctx = audio.ensure();
    this.source = source;
    this.onEvent = onEvent;
    this.onBar = onBar;
    this.onEnd = onEnd;
    this.running = true;
    this.barIndex = 0;
    this.bar = null;
    this.bpm = source.bpm;
    this.barStart = ctx.currentTime + 0.1;
    this.scheduledUntil = this.barStart;
    this.loadBar();
    this.ticker.start();
    this.tick();
    const loop = () => {
      this.drainVisuals();
      if (this.running || this.visualQueue.length) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  loadBar() {
    this.bar = this.source.nextBar(this.barIndex, this.barStart);
    if (!this.bar) return;
    if (this.bar.bpm) this.bpm = this.bar.bpm;
    this.eventIdx = 0;
    this.bar.events.sort((a, b) => a.beat - b.beat);
    const bar = this.bar;
    bar.startTime = this.barStart;
    bar.bpmAtStart = this.bpm;
    this.queueVisual(this.barStart, () => this.onBar?.(bar.info, bar));
  }

  get beatSec() {
    return 60 / this.bpm;
  }

  setBpm(bpm) {
    if (!this.running || !this.bar) {
      this.bpm = bpm;
      return;
    }
    // Keep the beat position continuous at the point we've scheduled up to.
    const beatPos = (this.scheduledUntil - this.barStart) / this.beatSec;
    this.bpm = bpm;
    this.barStart = this.scheduledUntil - beatPos * this.beatSec;
  }

  tick() {
    if (!this.running) return;
    const ctx = audio.ctx;
    const horizon = ctx.currentTime + this.lookahead;
    let guard = 0;
    while (this.running && this.bar && guard++ < 1000) {
      const evs = this.bar.events;
      if (this.eventIdx < evs.length) {
        const ev = evs[this.eventIdx];
        const t = this.barStart + ev.beat * this.beatSec;
        if (t > horizon) break;
        if (ev.sound) {
          const src = audio.play(ev.sound, ev.variant || 'normal', t, ev.gain ?? 1);
          this.sources.push({ src, t });
        }
        ev.time = t;
        if (this.onEvent) this.queueVisual(t, () => this.onEvent(ev, this.barInfoFor(ev)));
        ev.bar = this.bar;
        this.bar.onSchedule?.(ev, t);
        this.eventIdx++;
        this.scheduledUntil = t;
        continue;
      }
      const end = this.barStart + this.bar.beats * this.beatSec;
      if (end > horizon) {
        this.scheduledUntil = Math.max(this.scheduledUntil, horizon);
        break;
      }
      this.barStart = end;
      this.scheduledUntil = end;
      this.barIndex++;
      this.loadBar();
      if (!this.bar) {
        const endAt = end;
        this.running = false;
        this.ticker.stop();
        this.queueVisual(endAt, () => this.onEnd?.());
      }
    }
    const now = ctx.currentTime;
    this.sources = this.sources.filter((s) => s.t > now - 1);
  }

  barInfoFor(ev) {
    return ev.bar?.info;
  }

  queueVisual(time, fn) {
    this.visualQueue.push({ time, fn });
  }

  drainVisuals() {
    const now = audio.heardTime();
    const due = [];
    this.visualQueue = this.visualQueue.filter((v) => {
      if (v.time <= now) {
        due.push(v);
        return false;
      }
      return true;
    });
    due.sort((a, b) => a.time - b.time).forEach((v) => v.fn());
  }

  stop() {
    const wasRunning = this.running;
    this.running = false;
    this.ticker.stop();
    const now = audio.ctx ? audio.ctx.currentTime : 0;
    for (const { src, t } of this.sources) {
      if (t > now) {
        try { src.stop(); } catch { /* already stopped */ }
      }
    }
    this.sources = [];
    this.visualQueue = [];
    cancelAnimationFrame(this.raf);
    return wasRunning;
  }
}

// Keep the screen on while playing so Android doesn't suspend audio.
let wakeLock = null;
export async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* not supported or denied */ }
}
