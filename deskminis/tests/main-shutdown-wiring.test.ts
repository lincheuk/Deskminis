/**
 * W1b-5（lifecycle.md W1b-quit · 设计稿 §3 第 11 条）：优雅退出的接线（源码守卫）。
 *
 * 主进程要在 Electron 里才能跑，单测起不来，接线只能按调用形态认：
 *  - before-quit：把事件交给 quitGate.onBeforeQuit，钩子是「收窗口与托盘」「stopMinisdGracefully」「app.quit()」；
 *    挡不挡、等不等、第二次放不放行都在 QuitGate 里，行为测试在 tests/minisd-stop.test.ts（审查实测过：
 *    只认调用形态的话，「不等停完就 quit」「早退分支没了、永远退不出」都骗得过守卫）。处理体里不直接 kill。
 *  - 「重启并安装」：先 await 停止，再 quitAndInstall——electron-updater 同步 spawn 安装器、下一拍才 quit，
 *    不先停的话安装器与还活着的 minisd 抢同一个 exe。
 *  - 引擎进程的 exit 监听在 src/main 里只挂一个（设计稿 §3 第 11 条），由它写退出记录；
 *    on / once / addListener / prependListener / prependOnceListener、单双反引号都算；事件名一律写字面量，
 *    常量名或变量传进来的认不出是不是 exit。
 *  - 停止器等的就是那条监听写入的记录：startMinisdProcess 里只建一份 MinisdExitWatch，同一个名字既赋给
 *    minisdExit（stopMinisdGracefully 与 minisdAlive 读它），又在 exit 监听里 markExited。
 *  - 握手前的启动失败仍直接 kill，不走优雅停（进程可能根本没起来，等满 5 秒没有意义）。
 *  - minisd 的 standalone 分支接 parentPort 的 shutdown 消息，交给 closeThenExit（close 做完才退，行为测试在
 *    tests/shutdown-partial-reply.test.ts）；分支里别处不许 process.exit(。
 *  - minisd 的 shutdown：closing 置真之后紧跟 try，每一步各自兜住，关库放锁在 finally 里。
 *    第 6 步（W1b-5d）：终端、shell、MCP 的 disposeAll 各作为一步交给 await shutdownReap(…)，各自兜住地发起、
 *    一起等回收落定（上限 reapWaitMs），等完才关桥与 rpc；「等不等、等多久、一步抛错其余照做」的行为测试在
 *    tests/shutdown-reap.test.ts，这里只认接线。
 * 纯逻辑（超时 kill、幂等、退出记录）的行为测试在 tests/minisd-stop.test.ts。
 * 源码先剥注释再匹配：注释里写着旧调用也不能喂饱断言（handoff §2.10）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './strip-comments';

const read = (rel: string) => stripComments(readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n'));
const main = read('src/main/index.ts');
const minisd = read('src/minisd/index.ts');

/** 从 anchor 命中处之后的第一个 { 起，按括号配对取出块体（不含外层花括号）；找不到返回 ''。 */
function blockAfter(src: string, anchor: RegExp): string {
  const m = anchor.exec(src);
  if (!m) return '';
  const open = src.indexOf('{', m.index + m[0].length - 1);
  if (open < 0) return '';
  let depth = 1; let i = open + 1;
  for (; i < src.length && depth > 0; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
  }
  return src.slice(open + 1, i - 1);
}

