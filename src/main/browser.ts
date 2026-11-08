import { app, BrowserWindow, session as electronSession, type Session } from 'electron';
import { CancellationError, UncaliveError } from '../core/models';
import type { LoadedPage, PageKind, PageSource } from '../core/engine';
import { log } from './log';

const sessionCookie = 'arca.at';

function stateScript(selector: string): string {
  return `(function () {
  const title = document.title || '';
  if (/just a moment|잠시만 기다|attention required/i.test(title) ||
      document.querySelector('#challenge-form, #challenge-stage, #challenge-error-text')) return 'challenge';
  if (document.readyState !== 'loading' && document.querySelector(${JSON.stringify(selector)})) return 'ready';
  return 'waiting';
})()`;
}

/** 페이지를 읽는 동안 아카라이브와 Cloudflare 확인 화면 외의 제3자 요청과 사이트의 광고 API를 막습니다. */
function isBlocked(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!parsed.protocol.startsWith('http')) return false;
  const host = parsed.hostname;
  if (host === 'arca.live' || host.endsWith('.arca.live')) {
    return host === 'arca.live' && parsed.pathname.startsWith('/api/v1/pagead');
  }
  return host !== 'challenges.cloudflare.com';
}

/**
 * 로그인에 쓰는 브라우저 창입니다. 로그인이나 Cloudflare 확인이 필요할 때만 보이고, 평소에는 숨긴 채 페이지를 읽습니다.
 * 확인 화면이 나오면 통과를 대신하지 않고, 사용자가 직접 통과할 때까지 기다립니다.
 */
export class BrowserController implements PageSource {
  readonly session: Session;
  onLoginDetected?: () => void;
  onChallengeChanged?: (active: boolean) => void;
  challengeTimeout = 300_000;
  pageTimeout = 30_000;

  private window?: BrowserWindow;
  private privacy = true;
  private waitingForLogin = false;
  private loginWatch?: NodeJS.Timeout;
  private committed = false;
  private finished = false;
  private status = 0;
  /** 페이지는 한 번에 하나씩만 읽습니다. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.session = electronSession.fromPartition('persist:uncalive');
    this.session.setUserAgent(BrowserController.userAgent(this.session.getUserAgent()));
    this.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: this.privacy && isBlocked(details.url) });
    });
    // 아카라이브가 요청하는 알림, 위치 같은 권한은 주지 않습니다.
    this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  }

  /**
   * Electron 기본 형식 그대로 앱과 Electron을 밝힙니다. 앱 이름은 HTTP 헤더에 쓸 수 있게 영문으로 둡니다.
   * Electron 표시를 빼고 Chrome인 척하면 다른 브라우저 정보와 어긋나 Cloudflare 확인(Turnstile)이 끝나지 않습니다.
   */
  static userAgent(base: string): string {
    // Electron이 'Chrome/' 앞에 넣는 앱 이름(개발본은 UncaliveDev, 설치본은 한글 이름)과 뒤쪽의 Electron 표시를 지운 뒤 정해진 자리에 다시 넣습니다.
    const plain = base
      .replace(/\(KHTML, like Gecko\) .*?Chrome\//, '(KHTML, like Gecko) Chrome/')
      .replace(/\s(Electron|Uncalive)\/\S+/g, '');
    return plain.replace(/ Safari\//, ` Uncalive/${app.getVersion()} Electron/${process.versions.electron} Safari/`);
  }

  private ensureWindow(): BrowserWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = new BrowserWindow({
      width: 1000,
      height: 760,
      show: false,
      title: '아카라이브',
      autoHideMenuBar: true,
      webPreferences: {
        session: this.session,
        // 창이 숨겨져 있어도 페이지가 멈추지 않게 합니다.
        backgroundThrottling: false,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    window.webContents.setAudioMuted(true);
    // 새 창을 여는 링크도 같은 창에서 엽니다.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void window.loadURL(url).catch(() => undefined);
      return { action: 'deny' };
    });
    window.webContents.on('did-navigate', (_event, _url, code) => {
      this.committed = true;
      this.status = code;
    });
    window.webContents.on('did-finish-load', () => { this.finished = true; });
    window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      // -3은 다른 이동으로 이전 이동이 취소된 경우입니다.
      if (isMainFrame && code !== -3) this.finished = true;
    });
    window.webContents.on('page-title-updated', (event) => event.preventDefault());
    // 창을 닫아도 세션이 남도록 숨기기만 합니다.
    window.on('close', (event) => {
      if ((global as { quitting?: boolean }).quitting) return;
      event.preventDefault();
      window.hide();
      void this.loginWindowClosed();
    });
    this.window = window;
    return window;
  }

  destroy(): void {
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
  }

  enablePrivacyRules(): void {
    this.privacy = true;
  }

  // MARK: - 페이지 읽기

