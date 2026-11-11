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

// 예시 그림: 노을 바다, 안개 산, 사막, 밤하늘, 구름 언덕, 분홍 호수를 코드로 그립니다.
/** 0~1 사이 값을 돌려주는 결정적 난수입니다. */
const hash1 = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const hash2 = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); };
const smooth = (t) => t * t * (3 - 2 * t);
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
function noise1(x) { const i = Math.floor(x); return hash1(i) + (hash1(i + 1) - hash1(i)) * smooth(x - i); }
function noise2(x, y) {
  const i = Math.floor(x), j = Math.floor(y), u = smooth(x - i), v = smooth(y - j);
  const a = hash2(i, j), b = hash2(i + 1, j), c = hash2(i, j + 1), d = hash2(i + 1, j + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm1(x, octaves) { let sum = 0, amp = 0.5, f = 1; for (let o = 0; o < octaves; o += 1) { sum += amp * noise1(x * f); amp *= 0.5; f *= 2.03; } return sum; }
function fbm2(x, y) { let sum = 0, amp = 0.5, f = 1; for (let o = 0; o < 5; o += 1) { sum += amp * noise2(x * f, y * f); amp *= 0.5; f *= 2.01; } return sum; }
function gradient(stops, t) {
  for (let k = 1; k < stops.length; k += 1) if (t <= stops[k][0]) return mix(stops[k - 1][1], stops[k][1], smooth(clamp((t - stops[k - 1][0]) / (stops[k][0] - stops[k - 1][0]))));
  return stops[stops.length - 1][1];
}

/** 하늘, 해(달), 별, 구름, 겹겹의 능선, 물에 비친 모습을 그려 RGB 버퍼로 돌려줍니다. */
function scene(width, height, spec, variant = 0) {
  const W = width, H = height, buf = new Float32Array(W * H * 3);
  const sunX = spec.sun ? (spec.sun.x + (variant % 3 - 1) * 0.12) * W : 0;
  const horizon = spec.water ? spec.water * H : H;
  for (let y = 0; y < horizon; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let c = gradient(spec.sky, y / H);
      if (spec.stars && hash2(x + variant * 7, y) > 0.997) c = mix(c, [255, 250, 235], 0.4 + 0.6 * hash2(y, x));
      if (spec.sun) {
        const d = Math.hypot(x - sunX, y - spec.sun.y * H);
        c = mix(c, spec.sun.glow, Math.exp(-d / spec.sun.spread) * spec.sun.strength);
        c = mix(c, spec.sun.color, clamp(spec.sun.r - d + 0.5));
      }
      if (spec.clouds) {
        const n = fbm2(x / 110 + variant * 3.1, y / 42);
        const k = smooth(clamp((n - spec.clouds.cover) / 0.18)) * clamp(1.15 - y / (H * spec.clouds.until));
        c = mix(c, mix(spec.clouds.color, spec.clouds.shade, clamp((y / H) * 1.4)), k * 0.92);
      }
      for (const [n, layer] of spec.layers.entries()) {
        const ridge = H * layer.base - H * layer.amp * fbm1(x * layer.freq + n * 13.7 + variant * 5.3, layer.octaves ?? 6);
        const cover = clamp(y - ridge + 0.5);
        if (cover <= 0) continue;
        let lc = layer.color;
        if (layer.light) lc = mix(layer.light, lc, clamp((y - ridge) / (H * 0.12)));
        if (spec.fog) lc = mix(lc, spec.fog, clamp((y - H * (layer.base - layer.amp * 0.6)) / (H * 0.3)) * (layer.fog ?? 0));
        c = mix(c, lc, cover);
      }
      buf.set(c, (y * W + x) * 3);
    }
  }
  for (let y = Math.ceil(horizon); y < H; y += 1) {
    const depth = (y - horizon) / (H - horizon);
    const src = Math.max(0, Math.round(2 * horizon - y - 1));
    for (let x = 0; x < W; x += 1) {
      const wave = Math.sin(y * 0.9 + Math.sin(x * 0.05) * 2) * (1 + depth * 6);
      const sx = Math.min(W - 1, Math.max(0, Math.round(x + wave)));
      let c = Array.from(buf.subarray((src * W + sx) * 3, (src * W + sx) * 3 + 3));
      c = mix(c, spec.waterTint, 0.25 + depth * 0.35);
      if (spec.sun && Math.abs(x - sunX) < spec.sun.r * (1.4 + depth * 1.6) && y % 3 === 0 && hash2(Math.floor(x / 14), y) > 0.5) c = mix(c, spec.sun.color, 0.5 * (1 - depth));
      buf.set(c, (y * W + x) * 3);
    }
  }
  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i += 1) {
    const grain = (hash2(i % W, Math.floor(i / W) + variant) - 0.5) * 6;
    for (let k = 0; k < 3; k += 1) rgb[i * 3 + k] = clamp(Math.round(buf[i * 3 + k] + grain), 0, 255);
  }
  return rgb;
}

