import type { ScrapEntry } from './models';
import type { ArchiveSource } from './options';

export interface Batch {
  entries: ScrapEntry[];
  source: ArchiveSource;
}

/** 다운로드 한 회차의 대기열입니다. 받는 중에도 글을 묶음으로 더할 수 있고, 같은 글은 한 번만 들어갑니다. */
export class DownloadQueue {
  /** 이번 회차에 들어온 글의 수입니다. */
  totalPosts = 0;
  /** 마지막 묶음까지 가져간 뒤에는 더 넣을 수 없습니다. */
  isClosed = false;
  private readonly queued = new Set<string>();
  private readonly pending: Batch[] = [];

  constructor(entries: ScrapEntry[], source: ArchiveSource) {
    this.enqueue(entries, source);
  }

  /** 이미 들어 있는 글은 빼고 새 글만 뒤에 붙입니다. 더한 글 수를 돌려줍니다. */
  enqueue(entries: ScrapEntry[], source: ArchiveSource): number {
    if (this.isClosed) return 0;
    const fresh = entries.filter((entry) => {
      if (this.queued.has(entry.id)) return false;
      this.queued.add(entry.id);
      return true;
    });
    if (fresh.length === 0) return 0;
    this.totalPosts += fresh.length;
    this.pending.push({ entries: fresh, source });
    return fresh.length;
  }

  /** 다음 묶음을 꺼냅니다. 남은 묶음이 없으면 대기열을 닫습니다. */
  nextBatch(): Batch | undefined {
    const batch = this.pending.shift();
    if (!batch) this.isClosed = true;
    return batch;
  }

  /** 아직 시작하지 않은 묶음의 글 수입니다. */
  get queuedPosts(): number {
    return this.pending.reduce((sum, batch) => sum + batch.entries.length, 0);
  }
}
