import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeArchive, searchableText } from './archiver';
import { RunControl, sleep as realSleep } from './control';
import { MediaDownloader, type DownloadedFile, type Fetcher } from './downloader';
import { exists, resolveRelative, writeAtomic } from './fsutil';
import { writeText } from './library';
import {
  CancellationError, entryDate, errorMessage, inSingleChannelList, isFatal, prefersOriginal, UncaliveError,
  type MediaRef, type ParsedComment, type ParsedPost, type ScrapEntry,
} from './models';
import { baseName, folderName, sanitize } from './naming';
import { sourceFolders, type DownloadOptions, type ListScope, type PageRange } from './options';
import { commentPageURL, listURL, parseCommentPage, parsePost, parseScrapList, scrapListURL } from './parser';
import { ResumeStore } from './resume';

export type PageKind = 'scrapList' | 'post';

export interface LoadedPage {
  html: string;
  status: number;
}

/** 로그인된 브라우저에서 페이지를 읽어 오는 역할입니다. 앱에서는 숨긴 브라우저 창이 맡습니다. */
export interface PageSource {
  load(url: string, kind: PageKind, signal?: AbortSignal): Promise<LoadedPage>;
  userAgent(): Promise<string | undefined>;
  /** 마지막으로 불러온 페이지를 한 파일로 저장합니다. */
  saveWebArchive(target: string): Promise<void>;
}

export type EngineEvent =
  | { type: 'listPageRead'; page: number; entries: ScrapEntry[]; total: number; highestVisiblePage: number }
  | { type: 'listFinished'; total: number }
  | { type: 'accountFound'; username: string }
  | { type: 'postStarted'; index: number; total: number; entry: ScrapEntry }
  | { type: 'postSkipped'; index: number; total: number; entry: ScrapEntry }
  | { type: 'mediaStarted'; postID: string; count: number }
  | { type: 'mediaProgress'; postID: string; key: string; received: number; expected: number }
  | { type: 'mediaSaved'; postID: string; key: string; fileName: string; bytes: number; usedOriginal: boolean }
  | { type: 'mediaFailed'; postID: string; key: string; reason: string }
  | { type: 'postFinished'; index: number; total: number; entry: ScrapEntry; folder: string; complete: boolean }
  | { type: 'postFailed'; index: number; total: number; entry: ScrapEntry; reason: string }
  | { type: 'warning'; text: string };

export type EventHandler = (event: EngineEvent) => void;

export interface RunSummary {
  postsFound: number;
  postsCompleted: number;
  postsSkipped: number;
  postsIncomplete: number;
  postsFailed: number;
  mediaSaved: number;
  mediaReused: number;
  mediaFailed: number;
  bytesSaved: number;
}

interface Job {
  media: MediaRef;
  subfolder?: string;
  baseName: string;
  isAsset: boolean;
}

interface PreparedPost {
  entry: ScrapEntry;
  post: ParsedPost;
  folderName: string;
  folder: string;
  paths: Record<string, string>;
  pending: Job[];
  reused: number;
}

interface PostOutcome {
  index: number;
  entry: ScrapEntry;
  folder: string;
  saved: number;
  reused: number;
  failed: number;
  /** 원본을 원했지만 표시용으로 대체된 파일 수입니다. 다음 실행 때 다시 시도합니다. */
  downgraded: number;
  bytes: number;
  failureReason?: string;
}

const isComplete = (outcome: PostOutcome) => outcome.failed === 0 && outcome.downgraded === 0;

/** 파일을 받는 중에 미리 읽어 둘 글의 수입니다. 서명된 주소가 만료되기 전에 쓰도록 제한합니다. */
const maxPostsInFlight = 3;

export interface EngineOptions {
  fetcher?: Fetcher;
  sleep?: (seconds: number, control?: RunControl) => Promise<void>;
  retryDelay?: (attempt: number, signal?: AbortSignal) => Promise<void>;
}

export class ScrapEngine {
  private readonly sleep: (seconds: number, control?: RunControl) => Promise<void>;

  constructor(private readonly source: PageSource, private readonly engineOptions: EngineOptions = {}) {
    this.sleep = engineOptions.sleep ?? realSleep;
  }

