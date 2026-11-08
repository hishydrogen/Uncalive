import { createHash } from 'node:crypto';

/** 스크랩이나 목록에서 읽은 글 한 개입니다. 맥판의 `collection.json`과 같은 모양으로 저장합니다. */
export interface ScrapEntry {
  id: string;
  channel: string;
  /** 화면에 표시되는 채널 이름입니다. */
  channelName?: string;
  url: string;
  title: string;
  author?: string;
  createdAt?: string;
  /** 게시판의 카테고리입니다. 목록에 표시되지 않으면 비어 있습니다. */
  category?: string;
}

export interface ScrapPage {
  entries: ScrapEntry[];
  /** 페이지 이동 영역에 보이는 가장 큰 번호입니다. 실제 마지막 페이지가 아닐 수 있습니다. */
  highestVisiblePage: number;
  isLoggedIn: boolean;
  username?: string;
}

export type MediaKind = 'image' | 'video' | 'audio' | 'emoticon' | 'poster';

export interface MediaRef {
  /** 서명이 바뀌어도 변하지 않는 식별자입니다. */
  key: string;
  kind: MediaKind;
  displayURL: string;
  originalURL?: string;
  /** 본문 HTML에 적힌 원본의 크기입니다. 회전된 사진은 가로세로가 뒤바뀌어 있을 수 있습니다. */
  width?: number;
  height?: number;
}

export interface ParsedComment {
  id: string;
  author: string;
  createdAt?: string;
  depth: number;
  messageHTML: string;
  media: MediaRef[];
}

export interface ParsedPost {
  id: string;
  channel: string;
  url: string;
  title: string;
  category?: string;
  author?: string;
  createdAt?: string;
  contentHTML: string;
  media: MediaRef[];
  comments: ParsedComment[];
  /** YouTube처럼 파일로 받을 수 없는 외부 임베드 주소입니다. */
  embeds: string[];
  /** 댓글이 여러 페이지일 때의 마지막 페이지 번호입니다. 글을 열면 이 페이지가 먼저 보입니다. */
  commentPages: number;
}

