// 화면은 Vite 개발 서버에서, 메인 프로세스는 빌드한 파일로 실행합니다. 화면 코드를 고치면 바로 반영됩니다.
import { spawn } from 'node:child_process';
import { createServer } from 'vite';

await import('./build-main.mjs');
const server = await createServer({ configFile: 'vite.config.mts' });
await server.listen();
const url = server.resolvedUrls.local[0];
const electron = (await import('electron')).default;
const child = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, VITE_DEV_SERVER_URL: url } });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
