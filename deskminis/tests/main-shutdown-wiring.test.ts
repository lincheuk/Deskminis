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
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './strip-comments';
import { expectSame, callMark } from './engine-trace';
import type { EngineWatch } from './engine-wiring';
import { probeConnection, startCapturedEngine, type CapturedEngine } from './engine-assembly';
import { runStandaloneBranch } from './standalone-branch';
import type { StartMinisdOpts } from '../src/minisd/index';

const read = (rel: string) => stripComments(readFileSync(join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n'));
const main = read('src/main/index.ts');
const engines: CapturedEngine[] = [];
const savedFake = process.env.DESKMINIS_FAKE_PROVIDER;
const CLOSE = ['sync.stop', 'broker.settleWhere', 'terminals.disposeAll', 'shells.disposeAll', 'mcp.disposeAll', 'bridge.close', 'rpc.close', 'inputQueue.close', 'ledger.close', 'procLedger.close', 'db.close', 'lock.release'];
afterEach(async () => {
  for (const e of engines.splice(0).reverse()) {
    try { await e.close(); } catch { /* 变异失败后的收尾尽力 */ }
  }
  vi.restoreAllMocks();
  if (savedFake === undefined) delete process.env.DESKMINIS_FAKE_PROVIDER;
  else process.env.DESKMINIS_FAKE_PROVIDER = savedFake;
});

async function watchCurrentEngine(): Promise<EngineWatch> {
  return (await import('./engine-wiring')).watchEngine();
}
async function engine(opts: StartMinisdOpts = {}): Promise<CapturedEngine> {
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const e = await startCapturedEngine(opts);
  engines.push(e);
  return e;
}
async function until(what: string, test: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error('等待超时: ' + what);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}
async function pendingRun(w: EngineWatch, e: CapturedEngine): Promise<{ sid: string; release(): void; result: Promise<unknown> }> {
  let release!: () => void;
  w.spy('mcp.ensureForRun').mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const { id } = await e.methods['chat.sessions.create']({}, probeConnection('local')) as { id: string };
  const result = Promise.resolve(e.methods['chat.prompt']({ sessionId: id, providerId: '__fake__', text: 'Q20A SHUTDOWN' }, probeConnection('local'))).catch(error => error);
  await until('起跑挂在MCP', () => typeof release === 'function');
  return { sid: id, release, result };
}

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

  it('parentPort 的 message 监听只认 type === \'shutdown\'，交给 closeThenExit(starting, code => process.exit(code))', async () => {
    // message 是同步分发：监听已执行，后续微任务也经过，再确认其它类型没有开始关停。
    const run = await runStandaloneBranch();
    try {
      await run.settled();
      expect(run.spies['parentPort.on'].mock.calls.filter(args => args[0] === 'message')).toHaveLength(1);
      run.post({ type: 'other' });
      run.post(undefined);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(run.spies['sync.stop'].mock.calls).toHaveLength(0);
      expect(run.spies.exit.mock.calls).toHaveLength(0);
      // 真正的shutdown消息经过实际close，锁已释放才退出，退出码只有0。
      run.post({ type: 'shutdown' });
      expect(await run.exited()).toBe(0);
      expect(run.order().filter(name => ['sync.stop', 'lock.release', 'exit'].includes(name))).toEqual(['sync.stop', 'lock.release', 'exit']);
      expect(run.spies.exit.mock.calls).toEqual([[0]]);
    } finally {
      await run.dispose();
    }
  }, 60000);

  it('分支里 process.exit( 只有交给 closeThenExit 的那一处：不在 close 做完之前另退', async () => {
    // 实际RPC关闭尚未完成时不能提前exit，完成之后恰好一次exit(0)。
    let release!: () => void;
    const closeGate = new Promise<void>(resolve => {
      release = resolve;
    });
    const run = await runStandaloneBranch({ closeGate });
    try {
      await run.settled();
      run.post({ type: 'shutdown' });
      await until('RPC关闭已经开始且挂在闸上', () => run.spies['rpc.close'].mock.calls.length === 1);
      expect(run.spies.exit.mock.calls).toHaveLength(0);
      expect(run.spies['lock.release'].mock.calls).toHaveLength(0);
      release();
      expect(await run.exited()).toBe(0);
      expect(run.order().filter(name => ['rpc.close', 'lock.release', 'exit'].includes(name))).toEqual(['rpc.close', 'lock.release', 'exit']);
      expect(run.spies.exit.mock.calls).toEqual([[0]]);
    } finally {
      release();
      await run.dispose();
    }
  }, 60000);
});

