import type { ScrapEntry } from './models';

/** 화면에서도 쓰므로 Node 기능 없이 주소만 다룹니다. */

/** 사용자가 붙여 넣은 주소의 종류입니다. */
export type Target = { type: 'post'; entry: ScrapEntry } | { type: 'list'; url: string };

/** 붙여 넣은 글에서 아카라이브 주소만 골라냅니다. 다른 사이트 주소는 무시합니다. */
export function parseTargets(text: string): Target[] {
  const seen = new Set<string>();
  const result: Target[] = [];
  for (const token of text.split(/\s+/u).filter(Boolean)) {
    const raw = token.startsWith('arca.live') ? `https://${token}` : token;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || (url.hostname !== 'arca.live' && url.hostname !== 'www.arca.live')) continue;
    url.hostname = 'arca.live';
    url.hash = '';
    const post = postPath(url.pathname);
    if (post) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      const entryURL = `https://arca.live/b/${post.channel}/${post.id}`;
      result.push({ type: 'post', entry: { id: post.id, channel: post.channel, url: entryURL, title: `글 ${post.id}` } });
      continue;
    }
    if (!url.pathname.startsWith('/b/') && !url.pathname.startsWith('/u/')) continue;
    const absolute = url.toString();
    if (seen.has(absolute)) continue;
    seen.add(absolute);
    result.push({ type: 'list', url: absolute });
  }
  return result;
}

export /** `/b/<채널>/<번호>` 경로에서 채널과 번호를 꺼냅니다. */
function postPath(path: string): { channel: string; id: string } | undefined {
  const bare = path.split('?')[0] ?? path;
  const parts = bare.split('/').filter(Boolean);
  if (parts.length < 3 || parts[0] !== 'b' || !/^\d+$/.test(parts[2])) return undefined;
  return { channel: parts[1], id: parts[2] };
}