/** 작성일 문자열을 날짜로 바꿉니다. */
export function entryDate(entry: { createdAt?: string }): Date | undefined {
  if (!entry.createdAt) return undefined;
  const date = new Date(entry.createdAt);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** 한 채널의 목록에서는 뱃지가 채널 이름이 아니라 카테고리입니다. */
export function inSingleChannelList(entry: ScrapEntry): ScrapEntry {
  const { channelName, ...rest } = entry;
  return { ...rest, channelName: undefined, category: channelName };
}

// MARK: - 미디어

/** CDN 표시용 이미지의 최대 가로 크기입니다. 이보다 큰 이미지는 표시용에서 축소됩니다. */
export const displayMaxWidth = 1280;
const recompressedExtensions = new Set(['jpg', 'jpeg', 'png', 'webp']);

export type Quality = 'original' | 'balanced' | 'display';

export function makeMedia(kind: MediaKind, displayURL: string, originalURL?: string, width?: number, height?: number): MediaRef {
  return { key: mediaKey(displayURL), kind, displayURL, originalURL, width, height };
}

export function mediaKey(url: string): string {
  // 본문에 직접 들어 있는 이미지는 내용이 곧 주소이므로 해시로 줄입니다.
  if (url.startsWith('data:')) return 'data:' + createHash('sha256').update(url, 'utf8').digest('hex');
  try {
    const parsed = new URL(url);
    return parsed.hostname + parsed.pathname;
  } catch {
    return url;
  }
}

export function pathExtension(url: string): string {
  try {
    const name = new URL(url).pathname.split('/').pop() ?? '';
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  } catch {
    return '';
  }
}

/** 이 화질에서 원본 파일을 받아야 하는지 알려 줍니다. */
export function prefersOriginal(media: MediaRef, quality: Quality): boolean {
  switch (quality) {
    case 'original': return true;
    case 'display': return false;
    case 'balanced': return !keepsResolutionOnCDN(media);
  }
}

/** 크기를 확인할 수 있고 표시용에서도 해상도가 유지되는 정지 이미지인지 봅니다. */
function keepsResolutionOnCDN(media: MediaRef): boolean {
  if (media.kind !== 'image' || media.width === undefined || media.width > displayMaxWidth) return false;
  return recompressedExtensions.has(pathExtension(media.displayURL));
}

/** 시도할 주소를 우선순위대로 돌려줍니다. */
export function candidates(media: MediaRef, quality: Quality): string[] {
  if (!prefersOriginal(media, quality)) {
    // 균형 화질은 CDN을 쓰되, CDN이 실패하면 원본으로 받습니다.
    if (quality === 'balanced' && media.originalURL) return [media.displayURL, media.originalURL];
    return [media.displayURL];
  }
  const result: string[] = [];
  const inferred = inferredOriginalURL(media);
  if (media.originalURL) result.push(media.originalURL);
  else if (inferred) result.push(inferred);
  result.push(media.displayURL);
  return result;
}

/** `data-originalurl`이 없는 아카라이브 이미지에만 쓰는 대체 경로입니다. */
function inferredOriginalURL(media: MediaRef): string | undefined {
  if (media.kind !== 'image') return undefined;
  let url: URL;
  try {
    url = new URL(media.displayURL);
  } catch {
    return undefined;
  }
  if (!(url.hostname.endsWith('arca.live') || url.hostname.endsWith('namu.la'))) return undefined;
  if (url.searchParams.has('type')) return undefined;
  url.searchParams.append('type', 'orig');
  return url.toString();
}

// MARK: - 오류

export type UncaliveErrorCode =
  | 'loginRequired' | 'challengeTimedOut' | 'pageTimedOut' | 'postUnavailable' | 'contentNotFound'
  | 'httpStatus' | 'unsupportedMedia' | 'destinationUnavailable' | 'serverResized' | 'rangeNotSupported'
  | 'incompleteFile';

export class UncaliveError extends Error {
  constructor(readonly code: UncaliveErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'UncaliveError';
  }

  static loginRequired() { return new UncaliveError('loginRequired', '로그인이 필요합니다.'); }
  static challengeTimedOut() { return new UncaliveError('challengeTimedOut', '제한 시간 안에 Cloudflare 보안 확인을 완료하지 못했습니다.'); }
  static pageTimedOut(url: string) {
    let path = url;
    try { path = new URL(url).pathname; } catch { /* 그대로 씁니다. */ }
    return new UncaliveError('pageTimedOut', `페이지를 불러오지 못했습니다: ${path}`);
  }
  static postUnavailable(status: number) { return new UncaliveError('postUnavailable', `게시글을 열 수 없습니다. (HTTP ${status})`, status); }
  static contentNotFound() { return new UncaliveError('contentNotFound', '게시글 본문을 찾지 못했습니다.'); }
  static httpStatus(status: number) { return new UncaliveError('httpStatus', `서버 응답 오류입니다. (HTTP ${status})`, status); }
  static unsupportedMedia(type: string) { return new UncaliveError('unsupportedMedia', `지원하지 않는 파일 형식입니다: ${type}`); }
  static destinationUnavailable(reason: string) { return new UncaliveError('destinationUnavailable', `저장 위치를 사용할 수 없습니다: ${reason}`); }
  static serverResized(expected: number, actual: number) {
    return new UncaliveError('serverResized', `서버에서 축소된 이미지 응답: 긴 변 ${expected}px → ${actual}px`);
  }
  static rangeNotSupported() { return new UncaliveError('rangeNotSupported', '서버가 나눠 받기를 지원하지 않습니다.'); }
  static incompleteFile() { return new UncaliveError('incompleteFile', '파일을 끝까지 받지 못했습니다.'); }
}

/** 작업을 취소했을 때 던지는 오류입니다. */
export class CancellationError extends Error {
  constructor() {
    super('취소되었습니다.');
    this.name = 'CancellationError';
  }
}

export function isFatal(error: unknown): boolean {
  return error instanceof UncaliveError && (error.code === 'loginRequired' || error.code === 'challengeTimedOut');
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
