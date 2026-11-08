import { app, dialog, nativeTheme, Notification, powerSaveBlocker, shell, type BrowserWindow } from 'electron';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunControl } from '../core/control';
import { ScrapEngine, type EngineEvent } from '../core/engine';
import { resolveRelative, writeAtomic } from '../core/fsutil';
import { csvData, loadLibrary, matches, snippet, type ArchivedPost } from '../core/library';
import { CancellationError, entryDate, errorMessage, UncaliveError, type ScrapEntry } from '../core/models';
import { sanitize } from '../core/naming';
import { chooseAccountFolder } from '../core/accounts';
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
/** 처음 실행할 때 보여 주는 안내의 판입니다. 내용을 바꾸면 올려서 한 번 더 동의를 받습니다. */
export const termsVersion = 1;
export const imageExtensions = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'heic', 'heif', 'tiff']);
export const videoExtensions = new Set(['mp4', 'webm', 'mov', 'mpeg', 'mkv', 'avi', 'ogv']);
const logLimit = 1000;

const extensionOf = (file: string) => path.extname(file).slice(1).toLowerCase();

/** 스크랩과 링크가 각자 가지는 글 목록입니다. */
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
  /** 이 다운로드가 쓰는 보관함입니다. 도중에 계정이나 저장 위치가 바뀌어도 처음 보관함에만 씁니다. */
  root = '';
  finishedAt?: number;
  readonly control = new RunControl();
  readonly queue: DownloadQueue;
  private nextLogID = 0;

  /** 지금 받는 글과 아직 차례가 오지 않은 글입니다. 목록에서 줄마다 받는 중, 대기 중으로 보여 줍니다. */
  readonly activeIDs = new Set<string>();
  readonly waitingIDs = new Set<string>();

  constructor(entries: ScrapEntry[], source: ArchiveSource) {
    this.queue = new DownloadQueue(entries, source);
    entries.forEach((entry) => this.waitingIDs.add(entry.id));
  }

  get isActive(): boolean {
    return this.status === 'running' || this.status === 'paused' || this.status === 'waitingForChallenge';
  }

  enqueue(entries: ScrapEntry[], source: ArchiveSource): number {
    const added = this.queue.enqueue(entries, source);
    if (added > 0) entries.forEach((entry) => { if (!this.activeIDs.has(entry.id)) this.waitingIDs.add(entry.id); });
    if (added > 0) this.append('info', `대기열에 ${added}개 추가됨`);
    return added;
  }

  handle(event: EngineEvent): void {
    switch (event.type) {
      case 'postStarted':
        this.currentTitle = event.entry.title;
        this.activeIDs.add(event.entry.id);
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
        this.done(event.entry.id);
        this.finishedPosts += 1;
        if (!event.complete) this.incompletePosts += 1;
        this.append(event.complete ? 'success' : 'warning', event.complete ? event.entry.title : `일부 실패: ${event.entry.title}`);
        break;
      case 'postFailed':
        this.done(event.entry.id);
        this.finishedPosts += 1;
        this.failedPosts += 1;
        this.append('failure', `${event.entry.title}: ${event.reason}`);
        break;
      case 'postSkipped':
        this.done(event.entry.id);
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

  /** 끝난 글은 받는 중과 대기 목록에서 뺍니다. */
  private done(id: string): void {
    this.activeIDs.delete(id);
    this.waitingIDs.delete(id);
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
      activeIDs: this.isActive ? [...this.activeIDs] : [], waitingIDs: this.isActive ? [...this.waitingIDs].filter((id) => !this.activeIDs.has(id)) : [],
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
  /** 사이트에 보이는 닉네임입니다. 바뀌거나 다른 계정과 겹칠 수 있어 보관함 구분에는 쓰지 않습니다. */
  username?: string;
  /** 로그인 창에서 입력한 아이디입니다. 바뀌지 않으므로 계정마다 보관함을 나누는 기준으로 씁니다. */
  loginID?: string;
  /** 아이디 → 그 계정의 보관함 폴더 이름(저장 위치 기준) */
  private accounts: Record<string, { folder?: string; nickname?: string }>;
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
  /** 화면 모드입니다. 시스템을 따르거나 라이트, 다크로 고정합니다. */
  theme: 'system' | 'light' | 'dark';
  /** 다운로드를 마치거나 확인이 필요할 때 운영체제 알림을 띄웁니다. */
  notifications: boolean;

  window?: BrowserWindow;
  /** 창 바탕에 쓰는 운영체제 재질입니다. 있으면 화면이 사이드바를 투명하게 둡니다. */
  material?: 'vibrancy' | 'mica';
  private listControl?: RunControl;
  private listTask?: Promise<void>;
  private jobTask?: Promise<void>;
  private autoCheckTimer?: NodeJS.Timeout;
  private sleepBlocker?: number;
  private dirty = new Set<Slice>();
  private sendTimer?: NodeJS.Timeout;
  private recordsGeneration = 0;
  private libraryGeneration = 0;
  private lastRemoved?: { root: string; removed: Array<{ index: number; entry: ScrapEntry; checked: boolean }> };

  constructor(private readonly defaultFolder: string) {
    this.username = this.settings.get<string>('username');
    this.loginID = this.settings.get<string>('loginID');
    this.accounts = this.settings.get<Record<string, { folder?: string; nickname?: string }>>('accounts') ?? {};
    this.useAccountFolder = this.settings.get<boolean>('useAccountFolder') ?? true;
    this.options = mergeOptions(this.settings.get<Partial<DownloadOptions>>('downloadOptions'), path.isAbsolute(defaultFolder) ? defaultFolder : path.join(os.homedir(), defaultFolder));
    this.autoCheckHours = this.settings.get<number>('autoCheckHours') ?? 0;
    this.autoDownloadNew = this.settings.get<boolean>('autoDownloadNewScraps') ?? false;
    this.theme = this.settings.get<'system' | 'light' | 'dark'>('theme') ?? 'system';
    this.notifications = this.settings.get<boolean>('notifications') ?? true;
    nativeTheme.themeSource = this.theme;

    this.browser.onChallengeChanged = (active) => this.challengeChanged(active);
    this.browser.onLoginDetected = (loginID) => this.loginCompleted(loginID);
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
        platform: process.platform, version: app.getVersion(), material: this.material, section: this.section, login: this.login,
        username: this.username, loginID: this.loginID, useAccountFolder: this.useAccountFolder, options: this.options,
        libraryRoot: this.libraryRoot, isBusy: this.isBusy, newScrapCount: this.newScrapCount,
        lastCheck: this.lastCheck, autoCheckHours: this.autoCheckHours, autoDownloadNew: this.autoDownloadNew, theme: this.theme, notifications: this.notifications, termsAccepted: this.termsAccepted,
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
      hasPage: existsSync(path.join(resolveRelative(this.libraryRoot, post.record.folder), 'index.html')),
    };
  }

  // MARK: - 시작

  /** 처음 실행 안내에 동의했는지입니다. 동의하기 전에는 아카라이브에 접속하지 않습니다. */
  get termsAccepted(): boolean {
    return this.settings.get<number>('acceptedTermsVersion') === termsVersion;
  }

  acceptTerms(): void {
    this.settings.set('acceptedTermsVersion', termsVersion);
    void this.settings.flush();
    this.changed();
    void this.start();
  }

  private started = false;

  async start(): Promise<void> {
    if (this.started || !this.termsAccepted) return;
    this.started = true;
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
  private loginCompleted(loginID?: string): void {
    this.login = 'loggedIn';
    // 아이디를 못 읽었으면(창을 닫아 로그인을 마친 경우 등) 예전처럼 닉네임으로 보관함을 찾습니다.
    this.switchAccount(loginID);
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
    this.clearJob();
    this.switchAccount(undefined);
    this.setUsername(undefined);
    this.scraps.entries = [];
    this.scraps.checked = new Set();
    this.changed('scraps');
  }

  private setUsername(name: string | undefined): void {
    const previousRoot = this.libraryRoot;
    this.username = name;
    this.settings.set('username', name);
    if (name && this.loginID) this.assignAccountFolder(this.loginID, name);
    if (this.libraryRoot !== previousRoot) this.libraryDidChange();
    this.changed();
  }

  private switchAccount(loginID: string | undefined): void {
    const previousRoot = this.libraryRoot;
    const changedAccount = loginID !== undefined && loginID !== this.loginID;
    this.loginID = loginID;
    this.settings.set('loginID', loginID);
    if (loginID) this.accounts[loginID] ??= {};
    // 다른 계정으로 바뀌면 앞 계정의 닉네임으로 보관함을 찾지 않도록 이 계정의 닉네임(모르면 없음)으로 바꿉니다.
    if (changedAccount) {
      this.username = this.accounts[loginID].nickname;
      this.settings.set('username', this.username);
    }
    if (this.libraryRoot !== previousRoot) this.libraryDidChange();
    this.changed();
  }

  /**
   * 계정의 보관함 폴더를 정합니다. 예전처럼 닉네임 이름의 보관함이 있고 다른 계정이 쓰고 있지 않으면 그대로 이어 쓰고,
   * 없으면 아이디 이름으로 만듭니다. 한 번 정한 폴더는 닉네임이 바뀌어도 그대로 씁니다.
   */
  private assignAccountFolder(loginID: string, nickname: string): void {
    const account = (this.accounts[loginID] ??= {});
    account.nickname = nickname;
    if (!account.folder) {
      account.folder = chooseAccountFolder(loginID, nickname, this.accounts, (name) => existsSync(path.join(this.options.destination, name)));
      log(`계정 보관함 정함: ${account.folder === sanitize(loginID, 60) ? '아이디 폴더' : '예전 닉네임 폴더를 이어 씀'}`);
    }
    this.settings.set('accounts', this.accounts);
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

  /**
   * 새 글만 더합니다. 새로 더한 글을 돌려줍니다.
   * 저절로 불러온 글(스크랩 목록)은 고르지 않습니다. 사용자가 직접 더한 링크만 select로 골라 둡니다.
   */
  private merge(fresh: ScrapEntry[], list: EntryList, atFront = false, select = false): ScrapEntry[] {
    const known = new Set(list.entries.map((entry) => entry.id));
    const added = fresh.filter((entry) => !known.has(entry.id));
    list.entries = atFront ? [...added, ...list.entries] : [...list.entries, ...added];
    if (select) added.filter((entry) => this.status(entry) !== 'saved').forEach((entry) => list.checked.add(entry.id));
    this.changed(list.kind);
    return added;
  }

  stopLoading(): void {
    this.listControl?.cancel();
  }

  async exportCSV(kind: ListKind, ids: string[]): Promise<void> {
    const list = this.list(kind);
    const result = await dialog.showSaveDialog(this.window!, {
      defaultPath: kind === 'scraps' ? '스크랩 목록.csv' : '링크 목록.csv',
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

  /** 앱 전체와 창 재질, 로그인 창이 함께 바뀝니다. */
  setTheme(theme: 'system' | 'light' | 'dark'): void {
    this.theme = theme;
    nativeTheme.themeSource = theme;
    this.settings.set('theme', theme);
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
    this.notifyUser(`새 스크랩 ${count}개를 찾았습니다`, this.autoDownloadNew ? '자동으로 받기 시작합니다.' : '스크랩 목록에서 확인하세요.', 'scraps', true);
  }

  /**
   * 운영체제 알림 센터로 알립니다. 앱 창을 보고 있을 때는 띄우지 않고, 누르면 해당 화면을 엽니다.
   * 알림에는 글 제목을 넣지 않습니다.
   */
  private notifyUser(title: string, body: string, section: Section, evenIfFocused = false): void {
    if (!this.notifications || !Notification.isSupported()) return;
    if (!evenIfFocused && this.window && !this.window.isDestroyed() && this.window.isFocused()) return;
    const notification = new Notification({ title, body });
    notification.on('click', () => {
      const window = this.window;
      if (window && !window.isDestroyed()) {
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }
      this.setSection(section);
    });
    notification.show();
  }

  setNotifications(value: boolean): void {
    this.notifications = value;
    this.settings.set('notifications', value);
    this.changed();
  }

  private clearNewScrapBadge(): void {
    this.newScrapCount = 0;
    app.setBadgeCount(0);
  }

  // MARK: - 링크

  /** 링크 목록은 보관함마다 따로 있습니다. 맥판과 같은 파일을 씁니다. */
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
    this.collection.checked = new Set();
    this.changed('collection');
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

  removeCheckedFromCollection(): number {
    return this.removeFromCollectionMany([...this.collection.checked]);
  }

  /** 글 여러 개를 목록에서 뺍니다. 바로 앞의 제거는 되돌릴 수 있도록 자리와 함께 기억합니다. 뺀 글 수를 돌려줍니다. */
  removeFromCollectionMany(ids: string[]): number {
    const targets = new Set(ids);
    const removed: Array<{ index: number; entry: ScrapEntry; checked: boolean }> = [];
    this.collection.entries.forEach((entry, index) => {
      if (targets.has(entry.id)) removed.push({ index, entry, checked: this.collection.checked.has(entry.id) });
    });
    if (removed.length === 0) return 0;
    this.collection.entries = this.collection.entries.filter((entry) => !targets.has(entry.id));
    targets.forEach((id) => this.collection.checked.delete(id));
    this.lastRemoved = { root: this.libraryRoot, removed };
    this.saveCollection();
    this.changed('collection');
    return removed.length;
  }

  /** 바로 앞에 뺀 글을 원래 자리로 되돌립니다. 되돌린 글 수를 돌려줍니다. */
  undoRemoveFromCollection(): number {
    const last = this.lastRemoved;
    this.lastRemoved = undefined;
    if (!last || last.root !== this.libraryRoot) return 0;
    const known = new Set(this.collection.entries.map((entry) => entry.id));
    const entries = [...this.collection.entries];
    let restored = 0;
    for (const { index, entry, checked } of last.removed) {
      if (known.has(entry.id)) continue;
      entries.splice(Math.min(index, entries.length), 0, entry);
      if (checked) this.collection.checked.add(entry.id);
      restored += 1;
    }
    this.collection.entries = entries;
    this.saveCollection();
    this.changed('collection');
    return restored;
  }

  /** 고른 글을 통째로 바꿉니다. 화면에서 클릭, 끌어 고르기, 단축키로 고를 때 씁니다. */
  setSelection(kind: ListKind, ids: string[]): void {
    const list = this.list(kind);
    const known = new Set(list.entries.map((entry) => entry.id));
    list.checked = new Set(ids.filter((id) => known.has(id)));
    this.changed(kind);
  }

  /** 글 주소는 바로 더하고, 목록 주소는 지정한 범위만큼 읽습니다. */
  addTargets(text: string, scope: ListScope): void {
    const lists: string[] = [];
    const posts: ScrapEntry[] = [];
    for (const target of parseTargets(text)) {
      if (target.type === 'post') posts.push(target.entry);
      else lists.push(target.url);
    }
    this.merge(posts, this.collection, false, true);
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
            this.merge(event.entries, this.collection, false, true);
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

  async startDownload(kind: ListKind): Promise<void> {
    // 목록을 불러오는 중이면 멈추고 받기 시작합니다. 페이지를 읽는 창이 하나라 둘을 함께 할 수 없습니다.
    if (this.scraps.isLoading || this.collection.isLoading) {
      this.listControl?.cancel();
      await this.listTask;
    }
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
    job.root = this.libraryRoot;
    this.job = job;
    this.section = 'downloads';
    this.preventSleep(true);
    this.changed('job');

    this.jobTask = (async () => {
      try {
        for (let batch = job.queue.nextBatch(); batch; batch = job.queue.nextBatch()) {
          // 사용자가 직접 고른 글이므로 받은 기록이 있어도 다시 확인합니다. 있는 파일은 재사용합니다.
          const options: DownloadOptions = { ...this.options, destination: job.root, source: batch.source, skipCompleted: false };
          await this.engine.download(batch.entries, options, job.control, (event) => {
            job.handle(event);
            if (event.type === 'postFinished') this.reloadRecords();
            if (event.type === 'mediaSaved' || event.type === 'mediaStarted') this.scheduleLiveRefresh();
            this.changed('job');
          });
        }
        job.status = 'finished';
        const failed = job.failedPosts + job.incompletePosts;
        this.notifyUser('다운로드를 마쳤습니다', `글 ${job.finishedPosts}개를 처리했습니다${failed > 0 ? ` (일부만 받은 글 ${failed}개)` : ''}. 파일 ${job.savedFiles}개를 저장했습니다.`, 'downloads');
      } catch (error) {
        if (error instanceof CancellationError || job.control.isCancelled) {
          job.status = 'cancelled';
        } else {
          job.status = 'failed';
          this.notifyUser('다운로드가 멈췄습니다', errorMessage(error), 'downloads');
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

  private liveRefresh?: NodeJS.Timeout;

  /** 받는 동안 보관함과 갤러리를 가끔 다시 읽어, 이미 받은 파일을 바로 보여 줍니다. */
  private scheduleLiveRefresh(): void {
    if (this.liveRefresh) return;
    this.liveRefresh = setTimeout(() => {
      this.liveRefresh = undefined;
      this.reloadRecords();
      if (this.section === 'library' || this.section === 'gallery') this.reloadLibrary();
    }, 1500);
  }

  /** 끝난 다운로드의 기록을 지웁니다. 받는 중이면 지우지 않습니다. */
  clearJob(): void {
    if (!this.job || this.job.isActive) return;
    this.job = undefined;
    this.changed('job');
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
      if (this.job?.status === 'running') {
        this.job.status = 'waitingForChallenge';
        this.notifyUser('보안 확인이 필요합니다', '열린 창에서 Cloudflare 확인을 마치면 다운로드가 이어집니다.', 'downloads');
      }
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
    const folder = this.loginID ? this.accounts[this.loginID]?.folder : undefined;
    if (folder) return path.join(this.options.destination, folder);
    const name = sanitize(this.username ?? noAccountFolder, 60);
    return path.join(this.options.destination, name === '' ? noAccountFolder : name);
  }

  /** 저장 위치나 계정이 바뀌면 화면의 목록도 그 보관함의 내용으로 바꿉니다. */
  private libraryDidChange(): void {
    // 다른 보관함의 다운로드 기록(글 제목 등)이 보이지 않게 끝난 기록은 지웁니다.
    this.clearJob();
    this.records = {};
    this.library = [];
    void this.loadCollection();
    for (const list of [this.scraps, this.collection]) list.checked = new Set();
    this.changed('scraps', 'collection');
    this.reloadRecords();
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

  /** 보관함에서 고른 글을 다시 받습니다. 받은 파일은 그대로 쓰고 빠진 파일만 받습니다. */
  redownloadPosts(ids: string[]): number {
    const wanted = new Set(ids);
    const groups = new Map<ArchiveSource, ScrapEntry[]>();
    for (const post of this.library) {
      if (!wanted.has(post.record.id)) continue;
      const record = post.record;
      const entry: ScrapEntry = {
        id: record.id, channel: post.channel, channelName: post.channelName, title: record.title,
        url: record.url ?? `https://arca.live/b/${post.channel}/${record.id}`,
        author: post.author, createdAt: post.createdAt, category: post.category,
      };
      const source = post.source ?? '스크랩';
      groups.set(source, [...(groups.get(source) ?? []), entry]);
    }
    let count = 0;
    groups.forEach((entries, source) => {
      count += entries.length;
      void this.startDownloadEntries(entries, source);
    });
    return count;
  }

  /**
   * 보관함에서 고른 글을 운영체제 휴지통으로 옮깁니다. 휴지통에서 되살릴 수 있습니다.
   * 받는 중인 글은 건드리지 않습니다. 옮긴 글 수를 돌려줍니다.
   */
  async trashPosts(ids: string[]): Promise<number> {
    const busy = new Set([...(this.job?.isActive ? this.job.activeIDs : []), ...(this.job?.isActive ? this.job.waitingIDs : [])]);
    const root = this.libraryRoot;
    const store = await ResumeStore.open(root);
    let moved = 0;
    for (const id of ids) {
      if (busy.has(id)) continue;
      const record = store.record(id);
      if (!record) continue;
      const folder = resolveRelative(root, record.folder);
      try {
        if (existsSync(folder)) await shell.trashItem(folder);
      } catch (error) {
        log(`휴지통으로 옮기지 못함: ${errorMessage(error)}`);
        continue;
      }
      store.remove(id);
      await fs.rm(path.join(root, '.uncalive', 'text', `${id}.txt`), { force: true });
      moved += 1;
    }
    if (moved > 0) await store.save();
    this.reloadRecords();
    this.reloadLibrary();
    return moved;
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
