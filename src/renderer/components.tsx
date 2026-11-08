import { useEffect, useRef, useState, type ReactNode } from 'react';
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

export function Segmented<T extends string | number>(props: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  label?: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={props.label}>
      {props.options.map((option) => (
        <button
          key={String(option.value)}
          role="radio"
          aria-checked={option.value === props.value}
          className={option.value === props.value ? 'selected' : ''}
          onClick={() => props.onChange(option.value)}
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
  const element = menu ? (
    <div className="context-menu" style={{ left: Math.min(menu.x, window.innerWidth - 200), top: Math.min(menu.y, window.innerHeight - menu.items.length * 32 - 12) }} role="menu">
      {menu.items.map((item) => (
        <button key={item.label} role="menuitem" className={item.danger ? 'danger' : ''} disabled={item.disabled} onClick={item.onClick}>{item.label}</button>
      ))}
    </div>
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

export function Dialog(props: { title: string; children: ReactNode; onClose: () => void; width?: number }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div className="dialog" role="dialog" aria-modal aria-label={props.title} style={{ width: props.width ?? 540 }}>
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}
