import { app } from 'electron';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
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

/**
 * 로그인 진단 기록입니다. 설치본에서도 남기지만, 로그인 단계 이름과 개수, 참거짓만 적고 토큰이나 아이디, 비밀번호는 적지 않습니다.
 * 로그인 창을 열 때마다 새로 씁니다. 로그인이 막히면 이 파일로 어느 단계에서 멈췄는지 알 수 있습니다.
 */
function loginLogFile(): string {
  return path.join(app.getPath('logs'), 'login.log');
}

export function startLoginLog(): void {
  try {
    mkdirSync(app.getPath('logs'), { recursive: true });
    writeFileSync(loginLogFile(), `${new Date().toISOString()} 로그인 창 열림 (${app.getVersion()}, ${process.platform})\n`);
  } catch {
    // 기록을 못 남겨도 로그인에는 영향이 없습니다.
  }
}

export function loginLog(text: string): void {
  try {
    appendFileSync(loginLogFile(), `${new Date().toISOString()} ${text}\n`);
  } catch {
    // 기록을 못 남겨도 로그인에는 영향이 없습니다.
  }
}
