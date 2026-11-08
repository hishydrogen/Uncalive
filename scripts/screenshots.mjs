// README용 화면을 찍습니다. 지어낸 예시 글과 그림만 임시 폴더에 만들어 쓰며, 네트워크는 쓰지 않습니다.
// 사용법: npm run build && node scripts/screenshots.mjs docs/screenshots [--dark]
// --dark를 붙이면 다크 모드로 찍고 파일 이름 끝에 -dark를 붙입니다. CI는 운영체제마다 두 가지를 모두 찍어 보관합니다.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { _electron as electron } from 'playwright-core';

const out = path.resolve(process.argv[2] ?? 'docs/screenshots');
const dark = process.argv.includes('--dark');
mkdirSync(out, { recursive: true });
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'uncalive-shots-'));
const root = path.join(sandbox, 'library', 'Guest');

/** 위아래 두 색이 섞이는 그림을 만듭니다. */
function picture(width, height, top, bottom, band) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data) => {
    let c = 0xffffffff;
    for (const byte of data) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    const t = y / height;
    const inBand = band && Math.abs(t - band.at) < band.size;
    for (let x = 0; x < width; x += 1) {
      const color = inBand ? band.color : top.map((value, i) => Math.round(value + (bottom[i] - value) * t));
      row.set(color, 1 + x * 3);
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

const palettes = [
  [[255, 196, 140], [96, 158, 214], { at: 0.62, size: 0.02, color: [40, 70, 120] }],
  [[142, 204, 180], [24, 96, 86]],
  [[250, 226, 170], [214, 120, 72]],
  [[206, 203, 246], [60, 52, 137], { at: 0.7, size: 0.04, color: [240, 240, 255] }],
  [[180, 212, 244], [235, 245, 255]],
  [[244, 192, 209], [120, 50, 90]],
];
const channels = [['travel', '여행'], ['keyboard', '키보드'], ['cooking', '요리'], ['photo', '사진']];
const posts = [
  ['1001', 'travel', '노을 지는 바닷가에서 찍은 사진들', '풍경', '바다거북'],
  ['1002', 'keyboard', '첫 커스텀 키보드 조립 후기', '후기', '타건러'],
  ['1003', 'cooking', '주말에 만든 토마토 파스타 레시피', '레시피', '부엌요정'],
  ['1004', 'photo', '필름 카메라로 담은 가을 산책길', '필름', '은행잎'],
  ['1005', 'travel', '처음 가 본 섬 여행 정리', '정보', '바다거북'],
  ['1006', 'keyboard', '스위치 다섯 종류 비교해 봤습니다', '정보', '조용한타자'],
  ['1007', 'photo', '비 오는 날 창가 사진 모음', '디지털', '구름사진관'],
  ['1008', 'cooking', '실패 없는 계란말이 요령', '팁', '부엌요정'],
];

const state = { version: 1, posts: {} };
const collection = [];
posts.forEach(([id, channel, title, category, author], index) => {
  const channelName = channels.find(([slug]) => slug === channel)[1];
  const folder = `Links/${title}`;
  const files = {};
  const count = 1 + (index % 3);
  for (let n = 0; n < count; n += 1) {
    const [top, bottom, band] = palettes[(index + n) % palettes.length];
    const name = `0${n + 1}.png`;
    mkdirSync(path.join(root, ...folder.split('/')), { recursive: true });
    writeFileSync(path.join(root, ...folder.split('/'), name), picture(480, 360, top, bottom, band));
    files[`demo.example/${id}/${n}`] = name;
  }
  writeFileSync(path.join(root, ...folder.split('/'), 'index.html'), `<html><body><h1>${title}</h1></body></html>`);
  const createdAt = new Date(Date.UTC(2026, 10, 7 - index, 9, 30)).toISOString();
  state.posts[id] = { id, folder, title, completed: index !== 5, files, updatedAt: createdAt.replace(/\.\d{3}Z$/, 'Z'), channel, channelName, category, author, createdAt };
  mkdirSync(path.join(root, '.uncalive', 'text'), { recursive: true });
  writeFileSync(path.join(root, '.uncalive', 'text', `${id}.txt`), `${title}\n${author}`);
  collection.push({ id, channel, channelName, url: `https://arca.live/b/${channel}/${id}`, title, author, createdAt, category });
});
for (let index = 0; index < 6; index += 1) {
  const id = String(2001 + index);
  const [channel, channelName] = channels[index % channels.length];
  const titles = ['이번 주 모임 사진 공유합니다', '입문자를 위한 장비 추천', '오늘 저녁 메뉴 고민', '새벽 산책 기록', '중고로 들인 렌즈 후기', '다음 달 여행 계획'];
  collection.push({ id, channel, channelName, url: `https://arca.live/b/${channel}/${id}`, title: titles[index], author: ['산책가', '초보', '배고픔', '새벽', '렌즈', '계획러'][index], createdAt: new Date(Date.UTC(2026, 10, 8, 8 - index)).toISOString(), category: ['일반', '질문', '잡담', '일반', '후기', '정보'][index] });
}
mkdirSync(path.join(root, '.uncalive'), { recursive: true });
writeFileSync(path.join(root, '.uncalive', 'state.json'), JSON.stringify(state, null, 2));
writeFileSync(path.join(root, '.uncalive', 'collection.json'), JSON.stringify(collection));

// 처음 실행 안내는 이미 동의한 것으로 둡니다.
mkdirSync(path.join(sandbox, 'profile'), { recursive: true });
writeFileSync(path.join(sandbox, 'profile', 'settings.json'), JSON.stringify({ acceptedTermsVersion: 1 }));
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, UNCALIVE_PROFILE_DIR: path.join(sandbox, 'profile'), UNCALIVE_DEFAULT_FOLDER: path.join(sandbox, 'library') },
});
try {
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1240, height: 760 });
  if (dark) await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => document.documentElement.classList.add('capture'));
  // 임시 폴더 경로 대신 기본 보관함 위치로 보여 줍니다.
  const library = path.join(sandbox, 'library');
  const shoot = async (name) => {
    await page.evaluate((prefix) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent.includes(prefix)) node.textContent = node.textContent.replaceAll(prefix, '~/Uncalive');
      }
    }, library);
    await page.screenshot({ path: path.join(out, dark ? name.replace('.png', '-dark.png') : name) });
  };
  await page.waitForSelector('.sidebar');
  await page.click('.nav-item:has-text("링크")');
  await page.waitForSelector('td.title');
  // 새로 받을 글 2개와 일부만 받은 글 1개를 체크해 하단 요약 막대와 활성화된 다운로드 버튼을 보여 줍니다.
  await page.locator('tbody tr').nth(5).locator('td.check input').check();
  await page.locator('tbody tr').nth(8).locator('td.check input').check();
  await page.locator('tbody tr').nth(9).locator('td.check input').check();
  await page.waitForTimeout(800);
  await shoot('collection.png');
  await page.click('.nav-item:has-text("보관함")');
  await page.waitForSelector('.library-card img');
  await page.waitForTimeout(1200);
  await shoot('library.png');
  await page.click('.nav-item:has-text("갤러리")');
  await page.waitForSelector('.gallery-cell img');
  await page.waitForTimeout(1200);
  await shoot('gallery.png');
  await page.click('.nav-item:has-text("링크")');
  await page.click('button:has-text("주소 추가")');
  await page.fill('.dialog textarea', 'https://arca.live/b/travel?mode=best\nhttps://arca.live/b/photo/1004');
  await page.waitForTimeout(500);
  await shoot('add-address.png');
  console.log('화면을 저장했습니다:', out);
} finally {
  await app.close();
}
