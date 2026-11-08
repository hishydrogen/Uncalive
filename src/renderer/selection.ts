import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call } from './api';
import type { ListKind } from '../shared/types';

export interface Modifiers {
  /** macOS의 ⌘, Windows와 Linux의 Ctrl입니다. 하나씩 더하거나 뺍니다. */
  toggle: boolean;
  /** Shift입니다. 마지막으로 누른 줄부터 범위를 고릅니다. */
  range: boolean;
}

export function modifiersOf(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, isMac: boolean): Modifiers {
  return { toggle: isMac ? event.metaKey : event.ctrlKey, range: event.shiftKey };
}

/**
 * Finder나 탐색기처럼 동작하는 목록 선택입니다. 고른 글이 곧 다운로드할 글입니다.
 * 화면에서 먼저 바꾸고 메인 프로세스에 알리므로, 상태가 돌아오기를 기다리지 않아 반응이 즉각적입니다.
 */
export function useSelection(kind: ListKind, visibleIDs: string[], serverChecked: string[]) {
  const server = useMemo(() => new Set(serverChecked), [serverChecked]);
  const [local, setLocal] = useState<Set<string> | null>(null);
  const [cursor, setCursor] = useState<string>();
  const anchor = useRef<string>(undefined);
  /** 범위 선택을 시작하기 전의 선택입니다. Shift로 범위를 다시 고르면 앞 범위를 바꿉니다. */
  const rangeBase = useRef<Set<string>>(new Set());
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const selected = local ?? server;
  // 키를 빠르게 연달아 눌러도 앞 동작의 결과를 바로 이어받도록 화면 갱신을 기다리지 않는 값을 함께 둡니다.
  const current = useRef(selected);
  const cursorNow = useRef<string>(undefined);
  const pending = useRef(false);
  if (!pending.current) current.current = selected;
  const moveCursor = (id: string | undefined) => {
    cursorNow.current = id;
    setCursor(id);
  };

  // 메인 프로세스가 같은 선택을 돌려주거나 잠시 지나면 화면의 임시 선택을 거둡니다.
  useEffect(() => {
    if (local && local.size === server.size && [...local].every((id) => server.has(id))) setLocal(null);
  }, [server, local]);

  /** 화면에만 먼저 그립니다. 끌어 고르는 동안 씁니다. */
  const preview = useCallback((next: Set<string>) => {
    current.current = next;
    setLocal(next);
  }, []);

  const commit = useCallback((next: Set<string>) => {
    current.current = next;
    pending.current = true;
    queueMicrotask(() => { pending.current = false; });
    setLocal(next);
    void call('setSelection', kind, [...next]);
    clearTimeout(settle.current);
    settle.current = setTimeout(() => setLocal(null), 1200);
  }, [kind]);

  const setAnchor = useCallback((id: string | undefined, base: Set<string>) => {
    anchor.current = id;
    rangeBase.current = new Set(base);
  }, []);

  const rangeTo = useCallback((id: string): Set<string> => {
    const from = anchor.current && visibleIDs.includes(anchor.current) ? anchor.current : id;
    const [a, b] = [visibleIDs.indexOf(from), visibleIDs.indexOf(id)].sort((x, y) => x - y);
    const next = new Set(rangeBase.current);
    visibleIDs.slice(a, b + 1).forEach((item) => next.add(item));
    return next;
  }, [visibleIDs]);

  /** 줄을 눌렀을 때입니다. */
  const click = useCallback((id: string, modifiers: Modifiers) => {
    moveCursor(id);
    if (modifiers.range) {
      if (!anchor.current) setAnchor(id, current.current);
      commit(rangeTo(id));
      return;
    }
    if (modifiers.toggle) {
      const next = new Set(current.current);
      if (next.has(id)) next.delete(id); else next.add(id);
      setAnchor(id, next);
      commit(next);
      return;
    }
    const next = new Set([id]);
    setAnchor(id, new Set());
    commit(next);
  }, [commit, rangeTo, setAnchor]);

  /** 체크 상자와 스페이스 바입니다. 다른 글은 그대로 두고 이 글만 넣거나 뺍니다. */
  const toggle = useCallback((id: string) => {
    const next = new Set(current.current);
    if (next.has(id)) next.delete(id); else next.add(id);
    moveCursor(id);
    setAnchor(id, next);
    commit(next);
  }, [commit, setAnchor]);

  const selectAll = useCallback(() => commit(new Set(visibleIDs)), [visibleIDs, commit]);
  const clear = useCallback(() => {
    setAnchor(undefined, new Set());
    commit(new Set());
  }, [commit, setAnchor]);

  /** 방향키입니다. Shift를 누르면 범위를 넓힙니다. */
  const move = useCallback((delta: number, extend: boolean) => {
    if (visibleIDs.length === 0) return;
    const index = cursorNow.current ? visibleIDs.indexOf(cursorNow.current) : -1;
    const nextIndex = index < 0 ? (delta > 0 ? 0 : visibleIDs.length - 1) : Math.min(Math.max(index + delta, 0), visibleIDs.length - 1);
    const id = visibleIDs[nextIndex];
    moveCursor(id);
    if (extend) {
      if (!anchor.current) setAnchor(cursorNow.current ?? id, current.current);
      commit(rangeTo(id));
    } else {
      setAnchor(id, new Set());
      commit(new Set([id]));
    }
  }, [visibleIDs, commit, rangeTo, setAnchor]);

  /** 화면 갱신을 기다리지 않은 지금의 선택입니다. */
  const now = useCallback(() => current.current, []);
  return { selected, now, cursor, setCursor: moveCursor, click, toggle, selectAll, clear, move, preview, commit };
}
