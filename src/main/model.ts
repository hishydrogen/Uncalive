import { app, dialog, Notification, powerSaveBlocker, shell, type BrowserWindow } from 'electron';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunControl } from '../core/control';
import { ScrapEngine, type EngineEvent } from '../core/engine';
import { resolveRelative, writeAtomic } from '../core/fsutil';
import { csvData, loadLibrary, matches, snippet, type ArchivedPost } from '../core/library';
import { CancellationError, entryDate, errorMessage, UncaliveError, type ScrapEntry } from '../core/models';
import { sanitize } from '../core/naming';
import { mergeOptions, type ArchiveSource, type DownloadOptions, type ListScope } from '../core/options';
import { parseTargets } from '../core/parser';
import { DownloadQueue } from '../core/queue';
import { ResumeStore, stateFile, type PostRecord } from '../core/resume';
import type {
  AppState, JobState, LibraryItem, LibraryMedia, ListKind, ListLoad, ListState, LoginState, LogLine, PostStatus, Section,
} from '../shared/types';
import { BrowserController } from './browser';
import { log } from './log';
import { Settings } from './settings';

const noAccountFolder = '로그인 안 함';
export const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'heic', 'heif', 'tiff']);
export const videoExtensions = new Set(['mp4', 'webm', 'mov', 'mpeg', 'mkv', 'avi', 'ogv']);
const logLimit = 1000;

const extensionOf = (file: string) => path.extname(file).slice(1).toLowerCase();

/** 스크랩과 주소 수집이 각자 가지는 글 목록입니다. */
class EntryList {
  entries: ScrapEntry[] = [];
  checked = new Set<string>();
  load: ListLoad = { kind: 'idle' };

  constructor(readonly kind: ListKind) {}

  get isLoading(): boolean {
    return this.load.kind === 'loading';
  }

  snapshot(): ListState {
    // 목록에 없는 선택은 보내지 않습니다.
    return { entries: this.entries, checked: this.entries.filter((entry) => this.checked.has(entry.id)).map((entry) => entry.id), load: this.load };
  }
}

/** 다운로드 한 회차의 진행 상태입니다. */
class DownloadJob {
  status: JobState['status'] = 'running';
  failure?: string;
  finishedPosts = 0;
  currentTitle = '';
  savedFiles = 0;
  failedFiles = 0;
  failedPosts = 0;
  incompletePosts = 0;
  savedBytes = 0;
  activeFiles = new Map<string, { id: string; received: number; expected: number }>();
  log: LogLine[] = [];
  readonly startedAt = Date.now();
  finishedAt?: number;
  readonly control = new RunControl();
  readonly queue: DownloadQueue;
  private nextLogID = 0;

  constructor(entries: ScrapEntry[], source: ArchiveSource) {
    this.queue = new DownloadQueue(entries, source);
  }

  get isActive(): boolean {
    return this.status === 'running' || this.status === 'paused' || this.status === 'waitingForChallenge';
  }

  enqueue(entries: ScrapEntry[], source: ArchiveSource): number {
    const added = this.queue.enqueue(entries, source);
    if (added > 0) this.append('info', `대기열에 ${added}개 추가됨`);
    return added;
  }

  handle(event: EngineEvent): void {
    switch (event.type) {
      case 'postStarted':
        this.currentTitle = event.entry.title;
        break;
      case 'mediaProgress':
        this.activeFiles.set(event.key, { id: event.key, received: event.received, expected: event.expected });
        break;
      case 'mediaSaved':
        this.activeFiles.delete(event.key);
        this.savedFiles += 1;
        this.savedBytes += event.bytes;
        break;
      case 'mediaFailed':
        this.activeFiles.delete(event.key);
        this.failedFiles += 1;
        this.append('warning', `파일 다운로드 실패: ${event.reason}`);
        break;
      case 'postFinished':
        this.finishedPosts += 1;
        if (!event.complete) this.incompletePosts += 1;
        this.append(event.complete ? 'success' : 'warning', event.complete ? event.entry.title : `일부 실패: ${event.entry.title}`);
        break;
      case 'postFailed':
        this.finishedPosts += 1;
        this.failedPosts += 1;
        this.append('failure', `${event.entry.title}: ${event.reason}`);
        break;
      case 'postSkipped':
        this.finishedPosts += 1;
        this.append('info', `건너뜀: ${event.entry.title}`);
        break;
      case 'warning':
        this.append('warning', event.text);
        break;
      default:
        break;
    }
  }

