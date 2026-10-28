// Screenshots of tricky states for manual review. Output: $OUT (default /tmp)
const { chromium } = require('playwright');
const serve = require('./server.cjs');
const OUT = process.env.OUT || '/tmp';
(async () => {
  const { server, url } = await serve();
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const shot = async (name, setup, opts = {}) => {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: opts.dark ? 'dark' : 'light' });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message));
    await p.goto(url);
    await p.waitForFunction(() => document.querySelector('#r-timesig option'));
    await setup(p);
    await p.screenshot({ path: `${OUT}/v-${name}.png`, fullPage: !!opts.full });
    if (errs.length) console.log(name, errs);
    await ctx.close();
  };
  const gen = (p, g) => p.evaluate(async (g) => { const s = await import('./js/store.js'); Object.assign(s.state.gen, g); s.refresh(); }, g);
  await shot('dense-12-8', async (p) => { await p.tap('[data-tab=rhythm]'); await gen(p, { timeSig: '12/8', subdivision: '16th', complexity: 10, bars: 2, space: 0 }); await p.tap('#r-new'); });
  await shot('dense-7-4', async (p) => { await p.tap('[data-tab=rhythm]'); await gen(p, { timeSig: '7/4', subdivision: '16th', complexity: 10, bars: 1, space: 0, triplets: true }); await p.tap('#r-new'); });
  await shot('triplets-ghost-dark', async (p) => { await p.tap('[data-tab=rhythm]'); await gen(p, { timeSig: '4/4', subdivision: '16th', complexity: 8, bars: 4, triplets: true, ghostNotes: true, accents: true }); await p.tap('#r-new'); }, { dark: true });
  await shot('along', async (p) => { await p.tap('[data-tab=rhythm]'); await gen(p, { bpm: 60, complexity: 3, bars: 2, passes: 0 }); await p.tap('#r-new'); await p.tap('#r-along'); await p.waitForTimeout(5600); });
  await shot('summary', async (p) => { await p.tap('[data-tab=rhythm]'); await gen(p, { bpm: 200, complexity: 6, bars: 1, passes: 1, space: 0 }); await p.tap('#r-new'); await p.tap('#r-along'); await p.waitForFunction(() => document.getElementById('modal').open, null, { timeout: 20000 }); await p.waitForTimeout(300); });
  await shot('metronome-many', async (p) => { await p.evaluate(async () => { const s = await import('./js/store.js'); s.set('metronome.num', 7); s.set('metronome.sub', 6); }); await p.tap('#m-play'); await p.waitForTimeout(700); }, { dark: true });
  await shot('reading-play', async (p) => { await p.tap('[data-tab=reading]'); await gen(p, { bpm: 200, timeSig: '4/4', subdivision: '16th', complexity: 5 }); await p.tap('#rd-new'); await p.tap('#rd-play'); await p.waitForTimeout(5000); });
  await b.close(); server.close();
})();
