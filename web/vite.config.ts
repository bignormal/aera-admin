import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../internal/webui/dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    // Ant Design's jsdom setup is CPU-heavy enough that parallel files can
    // miss Testing Library's one-second query window on developer machines.
    // Keep the default verification command deterministic.
    fileParallelism: false,
  },
});
