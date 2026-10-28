// Renders icons/icon.svg to the PNG sizes the manifest needs.
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '../icons/icon.svg'), 'utf8');
  const b = await chromium.launch();
  const p = await b.newPage();
  const shot = async (size, file, maskable) => {
    await p.setViewportSize({ width: size, height: size });
    const inner = maskable
      ? `<div style="width:${size}px;height:${size}px;background:#ff7a2f;display:flex;align-items:center;justify-content:center"><div style="width:${size * 0.8}px;height:${size * 0.8}px">${svg.replace('rx="112"', 'rx="0"')}</div></div>`
      : `<div style="width:${size}px;height:${size}px">${svg}</div>`;
    await p.setContent(`<style>body{margin:0;background:transparent}svg{width:100%;height:100%;display:block}</style>${inner}`);
    await p.screenshot({ path: path.join(__dirname, '../icons', file), omitBackground: true });
  };
  await shot(192, 'icon-192.png');
  await shot(512, 'icon-512.png');
  await shot(512, 'maskable-512.png', true);
  await b.close();
})();
