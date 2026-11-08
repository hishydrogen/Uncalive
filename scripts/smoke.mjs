// 빌드한 앱을 실제로 띄워 화면을 한 바퀴 돌아봅니다. 네트워크를 쓰지 않으며, 임시 폴더의 프로필과 보관함만 씁니다.
// 사용법: node scripts/smoke.mjs [스크린샷 폴더]
import { mkdtempSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

const shots = process.argv[2];
if (shots) mkdirSync(shots, { recursive: true });
const sandbox = mkdtempSync(path.join(os.tmpdir(), 'uncalive-smoke-'));
const app = await electron.launch({
  args: ['.'],
  env: { ...process.env, UNCALIVE_PROFILE_DIR: path.join(sandbox, 'profile'), UNCALIVE_DEFAULT_FOLDER: path.join(sandbox, 'library') },
});
const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
  console.log(`${condition ? '통과' : '실패'}: ${message}`);
};

try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.waitForSelector('.sidebar', { timeout: 15000 });
  // 화면 캡처는 참고용입니다. 가상 화면처럼 캡처가 안 되는 곳에서도 확인은 계속합니다.
  const snap = async (name) => {
    if (!shots) return;
    await page.screenshot({ path: path.join(shots, `${name}.png`) }).catch((error) => console.log(`캡처 못 함(${name}): ${error.message.split('\n')[0]}`));
  };

  await page.waitForSelector('text=로그인이 필요합니다', { timeout: 15000 });
  check(true, '로그인 전 안내 화면이 보인다');
  await snap('1-scraps');
  const sees = (selector) => page.locator(selector).first().waitFor({ timeout: 5000 }).then(() => true, () => false);

  await page.click('.nav-item:has-text("주소 수집")');
  await page.waitForSelector('text=수집한 글이 없습니다');
  await page.click('button:has-text("주소 추가")');
  await page.fill('.dialog textarea', 'https://arca.live/b/test/123\narca.live/b/test/456 https://example.com/x');
  check(await sees('text=인식된 주소 2개'), '붙여 넣은 글 주소를 알아본다');
  await page.fill('.dialog textarea', 'https://arca.live/b/test/123\nhttps://arca.live/b/test?mode=best');
  check(await sees('text=목록을 불러올 범위'), '목록 주소면 범위를 묻는다');
  await snap('2-add-dialog');
  await page.fill('.dialog textarea', 'https://arca.live/b/test/123\narca.live/b/test/456');
  await page.click('.dialog button.primary');
  await page.waitForSelector('td.title:has-text("글 456")');
  check((await page.locator('tbody tr').count()) === 2, '주소로 더한 글이 목록에 보인다');
  check(await sees('text=2개 선택됨'), '새로 더한 글은 골라져 있다');
  await page.click('td.title:has-text("글 123")');
  check(await sees('text=1개 선택됨'), '줄을 누르면 선택이 바뀐다');
  await snap('3-collection');

  await page.click('button[aria-label="목록에서 제거"] >> nth=0');
  await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1);
  check(true, '줄 끝 버튼으로 글을 뺀다');

  await page.click('.nav-item:has-text("다운로드")');
  check(await sees('text=진행 중인 다운로드가 없습니다'), '다운로드 화면');
  await page.click('.nav-item:has-text("보관함")');
  check(await sees('text=받은 글이 없습니다'), '보관함 화면');
  await page.click('.nav-item:has-text("갤러리")');
  check(await sees('text=표시할 미디어가 없습니다'), '갤러리 화면');
  await page.click('.nav-item:has-text("설정")');
  check(await sees('text=계정마다 보관함 나누기'), '설정 화면');
  await snap('4-settings');
  await page.click('.segmented button:has-text("속도")');
  check(await sees('text=원본 서버는 자체 연결 제한에 맞춰'), '설정의 속도 탭');
  await page.click('.segmented button:has-text("미디어")');
  await page.click('.segmented button:has-text("균형")');
  await page.waitForSelector('text=가로 1280px보다 큰 이미지만');
  check(true, '화질을 바꾸면 설명이 바뀐다');

  check(errors.length === 0, `화면 오류가 없다${errors.length ? ': ' + errors.join(' / ') : ''}`);
} catch (error) {
  failures.push(String(error));
  console.error(error);
} finally {
  await app.close();
}

console.log(failures.length === 0 ? '모두 통과했습니다.' : `${failures.length}개 실패`);
process.exit(failures.length === 0 ? 0 : 1);
