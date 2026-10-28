const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const root = path.resolve(__dirname, '..');
const types = { '.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml' };
const server = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html'; const f = path.join(root, p); if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); } res.writeHead(200, {'content-type': types[path.extname(f)] || 'application/octet-stream'}); fs.createReadStream(f).pipe(res); });
server.listen(0, async () => {
  const port = server.address().port;
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 400, height: 800 } });
  p.on('pageerror', e => console.log('PAGEERROR', e.message));
  await p.goto(`http://localhost:${port}/tests/render.html${process.argv[2] || ''}`);
  await p.waitForFunction('window.done', null, { timeout: 120000 });
  console.log('parenthesis:', await p.evaluate('window.parenthesis'));
  console.log('errors:', JSON.stringify(await p.evaluate('window.renderErrors'), null, 1));
  if (!process.argv[2]) await p.screenshot({ path: process.argv[3] || '/tmp/claude-0/render.png', fullPage: true });
  await b.close(); server.close();
});
