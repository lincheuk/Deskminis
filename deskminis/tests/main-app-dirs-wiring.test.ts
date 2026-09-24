/** W1a-9：开发态数据隔离的接线（源码守卫，认调用形态）。
 *
 *  src/main/app-dirs.ts 的规则由 tests/app-dirs.test.ts 单测；这里钉「主进程真的按它办」：
 *  ① resolveAppDirs 在模块顶层只算一次，`app.setPath('userData', …)` 紧随其后。setPath 必须早于任何
 *     getPath('userData')、单实例锁（W1b-3 的 requestSingleInstanceLock 按 userData 算）和 ready——
 *     这是顶层代码的隐式顺序耦合，typecheck 与单测都看不见，只能靠源码位置钉住。
 *  ② 打包态不调 setPath：setPath 包在 `if (dirs.userData)` 里，resolveAppDirs 对打包态返回 undefined。
 *  ③ fork minisd 时显式下发 DESKMINIS_DATA_DIR / DESKMINIS_KEYRING_SERVICE / DESKMINIS_LOG_DIR，
 *     而且写在 `...process.env` 之后——顺序反了，外层 shell 里残留的旧值会盖掉主进程算出来的值。
 *  ④ attachments:save 用同一份 dirs.dataRoot，不再自己调 dataRoot() 另算一遍（两处算法一漂移，附件就落进另一个根）。
 *  ⑤ 主进程不改写 process.env；minisd 按 env 选 keyring 服务名。
 *  本文件不 import src/main/index.ts（electron 桩只在 ipc-contract.test.ts 维护一份）。
 *
 *  三份源码读进来就先去注释，之后所有正向匹配、位置搜索、blockAfter 都只看代码：
 *  代码回退了而注释里还留着旧调用的原文时，读原文的断言照样命中，测试不红（W1a-9 审查的 5 种「注释喂饱」变异）。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './strip-comments';

const repoRoot = join(__dirname, '..');
const readSrc = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');
const main = stripComments(readSrc('src/main/index.ts'));
const minisd = stripComments(readSrc('src/minisd/index.ts'));
const appDirs = stripComments(readSrc('src/main/app-dirs.ts'));

/** 从 anchor 之后的第一个 open 字符起做配对，取出块体（不含两端）。 */
function blockAfter(src: string, anchor: string, open = '{', close = '}'): string {
  const at = src.indexOf(anchor);
  expect(at, `源码里找不到锚点 ${anchor}`).toBeGreaterThanOrEqual(0);
  const start = src.indexOf(open, at + anchor.length - 1);
  let depth = 1; let i = start + 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) depth--;
  }
  return src.slice(start + 1, i - 1);
}

