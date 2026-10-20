/**
 * Q20：真实引擎的接线观察台（辅助，不是测试）。
 *
 * 以前「引擎装配得对不对」靠读 src/minisd/index.ts 的文本认调用形态（某个构造写没写、实参长什么样、谁在谁前面）。
 * 这里换成：照常 startMinisd，同时观察引擎装配时真的构造了什么、把什么交给了谁、各步的先后——
 *  - 构造（new X）记在 'new X' 名下，实参在 spy.mock.calls，造出来的实例在 instanceOf('new X')；
 *  - 工厂函数（createXxx、recoverOnBoot…）记在自己的名字下；
 *  - 启动与关停涉及的方法记在 '对象.方法' 名下。
 * 引擎交给各部件的回调（isSessionDeleted、onRevoked、processNote…）就是构造 / 工厂的实参：测试把它们取出来直接调，
 * 核对的是引擎真正接上的那一个，而不是源码里某一行的写法。装配代码搬到哪个文件、拆成几个模块都不影响这里；
 * 它依赖的是各部件自己的类名与方法名。
 *
 * 用法：
 *   const w = watchEngine();                 // 先装观察，再起引擎
 *   const srv = await startMinisd({ … });
 *   expect(w.seq(['chat.repairLifecycle', 'new RunLedger', 'recoverOnBoot', 'rpc.listen'])).toEqual([…]);
 *   afterEach(() => vi.restoreAllMocks());
 */
import { vi } from 'vitest';
import * as cronStoreNs from '../src/minisd/cron/store';
import * as parentWatchNs from '../src/minisd/proc/parent-watch';
import * as dbNs from '../src/minisd/store/db';
import * as lockNs from '../src/minisd/store/data-root-lock';
import * as chatStoreNs from '../src/minisd/store/chat-store';
import * as auditNs from '../src/minisd/store/audit';
import * as runLedgerNs from '../src/minisd/store/run-ledger';
import * as procLedgerNs from '../src/minisd/store/proc-ledger';
import * as inputQueueNs from '../src/minisd/store/input-queue';
import * as providerStoreNs from '../src/minisd/store/provider-store';
import * as checkpointStoreNs from '../src/minisd/checkpoints/store';
import * as checkpointRestoreNs from '../src/minisd/checkpoints/restore';
import * as eventLogNs from '../src/minisd/rpc/event-log';
import * as liveTailsNs from '../src/minisd/agent/live-tails';
import * as rpcServerNs from '../src/minisd/rpc/server';
import * as procOwnedNs from '../src/minisd/proc/owned';
import * as recoveryNs from '../src/minisd/agent/run-recovery';
import * as loopNs from '../src/minisd/agent/loop';
import * as systemPromptNs from '../src/minisd/agent/system-prompt';
import * as syncNs from '../src/minisd/sync';
import * as stateAttachNs from '../src/minisd/state-attach';
import * as terminalNs from '../src/minisd/terminal';
import * as shellNs from '../src/minisd/tools/shell';
import * as schedulerNs from '../src/minisd/tools/scheduler';
import * as permissionsNs from '../src/minisd/tools/permissions';
import * as brokerNs from '../src/minisd/tools/permission-broker';
import * as mcpManagerNs from '../src/minisd/mcp/manager';
import * as bridgeServerNs from '../src/minisd/bridge/server';
import { callMark, onCall, onReturn, onPromiseSettled, recorder, sequence, watch, watchNew, type Watched } from './engine-trace';
import * as marketNs from '../src/minisd/market/install';
import * as toolRegistryNs from '../src/minisd/tools/registry';
import * as skillStoreNs from '../src/minisd/skills/store';
import fsNs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as mcpStdioNs from '../src/minisd/mcp/stdio';

