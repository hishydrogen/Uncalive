import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { legacySourceFolders, sourceFolders, archiveSources } from './options';
import { stateFile } from './resume';

/**
 * 2.0.0 이전의 한글 폴더(스크랩, 주소 수집)를 영문 폴더(Scraps, Links)로 옮기고 받은 기록의 경로도 함께 고칩니다.
 * 이미 같은 이름이 있으면 덮어쓰지 않고 그 글만 그대로 둡니다. 옮긴 글 폴더 수를 돌려줍니다.
 */
export function migrateLibraryFolders(root: string): number {
  let state: { version?: number; posts?: Record<string, { folder: string }> } | undefined;
  const file = stateFile(root);
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    state = undefined;
  }
  let moved = 0;
  for (const source of archiveSources) {
    const legacy = legacySourceFolders[source];
    const next = sourceFolders[source];
    const from = path.join(root, legacy);
    if (!existsSync(from)) continue;
    const to = path.join(root, next);
    mkdirSync(to, { recursive: true });
    for (const child of readdirSync(from)) {
      if (child === '.DS_Store') continue;
      if (existsSync(path.join(to, child))) continue;
      renameSync(path.join(from, child), path.join(to, child));
      moved += 1;
      const oldPrefix = `${legacy}/${child}`;
      for (const record of Object.values(state?.posts ?? {})) {
        if (record.folder === oldPrefix || record.folder.startsWith(oldPrefix + '/')) {
          record.folder = `${next}/${child}` + record.folder.slice(oldPrefix.length);
        }
      }
    }
    try {
      const rest = readdirSync(from).filter((name) => name !== '.DS_Store');
      if (rest.length === 0) {
        if (existsSync(path.join(from, '.DS_Store'))) renameSync(path.join(from, '.DS_Store'), path.join(to, '.DS_Store.old'));
        rmdirSync(from);
      }
    } catch {
      // 비우지 못해도 옮긴 글은 새 폴더에서 그대로 쓸 수 있습니다.
    }
  }
  if (moved > 0 && state) {
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state, null, 2));
    renameSync(temporary, file);
  }
  return moved;
}

/** 저장 위치 바로 아래의 '로그인 안 함' 보관함을 'Guest'로 옮깁니다. 이미 있으면 그대로 둡니다. */
export function migrateGuestFolder(destination: string, guest: string): boolean {
  const from = path.join(destination, '로그인 안 함');
  const to = path.join(destination, guest);
  if (!existsSync(from) || existsSync(to)) return false;
  renameSync(from, to);
  return true;
}
