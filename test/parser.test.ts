import { describe, expect, test } from 'vitest';
import { render } from '../src/core/archiver';
import { csvData, csvEscape } from '../src/core/library';
import { candidates, makeMedia, prefersOriginal, mediaKey, type ParsedPost } from '../src/core/models';
import { baseName, sanitize } from '../src/core/naming';
import { listURL, parsePost, parseScrapList, parseTargets } from '../src/core/parser';
import { fixture } from './support';

const postURL = 'https://arca.live/b/testchannel/1001';
const host = (url: string | undefined) => (url ? new URL(url).hostname : undefined);

describe('parser', () => {
  test('목록에서 머리글과 중복을 제외한다', () => {
    const page = parseScrapList(fixture('scrap_list_page1'));
    expect(page.entries.map((entry) => entry.id)).toEqual(['1001', '1002']);
    expect(page.entries[0].url).toBe('https://arca.live/b/testchannel/1001');
    expect(page.entries[0].title).toBe('첫 번째 글');
    expect(page.entries[0].author).toBe('작성자A');
    expect(page.entries[0].channelName).toBe('테스트');
    expect(page.entries[0].category).toBe('질문');
    expect(page.highestVisiblePage).toBe(2);
    expect(page.isLoggedIn).toBe(true);
    expect(page.username).toBe('테스트유저');
  });

  test('빈 목록과 로그아웃을 구분한다', () => {
    const empty = parseScrapList(fixture('scrap_list_empty'));
    expect(empty.entries).toEqual([]);
    expect(empty.isLoggedIn).toBe(true);
    expect(parseScrapList(fixture('logged_out')).isLoggedIn).toBe(false);
  });

  test('게시글 정보를 읽는다', () => {
    const post = parsePost(fixture('post_full'), postURL);
    expect(post.id).toBe('1001');
    expect(post.channel).toBe('testchannel');
    expect(post.title).toBe('첫 번째: 글/제목');
    expect(post.category).toBe('유머');
    expect(post.author).toBe('작성자A');
    expect(post.createdAt).toBe('2026-11-06T02:39:52.000Z');
  });

  test('미디어를 본문 순서와 종류대로 읽는다', () => {
    const post = parsePost(fixture('post_full'), postURL);
    expect(post.media.map((media) => media.kind)).toEqual(['image', 'poster', 'video', 'image', 'emoticon']);
    expect(host(post.media[0].originalURL)).toBe('ac-o.arca.live');
    expect(post.media[0].displayURL.startsWith('https:')).toBe(true);
  });

  test('원본 주소를 먼저 시도한다', () => {
    const image = parsePost(fixture('post_full'), postURL).media[0];
    expect(candidates(image, 'original').map(host)).toEqual(['ac-o.arca.live', 'ac.arca.live']);
    expect(candidates(image, 'display').map(host)).toEqual(['ac.arca.live']);
  });

  test('원본 속성이 없으면 type=orig로 대체하되 외부 주소는 건드리지 않는다', () => {
    const arca = makeMedia('image', 'https://ac.arca.live/a.jpg?key=1');
    expect(candidates(arca, 'original')[0]).toContain('type=orig');
    const outside = makeMedia('image', 'https://example.com/a.jpg');
    expect(candidates(outside, 'original')).toHaveLength(1);
  });

  test('원본 가로 크기를 읽는다', () => {
    expect(parsePost(fixture('post_full'), postURL).media[0].width).toBe(10);
  });

  const image = (file: string, width?: number) => makeMedia('image', `https://ac.arca.live/${file}`, `https://ac-o.arca.live/${file}`, width);

  test('균형 화질은 축소되는 이미지만 원본으로 받는다', () => {
    expect(prefersOriginal(image('a.jpg', 1280), 'balanced')).toBe(false);
    expect(host(candidates(image('a.png', 800), 'balanced')[0])).toBe('ac.arca.live');
    expect(prefersOriginal(image('a.jpg', 1281), 'balanced')).toBe(true);
    expect(host(candidates(image('a.jpg', 2508), 'balanced')[0])).toBe('ac-o.arca.live');
  });

  test('균형 화질은 확신이 없으면 원본을 택한다', () => {
    expect(prefersOriginal(image('a.jpg'), 'balanced')).toBe(true);
    expect(prefersOriginal(image('a.gif', 300), 'balanced')).toBe(true);
    expect(prefersOriginal(makeMedia('video', 'https://ac.arca.live/a.mp4', undefined, 300), 'balanced')).toBe(true);
  });

  test('지연 로딩과 오디오와 내장 이미지를 놓치지 않는다', () => {
    const post = parsePost(fixture('post_comment_pages'), postURL);
    expect(post.media.map((media) => media.kind)).toEqual(['audio', 'image', 'image']);
    expect(post.media[1].displayURL.split('?')[0].endsWith('lazy.jpg')).toBe(true);
    expect(post.media[2].displayURL.startsWith('data:')).toBe(true);
    expect(post.media[2].key.length).toBeLessThan(80);
  });

  test('외부 임베드와 댓글 페이지 수를 읽는다', () => {
    const post = parsePost(fixture('post_comment_pages'), postURL);
    expect(post.embeds.map(host)).toEqual(['www.youtube.com']);
    expect(post.commentPages).toBe(2);
  });

  test('채널 목록에서 공지를 뺀다', () => {
    const page = parseScrapList(fixture('channel_list'));
    expect(page.entries.map((entry) => entry.id)).toEqual(['3001', '3002']);
    expect(page.highestVisiblePage).toBe(2);
    expect(page.entries[0].createdAt).toBeDefined();
  });

  test('붙여 넣은 주소를 구분한다', () => {
    const targets = parseTargets(`https://arca.live/b/test/123?p=1#c_9 다른글자 https://example.com/b/test/5
arca.live/b/test/123
https://arca.live/b/test?mode=best
http://arca.live/b/test/9`);
    expect(targets).toHaveLength(2);
    expect(targets[0].type === 'post' && targets[0].entry.url).toBe('https://arca.live/b/test/123');
    expect(targets[1]).toEqual({ type: 'list', url: 'https://arca.live/b/test?mode=best' });
  });

  test('목록 주소의 조건을 유지하며 페이지를 바꾼다', () => {
    expect(listURL('https://arca.live/b/test?mode=best&p=3', 2)).toBe('https://arca.live/b/test?mode=best&p=2');
  });

  test('미디어 키는 서명이 바뀌어도 같다', () => {
    expect(mediaKey('https://ac.arca.live/a.jpg?expires=1&key=x')).toBe(mediaKey('https://ac.arca.live/a.jpg?expires=2&key=y'));
  });

  test('댓글과 답글 깊이를 읽는다', () => {
    const post = parsePost(fixture('post_full'), postURL);
    expect(post.comments.map((comment) => comment.id)).toEqual(['11', '12']);
    expect(post.comments.map((comment) => comment.depth)).toEqual([0, 1]);
    expect(post.comments[0].messageHTML).not.toContain('펼쳐보기');
    expect(post.comments[1].media[0]?.kind).toBe('emoticon');
  });

  test('본문이 없으면 오류를 낸다', () => {
    expect(() => parsePost('<html><body></body></html>', postURL)).toThrow('본문');
  });
});

