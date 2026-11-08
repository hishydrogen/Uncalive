import { app } from 'electron';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

/**
 * 개발 빌드 전용 진단 로그입니다. 쿠키 값이나 입력값, 글 제목 같은 민감한 정보는 기록하지 않으며,
 * 설치본에서는 아무 기록도 남기지 않습니다.
 */
export function log(text: string): void {
  if (app.isPackaged) return;
  try {
    const folder = app.getPath('logs');
    mkdirSync(folder, { recursive: true });
    appendFileSync(path.join(folder, 'debug.log'), `${new Date().toISOString()} ${text}\n`);
  } catch {
    // 로그를 못 남겨도 앱 동작에는 영향이 없습니다.
  }
}
