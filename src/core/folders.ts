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

export interface SharedLibraryMove {
  /** 옮긴 곳(저장 위치 안의 폴더 이름)입니다. */
  folder: string;
  /** 옮긴 항목(글 폴더와 기록 폴더)의 수입니다. */
  moved: number;
  /** 같은 이름이 이미 있거나 잠겨 있어 옮기지 못한 항목입니다. 다음 실행 때 다시 시도합니다. */
  failed: string[];
}

/**
 * 2.1.0 이전에 '계정마다 보관함 나누기'를 끄고 쓰던 보관함(저장 위치 바로 아래)을 한 폴더(예: Legacy)로 옮깁니다.
 * 저장 위치에는 사용자가 둔 다른 파일이 있을 수 있으므로, 받은 기록에 있는 글 폴더와 앱이 만든 폴더, 기록 폴더(.uncalive)만 옮깁니다.
 * 계정 보관함(keep)은 건드리지 않습니다. 기록의 경로는 보관함 기준이므로 함께 옮기면 고칠 필요가 없습니다.
 * 기록 폴더는 글 폴더를 모두 옮긴 뒤에 마지막으로 옮겨, 도중에 실패해도 다음에 이어서 옮길 수 있게 합니다.
 * 옮길 것이 없으면 undefined를 돌려줍니다.
 */
export function moveSharedLibrary(destination: string, folder: string, keep: Iterable<string>): SharedLibraryMove | undefined {
  const keepNames = new Set([...keep, folder].map((name) => name.normalize('NFC')));
  const names = new Set<string>([...Object.values(sourceFolders), ...Object.values(legacySourceFolders)]);
  try {
    const state = JSON.parse(readFileSync(stateFile(destination), 'utf8')) as { posts?: Record<string, { folder?: unknown }> };
    for (const record of Object.values(state.posts ?? {})) {
      if (typeof record.folder === 'string' && record.folder !== '') names.add(record.folder.split('/')[0]);
    }
  } catch {
    // 기록이 없으면 앱이 만든 폴더만 옮깁니다.
  }
  const candidates = [...names].filter((name) => !keepNames.has(name.normalize('NFC')) && name !== '.uncalive' && name !== '..' && name !== '.' && existsSync(path.join(destination, name)));
  const records = path.join(destination, '.uncalive');
  if (candidates.length === 0 && !existsSync(records)) return undefined;

  const target = path.join(destination, folder);
  mkdirSync(target, { recursive: true });
  const result: SharedLibraryMove = { folder, moved: 0, failed: [] };
  const move = (name: string) => {
    if (existsSync(path.join(target, name))) {
      result.failed.push(name);
      return;
    }
    try {
      renameSync(path.join(destination, name), path.join(target, name));
      result.moved += 1;
    } catch {
      result.failed.push(name);
    }
  };
  candidates.forEach(move);
  if (existsSync(records)) {
    if (result.failed.length === 0) move('.uncalive');
    else result.failed.push('.uncalive');
  }
  return result;
}
