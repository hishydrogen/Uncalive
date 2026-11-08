import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { beforeEach, describe, expect, test } from 'vitest';
import { RunControl } from '../src/core/control';
import { MediaDownloader } from '../src/core/downloader';
import { ScrapEngine, type EngineEvent, type LoadedPage } from '../src/core/engine';
import { loadLibrary, matches, snippet } from '../src/core/library';
import { Limiter } from '../src/core/limiter';
import { CancellationError, makeMedia, type ScrapEntry } from '../src/core/models';
import { DownloadQueue } from '../src/core/queue';
import { ResumeStore } from '../src/core/resume';
import { contentType, exists, FakePageSource, fixture, listing, Stub, temporaryDirectory, testOptions } from './support';

const stub = new Stub();
const noDelay = async () => {};
const downloader = (retryCount = 2) => new MediaDownloader({ fetcher: stub.fetcher, retryCount, retryDelay: noDelay });
const original = 'https://ac-o.arca.live/a.jpg';
const display = 'https://ac.arca.live/a.jpg';
const video = makeMedia('video', 'https://ac.arca.live/a.mp4', 'https://ac-o.arca.live/a.mp4');

/** 지정한 크기의 PNG를 만듭니다. */
function png(width: number, height: number): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 0;
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(width)])));
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]));
}

