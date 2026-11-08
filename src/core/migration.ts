import { fileURLToPath } from 'node:url';
import type { DownloadOptions } from './options';

/** 예전 맥 앱(Swift)의 설정 가운데 새 앱이 이어받는 값입니다. */
export interface LegacySettings {
  options?: Partial<DownloadOptions>;
  useAccountFolder?: boolean;
  username?: string;
  autoCheckHours?: number;
  autoDownloadNewScraps?: boolean;
}

type PlistValue = string | number | boolean | Buffer;

/** `defaults export`가 내놓는 XML에서 맨 위 사전의 단순한 값만 읽습니다. */
export function parsePlist(xml: string): Record<string, PlistValue> {
  const result: Record<string, PlistValue> = {};
  const body = xml.match(/<dict>([\s\S]*)<\/dict>/)?.[1] ?? '';
  const pattern = /<key>([^<]*)<\/key>\s*(?:<(string|integer|real|data)>([\s\S]*?)<\/\2>|<(true|false)\s*\/>|<(string|data)\s*\/>)/g;
  for (const match of body.matchAll(pattern)) {
    const key = decode(match[1]);
    const [, , type, value, flag, empty] = match;
    if (flag) result[key] = flag === 'true';
    else if (empty) result[key] = empty === 'data' ? Buffer.alloc(0) : '';
    else if (type === 'integer' || type === 'real') result[key] = Number(value);
    else if (type === 'data') result[key] = Buffer.from(value.replace(/\s+/g, ''), 'base64');
    else result[key] = decode(value);
  }
  return result;
}

function decode(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');
}

/** 예전 앱은 저장 위치를 파일 주소(`file:///…`)로 저장했습니다. */
function pathOf(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value : (value as { relative?: string } | undefined)?.relative;
  if (!raw) return undefined;
  try {
    // 예전 설정은 맥에서만 오므로 어느 운영체제에서 읽든 맥 경로로 바꿉니다.
    return raw.startsWith('file:') ? fileURLToPath(raw, { windows: false }) : raw;
  } catch {
    return undefined;
  }
}

export function legacySettings(values: Record<string, PlistValue>): LegacySettings {
  const result: LegacySettings = {};
  for (const key of ['downloadOptions.v3', 'downloadOptions.v2']) {
    const data = values[key];
    if (!Buffer.isBuffer(data)) continue;
    try {
      const decoded = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      const { destination, source: _source, ...rest } = decoded;
      const options = rest as Partial<DownloadOptions>;
      // v2는 저장 위치의 뜻이 달랐으므로 다른 옵션만 이어받습니다.
      const folder = key === 'downloadOptions.v3' ? pathOf(destination) : undefined;
      if (folder) options.destination = folder;
      result.options = options;
      break;
    } catch {
      continue;
    }
  }
  if (typeof values.useAccountFolder === 'boolean') result.useAccountFolder = values.useAccountFolder;
  if (typeof values.username === 'string' && values.username !== '') result.username = values.username;
  if (typeof values.autoCheckHours === 'number') result.autoCheckHours = values.autoCheckHours;
  if (typeof values.autoDownloadNewScraps === 'boolean') result.autoDownloadNewScraps = values.autoDownloadNewScraps;
  return result;
}
