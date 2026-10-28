// End-to-end checks in a phone-sized headless Chromium.
// Run: NODE_PATH=$(npm root -g) node tests/e2e.cjs
const { chromium } = require('playwright');
const assert = require('assert/strict');
const serve = require('./server.cjs');

const results = [];
let browser;
let base;
let serverRef;

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && page.errors.push(m.text()));
  await page.goto(base);
  await page.waitForFunction(() => document.querySelector('#r-timesig option'));
  // Record every sound the engine plays.
  await page.evaluate(async () => {
    const { audio } = await import('./js/audio.js');
    window.__played = [];
    const orig = audio.play.bind(audio);
    audio.play = (name, variant, time, gain) => {
      window.__played.push({ name, variant, time, gain });
      return orig(name, variant, time, gain);
    };
  });
  return page;
}

async function test(name, fn) {
  const page = await newPage();
  try {
    await fn(page);
    assert.deepEqual(page.errors, [], 'page errors');
    results.push(['ok', name]);
  } catch (e) {
    results.push(['FAIL', name, e.message.split('\n').slice(0, 6).join('\n')]);
  } finally {
    await page.context().close();
  }
}

const tab = (page, name) => page.tap(`.tabbar [data-tab=${name}]`);
const played = (page) => page.evaluate(() => window.__played);
const intervals = (evs) => evs.slice(1).map((e, i) => +(e.time - evs[i].time).toFixed(4));

// Simulates a player tapping the pad: taps each scheduled note at its heard time + offset.
// `skip(i)` returns true for notes to leave out on purpose.
async function autoTap(page, { offsetMs = 0, skip = null, until }) {
  await page.evaluate(({ offsetMs, skipSrc }) => {
    window.__tapStop = false;
    window.__taps = 0;
    const skip = skipSrc ? new Function('i', skipSrc) : () => false;
    import('./js/audio.js').then(({ audio }) => {
      const done = new Set();
      let n = 0;
      const pad = document.getElementById('tap-pad');
      const loop = () => {
        if (window.__tapStop) return;
        const now = audio.heardTime();
        const notes = window.__played.filter((p) => p.note);
        for (const p of notes) {
          const key = p.time.toFixed(5);
          if (done.has(key)) continue;
          if (now >= p.time + offsetMs / 1000) {
            done.add(key);
            const idx = n++;
            if (skip(idx)) continue;
            // timeStamp of a synthetic event is "now"; the app maps it to audio time.
            pad.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
            window.__taps++;
          }
        }
        setTimeout(loop, 1);
      };
      loop();
    });
  }, { offsetMs, skipSrc: skip });
  await page.waitForFunction(until, null, { timeout: 60000, polling: 100 });
  await page.evaluate(() => { window.__tapStop = true; });
}

// Mark which played sounds are rhythm notes (not clicks) so autoTap can find them.
async function tagNotes(page, noteSound) {
  await page.evaluate((noteSound) => {
    const orig = window.__played.push.bind(window.__played);
    window.__played.push = (p) => orig({ ...p, note: p.name === noteSound });
  }, noteSound);
}

