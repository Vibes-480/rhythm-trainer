// Shared helpers that turn generated bars into scheduler bars.
import { barEvents, groupingFor } from './rhythm.js';

// Clicks for one bar: every beat, accenting the bar start (and group starts in x/8).
export function clickEvents(bar, gen) {
  if (!gen.click) return [];
  const groupStarts = new Set();
  let b = 0;
  for (const len of groupingFor(gen.timeSig)) {
    groupStarts.add(b);
    b += len;
  }
  const evs = [];
  for (let i = 0; i < bar.num; i++) {
    const variant = i === 0 ? 'accent' : bar.den === 8 && !groupStarts.has(i) ? 'sub' : 'normal';
    evs.push({ beat: i, sound: gen.clickSound, variant, gain: i === 0 ? 0.9 : bar.den === 8 && !groupStarts.has(i) ? 0.45 : 0.7, click: true });
  }
  return evs;
}

export function countInBar(gen, num, den) {
  const evs = [];
  for (let i = 0; i < num; i++) {
    evs.push({ beat: i, sound: gen.clickSound, variant: i === 0 ? 'accent' : 'normal', gain: 0.9, countIn: num - i, click: true });
  }
  return { beats: num, bpm: gen.bpm, events: evs, info: { countIn: true, num, den } };
}

// Note + click events for a rhythm bar. `silent` keeps the notes for
// highlighting/scoring but doesn't play them (play-along without guide).
export function rhythmBarEvents(bar, gen, { silent = false } = {}) {
  const notes = barEvents(bar, gen.swing).map((e) => ({
    ...e,
    note: true,
    sound: silent ? null : gen.sound,
    variant: e.ghost ? 'ghost' : e.accent ? 'accent' : 'normal',
    gain: e.ghost ? 0.25 : e.accent ? 1 : 0.65,
  }));
  return [...notes, ...clickEvents(bar, gen)];
}

export function sessionMeta(gen) {
  const [num, den] = gen.timeSig.split('/').map(Number);
  return { bpm: gen.bpm, timeSig: gen.timeSig, complexity: gen.complexity, num, den };
}
