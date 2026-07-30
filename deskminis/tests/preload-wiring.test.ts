import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 静态一致性守卫：不需要构建，直接读两个源文件的文本比对。
// 背景：electron.vite.config.ts 里 preload 的产出文件名，与 src/main/index.ts 里
// webPreferences.preload 引用的文件名，是一对隐式耦合。任何一侧单独改动都不会让
// typecheck / build / 其它单测变红，但运行时 Electron 会静默加载不到预加载脚本，
// window.deskminis 变成 undefined，rpc.connect() 直接抛错——整个应用连不上 minisd。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const COUPLING = '配置产出名必须与主进程引用名一致，否则预加载静默不加载';

function readText(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
}

describe('preload 接线', () => {
  it('配置产出名 == 主进程引用名，且格式为 CommonJS', () => {
    const configSource = readText('electron.vite.config.ts');
    const mainSource = readText('src/main/index.ts');

    // electron.vite.config.ts 的 preload 目标必须显式钉住产出文件名
    const configured = configSource.match(/entryFileNames:\s*'([^']+)'/)?.[1];
    expect(
      configured,
      `electron.vite.config.ts 的 preload 目标必须显式配置 output.entryFileNames；${COUPLING}`,
    ).toBeDefined();

    // src/main/index.ts 必须引用 ../preload/<文件名>
    const referenced = mainSource.match(/preload\/([\w.]+)'/)?.[1];
    expect(
      referenced,
      `src/main/index.ts 的 webPreferences.preload 必须引用 ../preload/<文件名>；${COUPLING}`,
    ).toBeDefined();

    // 核心断言：两侧文件名完全相等
    expect(
      referenced,
      `${COUPLING}：electron.vite.config.ts 产出 '${configured}'，` +
        `但 src/main/index.ts 引用 '${referenced}'。改一侧就必须同步改另一侧——` +
        '这类漂移不会让 typecheck/build 变红，只会在运行时静默失效。',
    ).toBe(configured);

    // preload 必须是 CommonJS：Electron 默认 sandbox: true 下 ESM(.mjs) 预加载加载不了，
    // 换 ESM 就得 sandbox: false，那会无谓削弱渲染进程沙箱。
    expect(
      /format:\s*'cjs'/.test(configSource),
      "electron.vite.config.ts 的 preload 必须配置 output.format: 'cjs'——" +
        'Electron 默认 sandbox: true 只支持 CommonJS 预加载；改成 ESM 就被迫 sandbox: false。',
    ).toBe(true);
    expect(configured, 'CJS 产出应使用 .cjs 扩展名（在 type:module 包中无歧义）').toMatch(/\.cjs$/);
  });
});