describe('minisd：shutdown 的每一步各自兜住，关库放锁在 finally', () => {

  it('closing = true 之后紧跟 try，这个 try 的 finally 是函数的最后一段：关库，再放锁', async () => {
    // 关停开始后拒绝新运行，某一步出错仍按全序关库并释放锁。
    const w = await watchCurrentEngine();
    const e = await engine();
    const pending = await pendingRun(w, e);
    const original = w.spy('sync.stop').getMockImplementation()!;
    w.spy('sync.stop').mockImplementationOnce(function(this: unknown, ...args: unknown[]) {
      original.apply(this, args);
      throw new Error('Q20A-SYNC-STOP-FAIL');
    });
    const from = callMark();
    const closing = e.handle.close({ graceMs: 137 });
    await expect(e.methods['chat.prompt']({ sessionId: pending.sid, text: 'late' }, probeConnection('local'))).rejects.toThrow('后台正在关闭');
    pending.release();
    await pending.result;
    await expect(closing).resolves.toBeUndefined();
    const steps = [...CLOSE.slice(0, 2), 'broker.settleWhere', 'run.end', ...CLOSE.slice(2)];
    expect(w.seq([...CLOSE, 'run.end'], from)).toEqual(steps);
    expect(w.count('lock.release', from)).toBe(1);
    expect(w.args('inputQueue.holdSession')).toEqual([pending.sid, 'shutdown']);
    expect(w.args('abort')).toEqual(['shutdown']);
    expect(w.spy('run.end').mock.calls.at(-1)![1]).toMatchObject({ state: 'cancelled', reason: 'shutdown' });
    const stopTimers = w.spy('timers.setTimeout').mock.calls.filter((_, i) => w.spy('timers.setTimeout').mock.invocationCallOrder[i] > from).map(args => args[1]);
    expect(stopTimers.filter(ms => ms === 137)).toHaveLength(1);
    expect(w.spy('lock.release').mock.contexts.at(-1)).toBe(w.made('lock.acquire'));
  }, 60000);

  it('同步的步骤都包在 shutdownStep(…) 里：一步抛错只记一笔，后面的 abort、销毁子进程照做', async () => {
    // 每个同步或异步步骤抛错，其余步骤仍各走一次；错误后资源确实收尾。
    for (const failure of ['sync.stop', 'broker.settleWhere', 'bridge.close', 'rpc.close']) {
      vi.restoreAllMocks();
      const w = await watchCurrentEngine();
      const e = await engine();
      const spy = w.spy(failure);
      const original = spy.getMockImplementation()!;
      if (failure === 'bridge.close' || failure === 'rpc.close') {
        spy.mockImplementationOnce(async function(this: unknown, ...args: unknown[]) {
          await original.apply(this, args);
          throw new Error('Q20A-STEP-FAIL:' + failure);
        });
      }
      else {
        spy.mockImplementationOnce(function(this: unknown, ...args: unknown[]) {
          original.apply(this, args);
          throw new Error('Q20A-STEP-FAIL:' + failure);
        });
      }
      const from = callMark();
      await expect(e.close()).resolves.toBeUndefined();
      expect(w.seq(CLOSE, from), failure).toEqual(CLOSE);
      const [all, how] = w.args('broker.settleWhere');
      expect(how).toEqual({ reason: 'cancelled', cause: 'shutdown' });
      for (const sessionId of ['Q20A-ONE', 'Q20A-OTHER', '']) expect(all({ req: { sessionId } })).toBe(true);
      expectSame(w.spy('broker.settleWhere').mock.contexts.at(-1), w.made('new PermissionBroker'));
      for (const name of CLOSE)
        expect(w.count(name, from), name).toBe(1);
    }
  }, 60000);

  it('第 6 步（W1b-5d）：三个 disposeAll 各是 await shutdownReap([…], reapWaitMs) 的一步；等完才关桥与 rpc', async () => {
    // run先收尾，三种回收都发起并等实际闸落定，之后才关桥、RPC、账本和库。
    const w = await watchCurrentEngine();
    const e = await engine({ reapWaitMs: 3000 });
    const pending = await pendingRun(w, e);
    let reap!: () => void;
    w.spy('terminals.disposeAll').mockImplementationOnce(() => new Promise<void>(resolve => {
      reap = resolve;
    }));
    const from = callMark();
    const closing = e.handle.close({ graceMs: 321 });
    pending.release();
    await pending.result;
    await until('回收map已经同步走过', () => ['terminals.disposeAll', 'shells.disposeAll', 'mcp.disposeAll'].some(name => w.count(name, from) > 0));
    expect(w.seq(['terminals.disposeAll', 'shells.disposeAll', 'mcp.disposeAll'], from)).toEqual(['terminals.disposeAll', 'shells.disposeAll', 'mcp.disposeAll']);
    expect(w.count('bridge.close', from)).toBe(0);
    expect(w.count('rpc.close', from)).toBe(0);
    expect(w.count('db.close', from)).toBe(0);
    const timerDurations = w.spy('timers.setTimeout').mock.calls.filter((_, i) => w.spy('timers.setTimeout').mock.invocationCallOrder[i] > from).map(args => args[1]);
    expect(timerDurations.filter(ms => ms === 3000)).toHaveLength(1);
    expect(timerDurations).not.toContain(1000);
    reap();
    await expect(closing).resolves.toBeUndefined();
    expect(w.seq(['run.end', ...CLOSE.slice(2)], from)).toEqual(['run.end', ...CLOSE.slice(2)]);

    // 注入50ms上限：永不落定的回收也不能把关停拖到默认1000ms。
    vi.restoreAllMocks();
    const timed = await watchCurrentEngine();
    const second = await engine({ reapWaitMs: 50 });
    timed.spy('terminals.disposeAll').mockImplementationOnce(() => new Promise<void>(() => {
    }));
    const timerMark = callMark();
    await second.close();
    const scheduled = timed.spy('timers.setTimeout').mock.calls.filter((_, i) => timed.spy('timers.setTimeout').mock.invocationCallOrder[i] > timerMark).map(args => args[1]);
    expect(scheduled.filter(ms => ms === 50)).toHaveLength(1);
    expect(scheduled).not.toContain(1000);
    for (const name of CLOSE.slice(2)) expect(timed.count(name), name).toBe(1);

    // 每个回收入口单独出错，仍须由 shutdownReap 当场兜住，继续其余回收和全部关闭。
    for (const failure of ['terminals.disposeAll', 'shells.disposeAll', 'mcp.disposeAll']) {
      vi.restoreAllMocks();
      const fault = await watchCurrentEngine();
      const faulty = await engine({ reapWaitMs: 50 });
      const original = fault.spy(failure).getMockImplementation()!;
      fault.spy(failure).mockImplementationOnce(function(this: unknown, ...args: unknown[]) {
        original.apply(this, args);
        throw new Error('Q20A-REAP-FAIL:' + failure);
      });
      const mark = callMark();
      await expect(faulty.close()).resolves.toBeUndefined();
      expect(fault.seq(CLOSE, mark), failure).toEqual(CLOSE);
      for (const name of CLOSE) expect(fault.count(name, mark), name).toBe(1);
    }
  }, 60000);

  it('了结全部权限卡之后、没有 await 就逐个 stopRun（先看取消才落得下 [已取消]）；单个会话停失败不拖垮 Promise.all', async () => {
    // 两个run的中止同步发生在权限收口之后，第一条中止抛错也必须继续等第二条。
    const w = await watchCurrentEngine();
    const e = await engine();
    const a = await pendingRun(w, e);
    const b = await pendingRun(w, e);
    const { yieldProbe } = await import('./engine-trace');
    // stopRun自身还会了结一次卡片；单看最后一次settle→abort会漏掉全体收口后的让步。
    const entryGaps = yieldProbe(w.spy('broker.settleWhere'), w.spy('inputQueue.holdSession'));
    const gaps = yieldProbe(w.spy('broker.settleWhere'), w.spy('abort'));
    const abort = w.spy('abort').getMockImplementation()!;
    w.spy('abort').mockImplementationOnce(function(this: unknown, ...args: unknown[]) {
      abort.apply(this, args);
      throw new Error('Q20A-FIRST-STOP-FAIL');
    });
    const from = callMark();
    const closing = e.handle.close();
    await until('两个中止都已发起', () => w.count('abort', from) === 2);
    expect(w.seq(['broker.settleWhere', 'abort'], from)).toEqual(['broker.settleWhere', 'broker.settleWhere', 'abort', 'broker.settleWhere', 'abort']);
    expect(w.seq(['broker.settleWhere', 'inputQueue.holdSession', 'abort'], from)).toEqual([
      'broker.settleWhere', 'inputQueue.holdSession', 'broker.settleWhere', 'abort',
      'inputQueue.holdSession', 'broker.settleWhere', 'abort',
    ]);
    expect(entryGaps).toEqual([false, false]);
    expect(gaps).toEqual([false, false]);
    expect(w.count('terminals.disposeAll', from)).toBe(0);
    expect(w.count('db.close', from)).toBe(0);
    a.release();
    b.release();
    await expect(Promise.all([a.result, b.result, closing])).resolves.toHaveLength(3);
    expect(w.count('run.end', from)).toBe(2);
    expect(w.spy('inputQueue.holdSession').mock.calls.filter((_, i) => w.spy('inputQueue.holdSession').mock.invocationCallOrder[i] > from)).toEqual([[a.sid, 'shutdown'], [b.sid, 'shutdown']]);
    expect(w.spy('abort').mock.calls.filter((_, i) => w.spy('abort').mock.invocationCallOrder[i] > from)).toEqual([['shutdown'], ['shutdown']]);
    for (const args of w.spy('broker.settleWhere').mock.calls.filter((_, i) => w.spy('broker.settleWhere').mock.invocationCallOrder[i] > from)) expect(args[1]).toEqual({ reason: 'cancelled', cause: 'shutdown' });
    expect(w.count('db.close', from)).toBe(1);
  }, 60000);
});
