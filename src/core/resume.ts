import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { isoDate, resolveRelative, sortedJSON, writeAtomic } from './fsutil';
import type { ParsedPost } from './models';

export interface PostRecord {
  id: string;
  /** 저장 폴더 기준 상대 경로입니다. 운영체제와 관계없이 `/`로 구분합니다. */
  folder: string;
  title: string;
  completed: boolean;
  /** 미디어 키 → 게시글 폴더 기준 상대 경로 */
  files: Record<string, string>;
  updatedAt: string;
  // 보관함 표시용 정보입니다. 이전 버전의 기록에는 없을 수 있습니다.
  channel?: string;
  channelName?: string;
  category?: string;
  author?: string;
  createdAt?: string;
  url?: string;
}

interface State {
  version: number;
  posts: Record<string, PostRecord>;
}

export function stateFile(root: string): string {
  return path.join(root, '.uncalive', 'state.json');
}

/** 어떤 게시글을 어디까지 받았는지 저장 폴더 안에 기록합니다. 맥판과 같은 파일을 씁니다. */
export class ResumeStore {
  private constructor(private readonly root: string, private state: State) {}

  static async open(root: string): Promise<ResumeStore> {
    const file = stateFile(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    let state: State = { version: 1, posts: {} };
    let text: string | undefined;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch {
      text = undefined;
    }
    if (text !== undefined) {
      const parsed = JSON.parse(text) as State;
      state = { version: parsed.version ?? 1, posts: parsed.posts ?? {} };
    }
    return new ResumeStore(root, state);
  }

  record(id: string): PostRecord | undefined {
    return this.state.posts[id];
  }

  allRecords(): PostRecord[] {
    return Object.values(this.state.posts);
  }

  /** 디스크에 실제로 남은 것만 돌려줍니다. 탐색기에서 지운 글은 빠지고, 파일이 일부 지워진 글은 미완료가 됩니다. */
  liveRecords(): PostRecord[] {
    const result: PostRecord[] = [];
    for (const record of Object.values(this.state.posts)) {
      const folder = resolveRelative(this.root, record.folder);
      if (!existsSync(folder)) continue;
      const files = Object.fromEntries(Object.entries(record.files).filter(([, file]) => existsSync(resolveRelative(folder, file))));
      const live = { ...record, files };
      if (Object.keys(files).length !== Object.keys(record.files).length) live.completed = false;
      result.push(live);
    }
    return result;
  }

  /** 이 게시글의 폴더를 정합니다. 다시 받을 때는 기존 폴더를 그대로 씁니다. */
  reserveFolder(post: ParsedPost, preferred: string, channelName?: string): string {
    const existing = this.state.posts[post.id];
    let folder: string;
    if (existing) {
      folder = existing.folder;
    } else {
      // macOS와 Windows는 대소문자가 다른 같은 이름을 한 폴더로 봅니다.
      const taken = new Set(Object.values(this.state.posts).map((record) => record.folder.toLowerCase()));
      let candidate = preferred;
      let counter = 1;
      while (taken.has(candidate.toLowerCase()) || existsSync(resolveRelative(this.root, candidate))) {
        candidate = `${preferred}_${counter}`;
        counter += 1;
      }
      folder = candidate;
      this.state.posts[post.id] = { id: post.id, folder, title: post.title, completed: false, files: {}, updatedAt: isoDate() };
    }
    const record = this.state.posts[post.id];
    record.title = post.title;
    record.channel = post.channel;
    record.channelName = channelName ?? record.channelName;
    record.category = post.category;
    record.author = post.author;
    record.createdAt = post.createdAt;
    record.url = post.url;
    return folder;
  }

  /** 기록에서 글을 뺍니다. 폴더는 따로 지웁니다. */
  remove(postID: string): void {
    delete this.state.posts[postID];
  }

  setFile(relative: string, key: string, postID: string): void {
    const record = this.state.posts[postID];
    if (record) record.files[key] = relative;
  }

  async finish(postID: string, completed: boolean): Promise<void> {
    const record = this.state.posts[postID];
    if (record) {
      record.completed = completed;
      record.updatedAt = isoDate();
    }
    await this.save();
  }

  private saveTimer?: ReturnType<typeof setTimeout>;

  /** 받는 도중에도 보관함과 갤러리가 받은 파일을 보여 줄 수 있도록, 잠깐 모았다가 기록합니다. */
  saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save().catch(() => undefined);
    }, 1000);
  }

  async save(): Promise<void> {
    await writeAtomic(stateFile(this.root), sortedJSON(this.state));
  }
}
