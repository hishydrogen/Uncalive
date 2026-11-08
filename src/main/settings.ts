import { app } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { writeAtomic } from '../core/fsutil';

/** 앱 설정을 사용자 데이터 폴더의 `settings.json` 하나에 저장합니다. */
export class Settings {
  private readonly file = path.join(app.getPath('userData'), 'settings.json');
  private values: Record<string, unknown> = {};
  private pending?: NodeJS.Timeout;

  constructor() {
    try {
      this.values = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
    } catch {
      this.values = {};
    }
  }

  get<T>(key: string): T | undefined {
    return this.values[key] as T | undefined;
  }

  set(key: string, value: unknown): void {
    if (value === undefined) delete this.values[key];
    else this.values[key] = value;
    // 슬라이더처럼 값이 연달아 바뀌어도 한 번만 씁니다.
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => void this.flush(), 300);
  }

  async flush(): Promise<void> {
    if (this.pending) clearTimeout(this.pending);
    this.pending = undefined;
    await writeAtomic(this.file, JSON.stringify(this.values, null, 2)).catch(() => undefined);
  }
}
