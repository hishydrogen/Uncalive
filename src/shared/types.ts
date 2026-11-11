import type { ScrapEntry } from '../core/models';
import type { ArchiveSource, DownloadOptions, ListScope } from '../core/options';
import type { UpdateRelease, UpdateResult } from '../core/update';

export type { ScrapEntry, ArchiveSource, DownloadOptions, ListScope };

export type Section = 'scraps' | 'collection' | 'downloads' | 'library' | 'gallery' | 'settings';
export type LoginState = 'unknown' | 'loggedOut' | 'loggedIn';
export type ListKind = 'scraps' | 'collection';
export type PostStatus = 'new' | 'incomplete' | 'saved';

export type ListLoad =
  | { kind: 'idle' }
  /** mode가 new이면 앞쪽만 읽어 새 글을 찾는 중이고, full이면 전체를 읽는 중입니다. */
  | { kind: 'loading'; page: number; highestPage?: number; mode?: 'new' | 'full' }
  | { kind: 'failed'; message: string };

export interface ListState {
  entries: ScrapEntry[];
  checked: string[];
  load: ListLoad;
}

export interface RecordInfo {
  title: string;
  completed: boolean;
  folder: string;
  category?: string;
}

export type JobStatus = 'running' | 'paused' | 'waitingForChallenge' | 'finished' | 'cancelled' | 'failed';

export interface LogLine {
  id: number;
  level: 'info' | 'success' | 'warning' | 'failure';
  text: string;
}

export interface JobState {
  status: JobStatus;
  failure?: string;
  totalPosts: number;
  finishedPosts: number;
  queuedPosts: number;
  currentTitle: string;
  savedFiles: number;
  failedFiles: number;
  failedPosts: number;
  incompletePosts: number;
  savedBytes: number;
  activeFiles: Array<{ id: string; received: number; expected: number }>;
  log: LogLine[];
  startedAt: number;
  finishedAt?: number;
  /** 멈춰 있던 시간(밀리초)과 지금 멈춘 때입니다. 평균 속도와 남은 시간에서 뺍니다. */
  pausedMs: number;
  pausedSince?: number;
  /** 지금 받는 글과 차례를 기다리는 글의 번호입니다. */
  activeIDs: string[];
  waitingIDs: string[];
}

export interface LibraryMedia {
  /** 보관함 폴더 기준 상대 경로입니다. */
  path: string;
  isVideo: boolean;
}

export interface LibraryItem {
  id: string;
  title: string;
  folder: string;
  completed: boolean;
  updatedAt: string;
  channel: string;
  channelName: string;
  category?: string;
  author?: string;
  source?: ArchiveSource;
  fileCount: number;
  /** 번호가 붙은 첫 사진이나 동영상입니다. */
  cover?: LibraryMedia;
  media: LibraryMedia[];
  /** 오프라인 페이지(index.html)가 있는지입니다. 받는 중에는 아직 없을 수 있습니다. */
  hasPage: boolean;
}

/** 새 버전 확인 상태입니다(main/updates.ts). */
export interface UpdateState {
  /** 시작할 때와 몇 시간마다 저절로 확인하는지입니다. */
  auto: boolean;
  checking: boolean;
  /** 마지막으로 확인한 결과입니다. */
  result?: UpdateResult;
  /** 마지막으로 확인에 성공한 때입니다. */
  checkedAt?: number;
  /** 알림 카드에 띄울 새 버전입니다. */
  notice?: UpdateRelease;
}

export interface AppState {
  platform: NodeJS.Platform;
  arch: string;
  material?: 'vibrancy' | 'mica';
  version: string;
  section: Section;
  login: LoginState;
  username?: string;
  /** 로그인 아이디입니다. 계정마다 보관함을 나누는 기준입니다. */
  loginID?: string;
  useAccountFolder: boolean;
  options: DownloadOptions;
  libraryRoot: string;
  scraps: ListState;
  collection: ListState;
  records: Record<string, RecordInfo>;
  job?: JobState;
  isBusy: boolean;
  newScrapCount: number;
  lastCheck?: number;
  /** 스크랩 목록을 끝까지 다 읽은 때입니다. 그 뒤로는 새 글만 더합니다. */
  scrapsFullSyncAt?: number;
  autoCheckHours: number;
  autoDownloadNew: boolean;
  theme: 'system' | 'light' | 'dark';
  notifications: boolean;
  /** 처음 실행 안내에 동의했는지입니다. */
  termsAccepted: boolean;
  library: LibraryItem[];
  isLoadingLibrary: boolean;
  update: UpdateState;
  /** '언카라이브에 관하여' 창을 열었는지입니다. 메뉴에서도 열므로 메인 프로세스가 기억합니다. */
  aboutOpen: boolean;
}

/** 화면에서 보내는 명령입니다. 이름과 인자가 `AppModel`의 메서드와 같습니다. */
export interface Commands {
  setSection(section: Section): void;
  signIn(): void;
  signOut(): void;
  refreshScraps(): void;
  reloadAllScraps(): void;
  stopLoading(): void;
  addTargets(text: string, scope: ListScope): void;
  clearCollection(): void;
  removeFromCollection(id: string): void;
  removeCheckedFromCollection(): number;
  removeFromCollectionMany(ids: string[]): number;
  undoRemoveFromCollection(): number;
  setSelection(kind: ListKind, ids: string[]): void;
  setChecked(kind: ListKind, ids: string[], value: boolean): void;
  checkUnsaved(kind: ListKind): void;
  startDownload(kind: ListKind): Promise<void>;
  togglePause(): void;
  cancelDownload(): void;
  clearJob(): void;
  exportCSV(kind: ListKind, ids: string[]): void;
  setOptions(options: DownloadOptions): void;
  setUseAccountFolder(value: boolean): void;
  setAutoCheckHours(hours: number): void;
  setAutoDownloadNew(value: boolean): void;
  setTheme(theme: 'system' | 'light' | 'dark'): void;
  setNotifications(value: boolean): void;
  acceptTerms(): void;
  checkForUpdates(): Promise<UpdateResult>;
  dismissUpdate(skip: boolean): void;
  downloadUpdate(): boolean;
  setUpdateCheck(value: boolean): void;
  setAboutOpen(open: boolean): void;
  testNotification(): void;
  quit(): void;
  checkNow(): void;
  chooseDestination(): void;
  openPost(id: string): void;
  revealPost(id: string): void;
  revealFile(relative: string): void;
  openLibraryFolder(): void;
  reloadLibrary(): void;
  searchLibrary(query: string): Record<string, string | null>;
  redownloadPosts(ids: string[]): number;
  trashPosts(ids: string[]): Promise<number>;
  copyFiles(paths: string[]): Promise<number>;
  exportFiles(paths: string[]): Promise<number>;
}

export type CommandName = keyof Commands;
