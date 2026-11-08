import { useLayoutEffect, useRef, useState } from 'react';
import { Archive, ArrowDownCircle, Bookmark, Images, Link2, Settings, UserCircle2 } from 'lucide-react';
import { call, useAppState } from './api';
import { Spinner, ToastHost } from './components';
import { DownloadView } from './views/DownloadView';
import { EntryListView, initialFilters, type Filters } from './views/EntryListView';
import { GalleryView } from './views/GalleryView';
import { LibraryView } from './views/LibraryView';
import { SettingsView } from './views/SettingsView';
import type { AppState, Section } from '../shared/types';

export function App() {
  const state = useAppState();
  // 목록마다 거르기 조건을 따로 기억합니다. 다른 화면에 다녀와도 유지됩니다.
  const [filters, setFilters] = useState<Record<'scraps' | 'collection', Filters>>({ scraps: initialFilters(), collection: initialFilters() });
  if (!state) return <Spinner label="불러오는 중입니다" />;

  return (
    <div className={`app platform-${state.platform} ${state.material ? `material-${state.material}` : ''}`}>
      <Sidebar state={state} />
      <main className="content">
        {state.section === 'scraps' && (
          <EntryListView key="scraps" state={state} kind="scraps" filters={filters.scraps} onFilters={(value) => setFilters({ ...filters, scraps: value })} />
        )}
        {state.section === 'collection' && (
          <EntryListView key="collection" state={state} kind="collection" filters={filters.collection} onFilters={(value) => setFilters({ ...filters, collection: value })} />
        )}
        {state.section === 'downloads' && <DownloadView state={state} />}
        {state.section === 'library' && <LibraryView state={state} />}
        {state.section === 'gallery' && <GalleryView state={state} />}
        {state.section === 'settings' && <SettingsView state={state} />}
      </main>
      <ToastHost />
    </div>
  );
}

function Sidebar({ state }: { state: AppState }) {
  // 고른 항목 뒤의 배경이 다음 항목으로 미끄러져 갑니다.
  const items = useRef(new Map<Section, HTMLButtonElement>());
  const indicator = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    const target = items.current.get(state.section);
    const element = indicator.current;
    if (!target || !element) return;
    if (!placed.current) element.style.transition = 'none';
    element.style.transform = `translateY(${target.offsetTop}px)`;
    element.style.height = `${target.offsetHeight}px`;
    if (!placed.current) {
      void element.offsetHeight;
      element.style.transition = '';
      placed.current = true;
    }
  }, [state.section]);
  const item = (section: Section, label: string, icon: React.ReactNode, badge?: string | number) => (
    <button ref={(button) => { if (button) items.current.set(section, button); }} className={`nav-item ${state.section === section ? 'selected' : ''}`} onClick={() => void call('setSection', section)} aria-current={state.section === section}>
      {icon}
      <span>{label}</span>
      {badge !== undefined && badge !== 0 && badge !== '' && <span className="badge">{badge}</span>}
    </button>
  );
  return (
    <aside className="sidebar">
      <nav>
        <div className="nav-indicator" ref={indicator} aria-hidden />
        {item('scraps', '스크랩', <Bookmark size={17} />, state.newScrapCount)}
        {item('collection', '주소 수집', <Link2 size={17} />, state.collection.entries.length)}
        {item('downloads', '다운로드', <ArrowDownCircle size={17} />, state.job && ['running', 'paused', 'waitingForChallenge'].includes(state.job.status) ? '진행 중' : undefined)}
        {item('library', '보관함', <Archive size={17} />, Object.keys(state.records).length)}
        {item('gallery', '갤러리', <Images size={17} />)}
        <div className="nav-divider" />
        {item('settings', '설정', <Settings size={17} />)}
      </nav>
      <div className="account">
        <UserCircle2 size={30} className={state.login === 'loggedIn' ? 'accent' : 'muted'} />
        <div>
          {state.login === 'loggedIn' && (
            <>
              <strong title={state.username}>{state.username ?? '로그인됨'}</strong>
              {state.loginID && <span className="caption" title="보관함은 이 아이디로 나눕니다">@{state.loginID}</span>}
              <button className="link" onClick={() => void call('signOut')} disabled={state.job?.status === 'running' || state.job?.status === 'paused'}>로그아웃</button>
            </>
          )}
          {state.login === 'loggedOut' && (
            <>
              <strong>로그인 필요</strong>
              <button className="link" onClick={() => void call('signIn')}>로그인</button>
            </>
          )}
          {state.login === 'unknown' && (
            <>
              <strong>{state.username ?? '아카라이브'}</strong>
              <span className="caption">로그인 상태 확인 중…</span>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
