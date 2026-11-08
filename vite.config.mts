import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: { outDir: '../../build/renderer', emptyOutDir: true, target: 'chrome130' },
  server: { port: 5199, strictPort: true },
});
