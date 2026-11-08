import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, protocol, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CommandName } from '../shared/types';
import { BrowserController } from './browser';
import { log } from './log';
import { importLegacySettings } from './migrate';
import { AppModel } from './model';

const isDev = !app.isPackaged;
const appName = isDev ? 'Uncalive Dev' : '언카라이브';
app.setName(appName);
// Electron은 앱 이름을 브라우저 표시에 넣는데, 한글 이름은 HTTP 헤더에 쓸 수 없습니다.
// 워커처럼 세션 설정을 따르지 않는 곳도 같은 표시를 쓰도록 기본값을 바꿉니다. 다르면 Cloudflare 확인이 실패합니다.
app.userAgentFallback = BrowserController.userAgent(app.userAgentFallback);
// 개발본과 설치본이 로그인 세션, 설정, 보관함을 서로 건드리지 않게 나눕니다. 폴더 이름은 영문으로 둡니다.
app.setPath('userData', process.env.UNCALIVE_PROFILE_DIR ?? path.join(app.getPath('appData'), isDev ? 'Uncalive Electron Dev' : 'Uncalive'));
if (process.platform === 'win32') app.setAppUserModelId(isDev ? 'io.github.hishydrogen.uncalive.dev' : 'io.github.hishydrogen.uncalive');

protocol.registerSchemesAsPrivileged([
  { scheme: 'uncalive-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const commands = new Set<CommandName>([
  'setSection', 'signIn', 'signOut', 'refreshScraps', 'stopLoading', 'addTargets', 'clearCollection', 'removeFromCollection',
  'removeCheckedFromCollection', 'removeFromCollectionMany', 'undoRemoveFromCollection', 'setSelection', 'setChecked', 'checkUnsaved', 'startDownload', 'togglePause', 'cancelDownload', 'exportCSV',
  'setOptions', 'setUseAccountFolder', 'setAutoCheckHours', 'setAutoDownloadNew', 'checkNow', 'chooseDestination', 'openPost',
  'revealPost', 'revealFile', 'openLibraryFolder', 'reloadLibrary', 'searchLibrary',
]);

let model: AppModel;
let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let quitting = false;

/** 이 운영체제에서 창 바탕에 쓸 수 있는 재질입니다. Windows 10과 Linux는 단색입니다. */
export function windowMaterial(): 'vibrancy' | 'mica' | undefined {
  if (process.platform === 'darwin') return 'vibrancy';
  if (process.platform === 'win32' && Number(os.release().split('.')[2] ?? 0) >= 22000) return 'mica';
  return undefined;
}

function resource(name: string): string {
  return isDev ? path.join(__dirname, '..', 'resources', name) : path.join(process.resourcesPath, name);
}

/** 다운로드 중이거나 자동 확인을 켠 동안에는 창을 닫아도 앱이 남습니다. */
function keepsRunning(): boolean {
  return model.job?.isActive === true || model.autoCheckHours > 0;
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1160,
    height: 720,
    minWidth: 980,
    minHeight: 600,
    title: appName,
    show: false,
    icon: resource('icon.png'),
    // 맥은 사이드바 뒤로 바탕화면이 은은히 비치는 재질을, Windows 11은 Mica 재질을 씁니다. 그 밖에는 단색 바탕입니다.
    backgroundColor: windowMaterial() ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#1f1f1f' : '#f3f3f3',
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 18, y: 18 },
      vibrancy: 'sidebar' as const,
      visualEffectState: 'followWindow' as const,
    } : {}),
    ...(windowMaterial() === 'mica' ? { backgroundMaterial: 'mica' as const } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  window.once('ready-to-show', () => window.show());
  window.on('focus', () => model.windowFocused());
  window.on('close', (event) => {
    if (quitting || !keepsRunning()) return;
    event.preventDefault();
    window.hide();
    showTray();
  });
  window.on('closed', () => {
    mainWindow = undefined;
    if (!quitting && !keepsRunning()) app.quit();
  });
  // 앱 화면은 다른 주소로 이동하지 않습니다. 링크는 기본 브라우저로 엽니다.
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) void window.loadURL(devServer);
  else void window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  model.window = window;
  return window;
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function showTray(): void {
  if (tray || process.platform === 'darwin') return;
  const image = nativeImage.createFromPath(resource('icon.png')).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip(appName);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '열기', click: showMainWindow },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ]));
  tray.on('click', showMainWindow);
}

