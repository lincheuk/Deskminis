/** W1a-9：开发态数据隔离（设计稿 §2「开发态数据隔离」、侦察计划 lifecycle.md「W1a-devdata」）。
 *
 *  以前 `npm run dev` 与装好的正式版共用 %APPDATA%\DeskMinis 和 keyring 服务名 'DeskMinis'：
 *  同一个 minis.db（dev 能把正式库迁移到正式版不认识的版本）、同一个配对身份、同一个搜索 key 单槽。
 *  现在主进程启动时由 src/main/app-dirs.ts 一次算出四样东西，经 fork env 显式下发给 minisd：
 *    - 数据根：DESKMINIS_DATA_DIR 优先；否则正式版 APPDATA\DeskMinis，未打包 APPDATA\DeskMinis-dev；
 *    - userData：打包态不动（undefined）；未打包且没设 DATA_DIR 时就是数据根（与正式版在 Windows 上 userData≡数据根的布局一致）；
 *      未打包且设了 DATA_DIR=X 时是 X/electron（Electron 的单实例锁按 userData 算，driver 才能和开着的 dev 应用并存）；
 *    - keyring 服务名：正式版 'DeskMinis'，未打包 'DeskMinis-dev'（设不设 DATA_DIR 都一样）；
 *    - 日志目录：设了 DATA_DIR 时 <DATA_DIR>/logs；否则 LOCALAPPDATA\DeskMinis[-dev]\logs，非 Windows 回退 HOME/.local/state。
 *
 *  resolveAppDirs 是纯函数、不 import electron：isPackaged 与 env 由调用方传进来，这里直接穷举组合。
 *  路径一律用 resolve 过的假根，Windows 与 Linux 上都是绝对路径。 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { isAbsolute, join, resolve } from 'node:path';
import { resolveAppDirs } from '../src/main/app-dirs';
import { dataRoot, defaultDataRoot } from '../src/minisd/paths';
import { KeyringVault } from '../src/minisd/store/provider-store';

const BASE = resolve('/fake-user');
const ROAMING = join(BASE, 'AppData', 'Roaming');
const LOCAL = join(BASE, 'AppData', 'Local');
/** Windows 上的样子：APPDATA 与 LOCALAPPDATA 都在。 */
const WIN_ENV = Object.freeze({ APPDATA: ROAMING, LOCALAPPDATA: LOCAL, HOME: BASE });
const X = join(BASE, 'drv-data');

afterEach(() => { vi.unstubAllEnvs(); });

describe('resolveAppDirs：是否打包 × 是否设 DESKMINIS_DATA_DIR 四种组合', () => {
  it('未打包、没设 DATA_DIR：数据根与 userData 都是 APPDATA\\DeskMinis-dev，keyring 服务名 DeskMinis-dev', () => {
    const d = resolveAppDirs({ isPackaged: false, env: WIN_ENV });
    expect(d.variant).toBe('dev');
    expect(d.dataRoot).toBe(join(ROAMING, 'DeskMinis-dev'));
    expect(d.dataRoot.endsWith('DeskMinis-dev')).toBe(true);
    expect(d.userData, 'dev 的 userData 与数据根同一个目录，和正式版在 Windows 上的布局一致').toBe(d.dataRoot);
    expect(d.keyringService).toBe('DeskMinis-dev');
    expect(d.logRoot).toBe(join(LOCAL, 'DeskMinis-dev', 'logs'));
  });

  it('未打包、DATA_DIR=X：数据根就是 X，userData 挪到 X/electron，keyring 仍是 DeskMinis-dev，日志在 X/logs', () => {
    const d = resolveAppDirs({ isPackaged: false, env: { ...WIN_ENV, DESKMINIS_DATA_DIR: X } });
    expect(d.variant).toBe('dev');
    expect(d.dataRoot).toBe(X);
    expect(d.userData, '每个临时根有自己的 Chromium 配置与单实例锁，driver 才能和开着的 dev 应用并存').toBe(join(X, 'electron'));
    expect(d.keyringService).toBe('DeskMinis-dev');
    expect(d.logRoot).toBe(join(X, 'logs'));
  });

  it('打包、没设 DATA_DIR：与改动前完全相同——数据根同 paths.dataRoot()，不动 userData，服务名 DeskMinis', () => {
    vi.stubEnv('APPDATA', ROAMING);
    vi.stubEnv('DESKMINIS_DATA_DIR', undefined);
    const d = resolveAppDirs({ isPackaged: true, env: process.env });
    expect(d.variant).toBe('prod');
    expect(d.dataRoot).toBe(dataRoot());
    expect(d.dataRoot).toBe(join(ROAMING, 'DeskMinis'));
    expect(d.userData, '打包态动 userData 会丢用户已保存的主题（localStorage）与 update-prefs').toBeUndefined();
    expect(d.keyringService).toBe('DeskMinis');
  });

  it('打包、DATA_DIR=X：数据根是 X，userData 仍不动，服务名 DeskMinis，日志在 X/logs', () => {
    const d = resolveAppDirs({ isPackaged: true, env: { ...WIN_ENV, DESKMINIS_DATA_DIR: X } });
    expect(d.variant).toBe('prod');
    expect(d.dataRoot).toBe(X);
    expect(d.userData).toBeUndefined();
    expect(d.keyringService).toBe('DeskMinis');
    expect(d.logRoot).toBe(join(X, 'logs'));
  });
});

