import * as cheerio from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { postPath } from './targets';
import { makeMedia, UncaliveError, type MediaRef, type ParsedComment, type ParsedPost, type ScrapEntry, type ScrapPage } from './models';

/** 아카라이브 HTML 구조를 아는 유일한 모듈입니다. 사이트가 바뀌면 이 파일만 고칩니다. */
export const baseURL = 'https://arca.live';

export function scrapListURL(page: number): string {
  return `https://arca.live/u/scrap_list?p=${page}`;
}

export { parseTargets, postPath, type Target } from './targets';

/** 목록 주소의 페이지 번호만 바꿉니다. 검색 조건 같은 다른 값은 유지합니다. */
export function listURL(base: string, page: number): string {
  try {
    const url = new URL(base);
    url.searchParams.delete('p');
    url.searchParams.append('p', String(page));
    return url.toString();
  } catch {
    return base;
  }
}

export function commentPageURL(post: string, page: number): string {
  return `${post}?cp=${page}`;
}

/** SwiftSoup의 `text()`처럼 공백을 하나로 줄이고 앞뒤를 정리합니다. */
function normalized(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function strictInt(value: string | undefined): number | undefined {
  return value !== undefined && /^[+-]?\d+$/.test(value.trim()) ? Number.parseInt(value, 10) : undefined;
}

function queryNumber(href: string, name: string): number | undefined {
  try {
    return strictInt(new URL(href, baseURL).searchParams.get(name) ?? undefined);
  } catch {
    return undefined;
  }
}

export function parseScrapList(html: string): ScrapPage {
  const $ = cheerio.load(html, { baseURI: baseURL });
  const seen = new Set<string>();
  const entries: ScrapEntry[] = [];

  $('a.vrow').each((_, element) => {
    const row = $(element);
    if (row.hasClass('notice')) return;
    const post = postPath(row.attr('href') ?? '');
    if (!post || seen.has(post.id)) return;
    seen.add(post.id);
    const title = normalized(row.find('.col-title .title').first().text());
    const author = row.find('.col-author [data-filter]').first().attr('data-filter');
    // 여러 채널이 섞인 목록의 뱃지는 [채널, 카테고리] 순서입니다.
    const badges = row.find('.col-title .badges .badge').map((_, badge) => normalized($(badge).text())).get();
    const createdAt = row.find('.col-time time[datetime]').first().attr('datetime');
    entries.push(compact({
      id: post.id,
      channel: post.channel,
      channelName: badges[0],
      url: `https://arca.live/b/${post.channel}/${post.id}`,
      title,
      author,
      createdAt,
      category: badges[1],
    }));
  });

  let highest = 1;
  $('.pagination a[href]').each((_, link) => {
    const page = queryNumber($(link).attr('href') ?? '', 'p');
    if (page !== undefined) highest = Math.max(highest, page);
  });
  const username = normalized($('.user-menu-link .username').first().text());
  return {
    entries,
    highestVisiblePage: highest,
    isLoggedIn: $("a[href^='/u/logout']").length > 0,
    username: username === '' ? undefined : username,
  };
}

export function parsePost(html: string, url: string): ParsedPost {
  const $ = cheerio.load(html, { baseURI: baseURL });
  let content = $('.article-content').first();
  if (content.length === 0) content = $('.fr-view').first();
  if (content.length === 0) throw UncaliveError.contentNotFound();

  let path = url;
  try { path = new URL(url).pathname; } catch { /* 주소가 아니면 그대로 봅니다. */ }
  const { channel, id } = postPath(path) ?? { channel: '', id: '' };
  const head = $('.article-head').first();
  const titleNode = head.find('.title').first();
  const category = normalized(titleNode.find('.category-badge').first().text());
  const author = head.find('.member-info .user-info [data-filter]').first().attr('data-filter');
  const createdAt = head.find('.article-info time[datetime]').first().attr('datetime');
  const ownText = normalized(titleNode.contents().filter((_, node) => node.type === 'text').map((_, node) => $(node).text()).get().join(' '));

  const embeds = content.find('iframe[src], embed[src]').map((_, element) => absoluteURL($(element).attr('src') ?? '')).get().filter(Boolean) as string[];

  return compact({
    id,
    channel,
    url,
    title: titleNode.length > 0 ? ownText : '',
    category: category === '' ? undefined : category,
    author,
    createdAt,
    contentHTML: content.html() ?? '',
    media: media($, content),
    comments: comments($),
    embeds,
    commentPages: commentPages($),
  });
}

export function parseCommentPage(html: string): ParsedComment[] {
  return comments(cheerio.load(html, { baseURI: baseURL }));
}

export function absoluteURL(raw: string): string | undefined {
  const text = raw.trim();
  if (text === '' || text.startsWith('data:') || text.startsWith('blob:')) return undefined;
  try {
    if (text.startsWith('//')) return new URL('https:' + text).toString();
    return new URL(text, baseURL).toString();
  } catch {
    return undefined;
  }
}

/** 본문 미디어 주소로 쓸 수 있는 값을 절대 주소로 바꿉니다. 내장된 `data:` 미디어도 허용합니다. */
export function mediaURL(raw: string): string | undefined {
  const text = raw.trim();
  if (text.startsWith('data:image/') || text.startsWith('data:video/') || text.startsWith('data:audio/')) return text;
  return absoluteURL(text);
}

// MARK: - 세부 분석

function media($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>): MediaRef[] {
  const seen = new Set<string>();
  const result: MediaRef[] = [];
  const add = (ref: MediaRef | undefined) => {
    if (ref && !seen.has(ref.key)) {
      seen.add(ref.key);
      result.push(ref);
    }
  };

  root.find('img, video, audio').each((_, node) => {
    const element = $(node);
    const original = absoluteURL(element.attr('data-originalurl') ?? '');
    const isEmoticon = element.hasClass('arca-emoticon') || element.hasClass('emoticon');
    // 지연 로딩이면 src는 자리표시자이고 data-src가 진짜 주소입니다.
    const sources = [element.attr('data-src') ?? '', element.attr('src') ?? ''];
    element.find('source').each((_, source) => {
      sources.push($(source).attr('data-src') ?? '', $(source).attr('src') ?? '');
    });
    const source = sources.map(mediaURL).find(Boolean);
    const tag = (node as Element).tagName.toLowerCase();

    if (tag === 'img') {
      const width = strictInt(element.attr('width'));
      const height = strictInt(element.attr('height'));
      add(source ? makeMedia(isEmoticon ? 'emoticon' : 'image', source, original, width, height) : undefined);
    } else if (tag === 'audio') {
      add(source ? makeMedia('audio', source, original) : undefined);
    } else {
      const poster = absoluteURL(element.attr('poster') ?? '');
      if (poster) add(makeMedia('poster', poster));
      add(source ? makeMedia(isEmoticon ? 'emoticon' : 'video', source, original) : undefined);
    }
  });
  return result;
}

function commentPages($: cheerio.CheerioAPI): number {
  let highest = 1;
  $('#comment .pagination a[href]').each((_, link) => {
    const page = queryNumber($(link).attr('href') ?? '', 'cp');
    if (page !== undefined) highest = Math.max(highest, page);
  });
  return highest;
}

function comments($: cheerio.CheerioAPI): ParsedComment[] {
  const result: ParsedComment[] = [];
  $('#comment .comment-item').each((_, node) => {
    const item = $(node);
    const message = item.find('.message').first();
    if (message.length === 0) return;
    message.find('.btn-more').remove();
    const depth = item.parents('.comment-wrapper').length - 1;
    result.push(compact({
      id: (item.attr('id') ?? '').replaceAll('c_', ''),
      author: item.find('.user-info [data-filter]').first().attr('data-filter') ?? '',
      createdAt: item.find('time[datetime]').first().attr('datetime'),
      depth: Math.max(depth, 0),
      messageHTML: message.html() ?? '',
      media: media($, message),
    }));
  });
  return result;
}

/** 값이 없는 항목을 지워 저장 파일에 `null`이 남지 않게 합니다. */
function compact<T extends object>(value: T): T {
  for (const key of Object.keys(value) as Array<keyof T>) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}
