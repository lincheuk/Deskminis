import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: { '@shared': new URL('./src/shared', import.meta.url).pathname } },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 30000 },
});
