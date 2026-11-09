// 언카라이브 아이콘 도형 정의 (1024x1024 기준)
// - 전체 좌우 범위: 212 .. 812 (폭 600px, 좌우 여백 각 212px -> 가로 정중앙 512.0)
// - 전체 상하 범위: 184 .. 840 (높이 656px, 상하 여백 각 184px -> 세로 정중앙 512.0)
// - 획 두께: 74px, 정원 반지름: 62px (지름 124px)
// - 좌측 원 cx = 274 (212..336), 우측 원 cx = 750 (688..812)
// - 상단 원 cy = 324 (262..386), 하단 원 cy = 618 (556..680)
// - 좌측 ㄱ자 가로획: x = 212..474, y = 434..508 (상하단 원과 각각 48px 등간격)
// - 좌측 ㄱ자 세로획: x = 400..474 (좌측 원과 64px 간격), 하단 y = 680 (하단 원 바닥 680과 베이스라인 일치)
// - 우측 화살표 기둥: x = 550..624 (중심 587, ㄱ자 세로획과 76px 간격, 우측 원과 64px 간격)
// - 우측 화살표 날개: 어깨 y = 710 (베이스라인 680 아래 30px 여백), 폭 x = 478..696, 끝점 (587, 840)

export const colors = {
  background: ['#5B4FF0', '#31298E', '#14113F'],
  arca: ['#FFFFFF', '#E2EBFF'],
  arrow: ['#E6FDFF', '#67E8F9', '#38BDF8'],
};

/** 좌우 대칭 4개 정원 (상단 2개, 하단 2개) */
export const topDots = [
  '<circle cx="274" cy="324" r="62" fill="#fff"/>',
  '<circle cx="750" cy="324" r="62" fill="#fff"/>',
];

export const bottomDots = [
  '<circle cx="274" cy="618" r="62" fill="#fff"/>',
  '<circle cx="750" cy="618" r="62" fill="#fff"/>',
];

export const dotsShapes = [...topDots, ...bottomDots];

/** 좌측 ㄱ자 모티프 (외곽 코너 r=18, 내측 코너 r=12 필렛) */
export const motifShape = '<path d="M230 434H456A18 18 0 0 1 474 452V662A18 18 0 0 1 456 680H418A18 18 0 0 1 400 662V520A12 12 0 0 0 388 508H230A18 18 0 0 1 212 490V452A18 18 0 0 1 230 434Z" fill="#fff"/>';

/** 우측 다운로드 화살표 기둥 (상단 코너 r=18, 기둥-날개 연결부 r=10 오목 필렛, 날개 끝 r=15, 촉 끝 r=17.5) */
export const arrowShape = '<path d="M568 184H606A18 18 0 0 1 624 202V700A10 10 0 0 0 634 710H681A15 15 0 0 1 692.6 734.5L599.6 834.5A17.5 17.5 0 0 1 574.4 834.5L481.4 734.5A15 15 0 0 1 493 710H540A10 10 0 0 0 550 700V202A18 18 0 0 1 568 184Z" fill="#fff"/>';

const wrapLayer = (shapes) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${shapes.join('')}</svg>\n`;

// 맥 리퀴드 글래스 아이콘(resources/AppIcon.icon)의 층 그림입니다. 층마다 따로 유리가 되고 색은 icon.json에서 칠합니다.
export const glassLayers = {
  'top-dots.svg': wrapLayer(topDots),
  'bottom-dots.svg': wrapLayer(bottomDots),
  'motif.svg': wrapLayer([motifShape]),
  'arrow.svg': wrapLayer([arrowShape]),
};

/** 유리 질감 없이 같은 조형과 색감으로 그린 크로스플랫폼 평면 아이콘입니다. */
export function flatIcon(radius = 228) {
  const paint = (shape, id) => shape.replaceAll('"#fff"', `"url(#${id})"`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
  <linearGradient id="bg" x1="160" y1="0" x2="864" y2="1024" gradientUnits="userSpaceOnUse">
    <stop offset="0%" stop-color="${colors.background[0]}"/>
    <stop offset="52%" stop-color="${colors.background[1]}"/>
    <stop offset="100%" stop-color="${colors.background[2]}"/>
  </linearGradient>
  <radialGradient id="glow" cx="360" cy="100" r="660" gradientUnits="userSpaceOnUse">
    <stop offset="0%" stop-color="#818CF8" stop-opacity="0.30"/>
    <stop offset="100%" stop-color="#818CF8" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="topDotGrad" x1="0" y1="262" x2="0" y2="386" gradientUnits="userSpaceOnUse">
    <stop offset="0%" stop-color="${colors.arca[0]}"/>
    <stop offset="100%" stop-color="${colors.arca[1]}"/>
  </linearGradient>
  <linearGradient id="bottomDotGrad" x1="0" y1="556" x2="0" y2="680" gradientUnits="userSpaceOnUse">
    <stop offset="0%" stop-color="${colors.arca[0]}"/>
    <stop offset="100%" stop-color="${colors.arca[1]}"/>
  </linearGradient>
  <linearGradient id="motifGrad" x1="0" y1="434" x2="0" y2="680" gradientUnits="userSpaceOnUse">
    <stop offset="0%" stop-color="${colors.arca[0]}"/>
    <stop offset="100%" stop-color="${colors.arca[1]}"/>
  </linearGradient>
  <linearGradient id="arrowGrad" x1="0" y1="184" x2="0" y2="840" gradientUnits="userSpaceOnUse">
    <stop offset="0%" stop-color="${colors.arrow[0]}"/>
    <stop offset="46%" stop-color="${colors.arrow[1]}"/>
    <stop offset="100%" stop-color="${colors.arrow[2]}"/>
  </linearGradient>
</defs>
<rect width="1024" height="1024" rx="${radius}" fill="url(#bg)"/>
<rect width="1024" height="1024" rx="${radius}" fill="url(#glow)"/>
<rect x="3" y="3" width="1018" height="1018" rx="${radius - 3}" fill="none" stroke="#FFFFFF" stroke-opacity="0.15" stroke-width="6"/>
${topDots.map((s) => paint(s, 'topDotGrad')).join('')}
${bottomDots.map((s) => paint(s, 'bottomDotGrad')).join('')}
${paint(motifShape, 'motifGrad')}
${paint(arrowShape, 'arrowGrad')}
</svg>\n`;
}
