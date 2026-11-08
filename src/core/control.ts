import { CancellationError } from './models';

/** 실행 중인 작업을 일시정지하거나 취소합니다. */
export class RunControl {
  private paused = false;
  private cancelled = false;
  private waiters: Array<() => void> = [];
  private readonly abort = new AbortController();

  get signal(): AbortSignal {
    return this.abort.signal;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    const waiters = this.waiters;
    this.waiters = [];
    waiters.forEach((wake) => wake());
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    this.abort.abort(new CancellationError());
    this.resume();
  }

  check(): void {
    if (this.cancelled) throw new CancellationError();
  }

  /** 일시정지 중이면 기다립니다. `signal`이 끊겨도 깨어납니다. */
  async waitIfPaused(signal?: AbortSignal): Promise<void> {
    while (this.paused && !this.cancelled && !signal?.aborted) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        signal?.addEventListener('abort', () => resolve(), { once: true });
      });
    }
    this.check();
    if (signal?.aborted) throw new CancellationError();
  }
}

/** 취소하면 바로 끝나는 대기입니다. */
export function sleep(seconds: number, control?: RunControl): Promise<void> {
  if (seconds <= 0) {
    control?.check();
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      control?.signal.removeEventListener('abort', onAbort);
      resolve();
    }, seconds * 1000);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancellationError());
    };
    if (control?.isCancelled) return onAbort();
    control?.signal.addEventListener('abort', onAbort, { once: true });
  });
}
