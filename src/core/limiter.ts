/** 동시 연결 수를 제한합니다. 우선순위가 높은 요청은 대기열 앞쪽으로 갑니다. */
export class Limiter {
  private used = 0;
  private urgent: Array<() => void> = [];
  private normal: Array<() => void> = [];
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = Math.max(limit, 1);
  }

  private acquire(isUrgent: boolean): Promise<void> {
    if (this.used < this.limit) {
      this.used += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => (isUrgent ? this.urgent : this.normal).push(resolve));
  }

  private release(): void {
    const next = this.urgent.shift() ?? this.normal.shift();
    if (next) next();
    else this.used -= 1;
  }

  async withSlot<T>(body: () => Promise<T>, urgent = false, signal?: AbortSignal): Promise<T> {
    await this.acquire(urgent);
    try {
      if (signal?.aborted) throw signal.reason;
      return await body();
    } finally {
      this.release();
    }
  }
}
