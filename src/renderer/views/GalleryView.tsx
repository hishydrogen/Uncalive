import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, ExternalLink, FolderOpen, Images, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react';
import { call, mediaURL, setLightboxOpen } from '../api';
import { categoriesOf, CategoryTabs, EmptyState, Header, SearchField, Segmented, Select, showToast, useContextMenu } from '../components';
import type { AppState, ArchiveSource, LibraryItem, LibraryMedia } from '../../shared/types';
import { channelsOf, SourcePicker, Thumbnail } from './LibraryView';
import { useCollectionKeys, useMarquee, useSelection } from '../selection';

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
  // 크게 보는 파일은 순서가 아니라 경로로 기억합니다. 받는 중에 새 파일이 앞에 끼어들어도 보던 파일이 그대로 남습니다.
  const [preview, setPreview] = useState<string>();
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

  const paths = useMemo(() => media.map((file) => file.path), [media]);
  const isMac = state.platform === 'darwin';
  const selection = useSelection(paths);
  const copyFiles = (picked: string[]) => {
    void call('copyFiles', picked).then((count) => {
      if (count === 1 && picked.length === 1) showToast('이미지를 복사했습니다. 다른 앱에 바로 붙여 넣을 수 있습니다');
      else if (count > 0) showToast(`파일 ${count}개를 복사했습니다. ${isMac ? 'Finder' : '파일 탐색기'}에 붙여 넣을 수 있습니다`);
    });
  };
  const exportFiles = (picked: string[]) => {
    void call('exportFiles', picked).then((count) => { if (count > 0) showToast(`파일 ${count}개를 내보냈습니다`); });
  };
  const openPosts = (ids: string[]) => {
    if (ids.length > 5) showToast('한 번에 5개까지만 열 수 있습니다');
    for (const id of ids.slice(0, 5)) void call('openPost', id);
  };
  const previewIndex = preview === undefined ? -1 : paths.indexOf(preview);
  // 보던 파일이 목록에서 빠지면(지우거나 거르기를 바꾸면) 크게 보기를 닫습니다.
  useEffect(() => { if (preview !== undefined && previewIndex < 0) setPreview(undefined); }, [preview, previewIndex]);
  const openAt = (path: string) => {
    if (paths.includes(path)) setPreview(path);
  };
  const marquee = useMarquee(selection, isMac, { onOpen: openAt });
  useCollectionKeys(selection, marquee.columns, isMac, { onOpen: (ids) => openAt(ids[0]), onSpace: openAt, onCopy: (ids) => copyFiles(ids) });
  useEffect(() => {
    if (selection.cursor) marquee.items.current.get(selection.cursor)?.scrollIntoView({ block: 'nearest' });
  }, [selection.cursor]);
  // 크게 보기를 닫으면 마지막으로 보던 파일을 지금 항목으로 삼습니다.
  const closePreview = () => {
    if (preview !== undefined && previewIndex >= 0) selection.click(preview, { toggle: false, range: false });
    setPreview(undefined);
  };

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
        <div className="scroll padded selectable" ref={marquee.container} tabIndex={-1} onMouseDown={marquee.onMouseDown}>
          {marquee.box && <div className="marquee" style={marquee.box} />}
          <div className="gallery-grid">
            {media.map((file) => (
              <div
                key={file.path}
                ref={marquee.register(file.path)}
                data-id={file.path}
                role="option"
                aria-selected={selection.selected.has(file.path)}
                className={`gallery-cell ${selection.selected.has(file.path) ? 'selected' : ''} ${selection.cursor === file.path ? 'cursor' : ''}`}
                title={file.item.title}
                onContextMenu={(event) => {
                  if (!selection.now().has(file.path)) selection.click(file.path, { toggle: false, range: false });
                  const picked = selection.now().has(file.path) ? [...selection.now()] : [file.path];
                  const many = picked.length > 1;
                  const posts = [...new Set(media.filter((item) => picked.includes(item.path)).map((item) => item.item.id))];
                  menu.open(event, [
                    { label: '크게 보기', onClick: () => openAt(file.path) },
                    { label: many ? `${picked.length}개 복사` : '복사', onClick: () => copyFiles(picked) },
                    { label: many ? `${picked.length}개 다른 폴더로 내보내기…` : '다른 폴더로 내보내기…', onClick: () => exportFiles(picked) },
                    { label: '폴더에서 보기', onClick: () => void call('revealFile', file.path) },
                    { label: posts.length > 1 ? `글 ${Math.min(posts.length, 5)}개 열기` : '글 열기', onClick: () => openPosts(posts) },
                  ]);
                }}
              >
                <Thumbnail className="cell-media" path={file.path} isVideo={file.isVideo} fallback={null} />
              </div>
            ))}
          </div>
        </div>
      )}
      {previewIndex >= 0 && <Lightbox media={media} index={previewIndex} onIndex={(index) => setPreview(media[index]?.path)} onClose={closePreview} />}
      {menu.element}
    </div>
  );
}

