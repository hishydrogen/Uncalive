import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/** 화면이 쓸 수 있는 기능은 상태 받기와 명령 보내기, 창 상태 받기와 창 단추 조작뿐입니다. */
contextBridge.exposeInMainWorld('uncalive', {
  getState: () => ipcRenderer.invoke('state'),
  getWindowState: () => ipcRenderer.invoke('window-state'),
  call: (name: string, ...args: unknown[]) => ipcRenderer.invoke('command', name, args),
  onState: (listener: (state: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
  onWindow: (listener: (state: unknown) => void) => {
    const handler = (_event: IpcRendererEvent, state: unknown) => listener(state);
    ipcRenderer.on('window', handler);
    return () => ipcRenderer.removeListener('window', handler);
  },
  windowControl: (action: 'minimize' | 'maximize' | 'close') => ipcRenderer.send('window-control', action),
});