  append(level: LogLine['level'], text: string): void {
    this.log.push({ id: this.nextLogID++, level, text });
    if (this.log.length > logLimit) this.log.splice(0, this.log.length - logLimit);
  }

  snapshot(): JobState {
    return {
      status: this.status, failure: this.failure, totalPosts: this.queue.totalPosts, finishedPosts: this.finishedPosts,
      queuedPosts: this.queue.queuedPosts, currentTitle: this.currentTitle, savedFiles: this.savedFiles,
      failedFiles: this.failedFiles, failedPosts: this.failedPosts, incompletePosts: this.incompletePosts,
      savedBytes: this.savedBytes, activeFiles: [...this.activeFiles.values()].sort((a, b) => a.id.localeCompare(b.id)),
      log: this.log, startedAt: this.startedAt, finishedAt: this.finishedAt,
    };
  }
}

type Slice = 'meta' | 'scraps' | 'collection' | 'records' | 'job' | 'library';

/** 앱 전체의 상태입니다. 맥판의 `AppModel`과 같은 일을 합니다. */
export class AppModel {
  readonly browser = new BrowserController();
  private readonly settings = new Settings();
  private readonly engine = new ScrapEngine(this.browser);

  section: Section = 'scraps';
  login: LoginState = 'unknown';
  username?: string;
  useAccountFolder: boolean;
  options: DownloadOptions;
  readonly scraps = new EntryList('scraps');
  readonly collection = new EntryList('collection');
  records: Record<string, PostRecord> = {};
  library: ArchivedPost[] = [];
  isLoadingLibrary = false;
  job?: DownloadJob;
  newScrapCount = 0;
  lastCheck?: number;
  autoCheckHours: number;
  autoDownloadNew: boolean;

  window?: BrowserWindow;
  private listControl?: RunControl;
  private listTask?: Promise<void>;
  private jobTask?: Promise<void>;
  private autoCheckTimer?: NodeJS.Timeout;
  private sleepBlocker?: number;
  private dirty = new Set<Slice>();
  private sendTimer?: NodeJS.Timeout;
  private recordsGeneration = 0;
  private libraryGeneration = 0;

  constructor(private readonly defaultFolder: string) {
    this.username = this.settings.get<string>('username');
    this.useAccountFolder = this.settings.get<boolean>('useAccountFolder') ?? true;
    this.options = mergeOptions(this.settings.get<Partial<DownloadOptions>>('downloadOptions'), path.isAbsolute(defaultFolder) ? defaultFolder : path.join(os.homedir(), defaultFolder));
    this.autoCheckHours = this.settings.get<number>('autoCheckHours') ?? 0;
    this.autoDownloadNew = this.settings.get<boolean>('autoDownloadNewScraps') ?? false;

    this.browser.onChallengeChanged = (active) => this.challengeChanged(active);
    this.browser.onLoginDetected = () => this.loginCompleted();
    void this.loadCollection();
  }

  // MARK: - 화면에 보내기

  private changed(...slices: Slice[]): void {
    slices.forEach((slice) => this.dirty.add(slice));
    this.dirty.add('meta');
    if (this.sendTimer) return;
    this.sendTimer = setTimeout(() => {
      this.sendTimer = undefined;
      this.send();
    }, 80);
  }

