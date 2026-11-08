import { app } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { writeAtomic } from '../core/fsutil';
import { legacySettings, parsePlist } from '../core/migration';
import { log } from './log';

/**
 * 맥에서 처음 실행하면 예전 맥 앱(Swift)의 설정을 가져옵니다. 저장 위치와 다운로드 옵션이 이어지므로
 * 받은 보관함을 그대로 씁니다. 로그인 세션은 가져올 수 없어 한 번 다시 로그인해야 합니다.
 */
export async function importLegacySettings(bundleID: string): Promise<void> {
  const file = path.join(app.getPath('userData'), 'settings.json');
  if (process.platform !== 'darwin' || existsSync(file)) return;
  let xml: string;
  try {
    xml = (await promisify(execFile)('/usr/bin/defaults', ['export', bundleID, '-'])).stdout;
  } catch {
    return;
  }
  const legacy = legacySettings(parsePlist(xml));
  const values: Record<string, unknown> = {
    downloadOptions: legacy.options,
    useAccountFolder: legacy.useAccountFolder,
    username: legacy.username,
    autoCheckHours: legacy.autoCheckHours,
    autoDownloadNewScraps: legacy.autoDownloadNewScraps,
  };
  for (const key of Object.keys(values)) if (values[key] === undefined) delete values[key];
  if (Object.keys(values).length === 0) return;
  await writeAtomic(file, JSON.stringify({ ...values, importedFromMacApp: true }, null, 2)).catch(() => undefined);
  log(`예전 맥 앱 설정 ${Object.keys(values).length}개를 가져왔습니다.`);
}
