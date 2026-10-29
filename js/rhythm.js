// Rhythm generation and conversion to notation segments / timed events.
// Pure module: no DOM, so it can be unit tested in Node.

export const TIME_SIGNATURES = ['2/4', '3/4', '4/4', '5/4', '6/4', '7/4', '5/8', '6/8', '7/8', '9/8', '12/8'];

// Beam/beat groups (in denominator beats) for each meter.
const GROUPINGS = {
  '5/8': [3, 2], '6/8': [3, 3], '7/8': [2, 2, 3], '9/8': [3, 3, 3], '12/8': [3, 3, 3, 3],
};

// Pattern pools: slot string -> difficulty (1 = easiest).
const POOL_16 = {
  '1000': 1, '1010': 1, '1111': 2, '1110': 3, '1011': 3, '1100': 3, '0010': 3,
  '1001': 4, '1101': 4, '0111': 5, '0011': 6, '0101': 6, '0110': 6, '0100': 7, '0001': 7,
};
const POOL_8 = { '10': 1, '11': 1, '01': 3 };
const POOL_TRIPLET = { '100': 1, '111': 2, '101': 3, '110': 4, '011': 6, '010': 7, '001': 8 };
// One eighth-note cell inside a compound (x/8) group, at 16th resolution.
const POOL_CELL_16 = { '10': 1, '11': 2, '01': 5 };

export const DEFAULT_SETTINGS = {
  bars: 2,
  complexity: 4,
  bpm: 90,
  timeSig: '4/4',
  subdivision: '16th', // '8th' | '16th'
  triplets: false,
  ghostNotes: false,
  accents: false,
  swing: 50, // 50 = straight, 75 = hard swing
  space: 20, // 0..100, chance of rests
  countIn: true,
  loop: true,
  sound: 'snare',
  click: true,
  clickSound: 'recorded',
};

export function parseTimeSig(ts) {
  const [num, den] = ts.split('/').map(Number);
  return { num, den };
}

export function groupingFor(ts) {
  const { num, den } = parseTimeSig(ts);
  if (den === 8) return GROUPINGS[ts] || Array(num).fill(1);
  return Array(num).fill(1);
}

// Small seeded RNG so tests are reproducible.
export function makeRng(seed = Date.now()) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function weightedPick(entries, rng) {
  const total = entries.reduce((s, e) => s + e[1], 0);
  let r = rng() * total;
  for (const [value, w] of entries) {
    r -= w;
    if (r <= 0) return value;
  }
  return entries[entries.length - 1][0];
}

// Pick a pattern from a pool. Patterns harder than the complexity are excluded;
// patterns close to the complexity limit are favoured so higher levels feel harder.
export function pickPattern(pool, complexity, rng) {
  const maxPool = Math.max(...Object.values(pool));
  const limit = Math.min(complexity, maxPool);
  const entries = Object.entries(pool)
    .filter(([, d]) => d <= limit)
    .map(([p, d]) => [p, 1 + 3 * Math.exp(-((limit - d) ** 2) / 4)]);
  return weightedPick(entries, rng);
}

function toSlots(str) {
  return str.split('').map(Number);
}

function decorate(group, settings, rng) {
  const c = settings.complexity;
  group.ghost = group.slots.map(() => false);
  group.accent = group.slots.map(() => false);
  group.slots.forEach((hit, i) => {
    if (!hit) return;
    if (settings.ghostNotes && i > 0 && rng() < 0.12 + 0.02 * c) group.ghost[i] = true;
    else if (settings.accents && rng() < (i === 0 ? 0.45 : 0.12)) group.accent[i] = true;
  });
}

function groupKey(g) {
  return `${g.kind}:${g.res}:${g.slots.join('')}`;
}

function makeStraightGroup(startBeat, settings, rng) {
  const sixteenth = settings.subdivision === '16th';
  const space = settings.space / 100;
  let pattern;
  if (rng() < space * 0.6) pattern = sixteenth ? '0000' : '00';
  else pattern = pickPattern(sixteenth ? POOL_16 : POOL_8, settings.complexity, rng);
  const slots = toSlots(pattern);
  return {
    kind: 'straight', res: sixteenth ? 16 : 8, startBeat, lengthBeats: 1,
    slotBeats: 1 / slots.length, slots,
  };
}

function makeTripletGroup(startBeat, settings, rng) {
  const space = settings.space / 100;
  const pattern = rng() < space * 0.4 ? '000' : pickPattern(POOL_TRIPLET, settings.complexity, rng);
  return { kind: 'triplet', res: 3, startBeat, lengthBeats: 1, slotBeats: 1 / 3, slots: toSlots(pattern) };
}

// Compound (x/8) group: a run of eighth-note cells.
function makeCompoundGroup(startBeat, cells, settings, rng) {
  const sixteenth = settings.subdivision === '16th';
  const space = settings.space / 100;
  const c = settings.complexity;
  const slots = [];
  for (let i = 0; i < cells; i++) {
    const restChance = space * 0.5 + (i === 0 ? (c >= 4 ? 0.02 * c : 0) : 0.04 * c);
    if (rng() < Math.min(restChance, 0.8)) {
      slots.push(...(sixteenth ? [0, 0] : [0]));
    } else if (sixteenth) {
      slots.push(...toSlots(pickPattern(POOL_CELL_16, c, rng)));
    } else {
      slots.push(1);
    }
  }
  return {
    kind: 'straight', res: sixteenth ? 16 : 8, startBeat, lengthBeats: cells,
    slotBeats: sixteenth ? 0.5 : 1, slots,
  };
}

