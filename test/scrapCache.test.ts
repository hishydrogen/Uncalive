import { describe, expect, test } from 'vitest';
import { canCheckNewOnly, parseScrapCache, type ScrapCache } from '../src/core/scrapCache';

const entry = (id: string) => ({ id, channel: 'test', url: `https://arca.live/b/test/${id}`, title: `글 ${id}` });
const cache = (patch: Partial<ScrapCache> = {}): ScrapCache => ({
  version: 1, account: 'me', pages: { first: 1 }, fullSyncAt: 1_700_000_000_000, entries: [entry('1'), entry('2')], ...patch,
});

describe('저장된 스크랩 목록', () => {
  test('같은 계정의 목록을 읽는다', () => {
    const parsed = parseScrapCache(JSON.stringify(cache()), 'me');
    expect(parsed?.entries.map((item) => item.id)).toEqual(['1', '2']);
    expect(parsed?.fullSyncAt).toBe(1_700_000_000_000);
  });

  test('다른 계정의 목록이나 깨진 파일은 버린다', () => {
    expect(parseScrapCache(JSON.stringify(cache()), 'other')).toBeUndefined();
    expect(parseScrapCache('{', 'me')).toBeUndefined();
    expect(parseScrapCache(JSON.stringify({ ...cache(), version: 2 }), 'me')).toBeUndefined();
    expect(parseScrapCache(JSON.stringify([entry('1')]), 'me')).toBeUndefined();
  });

  test('모양이 맞지 않는 글은 빼고 읽는다', () => {
    const parsed = parseScrapCache(JSON.stringify({ ...cache(), entries: [entry('1'), null, { id: 3 }] }), 'me');
    expect(parsed?.entries.map((item) => item.id)).toEqual(['1']);
  });

  test('끝까지 읽은 목록이고 범위가 같을 때만 새 글만 찾는다', () => {
    expect(canCheckNewOnly(cache(), { first: 1 })).toBe(true);
    expect(canCheckNewOnly(cache({ fullSyncAt: undefined }), { first: 1 })).toBe(false);
    expect(canCheckNewOnly(cache({ entries: [] }), { first: 1 })).toBe(false);
    expect(canCheckNewOnly(cache(), { first: 1, last: 10 })).toBe(false);
    expect(canCheckNewOnly(undefined, { first: 1 })).toBe(false);
  });
});
