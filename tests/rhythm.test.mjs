// Run with: node --test tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIME_SIGNATURES, DEFAULT_SETTINGS, generateBar, groupSegments, segmentsBeats, barEvents, makeRng, slotBeat,
} from '../js/rhythm.js';
import { Scorer } from '../js/scoring.js';

const VALID_DUR = new Set(['w', 'h', 'q', '8', '16']);

test('every generated bar fills exactly its time signature', () => {
  const rng = makeRng(42);
  let bars = 0;
  for (const timeSig of TIME_SIGNATURES) {
    for (const subdivision of ['8th', '16th']) {
      for (let complexity = 1; complexity <= 10; complexity++) {
        for (const triplets of [false, true]) {
          for (const space of [0, 50, 100]) {
            const settings = { ...DEFAULT_SETTINGS, timeSig, subdivision, complexity, triplets, space, ghostNotes: true, accents: true };
            for (let i = 0; i < 20; i++) {
              const bar = generateBar(settings, rng);
              bars++;
              let total = 0;
              for (const g of bar.groups) {
                const { segments, tuplet } = groupSegments(g, bar.den);
                const len = segmentsBeats(segments, tuplet, bar.den);
                assert.ok(Math.abs(len - g.lengthBeats) < 1e-9, `${timeSig} group ${g.key} length ${len} != ${g.lengthBeats}`);
                total += len;
                for (const s of segments) assert.ok(VALID_DUR.has(s.duration), `bad duration ${s.duration}`);
                // Every hit slot appears exactly once as a note.
                const noteSlots = segments.filter((s) => !s.rest).map((s) => s.slot);
                const hitSlots = g.slots.map((h, k) => (h ? k : -1)).filter((k) => k >= 0);
                assert.deepEqual(noteSlots, hitSlots);
              }
              assert.ok(Math.abs(total - bar.beats) < 1e-9);
              const evs = barEvents(bar, 50);
              assert.ok(evs.length > 0, 'bar must contain at least one note');
              for (const e of evs) assert.ok(e.beat >= 0 && e.beat < bar.beats);
            }
          }
        }
      }
    }
  }
  assert.ok(bars > 10000);
});

test('8th subdivision never produces 16th notes', () => {
  const rng = makeRng(7);
  for (const timeSig of TIME_SIGNATURES) {
    for (let i = 0; i < 200; i++) {
      const bar = generateBar({ ...DEFAULT_SETTINGS, timeSig, subdivision: '8th', complexity: 10 }, rng);
      for (const g of bar.groups) {
        if (g.kind === 'triplet') continue;
        for (const s of groupSegments(g, bar.den).segments) assert.notEqual(s.duration, '16');
      }
    }
  }
});

test('triplets only appear when enabled and only in x/4', () => {
  const rng = makeRng(9);
  for (let i = 0; i < 500; i++) {
    const off = generateBar({ ...DEFAULT_SETTINGS, triplets: false, complexity: 10 }, rng);
    assert.ok(off.groups.every((g) => g.kind !== 'triplet'));
    const compound = generateBar({ ...DEFAULT_SETTINGS, timeSig: '6/8', triplets: true, complexity: 10 }, rng);
    assert.ok(compound.groups.every((g) => g.kind !== 'triplet'));
  }
  let seen = 0;
  for (let i = 0; i < 200; i++) {
    const on = generateBar({ ...DEFAULT_SETTINGS, triplets: true, complexity: 6 }, rng);
    seen += on.groups.filter((g) => g.kind === 'triplet').length;
  }
  assert.ok(seen > 50);
});

test('complexity 1 only uses the simplest patterns', () => {
  const rng = makeRng(3);
  for (let i = 0; i < 500; i++) {
    const bar = generateBar({ ...DEFAULT_SETTINGS, complexity: 1, space: 0 }, rng);
    for (const g of bar.groups) assert.ok(['1000', '1010'].includes(g.slots.join('')), g.slots.join(''));
  }
});

