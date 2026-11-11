import { app, net, shell } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { interpret, latestReleaseAPI, type InstallKind, type UpdateResult } from '../core/update';
import type { UpdateState } from '../shared/types';
import { log } from './log';
import type { Settings } from './settings';

export const repository = 'https://github.com/hishydrogen/Uncalive';
const releaseAPI = latestReleaseAPI(repository);
/** 이 시간 안에 다시 물으면 앞의 결과를 씁니다. 사용자가 직접 누르면 늘 새로 묻습니다. */
const fresh = 30 * 60 * 1000;
/** 시작하고 첫 화면을 다 그린 뒤에 묻고, 그다음에는 이 간격으로 묻습니다. */
const firstDelay = 8000;
const interval = 6 * 60 * 60 * 1000;

/**
 * 새 버전 확인(나무덤프와 같은 방식). 확인과 알림만 합니다. 내려받기는 기본 웹 브라우저가 하고, 설치는 사용자가 합니다.
 * GitHub에 보내는 것은 앱 이름과 버전뿐입니다.
 */
export class Updates {
  readonly state: UpdateState;
  private lastAt = 0;
  private busy?: Promise<UpdateResult>;
  private timer?: NodeJS.Timeout;
  /** '나중에'를 누른 버전입니다. 이번 실행 동안은 다시 띄우지 않습니다. */
  private later?: string;

  constructor(private readonly settings: Settings, private readonly changed: () => void) {
    this.state = { auto: settings.get<boolean>('updateCheck') ?? true, checking: false };
  }

  /**
   * Windows 설치판은 설치 폴더에 제거 프로그램(Uninstall <productName>.exe)이 있습니다. 없으면 zip으로 받은 포터블판입니다.
   * productName은 electron-builder.yml의 영문 이름입니다.
   */
  private get installKind(): InstallKind {
    if (process.platform !== 'win32') return 'installer';
    return existsSync(path.join(path.dirname(process.execPath), 'Uninstall Uncalive.exe')) ? 'installer' : 'portable';
  }

  schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.state.auto) return;
    const run = (delay: number) => {
      this.timer = setTimeout(() => {
        void this.check(false);
        run(interval);
      }, delay);
    };
    run(firstDelay);
  }

  setAuto(value: boolean): void {
    this.state.auto = value;
    this.settings.set('updateCheck', value);
    this.schedule();
    this.changed();
  }

  /** manual은 사용자가 눌렀을 때입니다. 결과를 늘 보여 주고, 건너뛴 버전도 다시 알립니다. */
  async check(manual: boolean): Promise<UpdateResult> {
    const result = await this.fetch(manual);
    if (result.ok && result.newer) {
      const skipped = this.settings.get<string>('updateSkip');
      if (manual || (result.latest !== skipped && result.latest !== this.later)) this.state.notice = result;
    }
    this.changed();
    return result;
  }

  private fetch(force: boolean): Promise<UpdateResult> {
    const last = this.state.result;
    if (!force && last?.ok && Date.now() - this.lastAt < fresh) return Promise.resolve(last);
    if (this.busy) return this.busy;
    this.state.checking = true;
    this.changed();
    this.busy = (async (): Promise<UpdateResult> => {
      if (!releaseAPI) return { ok: false, error: '저장소 주소가 없습니다.' };
      try {
        const response = await net.fetch(releaseAPI, {
          headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Uncalive/${app.getVersion()}` },
          signal: AbortSignal.timeout(15000),
          cache: 'no-store',
        });
        if (response.status === 404) return { ok: false, error: '공개된 릴리스가 없습니다.' };
        if (!response.ok) return { ok: false, error: `GitHub 응답 오류(${response.status})` };
        return interpret(await response.json(), app.getVersion(), process.platform, process.arch, this.installKind);
      } catch (error) {
        return { ok: false, error: (error as Error)?.name === 'TimeoutError' ? '응답 시간이 초과되었습니다.' : '인터넷에 연결되어 있지 않거나 GitHub에 접속하지 못했습니다.' };
      }
    })().then((result) => {
      if (result.ok) {
        this.lastAt = Date.now();
        this.state.checkedAt = this.lastAt;
      } else {
        log(`새 버전 확인 실패: ${result.error}`);
      }
      this.state.result = result;
      this.state.checking = false;
      this.busy = undefined;
      return result;
    });
    return this.busy;
  }

  /** 알림 카드를 닫습니다. skip이면 이 버전은 다음부터 알리지 않습니다. */
  dismiss(skip: boolean): void {
    const latest = this.state.notice?.latest;
    if (latest) {
      if (skip) this.settings.set('updateSkip', latest);
      else this.later = latest;
    }
    this.state.notice = undefined;
    this.changed();
  }

  /** 설치 파일을 기본 웹 브라우저로 내려받습니다. 맞는 파일이 없으면 릴리스 페이지를 엽니다. 파일을 열었는지 돌려줍니다. */
  download(): boolean {
    const release = this.state.notice ?? (this.state.result?.ok ? this.state.result : undefined);
    if (!release) return false;
    const url = release.asset?.url ?? (release.page || `${repository}/releases/latest`);
    void shell.openExternal(url);
    this.state.notice = undefined;
    this.changed();
    return release.asset !== undefined;
  }
}