(async () => {
  const { server, url } = await serve();
  base = url;
  serverRef = server;
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  // ---------------- Metronome ----------------
  await test('metronome: 120 BPM clicks every 0.5 s with beat one accented', async (page) => {
    await page.tap('#m-play');
    await page.waitForTimeout(2300);
    await page.tap('#m-play');
    const evs = await played(page);
    assert.ok(evs.length >= 4, `only ${evs.length} clicks`);
    intervals(evs).forEach((d) => assert.ok(Math.abs(d - 0.5) < 0.002, `interval ${d}`));
    assert.equal(evs[0].variant, 'accent');
    assert.equal(evs[1].variant, 'normal');
    assert.equal(evs[4]?.variant ?? 'accent', 'accent');
  });

  await test('metronome: stop really stops (no clicks after stop)', async (page) => {
    await page.tap('#m-play');
    await page.waitForTimeout(1200);
    await page.tap('#m-play');
    const n = (await played(page)).length;
    const t = await page.evaluate(async () => (await import('./js/audio.js')).audio.ctx.currentTime);
    await page.waitForTimeout(1200);
    const after = (await played(page)).filter((e) => e.time > t + 0.2);
    assert.equal((await played(page)).length, n);
    assert.equal(after.length, 0);
    assert.equal(await page.textContent('#m-play'), '▶');
  });

  await test('metronome: tempo change while playing applies immediately', async (page) => {
    await page.tap('#m-play');
    await page.waitForTimeout(1100);
    const changedAt = await page.evaluate(async () => {
      (await import('./js/store.js')).set('metronome.bpm', 60);
      return (await import('./js/audio.js')).audio.ctx.currentTime;
    });
    assert.equal(await page.textContent('#m-bpm-out'), '60');
    await page.waitForTimeout(3300);
    await page.tap('#m-play');
    const all = await played(page);
    // Clicks already queued (up to 150 ms ahead) keep the old tempo; after that it's 60 BPM.
    const evs = all.filter((e) => e.time > changedAt + 0.2);
    const iv = intervals(evs);
    assert.ok(iv.length >= 2, 'not enough clicks after change');
    iv.forEach((d) => assert.ok(Math.abs(d - 1) < 0.002, `interval ${d}`));
    // The first click after the change is never sooner than the old spacing or later than the new one.
    const prev = all.filter((e) => e.time <= changedAt + 0.2).pop();
    const gap = evs[0].time - prev.time;
    assert.ok(gap >= 0.5 - 0.002 && gap <= 1.002, `transition gap ${gap}`);
  });

  await test('metronome: clicks per beat, per-click states and mute', async (page) => {
    await page.tap('[data-step="metronome.sub"][data-delta="1"]'); // 2 per beat
    const pads = await page.$$('#m-pads .pad');
    assert.equal(pads.length, 8);
    // Cycle pad 2 (off-beat of beat 1): soft -> silent
    await pads[1].tap();
    assert.equal(await pads[1].getAttribute('data-s'), '0');
    await page.tap('#m-play');
    await page.waitForTimeout(2200);
    await page.tap('#m-play');
    const evs = await played(page);
    // Silent pad produces no sound; 7 sounds per bar, spaced 0.25 s apart except around the gap.
    const bar = evs.slice(0, 7);
    assert.deepEqual(bar.map((e) => e.variant), ['accent', 'normal', 'sub', 'normal', 'sub', 'normal', 'sub']);
    assert.ok(Math.abs(bar[1].time - bar[0].time - 0.5) < 0.002);
    assert.ok(Math.abs(bar[2].time - bar[1].time - 0.25) < 0.002);
  });

  await test('metronome: tap tempo sets 120 BPM from 0.5 s taps', async (page) => {
    for (let i = 0; i < 5; i++) {
      await page.dispatchEvent('#m-tap', 'pointerdown');
      await page.waitForTimeout(500);
    }
    const bpm = Number(await page.textContent('#m-bpm-out'));
    assert.ok(Math.abs(bpm - 120) <= 3, `bpm ${bpm}`);
  });

  await test('metronome: gap click alternates sound and silent bars', async (page) => {
    await page.evaluate(async () => {
      const s = await import('./js/store.js');
      s.set('metronome.bpm', 240);
      s.set('metronome.gap.on', true);
      s.set('metronome.gap.play', 1);
      s.set('metronome.gap.mute', 1);
    });
    await page.tap('#m-play');
    await page.waitForTimeout(4200);
    await page.tap('#m-play');
    const evs = await played(page);
    // 240 BPM, 4/4: bar = 1 s. Sounds only in even bars.
    const t0 = evs[0].time;
    const barsWithSound = new Set(evs.map((e) => Math.floor((e.time - t0 + 0.01) / 1)));
    assert.ok(barsWithSound.has(0) && barsWithSound.has(2), [...barsWithSound].join(','));
    assert.ok(!barsWithSound.has(1) && !barsWithSound.has(3), [...barsWithSound].join(','));
  });

  await test('metronome: stepwise trainer increases tempo each bar up to the target', async (page) => {
    await page.evaluate(async () => {
      const s = await import('./js/store.js');
      s.set('metronome.bpm', 200);
      s.set('metronome.num', 2);
      Object.assign(s.state.metronome.step, { on: true, mode: 'up', amount: 20, every: 1, unit: 'bars', target: 240 });
    });
    await page.tap('#m-play');
    await page.waitForTimeout(3200);
    await page.tap('#m-play');
    const evs = await played(page);
    const iv = intervals(evs).map((d) => Math.round(60 / d));
    // bar 0: 200, bar 1: 220, then 240 and stays there
    assert.deepEqual(iv.slice(0, 6), [200, 200, 220, 220, 240, 240]);
    assert.ok(iv.slice(6).every((b) => b === 240), iv.join(','));
  });

  await test('metronome: stepwise alternate and decrease', async (page) => {
    const r = await page.evaluate(async () => {
      const { bpmForBar } = await import('./js/metronome.js');
      const cfg = (mode, unit) => ({ bpm: 100, step: { on: true, mode, amount: 10, every: 2, unit, target: mode === 'up' ? 200 : 70 } });
      return {
        alt: [0, 1, 2, 3, 4, 5].map((i) => bpmForBar(i, 0, cfg('alt', 'bars'))),
        down: [0, 2, 4, 6, 8, 10].map((i) => bpmForBar(i, 0, cfg('down', 'bars'))),
        secs: [0, 1.9, 2, 4.1].map((s) => bpmForBar(0, s, cfg('up', 'seconds'))),
      };
    });
    assert.deepEqual(r.alt, [100, 100, 110, 110, 100, 100]);
    assert.deepEqual(r.down, [100, 90, 80, 70, 70, 70]);
    assert.deepEqual(r.secs, [100, 100, 110, 120]);
  });

  await test('metronome: countdown stops playback when time is up', async (page) => {
    await page.selectOption('[data-bind="metronome.countdown"]', '1');
    await page.tap('#m-play');
    await page.waitForTimeout(300);
    // Jump the clock forward 61 s.
    await page.evaluate(() => {
      const orig = performance.now.bind(performance);
      performance.now = () => orig() + 61000;
    });
    await page.waitForTimeout(600);
    assert.equal(await page.textContent('#m-play'), '▶');
    assert.equal(await page.textContent('#m-countdown'), '0:00');
    assert.ok(await page.isVisible('#toast'));
  });

  await test('metronome: setlist save, load and delete (persists after reload)', async (page) => {
    await page.evaluate(async () => (await import('./js/store.js')).set('metronome.bpm', 133));
    await page.click('details:has(#m-setlist) summary');
    await page.fill('#m-set-name', 'Verse');
    await page.tap('#m-set-save');
    await page.evaluate(async () => (await import('./js/store.js')).set('metronome.bpm', 90));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#r-timesig option'));
    await page.click('details:has(#m-setlist) summary');
    assert.match(await page.textContent('#m-setlist'), /Verse/);
    await page.tap('#m-setlist [data-load="0"]');
    assert.equal(await page.textContent('#m-bpm-out'), '133');
    await page.tap('#m-setlist [data-del="0"]');
    assert.match(await page.textContent('#m-setlist'), /Nothing saved/);
  });

  // ---------------- Rhythm ----------------
  await test('rhythm: playback timing matches the notation exactly', async (page) => {
    await tab(page, 'rhythm');
    await page.evaluate(async () => {
      const s = await import('./js/store.js');
      Object.assign(s.state.gen, { bpm: 240, bars: 2, loop: false, countIn: true, click: false, swing: 50, triplets: true, complexity: 7 });
    });
    await page.tap('#r-new');
    await page.tap('#r-play');
    await page.waitForFunction(() => document.querySelector('#r-play').textContent === '▶', null, { timeout: 15000 });
    const { evs, expected } = await page.evaluate(async () => {
      const ui = await import('./js/rhythm-ui.js');
      const { barEvents } = await import('./js/rhythm.js');
      const bars = ui.current();
      const exp = [];
      bars.forEach((b, i) => barEvents(b, 50).forEach((e) => exp.push(i * b.num + e.beat)));
      return { evs: window.__played, expected: exp };
    });
    // Count-in: 4 clicks, then the notes.
    const clicks = evs.filter((e) => e.name === 'click');
    const notes = evs.filter((e) => e.name === 'snare');
    assert.equal(clicks.length, 4);
    assert.equal(notes.length, expected.length);
    const start = clicks[0].time + 4 * 0.25; // 240 BPM -> 0.25 s per beat
    notes.forEach((n, i) => assert.ok(Math.abs(n.time - (start + expected[i] * 0.25)) < 0.002, `note ${i}`));
  });

  await test('rhythm: swing delays off-beat 8ths', async (page) => {
    await tab(page, 'rhythm');
    const bar = { num: 4, den: 4, beats: 4, groups: [0, 1, 2, 3].map((b) => ({ kind: 'straight', res: 8, startBeat: b, lengthBeats: 1, slotBeats: 0.5, slots: [1, 1], ghost: [false, false], accent: [false, false], key: 'x' })) };
    await page.evaluate(async (bar) => {
      const s = await import('./js/store.js');
      Object.assign(s.state.gen, { bpm: 120, loop: false, countIn: false, click: false, swing: 66 });
      (await import('./js/rhythm-ui.js')).setRhythm([bar]);
    }, bar);
    await page.tap('#r-play');
    await page.waitForFunction(() => document.querySelector('#r-play').textContent === '▶', null, { timeout: 10000 });
    const iv = intervals(await played(page));
    // 120 BPM: beat 0.5 s, long-short = 0.33 / 0.17
    iv.forEach((d, i) => assert.ok(Math.abs(d - (i % 2 === 0 ? 0.33 : 0.17)) < 0.002, `interval ${i} = ${d}`));
  });

  await test('rhythm: loop repeats, new rhythm swaps in at the next loop', async (page) => {
    await tab(page, 'rhythm');
    await page.evaluate(async () => {
      const s = await import('./js/store.js');
      Object.assign(s.state.gen, { bpm: 300, bars: 1, loop: true, countIn: false, click: false });
    });
    await page.tap('#r-new');
    const first = await page.evaluate(async () => JSON.stringify((await import('./js/rhythm-ui.js')).current()));
    await page.tap('#r-play');
    await page.waitForTimeout(1000);
    await page.tap('#r-new');
    // still the old rhythm until the loop comes round
    assert.equal(await page.evaluate(async () => JSON.stringify((await import('./js/rhythm-ui.js')).current())), first);
    await page.waitForTimeout(1200);
    const now = await page.evaluate(async () => JSON.stringify((await import('./js/rhythm-ui.js')).current()));
    assert.notEqual(now, first);
    await page.tap('#r-play');
    assert.ok(await page.$$eval('#r-notation svg', (s) => s.length) >= 1);
  });

  await test('rhythm: notes light up while playing', async (page) => {
    await tab(page, 'rhythm');
    await page.evaluate(async () => {
      const s = await import('./js/store.js');
      Object.assign(s.state.gen, { bpm: 60, bars: 1, loop: true, countIn: false, click: true, complexity: 1, space: 0 });
    });
    await page.tap('#r-new');
    await page.tap('#r-play');
    await page.waitForTimeout(600);
    const lit = await page.$$eval('#r-notation .vf-stavenote.playing', (e) => e.length);
    // The highlight must actually change the notehead colour, not just the class.
    const colours = await page.$eval('#r-notation .vf-stavenote.playing path', (e) => [
      getComputedStyle(e).fill,
      getComputedStyle(document.querySelector('#r-notation .vf-stavenote:not(.playing) path')).fill,
    ]);
    await page.tap('#r-play');
    assert.equal(lit, 1);
    assert.notEqual(colours[0], colours[1], `highlight colour ${colours[0]} same as normal`);
    // Stems must still be drawn (a CSS rule once hid them).
    const stem = await page.$eval('#r-notation .vf-stem path', (e) => getComputedStyle(e).stroke);
    assert.notEqual(stem, 'none');
  });

  await test('rhythm: every setting regenerates a valid rhythm without errors', async (page) => {
    await tab(page, 'rhythm');
    const sigs = await page.$$eval('#r-timesig option', (o) => o.map((x) => x.value));
    for (const sig of sigs) {
      await page.selectOption('#r-timesig', sig);
      for (const sub of ['8th', '16th']) {
        await page.tap(`[data-bind="gen.subdivision"] [data-value="${sub}"]`);
        for (const bars of ['1', '8']) await page.tap(`[data-bind="gen.bars"] [data-value="${bars}"]`);
      }
    }
    for (const t of ['triplets', 'ghostNotes', 'accents']) await page.check(`[data-bind="gen.${t}"]`);
    await page.$eval('#tab-rhythm [data-bind="gen.complexity"]', (el) => { el.value = 10; el.dispatchEvent(new Event('input')); });
    assert.equal(await page.$$eval('#r-notation .error', (e) => e.length), 0);
    assert.ok(await page.$$eval('#r-notation svg', (e) => e.length) >= 1);
  });

  await test('rhythm: presets apply and user presets save/delete', async (page) => {
    await tab(page, 'rhythm');
    await page.selectOption('#r-presets', 'b4'); // 6/8 groove
    assert.equal(await page.inputValue('#r-timesig'), '6/8');
    await page.tap('#r-preset-save');
    await page.fill('#preset-name', 'Mine 6/8');
    await page.tap('#preset-ok');
    assert.equal(await page.inputValue('#r-presets'), 'u0');
    await page.selectOption('#r-presets', 'b0');
    assert.equal(await page.inputValue('#r-timesig'), '4/4');
    await page.selectOption('#r-presets', 'u0');
    assert.equal(await page.inputValue('#r-timesig'), '6/8');
    await page.tap('#r-preset-del');
    assert.equal(await page.$$eval('#r-presets option', (o) => o.filter((x) => x.value.startsWith('u')).length), 0);
  });

  await test('play-along: perfect taps score 100% with a full streak', async (page) => {
    await tab(page, 'rhythm');
    await page.evaluate(async () => {
      const s = await import('./js/store.js');
      Object.assign(s.state.gen, { bpm: 100, bars: 2, passes: 1, click: true, complexity: 5, space: 10, timeSig: '4/4', triplets: false, subdivision: '16th' });
      s.state.prefs.hearRhythm = true; // so the recorder sees note sounds
    });
    await page.tap('#r-new');
    await tagNotes(page, 'snare');
    await page.tap('#r-along');
    assert.ok(await page.isVisible('#tap-pad'));
    await autoTap(page, { offsetMs: 0, until: () => document.getElementById('modal').open });
    const acc = await page.textContent('.summary-acc');
    const grid = await page.textContent('.summary-grid');
    const nNotes = await page.evaluate(() => window.__played.filter((p) => p.note).length);
    assert.equal(acc, '100%', `accuracy ${acc} / ${grid}`);
    assert.match(grid, new RegExp(`${nNotes}\\s*longest streak`));
    assert.ok(!(await page.isVisible('#tap-pad')));
    const hist = await page.evaluate(async () => (await import('./js/store.js')).state.history);
    assert.equal(hist.length, 1);
    assert.equal(hist[0].accuracy, 100);
  });

  await test('play-along: skipped notes count as misses, shown as most missed and drillable', async (page) => {
    await tab(page, 'rhythm');
    await page.evaluate(async () => {
      const s = await import('./js/store.js');
      Object.assign(s.state.gen, { bpm: 100, bars: 2, passes: 1, click: true, complexity: 5, space: 0, timeSig: '4/4', subdivision: '16th' });
      s.state.prefs.hearRhythm = true;
    });
    await page.tap('#r-new');
    await tagNotes(page, 'snare');
    await page.tap('#r-along');
    await autoTap(page, { skip: 'return i % 3 === 1', until: () => document.getElementById('modal').open });
    const total = await page.evaluate(() => window.__played.filter((p) => p.note).length);
    const missed = Math.floor((total + 1) / 3);
    const acc = Number((await page.textContent('.summary-acc')).replace('%', ''));
    assert.equal(acc, Math.round(((total - missed) / total) * 100), `acc ${acc}, total ${total}`);
    assert.ok(await page.$$eval('[data-missed] svg', (s) => s.length) >= 1, 'most missed not rendered');
    assert.ok(await page.$$eval('#r-notation .vf-stavenote.miss', (s) => s.length) >= 1, 'misses not marked');
    assert.equal(await page.$eval('#r-notation .vf-stavenote.miss path', (e) => getComputedStyle(e).fill), 'rgb(214, 69, 69)', 'misses not red');
    assert.equal(await page.$eval('#r-notation .vf-stavenote.hit path', (e) => getComputedStyle(e).fill), 'rgb(31, 157, 85)', 'hits not green');
    await page.tap('#drill-btn');
    assert.ok(!(await page.evaluate(() => document.getElementById('modal').open)));
  });

  await test('play-along: late taps within the window still count, flagged as late', async (page) => {
    await tab(page, 'rhythm');
    await page.evaluate(async () => {
      const s = await import('./js/store.js');
      Object.assign(s.state.gen, { bpm: 80, bars: 1, passes: 2, complexity: 2, space: 0, subdivision: '8th', timeSig: '4/4', triplets: false });
      s.state.prefs.hearRhythm = true;
    });
    await page.tap('#r-new');
    await tagNotes(page, 'snare');
    await page.tap('#r-along');
    await autoTap(page, { offsetMs: 70, until: () => document.getElementById('modal').open });
    assert.equal(await page.textContent('.summary-acc'), '100%');
    assert.match(await page.textContent('#modal-body'), /ms late/);
  });

  await test('play-along: taps during count-in are ignored and stop button ends the session', async (page) => {
    await tab(page, 'rhythm');
    await page.evaluate(async () => {
      const s = await import('./js/store.js');
      Object.assign(s.state.gen, { bpm: 60, bars: 1, passes: 0 });
    });
    await page.tap('#r-along');
    await page.waitForTimeout(300);
    await page.dispatchEvent('#tap-pad', 'pointerdown');
    await page.waitForTimeout(8000); // count-in (4 s) plus the whole first bar
    await page.dispatchEvent('#tap-stop', 'pointerdown');
    await page.waitForFunction(() => document.getElementById('modal').open);
    assert.ok(!(await page.isVisible('#tap-pad')));
    // The count-in tap was ignored (0 extra taps); the untapped notes count as misses.
    const grid = await page.textContent('.summary-grid');
    assert.match(grid, /0\s*extra taps/);
    assert.equal(await page.textContent('.summary-acc'), '0%');
  });

  // ---------------- Reading ----------------
  await test('reading: rows scroll in endlessly and notes highlight', async (page) => {
    await tab(page, 'reading');
    await page.evaluate(async () => {
      const s = await import('./js/store.js');
      Object.assign(s.state.gen, { bpm: 260, timeSig: '4/4', subdivision: '8th', complexity: 3 });
    });
    await page.tap('#rd-new');
    const firstRowHtml = await page.$eval('#rd-notation .nrow', (e) => e.innerHTML);
    await page.tap('#rd-play');
    await page.waitForTimeout(9000);
    const rows = await page.$$eval('#rd-notation .nrow', (e) => e.length);
    const nowFirst = await page.$eval('#rd-notation .nrow', (e) => e.innerHTML);
    const current = await page.$$eval('#rd-notation .nrow.current', (e) => e.length);
    await page.tap('#rd-play');
    assert.equal(rows, 3);
    assert.equal(current, 1);
    assert.notEqual(nowFirst, firstRowHtml, 'rows did not advance');
  });

  await test('reading: play-along scores across many bars', async (page) => {
    await tab(page, 'reading');
    await page.evaluate(async () => {
      const s = await import('./js/store.js');
      Object.assign(s.state.gen, { bpm: 200, timeSig: '6/8', subdivision: '8th', complexity: 4, space: 10 });
      s.state.prefs.hearRhythm = true;
    });
    await page.tap('#rd-new');
    await tagNotes(page, 'snare');
    await page.tap('#rd-along');
    await autoTap(page, { until: () => window.__taps >= 30 });
    await page.dispatchEvent('#tap-stop', 'pointerdown');
    await page.waitForFunction(() => document.getElementById('modal').open);
    const acc = Number((await page.textContent('.summary-acc')).replace('%', ''));
    assert.ok(acc >= 95, `accuracy ${acc}`);
  });

  // ---------------- Settings ----------------
  await test('calibration: measures a consistent 60 ms tap delay', async (page) => {
    await tab(page, 'settings');
    await page.tap('#s-calibrate');
    await page.evaluate(() => {
      window.__tapStop = false;
      import('./js/audio.js').then(({ audio }) => {
        const done = new Set();
        const loop = () => {
          if (window.__tapStop) return;
          const now = audio.heardTime();
          for (const p of window.__played) {
            const k = p.time.toFixed(5);
            if (!done.has(k) && now >= p.time + 0.06) {
              done.add(k);
              document.getElementById('cal-pad')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            }
          }
          setTimeout(loop, 1);
        };
        loop();
      });
    });
    await page.waitForFunction(() => /Calibrated|Not enough/.test(document.getElementById('modal-body').textContent), null, { timeout: 15000 });
    await page.evaluate(() => { window.__tapStop = true; });
    const ms = await page.evaluate(async () => (await import('./js/store.js')).state.prefs.calibrationMs);
    assert.ok(Math.abs(ms - 60) <= 6, `measured ${ms}`);
    const off = await page.evaluate(async () => (await import('./js/audio.js')).audio.latencyOffset);
    assert.ok(Math.abs(off * 1000 - ms) < 0.5);
  });

  await test('settings: theme, export and import round-trip', async (page) => {
    await tab(page, 'settings');
    await page.tap('[data-bind="prefs.theme"] [data-value="dark"]');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await page.evaluate(async () => (await import('./js/store.js')).set('metronome.bpm', 77));
    const [download] = await Promise.all([page.waitForEvent('download'), page.tap('#s-export')]);
    const path = await download.path();
    await page.evaluate(async () => (await import('./js/store.js')).set('metronome.bpm', 150));
    await page.setInputFiles('#s-import', path);
    await page.waitForFunction(() => document.getElementById('m-bpm-out').textContent === '77');
    await page.setInputFiles('#s-import', { name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
    await page.waitForFunction(() => /not a Rhythm Trainer backup/.test(document.getElementById('toast').textContent));
  });

  await test('switching tabs stops the other player', async (page) => {
    await page.tap('#m-play');
    await tab(page, 'rhythm');
    await page.tap('#r-play');
    await page.waitForTimeout(200);
    await tab(page, 'metronome');
    assert.equal(await page.textContent('#m-play'), '▶');
    await tab(page, 'rhythm');
    assert.equal(await page.textContent('#r-play'), '■');
    await page.tap('#r-play');
  });

  // ---------------- Offline / install ----------------
  await test('PWA: service worker caches the app and it loads offline', async (page) => {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 10000 });
    const manifest = await page.evaluate(async () => (await fetch('manifest.webmanifest')).json());
    assert.equal(manifest.display, 'standalone');
    // Take the web server down completely, then reload.
    await new Promise((r) => { serverRef.closeAllConnections(); serverRef.close(r); });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#r-timesig option'));
    await tab(page, 'rhythm');
    assert.ok(await page.$$eval('#r-notation svg', (s) => s.length) >= 1);
  });

  await browser.close();
  if (server.listening) server.close();
  for (const [s, n, e] of results) console.log(`${s.padEnd(4)} ${n}${e ? `\n     ${e.replace(/\n/g, '\n     ')}` : ''}`);
  const failed = results.filter((r) => r[0] !== 'ok').length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