  /** 스크랩 목록을 읽고 모두 받습니다. */
  async run(options: DownloadOptions, control = new RunControl(), onEvent: EventHandler = () => {}): Promise<RunSummary> {
    const entries = await this.fetchScraps(options, control, onEvent);
    return this.download(entries, options, control, onEvent);
  }

  /**
   * 지정한 게시글만 받습니다. 페이지는 한 번에 하나씩 읽되, 앞선 글의 파일을 받는 동안 다음 글을 미리 읽어
   * 원본 서버의 제한된 연결이 쉬지 않게 합니다.
   */
  async download(entries: ScrapEntry[], options: DownloadOptions, control = new RunControl(), onEvent: EventHandler = () => {}): Promise<RunSummary> {
    const root = options.destination;
    try {
      await fs.mkdir(root, { recursive: true });
    } catch (error) {
      throw UncaliveError.destinationUnavailable(errorMessage(error));
    }
    const store = await ResumeStore.open(root);
    const downloader = new MediaDownloader({
      fetcher: this.engineOptions.fetcher,
      retryCount: options.retryCount,
      userAgent: await this.source.userAgent(),
      cdnConnections: options.maxConcurrentDownloads,
      retryDelay: this.engineOptions.retryDelay,
    });
    // 치명적인 오류가 나면 미리 받던 글도 멈춥니다.
    const halt = new AbortController();
    const signal = AbortSignal.any([control.signal, halt.signal]);

    const summary: RunSummary = {
      postsFound: entries.length, postsCompleted: 0, postsSkipped: 0, postsIncomplete: 0, postsFailed: 0,
      mediaSaved: 0, mediaReused: 0, mediaFailed: 0, bytesSaved: 0,
    };
    const total = entries.length;
    const running = new Map<number, Promise<PostOutcome>>();

    const record = (outcome: PostOutcome) => {
      summary.mediaSaved += outcome.saved;
      summary.mediaReused += outcome.reused;
      summary.mediaFailed += outcome.failed;
      summary.bytesSaved += outcome.bytes;
      if (outcome.failureReason !== undefined) {
        summary.postsFailed += 1;
        onEvent({ type: 'postFailed', index: outcome.index, total, entry: outcome.entry, reason: outcome.failureReason });
      } else {
        if (isComplete(outcome)) summary.postsCompleted += 1;
        else summary.postsIncomplete += 1;
        onEvent({ type: 'postFinished', index: outcome.index, total, entry: outcome.entry, folder: outcome.folder, complete: isComplete(outcome) });
      }
    };
    const waitOne = async () => {
      const [index, outcome] = await Promise.race([...running.entries()].map(([key, promise]) => promise.then((value) => [key, value] as const)));
      running.delete(index);
      record(outcome);
    };

    try {
      for (const [offset, entry] of entries.entries()) {
        const index = offset + 1;
        await control.waitIfPaused();

        if (options.skipCompleted && store.record(entry.id)?.completed === true) {
          summary.postsSkipped += 1;
          onEvent({ type: 'postSkipped', index, total, entry });
          continue;
        }

        if (running.size >= maxPostsInFlight) await waitOne();

        onEvent({ type: 'postStarted', index, total, entry });
        try {
          const prepared = await this.prepare(entry, options, store, onEvent, control);
          const task = this.transfer(prepared, index, options, store, downloader, control, signal, onEvent);
          // 결과를 기다리기 전에 실패해도 처리되지 않은 거부로 남지 않게 합니다.
          task.catch(() => undefined);
          running.set(index, task);
        } catch (error) {
          if (isFatal(error)) throw error;
          if (error instanceof CancellationError || control.isCancelled) throw new CancellationError();
          summary.postsFailed += 1;
          onEvent({ type: 'postFailed', index, total, entry, reason: errorMessage(error) });
        }

        // 결과와 상관없이 항상 쉬어서 서버에 연속 요청을 보내지 않습니다.
        if (index < total) await this.sleep(options.pageDelay, control);
      }
      while (running.size > 0) await waitOne();
    } catch (error) {
      halt.abort(new CancellationError());
      await Promise.allSettled(running.values());
      await store.save().catch(() => undefined);
      throw control.isCancelled ? new CancellationError() : error;
    }
    return summary;
  }