describe('파일 하나 받기', () => {
  test('형식에 맞는 확장자로 저장한다', async () => {
    const folder = temporaryDirectory();
    stub.install(() => ({ type: 'image/webp; charset=binary' }));
    const file = await downloader().download({ candidates: [original, display] }, folder, '01');
    expect(file.fileName).toBe('01.webp');
    expect(file.bytes).toBe(5);
    expect(file.usedOriginal).toBe(true);
    expect(listing(folder)).toEqual(['01.webp']);
  });

  test('원본이 없으면 표시용으로 대체한다', async () => {
    const folder = temporaryDirectory();
    stub.install((url) => (url.hostname === 'ac-o.arca.live' ? { status: 404 } : {}));
    const file = await downloader().download({ candidates: [original, display] }, folder, '01');
    expect(file.usedOriginal).toBe(false);
    expect(stub.requests).toHaveLength(2);
  });

  test('ETag가 같으면 CDN을 먼저 쓴다', async () => {
    stub.install(() => ({ type: 'video/mp4', etag: '"same"' }));
    const plan = await downloader().plan(video, 'original');
    expect(plan.identicalToOriginal).toBe(true);
    expect(new URL(plan.candidates[0]).hostname).toBe('ac.arca.live');
  });

  test('ETag가 다르면 원본 서버를 쓴다', async () => {
    stub.install((url) => ({ etag: url.hostname === 'ac.arca.live' ? '"small"' : '"big"' }));
    const plan = await downloader().plan(video, 'original');
    expect(plan.identicalToOriginal).toBeFalsy();
    expect(new URL(plan.candidates[0]).hostname).toBe('ac-o.arca.live');
  });

  test('원본 서버가 거부하면 원본 우선을 유지한다', async () => {
    stub.install((url) => (url.hostname === 'ac-o.arca.live' ? { status: 429 } : { etag: '"same"' }));
    const plan = await downloader().plan(video, 'original');
    expect(plan.identicalToOriginal).toBeFalsy();
    expect(new URL(plan.candidates[0]).hostname).toBe('ac-o.arca.live');
  });

  test('표시용 화질은 확인 요청을 보내지 않는다', async () => {
    stub.install(() => ({}));
    await downloader().plan(video, 'display');
    expect(stub.heads).toHaveLength(0);
  });

  test('큰 원본은 조각으로 받아 그대로 합친다', async () => {
    const folder = temporaryDirectory();
    const body = Uint8Array.from({ length: 2_500_000 }, (_, index) => index % 251);
    stub.install((url) => ({ type: 'video/mp4', body, etag: url.hostname === 'ac.arca.live' ? '"a"' : '"b"', supportsRanges: true }));
    const subject = downloader();
    const plan = await subject.plan(video, 'original');
    expect(plan.originalBytes).toBe(2_500_000);
    const file = await subject.download(plan, folder, '01');
    expect(Buffer.compare(readFileSync(path.join(folder, file.fileName)), Buffer.from(body))).toBe(0);
    expect(stub.requests).toHaveLength(3);
    expect(file.usedOriginal).toBe(true);
    expect(listing(folder)).toEqual(['01.mp4']);
  });

  test('나눠 받기를 거부하면 한 번에 받는다', async () => {
    const folder = temporaryDirectory();
    const body = new Uint8Array(2_500_000).fill(7);
    stub.install((url) => ({ type: 'video/mp4', body, etag: url.hostname === 'ac.arca.live' ? '"a"' : '"b"' }));
    const subject = downloader();
    const file = await subject.download(await subject.plan(video, 'original'), folder, '01');
    expect(file.bytes).toBe(2_500_000);
    expect(listing(folder)).toEqual(['01.mp4']);
  });

  test('축소된 원본을 받으면 다음 후보로 넘어간다', async () => {
    const folder = temporaryDirectory();
    stub.install(() => ({ type: 'image/png', body: png(1, 1) }));
    const file = await downloader().download({ candidates: [original, display], expectedLongSide: 100 }, folder, '01');
    expect(file.usedOriginal).toBe(false);
    expect(stub.requests.map((url) => url.hostname)).toEqual(['ac-o.arca.live', 'ac.arca.live']);
  });

  test('본문 크기와 가로세로가 뒤집힌 원본을 축소로 오해하지 않는다', async () => {
    const folder = temporaryDirectory();
    stub.install(() => ({ type: 'image/png', body: png(1, 2) }));
    const photo = makeMedia('image', display, original, 2, 1);
    const plan = await downloader().plan(photo, 'original');
    expect(plan.expectedLongSide).toBe(2);
    plan.candidates = [original, display];
    const file = await downloader().download(plan, folder, '01');
    expect(file.usedOriginal).toBe(true);
    expect(stub.requests).toHaveLength(1);
  });

  test('형식을 몰라도 내용으로 판별해 저장한다', async () => {
    const folder = temporaryDirectory();
    stub.install(() => ({ type: 'application/octet-stream', body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0]) }));
    expect((await downloader().download({ candidates: ['https://ac.arca.live/noext'] }, folder, '01')).fileName).toBe('01.png');
  });

  test('판별이 안 돼도 버리지 않는다', async () => {
    const folder = temporaryDirectory();
    stub.install(() => ({ type: 'application/x-unknown', body: new Uint8Array(32).fill(1) }));
    expect((await downloader().download({ candidates: ['https://ac.arca.live/a.xyz'] }, folder, '01')).fileName).toBe('01.xyz');
    expect((await downloader().download({ candidates: ['https://ac.arca.live/noext'] }, folder, '02')).fileName).toBe('02.bin');
  });

  test('빈 파일은 저장하지 않는다', async () => {
    const folder = temporaryDirectory();
    stub.install(() => ({ body: new Uint8Array() }));
    await expect(downloader(1).download({ candidates: [display] }, folder, '01')).rejects.toMatchObject({ code: 'incompleteFile' });
    expect(listing(folder)).toEqual([]);
  });

  test('내장 이미지를 파일로 푼다', async () => {
    const folder = temporaryDirectory();
    const url = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    expect((await downloader().download({ candidates: [url] }, folder, '01')).fileName).toBe('01.gif');
    expect(listing(folder)).toEqual(['01.gif']);
  });

  test('일시적 오류는 재시도한다', async () => {
    const folder = temporaryDirectory();
    let count = 0;
    stub.install(() => (++count < 3 ? { status: 503 } : {}));
    await downloader(3).download({ candidates: [display] }, folder, '01');
    expect(stub.requests).toHaveLength(3);
  });

  test('영구 오류는 재시도하지 않는다', async () => {
    const folder = temporaryDirectory();
    stub.install(() => ({ status: 403 }));
    await expect(downloader(3).download({ candidates: [display] }, folder, '01')).rejects.toMatchObject({ code: 'httpStatus', status: 403 });
    expect(stub.requests).toHaveLength(1);
  });

  test('오류 페이지를 이미지로 저장하지 않는다', async () => {
    const folder = temporaryDirectory();
    stub.install(() => ({ type: 'text/html' }));
    await expect(downloader().download({ candidates: [display] }, folder, '01')).rejects.toMatchObject({ code: 'unsupportedMedia' });
    expect(listing(folder)).toEqual([]);
  });
});

