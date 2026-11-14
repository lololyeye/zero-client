// Renders assets/logo.svg into the PNG/ICO files used by the app and the installer.
// Run with: npx electron scripts/make-icons.cjs   (Electron renders the SVG; no extra dependency)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'assets', 'logo.svg'), 'utf8');
const SIZE = 512;

function ico(pngs) {
  // ICO container with embedded PNG images (supported since Windows Vista)
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length); let offset = 6 + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size; dir[o + 1] = size >= 256 ? 0 : size; dir[o + 2] = 0; dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6); dir.writeUInt32LE(data.length, o + 8); dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: SIZE, height: SIZE, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden">${svg.replace('<svg ', `<svg width="${SIZE}" height="${SIZE}" `)}</body></html>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 400));
  const img = await win.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  const big = img.resize({ width: SIZE, height: SIZE, quality: 'best' });
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'icon.png'), big.toPNG());
  fs.writeFileSync(path.join(root, 'assets', 'icon.png'), img.resize({ width: 256, height: 256, quality: 'best' }).toPNG());
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  fs.writeFileSync(path.join(root, 'build', 'icon.ico'), ico(sizes.map((s) => ({ size: s, data: img.resize({ width: s, height: s, quality: 'best' }).toPNG() }))));
  console.log('icons written: build/icon.png, build/icon.ico, assets/icon.png');
  app.quit();
});