  /** 바뀐 부분만 보냅니다. 처음에는 전부 보냅니다. */
  private send(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const slices = this.dirty;
    this.dirty = new Set();
    window.webContents.send('state', this.snapshot(slices));
  }

  snapshot(slices?: Set<Slice>): Partial<AppState> {
    const all = !slices;
    const has = (slice: Slice) => all || slices.has(slice);
    const state: Partial<AppState> = {};
    if (has('meta')) {
      Object.assign(state, {
        platform: process.platform, version: app.getVersion(), section: this.section, login: this.login,
        username: this.username, useAccountFolder: this.useAccountFolder, options: this.options,
        libraryRoot: this.libraryRoot, isBusy: this.isBusy, newScrapCount: this.newScrapCount,
        lastCheck: this.lastCheck, autoCheckHours: this.autoCheckHours, autoDownloadNew: this.autoDownloadNew,
        isLoadingLibrary: this.isLoadingLibrary,
      } satisfies Partial<AppState>);
    }
    if (has('scraps')) state.scraps = this.scraps.snapshot();
    if (has('collection')) state.collection = this.collection.snapshot();
    if (has('records')) {
      state.records = Object.fromEntries(Object.values(this.records).map((record) => [record.id, {
        title: record.title, completed: record.completed, folder: record.folder, category: record.category,
      }]));
    }
    if (has('job')) state.job = this.job?.snapshot();
    if (has('library')) state.library = this.library.map((post) => this.libraryItem(post));
    return state;
  }

  private libraryItem(post: ArchivedPost): LibraryItem {
    const prefix = post.record.folder + '/';
    const media: LibraryMedia[] = Object.values(post.record.files)
      .filter((file) => !file.startsWith('assets/'))
      .sort()
      .flatMap((file) => {
        const extension = extensionOf(file);
        const isVideo = videoExtensions.has(extension);
        return isVideo || imageExtensions.has(extension) ? [{ path: prefix + file, isVideo }] : [];
      });
    return {
      id: post.record.id, title: post.record.title, folder: post.record.folder, completed: post.record.completed,
      updatedAt: post.record.updatedAt, channel: post.channel, channelName: post.channelName, category: post.category,
      author: post.author, source: post.source, fileCount: Object.keys(post.record.files).length, cover: media[0], media,
    };
  }

  // MARK: - 시작

  async start(): Promise<void> {
    this.reloadRecords();
    this.scheduleAutoCheck();
    if (await this.browser.hasSession()) {
      this.refreshScraps();
    } else {
      this.login = 'loggedOut';
      this.changed();
    }
  }

  setSection(section: Section): void {
    this.section = section;
    if (section === 'scraps') this.clearNewScrapBadge();
    this.refreshFromDisk();
    this.changed();
  }

  /** 탐색기에서 지운 내용은 앱으로 돌아올 때 다시 확인합니다. */
  windowFocused(): void {
    this.refreshFromDisk();
  }

  // MARK: - 로그인

  signIn(): void {
    this.browser.showLogin();
  }

  /** 읽고 있던 목록이 있어도 새 계정의 목록을 바로 읽습니다. */
  private loginCompleted(): void {
    this.login = 'loggedIn';
    this.changed();
    void (async () => {
      this.listControl?.cancel();
      await this.listTask;
      this.refreshScraps();
    })();
  }

  async signOut(): Promise<void> {
    this.listControl?.cancel();
    await this.listTask;
    await this.browser.signOut();
    this.login = 'loggedOut';
    this.setUsername(undefined);
    this.scraps.entries = [];
    this.scraps.checked = new Set();
    this.changed('scraps');
  }

  private setUsername(name: string | undefined): void {
    const previous = this.username;
    this.username = name;
    this.settings.set('username', name);
    if (name !== previous) this.libraryDidChange();
  }

  // MARK: - 목록 공통

