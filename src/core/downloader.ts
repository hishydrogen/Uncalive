import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { imageSize } from 'image-size';
import { sleep } from './control';
import { Limiter } from './limiter';
import { CancellationError, candidates, pathExtension, prefersOriginal, UncaliveError, type MediaRef, type Quality } from './models';

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;
export type Progress = (received: number, expected: number) => void;

export interface DownloadedFile {
  fileName: string;
  bytes: number;
  usedOriginal: boolean;
  /** 앞선 후보가 실패해 대체했을 때의 사유입니다. */
  fallbackReason?: string;
}

/** 파일 하나를 어디서 어떻게 받을지 정한 결과입니다. */
export interface DownloadPlan {
  candidates: string[];
  /** CDN 파일이 원본과 같은 파일인지 ETag로 확인했는지 나타냅니다. */
  identicalToOriginal?: boolean;
  /** 원본 서버가 알려 준 파일 크기입니다. 큰 파일을 조각으로 받을 때 씁니다. */
  originalBytes?: number;
  /** 받은 이미지의 긴 변이 이보다 짧으면 서버가 축소한 것으로 봅니다. 가로세로가 뒤바뀔 수 있어 긴 변끼리 비교합니다. */
  expectedLongSide?: number;
}

/** 원본 서버는 IP당 동시 연결 2개를 넘으면 429로 거부합니다. 서버가 정한 한도이므로 설정으로 늘리지 않습니다. */
export const originConnectionLimit = 2;
/** 이보다 큰 원본은 조각으로 받아, 다른 파일이 끝나 비는 연결을 바로 이어서 씁니다. */
export const chunkThreshold = 2 * 1024 * 1024;
export const chunkSize = 1024 * 1024;
/** 이 시간 동안 데이터가 오지 않으면 연결을 끊고 다시 시도합니다. */
const idleTimeout = 60_000;

const extensions: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/bmp': 'bmp', 'image/heic': 'heic', 'image/heif': 'heif',
  'image/tiff': 'tiff', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/jxl': 'jxl',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/mpeg': 'mpeg',
  'video/ogg': 'ogv', 'video/x-matroska': 'mkv', 'video/x-msvideo': 'avi',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'weba', 'audio/flac': 'flac',
};

export interface DownloaderOptions {
  fetcher?: Fetcher;
  retryCount: number;
  userAgent?: string;
  cdnConnections?: number;
  retryDelay?: (attempt: number, signal?: AbortSignal) => Promise<void>;
}

interface StoredFile {
  name: string;
  bytes: number;
}

/** 파일 하나를 안전하게 받습니다. 끝까지 받은 파일만 최종 이름을 얻습니다. */
export class MediaDownloader {
  readonly originLimiter = new Limiter(originConnectionLimit);
  readonly cdnLimiter: Limiter;
  private readonly fetcher: Fetcher;
  private readonly retryCount: number;
  private readonly userAgent?: string;
  private readonly retryDelay: (attempt: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: DownloaderOptions) {
    this.fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
    this.retryCount = options.retryCount;
    this.userAgent = options.userAgent;
    this.cdnLimiter = new Limiter(options.cdnConnections ?? 4);
    this.retryDelay = options.retryDelay ?? ((attempt, signal) => waitSeconds(2 ** attempt, signal));
  }

  /** 받을 주소의 우선순위를 정합니다. CDN 파일의 ETag가 원본과 같으면 빠른 CDN을 먼저 씁니다. */
  async plan(media: MediaRef, quality: Quality, signal?: AbortSignal): Promise<DownloadPlan> {
    const plan: DownloadPlan = { candidates: candidates(media, quality) };
    if (!prefersOriginal(media, quality)) return plan;
    if (media.kind === 'image') {
      const sides = [media.width, media.height].filter((value): value is number => value !== undefined);
      if (sides.length > 0) plan.expectedLongSide = Math.max(...sides);
    }
    if (!media.originalURL) return plan;
    const [cdn, origin] = await Promise.all([this.headers(media.displayURL, signal), this.headers(media.originalURL, signal)]);
    plan.originalBytes = origin?.length;
    if (origin?.tag && origin.tag === cdn?.tag) {
      plan.candidates = [media.displayURL, media.originalURL];
      plan.identicalToOriginal = true;
    }
    return plan;
  }

