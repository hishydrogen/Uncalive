import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, Bookmark, CheckCircle2, Circle, Clock, Download, Link2, Loader2, Plus, RefreshCw, SlidersHorizontal, Square, Trash2, UserCircle2, X } from 'lucide-react';
import { call, formatAgo, formatShortDate, qualityTitles, usePreference } from '../api';
import { EmptyState, Header, SearchField, Select, showToast, Spinner, useContextMenu, usePresence } from '../components';
import { useChecks, useMarquee, useSelection } from '../selection';
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
  return parts.join(', ');
}

type ColumnKey = 'channel' | 'category' | 'author' | 'date';
const defaultWidths: Record<ColumnKey, number> = { channel: 110, category: 92, author: 110, date: 92 };
const resizable: Array<{ key: ColumnKey; label: string }> = [
  { key: 'channel', label: '채널' }, { key: 'category', label: '카테고리' }, { key: 'author', label: '작성자' }, { key: 'date', label: '작성일' },
];

type LiveStatus = PostStatus | 'active' | 'waiting';

const statusInfo: Record<LiveStatus, { label: string; detail: string }> = {
  new: { label: '안 받음', detail: '아직 받지 않은 글입니다.' },
  incomplete: { label: '일부만 받음', detail: '일부 파일을 받지 못했거나 압축본으로 대체된 글입니다. 다시 받으면 빠진 파일만 이어서 받습니다.' },
  saved: { label: '받음', detail: '모든 파일을 받았습니다.' },
  active: { label: '받는 중', detail: '지금 다운로드하고 있습니다.' },
  waiting: { label: '대기 중', detail: '다운로드 대기열에서 차례를 기다리고 있습니다.' },
};

/**
 * 체크한 글이 받으면 어떻게 되는지 나눠 보여 줍니다. 새로 받을 글, 빠진 파일만 이어받을 글, 이미 받아 다시 확인만 할 글입니다.
 * 거르기 조건 때문에 목록에 보이지 않는 글이 있으면 함께 알립니다.
 */
function SelectionSummary(props: { state: AppState; entries: ScrapEntry[]; checked: Set<string>; visible: string[]; isMac: boolean }) {
  const { state, entries, checked } = props;
  if (checked.size === 0) {
    return <span className="selection-summary muted" title="줄을 선택한 뒤 스페이스 바를 눌러도 체크할 수 있습니다.">다운로드할 글을 체크하세요</span>;
  }
  const counts = { new: 0, incomplete: 0, saved: 0 };
  for (const entry of entries) if (checked.has(entry.id)) counts[statusOf(state, entry)] += 1;
  const visible = new Set(props.visible);
  const hidden = [...checked].filter((id) => !visible.has(id)).length;
  const parts = [
    counts.new > 0 && <span key="new" title="아직 받지 않은 글입니다.">새로 받기 <b>{counts.new}</b></span>,
    counts.incomplete > 0 && <span key="incomplete" className="warn" title="빠진 파일만 이어서 받습니다.">이어받기 <b>{counts.incomplete}</b></span>,
    counts.saved > 0 && <span key="saved" title="이미 받은 글입니다. 기존 파일은 건너뛰고 바뀐 파일만 확인합니다.">다시 확인 <b>{counts.saved}</b></span>,
  ].filter(Boolean);
  return (
    <span className="selection-summary">
      <strong>{checked.size}개 체크됨</strong>
      {parts.map((part, index) => <span key={index} className="summary-part">{part}</span>)}
      {hidden > 0 && <span className="summary-part hidden-note" title="채널, 상태, 기간, 검색 필터 때문에 현재 목록에 보이지 않는 글입니다.">숨겨진 글 {hidden}개 포함</span>}
    </span>
  );
}

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
  return <span className={`status-icon ${status}`} title={`${info.label}: ${info.detail}`} aria-label={info.label}>{icon}</span>;
}

/** 바로 앞 화면(스크랩이나 링크)에 옵션 패널이 열려 있었는지입니다. 그랬다면 다음 화면에서 패널을 다시 열지 않고 그대로 둡니다. */
let inspectorOnScreen = false;

