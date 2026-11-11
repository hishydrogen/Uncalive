/**
 * 새 버전 확인: GitHub Releases의 최신 공개 릴리스(초안, 사전 릴리스 제외)를 보고 알리기만 합니다.
 * 맥은 임시 서명이라 자동 설치(electron-updater)를 쓸 수 없어서, 세 운영체제 모두 내려받을 파일 링크만 건넵니다.
 * 요청은 메인 프로세스(main/updates.ts)가 하고, 여기에는 응답을 해석하는 부분만 둡니다(나무덤프와 같은 방식).
 */

export interface UpdateAsset {
  name: string;
  url: string;
  size: number;
}

/** 변경 내용의 한 줄입니다. 제목 줄이면 head가 참입니다. 화면은 글자로만 넣습니다(HTML로 해석하지 않음). */
export interface UpdateNote {
  head: boolean;
  text: string;
}

export interface UpdateRelease {
  current: string;
  latest: string;
  newer: boolean;
  name: string;
  published: string;
  /** 릴리스 페이지입니다. GitHub 주소가 아니면 비웁니다. */
  page: string;
  /** 이 운영체제와 CPU에 맞는 설치 파일입니다. 없으면 릴리스 페이지로 보냅니다. */
  asset?: UpdateAsset;
  notes: UpdateNote[];
}

export type UpdateResult = ({ ok: true } & UpdateRelease) | { ok: false; error: string };

/** Linux에서 어떤 꼴로 설치했는지입니다. 같은 꼴의 새 파일을 알려 줍니다. */
export type LinuxPackage = 'appimage' | 'deb' | 'rpm';

/** GitHub 저장소 주소(package.json의 homepage) → 최신 릴리스 API 주소 */
export function latestReleaseAPI(homepage: string | undefined): string | undefined {
  const match = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(homepage ?? ''));
  return match ? `https://api.github.com/repos/${match[1]}/${match[2]}/releases/latest` : undefined;
}

/** 'v2.1.0' 같은 꼬리표에서 숫자 세 개를 읽습니다. 못 읽으면 없습니다. */
export function parseVersion(version: string | undefined): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** 글자가 아니라 숫자로 비교합니다(2.10.0 > 2.9.9). */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}

interface RawAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}

/**
 * 운영체제와 CPU에 맞는 파일을 고릅니다. 이름은 electron-builder.yml의 artifactName 규칙을 따릅니다.
 * Uncalive-<버전>-macOS-arm64.dmg, -Windows-x64-Setup.exe, -Linux-x86_64.AppImage, -Linux-amd64.deb, -Linux-x86_64.rpm
 * Linux의 CPU 이름은 꼴마다 다릅니다(x64: AppImage·rpm은 x86_64, deb는 amd64 / arm64: rpm은 aarch64).
 */
export function pickAsset(assets: unknown, platform: string, arch: string, linux: LinuxPackage = 'appimage'): UpdateAsset | undefined {
  const list = Array.isArray(assets) ? (assets as RawAsset[]) : [];
  let pattern: RegExp | undefined;
  if (platform === 'darwin') pattern = new RegExp(`-macOS-${arch}\\.dmg$`, 'i');
  else if (platform === 'win32') pattern = new RegExp(`-Windows-${arch}-Setup\\.exe$`, 'i');
  else if (platform === 'linux') {
    const cpu = arch === 'x64' ? '(x64|x86_64|amd64)' : arch === 'arm64' ? '(arm64|aarch64)' : arch;
    const extension = linux === 'deb' ? 'deb' : linux === 'rpm' ? 'rpm' : 'AppImage';
    pattern = new RegExp(`-Linux-${cpu}\\.${extension}$`, 'i');
  }
  const found = pattern && list.find((item) => item && pattern.test(String(item.name ?? '')));
  const url = found ? String(found.browser_download_url ?? '') : '';
  // GitHub 밖의 주소는 쓰지 않습니다.
  return found && url.startsWith('https://github.com/') ? { name: String(found.name), url, size: Number(found.size) || 0 } : undefined;
}

/** 릴리스 설명(마크다운)을 줄 단위 글로 바꿉니다. 자르지 않고 전부 넘기며, 화면의 알림 카드 안에서 스크롤합니다. */
export function summarizeNotes(body: unknown): UpdateNote[] {
  const lines: UpdateNote[] = [];
  for (let line of String(body ?? '').replace(/\r/g, '').split('\n')) {
    line = line.replace(/<!--[\s\S]*?-->/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]{1,3}([^*_`]+)[*_`]{1,3}/g, '$1').trim();
    if (!line || /^([-*_=]\s*){3,}$/.test(line)) continue;
    const head = /^#{1,6}\s+(.*)$/.exec(line);
    if (head) {
      lines.push({ head: true, text: head[1] });
      continue;
    }
    lines.push({ head: false, text: line.replace(/^([-*+]|\d+\.)\s+/, '') });
  }
  // 내용 없이 끝에 걸린 제목은 뺍니다.
  while (lines.length > 0 && lines[lines.length - 1].head) lines.pop();
  return lines;
}

interface RawRelease {
  draft?: unknown;
  prerelease?: unknown;
  tag_name?: unknown;
  html_url?: unknown;
  name?: unknown;
  published_at?: unknown;
  body?: unknown;
  assets?: unknown;
}

/** API 응답 → 화면에 넘길 결과 */
export function interpret(value: unknown, current: string, platform: string, arch: string, linux: LinuxPackage = 'appimage'): UpdateResult {
  const release = (value && typeof value === 'object' ? value : {}) as RawRelease;
  if (release.draft || release.prerelease || !release.tag_name) return { ok: false, error: '릴리스 정보를 읽을 수 없습니다.' };
  const latest = String(release.tag_name).replace(/^v/, '');
  const page = String(release.html_url ?? '');
  return {
    ok: true,
    current,
    latest,
    newer: isNewer(latest, current),
    name: String(release.name ?? ''),
    published: String(release.published_at ?? ''),
    page: page.startsWith('https://github.com/') ? page : '',
    asset: pickAsset(release.assets, platform, arch, linux),
    notes: summarizeNotes(release.body),
  };
}
