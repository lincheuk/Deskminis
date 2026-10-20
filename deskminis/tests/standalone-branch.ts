/**
 * Q20：在测试进程里把引擎的 standalone 分支真的跑一遍，并观察它做了什么（辅助，不是测试）。
 *
 * standalone 分支是引擎作为独立进程启动时走的那一段（DESKMINIS_STANDALONE=1：装崩溃钩子、写局域网提示、起引擎、
 * 接主进程的 shutdown 消息、挂属主轮询、交出握手行、启动失败时写致命行）。以前这一段只能靠读 src/minisd/index.ts 的文本
 * 认调用形态；真起一个子进程的用例（crash-log-fork、proc-lifecycle-process）看得到结果，看不到「谁先谁后、各调了几次」。
 *
 * 这里的做法：清掉模块缓存，设好环境变量，把会动到测试进程本身的几样换成只记录的替身
 * （崩溃钩子的安装、属主轮询、标准流静音、process.exit、致命行上报），再重新 import 引擎入口。
 * 分支里的每一句都真的执行：引擎真的在临时数据根上起来，shutdown 消息真的走 closeThenExit → close → exit。
 * 观察到的是执行的先后与次数，与这段代码写在哪个文件无关（入口模块仍是 src/minisd/index.ts）。
 *
 * 没有换掉的：startMinisd 本身、closeThenExit、lanExposureWarning、数据根锁、RPC 服务。
 * RPC 的监听地址换成回环（记下引擎本来要听的地址），免得测试在机器上对外开端口。
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi, type MockInstance } from 'vitest';
import { sequence, watch, type Watched } from './engine-trace';

export interface StandaloneRun {
  root: string;
  /** 各观察点按发生先后排成的名字序列。名字：crash.install、lan.warning、lock.acquire、parentPort.on、stdio.mute、
   *  parent.watch、rpc.listen、handshake、fatal.report、lock.release、exit。 */
  order(): string[];
  spies: Record<string, Watched>;
  /** 引擎本来要监听的地址（MINISD_HOST 传下来的；实际绑的是回环）。 */
  listenHosts(): unknown[];
  /** 写到 stderr 的局域网提示行。 */
  warnings: string[];
  /** 握手行解析出来的端口与 token（还没握手是 undefined）。 */
  handshake(): { minisdPort: number; authToken: string } | undefined;
  /** 以主进程的身份发一条 parentPort 消息。没有 parentPort 的运行里调它会抛。 */
  post(message: unknown): void;
  /** 等到握手行写出（或上报了启动失败）。 */
  settled(): Promise<void>;
  /** 等到分支调了 process.exit；返回退出码。 */
  exited(): Promise<number | undefined>;
  /** 收尾：引擎还开着就发 shutdown 并等它退出；还原环境变量、process.parentPort 与全部替身，删临时数据根。 */
  dispose(): Promise<void>;
}

export interface StandaloneOpts {
  /** MINISD_HOST；不给就不设。 */
  host?: string;
  /** 临时根内的日志目录名，用于证明不把数据根/logs写死。 */
  logDirName?: string;
  /** 给不给 process.parentPort（真实的 utilityProcess 才有）。缺省给。 */
  parentPort?: boolean;
  /** 起引擎之前先在同一个数据根上占住锁：引擎会以 DATA_ROOT_LOCKED 启动失败。 */
  lockHeld?: boolean;
  /** 另外要设的环境变量。 */
  env?: Record<string, string>;
  /** 测试阻住实际 RPC 关闭，验证关停完成之前不能退出。 */
  closeGate?: Promise<void>;
}

const ENV_KEYS = ['DESKMINIS_STANDALONE', 'DESKMINIS_TEST', 'DESKMINIS_E2E', 'DESKMINIS_DATA_DIR', 'DESKMINIS_LOG_DIR', 'MINISD_HOST'] as const;