/** 스크랩과 링크가 함께 쓰는 글 목록 화면입니다. */
export function EntryListView(props: { state: AppState; kind: ListKind; filters: Filters; onFilters: (filters: Filters) => void }) {
  const { state, kind, filters } = props;
  const list = state[kind];
  const isScraps = kind === 'scraps';
  const [showOptions, setShowOptions] = usePreference('showDownloadOptions', true);
  const [showAdd, setShowAdd] = useState(false);
  const panel = usePresence(showOptions, 220);
  // 앞 화면에서 이어 온 패널은 움직이지 않고, 옵션 단추로 열 때만 밀려 나옵니다.
  const [kept] = useState(() => inspectorOnScreen && showOptions);
  const [slide, setSlide] = useState(false);
  useEffect(() => {
    inspectorOnScreen = panel.mounted && !panel.closing;
    return () => { inspectorOnScreen = false; };
  }, [panel.mounted, panel.closing]);
  const menu = useContextMenu();
  const set = (patch: Partial<Filters>) => props.onFilters({ ...filters, ...patch });

  const title = (entry: ScrapEntry) => state.records[entry.id]?.title ?? entry.title;
  const category = (entry: ScrapEntry) => entry.category ?? state.records[entry.id]?.category;

  const channels = useMemo(() => {
    const seen = new Map<string, string>();
    for (const entry of list.entries) if (!seen.has(entry.channel)) seen.set(entry.channel, entry.channelName ?? entry.channel);
    return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }, [list.entries]);

  // 고른 채널이 지금 목록에 없으면(계정을 바꾼 뒤 등) 선택 상자는 '모든 채널'로 보이는데 목록은 그 채널로 걸러져 비어 버렸습니다.
  // 화면에 보이는 값과 거르는 값을 같게 둡니다.
  const channel = channels.some((item) => item.id === filters.channel) ? filters.channel : '';

  const visible = useMemo(() => {
    const query = filters.search.toLowerCase();
    return list.entries.filter((entry) => {
      if (channel && entry.channel !== channel) return false;
      if (filters.status !== 'all' && statusOf(state, entry) !== filters.status) return false;
      if (!matchesPeriod(filters, entry)) return false;
      if (query === '') return true;
      return title(entry).toLowerCase().includes(query) || (entry.author ?? '').toLowerCase().includes(query);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.entries, filters, channel, state.records]);

  const loading = list.load.kind === 'loading';
  const load = list.load;
  let subtitle = list.entries.length > 0 ? `${list.entries.length}개` : '';
  if (load.kind === 'loading' && load.mode === 'new') subtitle = '새 스크랩 확인 중…';
  else if (load.kind === 'loading' && load.page > 0) {
    const pages = `${load.page}${load.highestPage ? `/${load.highestPage}` : ''}페이지`;
    // 전체를 다시 읽는 동안에는 지금 목록을 그대로 두므로 개수 대신 진행만 보여 줍니다.
    subtitle = load.mode === 'full' && state.scrapsFullSyncAt ? `전체 목록 다시 불러오는 중 (${pages})` : `${pages} 불러오는 중 (${list.entries.length}개)`;
  } else if (isScraps && subtitle && state.scrapsFullSyncAt) subtitle += ` · 전체 확인 ${formatAgo(state.scrapsFullSyncAt)}`;
  const jobActive = state.job !== undefined && ['running', 'paused', 'waitingForChallenge'].includes(state.job.status);

  const isMac = state.platform === 'darwin';

  // 열 너비: 열의 왼쪽 경계를 끌어 바꿉니다. 제목은 남는 너비를 모두 씁니다.
  const [widths, setWidths] = usePreference<Record<ColumnKey, number>>('columnWidths', defaultWidths);
  const startResize = (event: React.PointerEvent, key: ColumnKey) => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const start = widths[key] ?? defaultWidths[key];
    const onMove = (move: PointerEvent) => {
      const width = Math.round(Math.min(420, Math.max(52, start - (move.clientX - startX))));
      setWidths({ ...widths, [key]: width });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.classList.remove('resizing');
    };
    document.body.classList.add('resizing');
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  const live = useMemo(() => ({ active: new Set(state.job?.activeIDs ?? []), waiting: new Set(state.job?.waitingIDs ?? []) }), [state.job?.activeIDs, state.job?.waitingIDs]);
  const visibleIDs = useMemo(() => visible.map((entry) => entry.id), [visible]);
  // 두 가지를 따로 둡니다. 체크(다운로드할 글)는 체크 상자와 스페이스 바로만 바뀌고,
  // 강조(보라색)는 Finder처럼 누르기, 끌기, 방향키로 바뀝니다. 다른 곳을 잘못 눌러도 체크는 풀리지 않습니다.
  const checks = useChecks(kind, list.checked);
  const selection = useSelection(visibleIDs);
  // 마우스: 줄을 누르면 고르고, 누른 채 끌면 상자 안의 줄을 고릅니다. 두 번 누르면 받은 글은 열고, 아니면 원문을 엽니다.
  const marquee = useMarquee(selection, state.platform === 'darwin', {
    onOpen: (id) => {
      const entry = list.entries.find((item) => item.id === id);
      if (!entry) return;
      if (state.records[id]) void call('openPost', id); else window.open(entry.url);
    },
  });
  const rows = marquee.items;
  const checked = checks.checked;
  const highlighted = selection.selected;
  const allVisibleChecked = visible.length > 0 && visible.every((entry) => checked.has(entry.id));
  const checkedCount = checked.size;

  /** 체크를 바꿉니다. 여러 글의 체크를 한꺼번에 해제하면 되돌릴 수 있게 알립니다. */
  const setChecks = useCallback((ids: string[], value: boolean) => {
    const before = checks.set(ids, value);
    const lost = [...before].filter((id) => !checks.now().has(id)).length;
    if (!value && lost > 1) showToast(`${lost}개 체크를 해제했습니다`, { label: '실행 취소', run: () => checks.commit(before) });
  }, [checks]);

  /** 스페이스 바와 메뉴입니다. 선택한 글이 모두 체크되어 있으면 해제하고, 아니면 모두 체크합니다. */
  const toggleHighlighted = useCallback(() => {
    const targets = [...selection.now()];
    if (targets.length === 0 && selection.cursor) targets.push(selection.cursor);
    if (targets.length === 0) return;
    setChecks(targets, !targets.every((id) => checks.now().has(id)));
  }, [selection, checks, setChecks]);

  /** 목록에서 삭제하고, 실행 취소를 알림에 붙입니다. */
  const remove = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    const count = await call('removeFromCollectionMany', ids);
    if (count > 0) showToast(`${count}개를 목록에서 삭제했습니다`, { label: '실행 취소', run: () => void call('undoRemoveFromCollection') });
  }, []);

  // 키보드: ⌘A(Ctrl+A) 모두 선택, Esc 선택 해제, 방향키 이동, 스페이스 바 선택한 글 체크, Delete 삭제, ⌘Z 되돌리기, Enter 다운로드.
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
        void call('undoRemoveFromCollection').then((count) => { if (count > 0) showToast(`${count}개를 복구했습니다`); });
      } else if (key === 'Escape') {
        selection.clear();
      } else if (key === 'ArrowDown' || key === 'ArrowUp') {
        event.preventDefault();
        selection.move(key === 'ArrowDown' ? 1 : -1, event.shiftKey);
      } else if (key === ' ' && target?.tagName !== 'BUTTON') {
        event.preventDefault();
        toggleHighlighted();
      } else if (key === 'Delete' || key === 'Backspace') {
        const targets = [...selection.now()];
        if (targets.length === 0) return;
        event.preventDefault();
        if (isScraps) {
          setChecks(targets, false);
          showToast('스크랩은 아카라이브 웹에서만 삭제할 수 있어 체크만 해제했습니다');
        } else {
          selection.clear();
          void remove(targets);
        }
      } else if (key === 'Enter' && target?.tagName !== 'BUTTON') {
        if (checks.now().size > 0) void call('startDownload', kind);
        else showToast('다운로드할 글을 먼저 체크해 주세요. 선택한 줄에서 스페이스 바를 눌러도 됩니다');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, checks, showAdd, kind, isScraps, isMac, remove, toggleHighlighted, setChecks]);

  // 커서가 옮겨 가면 그 줄이 보이게 합니다.
  useEffect(() => {
    if (selection.cursor) rows.current.get(selection.cursor)?.scrollIntoView({ block: 'nearest' });
  }, [selection.cursor]);


  let body: React.ReactNode;
  if (isScraps && state.login === 'loggedOut' && list.entries.length === 0 && !loading) {
    body = (
      <EmptyState
        icon={<UserCircle2 size={44} />}
        title="로그인이 필요합니다"
        description={<>아카라이브 계정으로 로그인하면 스크랩한 글을 불러옵니다.<br />비밀번호는 아카라이브 로그인 창에서 직접 입력하며, 앱에는 저장되지 않습니다.</>}
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
    else if (isScraps) body = <EmptyState icon={<Bookmark size={44} />} title="스크랩한 글이 없습니다" description="아카라이브에서 글을 스크랩한 뒤 새로고침을 눌러 주세요." />;
    else body = (
      <EmptyState
        icon={<Link2 size={44} />}
        title="추가한 글이 없습니다"
        description={<>게시글 주소나 채널, 개념글, 검색 결과 같은 목록 주소를 추가해 글을 모을 수 있습니다.<br />여기서 추가한 글은 스크랩 목록과 따로 관리됩니다.</>}
        actions={<button className="primary" onClick={() => setShowAdd(true)}>주소 추가</button>}
      />
    );
  } else {
    body = (
      <div className="list-body">
        <div className="filter-bar">
          <Select label="채널" value={channel} onChange={(channel) => set({ channel })} options={[{ value: '', label: '모든 채널' }, ...channels.map((channel) => ({ value: channel.id, label: channel.name }))]} />
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
        <div className="table-wrap" ref={marquee.container} tabIndex={-1} onMouseDown={marquee.onMouseDown} aria-multiselectable>
          <table className="entries">
            <colgroup>
              <col style={{ width: 38 }} />
              <col />
              {resizable.map((column) => <col key={column.key} style={{ width: widths[column.key] ?? defaultWidths[column.key] }} />)}
              <col style={{ width: isScraps ? 52 : 64 }} />
            </colgroup>
            <thead>
              <tr>
                <th className="check">
                  <input type="checkbox" aria-label="보이는 글 모두 체크" checked={allVisibleChecked} onChange={(event) => setChecks(visibleIDs, event.target.checked)} />
                </th>
                <th>제목</th>
                {resizable.map((column) => (
                  <th key={column.key} className={column.key}>
                    <span
                      className="col-resize"
                      title="끌어서 열 너비를 조절합니다. 두 번 클릭하면 기본 너비로 돌아갑니다."
                      onPointerDown={(event) => startResize(event, column.key)}
                      onDoubleClick={() => setWidths({ ...widths, [column.key]: defaultWidths[column.key] })}
                    />
                    {column.label}
                  </th>
                ))}
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
                    ref={marquee.register(entry.id)}
                    className={`${checked.has(entry.id) ? 'checked' : ''} ${highlighted.has(entry.id) ? 'highlighted' : ''} ${selection.cursor === entry.id ? 'cursor' : ''}`}
                    aria-selected={highlighted.has(entry.id)}
                    onContextMenu={(event) => {
                      // 선택하지 않은 줄에서 메뉴를 열면 그 줄만 선택합니다(Finder와 같습니다). 메뉴는 선택한 글에 적용됩니다.
                      const targets = selection.now().has(entry.id) ? [...selection.now()] : [entry.id];
                      if (!selection.now().has(entry.id)) selection.click(entry.id, { toggle: false, range: false });
                      const many = targets.length > 1 ? ` (${targets.length}개)` : '';
                      const allChecked = targets.every((id) => checks.now().has(id));
                      menu.open(event, [
                        { label: allChecked ? `체크 해제${many}` : `체크${many}`, onClick: () => setChecks(targets, !allChecked) },
                        { label: '원문 열기', onClick: () => window.open(entry.url) },
                        ...(state.records[entry.id] ? [{ label: '받은 글 열기', onClick: () => void call('openPost', entry.id) }] : []),
                        ...(!isScraps ? [{ label: `목록에서 삭제${many}`, danger: true, onClick: () => { selection.clear(); void remove(targets); } }] : []),
                      ]);
                    }}
                  >
                    <td className="check">
                      <input type="checkbox" aria-label="다운로드할 글로 체크" checked={checked.has(entry.id)} onChange={() => checks.toggle(entry.id)} />
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
                        <button className="plain remove" title="목록에서 삭제" aria-label="목록에서 삭제" onClick={() => void remove([entry.id])}><X size={14} /></button>
                      )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {marquee.box && <div className="marquee" style={marquee.box} />}
        </div>
        <div className="action-bar">
          <Select<string> label="체크" value="" onChange={(value) => {
            if (value === 'all') setChecks(visibleIDs, true);
            if (value === 'none') setChecks([...checks.now()], false);
            if (value === 'unsaved') setChecks(visible.filter((entry) => statusOf(state, entry) !== 'saved').map((entry) => entry.id), true);
            if (value === 'highlighted') setChecks([...selection.now()], true);
          }} options={[
            { value: '', label: '체크 선택' }, { value: 'all', label: '보이는 글 모두 체크' }, { value: 'unsaved', label: '안 받은 글만 체크' },
            ...(highlighted.size > 0 ? [{ value: 'highlighted', label: `선택한 글 체크 (${highlighted.size}개, 스페이스 바)` }] : []),
            { value: 'none', label: '체크 모두 해제' },
          ]} />
          {!isScraps && <button onClick={() => { const targets = [...selection.now()]; selection.clear(); void remove(targets); }} disabled={highlighted.size === 0} title="선택한 글을 목록에서 삭제합니다 (Delete)">선택 삭제</button>}
          <SelectionSummary state={state} entries={list.entries} checked={checked} visible={visibleIDs} isMac={isMac} />
          <span className="spacer" />
          <button className="primary" onClick={() => {
            if (loading) showToast('목록 불러오기를 멈추고 다운로드를 시작합니다');
            void call('startDownload', kind);
          }} disabled={checkedCount === 0}>
            <Download size={15} /> {jobActive ? '대기열에 추가' : '다운로드 시작'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`screen ${kept ? 'keeps-inspector' : ''}`}>
      <Header title={isScraps ? '스크랩' : '링크'} subtitle={subtitle}>
        {list.entries.length > 0 && <SearchField value={filters.search} onChange={(search) => set({ search })} placeholder="제목, 작성자 검색" />}
        {loading ? (
          <button onClick={() => void call('stopLoading')}><Square size={14} /> 중지</button>
        ) : isScraps ? (
          <button onClick={() => void call('refreshScraps')} disabled={state.isBusy || state.login === 'loggedOut'} title={`새 스크랩 확인 (${isMac ? '⌘R' : 'Ctrl+R'})\n첫 페이지부터 확인하다가 이미 목록에 있는 글이 나오면 멈춥니다. 스크랩을 해제한 글까지 반영하려면 설정이나 파일 메뉴에서 ‘전체 다시 불러오기’(${isMac ? '⇧⌘R' : 'Ctrl+Shift+R'})를 눌러 주세요.`}><RefreshCw size={14} /> 새로고침</button>
        ) : (
          <>
            <button onClick={() => setShowAdd(true)}><Plus size={14} /> 주소 추가</button>
            <button onClick={() => void remove(list.entries.map((entry) => entry.id))} disabled={list.entries.length === 0}><Trash2 size={14} /> 목록 비우기</button>
          </>
        )}
        <button onClick={() => void call('exportCSV', kind, visible.map((entry) => entry.id))} disabled={list.entries.length === 0}>CSV로 내보내기</button>
        <button className={showOptions ? 'selected icon' : 'icon'} onClick={() => { setSlide(!showOptions); setShowOptions(!showOptions); }} title={showOptions ? '다운로드 옵션 숨기기' : '다운로드 옵션 보기'} aria-label="다운로드 옵션">
          <SlidersHorizontal size={15} />
        </button>
      </Header>
      <div className="split">
        <section className="split-main">{body}</section>
        {panel.mounted && <OptionsPanel state={state} closing={panel.closing} slide={slide} />}
      </div>
      {showAdd && <AddURLsDialog state={state} onClose={() => setShowAdd(false)} />}
      {menu.element}
    </div>
  );
}
