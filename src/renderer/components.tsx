import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';

export function EmptyState(props: { icon: ReactNode; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{props.icon}</div>
      <h2>{props.title}</h2>
      {props.description && <p>{props.description}</p>}
      {props.actions && <div className="empty-actions">{props.actions}</div>}
    </div>
  );
}

export function Spinner(props: { label?: string }) {
  return (
    <div className="empty">
      <div className="spinner" aria-hidden />
      {props.label && <p>{props.label}</p>}
    </div>
  );
}

/**
 * 여럿 중 하나를 고르는 단추 묶음입니다. 눌렀다 손을 떼면 바뀌고(누른 채 밖으로 빠지면 취소), 고른 표시가 다음 단추로 미끄러져 갑니다.
 */
export function Segmented<T extends string | number>(props: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const thumb = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);

  useLayoutEffect(() => {
    const place = () => {
      const button = buttons.current.get(String(props.value));
      const element = thumb.current;
      if (!button || !element) return;
      if (!placed.current) element.style.transition = 'none';
      element.style.transform = `translateX(${button.offsetLeft}px)`;
      element.style.width = `${button.offsetWidth}px`;
      element.style.opacity = '1';
      if (!placed.current) {
        void element.offsetWidth;
        element.style.transition = '';
        placed.current = true;
      }
    };
    place();
    // 칸 너비가 바뀌어도(창 크기, 글꼴 불러오기) 표시가 단추를 따라가게 합니다.
    const observer = new ResizeObserver(place);
    if (box.current) observer.observe(box.current);
    return () => observer.disconnect();
  }, [props.value, props.options.length]);

  return (
    <div className="segmented" role="radiogroup" aria-label={props.label} ref={box}>
      <span className="segmented-thumb" ref={thumb} aria-hidden />
      {props.options.map((option) => (
        <button
          key={String(option.value)}
          ref={(button) => { if (button) buttons.current.set(String(option.value), button); else buttons.current.delete(String(option.value)); }}
          role="radio"
          aria-checked={option.value === props.value}
          className={option.value === props.value ? 'selected' : ''}
          onClick={() => { if (option.value !== props.value) props.onChange(option.value); }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle(props: { label: ReactNode; checked: boolean; onChange: (value: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`toggle ${props.disabled ? 'disabled' : ''}`}>
      <span>{props.label}</span>
      <input type="checkbox" role="switch" checked={props.checked} disabled={props.disabled} onChange={(event) => props.onChange(event.target.checked)} />
    </label>
  );
}

/** 숫자를 키보드로 바로 입력하는 칸입니다. 범위를 벗어나면 가까운 값으로 맞춥니다. */
export function NumberField(props: { value: number; min: number; max: number; onChange: (value: number) => void; label?: string }) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);
  const commit = () => {
    const parsed = Number.parseInt(text, 10);
    const value = Number.isFinite(parsed) ? Math.min(Math.max(parsed, props.min), props.max) : props.value;
    setText(String(value));
    if (value !== props.value) props.onChange(value);
  };
  return (
    <input
      className="number"
      inputMode="numeric"
      aria-label={props.label}
      value={text}
      onChange={(event) => setText(event.target.value.replace(/[^0-9]/g, ''))}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') commit(); }}
    />
  );
}

export function SearchField(props: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div className="search">
      <Search size={14} aria-hidden />
      <input value={props.value} placeholder={props.placeholder} onChange={(event) => props.onChange(event.target.value)} />
      {props.value && (
        <button className="plain" aria-label="검색어 지우기" onClick={() => props.onChange('')}><X size={14} /></button>
      )}
    </div>
  );
}

export function Select<T extends string>(props: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; label: string }) {
  return (
    <select aria-label={props.label} value={props.value} onChange={(event) => props.onChange(event.target.value as T)}>
      {props.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

export function Header(props: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <header className="toolbar">
      <div className="toolbar-title">
        <h1>{props.title}</h1>
        {props.subtitle && <span className="subtitle">{props.subtitle}</span>}
      </div>
      <div className="toolbar-items">{props.children}</div>
    </header>
  );
}

/** 아카라이브 게시판의 카테고리 줄과 같은 모양입니다. */
export function CategoryTabs(props: { categories: string[]; selection?: string; onChange: (value?: string) => void }) {
  return (
    <nav className="category-tabs">
      <button className={props.selection === undefined ? 'selected' : ''} onClick={() => props.onChange(undefined)}>전체</button>
      {props.categories.map((name) => (
        <button key={name} className={props.selection === name ? 'selected' : ''} onClick={() => props.onChange(name)}>{name}</button>
      ))}
    </nav>
  );
}

/** 글이 많은 카테고리부터 나열합니다. */
export function categoriesOf(items: Array<{ category?: string }>): string[] {
  const counts = new Map<string, number>();
  for (const item of items) if (item.category) counts.set(item.category, (counts.get(item.category) ?? 0) + 1);
  return [...counts.keys()].sort((a, b) => (counts.get(b)! - counts.get(a)!) || a.localeCompare(b, 'ko'));
}

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/** 오른쪽 클릭 메뉴입니다. */
export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] }>();
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    window.addEventListener('click', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', close);
    };
  }, [menu]);
  const open = (event: React.MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };
  // 창 전체 위에 그립니다. 화면 안에 두면 움직임 효과가 기준을 바꿔 사이드바를 덮지 못합니다.
  const element = menu ? createPortal(
    <div className="context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - menu.items.length * 32 - 12) }} role="menu">
      {menu.items.map((item) => (
        <button key={item.label} role="menuitem" className={item.danger ? 'danger' : ''} disabled={item.disabled} onClick={item.onClick}>{item.label}</button>
      ))}
    </div>,
    document.body,
  ) : null;
  return { open, element };
}