  /** 페이지를 읽는 창은 하나이므로 한 번에 한 작업만 읽습니다. */
  get isBusy(): boolean {
    return this.scraps.isLoading || this.collection.isLoading || this.job?.isActive === true;
  }

  list(kind: ListKind): EntryList {
    return kind === 'scraps' ? this.scraps : this.collection;
  }

  status(entry: ScrapEntry): PostStatus {
    const record = this.records[entry.id];
    if (!record) return 'new';
    return record.completed ? 'saved' : 'incomplete';
  }

  /** 주소로 추가한 글은 받은 뒤에야 실제 제목을 알 수 있습니다. */
  displayTitle(entry: ScrapEntry): string {
    return this.records[entry.id]?.title ?? entry.title;
  }

  setChecked(kind: ListKind, ids: string[], value: boolean): void {
    const list = this.list(kind);
    ids.forEach((id) => (value ? list.checked.add(id) : list.checked.delete(id)));
    this.changed(kind);
  }

  checkUnsaved(kind: ListKind): void {
    const list = this.list(kind);
    list.checked = new Set(list.entries.filter((entry) => this.status(entry) !== 'saved').map((entry) => entry.id));
    this.changed(kind);
  }

  /** 새 글만 더합니다. 새로 더한 글을 돌려줍니다. */
  private merge(fresh: ScrapEntry[], list: EntryList, atFront = false): ScrapEntry[] {
    const known = new Set(list.entries.map((entry) => entry.id));
    const added = fresh.filter((entry) => !known.has(entry.id));
    list.entries = atFront ? [...added, ...list.entries] : [...list.entries, ...added];
    added.filter((entry) => this.status(entry) !== 'saved').forEach((entry) => list.checked.add(entry.id));
    this.changed(list.kind);
    return added;
  }

  stopLoading(): void {
    this.listControl?.cancel();
  }

