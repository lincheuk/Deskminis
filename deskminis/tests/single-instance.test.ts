/** W1b-3（侦察 lifecycle.md W1b-single；cross.md S11）：主进程单实例锁（源码守卫，认调用形态）。
 *
 *  为什么：主进程以前没有 requestSingleInstanceLock。托盘里藏着一个 DeskMinis 时再双击图标，会整套再起一遍：
 *  第二个主进程、第二个 minisd，两边同写一个库（数据根锁之前）；有了数据根锁之后也会多弹一个「已在运行」的框，
 *  而用户要的只是把藏起来的窗口叫回来。
 *
 *  钉住的形态：
 *  ① 模块顶层、setPath('userData') 之后拿锁（Electron 的锁按 userData 算，W1a-9 已把 dev 的 userData 分出去），
 *     在任何函数声明与 app.whenReady( 之前；全文件只拿一次。
 *  ② 拿不到锁就 app.quit()；second-instance 只在拿到锁时挂。
 *  ③ second-instance：退出流程中（quitting）什么都不做；主窗口还没建好就记一笔，建好后立即唤出；
 *     建好了就「最小化才 restore」、show、focus——托盘隐藏的窗口 show 才回得来。
 *  ④ 主窗口放到模块级（whenReady 里建好立即赋值），second-instance 才拿得到它。
 *  ⑤ whenReady 回调首行早退：app.quit() 之后 ready 仍可能触发，不早退的话第二个实例照样 fork minisd、建窗口、起更新检查。
 *
 *  本文件不 import src/main/index.ts（electron 桩只在 ipc-contract.test.ts 维护一份，它的 requestSingleInstanceLock 返回 true）。
 *  源码读进来先去注释：代码回退了而注释里还留着旧调用的原文时，读原文的断言照样命中（W1a-9 审查的「注释喂饱」变异）。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './strip-comments';

const main = stripComments(readFileSync(join(__dirname, '..', 'src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n'));

/** 从 anchor 之后的第一个 `{` 起做括号配对，取出块体（不含两端）。 */
function blockAfter(src: string, anchor: string, from = 0): string {
  const at = src.indexOf(anchor, from);
  expect(at, `源码里找不到锚点 ${anchor}`).toBeGreaterThanOrEqual(0);
  const open = src.indexOf('{', at + anchor.length - 1);
  let depth = 1; let i = open + 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return src.slice(open + 1, i - 1);
}
const statements = (body: string): string[] => body.split('\n').map(l => l.trim()).filter(Boolean);

describe('① 模块顶层拿单实例锁', () => {
  it('行首 `const gotSingleInstanceLock = app.requestSingleInstanceLock();`，全文件只调一次', () => {
    expect(main).toMatch(/^const gotSingleInstanceLock = app\.requestSingleInstanceLock\(\);$/m);
    expect(main.match(/\brequestSingleInstanceLock\(/g) ?? []).toHaveLength(1);
  });

  it('在 setPath(\'userData\') 之后、第一个顶层函数声明之前、app.whenReady( 之前', () => {
    const iLock = main.search(/^const gotSingleInstanceLock = app\.requestSingleInstanceLock\(\);$/m);
    const iSet = main.search(/app\.setPath\(\s*'userData'\s*,\s*dirs\.userData\s*\)/);
    const iFirstFn = main.search(/^(export )?(async )?function /m);
    const iReady = main.indexOf('app.whenReady(');
    expect(iLock).toBeGreaterThanOrEqual(0);
    expect(iSet).toBeGreaterThanOrEqual(0);
    expect(iLock, 'Electron 的单实例锁按 userData 算，必须在 setPath 之后').toBeGreaterThan(iSet);
    expect(iFirstFn).toBeGreaterThan(iLock);
    expect(iReady).toBeGreaterThan(iLock);
  });
});

describe('② 拿不到锁就退出；second-instance 只在拿到锁时挂', () => {
  it('`if (!gotSingleInstanceLock) { app.quit(); } else { app.on(\'second-instance\', …) }`', () => {
    expect(main).toMatch(/^if \(!gotSingleInstanceLock\) \{\s*app\.quit\(\);\s*\} else \{/m);
    const at = main.search(/^if \(!gotSingleInstanceLock\) \{/m);
    const elseBody = blockAfter(main, '} else {', at);
    expect(elseBody).toMatch(/^\s*app\.on\('second-instance',/);
    expect(main.match(/\.on\('second-instance'/g) ?? [], 'second-instance 只挂这一处').toHaveLength(1);
  });
});

describe('③ second-instance 的处理体', () => {
  // 每例各取一次：锚点不在时只让本例红，不让整个 describe 在收集阶段就崩掉
  const handler = (): string => blockAfter(main, "app.on('second-instance',");

  it('首行：退出流程中什么都不做', () => {
    expect(statements(handler())[0]).toBe('if (quitting) return;');
  });

  it('主窗口还没建好：记一笔等建好后唤出，然后返回', () => {
    expect(handler()).toMatch(/if \(mainWindow === undefined\) \{\s*revealWhenCreated = true;\s*return;\s*\}/);
  });

  it('主窗口在：最小化才 restore()，再 show()、focus()（托盘隐藏的窗口靠 show 回来）', () => {
    const body = handler();
    expect(body).toMatch(/if \(mainWindow\.isMinimized\(\)\) mainWindow\.restore\(\);/);
    const iRestore = body.indexOf('mainWindow.restore()');
    const iShow = body.indexOf('mainWindow.show()');
    const iFocus = body.indexOf('mainWindow.focus()');
    expect(iRestore).toBeGreaterThanOrEqual(0);
    expect(iShow).toBeGreaterThan(iRestore);
    expect(iFocus).toBeGreaterThan(iShow);
  });
});

describe('④ 主窗口放到模块级', () => {
  it('顶层 `let mainWindow: BrowserWindow | undefined;` 与 `let revealWhenCreated = false;`', () => {
    expect(main).toMatch(/^let mainWindow: BrowserWindow \| undefined;$/m);
    expect(main).toMatch(/^let revealWhenCreated = false;$/m);
  });

  it('whenReady 里建好窗口立即赋给模块级 mainWindow，并消费「建好后唤出」的标志；不再有同名局部变量遮住它', () => {
    const ready = blockAfter(main, 'app.whenReady().then(async () =>');
    expect(ready).toMatch(/const win = await createWindow\(\);\s*mainWindow = win;\s*if \(revealWhenCreated\) \{\s*revealWhenCreated = false;\s*win\.show\(\);\s*win\.focus\(\);\s*\}/);
    expect(ready).not.toMatch(/\b(const|let) mainWindow\b/);
  });
});

describe('⑤ whenReady 回调首行早退', () => {
  it('第一条语句是 `if (!gotSingleInstanceLock) return;`，在更新检查、fork minisd、建窗口之前', () => {
    const ready = blockAfter(main, 'app.whenReady().then(async () =>');
    const stmts = statements(ready);
    expect(stmts[0]).toBe('if (!gotSingleInstanceLock) return;');
    const iGuard = ready.indexOf('if (!gotSingleInstanceLock) return;');
    for (const call of ['setupUpdater(', 'startMinisdProcess(', 'createWindow(']) {
      expect(ready.indexOf(call), `${call} 必须在早退之后`).toBeGreaterThan(iGuard);
    }
  });
});
