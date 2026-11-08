import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';
import path from 'node:path';
import { sortedJSON, isoDate, writeAtomic } from './fsutil';
import { mediaKey, type ParsedPost } from './models';
import type { ArchiveOptions } from './options';
import { absoluteURL, mediaURL } from './parser';

/** 받은 파일을 연결한 오프라인 페이지를 만듭니다. 인터넷 없이 어느 브라우저에서나 열립니다. */
export async function writeArchive(post: ParsedPost, paths: Record<string, string>, options: ArchiveOptions, folder: string): Promise<void> {
  if (options.offlineHTML) {
    await writeAtomic(path.join(folder, 'index.html'), render(post, paths, options.includeComments));
  }
  if (options.metadataJSON) {
    const allMedia = [...post.media, ...post.comments.flatMap((comment) => comment.media)];
    const files = allMedia.flatMap((media) => (paths[media.key] ? [{ kind: media.kind, path: paths[media.key] }] : []));
    const metadata = {
      id: post.id, channel: post.channel, url: post.url, title: post.title,
      category: post.category, author: post.author, createdAt: post.createdAt,
      savedAt: isoDate(), commentCount: post.comments.length, embeds: post.embeds, files,
    };
    await writeAtomic(path.join(folder, 'post.json'), sortedJSON(metadata));
  }
}

function fragmentText(html: string): string {
  return cheerio.load(html, null, false).root().text().replace(/\s+/gu, ' ').trim();
}

/** 본문 검색에 쓸 글자를 뽑습니다. 제목, 본문, 댓글이 들어갑니다. */
export function searchableText(post: ParsedPost): string {
  const parts = [post.title, fragmentText(post.contentHTML)];
  for (const comment of post.comments) {
    parts.push(comment.author, fragmentText(comment.messageHTML));
  }
  return parts.join('\n');
}

export function render(post: ParsedPost, paths: Record<string, string>, includeComments: boolean): string {
  const content = rewrite(post.contentHTML, paths);
  const details = [post.channel, post.category, post.author, post.createdAt].filter((value): value is string => !!value).map(escape);
  details.push(`<a href="${escape(post.url)}">원문 보기</a>`);

  let commentsHTML = '';
  if (includeComments && post.comments.length > 0) {
    const items = post.comments.map((comment) => `<li style="margin-left:${Math.min(comment.depth, 4) * 20}px">
  <div class="meta"><strong>${escape(comment.author)}</strong> ${escape(comment.createdAt ?? '')}</div>
  <div>${rewrite(comment.messageHTML, paths)}</div>
</li>`).join('\n');
    commentsHTML = `<section><h2>댓글 ${post.comments.length}개</h2><ol class="comments">\n${items}\n</ol></section>`;
  }

  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="script-src 'none'">
<title>${escape(post.title)}</title>
<style>
:root { color-scheme: light dark; --line: #d8d8dc; --muted: #6e6e73; }
@media (prefers-color-scheme: dark) { :root { --line: #3a3a3c; --muted: #a1a1a6; } }
body { max-width: 860px; margin: 0 auto; padding: 24px 16px 64px; font: 16px/1.7 -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif; overflow-wrap: anywhere; }
h1 { font-size: 1.5rem; line-height: 1.35; margin: 0 0 8px; }
h2 { font-size: 1.1rem; margin-top: 40px; }
.meta { color: var(--muted); font-size: .875rem; }
header { border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 24px; }
img, video { max-width: 100%; height: auto; }
.comments { list-style: none; padding: 0; }
.comments li { border-top: 1px solid var(--line); padding: 10px 0; }
.comments pre { white-space: pre-wrap; font: inherit; margin: 0; }
.missing { color: var(--muted); font-size: .875rem; }
</style>
</head>
<body>
<header>
<h1>${escape(post.title)}</h1>
<div class="meta">${details.join(' · ')}</div>
</header>
<main>
${content}
</main>
${commentsHTML}
</body>
</html>`;
}

function encodePath(relative: string): string {
  return relative.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

/** 원격 주소를 로컬 경로로 바꾸고, 스크립트처럼 저장본에 필요 없는 요소를 지웁니다. */
export function rewrite(html: string, paths: Record<string, string>): string {
  const $ = cheerio.load(html, null, false);
  $('script, style, link, meta, object, embed, form').remove();

  $('iframe').each((_, frame) => {
    const url = absoluteURL($(frame).attr('src') ?? '');
    if (url) $(frame).after(`<p><a href="${escape(url)}">외부 콘텐츠 열기</a></p>`);
    $(frame).remove();
  });

  // data-src를 지우기 전에 지연 로딩 이미지의 진짜 주소를 기억해 둡니다.
  const rawDataSource = new Map<Element, string>();
  $('img[data-src]').each((_, image) => { rawDataSource.set(image, $(image).attr('data-src') ?? ''); });

  $('*').each((_, node) => {
    const element = node as Element;
    for (const [name, value] of Object.entries(element.attribs ?? {}) as Array<[string, string]>) {
      const key = name.toLowerCase();
      const reachesNetwork = key === 'style' && value.toLowerCase().includes('url(');
      if (key.startsWith('on') || reachesNetwork || ['data-originalurl', 'data-src', 'srcset', 'loading'].includes(key)) {
        $(element).removeAttr(name);
      }
    }
  });

  $('a[href]').each((_, link) => {
    const href = $(link).attr('href') ?? '';
    if (href.trim().toLowerCase().startsWith('javascript:')) {
      $(link).removeAttr('href');
    } else {
      const url = absoluteURL(href);
      if (url) $(link).attr('href', url);
    }
  });

  const local = (raw: string | undefined): string | undefined => {
    const url = mediaURL(raw ?? '');
    const found = url ? paths[mediaKey(url)] : undefined;
    return found ? encodePath(found) : undefined;
  };

  $('img').each((_, image) => {
    const element = $(image);
    const found = local(element.attr('src')) ?? local(rawDataSource.get(image));
    if (found) {
      element.attr('src', found);
    } else if ((element.attr('src') ?? '').startsWith('data:image/')) {
      // 본문에 내장된 이미지는 그 자체로 오프라인에서 보입니다.
    } else {
      element.after('<span class="missing">[저장되지 않은 이미지]</span>');
      element.remove();
    }
  });

  $('video, audio').each((_, node) => {
    const video = $(node);
    const sources = video.find('source');
    let found = local(video.attr('src'));
    sources.each((_, source) => { found ??= local($(source).attr('src')); });
    if (!found) {
      video.after(`<span class="missing">[저장되지 않은 ${node.tagName.toLowerCase() === 'audio' ? '오디오' : '동영상'}]</span>`);
      video.remove();
      return;
    }
    sources.remove();
    video.attr('src', found);
    video.attr('controls', 'controls');
    const poster = video.attr('poster') ?? '';
    const posterPath = local(poster);
    if (posterPath) video.attr('poster', posterPath);
    else if (poster !== '') video.removeAttr('poster');
  });
  return $.html();
}

function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