describe('CSV', () => {
  test('쉼표와 따옴표와 줄바꿈을 감싼다', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('그는 "네"')).toBe('"그는 ""네"""');
    expect(csvEscape('평범한 제목')).toBe('평범한 제목');
  });

  test('수식으로 실행되지 않게 막는다', () => {
    expect(csvEscape('=HYPERLINK(1)')).toBe("'=HYPERLINK(1)");
    expect(csvEscape('@cmd')).toBe("'@cmd");
  });

  test('엑셀용 BOM을 붙인다', () => {
    const data = csvData([['제목'], ['글']]);
    expect([...data.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(data.subarray(3).toString('utf8')).toBe('제목\r\n글\r\n');
  });
});

describe('파일 이름', () => {
  test('금지 문자와 앞뒤 공백 점을 정리한다', () => {
    expect(sanitize(' ..a/b:c*d?"e<f>g|h\\i.. ', 80)).toBe('a_b_c_d__e_f_g_h_i');
  });

  test('잘린 뒤에도 끝에 공백이나 점이 남지 않는다', () => {
    expect(sanitize('abc .def', 5)).toBe('abc');
  });

  test('긴 한글 이름도 바이트 제한을 지킨다', () => {
    expect(Buffer.byteLength(sanitize('가'.repeat(300), 300))).toBeLessThanOrEqual(200);
  });

  test('분해된 한글을 결합형으로 맞춘다', () => {
    expect(sanitize('한글'.normalize('NFD'), 10)).toBe('한글');
  });

  test('Windows 예약 이름을 피한다', () => {
    expect(sanitize('CON', 10)).toBe('_CON');
    expect(sanitize('nul.txt', 10)).toBe('_nul.txt');
  });

  test('순번은 전체 개수에 맞춰 자리를 맞춘다', () => {
    const media = makeMedia('image', 'https://a.test/' + encodeURIComponent('원본') + '.jpg');
    expect(baseName(3, 9, media, 'sequence')).toBe('03');
    expect(baseName(3, 120, media, 'sequence')).toBe('003');
    expect(baseName(3, 9, media, 'sequenceAndOriginalName')).toBe('03_원본');
  });
});

describe('오프라인 페이지', () => {
  const allPaths = {
    'ac.arca.live/2026/photo.jpg': '01.jpg',
    'ac.arca.live/2026/clip.mp4': '02.mp4',
    'ac.arca.live/2026/clip.thumbnail.webp': 'assets/poster.webp',
    'example.com/outside.png': '03.png',
    'ac.arca.live/2022/emo.png': 'assets/emo.png',
    'ac.arca.live/2023/cemo.png': 'assets/cemo.png',
  };
  const rendered = (paths: Record<string, string>) => render(parsePost(fixture('post_full'), postURL), paths, true);

  test('받은 파일을 로컬 경로로 연결한다', () => {
    const html = rendered(allPaths);
    expect(html).toContain('src="01.jpg"');
    expect(html).toContain('src="02.mp4"');
    expect(html).toContain('poster="assets/poster.webp"');
    expect(html).toContain('src="assets/cemo.png"');
  });

  test('서명 주소와 스크립트가 남지 않는다', () => {
    const html = rendered(allPaths);
    expect(html).not.toContain('expires=');
    expect(html).not.toContain('ac-o.arca.live');
    expect(html).not.toContain('alert(');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<iframe');
    expect(html).toContain('https://www.youtube.com/embed/abc');
    expect(html).toContain('href="https://arca.live/b/testchannel/1002"');
  });

  test('받지 않은 미디어는 안내문으로 바꾼다', () => {
    const html = rendered({});
    expect(html).toContain('[저장되지 않은 이미지]');
    expect(html).toContain('[저장되지 않은 동영상]');
    expect(html).not.toContain('<img');
  });

  test('제목의 HTML을 이스케이프한다', () => {
    const post: ParsedPost = { id: '1', channel: 'c', url: postURL, title: '<b>제목</b>', contentHTML: '', media: [], comments: [], embeds: [], commentPages: 1 };
    expect(render(post, {}, false)).toContain('&lt;b&gt;제목');
  });

  test('한글 본문을 글자 그대로 남긴다', () => {
    expect(rendered(allPaths)).toContain('본문');
  });
});
