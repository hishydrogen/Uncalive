import { useEffect, useMemo, useState } from 'react';
import { Archive, ChevronDown, ChevronRight, FileText, Play } from 'lucide-react';
import { call, mediaURL, usePreference } from '../api';
import { categoriesOf, CategoryTabs, EmptyState, Header, SearchField, Segmented, Select, Spinner, useContextMenu, useVisible, type MenuItem } from '../components';
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
      { value: '', label: '전체' }, { value: '스크랩', label: '스크랩' }, { value: '주소 수집', label: '주소 수집' },
    ]} />
  );
}

function metadata(item: LibraryItem): string {
  const parts = [item.channelName];
  if (item.category) parts.push(item.category);
  if (item.author) parts.push(item.author);
  parts.push(`파일 ${item.fileCount}개`);
  if (!item.completed) parts.push('일부만 받음');
  return parts.join(' · ');
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

  const items = (item: LibraryItem): MenuItem[] => [
    { label: '열기', onClick: () => void call('openPost', item.id) },
    { label: '폴더에서 보기', onClick: () => void call('revealPost', item.id) },
  ];
  const snippetOf = (item: LibraryItem) => (found ? found[item.id] ?? undefined : undefined);

  const renderItems = (list: LibraryItem[]) => layout === 'grid' ? (
    <div className="library-grid">
      {list.map((item) => <LibraryCard key={item.id} item={item} snippet={snippetOf(item)} onMenu={(event) => menu.open(event, items(item))} />)}
    </div>
  ) : (
    <div className="library-list">
      {list.map((item) => <LibraryRow key={item.id} item={item} snippet={snippetOf(item)} onMenu={(event) => menu.open(event, items(item))} />)}
    </div>
  );

  let body: React.ReactNode;
  if (state.library.length === 0) {
    body = state.isLoadingLibrary
      ? <Spinner label="보관함을 불러오는 중입니다" />
      : <EmptyState icon={<Archive size={44} />} title="받은 글이 없습니다" description="다운로드한 글이 여기에 표시됩니다." />;
  } else if (posts.length === 0) {
    body = search === ''
      ? <EmptyState icon={<Archive size={44} />} title="표시할 글이 없습니다" description="다른 채널이나 카테고리, 출처를 선택해 보세요." />
      : <EmptyState icon={<Archive size={44} />} title={`‘${search}’에 대한 결과 없음`} description="다른 검색어를 입력해 보세요." />;
  } else if (channel !== '') {
    body = <div className="scroll padded">{renderItems(posts)}</div>;
  } else {
    body = (
      <div className="scroll">
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
      <Header title="보관함" subtitle={`${posts.length}개 · ${state.libraryRoot}`}>
        <SearchField value={search} onChange={setSearch} placeholder="제목, 작성자, 본문, 댓글 검색" />
        <Select label="채널" value={channel} onChange={setChannel} options={[{ value: '', label: '모든 채널' }, ...channelsOf(state.library).map((item) => ({ value: item.id, label: item.name }))]} />
        <SourcePicker value={source} onChange={setSource} />
        <Segmented<Layout> label="보기" value={layout} onChange={setLayout} options={[{ value: 'grid', label: '격자' }, { value: 'list', label: '목록' }]} />
      </Header>
      {categories.length > 0 && <CategoryTabs categories={categories} selection={category} onChange={setCategory} />}
      {body}
      {menu.element}
    </div>
  );
}

export function Thumbnail(props: { path?: string; isVideo?: boolean; className: string; fallback: React.ReactNode }) {
  const [ref, visible] = useVisible<HTMLDivElement>();
  const [failed, setFailed] = useState(false);
  return (
    <div ref={ref} className={props.className}>
      {visible && props.path && !failed ? (
        props.isVideo
          ? <video src={mediaURL(props.path) + '#t=0.1'} preload="metadata" muted onError={() => setFailed(true)} />
          : <img src={mediaURL(props.path)} loading="lazy" decoding="async" alt="" onError={() => setFailed(true)} />
      ) : props.fallback}
      {props.isVideo && <span className="play"><Play size={18} fill="currentColor" /></span>}
    </div>
  );
}

function LibraryCard(props: { item: LibraryItem; snippet?: string; onMenu: (event: React.MouseEvent) => void }) {
  const { item } = props;
  return (
    <button className="library-card" title={item.title} onClick={() => void call('openPost', item.id)} onContextMenu={props.onMenu}>
      <Thumbnail className="cover" path={item.cover?.path} isVideo={item.cover?.isVideo} fallback={<FileText size={34} className="muted" />} />
      <span className="card-title">{item.title}</span>
      <span className="caption ellipsis">{props.snippet ?? metadata(item)}</span>
    </button>
  );
}

function LibraryRow(props: { item: LibraryItem; snippet?: string; onMenu: (event: React.MouseEvent) => void }) {
  const { item } = props;
  return (
    <div className="library-row" onContextMenu={props.onMenu} onDoubleClick={() => void call('openPost', item.id)}>
      <Thumbnail className="cover small" path={item.cover?.path} isVideo={item.cover?.isVideo} fallback={<FileText size={22} className="muted" />} />
      <div className="row-text">
        <span className="ellipsis">{item.title}</span>
        <span className="caption ellipsis">{metadata(item)}</span>
        {props.snippet && <span className="caption faint ellipsis">{props.snippet}</span>}
      </div>
      <button onClick={() => void call('openPost', item.id)}>열기</button>
    </div>
  );
}
