// Windows에서 네트워크 위치(공유 폴더)에 있는 경로인지 봅니다.
// Parallels가 맥과 같이 쓰는 바탕 화면은 Windows에서 \\Mac\Home\Desktop 같은 네트워크 경로입니다.
// 연결된 드라이브(Z: 등)는 실제 경로를 풀면 같은 꼴(\\서버\공유)이 됩니다.
export function isNetworkPath(value: string): boolean {
  const normalized = value.replace(/\//g, '\\');
  // \\?\C:\... 같은 긴 경로 표기는 로컬 경로입니다. \\?\UNC\... 는 네트워크 경로입니다.
  if (/^\\\\[?.]\\/.test(normalized)) return /^\\\\[?.]\\UNC\\/i.test(normalized);
  return normalized.startsWith('\\\\');
}