const minZoom = 1;
const maxZoom = 8;
const clampZoom = (value: number) => Math.min(maxZoom, Math.max(minZoom, value));

/**
 * 크게 보기입니다. 스페이스 바나 Esc로 닫고, 방향키로 앞뒤 파일을 봅니다.
 * 휠이나 두 손가락 벌리기, 두 번 누르기, +와 -로 확대하고, 확대한 뒤에는 끌어서 옮깁니다. R로 돌리고 0으로 되돌립니다. ⌘C로 복사합니다.
 */
function Lightbox(props: { media: Media[]; index: number; onIndex: (index: number) => void; onClose: () => void }) {
  const file = props.media[props.index];
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [smooth, setSmooth] = useState(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number; moved: boolean }>(undefined);
  useEffect(() => {
    setLightboxOpen(true);
    return () => setLightboxOpen(false);
  }, []);

  const apply = (next: { zoom?: number; rotation?: number; offset?: { x: number; y: number } }, animated = true) => {
    setSmooth(animated);
    if (next.zoom !== undefined) {
      const value = clampZoom(next.zoom);
      setZoom(value);
      if (value === 1) setOffset({ x: 0, y: 0 });
    }
    if (next.rotation !== undefined) setRotation(next.rotation);
    if (next.offset) setOffset(next.offset);
  };
  const reset = () => apply({ zoom: 1, rotation: 0, offset: { x: 0, y: 0 } });
  // 다른 파일로 넘어가면 확대와 회전을 바로 처음으로 되돌립니다. 넘길 때는 움직임 효과를 넣지 않습니다.
  const move = (step: number) => {
    setSmooth(false);
    setZoom(1);
    setRotation(0);
    setOffset({ x: 0, y: 0 });
    props.onIndex((props.index + step + props.media.length) % props.media.length);
  };

  useEffect(() => {
    // 크게 보기의 키는 갤러리 목록보다 먼저 받아서, 뒤에 있는 목록이 함께 움직이지 않게 합니다.
    const own = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === ' ') {
        own(event);
        props.onClose();
      } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        own(event);
        move(1);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        own(event);
        move(-1);
      } else if (event.key === '+' || event.key === '=') {
        apply({ zoom: zoom * 1.25 });
      } else if (event.key === '-' || event.key === '_') {
        apply({ zoom: zoom / 1.25 });
      } else if (event.key === '0') {
        reset();
      } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        void call('copyFiles', [file.path]).then((count) => { if (count > 0) showToast('클립보드에 복사했습니다'); });
      } else if (event.metaKey || event.ctrlKey) {
        return;
      } else if (event.key.toLowerCase() === 'r') {
        apply({ rotation: rotation + (event.shiftKey ? -90 : 90) });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const onWheel = (event: React.WheelEvent) => {
    // 트랙패드에서 두 손가락을 벌리면 Ctrl이 눌린 휠로 옵니다. 그보다 휠은 한 칸이 커서 조금씩 키웁니다.
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.002));
    apply({ zoom: zoom * factor }, false);
  };
  // 사진을 끌어 옮긴 뒤 손을 뗀 것을 '여백 누르기'로 보지 않도록 기억합니다.
  const moved = useRef(false);
  const onPointerDown = (event: React.PointerEvent) => {
    moved.current = false;
    if (event.button !== 0 || zoom === 1) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y, moved: false };
  };
  const onPointerMove = (event: React.PointerEvent) => {
    const start = drag.current;
    if (!start) return;
    start.moved = true;
    moved.current = true;
    apply({ offset: { x: start.ox + event.clientX - start.x, y: start.oy + event.clientY - start.y } }, false);
  };
  const onPointerUp = () => { drag.current = undefined; };

  const transform = `translate(${offset.x}px, ${offset.y}px) rotate(${rotation}deg) scale(${zoom})`;
  const mediaProps = {
    src: mediaURL(file.path),
    style: { transform, transition: smooth ? 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none', cursor: zoom > 1 ? (drag.current ? 'grabbing' : 'grab') : 'zoom-in' },
    onDoubleClick: () => apply({ zoom: zoom > 1 ? 1 : 2.5, offset: { x: 0, y: 0 } }),
    draggable: false,
  };

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal aria-label={file.item.title} onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }} onWheel={onWheel}>
      <div className="lightbox-bar">
        <span className="ellipsis">{file.item.title} ({props.index + 1} / {props.media.length})</span>
        <span className="spacer" />
        <div className="lightbox-tools" role="toolbar" aria-label="보기 도구">
          <button className="plain" title="축소 (-)" aria-label="축소" disabled={zoom <= minZoom} onClick={() => apply({ zoom: zoom / 1.25 })}><ZoomOut size={16} /></button>
          <button className="plain zoom-label" title="화면에 맞추기 (0)" onClick={reset}>{Math.round(zoom * 100)}%</button>
          <button className="plain" title="확대 (+)" aria-label="확대" disabled={zoom >= maxZoom} onClick={() => apply({ zoom: zoom * 1.25 })}><ZoomIn size={16} /></button>
          <button className="plain" title="회전 (R)" aria-label="회전" onClick={() => apply({ rotation: rotation + 90 })}><RotateCw size={16} /></button>
        </div>
        <button className="plain" title="글 열기" onClick={() => void call('openPost', file.item.id)}><ExternalLink size={16} /></button>
        <button className="plain" title="폴더에서 보기" onClick={() => void call('revealFile', file.path)}><FolderOpen size={16} /></button>
        <button className="plain" title="닫기" onClick={props.onClose}><X size={18} /></button>
      </div>
      {/* 사진을 확대해도 위 막대 아래로만 보입니다. 막대를 덮지 않으니 막대를 끌어 창을 옮길 수 있습니다. */}
      <div className="lightbox-view" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <button className="lightbox-nav left" aria-label="이전" onClick={() => move(-1)}><ChevronLeft size={28} /></button>
      <div className="lightbox-stage" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
        onClick={(event) => { if (event.target === event.currentTarget && !moved.current) props.onClose(); }}>
        {file.isVideo
          // 재생 막대를 누르면 키보드가 동영상으로 넘어가 방향키와 Esc가 크게 보기에 오지 않았습니다.
          // 마우스로는 그대로 조작하되 키보드는 동영상에 머물지 않게 합니다.
          ? <video key={file.path} {...mediaProps} controls autoPlay onFocus={(event) => event.currentTarget.blur()} />
          : <img key={file.path} {...mediaProps} alt="" />}
      </div>
      <button className="lightbox-nav right" aria-label="다음" onClick={() => move(1)}><ChevronRight size={28} /></button>
      </div>
    </div>,
    document.body,
  );
}
