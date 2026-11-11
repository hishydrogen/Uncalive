import type { ScrapEntry } from './models';
import type { PageRange } from './options';

/**
 * 계정 폴더(.uncalive/scraps.json)에 두는 스크랩 목록입니다. 보관함을 함께 쓰더라도 계정마다 따로 둡니다.
 * 앱을 열면 이 목록을 바로 보여 주고, 새로고침할 때는 앞쪽부터 읽다가 이미 아는 글이 나오면 멈춥니다.
 * 스크랩을 해제한 글은 앞쪽만 읽어서는 알 수 없으므로 전체 다시 불러오기로만 빠집니다.
 */
export interface ScrapCache {
  version: 1;
  /** 이 목록을 읽은 계정의 로그인 아이디입니다. 예전 닉네임 폴더를 다른 계정이 이어 쓰는 경우에 대비해 확인합니다. */
  account: string;
  /** 전체를 읽을 때 쓴 범위입니다. 범위를 바꾸면 전체를 다시 읽습니다. */
  pages: PageRange;
  /** 끝까지 다 읽은 때입니다. 없으면 도중에 멈춘 목록이라 다음에 전체를 다시 읽습니다. */
  fullSyncAt?: number;
  entries: ScrapEntry[];
}

export function samePages(a: PageRange, b: PageRange): boolean {
  return a.first === b.first && a.last === b.last;
}

/** 파일 내용을 읽어 이 계정의 목록이면 돌려줍니다. 형식이 맞지 않거나 다른 계정의 목록이면 버립니다. */
export function parseScrapCache(text: string, account: string): ScrapCache | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const cache = value as Partial<ScrapCache>;
  if (cache.version !== 1 || cache.account !== account || !Array.isArray(cache.entries)) return undefined;
  if (!cache.pages || typeof cache.pages.first !== 'number') return undefined;
  const entries = cache.entries.filter((entry): entry is ScrapEntry => !!entry && typeof entry.id === 'string' && typeof entry.url === 'string');
  return {
    version: 1,
    account,
    pages: { first: cache.pages.first, last: typeof cache.pages.last === 'number' ? cache.pages.last : undefined },
    fullSyncAt: typeof cache.fullSyncAt === 'number' ? cache.fullSyncAt : undefined,
    entries,
  };
}

/** 앞쪽만 읽어 새 글을 더해도 되는지입니다. 끝까지 읽은 목록이 있고 범위가 같아야 합니다. */
export function canCheckNewOnly(cache: Pick<ScrapCache, 'fullSyncAt' | 'pages' | 'entries'> | undefined, pages: PageRange): boolean {
  return !!cache && cache.fullSyncAt !== undefined && cache.entries.length > 0 && samePages(cache.pages, pages);
}
