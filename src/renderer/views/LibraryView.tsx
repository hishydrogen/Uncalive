import { useEffect, useMemo, useState } from 'react';
import { Archive, ChevronDown, ChevronRight, FileText, Loader2, Play } from 'lucide-react';
import { call, mediaURL, usePreference } from '../api';
import { categoriesOf, CategoryTabs, Dialog, EmptyState, Header, SearchField, Segmented, Select, showToast, Spinner, useContextMenu, useVisible, type MenuItem } from '../components';
import { useCollectionKeys, useMarquee, useSelection } from '../selection';
import type { AppState, ArchiveSource, LibraryItem } from '../../shared/types';

type Layout = 'grid' | 'list';

/** 본문 검색은 메인 프로세스에서 합니다. 찾은 글의 번호와 검색어 주변 글자를 받습니다. */
export function useLibrarySearch(query: string, library: LibraryItem[]): Record<string, string | null> | undefined {
  const [found, setFound] = useState<Record<string, string | null>>();
  useEffect(() => {
    if (query.trim() === '') {
      setFound(undefined);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void call('searchLibrary', query).then((result) => { if (!cancelled) setFound(result); });
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, library]);
  return found;
}

export function channelsOf(library: LibraryItem[]): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const item of library) if (!seen.has(item.channel)) seen.set(item.channel, item.channelName);
  return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

export function SourcePicker(props: { value?: ArchiveSource; onChange: (value?: ArchiveSource) => void }) {
  return (
    <Segmented<string> label="출처" value={props.value ?? ''} onChange={(value) => props.onChange(value === '' ? undefined : value as ArchiveSource)} options={[
      { value: '', label: '전체' }, { value: 'scrap', label: '스크랩' }, { value: 'link', label: '링크' },
    ]} />
  );
}

function metadata(item: LibraryItem): string {
  const channel = item.category ? `${item.channelName} (${item.category})` : item.channelName;
  const parts = [channel];
  if (item.author) parts.push(item.author);
  parts.push(`파일 ${item.fileCount}개${item.completed ? '' : ' (일부만 받음)'}`);
  return parts.join(', ');
}

