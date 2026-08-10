import { URL, fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // plugin-vue 6 is built against the bundled Vite 8 types while this app runs Vitest's Vite 7;
  // the runtime plugin contract is compatible, so keep the boundary typed without widening app code.
  plugins: [vue() as never],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    clearMocks: true,
    environment: 'jsdom'
  }
});
