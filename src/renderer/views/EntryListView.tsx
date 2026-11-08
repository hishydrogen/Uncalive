import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, Bookmark, CheckCircle2, Circle, Clock, Download, Link2, Loader2, Plus, RefreshCw, SlidersHorizontal, Square, Trash2, UserCircle2, X } from 'lucide-react';
import { call, formatShortDate, qualityTitles, usePreference } from '../api';
import { EmptyState, Header, SearchField, Select, showToast, Spinner, useContextMenu, usePresence } from '../components';
import { modifiersOf, useSelection } from '../selection';
import type { AppState, ListKind, PostStatus, ScrapEntry } from '../../shared/types';
import { AddURLsDialog } from './AddURLsDialog';
import { OptionsPanel } from './OptionsPanel';

type StatusFilter = 'all' | PostStatus;
type Period = 'all' | 'week' | 'month' | 'year' | 'custom';

export interface Filters {
  search: string;
  channel: string;
  status: StatusFilter;
  period: Period;
  from: string;
  to: string;
}

const today = () => new Date().toISOString().slice(0, 10);

export function initialFilters(): Filters {
  const monthAgo = new Date();
  monthAgo.setMonth(monthAgo.getMonth() - 1);
  return { search: '', channel: '', status: 'all', period: 'all', from: monthAgo.toISOString().slice(0, 10), to: today() };
}

export function statusOf(state: AppState, entry: ScrapEntry): PostStatus {
  const record = state.records[entry.id];
  if (!record) return 'new';
  return record.completed ? 'saved' : 'incomplete';
}

/** 작성일을 모르는 글은 기간을 정하면 보이지 않습니다. */
function matchesPeriod(filters: Filters, entry: ScrapEntry): boolean {
  if (filters.period === 'all') return true;
  if (!entry.createdAt) return false;
  const date = new Date(entry.createdAt).getTime();
  if (Number.isNaN(date)) return false;
  const day = 86_400_000;
  const now = Date.now();
  switch (filters.period) {
    case 'week': return date >= now - 7 * day;
    case 'month': return date >= now - 30 * day;
    case 'year': return date >= now - 365 * day;
    case 'custom': {
      const start = new Date(filters.from + 'T00:00:00').getTime();
      const end = new Date(filters.to + 'T00:00:00').getTime() + day;
      return date >= start && date < end;
    }
    default: return true;
  }
}

export function optionsSummary(state: AppState): string {
  const options = state.options;
  const kinds = [
    options.includeImages && '이미지', options.includeVideos && '동영상', options.includeAudio && '오디오', options.includeEmoticons && '아카콘',
  ].filter(Boolean);
  const parts = [qualityTitles[options.quality], kinds.length === 0 ? '받을 파일 없음' : kinds.join(', ')];
  if (options.archive.offlineHTML) parts.push('오프라인 페이지');
  return parts.join(' · ');
}

type LiveStatus = PostStatus | 'active' | 'waiting';

const statusInfo: Record<LiveStatus, { label: string; detail: string }> = {
  new: { label: '안 받음', detail: '아직 받지 않은 글입니다.' },
  incomplete: { label: '일부만 받음', detail: '받지 못했거나 원본 대신 압축본으로 받은 파일이 있습니다. 다시 받으면 그 파일만 이어서 받습니다.' },
  saved: { label: '받음', detail: '모든 파일을 받았습니다.' },
  active: { label: '받는 중', detail: '지금 받고 있습니다.' },
  waiting: { label: '대기 중', detail: '다운로드 대기열에서 차례를 기다리고 있습니다.' },
};

/** 글 상태를 아이콘으로 보여 줍니다. 마우스를 올리면 뜻을 알려 줍니다. */
function StatusIcon({ status }: { status: LiveStatus }) {
  const info = statusInfo[status];
  const icon = {
    new: <Circle size={15} />,
    incomplete: <AlertCircle size={15} />,
    saved: <CheckCircle2 size={15} />,
    active: <Loader2 size={15} className="spin" />,
    waiting: <Clock size={15} />,
  }[status];
  return <span className={`status-icon ${status}`} title={`${info.label} · ${info.detail}`} aria-label={info.label}>{icon}</span>;
}