describe('resolveAppDirs：边角', () => {
  it('正式版日志在 LOCALAPPDATA\\DeskMinis\\logs，不在会漫游的数据根里', () => {
    const d = resolveAppDirs({ isPackaged: true, env: WIN_ENV });
    expect(d.logRoot).toBe(join(LOCAL, 'DeskMinis', 'logs'));
    expect(d.logRoot.startsWith(d.dataRoot)).toBe(false);
  });

  it('dev 与正式版在同一台机器上三样全不相同（隔离的本意）', () => {
    const prod = resolveAppDirs({ isPackaged: true, env: WIN_ENV });
    const dev = resolveAppDirs({ isPackaged: false, env: WIN_ENV });
    expect(dev.dataRoot).not.toBe(prod.dataRoot);
    expect(dev.keyringService).not.toBe(prod.keyringService);
    expect(dev.logRoot).not.toBe(prod.logRoot);
  });

  it('非 Windows（没有 APPDATA / LOCALAPPDATA）：数据根回退 HOME/.config，日志回退 HOME/.local/state', () => {
    const env = { HOME: BASE };
    const dev = resolveAppDirs({ isPackaged: false, env });
    expect(dev.dataRoot).toBe(join(BASE, '.config', 'DeskMinis-dev'));
    expect(dev.logRoot).toBe(join(BASE, '.local', 'state', 'DeskMinis-dev', 'logs'));
    const prod = resolveAppDirs({ isPackaged: true, env });
    expect(prod.dataRoot).toBe(join(BASE, '.config', 'DeskMinis'));
    expect(prod.logRoot).toBe(join(BASE, '.local', 'state', 'DeskMinis', 'logs'));
  });

  it('DATA_DIR 为空串时当没设（与 paths.dataRoot() 的判断一致）', () => {
    const d = resolveAppDirs({ isPackaged: false, env: { ...WIN_ENV, DESKMINIS_DATA_DIR: '' } });
    expect(d.dataRoot).toBe(join(ROAMING, 'DeskMinis-dev'));
    expect(d.userData).toBe(d.dataRoot);
  });

  it('相对路径的 DATA_DIR 先按当前目录取绝对路径——app.setPath 只收绝对路径，给相对路径会在模块顶层抛错', () => {
    const d = resolveAppDirs({ isPackaged: false, env: { ...WIN_ENV, DESKMINIS_DATA_DIR: 'rel-data' } });
    expect(d.dataRoot).toBe(resolve('rel-data'));
    expect(isAbsolute(d.userData!)).toBe(true);
    expect(d.userData).toBe(join(resolve('rel-data'), 'electron'));
    expect(isAbsolute(d.logRoot)).toBe(true);
  });

  it('只读 env、不改写它（主进程把结果经 fork env 显式下发，不回写 process.env）', () => {
    const env = Object.freeze({ ...WIN_ENV, DESKMINIS_DATA_DIR: X });
    expect(() => resolveAppDirs({ isPackaged: false, env })).not.toThrow();
    expect(env).toEqual({ ...WIN_ENV, DESKMINIS_DATA_DIR: X });
  });

  it('正式版的服务名与 KeyringVault 的缺省值是同一个——两处写的字面量一旦漂移，正式版就读不到已存的 key', () => {
    expect(resolveAppDirs({ isPackaged: true, env: WIN_ENV }).keyringService).toBe(new KeyringVault().service);
  });
});

describe('paths.defaultDataRoot：与 dataRoot() 共用同一套 APPDATA / HOME 回退', () => {
  it('prod 与 dev 各一个目录名', () => {
    expect(defaultDataRoot(WIN_ENV, 'prod')).toBe(join(ROAMING, 'DeskMinis'));
    expect(defaultDataRoot(WIN_ENV, 'dev')).toBe(join(ROAMING, 'DeskMinis-dev'));
    expect(defaultDataRoot({ HOME: BASE }, 'prod')).toBe(join(BASE, '.config', 'DeskMinis'));
  });

  it('dataRoot() 对外行为不变：DATA_DIR 优先，否则正式版的根（standalone 脚本仍默认用正式版的根）', () => {
    vi.stubEnv('APPDATA', ROAMING);
    vi.stubEnv('DESKMINIS_DATA_DIR', X);
    expect(dataRoot()).toBe(X);
    vi.stubEnv('DESKMINIS_DATA_DIR', undefined);
    expect(dataRoot()).toBe(join(ROAMING, 'DeskMinis'));
  });
});
