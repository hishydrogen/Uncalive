import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bookmark, Download, Link2, Plus, RefreshCw, SlidersHorizontal, Square, Trash2, UserCircle2, X } from 'lucide-react';
import { call, formatShortDate, qualityTitles, usePreference } from '../api';
import { EmptyState, Header, SearchField, Select, Spinner, useContextMenu } from '../components';
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

const statusLabels: Record<PostStatus, string> = { new: '안 받음', incomplete: '일부만 받음', saved: '받음' };

/** 스크랩과 주소 수집이 함께 쓰는 글 목록 화면입니다. */
export function EntryListView(props: { state: AppState; kind: ListKind; filters: Filters; onFilters: (filters: Filters) => void }) {
  const { state, kind, filters } = props;
  const list = state[kind];
  const isScraps = kind === 'scraps';
  const [showOptions, setShowOptions] = usePreference('showDownloadOptions', true);
  const [showAdd, setShowAdd] = useState(false);
  const menu = useContextMenu();
  const anchor = useRef<string>(undefined);
  const set = (patch: Partial<Filters>) => props.onFilters({ ...filters, ...patch });

  const checked = useMemo(() => new Set(list.checked), [list.checked]);
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

  /** 줄을 누르면 고르고, Shift를 누른 채 누르면 사이의 글을 모두 같은 상태로 바꿉니다. */
  const toggle = (entry: ScrapEntry, shift: boolean) => {
    const value = !checked.has(entry.id);
    if (shift && anchor.current) {
      const ids = visible.map((item) => item.id);
      const [a, b] = [ids.indexOf(anchor.current), ids.indexOf(entry.id)].sort((x, y) => x - y);
      if (a >= 0) {
        void call('setChecked', kind, ids.slice(a, b + 1), value);
        anchor.current = entry.id;
        return;
      }
    }
    anchor.current = entry.id;
    void call('setChecked', kind, [entry.id], value);
  };

  const allVisibleChecked = visible.length > 0 && visible.every((entry) => checked.has(entry.id));
  const checkedCount = list.checked.length;

  // Enter로 다운로드를 시작합니다. 입력 칸이나 대화 상자에서 누른 Enter는 건드리지 않습니다.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || showAdd || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target.tagName)) return;
      if (checkedCount > 0 && !loading) void call('startDownload', kind);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [checkedCount, loading, showAdd, kind]);

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
        <div className="table-wrap">
          <table className="entries">
            <thead>
              <tr>
                <th className="check">
                  <input type="checkbox" aria-label="보이는 글 모두 선택" checked={allVisibleChecked} onChange={(event) => void call('setChecked', kind, visible.map((entry) => entry.id), event.target.checked)} />
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
                    className={checked.has(entry.id) ? 'checked' : ''}
                    onClick={(event) => toggle(entry, event.shiftKey)}
                    onContextMenu={(event) => menu.open(event, [
                      { label: '원문 열기', onClick: () => window.open(entry.url) },
                      ...(state.records[entry.id] ? [{ label: '받은 글 열기', onClick: () => void call('openPost', entry.id) }] : []),
                      ...(!isScraps ? [{ label: '목록에서 제거', danger: true, onClick: () => void call('removeFromCollection', entry.id) }] : []),
                    ])}
                  >
                    <td className="check">
                      <input type="checkbox" aria-label="선택" checked={checked.has(entry.id)} onClick={(event) => event.stopPropagation()} onChange={(event) => {
                        anchor.current = entry.id;
                        void call('setChecked', kind, [entry.id], event.target.checked);
                      }} />
                    </td>
                    <td className="title" title={title(entry)}>{title(entry)}</td>
                    <td className="channel">{entry.channelName ?? entry.channel}</td>
                    <td className="category">{category(entry) ?? ''}</td>
                    <td className="author">{entry.author ?? ''}</td>
                    <td className="date">{formatShortDate(entry.createdAt)}</td>
                    <td className="status">
                      <span className={`status-badge ${status}`} title={statusLabels[status]} aria-label={statusLabels[status]} />
                      {!isScraps && (
                        <button className="plain remove" title="목록에서 제거" aria-label="목록에서 제거" onClick={(event) => {
                          event.stopPropagation();
                          void call('removeFromCollection', entry.id);
                        }}><X size={14} /></button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="action-bar">
          <Select<string> label="선택" value="" onChange={(value) => {
            if (value === 'all') void call('setChecked', kind, visible.map((entry) => entry.id), true);
            if (value === 'none') void call('setChecked', kind, visible.map((entry) => entry.id), false);
            if (value === 'unsaved') void call('checkUnsaved', kind);
          }} options={[
            { value: '', label: '선택…' }, { value: 'all', label: '보이는 글 모두 선택' }, { value: 'none', label: '보이는 글 모두 해제' }, { value: 'unsaved', label: '안 받은 글만 선택' },
          ]} />
          {!isScraps && <button onClick={() => void call('removeCheckedFromCollection')} disabled={checkedCount === 0}>선택 제거</button>}
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
            <button onClick={() => void call('clearCollection')} disabled={list.entries.length === 0}><Trash2 size={14} /> 목록 비우기</button>
          </>
        )}
        <button onClick={() => void call('exportCSV', kind, visible.map((entry) => entry.id))} disabled={list.entries.length === 0}>CSV로 내보내기</button>
        <button className={showOptions ? 'selected icon' : 'icon'} onClick={() => setShowOptions(!showOptions)} title={showOptions ? '다운로드 옵션 숨기기' : '다운로드 옵션 보기'} aria-label="다운로드 옵션">
          <SlidersHorizontal size={15} />
        </button>
      </Header>
      <div className="split">
        <section className="split-main">{body}</section>
        {showOptions && <OptionsPanel state={state} />}
      </div>
      {showAdd && <AddURLsDialog state={state} onClose={() => setShowAdd(false)} />}
      {menu.element}
    </div>
  );
}
