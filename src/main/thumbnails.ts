import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { nativeImage, screen } from 'electron';
import { imageSizeFromFile } from 'image-size/fromFile';

/**
 * 갤러리와 보관함 칸에 쓰는 작은 그림을 만들어 둡니다.
 * 원본 사진을 칸마다 그대로 그리면 창 크기를 바꿀 때마다 큰 그림을 다시 줄여 그려야 해서 화면이 끊겼습니다.
 * 맥과 Windows는 운영체제의 미리 보기 기능으로 사진과 동영상 모두 만들 수 있습니다. Linux는 원본을 씁니다.
 */
export class Thumbnails {
  /** 짧은 쪽 길이입니다. 칸이 300px쯤까지 커지고 레티나에서 두 배로 그려도 흐리지 않을 만큼입니다. */
  private static readonly side = 480;
  private readonly working = new Map<string, Promise<string | undefined>>();
  private readonly failed = new Set<string>();
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly folder: string) {}

  static get supported(): boolean {
    return process.platform === 'darwin' || process.platform === 'win32';
  }

  /** 작은 그림 파일의 경로를 돌려줍니다. 만들 수 없거나 원본이 이미 작으면 undefined입니다. */
  async get(file: string, isVideo: boolean): Promise<string | undefined> {
    if (!Thumbnails.supported) return undefined;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(file);
    } catch {
      return undefined;
    }
    const key = createHash('sha1').update(`2|${file}|${stat.size}|${stat.mtimeMs}`).digest('hex');
    if (this.failed.has(key)) return undefined;
    const target = path.join(this.folder, key.slice(0, 2), `${key}.jpg`);
    if (fs.existsSync(target)) {
      // 쓸 때마다 날짜를 새로 적어, 자주 보는 그림은 정리할 때 남깁니다.
      const now = new Date();
      void fs.promises.utimes(target, now, now).catch(() => undefined);
      return target;
    }
    let job = this.working.get(key);
    if (!job) {
      job = this.limit(() => this.make(file, isVideo, target)).catch(() => undefined);
      this.working.set(key, job);
      void job.then((result) => {
        this.working.delete(key);
        if (!result) this.failed.add(key);
      });
    }
    return job;
  }

  private async make(file: string, isVideo: boolean, target: string): Promise<string | undefined> {
    const side = Thumbnails.side;
    let size = { width: side, height: side };
    if (!isVideo) {
      const dimensions = await imageSizeFromFile(file).catch(() => undefined);
      if (dimensions?.width && dimensions.height) {
        // 사진 정보에 돌려 찍었다고 적혀 있으면 가로와 세로가 바뀌어 보입니다.
        const turned = (dimensions.orientation ?? 1) >= 5;
        const width = turned ? dimensions.height : dimensions.width;
        const height = turned ? dimensions.width : dimensions.height;
        // 원본이 이미 작으면 그대로 씁니다.
        if (Math.min(width, height) <= side * 1.25) return undefined;
        // 짧은 쪽을 맞추되, 아주 긴 그림은 긴 쪽을 네 배까지만 둡니다. 칸은 위쪽부터 잘라 보여 줍니다.
        const scale = Math.min(side / Math.min(width, height), (side * 4) / Math.max(width, height));
        size = { width: Math.round(width * scale), height: Math.round(height * scale) };
      }
    }
    // 맥은 크기를 화면 배율 단위로 받아 레티나에서 두 배로 만듭니다. 픽셀 크기가 맞도록 배율로 나눠 부탁합니다.
    const scale = process.platform === 'darwin' ? Math.max(1, screen.getPrimaryDisplay().scaleFactor) : 1;
    const image = await nativeImage.createThumbnailFromPath(file, { width: Math.round(size.width / scale), height: Math.round(size.height / scale) });
    if (image.isEmpty()) return undefined;
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.promises.writeFile(temporary, image.toJPEG(82));
    await fs.promises.rename(temporary, target);
    return target;
  }

  /** 한꺼번에 너무 많이 만들지 않게 세 개씩만 만듭니다. */
  private async limit<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= 3) await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running += 1;
    try {
      return await work();
    } finally {
      this.running -= 1;
      this.waiting.shift()?.();
    }
  }

  /** 두 달 넘게 쓰지 않은 작은 그림을 지웁니다. 앱을 켤 때 한 번 합니다. */
  async prune(): Promise<void> {
    const limit = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const groups = await fs.promises.readdir(this.folder).catch(() => [] as string[]);
    for (const group of groups) {
      const directory = path.join(this.folder, group);
      const names = await fs.promises.readdir(directory).catch(() => [] as string[]);
      for (const name of names) {
        const file = path.join(directory, name);
        const stat = await fs.promises.stat(file).catch(() => undefined);
        if (stat && stat.mtimeMs < limit) await fs.promises.rm(file, { force: true });
      }
    }
  }
}