describe('연결 제한', () => {
  test('동시 실행 수를 넘지 않는다', async () => {
    const limiter = new Limiter(2);
    let current = 0;
    let peak = 0;
    await Promise.all(Array.from({ length: 20 }, () => limiter.withSlot(async () => {
      current += 1;
      peak = Math.max(peak, current);
      await new Promise((resolve) => setTimeout(resolve, 5));
      current -= 1;
    })));
    expect(peak).toBe(2);
  });

  test('급한 요청이 먼저 슬롯을 받는다', async () => {
    const limiter = new Limiter(1);
    const order: string[] = [];
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    const holder = limiter.withSlot(() => gate);
    const normal = limiter.withSlot(async () => { order.push('normal'); });
    const urgent = limiter.withSlot(async () => { order.push('urgent'); }, true);
    open();
    await Promise.all([holder, normal, urgent]);
    expect(order).toEqual(['urgent', 'normal']);
  });
});

describe('대기열', () => {
  const entry = (id: string): ScrapEntry => ({ id, channel: 'test', url: `https://arca.live/b/test/${id}`, title: `글 ${id}` });

  test('받는 중에 더한 글은 출처와 함께 뒤에 붙고 중복은 빠진다', () => {
    const queue = new DownloadQueue([entry('1'), entry('1'), entry('2')], '스크랩');
    expect(queue.totalPosts).toBe(2);
    expect(queue.nextBatch()?.entries.map((item) => item.id)).toEqual(['1', '2']);
    expect(queue.enqueue([entry('2'), entry('3')], '주소 수집')).toBe(1);
    expect(queue.queuedPosts).toBe(1);
    expect(queue.nextBatch()).toEqual({ entries: [entry('3')], source: '주소 수집' });
    expect(queue.nextBatch()).toBeUndefined();
    expect(queue.isClosed).toBe(true);
    expect(queue.enqueue([entry('4')], '스크랩')).toBe(0);
  });
});