  async exportCSV(kind: ListKind, ids: string[]): Promise<void> {
    const list = this.list(kind);
    const result = await dialog.showSaveDialog(this.window!, {
      defaultPath: kind === 'scraps' ? '스크랩 목록.csv' : '주소 수집 목록.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (result.canceled || !result.filePath) return;
    const visible = new Set(ids);
    const labels: Record<PostStatus, string> = { new: '안 받음', incomplete: '일부만 받음', saved: '받음' };
    const rows = [['제목', '채널', '카테고리', '작성자', '작성일', '주소', '상태', '저장 폴더']];
    for (const entry of list.entries.filter((item) => visible.has(item.id))) {
      rows.push([
        this.displayTitle(entry), entry.channelName ?? entry.channel, entry.category ?? this.records[entry.id]?.category ?? '',
        entry.author ?? '', entry.createdAt ?? '', entry.url, labels[this.status(entry)], this.records[entry.id]?.folder ?? '',
      ]);
    }
    await writeAtomic(result.filePath, csvData(rows));
  }

  // MARK: - 스크랩

  refreshScraps(): void {
    if (this.isBusy) return;
    this.browser.enablePrivacyRules();
    this.scraps.load = { kind: 'loading', page: 0 };
    this.scraps.entries = [];
    this.scraps.checked = new Set();
    this.changed('scraps');

    const control = new RunControl();
    this.listControl = control;
    this.listTask = (async () => {
      try {
        const read = await this.engine.fetchScraps(this.options, control, (event) => {
          if (event.type === 'accountFound') {
            this.login = 'loggedIn';
            this.setUsername(event.username);
          } else if (event.type === 'listPageRead') {
            // 스크랩 페이지를 읽었다면 로그인된 것이므로 끝까지 기다리지 않습니다.
            this.login = 'loggedIn';
            this.merge(event.entries, this.scraps);
            this.scraps.load = { kind: 'loading', page: event.page, highestPage: event.highestVisiblePage };
          }
          this.changed('scraps');
        });
        log(`스크랩 읽기 완료: ${read.length}개`);
        this.login = 'loggedIn';
        this.lastCheck = Date.now();
        this.scraps.load = { kind: 'idle' };
      } catch (error) {
        log(`스크랩 읽기 실패: ${errorMessage(error)}`);
        if (error instanceof CancellationError) {
          this.scraps.load = { kind: 'idle' };
        } else if (error instanceof UncaliveError && error.code === 'loginRequired') {
          this.login = 'loggedOut';
          this.scraps.load = { kind: 'idle' };
        } else {
          this.scraps.load = { kind: 'failed', message: errorMessage(error) };
        }
      }
      this.listTask = undefined;
      this.changed('scraps');
    })();
  }

  // MARK: - 새 스크랩 자동 확인

  private scheduleAutoCheck(): void {
    if (this.autoCheckTimer) clearInterval(this.autoCheckTimer);
    this.autoCheckTimer = undefined;
    if (this.autoCheckHours <= 0) return;
    this.autoCheckTimer = setInterval(() => void this.checkForNewScraps(), this.autoCheckHours * 3600_000);
  }

  setAutoCheckHours(hours: number): void {
    this.autoCheckHours = hours;
    this.settings.set('autoCheckHours', hours);
    this.scheduleAutoCheck();
    this.changed();
  }

  setAutoDownloadNew(value: boolean): void {
    this.autoDownloadNew = value;
    this.settings.set('autoDownloadNewScraps', value);
    this.changed();
  }

  /** 앞쪽부터 읽어 이미 아는 글이 나올 때까지 새 스크랩을 찾습니다. */
  async checkForNewScraps(): Promise<void> {
    if (this.login !== 'loggedIn' || this.isBusy) return;
    // 아는 글이 없으면 어디서 멈출지 알 수 없으므로 전체를 읽습니다.
    if (this.scraps.entries.length === 0) {
      this.refreshScraps();
      return;
    }
    this.browser.enablePrivacyRules();
    const known = new Set(this.scraps.entries.map((entry) => entry.id));
    let fresh: ScrapEntry[];
    try {
      fresh = await this.engine.fetchNewScraps(known, this.options);
    } catch {
      return;
    }
    this.lastCheck = Date.now();
    const added = this.merge(fresh, this.scraps, true).filter((entry) => this.status(entry) === 'new');
    this.changed();
    if (added.length === 0) return;

    if (this.section !== 'scraps') {
      this.newScrapCount += added.length;
      app.setBadgeCount(this.newScrapCount);
    }
    this.notify(added.length);
    if (this.autoDownloadNew) this.startDownloadEntries(added, '스크랩');
  }

  /** 알림에는 개수만 넣고 글 제목은 넣지 않습니다. */
  private notify(count: number): void {
    if (!Notification.isSupported()) return;
    new Notification({ title: app.getName(), body: `새 스크랩 ${count}개를 찾았습니다.` }).show();
  }

  private clearNewScrapBadge(): void {
    this.newScrapCount = 0;
    app.setBadgeCount(0);
  }

  // MARK: - 주소 수집

  /** 주소 수집 목록은 보관함마다 따로 있습니다. 맥판과 같은 파일을 씁니다. */
  private get collectionFile(): string {
    return path.join(this.libraryRoot, '.uncalive', 'collection.json');
  }

  private async loadCollection(): Promise<void> {
    const file = this.collectionFile;
    let entries: ScrapEntry[] = [];
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
      if (Array.isArray(parsed)) entries = parsed as ScrapEntry[];
    } catch {
      entries = [];
    }
    if (file !== this.collectionFile) return;
    this.collection.entries = entries;
    // 받은 기록을 읽은 뒤에 안 받은 글만 고릅니다. 먼저 고르면 받은 글까지 골라집니다.
    this.collection.checked = new Set();
    this.changed('collection');
    this.reloadRecords(() => {
      if (this.collection.entries !== entries) return;
      this.collection.checked = new Set(entries.filter((entry) => this.status(entry) !== 'saved').map((entry) => entry.id));
      this.changed('collection');
    });
  }

  private saveCollection(): void {
    void writeAtomic(this.collectionFile, JSON.stringify(this.collection.entries)).catch((error) => log(`주소 목록 저장 실패: ${errorMessage(error)}`));
  }

  clearCollection(): void {
    this.collection.entries = [];
    this.collection.checked = new Set();
    this.saveCollection();
    this.changed('collection');
  }

  removeFromCollection(id: string): void {
    this.collection.entries = this.collection.entries.filter((entry) => entry.id !== id);
    this.collection.checked.delete(id);
    this.saveCollection();
    this.changed('collection');
  }

  removeCheckedFromCollection(): void {
    const ids = this.collection.checked;
    if (ids.size === 0) return;
    this.collection.entries = this.collection.entries.filter((entry) => !ids.has(entry.id));
    this.collection.checked = new Set();
    this.saveCollection();
    this.changed('collection');
  }

  /** 글 주소는 바로 더하고, 목록 주소는 지정한 범위만큼 읽습니다. */
  addTargets(text: string, scope: ListScope): void {
    const lists: string[] = [];
    const posts: ScrapEntry[] = [];
    for (const target of parseTargets(text)) {
      if (target.type === 'post') posts.push(target.entry);
      else lists.push(target.url);
    }
    this.merge(posts, this.collection);
    this.saveCollection();
    // 화면에서 막지만, 혹시 들어와도 읽고 있는 작업을 방해하지 않습니다.
    if (lists.length === 0 || this.isBusy) return;

    this.browser.enablePrivacyRules();
    this.collection.load = { kind: 'loading', page: 0, highestPage: scope.lastPage };
    this.changed('collection');
    const control = new RunControl();
    this.listControl = control;
    this.listTask = (async () => {
      let failure: string | undefined;
      for (const list of lists) {
        try {
          await this.engine.fetchList(list, scope, this.options.pageDelay, control, (event) => {
            if (event.type !== 'listPageRead') return;
            this.merge(event.entries, this.collection);
            this.collection.load = { kind: 'loading', page: event.page, highestPage: scope.lastPage };
            this.changed('collection');
          });
        } catch (error) {
          if (error instanceof CancellationError) break;
          failure = errorMessage(error);
        }
      }
      this.saveCollection();
      this.collection.load = failure ? { kind: 'failed', message: failure } : { kind: 'idle' };
      this.listTask = undefined;
      this.changed('collection');
    })();
  }

  // MARK: - 다운로드

  startDownload(kind: ListKind): void {
    const list = this.list(kind);
    const selected = list.entries.filter((entry) => list.checked.has(entry.id));
    const wasRunning = this.job?.isActive === true;
    this.startDownloadEntries(selected, kind === 'scraps' ? '스크랩' : '주소 수집');
    // 대기열에 넣은 글은 선택을 풀어 들어갔음을 알립니다.
    if (wasRunning) {
      selected.forEach((entry) => list.checked.delete(entry.id));
      this.changed(kind);
    }
  }

  private startDownloadEntries(selected: ScrapEntry[], source: ArchiveSource): void {
    if (selected.length === 0) return;
    const current = this.job;
    if (current?.isActive) {
      if (!current.queue.isClosed) {
        current.enqueue(selected, source);
        this.changed('job');
      } else {
        // 마지막 묶음이 막 끝난 순간입니다. 정리를 기다렸다가 새로 시작합니다.
        void this.jobTask?.then(() => this.startDownloadEntries(selected, source));
      }
      return;
    }
    if (this.isBusy) return;

    const job = new DownloadJob(selected, source);
    this.job = job;
    this.section = 'downloads';
    this.preventSleep(true);
    this.changed('job');

    this.jobTask = (async () => {
      try {
        for (let batch = job.queue.nextBatch(); batch; batch = job.queue.nextBatch()) {
          // 사용자가 직접 고른 글이므로 받은 기록이 있어도 다시 확인합니다. 있는 파일은 재사용합니다.
          const options: DownloadOptions = { ...this.options, destination: this.libraryRoot, source: batch.source, skipCompleted: false };
          await this.engine.download(batch.entries, options, job.control, (event) => {
            job.handle(event);
            if (event.type === 'postFinished') this.reloadRecords();
            this.changed('job');
          });
        }
        job.status = 'finished';
      } catch (error) {
        if (error instanceof CancellationError || job.control.isCancelled) {
          job.status = 'cancelled';
        } else {
          job.status = 'failed';
          job.failure = errorMessage(error);
          if (error instanceof UncaliveError && error.code === 'loginRequired') this.login = 'loggedOut';
        }
      }
      job.finishedAt = Date.now();
      job.activeFiles.clear();
      this.reloadRecords();
      this.preventSleep(false);
      this.window?.flashFrame(true);
      this.changed('job');
    })();
  }

  togglePause(): void {
    const job = this.job;
    if (!job) return;
    if (job.status === 'paused') {
      job.control.resume();
      job.status = 'running';
    } else if (job.status === 'running') {
      job.control.pause();
      job.status = 'paused';
    }
    this.changed('job');
  }

  cancelDownload(): void {
    this.job?.control.cancel();
  }

  /** 종료 전에 기록이 저장되도록 작업이 멈추기를 잠시 기다립니다. */
  async cancelDownloadAndWait(): Promise<void> {
    this.cancelDownload();
    await Promise.race([this.jobTask, new Promise((resolve) => setTimeout(resolve, 3000))]);
  }

  private challengeChanged(active: boolean): void {
    if (active) {
      this.browser.showChallenge();
      if (this.job?.status === 'running') this.job.status = 'waitingForChallenge';
    } else {
      this.browser.hide();
      if (this.job?.status === 'waitingForChallenge') this.job.status = 'running';
    }
    this.changed('job');
  }

  private preventSleep(prevent: boolean): void {
    if (prevent && this.sleepBlocker === undefined) {
      this.sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!prevent && this.sleepBlocker !== undefined) {
      powerSaveBlocker.stop(this.sleepBlocker);
      this.sleepBlocker = undefined;
    }
  }

  // MARK: - 설정

  setOptions(options: DownloadOptions): void {
    const destinationChanged = options.destination !== this.options.destination;
    this.options = mergeOptions(options, this.options.destination);
    this.settings.set('downloadOptions', this.options);
    if (destinationChanged) this.libraryDidChange();
    this.changed();
  }

  setUseAccountFolder(value: boolean): void {
    if (this.job?.isActive) return;
    this.useAccountFolder = value;
    this.settings.set('useAccountFolder', value);
    this.libraryDidChange();
  }

  async chooseDestination(): Promise<void> {
    if (this.job?.isActive) return;
    const result = await dialog.showOpenDialog(this.window!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: this.options.destination,
      buttonLabel: '선택',
    });
    if (result.canceled || result.filePaths.length === 0) return;
    this.setOptions({ ...this.options, destination: result.filePaths[0] });
  }

