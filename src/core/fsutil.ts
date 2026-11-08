import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** 맥판과 같은 형식(소수점 없는 ISO 8601)으로 날짜를 씁니다. 맥판은 소수점이 있으면 읽지 못합니다. */
export function isoDate(date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * 임시 파일에 쓴 뒤 바꿔치기합니다. Windows에서는 백신이나 색인 프로그램이 파일을 잠깐 붙잡아
 * 바꿔치기가 실패할 수 있어 몇 번 다시 시도합니다.
 */
export async function writeAtomic(target: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, data);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temporary, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) {
        await fs.rm(temporary, { force: true });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** 키를 정렬해 사람이 읽기 좋은 JSON으로 씁니다. */
export function sortedJSON(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) result[key] = sortKeys(item);
    }
    return result;
  }
  return value;
}

/** 저장 폴더 기준 상대 경로(`/` 구분)를 실제 경로로 바꿉니다. */
export function resolveRelative(root: string, relative: string): string {
  return path.join(root, ...relative.split('/'));
}