function buildMenu(): void {
  const send = (section: Parameters<AppModel['setSection']>[0]) => () => {
    showMainWindow();
    model.setSection(section);
  };
  const isMac = process.platform === 'darwin';
  const settings: MenuItemConstructorOptions = { label: '설정…', accelerator: 'CmdOrCtrl+,', click: send('settings') };
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: appName,
      submenu: [
        { role: 'about', label: `${appName} 정보` }, { type: 'separator' }, settings, { type: 'separator' },
        { role: 'hide', label: `${appName} 가리기` }, { role: 'hideOthers', label: '기타 가리기' }, { role: 'unhide', label: '모두 보기' },
        { type: 'separator' }, { role: 'quit', label: `${appName} 종료` },
      ] as MenuItemConstructorOptions[],
    }] : []),
    {
      label: '파일',
      submenu: [
        { label: '스크랩 목록 새로고침', accelerator: 'CmdOrCtrl+R', click: () => model.refreshScraps() },
        ...(isMac ? [] : [settings]),
        { type: 'separator' },
        { label: '보관함 폴더 열기', click: () => model.openLibraryFolder() },
        { type: 'separator' },
        isMac ? { role: 'close', label: '창 닫기' } : { role: 'quit', label: '종료' },
      ],
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' }, { role: 'redo', label: '다시 실행' }, { type: 'separator' },
        { role: 'cut', label: '잘라내기' }, { role: 'copy', label: '복사' }, { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '모두 선택' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { label: '스크랩', accelerator: 'CmdOrCtrl+1', click: send('scraps') },
        { label: '주소 수집', accelerator: 'CmdOrCtrl+2', click: send('collection') },
        { label: '다운로드', accelerator: 'CmdOrCtrl+3', click: send('downloads') },
        { label: '보관함', accelerator: 'CmdOrCtrl+4', click: send('library') },
        { label: '갤러리', accelerator: 'CmdOrCtrl+5', click: send('gallery') },
        { type: 'separator' },
        { role: 'resetZoom', label: '실제 크기' }, { role: 'zoomIn', label: '확대' }, { role: 'zoomOut', label: '축소' },
        ...(isDev ? [{ type: 'separator' as const }, { role: 'toggleDevTools' as const, label: '개발자 도구' }] : []),
      ],
    },
    ...(isMac ? [{ role: 'windowMenu' as const, label: '윈도우' }] : []),
    {
      label: '도움말',
      submenu: [
        { label: '사용 설명서', click: () => void shell.openExternal('https://github.com/hishydrogen/Uncalive#readme') },
        { label: '최신 버전 확인', click: () => void shell.openExternal('https://github.com/hishydrogen/Uncalive/releases/latest') },
        { type: 'separator' },
        { label: `${appName} ${app.getVersion()}`, enabled: false },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** 보관함 안의 사진과 동영상만 화면에 보여 줍니다. 다른 경로는 거부합니다. */
function registerMediaProtocol(): void {
  protocol.handle('uncalive-media', (request) => {
    const url = new URL(request.url);
    const relative = url.pathname.slice(1).split('/').map((segment) => decodeURIComponent(segment)).join('/');
    const target = model.resolveLibraryPath(relative);
    if (!target) return new Response('없는 파일입니다.', { status: 404 });
    return net.fetch(pathToFileURL(target).toString(), { headers: request.headers });
  });
}

function registerIPC(): void {
  ipcMain.handle('state', () => model.snapshot());
  ipcMain.handle('command', async (event, name: CommandName, args: unknown[]) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('허용되지 않은 요청입니다.');
    if (!commands.has(name)) throw new Error(`알 수 없는 명령입니다: ${name}`);
    if (name === 'checkNow') return model.checkForNewScraps();
    const method = (model as unknown as Record<string, (...values: unknown[]) => unknown>)[name];
    return method.apply(model, Array.isArray(args) ? args : []);
  });
}

async function confirmQuit(): Promise<boolean> {
  if (model.job?.isActive !== true) return true;
  showMainWindow();
  const { response } = await dialog.showMessageBox(mainWindow!, {
    type: 'warning',
    message: '다운로드가 진행 중입니다',
    detail: '지금 종료하면 다운로드 중인 파일은 저장되지 않습니다. 이미 다 받은 파일은 그대로 남으며, 나중에 다시 시작하면 나머지를 이어서 받습니다.',
    // 첫 번째 버튼이 기본 버튼입니다.
    buttons: ['계속 받기', '중단하고 종료'],
    defaultId: 0,
    cancelId: 0,
  });
  return response === 1;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    void (async () => {
      if (!(await confirmQuit())) return;
      quitting = true;
      (global as { quitting?: boolean }).quitting = true;
      await model.cancelDownloadAndWait();
      await model.flush();
      model.browser.destroy();
      app.quit();
    })();
  });

  app.on('window-all-closed', () => {
    // 창을 모두 닫으면 종료합니다. 다운로드 중이거나 자동 확인 중이면 알림 영역에 남습니다.
    if (!keepsRunning()) app.quit();
  });

  app.on('activate', () => showMainWindow());

  void app.whenReady().then(async () => {
    log('=== 개발 빌드 시작 ===');
    const defaultFolder = isDev ? 'Uncalive Dev' : 'Uncalive';
    // 시험용으로 따로 띄울 때는 예전 앱의 설정을 읽지 않습니다.
    if (!process.env.UNCALIVE_PROFILE_DIR) await importLegacySettings(isDev ? 'io.github.hishydrogen.uncalive.dev' : 'io.github.hishydrogen.uncalive');
    model = new AppModel(process.env.UNCALIVE_DEFAULT_FOLDER ?? defaultFolder);
    model.material = windowMaterial();
    registerMediaProtocol();
    registerIPC();
    buildMenu();
    mainWindow = createWindow();
    await model.start();
  });
}