  async flush(): Promise<void> {
    await this.settings.flush();
  }

  // MARK: - 보관함

  /** 실제로 쓰는 보관함 폴더입니다. */
  get libraryRoot(): string {
    if (!this.useAccountFolder) return this.options.destination;
    const name = sanitize(this.username ?? noAccountFolder, 60);
    return path.join(this.options.destination, name === '' ? noAccountFolder : name);
  }

  /** 저장 위치나 계정이 바뀌면 화면의 목록도 그 보관함의 내용으로 바꿉니다. */
  private libraryDidChange(): void {
    this.records = {};
    this.library = [];
    void this.loadCollection();
    this.reloadRecords(() => {
      for (const list of [this.scraps, this.collection]) {
        list.checked = new Set(list.entries.filter((entry) => this.status(entry) !== 'saved').map((entry) => entry.id));
      }
      this.changed('scraps', 'collection');
    });
    this.reloadLibrary();
    this.changed('records', 'library');
  }

  /** 디스크의 현재 상태를 다시 읽습니다. */
  private refreshFromDisk(): void {
    this.reloadRecords();
    if (this.section === 'library' || this.section === 'gallery') this.reloadLibrary();
  }

  reloadRecords(then?: () => void): void {
    const root = this.libraryRoot;
    const generation = ++this.recordsGeneration;
    if (!existsSync(stateFile(root))) {
      this.records = {};
      this.changed('records');
      then?.();
      return;
    }
    void ResumeStore.open(root).then((store) => {
      if (generation !== this.recordsGeneration || root !== this.libraryRoot) return;
      this.records = Object.fromEntries(store.liveRecords().map((record) => [record.id, record]));
      this.changed('records');
      then?.();
    }).catch(() => undefined);
  }

