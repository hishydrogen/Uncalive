import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LoadedPage, PageSource, PageKind } from '../src/core/engine';
import { defaultOptions, type DownloadOptions } from '../src/core/options';

/** 아카라이브 페이지 구조를 줄여 담은 HTML 픽스처입니다. */
const fixtures = path.resolve(__dirname, 'fixtures');

export function fixture(name: string): string {
  return readFileSync(path.join(fixtures, `${name}.html`), 'utf8');
}

export function temporaryDirectory(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'uncalive-tests-'));
}

export function testOptions(destination: string): DownloadOptions {
  return { ...defaultOptions(destination), pageDelay: 0, mediaDelay: 0 };
}

export function exists(root: string, relative: string): boolean {
  return existsSync(path.join(root, ...relative.split('/')));
}

export function listing(folder: string): string[] {
  return readdirSync(folder).sort();
}

/** 게시글 페이지를 메모리에서 돌려주는 가짜 브라우저입니다. */
export class FakePageSource implements PageSource {
  readonly requests: string[] = [];
  archives = 0;

  constructor(private readonly pages: Record<string, LoadedPage>) {}

  async load(url: string, _kind: PageKind): Promise<LoadedPage> {
    const parsed = new URL(url);
    const key = parsed.pathname + parsed.search;
    this.requests.push(key);
    return this.pages[key] ?? { html: '', status: 404 };
  }

  async userAgent() { return 'TestAgent'; }

  async saveWebArchive(target: string) {
    this.archives += 1;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(target, 'archive');
  }
}

export interface StubResponse {
  status?: number;
  type?: string;
  body?: Uint8Array;
  etag?: string;
  supportsRanges?: boolean;
}

/** 네트워크 대신 응답을 돌려주는 fetch입니다. */
export class Stub {
  readonly requests: URL[] = [];
  readonly heads: URL[] = [];

  constructor(public handler: (url: URL) => StubResponse = () => ({})) {}

  install(handler: (url: URL) => StubResponse) {
    this.handler = handler;
    this.requests.length = 0;
    this.heads.length = 0;
  }

  readonly fetcher = async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const isHead = init.method === 'HEAD';
    (isHead ? this.heads : this.requests).push(url);
    const response = { status: 200, type: 'image/jpeg', body: new TextEncoder().encode('media'), ...this.handler(url) };
    const headers: Record<string, string> = { 'Content-Type': response.type, 'Content-Length': String(response.body.byteLength) };
    if (response.etag) headers.ETag = response.etag;

    let status = response.status;
    let body: Uint8Array = response.body;
    const range = (init.headers as Record<string, string> | undefined)?.Range;
    if (!isHead && response.supportsRanges && range) {
      const [start, end] = range.replace('bytes=', '').split('-').map(Number);
      body = response.body.subarray(start, end + 1);
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${response.body.byteLength}`;
      headers['Content-Length'] = String(body.byteLength);
    }
    const payload = isHead || [204, 304].includes(status) ? null : new Uint8Array(body);
    return new Response(payload, { status, headers });
  };
}

export function contentType(url: URL): StubResponse {
  const extension = url.pathname.split('.').pop();
  switch (extension) {
    case 'mp4': return { type: 'video/mp4' };
    case 'webp': return { type: 'image/webp' };
    case 'png': return { type: 'image/png' };
    default: return {};
  }
}
