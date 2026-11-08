import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, FolderOpen, Images, X } from 'lucide-react';
import { call, mediaURL } from '../api';
import { categoriesOf, CategoryTabs, EmptyState, Header, SearchField, Segmented, Select, useContextMenu } from '../components';
import type { AppState, ArchiveSource, LibraryItem, LibraryMedia } from '../../shared/types';
import { channelsOf, SourcePicker, Thumbnail } from './LibraryView';

type Kind = 'all' | 'images' | 'videos';

interface Media extends LibraryMedia {
  item: LibraryItem;
}

/** 받은 미디어만 모아 봅니다. 채널을 고르면 카테고리별로 나눠 볼 수 있습니다. */
export function GalleryView({ state }: { state: AppState }) {
  const [kind, setKind] = useState<Kind>('all');
  const [channel, setChannel] = useState('');
  const [category, setCategory] = useState<string>();
  const [source, setSource] = useState<ArchiveSource>();
  const [search, setSearch] = useState('');
  const [preview, setPreview] = useState<number>();
  const menu = useContextMenu();

  useEffect(() => { setCategory(undefined); }, [channel]);
  useEffect(() => {
    setChannel('');
    setCategory(undefined);
    setSource(undefined);
  }, [state.libraryRoot]);

  const items = useMemo(() => {
    const query = search.toLowerCase();
    return state.library
      .filter((item) => channel === '' || item.channel === channel)
      .filter((item) => source === undefined || item.source === source)
      .filter((item) => query === '' || item.title.toLowerCase().includes(query))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [state.library, channel, source, search]);

  const categories = useMemo(() => {
    if (channel === '') return [];
    const names = categoriesOf(items);
    if (category && !names.includes(category)) names.push(category);
    return names;
  }, [items, channel, category]);

  const media = useMemo<Media[]>(() => items
    .filter((item) => category === undefined || item.category === category)
    .flatMap((item) => item.media.map((file) => ({ ...file, item })))
    .filter((file) => kind === 'all' || (kind === 'videos') === file.isVideo), [items, category, kind]);

  return (
    <div className="screen">
      <Header title="갤러리" subtitle={`${media.length}개`}>
        <SearchField value={search} onChange={setSearch} placeholder="글 제목 검색" />
        <Select label="채널" value={channel} onChange={setChannel} options={[{ value: '', label: '모든 채널' }, ...channelsOf(state.library).map((item) => ({ value: item.id, label: item.name }))]} />
        <SourcePicker value={source} onChange={setSource} />
        <Segmented<Kind> label="종류" value={kind} onChange={setKind} options={[{ value: 'all', label: '전체' }, { value: 'images', label: '이미지' }, { value: 'videos', label: '동영상' }]} />
      </Header>
      {categories.length > 0 && <CategoryTabs categories={categories} selection={category} onChange={setCategory} />}
      {media.length === 0 ? (
        <EmptyState icon={<Images size={44} />} title="표시할 미디어가 없습니다" description="다운로드한 이미지와 동영상이 여기에 모입니다." />
      ) : (
        <div className="scroll padded">
          <div className="gallery-grid">
            {media.map((file, index) => (
              <button
                key={file.path}
                className="gallery-cell"
                title={file.item.title}
                onClick={() => setPreview(index)}
                onKeyDown={(event) => { if (event.key === ' ') { event.preventDefault(); setPreview(index); } }}
                onContextMenu={(event) => menu.open(event, [
                  { label: '글 열기', onClick: () => void call('openPost', file.item.id) },
                  { label: '폴더에서 보기', onClick: () => void call('revealFile', file.path) },
                ])}
              >
                <Thumbnail className="cell-media" path={file.path} isVideo={file.isVideo} fallback={null} />
              </button>
            ))}
          </div>
        </div>
      )}
      {preview !== undefined && media[preview] && <Lightbox media={media} index={preview} onIndex={setPreview} onClose={() => setPreview(undefined)} />}
      {menu.element}
    </div>
  );
}

/** 스페이스 바나 Esc로 닫고, 방향키로 앞뒤 파일을 봅니다. */
function Lightbox(props: { media: Media[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const file = props.media[props.index];
  const move = (offset: number) => props.onIndex((props.index + offset + props.media.length) % props.media.length);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === ' ') {
        event.preventDefault();
        props.onClose();
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        move(1);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        move(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <div className="lightbox" role="dialog" aria-modal aria-label={file.item.title} onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div className="lightbox-bar">
        <span className="ellipsis">{file.item.title} · {props.index + 1} / {props.media.length}</span>
        <span className="spacer" />
        <button className="plain" title="글 열기" onClick={() => void call('openPost', file.item.id)}><ExternalLink size={16} /></button>
        <button className="plain" title="폴더에서 보기" onClick={() => void call('revealFile', file.path)}><FolderOpen size={16} /></button>
        <button className="plain" title="닫기" onClick={props.onClose}><X size={18} /></button>
      </div>
      <button className="lightbox-nav left" aria-label="이전" onClick={() => move(-1)}><ChevronLeft size={28} /></button>
      {file.isVideo
        ? <video key={file.path} src={mediaURL(file.path)} controls autoPlay />
        : <img key={file.path} src={mediaURL(file.path)} alt="" />}
      <button className="lightbox-nav right" aria-label="다음" onClick={() => move(1)}><ChevronRight size={28} /></button>
    </div>
  );
}