  reloadLibrary(): void {
    const root = this.libraryRoot;
    const generation = ++this.libraryGeneration;
    this.isLoadingLibrary = true;
    this.changed();
    const names = new Map<string, string>();
    for (const entry of [...this.scraps.entries, ...this.collection.entries]) {
      if (entry.channelName) names.set(entry.channel, entry.channelName);
    }
    void loadLibrary(root).then((posts) => {
      if (generation !== this.libraryGeneration || root !== this.libraryRoot) return;
      this.library = posts.map((post) => {
        const name = names.get(post.channel);
        return post.channelName === post.channel && name ? { ...post, channelName: name } : post;
      });
      this.isLoadingLibrary = false;
      this.changed('library');
    });
  }

  /** 본문과 댓글까지 찾습니다. 찾은 글의 번호와 검색어 주변 글자를 돌려줍니다. */
  searchLibrary(query: string): Record<string, string | null> {
    const result: Record<string, string | null> = {};
    const needle = query.trim();
    if (needle === '') return result;
    const lower = needle.toLowerCase();
    for (const post of this.library) {
      if (matches(post, needle) || post.author?.toLowerCase().includes(lower)) result[post.record.id] = snippet(post, needle) ?? null;
    }
    return result;
  }

  private folderOf(id: string): string | undefined {
    const record = this.records[id] ?? this.library.find((post) => post.record.id === id)?.record;
    return record ? resolveRelative(this.libraryRoot, record.folder) : undefined;
  }

  openPost(id: string): void {
    const folder = this.folderOf(id);
    if (!folder) return;
    const page = path.join(folder, 'index.html');
    void shell.openPath(existsSync(page) ? page : folder);
  }

  revealPost(id: string): void {
    const folder = this.folderOf(id);
    if (folder) shell.showItemInFolder(folder);
  }

  revealFile(relative: string): void {
    const target = this.resolveLibraryPath(relative);
    if (target) shell.showItemInFolder(target);
  }

  openLibraryFolder(): void {
    const root = this.libraryRoot;
    void fs.mkdir(root, { recursive: true }).then(() => shell.openPath(root));
  }

  /** 보관함 안의 파일만 돌려줍니다. 바깥을 가리키는 경로는 거부합니다. */
  resolveLibraryPath(relative: string): string | undefined {
    const root = path.resolve(this.libraryRoot);
    const target = path.resolve(resolveRelative(root, relative));
    const inside = path.relative(root, target);
    if (inside === '' || inside.startsWith('..') || path.isAbsolute(inside)) return undefined;
    return target;
  }

  /** 작성일 순으로 정렬할 때 씁니다. */
  static dateValue(entry: ScrapEntry): number {
    return entryDate(entry)?.getTime() ?? 0;
  }
}