describe('전체 흐름', () => {
  const site = (): Record<string, LoadedPage> => ({
    '/b/testchannel/4001': { html: fixture('post_comment_pages'), status: 200 },
    '/b/testchannel/4001?cp=1': { html: fixture('post_comment_page1'), status: 200 },
    '/b/testchannel?mode=best&p=1': { html: fixture('channel_list'), status: 200 },
    '/b/testchannel?mode=best&p=2': { html: fixture('scrap_list_empty'), status: 200 },
    '/u/scrap_list?p=1': { html: fixture('scrap_list_page1'), status: 200 },
    '/u/scrap_list?p=2': { html: fixture('scrap_list_page2'), status: 200 },
    '/b/testchannel/1001': { html: fixture('post_full'), status: 200 },
    '/b/testchannel/1002': { html: fixture('post_no_media'), status: 200 },
  });
  const engine = (source: FakePageSource, sleep: (seconds: number) => Promise<void> = noDelay) =>
    new ScrapEngine(source, { fetcher: stub.fetcher, sleep, retryDelay: noDelay });
  const folder = '첫 번째_ 글_제목';
  const onePage = (root: string) => ({ ...testOptions(root), pages: { first: 1, last: 1 } });

  beforeEach(() => stub.install(contentType));

  test('파일과 보관본을 만든다', async () => {
    const root = temporaryDirectory();
    const summary = await engine(new FakePageSource(site())).run(testOptions(root));
    expect(summary.postsFound).toBe(3);
    expect(summary.postsCompleted).toBe(2);
    expect(summary.postsFailed).toBe(1); // 픽스처에 없는 2001번 글은 404입니다.
    for (const file of ['01.jpg', '02.mp4', '03.png', 'index.html', 'post.json', 'assets']) expect(exists(root, `${folder}/${file}`)).toBe(true);
    expect(stub.requests.some((url) => url.hostname === 'ac-o.arca.live' && url.pathname === '/2026/photo.jpg')).toBe(true);
    // 맥판이 읽을 수 있도록 소수점 없는 날짜를 씁니다.
    const state = JSON.parse(readFileSync(path.join(root, '.uncalive', 'state.json'), 'utf8'));
    expect(state.posts['1001'].updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  test('다시 실행해도 폴더를 늘리지 않고 건너뛴다', async () => {
    const root = temporaryDirectory();
    await engine(new FakePageSource(site())).run(testOptions(root));
    const before = listing(root);
    const requests = stub.requests.length;
    const second = new FakePageSource(site());
    const summary = await engine(second).run(testOptions(root));
    expect(summary.postsSkipped).toBe(2);
    expect(stub.requests).toHaveLength(requests);
    expect(second.requests).not.toContain('/b/testchannel/1001');
    expect(listing(root)).toEqual(before);
  });

  test('실패한 파일만 이어서 받는다', async () => {
    const root = temporaryDirectory();
    stub.install((url) => (url.pathname.endsWith('.mp4') ? { status: 500 } : contentType(url)));
    const first = await engine(new FakePageSource(site())).run(testOptions(root));
    expect(first.postsIncomplete).toBe(1);
    expect(first.mediaFailed).toBe(1);

    stub.install(contentType);
    const second = await engine(new FakePageSource(site())).run(testOptions(root));
    expect(second.mediaSaved).toBe(1);
    expect(second.mediaReused).toBeGreaterThan(0);
    expect(stub.requests.every((url) => url.pathname.endsWith('.mp4'))).toBe(true);
    expect(exists(root, `${folder}/02.mp4`)).toBe(true);
    expect(exists(root, `${folder}_1`)).toBe(false);
  });

  test('제목이 같은 다른 글은 번호를 붙인다', async () => {
    const store = await ResumeStore.open(temporaryDirectory());
    const post = (id: string) => ({ id, channel: 'c', url: `https://arca.live/b/c/${id}`, title: '같은 제목', contentHTML: '', media: [], comments: [], embeds: [], commentPages: 1 });
    expect(store.reserveFolder(post('1'), '같은 제목')).toBe('같은 제목');
    expect(store.reserveFolder(post('2'), '같은 제목')).toBe('같은 제목_1');
    expect(store.reserveFolder(post('1'), '같은 제목')).toBe('같은 제목');
  });

  test('미디어가 없는 글 뒤에도 대기한다', async () => {
    const delays: number[] = [];
    await engine(new FakePageSource(site()), async (seconds) => { delays.push(seconds); }).run({ ...onePage(temporaryDirectory()), pageDelay: 7 });
    expect(delays.filter((value) => value === 7)).toHaveLength(1);
  });

  test('같은 파일은 원본 서버에서 내려받지 않는다', async () => {
    const root = temporaryDirectory();
    stub.install((url) => ({ ...contentType(url), etag: `"${url.pathname.split('/').pop()}"` }));
    await engine(new FakePageSource(site())).run(onePage(root));
    expect(stub.requests.every((url) => url.hostname !== 'ac-o.arca.live')).toBe(true);
    expect(exists(root, `${folder}/02.mp4`)).toBe(true);
  });

  test('원본 대신 표시용을 받으면 경고하고 다음 실행에서 원본을 다시 받는다', async () => {
    const root = temporaryDirectory();
    stub.install((url) => (url.hostname === 'ac-o.arca.live' ? { status: 404 } : contentType(url)));
    const warnings: string[] = [];
    const first = await engine(new FakePageSource(site())).run(onePage(root), undefined, (event) => {
      if (event.type === 'warning' && event.text.includes('표시용')) warnings.push(event.text);
    });
    expect(warnings).toHaveLength(2); // 이미지와 동영상
    expect(first.postsIncomplete).toBe(1);

    stub.install(contentType);
    await engine(new FakePageSource(site())).run(onePage(root));
    expect(stub.requests.some((url) => url.hostname === 'ac-o.arca.live' && url.pathname === '/2026/photo.jpg')).toBe(true);
  });

  test('균형 화질은 작은 이미지를 CDN에서 받는다', async () => {
    const summary = await engine(new FakePageSource(site())).run({ ...onePage(temporaryDirectory()), quality: 'balanced' });
    expect(summary.postsIncomplete).toBe(0);
    expect(stub.requests.some((url) => url.hostname === 'ac.arca.live' && url.pathname === '/2026/photo.jpg')).toBe(true);
    expect(stub.requests.some((url) => url.hostname === 'ac-o.arca.live' && url.pathname === '/2026/clip.mp4')).toBe(true);
  });

  test('나뉜 댓글을 모두 모아 순서대로 저장한다', async () => {
    const root = temporaryDirectory();
    stub.install((url) => (url.pathname.endsWith('.mp3') ? { type: 'audio/mpeg' } : contentType(url)));
    const source = new FakePageSource(site());
    const entry: ScrapEntry = { id: '4001', channel: 'testchannel', url: 'https://arca.live/b/testchannel/4001', title: 't' };
    const warnings: EngineEvent[] = [];
    const summary = await engine(source).download([entry], testOptions(root), undefined, (event) => {
      if (event.type === 'warning' && event.text.includes('임베드')) warnings.push(event);
    });
    expect(summary.postsCompleted).toBe(1);
    expect(warnings).toHaveLength(1);
    expect(source.requests).toContain('/b/testchannel/4001?cp=1');
    const html = readFileSync(path.join(root, '댓글 많은 글', 'index.html'), 'utf8');
    expect(html.indexOf('첫 페이지 댓글')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('첫 페이지 댓글')).toBeLessThan(html.indexOf('마지막 페이지 댓글'));
    expect(html).toContain('<audio');
    expect(html).not.toContain('[저장되지 않은');
    expect(exists(root, '댓글 많은 글/01.mp3')).toBe(true);
    expect(exists(root, '댓글 많은 글/03.gif')).toBe(true);
  });

  test('지정한 목록을 범위만큼만 읽는다', async () => {
    const source = new FakePageSource(site());
    const entries = await engine(source).fetchList('https://arca.live/b/testchannel?mode=best', { firstPage: 1, lastPage: 1 }, 0);
    expect(entries.map((entry) => entry.id)).toEqual(['3001', '3002']);
    expect(entries[0].channelName).toBeUndefined();
    expect(entries[0].category).toBe('일반');
    expect(source.requests).toEqual(['/b/testchannel?mode=best&p=1']);
  });

  test('마지막 페이지 뒤의 404를 로그아웃으로 오해하지 않는다', async () => {
    const source = new FakePageSource({ '/u/scrap_list?p=1': { html: fixture('scrap_list_page1'), status: 200 } });
    const entries = await engine(source).fetchScraps(testOptions(temporaryDirectory()));
    expect(entries.map((entry) => entry.id)).toEqual(['1001', '1002']);
    expect(source.requests).toEqual(['/u/scrap_list?p=1', '/u/scrap_list?p=2']);
  });

  test('한 페이지가 넘는 새 스크랩도 찾고, 아는 글이 나오면 멈춘다', async () => {
    let source = new FakePageSource(site());
    expect((await engine(source).fetchNewScraps(new Set(['2001']), testOptions(temporaryDirectory()))).map((entry) => entry.id)).toEqual(['1001', '1002']);
    expect(source.requests).toEqual(['/u/scrap_list?p=1', '/u/scrap_list?p=2']);
    source = new FakePageSource(site());
    expect((await engine(source).fetchNewScraps(new Set(['1002']), testOptions(temporaryDirectory()))).map((entry) => entry.id)).toEqual(['1001']);
    expect(source.requests).toEqual(['/u/scrap_list?p=1']);
  });

  test('끝까지 읽으면 글이 없는 페이지에서 멈추고, 기준일보다 오래된 글을 뺀다', async () => {
    let source = new FakePageSource(site());
    expect(await engine(source).fetchList('https://arca.live/b/testchannel?mode=best', { firstPage: 1 }, 0)).toHaveLength(2);
    expect(source.requests).toHaveLength(2);
    source = new FakePageSource(site());
    const recent = await engine(source).fetchList('https://arca.live/b/testchannel?mode=best', { firstPage: 1, since: '2026-01-01T00:00:00Z' }, 0);
    expect(recent.map((entry) => entry.id)).toEqual(['3001']);
  });

  test('출처별 폴더에 저장하고, 양쪽 목록에 있는 글은 처음 폴더에만 둔다', async () => {
    const root = temporaryDirectory();
    await engine(new FakePageSource(site())).run({ ...onePage(root), source: '주소 수집', skipCompleted: false });
    expect(exists(root, `주소 수집/${folder}/01.jpg`)).toBe(true);
    const before = stub.requests.length;
    const summary = await engine(new FakePageSource(site())).run({ ...onePage(root), source: '스크랩', skipCompleted: false });
    expect(summary.mediaReused).toBeGreaterThan(0);
    expect(stub.requests).toHaveLength(before);
    expect(exists(root, '스크랩')).toBe(false);
    const posts = await loadLibrary(root);
    expect(posts).toHaveLength(2);
    expect(posts.every((post) => post.source === '주소 수집')).toBe(true);
  });

  test('지운 폴더와 파일을 기록에서 빼고, 다시 받으면 같은 자리에 복구한다', async () => {
    const root = temporaryDirectory();
    await engine(new FakePageSource(site())).run({ ...onePage(root), skipCompleted: false });
    rmSync(path.join(root, '두 번째 글'), { recursive: true });
    rmSync(path.join(root, folder, '01.jpg'));
    const records = (await ResumeStore.open(root)).liveRecords();
    expect(records.map((record) => record.id)).toEqual(['1001']);
    expect(records[0].completed).toBe(false);
    expect(Object.values(records[0].files)).not.toContain('01.jpg');
    expect((await loadLibrary(root)).map((post) => post.record.id)).toEqual(['1001']);

    rmSync(path.join(root, folder), { recursive: true });
    await engine(new FakePageSource(site())).run({ ...onePage(root), skipCompleted: false });
    expect(exists(root, `${folder}/01.jpg`)).toBe(true);
    expect(exists(root, `${folder}_1`)).toBe(false);
  });

  test('보관함이 글 정보와 본문을 찾는다', async () => {
    const root = temporaryDirectory();
    await engine(new FakePageSource(site())).run(onePage(root));
    const item = (await loadLibrary(root)).find((post) => post.record.id === '1001')!;
    expect(item.channel).toBe('testchannel');
    expect(item.channelName).toBe('테스트');
    expect(item.category).toBe('유머');
    expect(item.author).toBe('작성자A');
    expect(matches(item, '본문 글자')).toBe(true);
    expect(matches(item, '댓글러')).toBe(true);
    expect(snippet(item, '본문')).toContain('본문');
  });

  test('맥판으로 받은 보관함도 읽는다', async () => {
    const root = temporaryDirectory();
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(path.join(root, '옛글'), { recursive: true });
    mkdirSync(path.join(root, '.uncalive'), { recursive: true });
    writeFileSync(path.join(root, '.uncalive', 'state.json'), '{"version":1,"posts":{"7":{"id":"7","folder":"옛글","title":"옛 제목","completed":true,"files":{},"updatedAt":"2026-01-01T00:00:00Z"}}}');
    writeFileSync(path.join(root, '옛글', 'post.json'), '{"channel":"oldch","category":"질문","author":"글쓴이"}');
    writeFileSync(path.join(root, '옛글', 'index.html'), '<html><body><p>옛날 본문</p></body></html>');
    const item = (await loadLibrary(root))[0];
    expect(item.channel).toBe('oldch');
    expect(item.category).toBe('질문');
    expect(matches(item, '옛날 본문')).toBe(true);
    expect(exists(root, '.uncalive/text/7.txt')).toBe(true);
  });

  test('고른 글만 받는다', async () => {
    const root = temporaryDirectory();
    const source = new FakePageSource(site());
    const all = await engine(source).fetchScraps(testOptions(root));
    expect(all.map((entry) => entry.id)).toEqual(['1001', '1002', '2001']);
    const summary = await engine(source).download([all[1]], testOptions(root));
    expect(summary.postsCompleted).toBe(1);
    expect(source.requests).not.toContain('/b/testchannel/1001');
    expect(exists(root, '두 번째 글/index.html')).toBe(true);
  });

  test('로그아웃 상태면 바로 멈춘다', async () => {
    const root = temporaryDirectory();
    await expect(engine(new FakePageSource({})).run(testOptions(root))).rejects.toMatchObject({ code: 'loginRequired' });
    const loggedOut = new FakePageSource({ '/u/scrap_list?p=1': { html: fixture('logged_out'), status: 200 } });
    await expect(engine(loggedOut).run(testOptions(root))).rejects.toMatchObject({ code: 'loginRequired' });
  });

  test('옵션대로 종류를 거르고 보관본을 끈다', async () => {
    const root = temporaryDirectory();
    const options = onePage(root);
    await engine(new FakePageSource(site())).run({
      ...options, includeVideos: false, quality: 'display',
      archive: { ...options.archive, offlineHTML: false, metadataJSON: false, webArchive: true },
    });
    expect(stub.requests.every((url) => !url.pathname.endsWith('.mp4') && url.hostname !== 'ac-o.arca.live')).toBe(true);
    expect(exists(root, `${folder}/index.html`)).toBe(false);
    expect(exists(root, `${folder}/page.mhtml`)).toBe(true);
    expect(exists(root, `${folder}/assets`)).toBe(false);
  });

  test('일시정지하면 멈췄다가 재개하면 끝까지 받는다', async () => {
    const source = new FakePageSource(site());
    const control = new RunControl();
    control.pause();
    const task = engine(source).run(onePage(temporaryDirectory()), control);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(source.requests).toEqual([]);
    control.resume();
    expect((await task).postsCompleted).toBe(2);
  });

  test('취소하면 바로 멈추고 다음 실행에서 이어간다', async () => {
    const root = temporaryDirectory();
    const control = new RunControl();
    const cancelling = engine(new FakePageSource(site()), async () => {
      control.cancel();
      throw new CancellationError();
    });
    await expect(cancelling.run(testOptions(root), control)).rejects.toBeInstanceOf(CancellationError);
    const summary = await engine(new FakePageSource(site())).run(testOptions(root));
    expect(summary.postsCompleted + summary.postsSkipped).toBe(2);
  });
});