const scenes = [
  { // 노을 지는 바다
    sky: [[0, [52, 50, 108]], [0.38, [196, 104, 130]], [0.6, [255, 178, 128]]],
    sun: { x: 0.62, y: 0.56, r: 30, color: [255, 238, 206], glow: [255, 168, 112], spread: 70, strength: 0.75 },
    layers: [{ base: 0.6, amp: 0.07, freq: 0.012, color: [112, 70, 104] }],
    water: 0.6, waterTint: [52, 44, 96],
  },
  { // 안개 낀 산
    sky: [[0, [186, 216, 220]], [1, [244, 238, 222]]], fog: [226, 234, 228],
    sun: { x: 0.3, y: 0.24, r: 18, color: [255, 252, 238], glow: [255, 246, 220], spread: 60, strength: 0.5 },
    layers: [
      { base: 0.52, amp: 0.2, freq: 0.008, color: [150, 184, 182], fog: 0.7 },
      { base: 0.64, amp: 0.2, freq: 0.01, color: [104, 150, 146], fog: 0.6 },
      { base: 0.78, amp: 0.18, freq: 0.013, color: [56, 104, 100], fog: 0.5 },
      { base: 0.95, amp: 0.16, freq: 0.017, color: [24, 64, 64], fog: 0.3 },
    ],
  },
  { // 사막 언덕
    sky: [[0, [98, 150, 210]], [0.55, [246, 210, 170]]],
    sun: { x: 0.72, y: 0.2, r: 20, color: [255, 250, 232], glow: [255, 232, 190], spread: 80, strength: 0.6 },
    layers: [
      { base: 0.62, amp: 0.12, freq: 0.006, octaves: 2, color: [226, 164, 108], light: [246, 206, 150] },
      { base: 0.8, amp: 0.16, freq: 0.005, octaves: 2, color: [204, 128, 80], light: [238, 180, 122] },
      { base: 1.0, amp: 0.2, freq: 0.004, octaves: 2, color: [170, 96, 62], light: [222, 150, 98] },
    ],
  },
  { // 별이 뜬 밤
    sky: [[0, [14, 16, 44]], [0.6, [64, 50, 118]], [0.85, [150, 96, 150]]], stars: true,
    sun: { x: 0.7, y: 0.22, r: 16, color: [250, 246, 228], glow: [170, 160, 220], spread: 50, strength: 0.45 },
    layers: [
      { base: 0.7, amp: 0.26, freq: 0.009, color: [82, 62, 132] },
      { base: 0.86, amp: 0.2, freq: 0.012, color: [40, 30, 78] },
      { base: 1.0, amp: 0.16, freq: 0.016, color: [18, 16, 42] },
    ],
  },
  { // 뭉게구름과 언덕
    sky: [[0, [96, 156, 226]], [0.75, [214, 232, 250]]],
    clouds: { cover: 0.52, until: 0.7, color: [255, 255, 255], shade: [214, 222, 238] },
    layers: [
      { base: 0.78, amp: 0.16, freq: 0.006, octaves: 3, color: [132, 182, 120], light: [176, 212, 146] },
      { base: 0.96, amp: 0.16, freq: 0.008, octaves: 3, color: [76, 136, 88], light: [118, 170, 108] },
    ],
  },
  { // 분홍빛 호수
    sky: [[0, [110, 90, 170]], [0.4, [236, 160, 182]], [0.62, [255, 212, 190]]],
    sun: { x: 0.4, y: 0.5, r: 22, color: [255, 240, 226], glow: [255, 196, 190], spread: 70, strength: 0.6 },
    layers: [
      { base: 0.62, amp: 0.22, freq: 0.01, color: [168, 112, 150] },
      { base: 0.68, amp: 0.12, freq: 0.015, color: [104, 70, 112] },
    ],
    water: 0.68, waterTint: [96, 72, 130],
  },
];

/** RGB 버퍼를 PNG로 감쌉니다. */
function png(width, height, rgb) {
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
  for (let y = 0; y < height; y += 1) rows.push(Buffer.from([0]), rgb.subarray(y * width * 3, (y + 1) * width * 3));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

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
// 글마다 첫 그림(보관함 카드)을 정해 두어 갤러리에서 같은 그림이 이웃하지 않게 합니다.
const firstScene = [0, 1, 4, 3, 2, 5, 4, 1];
posts.forEach(([id, channel, title, category, author], index) => {
  const channelName = channels.find(([slug]) => slug === channel)[1];
  const folder = `Links/${title}`;
  const files = {};
  const count = 1 + (index % 3);
  for (let n = 0; n < count; n += 1) {
        const name = `0${n + 1}.png`;
    mkdirSync(path.join(root, ...folder.split('/')), { recursive: true });
    writeFileSync(path.join(root, ...folder.split('/'), name), png(480, 360, scene(480, 360, scenes[(firstScene[index] + n) % scenes.length], index * 3 + n)));
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
