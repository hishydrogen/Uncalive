import { sanitize } from './naming';

export interface AccountInfo {
  /** 저장 위치 기준 보관함 폴더 이름입니다. */
  folder?: string;
  nickname?: string;
}

/**
 * 계정의 보관함 폴더를 고릅니다. 예전처럼 닉네임 이름의 보관함이 있고 다른 계정이 쓰고 있지 않으면 그대로 이어 쓰고,
 * 아니면 바뀌지 않는 아이디 이름으로 만듭니다. 대소문자만 다른 이름은 같은 폴더로 봅니다(macOS, Windows).
 */
export function chooseAccountFolder(
  loginID: string,
  nickname: string,
  accounts: Record<string, AccountInfo>,
  folderExists: (name: string) => boolean,
): string {
  const legacy = sanitize(nickname, 60);
  const claimed = Object.entries(accounts).some(([id, other]) => id !== loginID && other.folder?.toLowerCase() === legacy.toLowerCase());
  if (legacy !== '' && !claimed && folderExists(legacy)) return legacy;
  return sanitize(loginID, 60);
}
