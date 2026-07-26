import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    // 必须 external 掉 dependencies：better-sqlite3 / @napi-rs/keyring 都是原生模块，
    // 一旦被 rollup 内联，它们加载 .node 的动态 require 会被替换成只会抛
    // "Could not dynamically require" 的桩函数，openDb() 第一行就炸，minisd 起不来。
    plugins: [externalizeDepsPlugin()],
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
    plugins: [externalizeDepsPlugin()],
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
