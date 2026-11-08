import type { Quality } from './models';

/** 글을 어느 목록에서 받았는지 나타냅니다. */
export type ArchiveSource = 'scrap' | 'link';
export const archiveSources: ArchiveSource[] = ['scrap', 'link'];
/** 보관함 안의 폴더 이름입니다. */
export const sourceFolders: Record<ArchiveSource, string> = { scrap: 'Scraps', link: 'Links' };
/** 화면에 보이는 이름입니다. */
export const sourceLabels: Record<ArchiveSource, string> = { scrap: '스크랩', link: '링크' };
/** 2.0.0 이전에 쓰던 한글 폴더 이름입니다. 읽을 때만 알아보고, 시작할 때 영문 폴더로 옮깁니다. */
export const legacySourceFolders: Record<ArchiveSource, string> = { scrap: '스크랩', link: '주소 수집' };

/** 저장된 폴더 경로로 출처를 판단합니다. 구분이 없던 시절의 글은 `undefined`입니다. */
export function sourceOfFolder(folder: string): ArchiveSource | undefined {
  return archiveSources.find((source) => folder.startsWith(sourceFolders[source] + '/') || folder.startsWith(legacySourceFolders[source] + '/'));
}

/** 채널이나 검색 결과 같은 목록을 어디까지 읽을지 정합니다. */
export interface ListScope {
  firstPage: number;
  /** 비어 있으면 마지막 페이지까지 읽습니다. */
  lastPage?: number;
  /** 지정하면 이보다 오래된 글만 남은 페이지에서 멈춥니다. ISO 날짜 문자열입니다. */
  since?: string;
}

export interface PageRange {
  first: number;
  /** 비어 있으면 마지막 페이지까지 진행합니다. */
  last?: number;
}

export interface ArchiveOptions {
  /** 받은 파일을 연결한 `index.html`을 만듭니다. */
  offlineHTML: boolean;
  includeComments: boolean;
  /** 제목, 작성자, 파일 목록을 담은 `post.json`을 만듭니다. */
  metadataJSON: boolean;
  /** 페이지 전체를 한 파일에 담은 `page.mhtml`을 만듭니다. 맥판의 웹 아카이브에 해당합니다. */
  webArchive: boolean;
  /** 페이지 원문을 `page.html`로 저장합니다. 계정 닉네임이 포함될 수 있습니다. */
  rawHTML: boolean;
}

/** 설정 화면과 1:1로 대응하는 다운로드 옵션입니다. */
export interface DownloadOptions {
  destination: string;
  /** 지정하면 저장 위치 아래 이 출처의 폴더에 글을 저장합니다. */
  source?: ArchiveSource;
  pages: PageRange;
  quality: Quality;

  includeImages: boolean;
  includeVideos: boolean;
  includeAudio: boolean;
  includeEmoticons: boolean;
  includeVideoPosters: boolean;

  folderNaming: 'title' | 'idAndTitle';
  fileNaming: 'sequence' | 'sequenceAndOriginalName';
  groupByChannel: boolean;
  folderNameMaxLength: number;

  archive: ArchiveOptions;

  /** 완료로 기록된 게시글은 다시 방문하지 않습니다. */
  skipCompleted: boolean;

  /** 초 단위입니다. */
  pageDelay: number;
  mediaDelay: number;
  /** CDN 파일의 동시 다운로드 수입니다. 원본 서버는 `originConnectionLimit`을 따릅니다. */
  maxConcurrentDownloads: number;
  retryCount: number;
}

export function defaultOptions(destination: string): DownloadOptions {
  return {
    destination,
    pages: { first: 1 },
    quality: 'original',
    includeImages: true,
    includeVideos: true,
    includeAudio: true,
    includeEmoticons: false,
    includeVideoPosters: false,
    folderNaming: 'title',
    fileNaming: 'sequence',
    groupByChannel: false,
    folderNameMaxLength: 80,
    archive: { offlineHTML: true, includeComments: true, metadataJSON: true, webArchive: false, rawHTML: false },
    skipCompleted: true,
    pageDelay: 2,
    mediaDelay: 0.2,
    maxConcurrentDownloads: 4,
    retryCount: 3,
  };
}

/** 저장된 옵션을 기본값 위에 덮어 읽습니다. 새 버전에서 생긴 값은 기본값을 씁니다. */
export function mergeOptions(saved: Partial<DownloadOptions> | undefined, destination: string): DownloadOptions {
  const base = defaultOptions(destination);
  if (!saved || typeof saved !== 'object') return base;
  return { ...base, ...saved, pages: { ...base.pages, ...saved.pages }, archive: { ...base.archive, ...saved.archive } };
}
