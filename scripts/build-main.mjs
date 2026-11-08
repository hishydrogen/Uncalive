// 메인 프로세스와 프리로드를 하나의 파일로 묶습니다. 설치본에 node_modules를 넣지 않아도 됩니다.
import { build } from 'esbuild';

const watch = process.argv.includes('--watch');
const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: true, external: ['electron'], logLevel: 'info' };
const targets = [
  { ...common, entryPoints: ['src/main/main.ts'], outfile: 'build/main.js' },
  { ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'build/preload.js' },
];
if (watch) {
  const { context } = await import('esbuild');
  for (const options of targets) await (await context(options)).watch();
} else {
  await Promise.all(targets.map((options) => build(options)));
}
