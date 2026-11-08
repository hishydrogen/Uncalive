import * as cheerio from 'cheerio';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exists, resolveRelative, writeAtomic } from './fsutil';
import { sourceOfFolder, type ArchiveSource } from './options';
import { ResumeStore, stateFile, type PostRecord } from './resume';

/** 보관함 화면이 쓰는 글 한 개의 정보입니다. */
export interface ArchivedPost {
  record: PostRecord;
  channel: string;
  channelName: string;
  category?: string;
  author?: string;
  createdAt?: string;
  source?: ArchiveSource;
  /** 검색용 소문자 글자입니다. */
  searchText: string;
}

export function matches(post: ArchivedPost, query: string): boolean {
  return post.searchText.includes(query.toLowerCase());
}

/** 검색어 주변의 글자를 돌려줍니다. */
export function snippet(post: ArchivedPost, query: string, radius = 40): string | undefined {
  const needle = query.toLowerCase();
  if (needle === '') return undefined;
  const index = post.searchText.indexOf(needle);
  if (index < 0) return undefined;
  const start = Math.max(0, index - radius);
  const end = Math.min(post.searchText.length, index + needle.length + radius);
  return post.searchText.slice(start, end).replaceAll('\n', ' ');
}

function textFile(postID: string, root: string): string {
  return path.join(root, '.uncalive', 'text', `${postID}.txt`);
}

export async function writeText(text: string, postID: string, root: string): Promise<void> {
  await writeAtomic(textFile(postID, root), text);
}

interface PostInfo {
  channel?: string;
  category?: string;
  author?: string;
  createdAt?: string;
}

/** 저장 폴더의 기록을 보관함 정보로 읽습니다. 이전 버전으로 받은 글도 저장된 파일에서 정보를 보완합니다. */
export async function loadLibrary(root: string): Promise<ArchivedPost[]> {
  if (!(await exists(stateFile(root)))) return [];
  let store: ResumeStore;
  try {
    store = await ResumeStore.open(root);
  } catch {
    return [];
  }
  const posts = await Promise.all(store.liveRecords().map((record) => postFor(record, root)));

  // 이름이 없는 옛 기록도 같은 채널의 다른 글에서 이름을 찾아 한 채널로 묶습니다.
  const names = new Map<string, string>();
  for (const post of posts) if (post.channelName !== post.channel) names.set(post.channel, post.channelName);
  return posts.map((post) => ({ ...post, channelName: names.get(post.channel) ?? post.channelName }));
}

async function postFor(record: PostRecord, root: string): Promise<ArchivedPost> {
  const folder = resolveRelative(root, record.folder);
  let info: PostInfo | undefined;
  if (record.channel === undefined) {
    try {
      info = JSON.parse(await fs.readFile(path.join(folder, 'post.json'), 'utf8')) as PostInfo;
    } catch {
      info = undefined;
    }
  }
  const channel = record.channel ?? info?.channel ?? '';
  return {
    record,
    channel,
    channelName: record.channelName ?? (channel === '' ? '기타' : channel),
    category: record.category ?? info?.category,
    author: record.author ?? info?.author,
    createdAt: record.createdAt ?? info?.createdAt,
    source: sourceOfFolder(record.folder),
    searchText: (await textFor(record, folder, root)).toLowerCase(),
  };
}

async function textFor(record: PostRecord, folder: string, root: string): Promise<string> {
  try {
    return await fs.readFile(textFile(record.id, root), 'utf8');
  } catch {
    // 색인이 없던 시절에 받은 글은 오프라인 페이지에서 글자를 뽑아 저장해 둡니다.
  }
  try {
    const html = await fs.readFile(path.join(folder, 'index.html'), 'utf8');
    const body = cheerio.load(html)('body').text().replace(/\s+/gu, ' ').trim();
    await writeText(body, record.id, root).catch(() => undefined);
    return body;
  } catch {
    return record.title;
  }
}

/** 엑셀에서 열 수 있는 CSV를 만듭니다. */
export function csvData(rows: string[][]): Buffer {
  const text = rows.map((row) => row.map(csvEscape).join(',')).join('\r\n') + '\r\n';
  // BOM이 있어야 엑셀이 한글을 UTF-8로 읽습니다.
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
}

export function csvEscape(field: string): string {
  let value = field;
  // 남이 쓴 제목이 엑셀 수식으로 실행되지 않게 막습니다.
  if (value !== '' && '=+-@\t\r'.includes(value[0])) value = "'" + value;
  if (!/[,"\r\n]/.test(value)) return value;
  return '"' + value.replaceAll('"', '""') + '"';
}
