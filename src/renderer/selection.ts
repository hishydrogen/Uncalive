import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { call } from './api';
import type { ListKind } from '../shared/types';

export interface Modifiers {
  /** macOS의 ⌘, Windows와 Linux의 Ctrl입니다. 하나씩 더하거나 뺍니다. */
  toggle: boolean;
  /** Shift입니다. 마지막으로 누른 항목부터 범위를 고릅니다. */
  range: boolean;
}

export function modifiersOf(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, isMac: boolean): Modifiers {
  return { toggle: isMac ? event.metaKey : event.ctrlKey, range: event.shiftKey };
}

const empty: string[] = [];

/**
 * Finder나 탐색기처럼 동작하는 선택입니다.
 * sync를 주면(스크랩과 링크) 고른 글이 곧 다운로드할 글이라 메인 프로세스에 알립니다. 화면에서 먼저 바꾸므로 반응이 즉각적입니다.
 * sync가 없으면(보관함과 갤러리) 화면 안에서만 기억합니다.
 */
export function useSelection(visibleIDs: string[], sync?: { kind: ListKind; checked: string[] }) {
  const server = useMemo(() => new Set(sync?.checked ?? empty), [sync?.checked]);
  const [local, setLocal] = useState<Set<string> | null>(sync ? null : new Set());
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
  const moveCursor = useCallback((id: string | undefined) => {
    cursorNow.current = id;
    setCursor(id);
  }, []);

  // 메인 프로세스가 같은 선택을 돌려주면 화면의 임시 선택을 거둡니다.
  useEffect(() => {
    if (sync && local && local.size === server.size && [...local].every((id) => server.has(id))) setLocal(null);
  }, [server, local, sync]);

  /** 화면에만 먼저 그립니다. 끌어 고르는 동안 씁니다. */
  const preview = useCallback((next: Set<string>) => {
    current.current = next;
    setLocal(next);
  }, []);

  const kind = sync?.kind;
  const commit = useCallback((next: Set<string>) => {
    current.current = next;
    pending.current = true;
    queueMicrotask(() => { pending.current = false; });
    setLocal(next);
    if (!kind) return;
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

  /** 항목을 눌렀을 때입니다. */
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
    setAnchor(id, new Set());
    commit(new Set([id]));
  }, [commit, rangeTo, setAnchor, moveCursor]);

  /** 체크 상자와 스페이스 바입니다. 다른 항목은 그대로 두고 이 항목만 넣거나 뺍니다. */
  const toggle = useCallback((id: string) => {
    const next = new Set(current.current);
    if (next.has(id)) next.delete(id); else next.add(id);
    moveCursor(id);
    setAnchor(id, next);
    commit(next);
  }, [commit, setAnchor, moveCursor]);

  const selectAll = useCallback(() => commit(new Set(visibleIDs)), [visibleIDs, commit]);
  const clear = useCallback(() => {
    setAnchor(undefined, new Set());
    commit(new Set());
  }, [commit, setAnchor]);

  /** 방향키입니다. 격자에서는 위아래가 한 줄(columns칸)씩 움직입니다. Shift를 누르면 범위를 넓힙니다. */
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
  }, [visibleIDs, commit, rangeTo, setAnchor, moveCursor]);

  /** 화면 갱신을 기다리지 않은 지금의 선택입니다. */
  const now = useCallback(() => current.current, []);
  return { selected, now, cursor, setCursor: moveCursor, click, toggle, selectAll, clear, move, preview, commit };
}

export type Selection = ReturnType<typeof useSelection>;

/**
 * 누르면 고르고, 누른 채 끌면 상자 안의 항목을 고릅니다. 표의 줄과 격자의 칸 모두에 씁니다.
 * 항목에는 data-id를 달고 items에 등록합니다. 가장자리로 끌면 저절로 굴러갑니다.
 */
