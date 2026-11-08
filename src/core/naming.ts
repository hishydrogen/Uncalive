import type { MediaRef, ParsedPost } from './models';
import type { DownloadOptions } from './options';

/** 파일 시스템 이름 제한(255바이트)보다 여유 있게 둡니다. */
const maxBytes = 200;
const illegal = new Set('\\/:*?"<>|'.split(''));
// Windows에서 장치 이름으로 예약된 이름입니다. 확장자가 붙어도 쓸 수 없습니다.
const reserved = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function trim(text: string): string {
  return text.replace(/^[.\s]+|[.\s]+$/gu, '');
}

/** macOS, Windows, Linux에서 모두 안전한 이름으로 바꿉니다. */
export function sanitize(raw: string, maxCharacters: number): string {
  let name = raw.normalize('NFC');
  name = Array.from(name, (character) => {
    const code = character.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code < 0xa0);
    return illegal.has(character) || control ? '_' : character;
  }).join('');
  name = name.split(/\s+/u).filter(Boolean).join(' ');
  name = trim(name);
  let characters = Array.from(name);
  if (characters.length > maxCharacters) characters = characters.slice(0, maxCharacters);
  while (utf8Length(characters.join('')) > maxBytes) characters.pop();
  name = trim(characters.join(''));
  if (reserved.test(name)) name = '_' + name;
  return name;
}

export function folderName(post: ParsedPost, options: DownloadOptions): string {
  const title = sanitize(post.title, options.folderNameMaxLength);
  if (options.folderNaming === 'title') return title === '' ? `post_${post.id}` : title;
  return title === '' ? post.id : `${post.id}_${title}`;
}

/** 확장자를 뺀 파일 이름입니다. */
export function baseName(sequence: number, total: number, media: MediaRef, naming: DownloadOptions['fileNaming']): string {
  const number = String(sequence).padStart(Math.max(2, String(total).length), '0');
  if (naming !== 'sequenceAndOriginalName' || media.displayURL.startsWith('data:')) return number;
  let stem = '';
  try {
    const last = new URL(media.displayURL).pathname.split('/').pop() ?? '';
    const dot = last.lastIndexOf('.');
    stem = dot > 0 ? last.slice(0, dot) : last;
    try { stem = decodeURIComponent(stem); } catch { /* 그대로 씁니다. */ }
  } catch {
    stem = '';
  }
  const original = sanitize(stem, 100);
  return original === '' ? number : `${number}_${original}`;
}
