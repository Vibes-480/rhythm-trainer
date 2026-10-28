const { chromium } = require('playwright');
const serve = require('./server.cjs');
(async () => {
  const { server, url } = await serve();
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push('CONSOLE ' + m.text()); });
  await p.goto(url);
  await p.waitForTimeout(800);
  for (const tab of ['rhythm', 'metronome', 'menu']) {
    await p.tap(`.tabbar [data-tab=${tab}]`);
    await p.waitForTimeout(400);
    await p.screenshot({ path: `/tmp/claude-0/tab-${tab}.png`, fullPage: true });
  }
  console.log(errs.join('\n') || 'no errors');
  await b.close(); server.close();
})();
