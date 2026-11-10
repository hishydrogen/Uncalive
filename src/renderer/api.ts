import { useEffect, useState } from 'react';
import type { AppState, CommandName, Commands } from '../shared/types';

interface Bridge {
  getState(): Promise<AppState>;
  call(name: string, ...args: unknown[]): Promise<unknown>;
  onState(listener: (state: Partial<AppState>) => void): () => void;
  onWindow(listener: (state: { fullScreen: boolean }) => void): () => void;
  setLightbox(open: boolean): void;
}

const bridge = (window as unknown as { uncalive: Bridge }).uncalive;

/** 메인 프로세스의 `AppModel`에 명령을 보냅니다. */
export function call<K extends CommandName>(name: K, ...args: Parameters<Commands[K]>): Promise<Awaited<ReturnType<Commands[K]>>> {
  return bridge.call(name, ...args) as Promise<Awaited<ReturnType<Commands[K]>>>;
}

/** 메인 프로세스가 보내는 상태를 받습니다. 바뀐 부분만 오므로 앞의 상태에 덮어씁니다. */
export function useAppState(): AppState | undefined {
  const [state, setState] = useState<AppState>();
  useEffect(() => {
    let pending: Partial<AppState> = {};
    let ready = false;
    const stop = bridge.onState((partial) => {
      if (!ready) {
        pending = { ...pending, ...partial };
        return;
      }
      setState((previous) => (previous ? { ...previous, ...partial } : previous));
    });
    void bridge.getState().then((initial) => {
      ready = true;
      setState({ ...initial, ...pending });
    });
    return stop;
  }, []);
  return state;
}

const encodePath = (relative: string) => relative.split('/').map(encodeURIComponent).join('/');

/** 전체 화면이면 html에 fullscreen을 붙입니다. 맥은 전체 화면에서 창 단추가 숨으므로 그 자리를 비워 두지 않습니다. */
export function watchWindowState(): () => void {
  return bridge.onWindow((state) => document.documentElement.classList.toggle('fullscreen', state.fullScreen));
}

/** 크게 보기를 열고 닫은 것을 알립니다. Windows는 창 단추 색을 어두운 막대에 맞춥니다. */
export function setLightboxOpen(open: boolean): void {
  bridge.setLightbox(open);
}

/** 보관함 안의 파일을 화면에서 여는 주소입니다. */
export function mediaURL(relative: string): string {
  return 'uncalive-media://library/' + encodePath(relative);
}

/** 갤러리와 보관함 칸에 쓰는 작은 그림의 주소입니다. 동영상은 첫 장면으로 만듭니다. */
export function thumbnailURL(relative: string, isVideo = false): string {
  return 'uncalive-media://thumb/' + encodePath(relative) + (isVideo ? '?video' : '');
}

/** 창 안에서만 쓰는 값을 기억합니다. 저장소를 쓸 수 없으면 기본값으로 동작합니다. */
export function usePreference<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? initial : (JSON.parse(saved) as T);
    } catch {
      return initial;
    }
  });
  const update = (next: T) => {
    setValue(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* 기억하지 못해도 괜찮습니다. */ }
  };
  return [value, update];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes}바이트`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  if (minutes > 0) return `${minutes}분 ${rest}초`;
  return `${rest}초`;
}

export function formatShortDate(iso?: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(date.getFullYear() % 100)}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
}

/** '방금', '5분 전', '3시간 전', '2일 전'처럼 지난 시간을 짧게 씁니다. */
export function formatAgo(time: number, now = Date.now()): string {
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

export const qualityTitles = { original: '원본', balanced: '균형', display: '웹 표시용' } as const;

export const qualityDetails = {
  original: '모든 파일을 원본 화질로 받습니다. 원본 서버의 속도 제한(약 200KB/s) 때문에 가장 느립니다.',
  balanced: '가로 1280px보다 큰 이미지만 원본으로 받습니다. 그 이하인 이미지는 원본과 해상도가 같은 압축본으로 받아 속도가 훨씬 빠릅니다.',
  display: '모든 이미지를 웹 표시용 압축본으로 받습니다. 가장 빠르지만 큰 이미지는 가로 1280px 크기로 줄어듭니다.',
} as const;