  load(url: string, kind: PageKind, signal?: AbortSignal): Promise<LoadedPage> {
    const task = this.queue.then(() => this.loadNow(url, kind, signal));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async loadNow(url: string, kind: PageKind, signal?: AbortSignal): Promise<LoadedPage> {
    const window = this.ensureWindow();
    const contents = window.webContents;
    this.committed = false;
    this.finished = false;
    this.status = 0;
    contents.loadURL(url).catch(() => undefined);

    const selector = kind === 'scrapList' ? '.article-list' : '.article-content, .fr-view';
    let deadline = Date.now() + this.pageTimeout;
    let inChallenge = false;
    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new CancellationError();
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (!this.committed) continue;

        const state = await this.evaluate<string>(stateScript(selector)) ?? 'loading';
        if (state === 'challenge') {
          if (!inChallenge) {
            inChallenge = true;
            this.onChallengeChanged?.(true);
            deadline = Date.now() + this.challengeTimeout;
          }
        } else if (state === 'ready') {
          const html = await this.evaluate<string>('document.documentElement.outerHTML');
          if (html !== undefined) return { html, status: this.status === 0 ? 200 : this.status };
        } else {
          if (inChallenge) {
            inChallenge = false;
            this.onChallengeChanged?.(false);
            deadline = Date.now() + this.pageTimeout;
          }
          if (this.finished && this.status >= 400) {
            const html = await this.evaluate<string>('document.documentElement.outerHTML');
            if (html !== undefined) return { html, status: this.status };
          }
        }
      }
      throw inChallenge ? UncaliveError.challengeTimedOut() : UncaliveError.pageTimedOut(url);
    } finally {
      if (inChallenge) this.onChallengeChanged?.(false);
    }
  }

  private async evaluate<T>(script: string): Promise<T | undefined> {
    const window = this.window;
    if (!window || window.isDestroyed()) return undefined;
    try {
      return await window.webContents.executeJavaScript(script, true) as T;
    } catch {
      return undefined;
    }
  }

  async userAgent(): Promise<string | undefined> {
    return this.session.getUserAgent();
  }

  async saveWebArchive(target: string): Promise<void> {
    await this.ensureWindow().webContents.savePage(target, 'MHTML');
  }

  // MARK: - 로그인

  showLogin(): void {
    this.waitingForLogin = true;
    // 로그인 절차가 쓰는 외부 요소가 막히지 않도록 이 화면에서만 끕니다.
    this.privacy = false;
    const window = this.ensureWindow();
    window.setTitle('아카라이브 로그인');
    window.webContents.setAudioMuted(false);
    // goto가 없으면 사이트가 로그인 뒤 /u/null(404)로 이동합니다.
    void window.loadURL('https://arca.live/u/login?goto=%2F').catch(() => undefined);
    this.present();
    this.watchForLogin();
  }

  /** 로그인 뒤 사이트가 다음 화면으로 넘어가지 않아도 알 수 있게 세션 쿠키를 직접 살핍니다. */
  private watchForLogin(): void {
    if (this.loginWatch) clearInterval(this.loginWatch);
    void this.sessionValue().then((previous) => {
      let busy = false;
      this.loginWatch = setInterval(async () => {
        if (!this.waitingForLogin || busy) return;
        busy = true;
        try {
          // 로그인 페이지에는 손대지 않습니다. Turnstile 함수를 바꾸면 Cloudflare가 변조로 보고 확인을 끝내지 않습니다.
          const current = await this.sessionValue();
          if (current !== undefined && current !== previous) this.finishLogin();
        } finally {
          busy = false;
        }
      }, 500);
    });
  }

  private finishLogin(): void {
    if (!this.waitingForLogin) return;
    log('로그인 감지: 세션 쿠키 변경');
    this.waitingForLogin = false;
    if (this.loginWatch) clearInterval(this.loginWatch);
    this.privacy = true;
    this.hide();
    this.onLoginDetected?.();
  }

  /** 로그인 창을 닫으면 그 시점의 로그인 여부를 확인합니다. */
  private async loginWindowClosed(): Promise<void> {
    if (!this.waitingForLogin) return;
    if (await this.hasSession()) {
      this.finishLogin();
    } else {
      this.waitingForLogin = false;
      if (this.loginWatch) clearInterval(this.loginWatch);
      this.privacy = true;
    }
  }

  showChallenge(): void {
    this.ensureWindow().setTitle('Cloudflare 보안 확인을 완료해 주세요');
    this.present();
  }

  hide(): void {
    const window = this.window;
    if (window && !window.isDestroyed()) {
      window.hide();
      window.webContents.setAudioMuted(true);
    }
  }

  private present(): void {
    const window = this.ensureWindow();
    window.show();
    window.focus();
  }

  async hasSession(): Promise<boolean> {
    return (await this.sessionValue()) !== undefined;
  }

  /** 로그인이 바뀌었는지 비교하는 데만 쓰고 저장하지 않습니다. */
  private async sessionValue(): Promise<string | undefined> {
    const cookies = await this.session.cookies.get({ name: sessionCookie });
    return cookies.find((cookie) => (cookie.domain ?? '').replace(/^\./, '').endsWith('arca.live'))?.value;
  }

  /** 이 앱에 저장된 아카라이브 로그인 정보를 지웁니다. */
  async signOut(): Promise<void> {
    const cookies = await this.session.cookies.get({});
    await Promise.all(cookies
      .filter((cookie) => (cookie.domain ?? '').replace(/^\./, '').endsWith('arca.live'))
      .map((cookie) => {
        const host = (cookie.domain ?? 'arca.live').replace(/^\./, '');
        return this.session.cookies.remove(`https://${host}${cookie.path ?? '/'}`, cookie.name).catch(() => undefined);
      }));
    await this.session.clearStorageData({ origin: 'https://arca.live' }).catch(() => undefined);
  }
}
