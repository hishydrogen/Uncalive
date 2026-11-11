import { describe, expect, test } from 'vitest';
import { interpret, isNewer, latestReleaseAPI, pickAsset, summarizeNotes } from '../src/core/update';

// electron-builder가 만드는 파일 이름과 같습니다. Linux의 CPU 이름은 꼴마다 다릅니다.
const assets = [
  'Uncalive-2.1.0-Linux-arm64.AppImage', 'Uncalive-2.1.0-Linux-x86_64.AppImage',
  'Uncalive-2.1.0-Linux-arm64.deb', 'Uncalive-2.1.0-Linux-amd64.deb',
  'Uncalive-2.1.0-Linux-aarch64.rpm', 'Uncalive-2.1.0-Linux-x86_64.rpm',
  'Uncalive-2.1.0-macOS-arm64.dmg', 'Uncalive-2.1.0-macOS-arm64.zip',
  'Uncalive-2.1.0-Windows-arm64-Setup.exe', 'Uncalive-2.1.0-Windows-x64-Setup.exe',
].map((name) => ({ name, size: 100, browser_download_url: `https://github.com/hishydrogen/Uncalive/releases/download/v2.1.0/${name}` }));

describe('새 버전 확인', () => {
  test('저장소 주소에서 최신 릴리스 API 주소를 만든다', () => {
    expect(latestReleaseAPI('https://github.com/hishydrogen/Uncalive')).toBe('https://api.github.com/repos/hishydrogen/Uncalive/releases/latest');
    expect(latestReleaseAPI('https://example.com/x')).toBeUndefined();
  });

  test('버전을 숫자로 비교한다', () => {
    expect(isNewer('v2.1.0', '2.0.5')).toBe(true);
    expect(isNewer('2.10.0', '2.9.9')).toBe(true);
    expect(isNewer('v2.0.5', '2.0.5')).toBe(false);
    expect(isNewer('2.0.4', '2.0.5')).toBe(false);
    expect(isNewer('nightly', '2.0.5')).toBe(false);
  });

  test('운영체제와 CPU, 설치 꼴에 맞는 파일을 고른다', () => {
    expect(pickAsset(assets, 'darwin', 'arm64')?.name).toMatch(/macOS-arm64\.dmg$/);
    expect(pickAsset(assets, 'win32', 'x64')?.name).toMatch(/Windows-x64-Setup\.exe$/);
    expect(pickAsset(assets, 'win32', 'arm64')?.name).toMatch(/Windows-arm64-Setup\.exe$/);
    expect(pickAsset(assets, 'linux', 'x64')?.name).toMatch(/Linux-x86_64\.AppImage$/);
    expect(pickAsset(assets, 'linux', 'arm64')?.name).toMatch(/Linux-arm64\.AppImage$/);
    expect(pickAsset(assets, 'linux', 'x64', 'deb')?.name).toMatch(/Linux-amd64\.deb$/);
    expect(pickAsset(assets, 'linux', 'arm64', 'deb')?.name).toMatch(/Linux-arm64\.deb$/);
    expect(pickAsset(assets, 'linux', 'x64', 'rpm')?.name).toMatch(/Linux-x86_64\.rpm$/);
    expect(pickAsset(assets, 'linux', 'arm64', 'rpm')?.name).toMatch(/Linux-aarch64\.rpm$/);
    // 인텔 맥용은 만들지 않으므로 릴리스 페이지로 보냅니다.
    expect(pickAsset(assets, 'darwin', 'x64')).toBeUndefined();
    // GitHub 밖 주소는 쓰지 않습니다.
    expect(pickAsset([{ name: 'Uncalive-2.1.0-Windows-x64-Setup.exe', browser_download_url: 'https://evil.example/x.exe' }], 'win32', 'x64')).toBeUndefined();
  });

  test('변경 내용을 줄 단위 글로 바꾼다', () => {
    expect(summarizeNotes('## 새 기능\n- **업데이트 확인** 추가\n- [링크](https://x) 목록\n\n---\n## 고친 점\n')).toEqual([
      { head: true, text: '새 기능' }, { head: false, text: '업데이트 확인 추가' }, { head: false, text: '링크 목록' },
    ]);
    expect(summarizeNotes(Array.from({ length: 40 }, (_, index) => `- ${index}`).join('\n'))).toHaveLength(40);
  });

  test('릴리스 응답을 해석한다', () => {
    const result = interpret({ tag_name: 'v2.1.0', html_url: 'https://github.com/hishydrogen/Uncalive/releases/tag/v2.1.0', body: '- 하나', assets }, '2.0.5', 'win32', 'x64');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.newer).toBe(true);
    expect(result.latest).toBe('2.1.0');
    expect(result.asset?.url).toMatch(/Windows-x64-Setup\.exe$/);
    expect(interpret({ tag_name: 'v3.0.0', prerelease: true }, '2.0.5', 'win32', 'x64').ok).toBe(false);
    expect(interpret({ tag_name: 'v3.0.0', draft: true }, '2.0.5', 'win32', 'x64').ok).toBe(false);
    expect(interpret(null, '2.0.5', 'win32', 'x64').ok).toBe(false);
  });
});