  // MARK: - 목록

  /** 스크랩 목록을 읽습니다. 페이지마다 이벤트를 보내므로 도중에 취소해도 읽은 부분을 쓸 수 있습니다. */
  fetchScraps(options: DownloadOptions, control = new RunControl(), onEvent: EventHandler = () => {}): Promise<ScrapEntry[]> {
    return this.collect({ range: options.pages, delay: options.pageDelay, requiresLogin: true, control, onEvent, url: scrapListURL });
  }

  /** 스크랩 앞쪽부터 읽어 이미 아는 글이 나오면 멈춥니다. 확인 주기 사이에 한 페이지가 넘게 스크랩해도 놓치지 않습니다. */
  fetchNewScraps(known: Set<string>, options: DownloadOptions, control = new RunControl(), onEvent: EventHandler = () => {}): Promise<ScrapEntry[]> {
    return this.collect({ range: { first: 1 }, known, delay: options.pageDelay, requiresLogin: true, control, onEvent, url: scrapListURL });
  }

  /** 채널이나 검색 결과처럼 사용자가 지정한 목록을 읽습니다. */
  fetchList(list: string, scope: ListScope, delay: number, control = new RunControl(), onEvent: EventHandler = () => {}): Promise<ScrapEntry[]> {
    let channel: string | undefined;
    try {
      const parts = new URL(list).pathname.split('/').filter(Boolean);
      if (parts.length >= 2 && parts[0] === 'b') channel = parts[1];
    } catch { /* 채널이 없는 목록입니다. */ }
    return this.collect({
      range: { first: scope.firstPage, last: scope.lastPage },
      since: scope.since ? new Date(scope.since) : undefined,
      listChannel: channel, delay, requiresLogin: false, control, onEvent,
      url: (page) => listURL(list, page),
    });
  }

  private async collect(args: {
    range: PageRange; since?: Date; known?: Set<string>; listChannel?: string; delay: number;
    requiresLogin: boolean; control: RunControl; onEvent: EventHandler; url: (page: number) => string;
  }): Promise<ScrapEntry[]> {
    const { range, since, known = new Set<string>(), listChannel, delay, requiresLogin, control, onEvent, url } = args;
    const entries: ScrapEntry[] = [];
    const seen = new Set<string>();
    const firstPage = Math.max(range.first, 1);
    let page = firstPage;

    while (true) {
      await control.waitIfPaused();
      const loaded = await this.source.load(url(page), 'scrapList', control.signal);
      control.check();
      // 이미 글을 읽은 뒤의 404는 로그아웃이 아니라 목록의 끝입니다.
      if (loaded.status === 404 && page > firstPage && entries.length > 0) break;
      // 로그아웃 상태에서 스크랩 목록은 404로 응답합니다.
      if (requiresLogin && loaded.status === 404) throw UncaliveError.loginRequired();
      if (loaded.status < 200 || loaded.status >= 300) throw UncaliveError.httpStatus(loaded.status);

      const parsed = parseScrapList(loaded.html);
      if (requiresLogin && !parsed.isLoggedIn) throw UncaliveError.loginRequired();
      if (page === firstPage && parsed.username) onEvent({ type: 'accountFound', username: parsed.username });

      const unseen = parsed.entries
        .filter((entry) => {
          if (seen.has(entry.id)) return false;
          seen.add(entry.id);
          return true;
        })
        .map((entry) => (entry.channel === listChannel ? inSingleChannelList(entry) : entry));
      // 작성일을 모르는 글은 안전하게 남깁니다.
      const fresh = unseen.filter((entry) => {
        if (known.has(entry.id)) return false;
        const date = entryDate(entry);
        return !since || !date || date >= since;
      });
      const reachedKnown = unseen.some((entry) => known.has(entry.id));
      entries.push(...fresh);
      onEvent({ type: 'listPageRead', page, entries: fresh, total: entries.length, highestVisiblePage: parsed.highestVisiblePage });

      if (unseen.length === 0 || fresh.length === 0 || reachedKnown || page >= parsed.highestVisiblePage) break;
      if (range.last !== undefined && page >= range.last) break;
      page += 1;
      await this.sleep(delay, control);
    }
    onEvent({ type: 'listFinished', total: entries.length });
    return entries;
  }

