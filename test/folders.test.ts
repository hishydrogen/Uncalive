import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { migrateGuestFolder, migrateLibraryFolders } from '../src/core/folders';
import { sourceOfFolder } from '../src/core/options';
import { exists, temporaryDirectory } from './support';

function library(posts: Record<string, string>) {
  const root = temporaryDirectory();
  for (const folder of Object.values(posts)) {
    mkdirSync(path.join(root, ...folder.split('/')), { recursive: true });
    writeFileSync(path.join(root, ...folder.split('/'), '01.jpg'), 'x');
  }
  mkdirSync(path.join(root, '.uncalive'), { recursive: true });
  const state = { version: 1, posts: Object.fromEntries(Object.entries(posts).map(([id, folder]) => [id, { id, folder, title: id, completed: true, files: { k: '01.jpg' }, updatedAt: '2026-11-08T00:00:00Z' }])) };
  writeFileSync(path.join(root, '.uncalive', 'state.json'), JSON.stringify(state));
  return root;
}
const folders = (root: string) => Object.fromEntries(Object.entries(JSON.parse(readFileSync(path.join(root, '.uncalive', 'state.json'), 'utf8')).posts).map(([id, record]) => [id, (record as { folder: string }).folder]));

describe('한글 폴더를 영문으로 옮기기', () => {
  test('글 폴더를 옮기고 기록의 경로도 고친다', () => {
    const root = library({ a: '스크랩/첫 글', b: '주소 수집/둘째 글', c: '주소 수집/채널/셋째 글', d: '그냥 글' });
    expect(migrateLibraryFolders(root)).toBe(3);
    expect(folders(root)).toEqual({ a: 'Scraps/첫 글', b: 'Links/둘째 글', c: 'Links/채널/셋째 글', d: '그냥 글' });
    expect(exists(root, 'Scraps/첫 글/01.jpg')).toBe(true);
    expect(exists(root, 'Links/채널/셋째 글/01.jpg')).toBe(true);
    expect(exists(root, '스크랩')).toBe(false);
    expect(exists(root, '주소 수집')).toBe(false);
    expect(sourceOfFolder('Links/둘째 글')).toBe('link');
  });

  test('같은 이름이 이미 있으면 덮어쓰지 않고 그 글만 둔다', () => {
    const root = library({ a: '스크랩/같은 글', b: 'Scraps/같은 글', c: '스크랩/다른 글' });
    expect(migrateLibraryFolders(root)).toBe(1);
    expect(folders(root)).toEqual({ a: '스크랩/같은 글', b: 'Scraps/같은 글', c: 'Scraps/다른 글' });
    expect(sourceOfFolder('스크랩/같은 글')).toBe('scrap');
  });

  test('두 번 해도 아무것도 바꾸지 않는다', () => {
    const root = library({ a: '스크랩/첫 글' });
    migrateLibraryFolders(root);
    expect(migrateLibraryFolders(root)).toBe(0);
    expect(folders(root)).toEqual({ a: 'Scraps/첫 글' });
  });

  test('로그인 안 함 보관함을 Guest로 옮긴다', () => {
    const destination = temporaryDirectory();
    mkdirSync(path.join(destination, '로그인 안 함', '.uncalive'), { recursive: true });
    expect(migrateGuestFolder(destination, 'Guest')).toBe(true);
    expect(exists(destination, 'Guest/.uncalive')).toBe(true);
    expect(migrateGuestFolder(destination, 'Guest')).toBe(false);
  });
});