export async function runStandaloneBranch(o: StandaloneOpts = {}): Promise<StandaloneRun> {
  // 安装函数已换成替身；测试可观察分支自己多挂的监听，收尾时仅移除本次新增的那几条。
  const crashEvents = ['uncaughtException', 'unhandledRejection'] as const;
  const crashListeners = new Map(crashEvents.map(event => [event, process.listeners(event)]));
  const root = mkdtempSync(join(tmpdir(), 'dm-standalone-branch-'));
  const savedEnv = new Map<string, string | undefined>();
  const setEnv = (k: string, v: string | undefined): void => {
    if (!savedEnv.has(k)) savedEnv.set(k, process.env[k]);
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  };
  for (const k of ENV_KEYS) setEnv(k, undefined);
  setEnv('DESKMINIS_STANDALONE', '1');
  setEnv('DESKMINIS_TEST', '1');
  setEnv('DESKMINIS_DATA_DIR', root);
  setEnv('DESKMINIS_LOG_DIR', join(root, o.logDirName ?? 'logs'));
  if (o.host !== undefined) setEnv('MINISD_HOST', o.host);
  for (const [k, v] of Object.entries(o.env ?? {})) setEnv(k, v);

  vi.resetModules();
  const spies: Record<string, Watched> = {};
  const restores: (() => void)[] = [];
  const stub = <T extends object>(name: string, target: T, method: keyof T & string, impl: (...a: any[]) => unknown): void => {
    const s = vi.spyOn(target as never, method as never).mockImplementation(impl as never) as unknown as MockInstance;
    spies[name] = s as unknown as Watched;
    restores.push(() => s.mockRestore());
  };
  const observe = <T extends object>(name: string, target: T, method: keyof T & string): void => {
    spies[name] = watch(target, method);
    restores.push(() => spies[name].mockRestore());
  };

  // 清过缓存之后再 import：拿到的是分支接下来会用的那一份模块
  const crash = await import('../src/minisd/diag/crash-hooks');
  const parentWatch = await import('../src/minisd/proc/parent-watch');
  const fatal = await import('../src/minisd/fatal');
  const lockMod = await import('../src/minisd/store/data-root-lock');
  const rpcServer = await import('../src/minisd/rpc/server');
  const sync = await import('../src/minisd/sync');
  observe('sync.stop', sync.SyncCoordinator.prototype, 'stop');
  const rpcClose = rpcServer.RpcServer.prototype.close;
  stub('rpc.close', rpcServer.RpcServer.prototype, 'close', async function (this: unknown) {
    if (o.closeGate) await o.closeGate;
    return rpcClose.call(this as never);
  });
  stub('crash.install', crash, 'installMinisdCrashHandlers', () => undefined);
  stub('stdio.mute', parentWatch, 'muteBrokenStdio', () => undefined);
  stub('parent.watch', parentWatch, 'watchParent', () => ({ stop: () => undefined }));
  let settle!: () => void;
  const settledP = new Promise<void>(r => { settle = r; });
  stub('fatal.report', fatal, 'reportStartupFailure', () => { settle(); });
  observe('lock.acquire', lockMod, 'acquireDataRootLock');
  observe('lock.release', lockMod.DataRootLock.prototype, 'release');
  const listenHosts: unknown[] = [];
  const listen = rpcServer.RpcServer.prototype.listen;
  stub('rpc.listen', rpcServer.RpcServer.prototype, 'listen', function (this: unknown, host: string, port: number) {
    listenHosts.push(host);
    return listen.call(this as never, '127.0.0.1', port);
  });

  // 预先占锁（用的是同一份锁模块；占锁这一次不算进观察）
  let held: { release(): void } | undefined;
  if (o.lockHeld) { held = lockMod.acquireDataRootLock(root); spies['lock.acquire'].mockClear(); }

  let exit!: (code: number | undefined) => void;
  const exitedP = new Promise<number | undefined>(r => { exit = r; });
  stub('exit', process, 'exit', (code?: number) => { exit(code); return undefined as never; });

  const warnings: string[] = [];
  let shake: { minisdPort: number; authToken: string } | undefined;
  spies['lan.warning'] = vi.fn() as unknown as Watched;
  spies.handshake = vi.fn() as unknown as Watched;
  const errWrite = process.stderr.write.bind(process.stderr);
  stub('stderr.write', process.stderr, 'write', (chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === 'string' && chunk.includes('MINISD_HOST=')) { warnings.push(chunk); (spies['lan.warning'] as unknown as () => void)(); return true; }
    return (errWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  });
  const outWrite = process.stdout.write.bind(process.stdout);
  stub('stdout.write', process.stdout, 'write', (chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === 'string' && chunk.includes('"minisdPort"')) {
      shake = JSON.parse(chunk.trim()) as { minisdPort: number; authToken: string };
      (spies.handshake as unknown as () => void)();
      settle();
      return true;
    }
    return (outWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  });

  const hadParentPort = Object.getOwnPropertyDescriptor(process, 'parentPort');
  let port: EventEmitter | undefined;
  if (o.parentPort !== false) {
    port = new EventEmitter();
    spies['parentPort.on'] = watch(port as unknown as { on: (...a: unknown[]) => unknown }, 'on');
    spies['parentPort.emit'] = watch(port, 'emit');
    Object.defineProperty(process, 'parentPort', { value: port, configurable: true, writable: true });
  } else {
    spies['parentPort.on'] = vi.fn() as unknown as Watched;
    spies['parentPort.emit'] = vi.fn() as unknown as Watched;
    Object.defineProperty(process, 'parentPort', { value: undefined, configurable: true, writable: true });
  }

  // 分支在入口模块求值时执行
  await import('../src/minisd/index');

  const names = ['crash.install', 'lan.warning', 'lock.acquire', 'parentPort.on', 'stdio.mute', 'parent.watch', 'rpc.listen', 'handshake', 'fatal.report', 'sync.stop', 'rpc.close', 'lock.release', 'exit'];
  let disposed = false;
  const run: StandaloneRun = {
    root, spies, warnings,
    order: () => sequence(Object.fromEntries(names.map(n => [n, spies[n]]))),
    listenHosts: () => [...listenHosts],
    handshake: () => shake,
    post: message => {
      if (!port) throw new Error('这次运行没有 parentPort');
      port.emit('message', { data: message });
    },
    settled: () => settledP,
    exited: () => exitedP,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try {
        await Promise.race([settledP, new Promise<void>(r => setTimeout(r, 20_000))]);
        if (shake && spies.exit.mock.calls.length === 0) {
          // 引擎还开着：有 parentPort 就照主进程的做法发 shutdown；没有的话直接借 closeThenExit 之外的路关不了，只能留给进程结束
          if (port) { port.emit('message', { data: { type: 'shutdown' } }); await Promise.race([exitedP, new Promise<void>(r => setTimeout(r, 20_000))]); }
        }
      } finally {
        try { held?.release(); } catch { /* 已放 */ }
        for (const event of crashEvents) {
          for (const listener of process.listeners(event)) {
            if (!crashListeners.get(event)!.includes(listener)) process.removeListener(event, listener);
          }
        }
        for (const r of restores.reverse()) { try { r(); } catch { /* 尽力 */ } }
        if (hadParentPort) Object.defineProperty(process, 'parentPort', hadParentPort); else delete (process as unknown as Record<string, unknown>).parentPort;
        for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
        vi.resetModules();
        try { rmSync(root, { recursive: true, force: true }); } catch { /* 被占用时留给系统清 */ }
      }
    },
  };
  return run;
}