export function LibraryView({ state }: { state: AppState }) {
  const [search, setSearch] = useState('');
  const [channel, setChannel] = useState('');
  const [category, setCategory] = useState<string>();
  const [source, setSource] = useState<ArchiveSource>();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [layout, setLayout] = usePreference<Layout>('libraryLayout', 'grid');
  const menu = useContextMenu();
  const found = useLibrarySearch(search, state.library);

  useEffect(() => { setCategory(undefined); }, [channel]);
  useEffect(() => {
    setChannel('');
    setCategory(undefined);
    setSource(undefined);
  }, [state.libraryRoot]);

  const channelPosts = useMemo(() => state.library
    .filter((item) => channel === '' || item.channel === channel)
    .filter((item) => source === undefined || item.source === source)
    .filter((item) => !found || item.id in found)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [state.library, channel, source, found]);
  const posts = channelPosts.filter((item) => category === undefined || item.category === category);

  // 카테고리는 채널마다 다르므로 채널을 골랐을 때만 나눕니다.
  const categories = useMemo(() => {
    if (channel === '') return [];
    const names = categoriesOf(channelPosts);
    if (category && !names.includes(category)) names.push(category);
    return names;
  }, [channelPosts, channel, category]);

  const groups = useMemo(() => {
    const map = new Map<string, LibraryItem[]>();
    for (const post of posts) map.set(post.channel, [...(map.get(post.channel) ?? []), post]);
    return [...map.entries()].map(([id, items]) => ({ id, name: items[0].channelName, items })).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }, [posts]);

  // 보이는 순서대로의 글 번호입니다. 접어 둔 채널의 글은 고를 수 없습니다.
  const orderedIDs = useMemo(() => (channel !== '' ? posts : groups.filter((group) => !collapsed.has(group.id)).flatMap((group) => group.items)).map((item) => item.id), [posts, groups, collapsed, channel]);
  const byID = useMemo(() => new Map(state.library.map((item) => [item.id, item])), [state.library]);
  const busy = useMemo(() => new Set([...(state.job?.activeIDs ?? []), ...(state.job?.waitingIDs ?? [])]), [state.job?.activeIDs, state.job?.waitingIDs]);
  const isMac = state.platform === 'darwin';
  const selection = useSelection(orderedIDs);
  const [trash, setTrash] = useState<string[]>();

  /** 받는 중이라 오프라인 페이지가 아직 없는 글은 열지 않습니다. 여러 개는 다섯 개까지만 엽니다. */
  const open = (ids: string[]) => {
    const ready = ids.filter((id) => !(busy.has(id) && !byID.get(id)?.hasPage));
    if (ready.length < ids.length) showToast('다운로드 중인 글은 완료된 뒤에 열 수 있습니다');
    if (ready.length > 5) showToast('한 번에 5개까지만 열 수 있습니다');
    ready.slice(0, 5).forEach((id) => void call('openPost', id));
  };
  const redownload = (ids: string[]) => {
    void call('redownloadPosts', ids).then((count) => { if (count > 0) showToast(`글 ${count}개의 빠진 파일을 다시 받습니다`); });
  };
  const marquee = useMarquee(selection, isMac, { ignore: '.group-header', onOpen: (id) => open([id]) });
  useCollectionKeys(selection, () => (layout === 'grid' ? marquee.columns() : 1), isMac, { onOpen: open, onDelete: setTrash });
  useEffect(() => {
    if (selection.cursor) marquee.items.current.get(selection.cursor)?.scrollIntoView({ block: 'nearest' });
  }, [selection.cursor]);

  const menuItems = (item: LibraryItem): MenuItem[] => {
    // 고르지 않은 글에서 메뉴를 열면 그 글만 고릅니다(Finder와 같습니다).
    const targets = selection.now().has(item.id) ? [...selection.now()] : [item.id];
    if (!selection.now().has(item.id)) selection.click(item.id, { toggle: false, range: false });
    const many = targets.length > 1 ? ` (${targets.length}개)` : '';
    return [
      { label: `열기${many}`, onClick: () => open(targets) },
      { label: '폴더에서 보기', onClick: () => void call('revealPost', item.id) },
      { label: `다시 받기${many}`, onClick: () => redownload(targets) },
      { label: `휴지통으로 옮기기${many}`, danger: true, onClick: () => setTrash(targets) },
    ];
  };
  const snippetOf = (item: LibraryItem) => (found ? found[item.id] ?? undefined : undefined);
  const itemProps = (item: LibraryItem) => ({
    item, snippet: snippetOf(item), selected: selection.selected.has(item.id), cursor: selection.cursor === item.id,
    busy: busy.has(item.id), refer: marquee.register(item.id), onMenu: (event: React.MouseEvent) => menu.open(event, menuItems(item)), onOpen: () => open([item.id]),
  });

  const renderItems = (list: LibraryItem[]) => layout === 'grid' ? (
    <div className="library-grid">
      {list.map((item) => <LibraryCard key={item.id} {...itemProps(item)} />)}
    </div>
  ) : (
    <div className="library-list">
      {list.map((item) => <LibraryRow key={item.id} {...itemProps(item)} />)}
    </div>
  );

  let body: React.ReactNode;
  if (state.library.length === 0) {
    body = state.isLoadingLibrary
      ? <Spinner label="보관함을 불러오는 중입니다" />
      : <EmptyState icon={<Archive size={44} />} title="받은 글이 없습니다" description="다운로드한 글이 여기에 표시됩니다." />;
  } else if (posts.length === 0) {
    body = search === ''
      ? <EmptyState icon={<Archive size={44} />} title="조건에 맞는 글이 없습니다" description="다른 채널이나 카테고리, 출처를 선택해 보세요." />
      : <EmptyState icon={<Archive size={44} />} title={`‘${search}’ 검색 결과가 없습니다`} description="다른 검색어를 입력해 보세요." />;
  } else if (channel !== '') {
    body = <div className="scroll padded selectable" ref={marquee.container} tabIndex={-1} onMouseDown={marquee.onMouseDown}>{renderItems(posts)}{marquee.box && <div className="marquee" style={marquee.box} />}</div>;
  } else {
    body = (
      <div className="scroll selectable" ref={marquee.container} tabIndex={-1} onMouseDown={marquee.onMouseDown}>
        {marquee.box && <div className="marquee" style={marquee.box} />}
        {groups.map((group) => (
          <section key={group.id} className="group-section">
            <button className="group-header" onClick={() => {
              const next = new Set(collapsed);
              if (next.has(group.id)) next.delete(group.id); else next.add(group.id);
              setCollapsed(next);
            }}>
              {collapsed.has(group.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              <strong>{group.name}</strong>
              <span className="muted">{group.items.length}</span>
            </button>
            {!collapsed.has(group.id) && <div className="padded-x">{renderItems(group.items)}</div>}
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="screen">
      <Header title="보관함" subtitle={`${posts.length}개 (${state.libraryRoot})`}>
        <SearchField value={search} onChange={setSearch} placeholder="제목, 작성자, 본문, 댓글 검색" />
        <Select label="채널" value={channel} onChange={setChannel} options={[{ value: '', label: '모든 채널' }, ...channelsOf(state.library).map((item) => ({ value: item.id, label: item.name }))]} />
        <SourcePicker value={source} onChange={setSource} />
        <Segmented<Layout> label="보기" value={layout} onChange={setLayout} options={[{ value: 'grid', label: '격자' }, { value: 'list', label: '목록' }]} />
      </Header>
      {categories.length > 0 && <CategoryTabs categories={categories} selection={category} onChange={setCategory} />}
      {body}
      {selection.selected.size > 0 && (
        <div className="selection-bar">
          <strong>{selection.selected.size}개 선택됨</strong>
          <span className="spacer" />
          <button onClick={() => open([...selection.selected])}>열기</button>
          <button onClick={() => redownload([...selection.selected])}>다시 받기</button>
          <button className="danger" onClick={() => setTrash([...selection.selected])}>휴지통으로 이동</button>
        </div>
      )}
      {trash && (
        <Dialog title={`선택한 글 ${trash.length}개를 휴지통으로 옮길까요?`} onClose={() => setTrash(undefined)} width={440}>
          <p className="muted">저장된 이미지와 동영상, 오프라인 페이지가 폴더째 휴지통으로 이동합니다. 휴지통에서 복원하면 보관함에 다시 나타나며, 다운로드 중인 글은 제외됩니다.</p>
          <div className="dialog-buttons">
            <button onClick={() => setTrash(undefined)} autoFocus>취소</button>
            <button className="primary danger-fill" onClick={() => {
              const targets = trash;
              setTrash(undefined);
              selection.clear();
              void call('trashPosts', targets).then((count) => showToast(`${count}개를 휴지통으로 옮겼습니다`));
            }}>휴지통으로 옮기기</button>
          </div>
        </Dialog>
      )}
      {menu.element}
    </div>
  );
}

export function Thumbnail(props: { path?: string; isVideo?: boolean; className: string; fallback: React.ReactNode }) {
  const [ref, visible] = useVisible<HTMLDivElement>();
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const showing = visible && props.path && !failed;
  // 그림이 다 오기 전에는 은은하게 반짝이다가, 오면 부드럽게 나타납니다.
  return (
    <div ref={ref} className={`${props.className} ${showing && !loaded ? 'loading' : ''}`}>
      {showing ? (
        props.isVideo
          ? <video className={loaded ? 'loaded' : ''} src={mediaURL(props.path!) + '#t=0.1'} preload="metadata" muted onLoadedData={() => setLoaded(true)} onError={() => setFailed(true)} />
          : <img className={loaded ? 'loaded' : ''} src={mediaURL(props.path!)} loading="lazy" decoding="async" alt="" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
      ) : props.fallback}
      {props.isVideo && <span className="play"><Play size={18} fill="currentColor" /></span>}
    </div>
  );
}

interface ItemProps {
  item: LibraryItem;
  snippet?: string;
  selected: boolean;
  cursor: boolean;
  /** 받는 중이거나 차례를 기다리는 글입니다. */
  busy: boolean;
  refer: (element: HTMLElement | null) => void;
  onMenu: (event: React.MouseEvent) => void;
  onOpen: () => void;
}

function busyBadge(props: ItemProps) {
  if (!props.busy) return null;
  return <span className="busy-badge"><Loader2 size={12} className="spin" /> 받는 중</span>;
}

function LibraryCard(props: ItemProps) {
  const { item } = props;
  return (
    <div ref={props.refer} data-id={item.id} role="option" aria-selected={props.selected} className={`library-card ${props.selected ? 'selected' : ''} ${props.cursor ? 'cursor' : ''}`} title={item.title} onContextMenu={props.onMenu}>
      <Thumbnail className="cover" path={item.cover?.path} isVideo={item.cover?.isVideo} fallback={<FileText size={34} className="muted" />} />
      {busyBadge(props)}
      <span className="card-title">{item.title}</span>
      <span className="caption ellipsis">{props.snippet ?? metadata(item)}</span>
    </div>
  );
}

function LibraryRow(props: ItemProps) {
  const { item } = props;
  const waiting = props.busy && !item.hasPage;
  return (
    <div ref={props.refer} data-id={item.id} role="option" aria-selected={props.selected} className={`library-row ${props.selected ? 'selected' : ''} ${props.cursor ? 'cursor' : ''}`} onContextMenu={props.onMenu}>
      <Thumbnail className="cover small" path={item.cover?.path} isVideo={item.cover?.isVideo} fallback={<FileText size={22} className="muted" />} />
      <div className="row-text">
        <span className="ellipsis">{item.title}</span>
        <span className="caption ellipsis">{metadata(item)}</span>
        {props.snippet && <span className="caption faint ellipsis">{props.snippet}</span>}
      </div>
      {busyBadge(props)}
      <button onClick={props.onOpen} disabled={waiting} title={waiting ? '다운로드가 끝난 뒤에 열 수 있습니다' : undefined}>열기</button>
    </div>
  );
}