/** 各部件的类，模块加载时就取下来：watchNew 之后命名空间上的导出换成了 spy，它的 prototype 不是实例用的那一个。 */
const Classes = {
  ToolRegistry: toolRegistryNs.ToolRegistry, SkillStore: skillStoreNs.SkillStore,
  AuditLogger: auditNs.AuditLogger, DataRootLock: lockNs.DataRootLock, ChatStore: chatStoreNs.ChatStore, RunLedger: runLedgerNs.RunLedger, ProcLedger: procLedgerNs.ProcLedger,
  InputQueueStore: inputQueueNs.InputQueueStore, CheckpointStore: checkpointStoreNs.CheckpointStore, EventLog: eventLogNs.EventLog,
  RpcServer: rpcServerNs.RpcServer, ProcSupervisor: procOwnedNs.ProcSupervisor, SyncCoordinator: syncNs.SyncCoordinator,
  TerminalManager: terminalNs.TerminalManager, ShellManager: shellNs.ShellManager, McpManager: mcpManagerNs.McpManager,
  PermissionGatewayImpl: permissionsNs.PermissionGatewayImpl, PermissionBroker: brokerNs.PermissionBroker, BridgeServer: bridgeServerNs.BridgeServer,
  LiveTails: liveTailsNs.LiveTails, KeyringVault: providerStoreNs.KeyringVault, McpStdioClient: mcpStdioNs.McpStdioClient,
};

export interface EngineWatch {
  /** 全部观察点，按名字取。 */
  spies: Record<string, Watched>;
  /** 取一个观察点；名字写错当场报错。 */
  spy(name: string): Watched;
  /** 这些观察点的调用按发生先后排成的名字序列；after 是 callMark() 取的序号（只看它之后的）。 */
  seq(names: readonly string[], after?: number): string[];
  /** 某个 'new X' / 工厂观察点第 n 次（缺省最后一次）的返回值：构造出来的实例，或工厂的产物。 */
  made<T = any>(name: string, nth?: number): T;
  /** 某个观察点第 n 次（缺省最后一次）调用的实参。 */
  args<T extends unknown[] = any[]>(name: string, nth?: number): T;
  /** 某个观察点被调用的次数；after 同 seq。 */
  count(name: string, after?: number): number;
}