/** 스크랩과 주소 수집이 함께 쓰는 글 목록 화면입니다. */
export function EntryListView(props: { state: AppState; kind: ListKind; filters: Filters; onFilters: (filters: Filters) => void }) {
  const { state, kind, filters } = props;
  const list = state[kind];
  const isScraps = kind === 'scraps';
  const [showOptions, setShowOptions] = usePreference('showDownloadOptions', true);
  const [showAdd, setShowAdd] = useState(false);
  const panel = usePresence(showOptions, 220);
  const menu = useContextMenu();
  const set = (patch: Partial<Filters>) => props.onFilters({ ...filters, ...patch });

  const title = (entry: ScrapEntry) => state.records[entry.id]?.title ?? entry.title;
  const category = (entry: ScrapEntry) => entry.category ?? state.records[entry.id]?.category;

  const channels = useMemo(() => {
    const seen = new Map<string, string>();
    for (const entry of list.entries) if (!seen.has(entry.channel)) seen.set(entry.channel, entry.channelName ?? entry.channel);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }, [list.entries]);

  const visible = useMemo(() => {
    const query = filters.search.toLowerCase();
    return list.entries.filter((entry) => {
      if (filters.channel && entry.channel !== filters.channel) return false;
      if (filters.status !== 'all' && statusOf(state, entry) !== filters.status) return false;
      if (!matchesPeriod(filters, entry)) return false;
      if (query === '') return true;
      return title(entry).toLowerCase().includes(query) || (entry.author ?? '').toLowerCase().includes(query);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.entries, filters, state.records]);

  const loading = list.load.kind === 'loading';
  const subtitle = list.load.kind === 'loading' && list.load.page > 0
    ? `${list.load.page}${list.load.highestPage ? ` / ${list.load.highestPage}` : ''}페이지 읽는 중 · ${list.entries.length}개`
    : list.entries.length > 0 ? `${list.entries.length}개` : '';
  const jobActive = state.job !== undefined && ['running', 'paused', 'waitingForChallenge'].includes(state.job.status);

  const isMac = state.platform === 'darwin';
  const live = useMemo(() => ({ active: new Set(state.job?.activeIDs ?? []), waiting: new Set(state.job?.waitingIDs ?? []) }), [state.job?.activeIDs, state.job?.waitingIDs]);
  const visibleIDs = useMemo(() => visible.map((entry) => entry.id), [visible]);
  const selection = useSelection(kind, visibleIDs, list.checked);
  const checked = selection.selected;
  const allVisibleChecked = visible.length > 0 && visible.every((entry) => checked.has(entry.id));
  const checkedCount = checked.size;

  /** 목록에서 빼고, 실행 취소를 알림에 붙입니다. */
  const remove = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    const count = await call('removeFromCollectionMany', ids);
    if (count > 0) showToast(`${count}개를 목록에서 뺐습니다`, { label: '실행 취소', run: () => void call('undoRemoveFromCollection') });
  }, []);

  // 키보드: ⌘A(Ctrl+A) 모두 선택, Esc 선택 해제, 방향키 이동, 스페이스 바 넣고 빼기, Delete 빼기, ⌘Z 되돌리기, Enter 다운로드.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (showAdd || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      if (document.querySelector('.dialog, .context-menu, .lightbox')) return;
      const command = isMac ? event.metaKey : event.ctrlKey;
      const key = event.key;
      if (command && key.toLowerCase() === 'a') {
        event.preventDefault();
        selection.selectAll();
      } else if (command && key.toLowerCase() === 'z' && !event.shiftKey) {
        if (isScraps) return;
        event.preventDefault();
        void call('undoRemoveFromCollection').then((count) => { if (count > 0) showToast(`${count}개를 되돌렸습니다`); });
      } else if (key === 'Escape') {
        selection.clear();
      } else if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        selection.move(key === 'ArrowDown' ? 1 : -1, event.shiftKey);
      } else if (key === ' ' && selection.cursor && target?.tagName !== 'BUTTON') {
        event.preventDefault();
        selection.toggle(selection.cursor);
      } else if (key === 'Delete' || key === 'Backspace') {
        const targets = selection.now();
        if (targets.size === 0) return;
        event.preventDefault();
        if (isScraps) {
          selection.clear();
          showToast('스크랩은 아카라이브에서만 지울 수 있어 선택만 해제했습니다');
        } else {
          void remove([...targets]);
        }
      } else if (key === 'Enter' && target?.tagName !== 'BUTTON') {
        if (selection.now().size > 0 && !loading) void call('startDownload', kind);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, checked, checkedCount, loading, showAdd, kind, isScraps, isMac, remove]);

  // 커서가 옮겨 가면 그 줄이 보이게 합니다.
  useEffect(() => {
    if (selection.cursor) rows.current.get(selection.cursor)?.scrollIntoView({ block: 'nearest' });
  }, [selection.cursor]);

  // 마우스: 줄을 누르면 고르고, 누른 채 끌면 상자 안의 줄을 고릅니다. 가장자리로 끌면 저절로 굴러갑니다.
  const wrap = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLTableRowElement>());
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number }>();

  const onPointerDown = (event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const element = event.target as HTMLElement;
    if (element.closest('input, button, a, select, th')) return;
    const container = wrap.current;
    if (!container) return;
    event.preventDefault();
    container.focus({ preventScroll: true });
    const modifiers = modifiersOf(event, isMac);
    const additive = modifiers.toggle || modifiers.range;
    const base = additive ? new Set(checked) : new Set<string>();
    const rowID = element.closest('tr')?.dataset.id;
    const origin = container.getBoundingClientRect();
    const start = { x: event.clientX - origin.left + container.scrollLeft, y: event.clientY - origin.top + container.scrollTop };
    let pointer = { x: event.clientX, y: event.clientY };
    let moved = false;
    let frame = 0;
    let latest = base;

    const update = () => {
      const rect = container.getBoundingClientRect();
      // 가장자리 가까이 끌면 그만큼 빠르게 굴립니다.
      const edge = 36;
      if (pointer.y < rect.top + edge) container.scrollTop -= Math.ceil((rect.top + edge - pointer.y) / 3);
      else if (pointer.y > rect.bottom - edge) container.scrollTop += Math.ceil((pointer.y - (rect.bottom - edge)) / 3);
      const now = { x: pointer.x - rect.left + container.scrollLeft, y: pointer.y - rect.top + container.scrollTop };
      const top = Math.min(start.y, now.y);
      const bottom = Math.max(start.y, now.y);
      const left = Math.max(0, Math.min(start.x, now.x));
      setBox({ top, left, width: Math.abs(now.x - start.x), height: bottom - top });
      const next = new Set(base);
      rows.current.forEach((row, id) => {
        if (row.offsetTop < bottom && row.offsetTop + row.offsetHeight > top) next.add(id);
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
        // 끌기를 마친 줄을 지금 줄로 삼아, 방향키가 거기서 이어지게 합니다.
        const rect = container.getBoundingClientRect();
        const y = pointer.y - rect.top + container.scrollTop;
        let end: string | undefined;
        rows.current.forEach((row, id) => { if (row.offsetTop <= y && y < row.offsetTop + row.offsetHeight) end = id; });
        if (end) selection.setCursor(end);
      }
      else if (rowID) selection.click(rowID, modifiers);
      else if (!additive) selection.clear();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  let body: React.ReactNode;
  if (isScraps && state.login === 'loggedOut' && list.entries.length === 0 && !loading) {
    body = (
      <EmptyState
        icon={<UserCircle2 size={44} />}
        title="로그인이 필요합니다"
        description={<>아카라이브 계정으로 로그인하면 스크랩 목록을 불러옵니다.<br />비밀번호는 아카라이브 로그인 화면에서 직접 입력하며, 앱에는 저장되지 않습니다.</>}
        actions={<button className="primary" onClick={() => void call('signIn')}>로그인</button>}
      />
    );
  } else if (list.load.kind === 'failed' && list.entries.length === 0) {
    body = (
      <EmptyState
        icon={<AlertTriangle size={44} />}
        title="목록을 불러오지 못했습니다"
        description={list.load.message}
        actions={<button onClick={() => (isScraps ? void call('refreshScraps') : setShowAdd(true))}>다시 시도</button>}
      />
    );
  } else if (list.entries.length === 0) {
    if (loading || (isScraps && state.login === 'unknown')) body = <Spinner label="목록을 불러오는 중입니다" />;
    else if (isScraps) body = <EmptyState icon={<Bookmark size={44} />} title="스크랩한 글이 없습니다" description="아카라이브에서 글을 스크랩한 뒤 새로고침하세요." />;
    else body = (
      <EmptyState
        icon={<Link2 size={44} />}
        title="수집한 글이 없습니다"
        description={<>개별 글 주소나 채널, 개념글, 검색 결과 등의 목록 주소를 추가해 글을 모을 수 있습니다.<br />스크랩 목록과는 별도로 관리됩니다.</>}
        actions={<button className="primary" onClick={() => setShowAdd(true)}>주소 추가</button>}
      />
    );
  } else {
    body = (
      <div className="list-body">
        <div className="filter-bar">
          <Select label="채널" value={filters.channel} onChange={(channel) => set({ channel })} options={[{ value: '', label: '모든 채널' }, ...channels.map((channel) => ({ value: channel.id, label: channel.name }))]} />
          <Select<StatusFilter> label="상태" value={filters.status} onChange={(status) => set({ status })} options={[
            { value: 'all', label: '모든 상태' }, { value: 'new', label: '안 받음' }, { value: 'incomplete', label: '일부만 받음' }, { value: 'saved', label: '받음' },
          ]} />
          <Select<Period> label="기간" value={filters.period} onChange={(period) => set({ period })} options={[
            { value: 'all', label: '전체 기간' }, { value: 'week', label: '최근 7일' }, { value: 'month', label: '최근 30일' }, { value: 'year', label: '최근 1년' }, { value: 'custom', label: '직접 지정' },
          ]} />
          {filters.period === 'custom' && (
            <>
              <input type="date" aria-label="시작" value={filters.from} onChange={(event) => set({ from: event.target.value })} />
              <span className="muted">-</span>
              <input type="date" aria-label="끝" value={filters.to} onChange={(event) => set({ to: event.target.value })} />
            </>
          )}
          <span className="spacer" />
          <span className="caption">{visible.length}개 표시</span>
        </div>
        <div className="table-wrap" ref={wrap} tabIndex={-1} onMouseDown={onPointerDown} aria-multiselectable>
          <table className="entries">
            <thead>
              <tr>
                <th className="check">
                  <input type="checkbox" aria-label="보이는 글 모두 선택" checked={allVisibleChecked} onChange={(event) => (event.target.checked ? selection.selectAll() : selection.clear())} />
                </th>
                <th>제목</th>
                <th className="channel">채널</th>
                <th className="category">카테고리</th>
                <th className="author">작성자</th>
                <th className="date">작성일</th>
                <th className="status">상태</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => {
                const status = statusOf(state, entry);
                return (
                  <tr
                    key={entry.id}
                    data-id={entry.id}
                    ref={(row) => { if (row) rows.current.set(entry.id, row); else rows.current.delete(entry.id); }}
                    className={`${checked.has(entry.id) ? 'checked' : ''} ${selection.cursor === entry.id ? 'cursor' : ''}`}
                    aria-selected={checked.has(entry.id)}
                    onContextMenu={(event) => {
                      // 고르지 않은 줄에서 메뉴를 열면 그 줄만 고릅니다(Finder와 같습니다).
                      const targets = checked.has(entry.id) ? [...checked] : [entry.id];
                      if (!checked.has(entry.id)) selection.click(entry.id, { toggle: false, range: false });
                      menu.open(event, [
                        { label: '원문 열기', onClick: () => window.open(entry.url) },
                        ...(state.records[entry.id] ? [{ label: '받은 글 열기', onClick: () => void call('openPost', entry.id) }] : []),
                        ...(!isScraps ? [{ label: targets.length > 1 ? `고른 ${targets.length}개 목록에서 빼기` : '목록에서 빼기', danger: true, onClick: () => void remove(targets) }] : []),
                      ]);
                    }}
                  >
                    <td className="check">
                      <input type="checkbox" aria-label="선택" checked={checked.has(entry.id)} onChange={() => selection.toggle(entry.id)} />
                    </td>
                    <td className="title" title={title(entry)}>{title(entry)}</td>
                    <td className="channel">{entry.channelName ?? entry.channel}</td>
                    <td className="category">{category(entry) ?? ''}</td>
                    <td className="author">{entry.author ?? ''}</td>
                    <td className="date">{formatShortDate(entry.createdAt)}</td>
                    <td className="status">
                      <span className="status-cell">
                      <StatusIcon status={live.active.has(entry.id) ? 'active' : live.waiting.has(entry.id) ? 'waiting' : status} />
                      {!isScraps && (
                        <button className="plain remove" title="목록에서 빼기" aria-label="목록에서 빼기" onClick={() => void remove([entry.id])}><X size={14} /></button>
                      )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {box && <div className="marquee" style={box} />}
        </div>
        <div className="action-bar">
          <Select<string> label="선택" value="" onChange={(value) => {
            if (value === 'all') selection.selectAll();
            if (value === 'none') selection.clear();
            if (value === 'unsaved') selection.commit(new Set(visible.filter((entry) => statusOf(state, entry) !== 'saved').map((entry) => entry.id)));
          }} options={[
            { value: '', label: '선택…' }, { value: 'all', label: `모두 선택 (${isMac ? '⌘A' : 'Ctrl+A'})` }, { value: 'none', label: '선택 해제 (Esc)' }, { value: 'unsaved', label: '안 받은 글만 선택' },
          ]} />
          {!isScraps && <button onClick={() => void remove([...checked])} disabled={checkedCount === 0} title={isMac ? 'Delete' : 'Delete'}>고른 글 빼기</button>}
          <button className="plain summary" title="다운로드 옵션 보기" onClick={() => setShowOptions(true)}>{optionsSummary(state)}</button>
          <span className="spacer" />
          <span className="muted nowrap">{checkedCount}개 선택됨</span>
          <button className="primary" onClick={() => void call('startDownload', kind)} disabled={checkedCount === 0 || loading}>
            <Download size={15} /> {jobActive ? '대기열에 추가' : '다운로드 시작'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <Header title={isScraps ? '스크랩' : '주소 수집'} subtitle={subtitle}>
        {list.entries.length > 0 && <SearchField value={filters.search} onChange={(search) => set({ search })} placeholder="제목, 작성자 검색" />}
        {loading ? (
          <button onClick={() => void call('stopLoading')}><Square size={14} /> 중지</button>
        ) : isScraps ? (
          <button onClick={() => void call('refreshScraps')} disabled={state.isBusy || state.login === 'loggedOut'} title="새로고침 (Ctrl+R)"><RefreshCw size={14} /> 새로고침</button>
        ) : (
          <>
            <button onClick={() => setShowAdd(true)}><Plus size={14} /> 주소 추가</button>
            <button onClick={() => void remove(list.entries.map((entry) => entry.id))} disabled={list.entries.length === 0}><Trash2 size={14} /> 목록 비우기</button>
          </>
        )}
        <button onClick={() => void call('exportCSV', kind, visible.map((entry) => entry.id))} disabled={list.entries.length === 0}>CSV로 내보내기</button>
        <button className={showOptions ? 'selected icon' : 'icon'} onClick={() => setShowOptions(!showOptions)} title={showOptions ? '다운로드 옵션 숨기기' : '다운로드 옵션 보기'} aria-label="다운로드 옵션">
          <SlidersHorizontal size={15} />
        </button>
      </Header>
      <div className="split">
        <section className="split-main">{body}</section>
        {panel.mounted && <OptionsPanel state={state} closing={panel.closing} />}
      </div>
      {showAdd && <AddURLsDialog state={state} onClose={() => setShowAdd(false)} />}
      {menu.element}
    </div>
  );
}
