// Screenshots of key states for manual review. Output: $OUT (default /tmp)
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
  const gen = (p, g) => p.evaluate(async (g) => { const s = await import('./js/store.js'); for (const [k, v] of Object.entries(g)) s.set(`gen.${k}`, v); }, g);
  await shot('rhythm-playing', async (p) => { await gen(p, { bars: 4, complexity: 4, bpm: 95, countIn: false }); await p.tap('#r-new'); await p.tap('#r-play'); await p.waitForTimeout(1500); });
  await shot('settings-sheet', async (p) => { await p.tap('#r-all'); await p.waitForTimeout(300); });
  await shot('pick-bpm', async (p) => { await p.tap('[data-pick="bpm"]'); await p.waitForTimeout(300); });
  await shot('along', async (p) => { await gen(p, { bpm: 60, complexity: 3, bars: 2, passes: 0, playAlong: true }); await p.tap('#r-new'); await p.tap('#r-play'); await p.waitForTimeout(6600); await p.tap('#tap-pad'); });
  await shot('results', async (p) => { await gen(p, { bpm: 200, complexity: 6, bars: 1, passes: 1, space: 0, playAlong: true }); await p.tap('#r-new'); await p.tap('#r-play'); await p.waitForFunction(() => document.getElementById('modal').open, null, { timeout: 20000 }); await p.waitForTimeout(300); });
  await shot('reading-dark', async (p) => { await gen(p, { readingMode: true, bpm: 120, complexity: 5, triplets: true }); await p.tap('#r-play'); await p.waitForTimeout(4500); }, { dark: true });
  await shot('metro-playing', async (p) => { await p.tap('[data-tab=metronome]'); await p.evaluate(async () => { const s = await import('./js/store.js'); s.set('metronome.num', 6); s.set('metronome.sub', 3); s.set('metronome.bpm', 85); }); await p.tap('#m-play'); await p.waitForTimeout(1300); });
  await shot('metro-dark', async (p) => { await p.tap('[data-tab=metronome]'); await p.tap('#m-step-btn'); await p.waitForTimeout(300); }, { dark: true });
  await shot('menu', async (p) => { await p.tap('[data-tab=menu]'); }, { full: true });
  await b.close(); server.close();
})();