export function useMarquee(selection: Selection, isMac: boolean, options: { ignore?: string; onOpen?: (id: string) => void } = {}) {
  const container = useRef<HTMLDivElement>(null);
  const items = useRef(new Map<string, HTMLElement>());
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number }>();

  const register = useCallback((id: string) => (element: HTMLElement | null) => {
    if (element) items.current.set(id, element); else items.current.delete(id);
  }, []);

  const onMouseDown = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const element = event.target as HTMLElement;
    if (element.closest(`input, button:not([data-id]), a, select, th${options.ignore ? `, ${options.ignore}` : ''}`)) return;
    const scroller = container.current;
    if (!scroller) return;
    if (event.detail === 2) {
      const id = (element.closest('[data-id]') as HTMLElement | null)?.dataset.id;
      if (id) options.onOpen?.(id);
      return;
    }
    event.preventDefault();
    scroller.focus({ preventScroll: true });
    const modifiers = modifiersOf(event, isMac);
    const additive = modifiers.toggle || modifiers.range;
    const base = additive ? new Set(selection.now()) : new Set<string>();
    const hitID = (element.closest('[data-id]') as HTMLElement | null)?.dataset.id;
    const toContent = (x: number, y: number) => {
      const rect = scroller.getBoundingClientRect();
      return { x: x - rect.left + scroller.scrollLeft, y: y - rect.top + scroller.scrollTop };
    };
    const start = toContent(event.clientX, event.clientY);
    let pointer = { x: event.clientX, y: event.clientY };
    let moved = false;
    let frame = 0;
    let latest = base;

    const update = () => {
      const rect = scroller.getBoundingClientRect();
      const edge = 36;
      if (pointer.y < rect.top + edge) scroller.scrollTop -= Math.ceil((rect.top + edge - pointer.y) / 3);
      else if (pointer.y > rect.bottom - edge) scroller.scrollTop += Math.ceil((pointer.y - (rect.bottom - edge)) / 3);
      const now = toContent(pointer.x, pointer.y);
      const area = { left: Math.min(start.x, now.x), right: Math.max(start.x, now.x), top: Math.min(start.y, now.y), bottom: Math.max(start.y, now.y) };
      setBox({ top: area.top, left: Math.max(0, area.left), width: area.right - area.left, height: area.bottom - area.top });
      const next = new Set(base);
      items.current.forEach((item, id) => {
        const r = item.getBoundingClientRect();
        const a = toContent(r.left, r.top);
        if (a.y < area.bottom && a.y + r.height > area.top && a.x < area.right && a.x + r.width > area.left) next.add(id);
      });
      latest = next;
      selection.preview(next);
      frame = requestAnimationFrame(update);
    };
    const onMove = (move: MouseEvent) => {
      pointer = { x: move.clientX, y: move.clientY };
      if (!moved && Math.hypot(move.clientX - event.clientX, move.clientY - event.clientY) > 4) {
        moved = true;
        frame = requestAnimationFrame(update);
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      cancelAnimationFrame(frame);
      setBox(undefined);
      if (moved) {
        selection.commit(latest);
        // 끌기를 마친 항목을 지금 항목으로 삼아, 방향키가 거기서 이어지게 합니다.
        let end: string | undefined;
        items.current.forEach((item, id) => {
          const r = item.getBoundingClientRect();
          if (pointer.x >= r.left && pointer.x < r.right && pointer.y >= r.top && pointer.y < r.bottom) end = id;
        });
        if (end) selection.setCursor(end);
      } else if (hitID) {
        selection.click(hitID, modifiers);
      } else if (!additive) {
        selection.clear();
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  /** 격자에서 한 줄에 놓인 칸 수입니다. 위아래 방향키가 이만큼 움직입니다. */
  const columns = () => {
    const tops = [...items.current.values()].slice(0, 64).map((item) => Math.round(item.getBoundingClientRect().top));
    if (tops.length === 0) return 1;
    return Math.max(1, tops.filter((top) => top === tops[0]).length);
  };

  return { container, register, onMouseDown, box, items, columns };
}

/**
 * 보관함과 갤러리의 키보드 조작입니다. ⌘A(Ctrl+A) 모두 고르기, Esc 풀기, 방향키(격자에서는 위아래가 한 줄씩), Enter 열기,
 * Delete 지우기(있을 때만), 스페이스 바(화면마다 다름)입니다. 입력 칸이나 대화 상자, 크게 보기가 열려 있으면 건드리지 않습니다.
 */
export function useCollectionKeys(selection: Selection, columns: () => number, isMac: boolean, actions: {
  onOpen?: (ids: string[]) => void;
  onDelete?: (ids: string[]) => void;
  onSpace?: (id: string) => void;
  onCopy?: (ids: string[]) => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      if (document.querySelector('.dialog, .context-menu, .lightbox')) return;
      const command = isMac ? event.metaKey : event.ctrlKey;
      const key = event.key;
      const picked = [...selection.now()];
      if (command && key.toLowerCase() === 'a') {
        event.preventDefault();
        selection.selectAll();
      } else if (command && key.toLowerCase() === 'c' && picked.length > 0 && actions.onCopy) {
        event.preventDefault();
        actions.onCopy(picked);
      } else if (key === 'Escape') {
        selection.clear();
      } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
        event.preventDefault();
        selection.move(key === 'ArrowRight' ? 1 : -1, event.shiftKey);
      } else if (key === 'ArrowUp' || key === 'ArrowDown') {
        event.preventDefault();
        selection.move((key === 'ArrowDown' ? 1 : -1) * columns(), event.shiftKey);
      } else if (key === 'Enter' && target?.tagName !== 'BUTTON' && picked.length > 0) {
        actions.onOpen?.(picked);
      } else if ((key === 'Delete' || key === 'Backspace') && picked.length > 0 && actions.onDelete) {
        event.preventDefault();
        actions.onDelete(picked);
      } else if (key === ' ' && selection.cursor && actions.onSpace && target?.tagName !== 'BUTTON') {
        event.preventDefault();
        actions.onSpace(selection.cursor);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
}

/**
 * 다운로드할 글의 체크입니다. 강조 선택(useSelection)과 따로 두어, 다른 곳을 잘못 눌러도 체크가 풀리지 않습니다.
 * 체크 상자, 스페이스 바, 머리글 체크 상자, '체크…' 메뉴로만 바뀝니다. 화면에서 먼저 바꾸고 메인 프로세스에 알립니다.
 */
export function useChecks(kind: ListKind, serverChecked: string[]) {
  const server = useMemo(() => new Set(serverChecked), [serverChecked]);
  const [local, setLocal] = useState<Set<string> | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const checked = local ?? server;
  const current = useRef(checked);
  const pending = useRef(false);
  if (!pending.current) current.current = checked;

  useEffect(() => {
    // 이 효과가 돌기 직전에 새 체크가 들어올 수 있습니다(느린 컴퓨터에서 빠르게 연달아 누를 때).
    // 그린 때의 local이 아니라 가장 최근 값과 비교해야 방금 누른 체크를 서버의 옛 상태로 덮어쓰지 않습니다.
    setLocal((latest) => (latest && latest.size === server.size && [...latest].every((id) => server.has(id)) ? null : latest));
  }, [server, local]);

  const commit = useCallback((next: Set<string>) => {
    current.current = next;
    pending.current = true;
    queueMicrotask(() => { pending.current = false; });
    setLocal(next);
    void call('setSelection', kind, [...next]);
    clearTimeout(settle.current);
    settle.current = setTimeout(() => setLocal(null), 1200);
  }, [kind]);

  /** 여러 글을 한꺼번에 체크하거나 풉니다. 바꾸기 전의 체크를 돌려주므로 되돌리기에 씁니다. */
  const set = useCallback((ids: Iterable<string>, value: boolean): Set<string> => {
    const before = new Set(current.current);
    const next = new Set(before);
    for (const id of ids) { if (value) next.add(id); else next.delete(id); }
    commit(next);
    return before;
  }, [commit]);

  const toggle = useCallback((id: string) => set([id], !current.current.has(id)), [set]);
  const now = useCallback(() => current.current, []);
  return { checked, now, commit, set, toggle };
}
