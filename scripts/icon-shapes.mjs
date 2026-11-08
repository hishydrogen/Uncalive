// '언카' 글자 모양을 한곳에서 정합니다. 맥의 리퀴드 글래스 아이콘 층과 다른 운영체제용 평면 아이콘이 모두 이 모양을 씁니다.
// 1024 칸 기준이며, 굵기 하나(획)와 점 하나(짧은 획)로만 이루어집니다.

export const stroke = 64;
const half = stroke / 2;
const dot = 35;
const top = 300;
const bottom = 724;
const mid = 500;

// 모든 획을 채운 도형으로 그립니다. 애플의 아이콘 도구는 선(stroke)만 있는 도형을 예전 맥용 아이콘에서 잘못 채우기 때문입니다.
const n = (value) => Math.round(value * 10) / 10;

/** 끝이 둥근 가로나 세로 획입니다. */
function bar(x1, y1, x2, y2) {
  const x = Math.min(x1, x2) - half;
  const y = Math.min(y1, y2) - half;
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.abs(x2 - x1) + stroke)}" height="${n(Math.abs(y2 - y1) + stroke)}" rx="${half}" fill="#fff"/>`;
}

/** 가운데가 빈 고리입니다. */
function ring(cx, cy, r) {
  const outer = r + half;
  const inner = r - half;
  const circle = (radius) => `M${n(cx - radius)} ${n(cy)}a${radius} ${radius} 0 1 0 ${radius * 2} 0a${radius} ${radius} 0 1 0 ${-radius * 2} 0Z`;
  return `<path d="${circle(outer)}${circle(inner)}" fill="#fff" fill-rule="evenodd"/>`;
}

function disc(cx, cy, r) {
  return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${r}" fill="#fff"/>`;
}

/** 곧은 선과 곡선으로 이어진 중심선을 같은 굵기의 채운 도형으로 바꿉니다. 양 끝은 둥글게 맺습니다. */
function curvedStroke(points) {
  const left = [];
  const right = [];
  points.forEach(([x, y], index) => {
    const [px, py] = points[Math.max(index - 1, 0)];
    const [nx, ny] = points[Math.min(index + 1, points.length - 1)];
    const length = Math.hypot(nx - px, ny - py) || 1;
    const [ox, oy] = [(-(ny - py) / length) * half, ((nx - px) / length) * half];
    left.push([x + ox, y + oy]);
    right.push([x - ox, y - oy]);
  });
  const outline = [...left, ...right.reverse()].map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${n(x)} ${n(y)}`).join('') + 'Z';
  const [start, end] = [points[0], points[points.length - 1]];
  return `<path d="${outline}" fill="#fff"/>${disc(start[0], start[1], half)}${disc(end[0], end[1], half)}`;
}

/** 세로로 내려오다 왼쪽 아래로 휘는 ㅋ의 획입니다. */
function hook(x, y1, y2, endX, endY) {
  const points = [];
  for (let y = y1; y < y2; y += 8) points.push([x, y]);
  for (let step = 0; step <= 48; step += 1) {
    const t = step / 48;
    const qx = (1 - t) ** 2 * x + 2 * (1 - t) * t * x + t ** 2 * endX;
    const qy = (1 - t) ** 2 * y2 + 2 * (1 - t) * t * endY + t ** 2 * endY;
    points.push([qx, qy]);
  }
  return curvedStroke(points);
}

/** 글자 묶음 전체를 가운데로 옮기기 전의 좌표입니다. */
function layout(x0) {
  // 언: ㅇ(고리) · ㅓ(점) · 세로획, 아래에 ㄴ
  const ringR = 64;
  const ringX = x0 + ringR + half;
  const ringY = top + ringR + half;
  const eoDotX = ringX + ringR + half + 18 + dot;
  const eoBarX = eoDotX + dot + 18 + half;
  const nieunX = x0 + half;
  const nieunY = bottom - half;
  const un = [
    ring(ringX, ringY, ringR),
    disc(eoDotX, ringY, dot),
    bar(eoBarX, top + half, eoBarX, mid + 60),
    bar(nieunX, ringY + ringR + half + 44 + half, nieunX, nieunY),
    bar(nieunX, nieunY, eoBarX, nieunY),
  ];
  const unRight = eoBarX + half;

  // 카: ㅋ(꺾인 획과 안쪽 점) · 세로획 · ㅏ(점)
  const k0 = unRight + 60;
  const kLeft = k0 + half;
  const kCorner = kLeft + 104;
  const barX = kCorner + half + 26 + half;
  const ahDotX = barX + half + 18 + dot;
  const ka = [
    bar(kLeft, top + half, kCorner, top + half),
    hook(kCorner, top + half, mid + 20, kLeft, bottom - half),
    disc(kCorner - half - 16 - dot, mid, dot),
    bar(barX, top + half, barX, bottom - half),
    disc(ahDotX, mid, dot),
  ];
  return { un, ka, right: ahDotX + dot };
}

const first = layout(0);
/** 왼쪽 끝을 정해 묶음 전체가 가로 가운데에 오게 합니다. */
const shift = Math.round((1024 - first.right) / 2);
export const { un, ka } = layout(shift);

export const colors = {
  background: ['#6A5CFF', '#1B1590'],
  un: ['#FFFFFF', '#DCE4FF'],
  ka: ['#C9F0FF', '#6FB0FF'],
};

const layer = (shapes) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${shapes.join('')}</svg>\n`;
export const unLayer = layer(un);
export const kaLayer = layer(ka);

/** 유리 질감 없이 같은 모양과 색으로 그린 평면 아이콘입니다. */
export function flatIcon(radius = 230) {
  // 세로 획처럼 폭이 없는 모양에도 칠해지도록 그림 전체 좌표로 그라데이션을 정합니다.
  const gradient = (id, [from, to], y1 = 0, y2 = 1024) => `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${y1}" x2="0" y2="${y2}"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient>`;
  const paint = (shapes, id) => shapes.map((shape) => shape.replaceAll('"#fff"', `"url(#${id})"`)).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>${gradient('bg', colors.background)}${gradient('un', colors.un, top, bottom)}${gradient('ka', colors.ka, top, bottom)}</defs>
<rect width="1024" height="1024" rx="${radius}" fill="url(#bg)"/>
${paint(un, 'un')}${paint(ka, 'ka')}
</svg>\n`;
}
