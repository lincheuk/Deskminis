import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// 静态构建配置守卫：不跑构建，只读文本。
// 背景：minisd 依赖两个原生模块（better-sqlite3 / @napi-rs/keyring）。它们能跑起来有两个前提，
// 任一缺失都不会让 typecheck / build / 其它单测变红，只会在真正启动应用时炸：
//   1) 打包时必须 external —— 否则 rollup 会把模块体内联，并把它加载 .node 的动态 require
//      换成只会抛 "Could not dynamically require" 的桩，openDb() 第一行就死。
//   2) 安装后必须按 Electron 的 ABI 重建 —— minisd 跑在 Electron utilityProcess 里，
//      npm 装下来的 .node 是按 Node ABI 编译的，ABI 不匹配同样加载失败。
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const WHY = '原生模块必须 external 并按 Electron ABI 重建，否则 minisd 起不来';

function readText(rel: string): string {
  return readFileSync(join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
}

describe('构建配置：原生依赖', () => {
  it('electron.vite.config.ts 对 main 目标应用了 externalizeDepsPlugin', () => {
    const source = readText('electron.vite.config.ts');

    expect(
      /externalizeDepsPlugin/.test(source),
      `electron.vite.config.ts 必须从 electron-vite 导入 externalizeDepsPlugin；${WHY}——` +
        '内联后 better-sqlite3 的 bindings 加载器会被替换成抛错桩。',
    ).toBe(true);

    expect(
      /from\s+'electron-vite'/.test(source) && /externalizeDepsPlugin[^;]*from\s+'electron-vite'|import\s*\{[^}]*externalizeDepsPlugin[^}]*\}\s*from\s*'electron-vite'/.test(source),
      `externalizeDepsPlugin 必须来自 'electron-vite' 的导入；${WHY}。`,
    ).toBe(true);

    // main 目标块内必须挂上这个插件。取 main: { ... } 到下一个顶层目标（preload:）之间的文本。
    const mainBlock = source.match(/\bmain:\s*\{[\s\S]*?\n\s{2}\},\n\s{2}preload:/)?.[0];
    expect(
      mainBlock,
      'electron.vite.config.ts 里找不到 main 目标块（本守卫依赖 main: { ... } 后接 preload: 的写法）。',
    ).toBeDefined();
    expect(
      /plugins:\s*\[[^\]]*externalizeDepsPlugin\(\)/.test(mainBlock ?? ''),
      `electron.vite.config.ts 的 main 目标必须配置 plugins: [externalizeDepsPlugin()]；${WHY}。` +
        'main 目标产出的正是 minisd.js —— 少了它，better-sqlite3 被整体内联进 bundle，' +
        '运行时 new Database() 直接抛 "Could not dynamically require"。',
    ).toBe(true);
  });

  it('package.json 有按 Electron ABI 重建原生模块的脚本', () => {
    const pkg = JSON.parse(readText('package.json')) as { scripts?: Record<string, string>; devDependencies?: Record<string, string> };
    const scripts = pkg.scripts ?? {};

    expect(
      scripts.rebuild,
      `package.json 必须有 "rebuild" 脚本（electron-rebuild -f -w better-sqlite3）；${WHY}——` +
        'npm 装下来的 better_sqlite3.node 是 Node ABI，Electron utilityProcess 加载不了。',
    ).toBeDefined();
    expect(
      /electron-rebuild/.test(scripts.rebuild ?? ''),
      `"rebuild" 脚本必须调用 electron-rebuild；${WHY}。`,
    ).toBe(true);
    expect(
      /better-sqlite3/.test(scripts.rebuild ?? ''),
      `"rebuild" 脚本必须覆盖 better-sqlite3；${WHY}。`,
    ).toBe(true);

    // 重建必须自动发生：只靠人记得手跑一次，换台机器 / CI 上就又是启动即崩。
    expect(
      /electron-rebuild/.test(scripts.postinstall ?? ''),
      `package.json 必须有调用 electron-rebuild 的 "postinstall" 脚本；${WHY}——` +
        '否则 npm install 之后原生模块仍是 Node ABI，新环境一律启动失败。',
    ).toBe(true);

    expect(
      pkg.devDependencies?.['@electron/rebuild'],
      `@electron/rebuild 必须在 devDependencies 里，否则 rebuild/postinstall 脚本找不到命令；${WHY}。`,
    ).toBeDefined();
  });

  it('单测跑在 Electron 运行时上（与生产同 ABI）', () => {
    const pkg = JSON.parse(readText('package.json')) as { scripts?: Record<string, string> };
    const test = pkg.scripts?.test ?? '';

    // 这是上面那条重建要求的直接后果，别当成风格偏好改掉：
    // better_sqlite3.node 一次只能是一个 ABI。既然生产（Electron utilityProcess）要 ABI 139，
    // 那么用 plain node（ABI 137）跑 vitest 必然在 openDb() 处崩掉一片。
    // 解法是让 vitest 跑在 Electron 二进制上（ELECTRON_RUN_AS_NODE=1），
    // 顺带的好处：单测和真实运行时用的是同一个 ABI，DB 层的问题不会被测试环境掩盖。
    expect(
      /ELECTRON_RUN_AS_NODE/.test(test) && /electron/.test(test),
      '"test" 脚本必须用 Electron 二进制跑 vitest（cross-env ELECTRON_RUN_AS_NODE=1 electron …）。' +
        `改回 plain \`vitest run\` 会让所有碰 SQLite 的用例报 NODE_MODULE_VERSION 不匹配——${WHY}。`,
    ).toBe(true);
    expect(
      /vitest/.test(test),
      '"test" 脚本仍然必须跑 vitest。',
    ).toBe(true);
  });
});