  private async headers(url: string, signal?: AbortSignal): Promise<{ tag?: string; length?: number } | undefined> {
    try {
      return await this.limiter(url).withSlot(async () => {
        const response = await this.fetcher(url, { method: 'HEAD', headers: this.requestHeaders(url), signal: withTimeout(signal) });
        if (response.status !== 200) return undefined;
        const length = Number.parseInt(response.headers.get('content-length') ?? '', 10);
        return {
          tag: response.headers.get('etag')?.replace('W/', '') ?? undefined,
          length: Number.isFinite(length) ? length : undefined,
        };
      }, true, signal);
    } catch (error) {
      if (signal?.aborted) throw new CancellationError();
      return undefined;
    }
  }

  private requestHeaders(url: string): Record<string, string> {
    const headers: Record<string, string> = {};
    // 다른 사이트의 파일을 받을 때는 어디서 왔는지 알리지 않습니다.
    let host = '';
    try { host = new URL(url).hostname; } catch { /* 빈 이름으로 둡니다. */ }
    if (host.endsWith('arca.live') || host.endsWith('namu.la')) {
      headers.Referer = 'https://arca.live/';
      if (this.userAgent) headers['User-Agent'] = this.userAgent;
    }
    return headers;
  }

  static isOrigin(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.hostname.startsWith('ac-o.') || parsed.search.includes('type=orig');
    } catch {
      return false;
    }
  }

  private limiter(url: string): Limiter {
    return MediaDownloader.isOrigin(url) ? this.originLimiter : this.cdnLimiter;
  }

  /** 후보 주소를 차례로 시도합니다. 마지막 후보가 아니면 받은 이미지의 크기도 확인합니다. */
  async download(plan: DownloadPlan, directory: string, baseName: string, progress?: Progress, signal?: AbortSignal): Promise<DownloadedFile> {
    let lastError: unknown;
    for (const [index, url] of plan.candidates.entries()) {
      try {
        const file = await this.fetchBest(url, plan, directory, baseName, progress, signal);
        const filePath = path.join(directory, file.name);
        if (index < plan.candidates.length - 1 && plan.expectedLongSide !== undefined) {
          const actual = await longSide(filePath);
          if (actual !== undefined && actual < plan.expectedLongSide) {
            await fs.rm(filePath, { force: true });
            throw UncaliveError.serverResized(plan.expectedLongSide, actual);
          }
        }
        return {
          fileName: file.name,
          bytes: file.bytes,
          usedOriginal: plan.identicalToOriginal === true || MediaDownloader.isOrigin(url),
          fallbackReason: lastError instanceof Error ? lastError.message : undefined,
        };
      } catch (error) {
        if (error instanceof CancellationError || signal?.aborted) throw new CancellationError();
        lastError = error;
      }
    }
    throw lastError ?? UncaliveError.httpStatus(0);
  }

  private async fetchBest(url: string, plan: DownloadPlan, directory: string, baseName: string, progress?: Progress, signal?: AbortSignal): Promise<StoredFile> {
    if (MediaDownloader.isOrigin(url) && plan.originalBytes !== undefined && plan.originalBytes >= chunkThreshold) {
      try {
        return await this.fetchInChunks(url, plan.originalBytes, directory, baseName, progress, signal);
      } catch (error) {
        if (error instanceof CancellationError || signal?.aborted) throw new CancellationError();
        // 나눠 받기에 실패하면 한 번에 받습니다.
      }
    }
    return this.fetchWhole(url, directory, baseName, progress, signal);
  }

  private async fetchWhole(url: string, directory: string, baseName: string, progress?: Progress, signal?: AbortSignal): Promise<StoredFile> {
    if (url.startsWith('data:')) return this.storeInlineData(url, directory, baseName);
    return this.withRetries(signal, () =>
      // 재시도 대기 중에는 슬롯을 비워 다른 파일이 쓰게 합니다.
      this.limiter(url).withSlot(async () => {
        const temporary = path.join(directory, `.${baseName}.${randomUUID()}.download`);
        try {
          const { response, bytes } = await this.stream(url, {}, temporary, progress, signal);
          if (response.status < 200 || response.status >= 300) throw UncaliveError.httpStatus(response.status);
          verifyComplete(bytes, response);
          return await this.store(temporary, contentTypeOf(response), url, directory, baseName);
        } finally {
          await fs.rm(temporary, { force: true });
        }
      }, false, signal),
    );
  }

  /** 응답 본문을 파일로 씁니다. 데이터가 한동안 오지 않으면 끊습니다. */
  private async stream(url: string, extraHeaders: Record<string, string>, target: string, progress: Progress | undefined, signal?: AbortSignal): Promise<{ response: Response; bytes: number }> {
    const idle = new AbortController();
    let timer = setTimeout(() => idle.abort(new UncaliveError('httpStatus', '응답 시간이 초과되었습니다.', 408)), idleTimeout);
    const combined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal;
    const handle = await fs.open(target, 'w');
    try {
      const response = await this.fetcher(url, { headers: { ...this.requestHeaders(url), ...extraHeaders }, signal: combined });
      const expected = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      let bytes = 0;
      let lastReport = 0;
      if (response.body && response.status >= 200 && response.status < 300) {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          clearTimeout(timer);
          timer = setTimeout(() => idle.abort(new UncaliveError('httpStatus', '응답 시간이 초과되었습니다.', 408)), idleTimeout);
          await handle.write(chunk);
          bytes += chunk.byteLength;
          const now = Date.now();
          if (progress && now - lastReport >= 250) {
            lastReport = now;
            progress(bytes, Number.isFinite(expected) ? expected : -1);
          }
        }
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
      return { response, bytes };
    } catch (error) {
      if (signal?.aborted) throw new CancellationError();
      if (idle.signal.aborted) throw idle.signal.reason;
      throw error;
    } finally {
      clearTimeout(timer);
      await handle.close();
    }
  }

  /** 본문에 내장된 `data:` 미디어를 파일로 풀어 저장합니다. */
  private async storeInlineData(url: string, directory: string, baseName: string): Promise<StoredFile> {
    const comma = url.indexOf(',');
    const header = url.slice('data:'.length, comma < 0 ? undefined : comma);
    const payload = comma < 0 ? '' : url.slice(comma + 1);
    const contentType = (header.split(';')[0] ?? '').toLowerCase();
    const data = header.includes(';base64') ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload), 'utf8');
    const temporary = path.join(directory, `.${baseName}.inline`);
    await fs.writeFile(temporary, data);
    return this.store(temporary, contentType, url, directory, baseName);
  }

  private async withRetries<T>(signal: AbortSignal | undefined, body: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      if (signal?.aborted) throw new CancellationError();
      try {
        return await body();
      } catch (error) {
        if (error instanceof CancellationError || signal?.aborted) throw new CancellationError();
        if (attempt >= this.retryCount || !isRetryable(error)) throw error;
        attempt += 1;
        await this.retryDelay(attempt, signal);
      }
    }
  }

  // MARK: - 조각 다운로드

  /** 큰 원본을 조각으로 받습니다. 조각마다 슬롯을 다시 빌리므로 다른 파일과 공평하게 나눠 씁니다. */
  private async fetchInChunks(url: string, length: number, directory: string, baseName: string, progress?: Progress, signal?: AbortSignal): Promise<StoredFile> {
    const folder = path.join(directory, `.${baseName}.chunks`);
    await fs.rm(folder, { recursive: true, force: true });
    await fs.mkdir(folder, { recursive: true });
    try {
      const ranges: Array<[number, number]> = [];
      for (let start = 0; start < length; start += chunkSize) ranges.push([start, Math.min(start + chunkSize - 1, length - 1)]);
      const received = new Map<number, number>();
      const report = (index: number, bytes: number) => {
        received.set(index, bytes);
        let sum = 0;
        received.forEach((value) => { sum += value; });
        progress?.(sum, length);
      };

      let contentType = '';
      let next = 0;
      const worker = async () => {
        while (next < ranges.length) {
          const index = next;
          next += 1;
          const type = await this.fetchChunk(url, ranges[index], path.join(folder, String(index)), (bytes) => report(index, bytes), signal);
          if (contentType === '') contentType = type;
        }
      };
      await Promise.all(Array.from({ length: Math.min(originConnectionLimit, ranges.length) }, worker));

      const joined = path.join(folder, 'joined');
      const output = await fs.open(joined, 'w');
      let written = 0;
      try {
        for (const index of ranges.keys()) {
          const data = await fs.readFile(path.join(folder, String(index)));
          await output.write(data);
          written += data.byteLength;
        }
      } finally {
        await output.close();
      }
      if (written !== length) throw UncaliveError.rangeNotSupported();
      return await this.store(joined, contentType, url, directory, baseName);
    } finally {
      await fs.rm(folder, { recursive: true, force: true });
    }
  }

  private fetchChunk(url: string, range: [number, number], target: string, onBytes: (bytes: number) => void, signal?: AbortSignal): Promise<string> {
    return this.withRetries(signal, () =>
      this.limiter(url).withSlot(async () => {
        const temporary = `${target}.download`;
        try {
          const { response, bytes } = await this.stream(url, { Range: `bytes=${range[0]}-${range[1]}` }, temporary, (bytes) => onBytes(bytes), signal);
          if (response.status === 200) throw UncaliveError.rangeNotSupported();
          if (response.status !== 206) throw UncaliveError.httpStatus(response.status);
          if (!(response.headers.get('content-range') ?? '').startsWith(`bytes ${range[0]}-${range[1]}/`)) throw UncaliveError.rangeNotSupported();
          if (bytes !== range[1] - range[0] + 1) throw UncaliveError.incompleteFile();
          await fs.rename(temporary, target);
          onBytes(bytes);
          return contentTypeOf(response);
        } finally {
          await fs.rm(temporary, { force: true });
        }
      }, false, signal),
    );
  }

  private async store(temporary: string, contentType: string, url: string, directory: string, baseName: string): Promise<StoredFile> {
    const extension = await fileExtension(contentType, url, temporary);
    const name = `${baseName}.${extension}`;
    // 같은 폴더의 .part를 거쳐 원자적으로 옮깁니다.
    const part = path.join(directory, name + '.part');
    const final = path.join(directory, name);
    await fs.rm(part, { force: true });
    await fs.rename(temporary, part);
    await fs.rm(final, { force: true });
    await fs.rename(part, final);
    const stat = await fs.stat(final);
    return { name, bytes: stat.size };
  }
}

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(idleTimeout);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function waitSeconds(seconds: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(seconds);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, seconds * 1000);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancellationError());
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function contentTypeOf(response: Response): string {
  return (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
}

/** 빈 파일이나 도중에 끊긴 파일을 완성본으로 저장하지 않습니다. */
function verifyComplete(bytes: number, response: Response): void {
  const encoded = response.headers.get('content-encoding') !== null;
  const expected = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (bytes <= 0) throw UncaliveError.incompleteFile();
  if (!encoded && Number.isFinite(expected) && expected > 0 && bytes !== expected) throw UncaliveError.incompleteFile();
}

export async function longSide(file: string): Promise<number | undefined> {
  try {
    const size = imageSize(await fs.readFile(file));
    return size.width && size.height ? Math.max(size.width, size.height) : undefined;
  } catch {
    return undefined;
  }
}

/** 확장자를 정합니다. 오류 페이지만 거부하고, 낯선 형식도 버리지 않고 저장합니다. */
export async function fileExtension(contentType: string, url: string, file?: string): Promise<string> {
  if (contentType.startsWith('text/') || contentType.includes('json')) throw UncaliveError.unsupportedMedia(contentType);
  const known = extensions[contentType];
  if (known) return known;
  if (file) {
    const sniffed = await sniffExtension(file);
    if (sniffed) return sniffed;
  }
  const fromURL = url.startsWith('data:') ? '' : pathExtension(url);
  if (fromURL.length >= 1 && fromURL.length <= 5 && /^[a-z0-9]+$/.test(fromURL)) return fromURL === 'jpeg' ? 'jpg' : fromURL;
  return 'bin';
}

/** 파일 앞부분의 서명으로 형식을 알아냅니다. */
export async function sniffExtension(file: string): Promise<string | undefined> {
  let head: Buffer;
  try {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(16);
      const { bytesRead } = await handle.read(buffer, 0, 16, 0);
      head = buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
  if (head.length < 12) return undefined;
  const ascii = (start: number, end: number) => head.subarray(start, end).toString('latin1');
  const starts = (bytes: number[]) => bytes.every((byte, index) => head[index] === byte);

  if (starts([0xff, 0xd8, 0xff])) return 'jpg';
  if (starts([0x89, 0x50, 0x4e, 0x47])) return 'png';
  if (ascii(0, 4) === 'GIF8') return 'gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp';
  if (ascii(0, 2) === 'BM') return 'bmp';
  if (starts([0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  if (ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (brand.startsWith('avif')) return 'avif';
    if (brand.startsWith('heic')) return 'heic';
    return brand.startsWith('qt') ? 'mov' : 'mp4';
  }
  return undefined;
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof UncaliveError) {
    if (error.code === 'incompleteFile') return true;
    if (error.code === 'httpStatus' && error.status !== undefined) {
      return error.status === 408 || error.status === 429 || (error.status >= 500 && error.status < 600);
    }
    return false;
  }
  // fetch가 연결 실패, 끊김, 시간 초과를 TypeError로 알립니다.
  if (error instanceof TypeError) return true;
  const code = (error as { code?: string } | undefined)?.code;
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_SOCKET'].includes(code ?? '');
}
