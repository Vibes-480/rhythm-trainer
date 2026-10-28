// VexFlow rendering of generated rhythms on a single-line percussion staff.
import { groupSegments } from './rhythm.js';

const VF = () => window.Vex.Flow;
const NOTE_KEY = 'f/5'; // sits on the single staff line (see Stave.getYForNote)
const BEAMABLE = new Set(['8', '16']);
const STAVE_Y = 34; // room above for accents and tuplet numbers

// The built-in time signature assumes a 5-line staff, so draw it by hand
// centred on the single line.
function drawTimeSig(ctx, x, lineY, bar) {
  ctx.save();
  ctx.setFont('Times New Roman, serif', 20, 'bold');
  ctx.fillText(String(bar.num), x, lineY - 3);
  ctx.fillText(String(bar.den), x, lineY + 17);
  ctx.restore();
}

function buildGroupNotes(group, den, gi, barIndex, noteMap) {
  const { StaveNote, Dot, Articulation, Tuplet, Beam, Modifier } = VF();
  const { segments, tuplet } = groupSegments(group, den);
  const notes = segments.map((s) => {
    const n = new StaveNote({
      keys: [NOTE_KEY],
      duration: s.duration + 'd'.repeat(s.dots) + (s.rest ? 'r' : ''),
      stem_direction: 1,
      auto_stem: false,
    });
    if (s.dots) Dot.buildAndAttach([n], { all: true });
    if (!s.rest) {
      if (s.accent) n.addModifier(new Articulation('a>').setPosition(Modifier.Position.ABOVE), 0);
      if (s.ghost) {
        n.addClass('ghost');
        if (VF().Parenthesis) VF().Parenthesis.buildAndAttach([n]);
      }
      noteMap?.set(`${barIndex}:${gi}:${s.slot}`, n);
    }
    n._seg = s;
    return n;
  });
  const tuplets = [];
  if (tuplet) tuplets.push(new Tuplet(notes, { num_notes: 3, notes_occupied: 2, ratioed: false, bracketed: true }));
  // Beam each contiguous run of beamable, non-rest notes.
  const beams = [];
  let run = [];
  const flush = () => {
    if (run.length >= 2) beams.push(new Beam(run));
    run = [];
  };
  notes.forEach((n, i) => {
    const s = segments[i];
    if (!s.rest && BEAMABLE.has(s.duration)) run.push(n);
    else flush();
  });
  flush();
  return { notes, beams, tuplets };
}

// Rough width a bar needs so dense 16ths don't collide.
export function barMinWidth(bar) {
  let count = 0;
  for (const g of bar.groups) count += groupSegments(g, bar.den).segments.length;
  return 34 + count * 21;
}

// Render one row of bars into `el` (cleared first).
// Returns a Map of "bar:group:slot" -> StaveNote for highlighting.
export function renderRow(el, bars, { width, firstBarIndex = 0, showTimeSig = false, height = 112 } = {}) {
  const { Renderer, Stave, Voice, Formatter } = VF();
  el.innerHTML = '';
  const tsWidth = showTimeSig ? 30 : 0;
  // Draw at least as wide as the notes need, then scale the SVG down to fit,
  // so very dense bars (e.g. 12/8 in 16ths on a phone) never collide.
  const mins = bars.map(barMinWidth);
  const natural = Math.max(width, mins.reduce((a, b) => a + b, 0) + tsWidth + 2);
  const renderer = new Renderer(el, Renderer.Backends.SVG);
  renderer.resize(natural, height);
  const ctx = renderer.getContext();
  const noteMap = new Map();
  const total = mins.reduce((a, b) => a + b, 0);
  let x = 1;
  bars.forEach((bar, i) => {
    // Share the space in proportion to how much each bar needs.
    const w = ((natural - 2 - tsWidth) * mins[i]) / total + (i === 0 ? tsWidth : 0);
    const stave = new Stave(x, STAVE_Y, w, { num_lines: 1, spacing_between_lines_px: 10, space_above_staff_ln: 4 });
    if (i === 0 && showTimeSig) stave.setNoteStartX(x + tsWidth + 8);
    stave.setContext(ctx).draw();
    if (i === 0 && showTimeSig) drawTimeSig(ctx, x + 6, stave.getYForLine(0), bar);
    const all = [];
    const beams = [];
    const tuplets = [];
    bar.groups.forEach((g, gi) => {
      const r = buildGroupNotes(g, bar.den, gi, firstBarIndex + i, noteMap);
      all.push(...r.notes);
      beams.push(...r.beams);
      tuplets.push(...r.tuplets);
    });
    const voice = new Voice({ num_beats: bar.num, beat_value: bar.den });
    voice.addTickables(all);
    new Formatter().joinVoices([voice]).formatToStave([voice], stave);
    voice.draw(ctx, stave);
    beams.forEach((b) => b.setContext(ctx).draw());
    tuplets.forEach((t) => t.setContext(ctx).draw());
    x += w;
  });
  const svg = el.querySelector('svg');
  svg.setAttribute('viewBox', `0 0 ${natural} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');
  svg.style.width = '100%';
  svg.style.height = 'auto';
  svg.style.maxWidth = `${width}px`;
  return noteMap;
}

// Render a single beat group on its own (for "most missed" summaries).
export function renderGroup(el, group, den, width = 120) {
  const { Renderer, Stave, Voice, Formatter } = VF();
  el.innerHTML = '';
  const renderer = new Renderer(el, Renderer.Backends.SVG);
  renderer.resize(width, 80);
  const ctx = renderer.getContext();
  const stave = new Stave(0, STAVE_Y - 10, width, { num_lines: 1, spacing_between_lines_px: 10, space_above_staff_ln: 4, left_bar: false, right_bar: false });
  stave.setContext(ctx).draw();
  const g = { ...group, startBeat: 0 };
  const r = buildGroupNotes(g, den, 0, 0, null);
  const voice = new Voice({ num_beats: g.lengthBeats, beat_value: den });
  voice.addTickables(r.notes);
  new Formatter().joinVoices([voice]).formatToStave([voice], stave);
  voice.draw(ctx, stave);
  r.beams.forEach((b) => b.setContext(ctx).draw());
  r.tuplets.forEach((t) => t.setContext(ctx).draw());
}

export function noteEl(note) {
  try {
    return note.getSVGElement();
  } catch {
    return null;
  }
}

export function setNoteClass(note, cls, on = true) {
  const e = noteEl(note);
  if (e) e.classList.toggle(cls, on);
}
