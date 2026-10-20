/**
 * F06 W 组：源码守卫（先剥注释）。
 *
 * 行为由 state-sync-minisd / state-sync-outcomes / renderer-* 的用例钉；这里防的是合并或重构时把几处「形态本身就是保证」的
 * 写法冲掉：state.attach 必须是同步函数、广播只有一个入序点、两个新方法受业务守卫保护、chat.prompt / chat.cancel 不碰入序机制。
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripComments } from './strip-comments';
import { RpcServer } from '../src/minisd/rpc/server';
import { accessResult, probeConnection, startCapturedEngine, type CapturedEngine } from './engine-assembly';
import { watchEngine, type EngineWatch } from './engine-wiring';
import { allLifecycleEvents, callMark, onCall } from './engine-trace';
import { expectSame } from './engine-trace';


// 渲染端RPC只记录调用，恢复钩子由真实store在init中交出。
const probe = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn(), handlers: new Map<string, (p: any) => unknown>(), lost: vi.fn(), connect: vi.fn(async () => {}), resync: vi.fn(), box: {} as { hooks?: import('../src/renderer/src/rpc').RecoveryHooks } }));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: probe.call, on: probe.on.mockImplementation((m: string, h: (p: any) => unknown) => probe.handlers.set(m, h)), onLost: probe.lost, connect: probe.connect, resync: probe.resync, enableRecovery: (hooks: import('../src/renderer/src/rpc').RecoveryHooks) => { probe.box.hooks = hooks; } } }));
import { readSourceSet } from './source-set';
import { checkPermissionEntrances, checkRecoveryNoWrites } from './renderer-store-recovery';
afterEach(() => vi.useRealTimers());

const root = join(__dirname, '..', 'src');
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8');
const code = (rel: string): string => stripComments(read(rel));
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out); else if (/\.(ts|mjs)$/.test(name)) out.push(abs);
  }
  return out;
};
const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

describe('F06 W 组：引擎侧', () => {
  const attach = code('minisd/state-attach.ts');

  // Q20：装配那一半不再读 src/minisd/index.ts 的文本，起一台真实引擎看它装配出来的东西（engine-wiring.ts / engine-assembly.ts）。
  // 三条用例共用这一台：W1 调装配后的 state.attach，W4 跑一个回合、停一个回合、删一个会话，W3 最后取消配对。
  let w: EngineWatch;
  let eng: CapturedEngine;
  const local = probeConnection('local');
  const RETENTION = { maxEvents: 4321, maxChars: 765_432 };
  /** 入序（EventLog.append）发生时在不在一次 RpcServer.broadcast 里面；不在的记下方法名。 */
  const appendedOutsideBroadcast: string[] = [];
  let appended = 0;
  /** 测试自己直接调入序回调（不经事件日志）的次数。 */
  let observedDirectly = 0;
  const savedFake = process.env.DESKMINIS_FAKE_PROVIDER;
  beforeEach(async () => {
    appendedOutsideBroadcast.length = 0;
    appended = 0;
    observedDirectly = 0;
    process.env.DESKMINIS_FAKE_PROVIDER = '1';
    const broadcast = RpcServer.prototype.broadcast; // 先取原实现，再装观察
    w = watchEngine();
    let broadcasting = 0;
    w.spy('rpc.broadcast').mockImplementation(function (this: RpcServer, method: string, params: unknown) {
      broadcasting++;
      try { return broadcast.call(this, method, params); } finally { broadcasting--; }
    });
    onCall(w.spy('events.append'), (_self, args) => { appended++; if (broadcasting === 0) appendedOutsideBroadcast.push(String(args[0])); });
    eng = await startCapturedEngine({ eventRetention: RETENTION, permTimeoutMs: 60_000 });
  }, 60_000);
  afterEach(async () => {
    await eng?.close();
    vi.restoreAllMocks();
    if (savedFake === undefined) delete process.env.DESKMINIS_FAKE_PROVIDER; else process.env.DESKMINIS_FAKE_PROVIDER = savedFake;
  });
  const broadcasts = (method: string): any[] => w.spy('rpc.broadcast').mock.calls.filter(c => c[0] === method).map(c => c[1]);
  const runEvents = (sid: string): any[] => broadcasts('chat.event').filter(p => p.sessionId === sid && p.event !== undefined);
  async function until(what: string, cond: () => boolean, capMs = 20_000): Promise<void> {
    const deadline = Date.now() + capMs;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`等待超时: ${what}`);
      await new Promise(r => setTimeout(r, 15));
    }
  }

  it('W1 state.attach 是同步的：createAttachHandler 的函数体里没有 await / async；index.ts 里它的值也不是 async', () => {
    // 装配后的 state.attach（外面包着业务守卫）当场交出结果，不是 Promise：lastSeq 与状态在同一段同步代码里取
    const answered = eng.methods['state.attach']({}, local) as { mode?: string; lastSeq?: number; then?: unknown };
    expect(answered).not.toBeInstanceOf(Promise);
    expect(answered.then).toBeUndefined();
    expect(answered.mode).toBe('snapshot');
    expect(typeof answered.lastSeq).toBe('number');
    const body = attach.slice(attach.indexOf('export function createAttachHandler'), attach.indexOf('export interface OutcomesDeps'));
    expect(body.length).toBeGreaterThan(500);
    expect(body).not.toMatch(/\bawait\b/);
    expect(body).not.toMatch(/\basync\b/);
    expect(body).not.toMatch(/\.then\(/);
    // 返回类型是 AttachResult 本身，不是 Promise
    expect(body).toMatch(/\): \(p: AttachParams \| undefined, conn\?: RpcConnection\) => AttachResult \{/);
    // lastSeq 在取任何状态之前读
    const h = body.slice(body.indexOf('return (p, conn) => {'));
    const iSeq = h.indexOf('log.lastSeq');
    expect(iSeq).toBeGreaterThan(0);
    for (const later of ['deps.ledger.snapshot(', 'deps.broker.deliver(', 'deps.tails.list()', 'deps.chat.listSessions()', 'deps.revision()']) {
      expect(h.indexOf(later), later).toBeGreaterThan(iSeq);
    }
  }, 60000);

  it('W2 引擎里拼通知帧（jsonrpc 加 method、没有 id）的地方只有 rpc/server.ts 与 rpc/event-log.ts（mcp/ 是对外的另一套协议，不算）', () => {
    const minisd = join(root, 'minisd');
    const hits: string[] = [];
    for (const f of walk(minisd)) {
      const rel = relative(minisd, f).replace(/\\/g, '/');
      if (rel.startsWith('mcp/')) continue;
      if (/jsonrpc: '2\.0',\s*method\b/.test(stripComments(readFileSync(f, 'utf8')))) hits.push(rel);
    }
    expect(hits.sort()).toEqual(['rpc/event-log.ts', 'rpc/server.ts']);
    // broadcast 的第一句经 events 入序
    const server = code('minisd/rpc/server.ts');
    expect(server).toMatch(/broadcast\(method: string, params: unknown\): void \{\s*const frame = this\.opts\.events\?\.append\(method, params\) \?\? JSON\.stringify\(\{ jsonrpc: '2\.0', method, params \}\);/);
    // 入序：先成帧（可能抛）再推进序号
    const log = code('minisd/rpc/event-log.ts');
    const append = log.slice(log.indexOf('append(method: string, params: unknown)'), log.indexOf('since(afterSeq: number'));
    expect(append.indexOf('JSON.stringify(')).toBeGreaterThan(0);
    expect(append.indexOf('this.seq = seq;')).toBeGreaterThan(append.indexOf('JSON.stringify('));
    expect(append.indexOf('this.onAppend(method, params, seq)')).toBeGreaterThan(append.indexOf('this.seq = seq;'));
    expect(append.indexOf('this.items.push(')).toBeGreaterThan(append.indexOf('this.onAppend(method, params, seq)'));
  });

  it('W3 实际装配的两个新方法拒 pairing、复查配对；RpcServer 构造时带 events', async () => {
    const fp = await eng.pair();
    for (const name of ['state.attach', 'state.outcomes']) {
      expect(eng.methods[name], name).toBeTypeOf('function');
      expect(await accessResult(eng.methods[name], name, probeConnection('local'))).toEqual({ allowed: true });
      expect(await accessResult(eng.methods[name], name, probeConnection('remote', undefined, fp))).toEqual({ allowed: true });
      expect(await accessResult(eng.methods[name], name, probeConnection('pairing'))).toEqual({ allowed: false, error: `${name} 在 pairing 模式下不可用（配对期仅可调 remote.pair.complete）` });
    }
    await eng.unpair(fp);
    for (const name of ['state.attach', 'state.outcomes']) {
      let closed = false;
      expect(await accessResult(eng.methods[name], name, probeConnection('remote', () => { closed = true; }, fp))).toEqual({ allowed: false, error: `${name} 被拒：这台设备已取消配对` });
      expect(closed).toBe(true);
    }
    // RpcServer 构造时带的 events 就是引擎建的那个事件日志：代次取账本的，保留窗口取启动参数，入序时把同一帧交给尾巴
    const made = w.args('new EventLog')[0] as { epoch: number; maxEvents?: number; maxChars?: number; onAppend(m: string, p: unknown, seq: number): void };
    expect(eng.events).toBe(w.made('new EventLog'));
    expect(made.epoch).toBe(w.made<{ epoch: number }>('new RunLedger').epoch);
    expect({ maxEvents: made.maxEvents, maxChars: made.maxChars }).toEqual(RETENTION);
    const frame = { sessionId: 'S', probe: 1 };
    const tails = w.made('new LiveTails');
    for (const [method, params, seq] of [['q20.probe', frame, 7], ['q20.boundary', null, 0]] as const) {
      const from = callMark();
      const result = made.onAppend(method, params, seq);
      observedDirectly++;
      expect(w.count('tails.observe', from)).toBe(1);
      const last = w.spy('tails.observe').mock.calls.at(-1)!;
      expect([last[0], last[1], last[2]]).toEqual([method, params, seq]);
      expectSame(last[1], params);
expectSame(w.spy('tails.observe').mock.contexts.at(-1), tails);
      expect(result).toBe(w.spy('tails.observe').mock.results.at(-1)?.value);
    }
  }, 60000);

  it('W4 写调用与关停不自行入序；emitRunEvent 仍经广播；生命周期钩子清除已删会话的保留帧', async () => {
    // 事件日志只建一个：RpcServer 拿到的、state.attach 读的是它；尾巴也只有一份，state.attach 读的同样是它
    expect(w.count('new EventLog')).toBe(1);
    expect(w.count('new LiveTails')).toBe(1);
    const log = w.made('new EventLog');
    expect(eng.events).toBe(log);
    expect(w.args('createAttachHandler')[0].log).toBe(log);
    expect(w.args('createAttachHandler')[0].tails).toBe(w.made('new LiveTails'));

    // 一个完整的回合：run 事件都经广播发出，带着这次运行的 id / 会话内第几次 / 引擎代次
    const done = (await eng.methods['chat.sessions.create']({}, local) as { id: string }).id;
    const started = await eng.methods['chat.prompt']({ sessionId: done, providerId: '__fake__', text: '你好', promptId: 'q20-w4-0001' }, local) as { runId: string; generation: number };
    await until('真实运行终态已提交', () => w.spy('run.ended').mock.calls.some(([ref]) => ref.sessionId === done));
    expect(runEvents(done).some(p => p.event.kind === 'turnEnd')).toBe(true);
    const epoch = w.made<{ epoch: number }>('new RunLedger').epoch;
    expect(runEvents(done).length).toBeGreaterThan(1);
    for (const p of runEvents(done)) expect(p.run, p.event.kind).toEqual({ id: started.runId, generation: started.generation, epoch });

    // 停一个挂在权限卡上的回合，再删掉它的会话
    const stopped = (await eng.methods['chat.sessions.create']({}, local) as { id: string }).id;
    const text = `__tool__ web_fetch ${JSON.stringify({ url: 'http://127.0.0.1:9/q20-w4', tool_title: '抓网页' })}`;
    await eng.methods['chat.prompt']({ sessionId: stopped, providerId: '__fake__', text }, local);
    await until('权限卡挂出', () => broadcasts('permission.request').some(p => p.req?.sessionId === stopped));
    await eng.methods['chat.cancel']({ sessionId: stopped }, local);
    await until('被停的真实运行终态已提交', () => w.spy('run.ended').mock.calls.some(([ref]) => ref.sessionId === stopped));
    expect(runEvents(stopped).some(p => p.event.kind === 'error' || p.event.kind === 'turnEnd')).toBe(true);
    expect(w.count('events.redactSession')).toBe(0);
    await eng.methods['chat.sessions.delete']({ sessionId: stopped, confirm: true }, local);
    // 生命周期钩子清掉这个会话留在窗口里的帧：恰好一次，清的就是被删的那个会话
    expect(w.spy('events.redactSession').mock.calls).toEqual([[stopped]]);

    // 提问、停止、删除这一路下来，入序只发生在 RpcServer.broadcast 里面：处理器自己不碰事件日志
    expect(appended).toBeGreaterThan(10);
    expect(appendedOutsideBroadcast).toEqual([]);
    // 尾巴只由事件日志在入序的同一步里喂：每入序一条，尾巴看到一条（直接调用回调的次数另算）
    expect(w.count('tails.observe')).toBe(appended + observedDirectly);
    // 完整生命周期集合：四种隐藏/清除事件各redact一次，其余三种零次。
    const chat = w.made('new ChatStore');
    for (const event of allLifecycleEvents('Q20A-REDACT', { v: 1, opId: 'Q20A-REDACT-OP', originDeviceId: 'Q20A-DEVICE', at: 0 })) {
      const mark = callMark();
      chat.onLifecycle(event);
      const clears = ['deleted', 'tombstone-applied', 'purged', 'retained-released'].includes(event.kind);
      expect(w.count('events.redactSession', mark), event.kind).toBe(clears ? 1 : 0);
      if (clears) {
        expect(w.args('events.redactSession')).toEqual([event.sessionId]);
        expectSame(w.spy('events.redactSession').mock.contexts.at(-1), log);
      }
    }
    expect(appendedOutsideBroadcast).toEqual([]);
    expect(w.count('tails.observe')).toBe(appended + observedDirectly);
    // 关停同样不自行入序
    await eng.close();
    expect(appendedOutsideBroadcast).toEqual([]);
    // state.outcomes 的处理器里没有任何写入：账本与 broker 只用到只读的那几个方法
    const outcomes = attach.slice(attach.indexOf('export function createOutcomesHandler'));
    expect(outcomes).not.toMatch(/\.respond\(|\.deliver\(|\.settleWhere\(|beginRun\(|\.prepare\(/);
    const calls = new Set((outcomes.match(/deps\.(ledger|broker)\.\w+/g) ?? []));
    expect([...calls].sort()).toEqual(['deps.broker.statusOf', 'deps.ledger.findApproval', 'deps.ledger.findByPrompt']);
  }, 60000);

  it('W4b broker：deliver 不了结任何卡；respond 的资格条件是「发卡时已连着，或被交付过」', () => {
    const broker = code('minisd/tools/permission-broker.ts');
    const deliver = broker.slice(broker.indexOf('deliver(to?: Responder): PendingPermissionView[] {'), broker.indexOf('statusOf(requestId: string)'));
    expect(deliver.length).toBeGreaterThan(300);
    expect(deliver).not.toMatch(/this\.settle\(|entry\.resolve\(|this\.entries\.delete\(|clearTimeout\(|broadcast\(/);
    expect(broker).toMatch(/const eligible = by\?\.seq !== undefined && \(by\.seq <= \(entry\.connSeqAtIssue \?\? -1\) \|\| entry\.delivered\.has\(by\.seq\)\);\s*if \(entry\.connSeqAtIssue !== undefined && !eligible\) \{/);
    // 登记只发生在 deliver 里
    expect(count(broker, /\.delivered\.add\(/g)).toBe(1);
    expect(deliver).toContain('entry.delivered.add(seq)');
  });
});

describe('F06 W 组：渲染端', () => {
  const rpcSrc = code('renderer/src/rpc.ts');
  const store = stripComments(readSourceSet(['src/renderer/src/stores']));
  /** .vue：模板剥 <!-- -->，脚本与样式剥注释。 */
  const vue = (rel: string): string => stripComments(read(rel).replace(/<!--[\s\S]*?-->/g, ''));

  it('W5 在途调用永不重发：pending 只在两处断线结算里被整体取出并清空；发帧只有两处（call 与 state.attach）；开闸只有一处；synced 只有一个调用点', () => {
    // 整体清空：没开恢复的 markLost、开了恢复的 settleInFlight，各一处；清空之后那些调用只被拒绝，不留请求帧
    expect(count(rpcSrc, /this\.pending\.clear\(\)/g)).toBe(2);
    const settle = rpcSrc.slice(rpcSrc.indexOf('private settleInFlight(): void {'), rpcSrc.indexOf('private failSyncs(): void {'));
    expect(settle).toMatch(/this\.pending\.clear\(\);/);
    expect(settle).toMatch(/settle\(\{ error: \{ message: LOST \}, \[IN_FLIGHT\]: true \}\)/);
    expect(settle).not.toMatch(/\.send\(/);
    // 整个文件里往套接字写帧的只有两处：用户调用（sendNow）与内部的 state.attach
    expect(count(rpcSrc, /\.send\(/g)).toBe(2);
    expect(rpcSrc).toMatch(/this\.ws!\.send\(JSON\.stringify\(\{ jsonrpc: '2\.0', id, method, params \}\)\);/);
    expect(rpcSrc).toMatch(/this\.ws!\.send\(JSON\.stringify\(\{ jsonrpc: '2\.0', id, method: 'state\.attach', params \}\)\);/);
    // 在途表只记方法与参数（用来交代）：断线时记入、同步完成时交出，没有第三处读它
    expect(count(rpcSrc, /this\.inDoubt\b/g)).toBe(2);
    // RpcClient 自己从不发起业务调用（没有任何内部路径走 call()）
    expect(count(rpcSrc, /this\.call\(/g)).toBe(0);
    expect(rpcSrc).toMatch(/const inDoubt = fresh \? this\.inDoubt\.splice\(0\) : \[\];/);
    // 闸：开只有一处，而且在 runSync 里、排在交付之前
    expect(count(rpcSrc, /this\.lost = false/g)).toBe(1);
    const runSync = rpcSrc.slice(rpcSrc.indexOf('private async runSync('), rpcSrc.indexOf('private attachOnce('));
    const iGate = runSync.indexOf('this.lost = false');
    expect(iGate).toBeGreaterThan(0);
    for (const later of ['rec.hooks.applySnapshot(', 'for (const f of out.replay) this.dispatch(f)', 'for (const f of out.after) this.dispatch(f)', 'rec.hooks.synced?.(']) {
      expect(runSync.indexOf(later), later).toBeGreaterThan(iGate);
    }
    // 从开闸到交付结束之间没有 await（用户操作插不进来）
    const deliver = runSync.slice(iGate, runSync.indexOf('if (!out.need) break;'));
    expect(deliver.length).toBeGreaterThan(300);
    expect(deliver).not.toMatch(/\bawait\b/);
    expect(count(rpcSrc, /hooks\.synced\?\.\(/g)).toBe(1);
  });

  it('W5b 每次重连都重新向主进程要端口与 token；套接字回调带自己的序号', () => {
    const attempt = rpcSrc.slice(rpcSrc.indexOf('private async attemptReconnect('), rpcSrc.indexOf('private within<T>('));
    expect(attempt).toMatch(/const info = await \(window as any\)\.deskminis\.minisdInfo\(\);/);
    expect(attempt).toMatch(/this\.openSocket\(urlOf\(info\?\.port, info\?\.token\)\)/);
    expect(attempt).toMatch(/info\?\.alive === false/);
    expect(rpcSrc).toMatch(/this\.ws\.onclose = \(\) => this\.onSocketClose\(no\);/);
    expect(rpcSrc).toMatch(/this\.ws\.onmessage = ev => this\.onSocketMessage\(no, ev\.data\);/);
    expect(rpcSrc).toMatch(/private onSocketMessage\(no: number, data: string\): void \{\s*if \(no !== this\.sockNo\) return;/);
    expect(rpcSrc).toMatch(/private onSocketClose\(no: number\): void \{\s*if \(no !== this\.sockNo\) return;/);
  });

  it('W6 界面：TerminalPane 按 linkGeneration 重新挂接；TopBar 的重连行是断线横幅的 v-else-if 兄弟；Composer 与 PermCard 在重连期间不可操作', () => {
    expect(vue('renderer/src/ui/TerminalPane.vue')).toMatch(/watch\(\(\) => chat\.linkGeneration, \(\) => \{ if \(chat\.activeId\) void attach\(chat\.activeId\); \}\);/);
    const top = vue('renderer/src/ui/TopBar.vue');
    const iLost = top.search(/<div v-if="chat\.connection === 'lost'"/);
    const iReconn = top.search(/<div v-else-if="chat\.connection === 'reconnecting'" class="reconn" role="status">/);
    expect(iLost).toBeGreaterThan(-1);
    expect(iReconn).toBeGreaterThan(iLost);
    // 两者之间只有横幅自己的内容与它的闭合标签：是紧邻的兄弟
    expect(top.slice(iLost, iReconn).match(/<\/div>/g)).toHaveLength(1);
    expect(top).toMatch(/<button v-if="chat\.linkRetryable" class="f-btn" type="button" @click="chat\.retryConnection\(\)">重新连接<\/button>/);
    expect(top).toContain('正在重新连接（第 {{ chat.link?.attempt ?? 1 }} / {{ chat.link?.maxAttempts ?? 1 }} 次）');
    const reconn = /(^|\})\s*\.reconn\s*\{([^}]*)\}/.exec(top)?.[2] ?? '';
    expect(reconn).toMatch(/background:\s*var\(--c-warn-soft\)/);
    expect(reconn).not.toMatch(/z-index|position\s*:/);
    expect(vue('renderer/src/ui/Composer.vue')).toMatch(/const canSend = computed\(\(\) =>[^;]*&& chat\.connection !== 'reconnecting' && chat\.connection !== 'lost' && !sending\.value\);/);
    const perm = vue('renderer/src/ui/PermCard.vue');
    expect(count(perm, /:disabled="chat\.connection !== 'ok'"/g)).toBe(3);
    expect(perm).toMatch(/<div v-if="chat\.connection !== 'ok'"[^>]*>正在重新连接，连上后再选择<\/div>/);
  });

  it('W7 权限卡的字段映射只有一份：note: req.note 只出现一次，且在 permission.request 的处理器正文里；快照与续传校正经 _permIn 复用', async () => {
    await checkPermissionEntrances(probe);
  });

  it('W8 store 从不因为重连而发写调用：chat.prompt 只在 send() 里、permission.respond 只在 respondPerm() 里；核对只用 state.outcomes', async () => {
    // 写调用只有一个发起点是全目录的结构保证；各恢复入口另真跑。
    expect(count(store, /'chat\.prompt'/g)).toBe(2);
    expect(count(store, /rpc\.call\('chat\.prompt'/g)).toBe(1);
    expect(count(store, /'permission\.respond'/g)).toBe(2);
    expect(count(store, /rpc\.call<[^(]*>\('permission\.respond'/g)).toBe(1);
    await checkRecoveryNoWrites(probe);
  });
});
