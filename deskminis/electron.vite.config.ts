import { defineConfig } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          minisd: resolve(__dirname, 'src/minisd/index.ts'),
        },
      },
    },
  },
  preload: { build: { rollupOptions: { input: resolve(__dirname, 'src/preload/index.ts') } } },
  renderer: {
    plugins: [vue()],
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  },
});
