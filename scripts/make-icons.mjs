// scripts/icon-shapes.mjs의 도형으로 모든 운영체제의 아이콘을 만듭니다. Electron으로 실행합니다.
// 사용법: npx electron scripts/make-icons.mjs
//
// - resources/AppIcon.icon/Assets: 맥 리퀴드 글래스 아이콘(Icon Composer 형식)의 층 그림. 색과 유리 설정은 icon.json에 둡니다.
// - resources/icon.svg, icon.png: 같은 조형과 색을 유리 질감 없이 그린 Windows, Linux용 아이콘
// - docs/icon.png: README용 작은 그림
import { app, BrowserWindow } from 'electron';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flatIcon, glassLayers } from './icon-shapes.mjs';

const root = path.resolve(import.meta.dirname, '..');
const svg = flatIcon();

async function render(size) {
  const html = `<!doctype html><html><body style="margin:0;background:transparent">
    <img style="width:${size}px;height:${size}px;display:block" src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">
    </body></html>`;
  const window = new BrowserWindow({ width: size, height: size, show: false, transparent: true, frame: false, useContentSize: true, webPreferences: { offscreen: true } });
  const page = path.join(mkdtempSync(path.join(os.tmpdir(), 'uncalive-icon-')), 'icon.html');
  writeFileSync(page, html);
  await window.loadFile(page);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  window.destroy();
  return image.resize({ width: size, height: size, quality: 'best' }).toPNG();
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  try {
    // 층 그림은 icon-shapes.mjs에 있는 것만 둡니다. 예전 층 그림은 지웁니다.
    const assets = path.join(root, 'resources', 'AppIcon.icon', 'Assets');
    for (const name of readdirSync(assets)) if (!(name in glassLayers)) rmSync(path.join(assets, name));
    for (const [name, layer] of Object.entries(glassLayers)) writeFileSync(path.join(assets, name), layer);
    writeFileSync(path.join(root, 'resources', 'icon.svg'), svg);
    writeFileSync(path.join(root, 'resources', 'icon.png'), await render(1024));
    writeFileSync(path.join(root, 'docs', 'icon.png'), await render(256));
  } catch (error) {
    console.error('아이콘 만들기 실패:', error);
    process.exitCode = 1;
  }
  app.quit();
});