/** 装上全部观察点。之后在本测试文件的 worker 里起的引擎都被观察；测试结束用 vi.restoreAllMocks() 摘掉。 */
export function watchEngine(dataRoot?: string): EngineWatch {
  const spies: Record<string, Watched> = {};
  spies['timers.setTimeout'] = watch(globalThis, 'setTimeout');
  spies['parent.watch'] = watch(parentWatchNs, 'watchParent');
  spies['stdio.mute'] = watch(parentWatchNs, 'muteBrokenStdio');
  spies['new CronStore'] = watchNew(cronStoreNs, 'CronStore');
  spies['new AuditLogger'] = watchNew(auditNs, 'AuditLogger');
  const proto = <T extends object>(name: string, cls: { prototype: T }, method: keyof T & string): void => { spies[name] = watch(cls.prototype, method); };

  // 可指定临时数据根，只记录对根本身的 mkdir（子目录初始化不混进外壳次序）。
  const rootMkdir = recorder();
  spies['root.mkdir'] = rootMkdir;
  if (dataRoot !== undefined) {
    // Node的ESM命名空间不可改：观察可变的默认fs导出，再同步命名导出。
    const mkdir = watch(fsNs, 'mkdirSync');
    spies['fs.mkdir'] = mkdir;
    syncBuiltinESMExports();
    onCall(mkdir, (self, args) => {
      if (args[0] === dataRoot) rootMkdir.apply(self, args);
    });
  }
  spies['abort'] = watch(AbortController.prototype, 'abort');
  // 数据根锁与库
  spies['lock.acquire'] = watch(lockNs, 'acquireDataRootLock');
  proto('lock.release', Classes.DataRootLock, 'release');
  // 库的 close 按实例观察（测试自己另开的只读连接不算）：引擎每开一次库，'db.close' 就指向那个实例的 close
  const openDb = dbNs.openDb;
  spies['db.open'] = vi.spyOn(dbNs, 'openDb').mockImplementation((...a: Parameters<typeof openDb>) => {
    const db = openDb(...a);
    spies['db.close'] = watch(db, 'close');
    return db;
  }) as unknown as Watched;

  // 存储层
  spies['new ChatStore'] = watchNew(chatStoreNs, 'ChatStore');
  proto('audit.append', Classes.AuditLogger, 'append');
  proto('chat.repairLifecycle', Classes.ChatStore, 'repairLifecycle');
  proto('chat.compactTombstones', Classes.ChatStore, 'compactTombstones');
  proto('chat.deleteSession', Classes.ChatStore, 'deleteSession');
  proto('chat.applyTombstone', Classes.ChatStore, 'applyTombstone');
  proto('chat.getLifecycle', Classes.ChatStore, 'getLifecycle');
  proto('chat.getSession', Classes.ChatStore, 'getSession');
  proto('chat.isDeleted', Classes.ChatStore, 'isDeleted');
  proto('chat.appendMessage', Classes.ChatStore, 'appendMessage');
  spies['new RunLedger'] = watchNew(runLedgerNs, 'RunLedger');
  proto('ledger.findByPrompt', Classes.RunLedger, 'findByPrompt');
  proto('ledger.snapshot', Classes.RunLedger, 'snapshot');
  proto('ledger.beginRun', Classes.RunLedger, 'beginRun');
  // 每个 run 的句柄（beginRun 的返回值）上：落 user 消息并进 running 记在 'run.started'，落终态记在 'run.end'（实参：run 的 ref、终态）
  const runStarted = recorder();
  const runEnd = recorder();
  const runEnded = recorder();
  spies['run.started'] = runStarted;
  spies['run.end'] = runEnd;
  // end 返回时同步落库已经完成；重试可能随后清掉行，故另留一个确定的收尾信号。
  spies['run.ended'] = runEnded;
  onReturn(spies['ledger.beginRun'], result => {
    const handle = result as { ref: unknown; started(append: () => unknown): unknown; end(e: unknown): void };
    const started = handle.started.bind(handle);
    const end = handle.end.bind(handle);
    handle.started = append => { runStarted(handle.ref); return started(append); };
    handle.end = e => {
      runEnd(handle.ref, e);
      end(e);
      runEnded(handle.ref, e);
    };
  });
  proto('ledger.startHeartbeat', Classes.RunLedger, 'startHeartbeat');
  proto('ledger.stopHeartbeat', Classes.RunLedger, 'stopHeartbeat');
  proto('ledger.close', Classes.RunLedger, 'close');
  spies['new ProcLedger'] = watchNew(procLedgerNs, 'ProcLedger');
  proto('procLedger.closeOrphans', Classes.ProcLedger, 'closeOrphans');
  proto('procLedger.orphanNote', Classes.ProcLedger, 'orphanNote');
  proto('procLedger.snapshot', Classes.ProcLedger, 'snapshot');
  proto('procLedger.close', Classes.ProcLedger, 'close');
  proto('inputQueue.close', Classes.InputQueueStore, 'close');
  proto('inputQueue.holdSession', Classes.InputQueueStore, 'holdSession');
  spies['new KeyringVault'] = watchNew(providerStoreNs, 'KeyringVault');
  proto('keyring.get', Classes.KeyringVault, 'get');
  proto('keyring.set', Classes.KeyringVault, 'set');
  proto('keyring.delete', Classes.KeyringVault, 'delete');
  proto('keyring.entry', Classes.KeyringVault as any, 'entry');

  // 检查点
  spies['new CheckpointStore'] = watchNew(checkpointStoreNs, 'CheckpointStore');
  proto('checkpoints.markSinceEpoch', Classes.CheckpointStore, 'markSinceEpoch');
  proto('checkpoints.reconcile', Classes.CheckpointStore, 'reconcile');
  proto('checkpoints.effectEvidence', Classes.CheckpointStore, 'effectEvidence');
  proto('checkpoints.gc', Classes.CheckpointStore, 'gc');
  const sweep = recorder();
  spies['checkpoints.sweep'] = sweep;
  onCall(spies['checkpoints.gc'], (self, args) => { if ((args[0] as { sweep?: boolean } | undefined)?.sweep === true) sweep.call(self, ...args); });
  spies['new CheckpointService'] = watchNew(checkpointRestoreNs, 'CheckpointService');

  // 事件、RPC、进程托管、恢复、循环
  spies['new EventLog'] = watchNew(eventLogNs, 'EventLog');
  proto('events.append', Classes.EventLog, 'append');
  proto('events.redactSession', Classes.EventLog, 'redactSession');
  proto('tails.observe', Classes.LiveTails, 'observe');
  spies['new LiveTails'] = watchNew(liveTailsNs, 'LiveTails');
  proto('rpc.listen', Classes.RpcServer, 'listen');
  proto('rpc.broadcast', Classes.RpcServer, 'broadcast');
  proto('rpc.close', Classes.RpcServer, 'close');
  spies['new ProcSupervisor'] = watchNew(procOwnedNs, 'ProcSupervisor');
  proto('supervisor.bind', Classes.ProcSupervisor, 'bind');
  // status 是 getter：记录真正访问它的实例、次数和返回值。
  spies['supervisor.status'] = vi.spyOn(Classes.ProcSupervisor.prototype, 'status', 'get') as unknown as Watched;
  spies.recoverOnBoot = watch(recoveryNs, 'recoverOnBoot');
  spies.settleOpenBatches = watch(recoveryNs, 'settleOpenBatches');
  spies.runAgentLoop = watch(loopNs, 'runAgentLoop');
  spies.createStableCache = watch(systemPromptNs, 'createStableCache');
  onReturn(spies.createStableCache, cache => { spies['stable.invalidate'] = watch(cache as { invalidate(s: string): void }, 'invalidate'); });

  // 同步、附件、快照
  spies['new SyncCoordinator'] = watchNew(syncNs, 'SyncCoordinator');
  proto('sync.setPaused', Classes.SyncCoordinator, 'setPaused');
  proto('sync.start', Classes.SyncCoordinator, 'start');
  proto('sync.onDirty', Classes.SyncCoordinator, 'onDirty');
  proto('sync.stop', Classes.SyncCoordinator, 'stop');
  spies.createSyncMethods = watch(syncNs, 'createSyncMethods');
  spies.createAttachmentSync = watch(syncNs, 'createAttachmentSync');
  // 每台引擎的实际附件端口；不是测试自己造的同步对象。
  onReturn(spies.createAttachmentSync, result => {
    const attachment = result as { port: { markDirty(sid: string): void; stop(): void }; onPeerHello(fp: string | undefined, peer: unknown): void };
    spies['attachments.markDirty'] = watch(attachment.port, 'markDirty');
    spies['attachments.stop'] = watch(attachment.port, 'stop');
    spies['attachments.onPeerHello'] = watch(attachment, 'onPeerHello');
  });
  spies.createAttachHandler = watch(stateAttachNs, 'createAttachHandler');
  spies.createOutcomesHandler = watch(stateAttachNs, 'createOutcomesHandler');

  // 子进程的三种入口、调度器、权限
  spies['new TerminalManager'] = watchNew(terminalNs, 'TerminalManager');
  proto('terminals.dispose', Classes.TerminalManager, 'dispose');
  proto('terminals.disposeAll', Classes.TerminalManager, 'disposeAll');
  spies['new ShellManager'] = watchNew(shellNs, 'ShellManager');
  proto('shells.dispose', Classes.ShellManager, 'dispose');
  proto('shells.disposeAll', Classes.ShellManager, 'disposeAll');
  spies['new McpManager'] = watchNew(mcpManagerNs, 'McpManager');
  proto('mcp.ensureForRun', Classes.McpManager, 'ensureForRun');
  proto('mcp.disposeAll', Classes.McpManager, 'disposeAll');
  spies['new McpStdioClient'] = watchNew(mcpStdioNs, 'McpStdioClient');
  proto('mcpStdio.dispose', Classes.McpStdioClient, 'dispose');
  spies['new ToolScheduler'] = watchNew(schedulerNs, 'ToolScheduler');
  spies['new PermissionGatewayImpl'] = watchNew(permissionsNs, 'PermissionGatewayImpl');
  proto('gateway.applyPreset', Classes.PermissionGatewayImpl, 'applyPreset');
  proto('gateway.resetUnanswered', Classes.PermissionGatewayImpl, 'resetUnanswered');
  proto('gateway.revokeBridgeSession', Classes.PermissionGatewayImpl, 'revokeBridgeSession');
  proto('gateway.revokeBridgeOnce', Classes.PermissionGatewayImpl, 'revokeBridgeOnce');
  spies['new PermissionBroker'] = watchNew(brokerNs, 'PermissionBroker');
  proto('broker.settleWhere', Classes.PermissionBroker, 'settleWhere');
  proto('broker.respond', Classes.PermissionBroker, 'respond');
  proto('rpc.lastConnSeq', Classes.RpcServer, 'lastConnSeq');
  spies['new ToolRegistry'] = watchNew(toolRegistryNs, 'ToolRegistry');
  proto('tools.register', Classes.ToolRegistry, 'register');
  proto('skills.setSessionOverride', Classes.SkillStore, 'setSessionOverride');
  spies['new SkillStore'] = watchNew(skillStoreNs, 'SkillStore');
  spies['new MarketInstaller'] = watchNew(marketNs, 'MarketInstaller');
  proto('mcp.forget', Classes.McpManager, 'forget');
  proto('mcp.mkExecutor', Classes.McpManager as any, 'mkExecutor');
  proto('bridge.close', Classes.BridgeServer, 'close');

  const spy = (name: string): Watched => {
    const s = spies[name];
    if (!s) throw new Error(`engine-wiring：没有名叫 ${name} 的观察点`);
    return s;
  };
  const pickIndex = (s: Watched, nth: number | undefined, name: string): number => {
    const n = nth ?? s.mock.calls.length - 1;
    if (n < 0 || n >= s.mock.calls.length) throw new Error(`engine-wiring：${name} 没有第 ${n + 1} 次调用（共 ${s.mock.calls.length} 次）`);
    return n;
  };
  return {
    spies, spy,
    seq: (names, after = 0) => sequence(Object.fromEntries(names.map(n => [n, spy(n)])), after),
    made: (name, nth) => { const s = spy(name); return s.mock.results[pickIndex(s, nth, name)].value; },
    args: (name, nth) => { const s = spy(name); return s.mock.calls[pickIndex(s, nth, name)] as never; },
    count: (name, after = 0) => spy(name).mock.invocationCallOrder.filter(at => at > after).length,
  };
}

export { callMark };

/** 通过引擎真正交给结果查询的 launchOf 回调取得这次起跑 Promise，记录它同步了结时的状态。 */
export function watchLaunch(w: EngineWatch, runId: string, snapshot: () => unknown): { spy: Watched; stop(): void } {
  const launch = w.args('createOutcomesHandler')[0].launchOf(runId) as Promise<unknown> | undefined;
  if (!(launch instanceof Promise)) throw new Error('watchLaunch: 起跑仍未挂起或该 run 不存在');
  const spy = recorder();
  const stop = onPromiseSettled(launch, () => { spy(snapshot()); });
  return { spy, stop };
}

/** 指定dataRoot装过fs观察后，在vi.restoreAllMocks之后同步还原命名导出。 */
export function restoreEngineBuiltins(): void {
  syncBuiltinESMExports();
}