/** 화면에 보일 때만 그립니다. 사진과 동영상이 많은 화면을 가볍게 합니다. */
export function useVisible<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || visible) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: '400px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);
  return [ref, visible];
}

export function Dialog(props: { title: string; children: ReactNode; onClose: () => void; width?: number; dismissable?: boolean; className?: string; closeButton?: boolean }) {
  const dismissable = props.dismissable ?? true;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && dismissable) props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(event) => { if (dismissable && event.target === event.currentTarget) props.onClose(); }}>
      <div className={`dialog ${props.className ?? ''}`} role="dialog" aria-modal aria-label={props.title} style={{ width: props.width ?? 540 }}>
        {props.closeButton ? (
          <div className="dialog-head">
            <h2>{props.title}</h2>
            <button className="plain dialog-close" aria-label="닫기" title="닫기" onClick={props.onClose}><X size={16} /></button>
          </div>
        ) : <h2>{props.title}</h2>}
        {props.children}
      </div>
    </div>,
    document.body,
  );
}

export interface ToastAction {
  label: string;
  run: () => void;
}

interface ToastItem {
  id: number;
  text: string;
  action?: ToastAction;
  leaving?: boolean;
}

const toastListeners = new Set<(item: ToastItem) => void>();
let nextToastID = 0;

/** 화면 아래에 잠깐 알림을 띄웁니다. 실행 취소 같은 단추를 하나 붙일 수 있습니다. */
export function showToast(text: string, action?: ToastAction): void {
  const item = { id: nextToastID++, text, action };
  toastListeners.forEach((listener) => listener(item));
}

export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const leave = (id: number) => {
      setItems((current) => current.map((item) => (item.id === id ? { ...item, leaving: true } : item)));
      setTimeout(() => setItems((current) => current.filter((item) => item.id !== id)), 220);
    };
    const listener = (item: ToastItem) => {
      // 새 알림이 오면 앞의 알림은 내립니다. 실행 취소는 가장 최근 작업에만 뜻이 있습니다.
      setItems((current) => [...current.map((old) => ({ ...old, leaving: true })), item]);
      setTimeout(() => setItems((current) => current.filter((old) => old.id === item.id || !old.leaving)), 220);
      setTimeout(() => leave(item.id), item.action ? 6000 : 3500);
    };
    toastListeners.add(listener);
    return () => { toastListeners.delete(listener); };
  }, []);
  return createPortal(
    <div className="toasts" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast ${item.leaving ? 'leaving' : ''}`}>
          <span>{item.text}</span>
          {item.action && (
            <button className="link" onClick={() => {
              item.action?.run();
              setItems((current) => current.map((old) => (old.id === item.id ? { ...old, leaving: true } : old)));
            }}>{item.action.label}</button>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}

/** 닫을 때도 움직임이 끝날 때까지 그려 두도록, 보이기 상태를 늦게 따라갑니다. */
export function usePresence(show: boolean, duration = 200): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(show);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    if (show) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, duration);
    return () => clearTimeout(timer);
  }, [show]);
  return { mounted, closing };
}