export function generateBar(settings, rng = Math.random) {
  const { num, den } = parseTimeSig(settings.timeSig);
  const groups = [];
  let beat = 0;
  const tripletChance = settings.triplets && den === 4 ? Math.min(0.2 + 0.035 * settings.complexity, 0.55) : 0;
  for (const len of groupingFor(settings.timeSig)) {
    let g;
    if (den === 8) g = makeCompoundGroup(beat, len, settings, rng);
    else if (rng() < tripletChance) g = makeTripletGroup(beat, settings, rng);
    else g = makeStraightGroup(beat, settings, rng);
    groups.push(g);
    beat += len;
  }
  // Never leave a whole bar empty: it makes reading/play-along pointless.
  if (!groups.some((g) => g.slots.some(Boolean))) groups[0].slots[0] = 1;
  groups.forEach((g) => {
    decorate(g, settings, rng);
    g.key = groupKey(g);
  });
  return { num, den, beats: num, groups };
}

export function generateRhythm(settings, rng = Math.random) {
  return Array.from({ length: settings.bars }, () => generateBar(settings, rng));
}

// ---- Notation segments ----

// Length in 16th notes -> [VexFlow duration, dots]
const DUR16 = { 16: ['w', 0], 12: ['h', 1], 8: ['h', 0], 6: ['q', 1], 4: ['q', 0], 3: ['8', 1], 2: ['8', 0], 1: ['16', 0] };
const DUR16_KEYS = [16, 12, 8, 6, 4, 3, 2, 1];

function split16(len) {
  const out = [];
  let rest = len;
  while (rest > 0) {
    const k = DUR16_KEYS.find((x) => x <= rest);
    out.push(k);
    rest -= k;
  }
  return out;
}

// Convert a group into notation segments:
// [{ duration, dots, rest, slot (index of hit or -1), ghost, accent, len16 }]
// Returns { segments, tuplet }.
export function groupSegments(group, den) {
  const { slots } = group;
  const hits = [];
  slots.forEach((s, i) => s && hits.push(i));
  const segments = [];

  if (group.kind === 'triplet') {
    if (hits.length === 0) return { segments: [{ duration: 'q', dots: 0, rest: true, slot: -1 }], tuplet: false };
    if (hits.length === 1 && hits[0] === 0) {
      return { segments: [{ duration: 'q', dots: 0, rest: false, slot: 0, ghost: group.ghost?.[0], accent: group.accent?.[0] }], tuplet: false };
    }
    const tdur = { 1: '8', 2: 'q' };
    if (hits[0] > 0) segments.push({ duration: tdur[hits[0]], dots: 0, rest: true, slot: -1 });
    hits.forEach((h, j) => {
      const end = j + 1 < hits.length ? hits[j + 1] : slots.length;
      segments.push({ duration: tdur[end - h], dots: 0, rest: false, slot: h, ghost: group.ghost?.[h], accent: group.accent?.[h] });
    });
    return { segments, tuplet: true };
  }

  // Straight: slot length in 16ths.
  const slot16 = group.slotBeats * (16 / den);
  const pushRest = (len) => split16(len).forEach((l) => segments.push({ duration: DUR16[l][0], dots: DUR16[l][1], rest: true, slot: -1, len16: l }));
  if (hits.length === 0) {
    pushRest(slots.length * slot16);
    return { segments, tuplet: false };
  }
  if (hits[0] > 0) pushRest(hits[0] * slot16);
  hits.forEach((h, j) => {
    const end = j + 1 < hits.length ? hits[j + 1] : slots.length;
    const pieces = split16((end - h) * slot16);
    const first = pieces.shift();
    segments.push({
      duration: DUR16[first][0], dots: DUR16[first][1], rest: false, slot: h, len16: first,
      ghost: group.ghost?.[h], accent: group.accent?.[h],
    });
    pieces.forEach((l) => segments.push({ duration: DUR16[l][0], dots: DUR16[l][1], rest: true, slot: -1, len16: l }));
  });
  return { segments, tuplet: false };
}

// Total length of segments in beats of the bar's denominator (used by tests).
export function segmentsBeats(segments, tuplet, den) {
  const base = { w: 16, h: 8, q: 4, 8: 2, 16: 1 };
  let total16 = 0;
  for (const s of segments) {
    let l = base[s.duration];
    if (s.dots) l *= 1.5;
    total16 += l;
  }
  if (tuplet) total16 *= 2 / 3;
  return total16 / (16 / den);
}

// ---- Timed events ----

// Beat position of a slot, applying swing to the off-beat of each straight pair.
export function slotBeat(group, slot, swing = 50) {
  const base = group.startBeat + slot * group.slotBeats;
  if (group.kind !== 'straight' || swing === 50 || slot % 2 === 0 || group.slots.length % 2 !== 0) return base;
  const pairStart = group.startBeat + (slot - 1) * group.slotBeats;
  return pairStart + 2 * group.slotBeats * (swing / 100);
}

// Hit events of a bar: [{ beat, ghost, accent, group, slot, key }]
export function barEvents(bar, swing = 50) {
  const events = [];
  bar.groups.forEach((g, gi) => {
    g.slots.forEach((hit, si) => {
      if (!hit) return;
      events.push({ beat: slotBeat(g, si, swing), ghost: !!g.ghost?.[si], accent: !!g.accent?.[si], group: gi, slot: si, key: g.key });
    });
  });
  return events;
}