test('space 100 produces many rests, space 0 none at complexity 1', () => {
  const rng = makeRng(5);
  let empty = 0;
  for (let i = 0; i < 300; i++) {
    const bar = generateBar({ ...DEFAULT_SETTINGS, space: 100 }, rng);
    empty += bar.groups.filter((g) => !g.slots.some(Boolean)).length;
  }
  assert.ok(empty > 300);
});

test('swing delays off-beats and leaves downbeats alone', () => {
  const g = { kind: 'straight', startBeat: 1, slotBeats: 0.5, slots: [1, 1] };
  assert.equal(slotBeat(g, 0, 66), 1);
  assert.ok(Math.abs(slotBeat(g, 1, 66) - 1.66) < 1e-9);
  assert.equal(slotBeat(g, 1, 50), 1.5);
  const t = { kind: 'triplet', startBeat: 0, slotBeats: 1 / 3, slots: [1, 1, 1] };
  assert.equal(slotBeat(t, 1, 70), 1 / 3);
});

test('known patterns render to the expected notation', () => {
  const seg = (slots, kind = 'straight', den = 4) => {
    const g = { kind, slots, slotBeats: kind === 'triplet' ? 1 / 3 : 1 / slots.length, lengthBeats: 1 };
    const { segments, tuplet } = groupSegments(g, den);
    return segments.map((s) => s.duration + (s.dots ? 'd' : '') + (s.rest ? 'r' : '')).join(' ') + (tuplet ? ' (3)' : '');
  };
  assert.equal(seg([1, 0, 0, 0]), 'q');
  assert.equal(seg([1, 0, 0, 1]), '8d 16');
  assert.equal(seg([0, 1, 1, 0]), '16r 16 8');
  assert.equal(seg([0, 0, 0, 1]), '8dr 16');
  assert.equal(seg([0, 1]), '8r 8');
  assert.equal(seg([1, 1, 1], 'triplet'), '8 8 8 (3)');
  assert.equal(seg([0, 1, 1], 'triplet'), '8r 8 8 (3)');
  assert.equal(seg([1, 0, 1], 'triplet'), 'q 8 (3)');
  assert.equal(seg([1, 0, 0], 'triplet'), 'q');
});

test('scorer matches taps, counts misses, extras and streaks', () => {
  const s = new Scorer('normal');
  s.add([0, 0.5, 1, 1.5, 2].map((time, i) => ({ time, key: i < 2 ? 'A' : 'B', id: i })));
  assert.equal(s.tap(0.01).grade, 'perfect');
  assert.equal(s.tap(0.55).grade, 'good');
  assert.equal(s.tap(0.75).type, 'extra'); // nowhere near a note
  s.advance(1.2); // note at 1.0 missed
  assert.equal(s.tap(1.58).grade, 'late');
  assert.equal(s.tap(1.95).grade, 'good');
  s.finish(3);
  const sum = s.summary();
  assert.equal(sum.hits, 4);
  assert.equal(sum.misses, 1);
  assert.equal(sum.extras, 1);
  assert.equal(sum.bestStreak, 2);
  assert.equal(sum.accuracy, Math.round((4 / 6) * 100));
  assert.equal(sum.mostMissed[0].key, 'B');
});

test('scorer window shrinks for fast notes so taps go to the closest note', () => {
  const s = new Scorer('relaxed');
  s.add([{ time: 0 }, { time: 0.08 }]);
  s.tap(0.07);
  assert.equal(s.expected[1].state, 'hit');
  assert.equal(s.expected[0].state, 'pending');
});

test('stopping early does not count future notes as misses', () => {
  const s = new Scorer();
  s.add([{ time: 0 }, { time: 1 }, { time: 2 }]);
  s.tap(0);
  s.finish(0.5);
  assert.equal(s.summary().misses, 0);
  assert.equal(s.summary().accuracy, 100);
});