describe('① 模块顶层一次算定，setPath 抢在一切之前', () => {
  const SET = /app\.setPath\(\s*'userData'\s*,\s*dirs\.userData\s*\)/;

  it('顶层 `const dirs = resolveAppDirs({ isPackaged: app.isPackaged, env: process.env })`，全文件只算这一次', () => {
    expect(main).toMatch(/^const dirs = resolveAppDirs\(\{\s*isPackaged:\s*app\.isPackaged,\s*env:\s*process\.env\s*\}\);$/m);
    expect(main.match(/\bresolveAppDirs\(/g) ?? []).toHaveLength(1);
    expect(main).toMatch(/import \{ resolveAppDirs \} from '\.\/app-dirs'/);
  });

  it('`app.setPath(\'userData\', dirs.userData)` 只有一处，在 resolveAppDirs 之后、任何函数声明与 app.whenReady( 之前', () => {
    expect(main.match(/app\.setPath\(/g) ?? [], 'setPath 只该出现这一处').toHaveLength(1);
    const iSet = main.search(SET);
    expect(iSet, '找不到 app.setPath(\'userData\', dirs.userData)').toBeGreaterThanOrEqual(0);
    expect(iSet).toBeGreaterThan(main.search(/const dirs = resolveAppDirs\(/));
    // 在第一个顶层函数声明之前 = 在模块求值时就执行，而不是等某个回调
    const iFirstFn = main.search(/^(export )?(async )?function /m);
    expect(iFirstFn).toBeGreaterThan(iSet);
    expect(main.indexOf('app.whenReady(')).toBeGreaterThan(iSet);
  });

  it('打包态不调 setPath：模块顶层（行首、不缩进）正是 `if (dirs.userData) app.setPath(\'userData\', dirs.userData);`', () => {
    // 行首不缩进 = 模块求值时执行；包进任何回调（哪怕回调注册在 whenReady 之前）都会缩进，这里就红
    expect(main).toMatch(/^if \(dirs\.userData\) app\.setPath\(\s*'userData'\s*,\s*dirs\.userData\s*\);$/m);
  });

  it('每个 getPath(\'userData\') 都在 setPath 之后；单实例锁（W1b-3 引入后）也必须在它之后', () => {
    const iSet = main.search(SET);
    expect(iSet, '找不到 app.setPath(\'userData\', dirs.userData)').toBeGreaterThanOrEqual(0);
    const re = /getPath\(\s*'userData'\s*\)/g;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(main)) !== null) { n++; expect(m.index).toBeGreaterThan(iSet); }
    expect(n, '至少 update-prefs.json 那一处').toBeGreaterThan(0);
    const iLock = main.search(/requestSingleInstanceLock\(/);
    if (iLock >= 0) expect(iLock, 'Electron 单实例锁按 userData 算，必须在 setPath 之后').toBeGreaterThan(iSet);
  });

  it('src/main/app-dirs.ts 是纯函数模块：不 import electron', () => {
    expect(appDirs).toMatch(/export function resolveAppDirs\(/);
    expect(appDirs).not.toMatch(/from ['"]electron['"]|require\(\s*['"]electron['"]\s*\)/);
  });
});

describe('② fork minisd 时显式下发三个目录变量', () => {
  const forkArgs = blockAfter(main, 'utilityProcess.fork(', '(', ')');

  it('env 字面量里有 DATA_DIR / KEYRING_SERVICE / LOG_DIR，取值都来自 dirs', () => {
    expect(forkArgs).toMatch(/DESKMINIS_DATA_DIR:\s*dirs\.dataRoot\b/);
    expect(forkArgs).toMatch(/DESKMINIS_KEYRING_SERVICE:\s*dirs\.keyringService\b/);
    expect(forkArgs).toMatch(/DESKMINIS_LOG_DIR:\s*dirs\.logRoot\b/);
    expect(forkArgs).toMatch(/DESKMINIS_STANDALONE:\s*'1'/);
  });

  it('三者都写在 `...process.env` 之后（后写的键才生效）', () => {
    const iSpread = forkArgs.indexOf('...process.env');
    expect(iSpread).toBeGreaterThanOrEqual(0);
    for (const k of ['DESKMINIS_DATA_DIR:', 'DESKMINIS_KEYRING_SERVICE:', 'DESKMINIS_LOG_DIR:']) {
      expect(forkArgs.indexOf(k), `${k} 必须在 ...process.env 之后`).toBeGreaterThan(iSpread);
    }
  });

  it('未打包时在日志里打一行「开发态数据根：…」（fork 之前，打包态不打）', () => {
    const body = blockAfter(main, 'function startMinisdProcess(');
    const iLog = body.search(/if \(dirs\.variant === 'dev'\)[^\n]*开发态数据根：\$\{dirs\.dataRoot\}/);
    expect(iLog).toBeGreaterThanOrEqual(0);
    expect(body.indexOf('utilityProcess.fork(')).toBeGreaterThan(iLog);
  });
});

describe('③ attachments:save 与数据根用同一份结果', () => {
  it('处理体用 attachmentPath(dirs.dataRoot, …)，不再调 dataRoot()', () => {
    const body = blockAfter(main, "ipcMain.handle('attachments:save'");
    expect(body).toMatch(/attachmentPath\(\s*dirs\.dataRoot\s*,/);
    expect(body).not.toMatch(/\bdataRoot\(\)/);
  });

  it('主进程不再从 paths 引入 dataRoot', () => {
    expect(main).not.toMatch(/import \{[^}]*\bdataRoot\b[^}]*\} from '\.\.\/minisd\/paths'/);
  });
});

describe('④ 不改写 process.env；minisd 按 env 选 keyring 服务名', () => {
  it('主进程里没有对 process.env 的赋值、删除或 Object.assign', () => {
    expect(main).not.toMatch(/process\.env(\.\w+|\[[^\]]+\])\s*=(?!=)/);
    expect(main).not.toMatch(/delete\s+process\.env/);
    expect(main).not.toMatch(/Object\.assign\(\s*process\.env/);
  });

  it('minisd 用 `new KeyringVault(keyringServiceFromEnv(process.env))`，不再有无参构造', () => {
    expect(minisd).toMatch(/new KeyringVault\(\s*keyringServiceFromEnv\(\s*process\.env\s*\)\s*\)/);
    expect(minisd).not.toMatch(/new KeyringVault\(\s*\)/);
    expect(minisd.match(/new KeyringVault\(/g) ?? [], 'KeyringVault 只在这一处构造').toHaveLength(1);
  });
});
