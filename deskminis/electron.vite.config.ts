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
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        // Electron 默认 sandbox: true 只支持 CommonJS 预加载；.cjs 在 type:module 包中无歧义
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    plugins: [vue()],
    resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  },
});
