import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

/** 화면이 쓸 수 있는 기능은 상태 받기와 명령 보내기, 창 상태 받기, 크게 보기를 열고 닫은 것 알리기뿐입니다. */
contextBridge.exposeInMainWorld('uncalive', {
  getState: () => ipcRenderer.invoke('state'),
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
  setLightbox: (open: boolean) => ipcRenderer.send('lightbox', open === true),
});