describe('主进程：before-quit 交给 QuitGate', () => {
  const head = /app\.on\(\s*'before-quit'\s*,\s*\(\s*(\w+)\s*\)\s*=>\s*\{/;
  const ev = head.exec(main)?.[1] ?? '';
  const body = blockAfter(main, head);

  it('处理体只有两句：quitting = true，然后把这次事件交给 quitGate.onBeforeQuit(e, { … })', () => {
    expect(ev).not.toBe('');
    expect(body).toMatch(new RegExp(`^\\s*quitting = true;\\s*quitGate\\.onBeforeQuit\\(${ev},\\s*\\{[\\s\\S]*\\}\\);\\s*$`));
    expect(main.match(/\bnew QuitGate\(\)/g) ?? [], '全文件一个 QuitGate：放行状态只有一份').toHaveLength(1);
  });

  it('钩子：stop 是 stopMinisdGracefully(MINISD_STOP_TIMEOUT_MS)，quit 是 app.quit()，minisdAlive 认「fork 过且没先退」', () => {
    expect(body).toMatch(/\bstop:\s*\(\)\s*=>\s*stopMinisdGracefully\(MINISD_STOP_TIMEOUT_MS\)\s*,/);
    expect(body).toMatch(/\bquit:\s*\(\)\s*=>\s*app\.quit\(\)/);
    expect(body).toMatch(/\bminisdAlive:\s*minisd !== undefined && !minisdExit\?\.exited\s*,/);
  });

  it('处理体不自己挡、不自己停、不自己退、不 kill：等待与放行只在 QuitGate 里', () => {
    expect(body.match(/stopMinisdGracefully\(/g) ?? []).toHaveLength(1);
    expect(body.match(/app\.quit\(/g) ?? []).toHaveLength(1);
    expect(body).not.toMatch(/\.preventDefault\(/);
    expect(body).not.toMatch(/\.kill\(/);
    expect(body).not.toMatch(/\.then\(|\bawait\b|markStopped\(/);
  });

  it('hideUi 隐藏全部窗口、销毁托盘（用户立刻看到已退出）', () => {
    const hide = blockAfter(body, /\bhideUi:\s*\(\)\s*=>\s*\{/);
    expect(hide).toMatch(/BrowserWindow\.getAllWindows\(\)\)\s*\w+\.hide\(\)/);
    expect(hide).toMatch(/tray\?\.destroy\(\)/);
  });

  it('stopMinisdGracefully 走 minisdExit.stop，时限用 MINISD_STOP_TIMEOUT_MS', () => {
    const fn = blockAfter(main, /function stopMinisdGracefully\(/);
    // 认 minisdExit 这个名字：它是不是 exit 监听写的那一份，由下面「停止器等的就是那一处写入的退出记录」钉
    expect(fn).toMatch(/\breturn minisdExit\.stop\(minisd,\s*timeoutMs\);/);
    expect(main).toMatch(/stopMinisdGracefully\(MINISD_STOP_TIMEOUT_MS\)/);
  });
});

describe('主进程：引擎的 exit 监听只有一个，由它写退出记录', () => {
  // 各种挂监听的写法、各种引号都算（审查实测：只认 .on/.once 加单引号的话，once("exit") 与 addListener('exit') 都漏）；
  // 方法名与括号之间的空白、可选调用 `?.(` 也算（三审 N2/N3：`minisd.once ('exit', …)`、`minisd.on?.('exit', …)` 曾数不到）
  const HOOK = String.raw`\.(?:on|once|addListener|prependListener|prependOnceListener)\s*(?:\?\.)?\s*\(`;
  const EXIT_LISTENER = new RegExp(HOOK + String.raw`\s*['"\`]exit['"\`]`);
  const mainDir = join(__dirname, '..', 'src/main');
  const sources = readdirSync(mainDir).filter(f => f.endsWith('.ts')).map(f => [f, read(`src/main/${f}`)] as const);
  /** src/main 每个文件里 re 命中几次就记几个文件名 */
  const hitFiles = (re: RegExp) => sources.flatMap(([f, src]) => (src.match(new RegExp(re.source, 'g')) ?? []).map(() => f));

  it('src/main 全部源码里恰好一处 exit 监听，在 index.ts', () => {
    expect(hitFiles(EXIT_LISTENER)).toEqual(['index.ts']);
  });

  it('src/main 里挂监听一律写字面量事件名（常量名、变量传进来的 exit 上面那条数不到）', () => {
    // 审查实测（二审 R15）：`const EV = 'exit' as const; minisd.once(EV, …)` 再挂一个，只认字面量的计数照样是 1。
    // (?![\s'"`]) 连空白一起排除：\s* 回退一格时下一个字符是空白，不能因此把 `.on( 'x'` 当成非字面量
    const nonLiteral = new RegExp(HOOK + String.raw`\s*(?![\s'"\`])`);
    expect(hitFiles(nonLiteral)).toEqual([]);
  });

  it('停止器等的就是那一处写入的退出记录：startMinisdProcess 里只建一份 MinisdExitWatch，同一个名字赋给 minisdExit、在 exit 监听里 markExited', () => {
    // 审查实测（二审 R17 / R12）：删掉 `minisdExit = exitWatch;`，或改成另建一个实例，旧守卫与 typecheck 全绿，
    // 优雅退出却整个失效——前者 stopMinisdGracefully 以为没 fork 过、直接返回 already-exited，从不发 shutdown，退出退回硬杀；
    // 后者停止器永远等不到退出记录，每次退出都等满 5 秒再 kill，minisd 先崩了 minisdAlive 也还是真。
    expect(hitFiles(/\bnew MinisdExitWatch\(/), 'src/main 里只建一份退出记录').toEqual(['index.ts']);
    const start = blockAfter(main, /function startMinisdProcess\(\): Promise<number> \{/);
    const created = /\bconst (\w+) = new MinisdExitWatch\(\);\s*minisdExit = \1;/.exec(start);
    expect(created?.[1], 'startMinisdProcess 里：const X = new MinisdExitWatch(); minisdExit = X;').toBeTruthy();
    // 别处再赋值（置空、换成别的实例）同样让停止器与监听对不上；`===` / `!==` 不算
    expect(main.match(/\bminisdExit\s*=(?!=)/g) ?? [], 'minisdExit 只在那一处赋值').toHaveLength(1);

    const head = new RegExp(EXIT_LISTENER.source + String.raw`\s*,\s*\(?\s*(\w+)[\w\s,]*\)?\s*=>\s*\{`);
    const code = head.exec(start)?.[1];
    expect(code, 'exit 监听在 startMinisdProcess 里，并接住退出码').toBeTruthy();
    const listener = blockAfter(start, head);
    expect(listener.match(new RegExp(String.raw`\b${created?.[1]}\.markExited\(${code}\)`, 'g')) ?? [],
      '监听写入的是赋给 minisdExit 的同一个实例').toHaveLength(1);
    // 而且是第一句、无条件写（三审 N1：包进 `if (minisdPort === 0)` 之后「恰好一次」照样成立，全绿；
    // 可握手后的退出从此不进记录——停止器每次白等 5 秒再 kill，崩了 minisdAlive 还是真，W2b-7 也分不清退出与崩溃）
    expect(listener, 'exit 监听体第一句就是无条件的 markExited(退出码);')
      .toMatch(new RegExp(String.raw`^\s*${created?.[1]}\.markExited\(${code}\);`));
  });
});

describe('主进程：「重启并安装」先停 minisd 再 quitAndInstall', () => {
  const body = blockAfter(main, /autoUpdater\.on\(\s*'update-downloaded'/);

  it('await stopMinisdGracefully( 在 autoUpdater.quitAndInstall( 之前', () => {
    const iStop = body.search(/await stopMinisdGracefully\(/);
    const iInstall = body.search(/autoUpdater\.quitAndInstall\(/);
    expect(iStop).toBeGreaterThan(-1);
    expect(iInstall).toBeGreaterThan(iStop);
  });

  it('停完 quitGate.markStopped()（quitAndInstall 触发的 before-quit 直接放行，不再等第二遍）', () => {
    expect(body).toMatch(/await stopMinisdGracefully\(MINISD_STOP_TIMEOUT_MS\);\s*quitGate\.markStopped\(\);\s*autoUpdater\.quitAndInstall\(\)/);
  });
});

describe('主进程：握手前启动失败仍直接 kill', () => {
  const whenReady = blockAfter(main, /app\.whenReady\(\)\.then\(async \(\) => \{/);
  const caught = blockAfter(whenReady, /\}\s*catch\s*\(e\)\s*\{/);

  it('catch 里 minisd?.kill()，quitGate.markStopped() 后 app.quit()，不调 stopMinisdGracefully', () => {
    expect(caught).toMatch(/minisd\?\.kill\(\);\s*quitGate\.markStopped\(\);\s*app\.quit\(\)/);
    expect(caught).not.toMatch(/stopMinisdGracefully\(/);
  });
});

describe('minisd：standalone 分支接 shutdown 消息', () => {
  const standalone = blockAfter(minisd, /if \(process\.env\.DESKMINIS_STANDALONE === '1'\) \{/);
  const handler = blockAfter(standalone, /process\.parentPort\?\.on\(\s*'message'\s*,\s*\(\s*\w+\s*\)\s*=>\s*\{/);

  it('parentPort 的 message 监听只认 type === \'shutdown\'，交给 closeThenExit(starting, code => process.exit(code))', () => {
    expect(handler).not.toBe('');
    expect(handler).toMatch(/\.type\s*!==\s*'shutdown'\)\s*return;/);
    expect(handler).toMatch(/\bvoid closeThenExit\(starting,\s*\(?code\)?\s*=>\s*process\.exit\(code\)\);/);
  });

  it('分支里 process.exit( 只有交给 closeThenExit 的那一处：不在 close 做完之前另退', () => {
    // 审查实测：`void inst.close(…); process.exit(0);`（库还没关就退）只认「有 close、有 exit(0)」的守卫照样绿
    expect(standalone.match(/process\.exit\(/g) ?? []).toHaveLength(1);
    expect(standalone).not.toMatch(/\.close\(/);
  });
});

describe('minisd：shutdown 的每一步各自兜住，关库放锁在 finally', () => {
  const body = blockAfter(minisd, /async function shutdown\(graceMs: number\): Promise<void> \{/);

  it('closing = true 之后紧跟 try，这个 try 的 finally 是函数的最后一段：关库，再放锁', () => {
    // 审查实测：try 只包住第 6 步时，第 3 步审计写入抛错就跳过关库放锁，同一进程里这个根再也打不开
    const head = /^\s*closing = true;\s*try \{/;
    expect(body).toMatch(head);
    const tryBody = blockAfter(body, head);
    const rest = body.slice(body.indexOf(tryBody) + tryBody.length + 1).replace(/\s+/g, ' ').trim();
    expect(rest).toBe('finally { try { db.close(); } finally { lock.release(); } }');
  });

  it('同步的步骤都包在 shutdownStep(…) 里：一步抛错只记一笔，后面的 abort、销毁子进程照做', () => {
    // W1b-5d 有意重指：三个 disposeAll 原来也在这张表里（各自一句同步的 shutdownStep）。它们现在返回回收落定的 Promise，
    // 改由下一条的 shutdownReap 各自兜住地发起、一起限时等待；这里只留仍是同步一步的两项
    for (const call of ['syncCoordinator.stop()', "denyPendingPerms('all', 'shutdown')"]) {
      const esc = call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(body.match(new RegExp(esc, 'g')) ?? [], call).toHaveLength(1);
      expect(body, call).toMatch(new RegExp(`\\bshutdownStep\\('[^']+',\\s*\\(\\)\\s*=>\\s*${esc}\\);`));
    }
    for (const call of ['bridge?.close()', 'rpc.close()']) {
      const esc = call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(body.match(new RegExp(esc, 'g')) ?? [], call).toHaveLength(1);
      expect(body, call).toMatch(new RegExp(`\\bawait shutdownStepAsync\\('[^']+',\\s*\\(\\)\\s*=>\\s*${esc}\\);`));
    }
  });

  it('第 6 步（W1b-5d）：三个 disposeAll 各是 await shutdownReap([…], reapWaitMs) 的一步；等完才关桥与 rpc', () => {
    // 审查要防的回退：退回同步的三句 shutdownStep（起了 taskkill 不等就关库退出，孙进程成孤儿）、
    // 只把其中一两个交给等待、或者等待挪到关桥 / 关 rpc 之后。等的行为（落定前不关库、上限、一步抛错其余照做）
    // 由 tests/shutdown-reap.test.ts 按行为钉住
    const head = /\bawait shutdownReap\(/;
    const at = body.search(head);
    expect(at, 'shutdown 里要 await shutdownReap(…)').toBeGreaterThan(-1);
    // 等回收要排在等 run 收尾之后（W1b-5e，W1b-5d 审查变异 R1：整句挪到 stopRun 之前，原有断言照绿）：先 abort 在跑的工具、
    // 等它们落下 [已取消]，再收子进程；反过来的话，在跑的 shell / MCP 工具看到的是进程没了，记成执行失败
    const stopRuns = body.search(/await Promise\.all\(\[\.\.\.runs\.keys\(\)\]\.map\(/);
    expect(stopRuns, '等 run 收尾那一句要在').toBeGreaterThan(-1);
    expect(at, '等回收要排在等 run 收尾之后').toBeGreaterThan(stopRuns);
    expect(body.match(/\bshutdownReap\(/g) ?? [], '只调一次').toHaveLength(1);
    // 取出这次调用的实参（按圆括号配对）
    const open = body.indexOf('(', at);
    let depth = 1; let i = open + 1;
    for (; i < body.length && depth > 0; i++) {
      if (body[i] === '(') depth++;
      else if (body[i] === ')') depth--;
    }
    const args = body.slice(open + 1, i - 1);
    for (const call of ['terminals.disposeAll()', 'shells.disposeAll()', 'mcpManager.disposeAll()']) {
      const esc = call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(body.match(new RegExp(esc, 'g')) ?? [], `${call} 在 shutdown 里只出现一次`).toHaveLength(1);
      expect(args, `${call} 是 shutdownReap 的一步 ['名字', () => …]`).toMatch(new RegExp(`\\[\\s*'[^']+',\\s*\\(\\)\\s*=>\\s*${esc}\\s*\\]`));
    }
    expect(args, '上限是 reapWaitMs（注入值，缺省 REAP_WAIT_MS）').toMatch(/\],?\s*\],\s*reapWaitMs\s*$/);
    for (const call of ['bridge?.close()', 'rpc.close()']) {
      const esc = call.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(body.search(new RegExp(`await shutdownStepAsync\\('[^']+',\\s*\\(\\)\\s*=>\\s*${esc}\\)`)), `${call} 要排在等回收之后`)
        .toBeGreaterThan(at);
    }
  });

  it('了结全部权限卡之后、没有 await 就逐个 stopRun（先看取消才落得下 [已取消]）；单个会话停失败不拖垮 Promise.all', () => {
    expect(body).toMatch(/shutdownStep\('[^']+',\s*\(\)\s*=>\s*denyPendingPerms\('all', 'shutdown'\)\);\s*await Promise\.all\(\[\.\.\.runs\.keys\(\)\]\.map\(\s*sessionId\s*=>\s*stopRun\(sessionId,\s*graceMs,\s*'shutdown'\)\.catch\(/);
  });
});
