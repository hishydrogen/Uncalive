import { defineConfig } from 'vitest/config';

// 화면용 Vite 설정과 달리 저장소 폴더를 기준으로 시험 파일을 찾습니다.
export default defineConfig({
  test: { root: '.', include: ['test/**/*.test.ts'] },
});