  // MARK: - 게시글

  /** 페이지를 읽고 받을 파일을 정합니다. 브라우저를 쓰는 작업은 모두 여기서 끝냅니다. */
  private async prepare(entry: ScrapEntry, options: DownloadOptions, store: ResumeStore, onEvent: EventHandler, control: RunControl): Promise<PreparedPost> {
    const loaded = await this.source.load(entry.url, 'post', control.signal);
    control.check();
    if (loaded.status < 200 || loaded.status >= 300) throw UncaliveError.postUnavailable(loaded.status);
    const post = parsePost(loaded.html, entry.url);

    if (post.embeds.length > 0) {
      onEvent({ type: 'warning', text: `${post.title}: 외부 임베드 콘텐츠 ${post.embeds.length}개(YouTube 등)는 파일로 받을 수 없어 오프라인 페이지에 링크로 남겼습니다.` });
    }

    let preferred = folderName(post, options);
    if (options.groupByChannel) preferred = sanitize(post.channel, 50) + '/' + preferred;
    if (options.source) preferred = sourceFolders[options.source] + '/' + preferred;
    // 이미 받은 글은 어느 목록에서 다시 받든 처음 폴더를 그대로 씁니다.
    const relativeFolder = store.reserveFolder(post, preferred, entry.channelName);
    const folder = resolveRelative(options.destination, relativeFolder);
    await fs.mkdir(folder, { recursive: true });
    store.saveSoon();

    if (options.archive.webArchive) {
      try {
        await this.source.saveWebArchive(path.join(folder, 'page.mhtml'));
      } catch (error) {
        onEvent({ type: 'warning', text: `웹 아카이브 저장 실패: ${errorMessage(error)}` });
      }
    }
    if (options.archive.rawHTML) await writeAtomic(path.join(folder, 'page.html'), loaded.html);

    // 글을 열면 댓글의 마지막 페이지만 보이므로 앞쪽 페이지를 따로 읽습니다.
    if (options.archive.offlineHTML && options.archive.includeComments && post.commentPages > 1) {
      const earlier: ParsedComment[] = [];
      for (let page = 1; page < post.commentPages; page += 1) {
        await this.sleep(options.pageDelay, control);
        try {
          const extra = await this.source.load(commentPageURL(entry.url, page), 'post', control.signal);
          control.check();
          if (extra.status < 200 || extra.status >= 300) throw UncaliveError.httpStatus(extra.status);
          earlier.push(...parseCommentPage(extra.html));
        } catch (error) {
          if (isFatal(error)) throw error;
          if (error instanceof CancellationError || control.isCancelled) throw new CancellationError();
          onEvent({ type: 'warning', text: `댓글 ${page}페이지를 불러오지 못했습니다: ${post.title}` });
        }
      }
      post.comments = [...earlier, ...post.comments];
    }

    const paths: Record<string, string> = {};
    for (const [key, file] of Object.entries(store.record(post.id)?.files ?? {})) {
      if (await exists(resolveRelative(folder, file))) paths[key] = file;
    }

    const allJobs = jobsFor(post, options);
    const pending = allJobs.filter((job) => paths[job.media.key] === undefined);
    onEvent({ type: 'mediaStarted', postID: post.id, count: pending.length });
    if (pending.some((job) => job.subfolder !== undefined)) await fs.mkdir(path.join(folder, 'assets'), { recursive: true });

    return { entry, post, folderName: relativeFolder, folder, paths, pending, reused: allJobs.length - pending.length };
  }

  /** 한 글의 파일을 받고 보관본을 씁니다. 연결 수는 `MediaDownloader`의 제한기가 지킵니다. */
  private async transfer(
    prepared: PreparedPost, index: number, options: DownloadOptions, store: ResumeStore,
    downloader: MediaDownloader, control: RunControl, signal: AbortSignal, onEvent: EventHandler,
  ): Promise<PostOutcome> {
    const { post } = prepared;
    const outcome: PostOutcome = { index, entry: prepared.entry, folder: prepared.folderName, saved: 0, reused: prepared.reused, failed: 0, downgraded: 0, bytes: 0 };
    const paths = { ...prepared.paths };

    await Promise.all(prepared.pending.map(async (job) => {
      await control.waitIfPaused(signal);
      const directory = job.subfolder ? path.join(prepared.folder, job.subfolder) : prepared.folder;
      // 오프라인 페이지 장식용 파일은 원본 서버의 연결을 쓰지 않습니다.
      const quality = job.isAsset ? 'display' : options.quality;
      let file: DownloadedFile;
      try {
        const plan = await downloader.plan(job.media, quality, signal);
        file = await downloader.download(plan, directory, job.baseName, (received, expected) => {
          onEvent({ type: 'mediaProgress', postID: post.id, key: job.media.key, received, expected });
        }, signal);
      } catch (error) {
        if (error instanceof CancellationError || signal.aborted) throw new CancellationError();
        if (!job.isAsset) outcome.failed += 1;
        onEvent({ type: 'mediaFailed', postID: post.id, key: job.media.key, reason: errorMessage(error) });
        await this.sleep(options.mediaDelay, control);
        return;
      }
      const relative = job.subfolder ? `${job.subfolder}/${file.fileName}` : file.fileName;
      paths[job.media.key] = relative;
      outcome.saved += 1;
      outcome.bytes += file.bytes;
      onEvent({ type: 'mediaSaved', postID: post.id, key: job.media.key, fileName: relative, bytes: file.bytes, usedOriginal: file.usedOriginal });
      const wantedOriginal = prefersOriginal(job.media, quality) && job.media.originalURL !== undefined;
      if (wantedOriginal && !file.usedOriginal) {
        // 기록하지 않아서 다음 실행 때 원본을 다시 시도합니다.
        outcome.downgraded += 1;
        onEvent({ type: 'warning', text: `원본을 받지 못해 웹 표시용으로 대체했습니다: ${post.title} / ${file.fileName} (${file.fallbackReason ?? '원인 미상'})` });
      } else {
        store.setFile(relative, job.media.key, post.id);
        store.saveSoon();
      }
      await this.sleep(options.mediaDelay, control);
    }));

    try {
      await writeArchive(post, paths, options.archive, prepared.folder);
      await writeText(searchableText(post), post.id, options.destination);
      await store.finish(post.id, isComplete(outcome));
    } catch (error) {
      outcome.failureReason = errorMessage(error);
    }
    return outcome;
  }
}

/** 번호를 붙일 파일과, 오프라인 페이지에만 쓰는 `assets/` 파일을 구분합니다. */
function jobsFor(post: ParsedPost, options: DownloadOptions): Job[] {
  const selected = post.media.filter((media) => {
    switch (media.kind) {
      case 'image': return options.includeImages;
      case 'video': return options.includeVideos;
      case 'audio': return options.includeAudio;
      case 'emoticon': return options.includeEmoticons;
      case 'poster': return options.includeVideoPosters;
    }
  });
  const jobs: Job[] = selected.map((media, offset) => ({
    media, baseName: baseName(offset + 1, selected.length, media, options.fileNaming), isAsset: false,
  }));
  if (!options.archive.offlineHTML) return jobs;

  const known = new Set(selected.map((media) => media.key));
  const extras = post.media.filter((media) => media.kind === 'emoticon' || (media.kind === 'poster' && options.includeVideos));
  if (options.archive.includeComments) extras.push(...post.comments.flatMap((comment) => comment.media));
  for (const media of extras) {
    if (known.has(media.key)) continue;
    known.add(media.key);
    jobs.push({ media, subfolder: 'assets', baseName: assetName(media), isAsset: true });
  }
  return jobs;
}

function assetName(media: MediaRef): string {
  return createHash('sha256').update(media.key, 'utf8').digest('hex').slice(0, 16);
}
