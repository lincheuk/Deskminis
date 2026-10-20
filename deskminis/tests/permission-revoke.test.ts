/**
 * F05 复核修复（B2）：放行落账失败时，这张卡带来的授权要一并收回。
 *
 * 背景：用户在权限卡上点「本会话允许」，网关在交回放行之前就记下了会话授权（shell 卡还带出桥合并授权）。
 * 运行账本的权限接缝发现「已放行」写不进执行账本时把这次放行改成拒绝（invalidated / record-failed），
 * 回给模型的话是「这次批准已失效……会重新询问」。授权不收回的话，同样的请求下一次不弹卡直接放行——
 * 与那句话、与审计里的「已失效」都对不上。
 *
 * 这里测网关一侧的收回入口（revokeGrant / revokeBridgeSession / revokeBridgeOnce）与 index.ts 的接线；
 * 接缝 + 真实账本的整条链路在 run-ledger-loop.test.ts 的 G8c。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { allowed, denied } from '../src/shared/permission';
import { PermissionGatewayImpl, type PermissionPrompt } from '../src/minisd/tools/permissions';
import { denialText } from '../src/minisd/tools/permission-text';
import type { BridgePermissionKind, PermissionRequest } from '../src/minisd/tools/types';
import { stripComments } from './strip-comments';
import { expectSame, callMark, onCall } from './engine-trace';
import type { PermissionAllowVia } from '../src/shared/permission';
import { watchEngine, type EngineWatch } from './engine-wiring';
import { startCapturedEngine, probeConnection, type CapturedEngine } from './engine-assembly';
import type { StartMinisdOpts } from '../src/minisd/index';

const qEngines: CapturedEngine[] = [];

const qSavedFake = process.env.DESKMINIS_FAKE_PROVIDER;

afterEach(async () => {
  for (const e of qEngines.splice(0).reverse()) await e.close();
  vi.restoreAllMocks();
  if (qSavedFake === undefined) delete process.env.DESKMINIS_FAKE_PROVIDER;
  else process.env.DESKMINIS_FAKE_PROVIDER = qSavedFake;
});

async function qStart(opts: StartMinisdOpts = {}): Promise<CapturedEngine> {
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const e = await startCapturedEngine(opts);
  qEngines.push(e);
  return e;
}

async function qRpc(e: CapturedEngine, name: string, p: any = {}, conn = probeConnection('local')): Promise<any> {
  return await e.methods[name](p, conn);
}

function qObserved(w: EngineWatch, name: string, owner: unknown, args: unknown[], invoke: () => unknown): unknown {
  const from = callMark();
  const result = invoke();
  expect(w.count(name, from)).toBe(1);
  expect(w.args(name)).toEqual(args);
  for (const [i, arg] of args.entries()) expectSame(w.args(name)[i], arg);
  expectSame(w.spy(name).mock.contexts.at(-1), owner);
  expect(result).toBe(w.spy(name).mock.results.at(-1)?.value);
  return result;
}

async function qUntil(what: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('等待超时: ' + what);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

const shellReq = (detail: string, sessionId = 'S1'): PermissionRequest => ({ kind: 'shell', detail, sessionId, toolTitle: 't' });
const bridgeReq = (kind: BridgePermissionKind, sessionId = 'S1'): PermissionRequest => ({ kind, detail: 'd', sessionId, toolTitle: 't' });

/** 每次询问发一张卡（回报 requestId）并按给定的答复作答；asked 记下发过的卡。 */
function cards(answer: 'allow-once' | 'allow-session' | 'deny'): { prompt: PermissionPrompt; asked: string[] } {
  const asked: string[] = [];
  const prompt: PermissionPrompt = async (_req, ctl) => {
    const id = `CARD-${asked.length + 1}`;
    asked.push(id);
    ctl.issued?.(id);
    return answer === 'deny' ? { answer: 'deny', reason: 'user-denied', requestId: id } : { answer, requestId: id };
  };
  return { prompt, asked };
}

describe('F05 收回一张卡的放行带来的授权（网关）', () => {
  it('「本会话允许」之后 revokeGrant：会话授权被收回，同样的请求重新弹卡；别的请求、别的会话的授权不动', async () => {
    const { prompt, asked } = cards('allow-session');
    const g = new PermissionGatewayImpl(prompt);
    const a = await g.decide(shellReq('build.ps1'));
    expect(a).toEqual({ decision: 'allow', via: 'user-session', requestId: 'CARD-1' });
    await g.decide(shellReq('other.ps1'));            // CARD-2
    await g.decide(shellReq('build.ps1', 'S2'));      // CARD-3
    // 对照：不收回时同样的请求走会话授权、不弹卡
    expect(await g.decide(shellReq('build.ps1'))).toEqual({ decision: 'allow', via: 'session-grant' });
    expect(asked).toHaveLength(3);

    g.revokeGrant(shellReq('build.ps1'), allowed('user-session', 'CARD-1'));
    expect(await g.decide(shellReq('build.ps1'))).toEqual({ decision: 'allow', via: 'user-session', requestId: 'CARD-4' });
    expect(asked).toHaveLength(4);
    // 另两条授权还在
    g.revokeGrant(shellReq('build.ps1'), allowed('user-session', 'CARD-4'));
    expect((await g.decide(shellReq('other.ps1'))).decision).toBe('allow');
    expect((await g.decide(shellReq('build.ps1', 'S2'))).decision).toBe('allow');
    expect(asked).toHaveLength(4);
  });

  it('只认卡片上的允许：没弹卡的放行（档位免审、既有会话授权、桥合并授权、旧式网关）没有东西可收，既有授权不动、钩子不调', async () => {
    const { prompt, asked } = cards('allow-session');
    const revoked: unknown[] = [];
    const g = new PermissionGatewayImpl(prompt, undefined, 90000, undefined, { onRevoked: (req, a) => { revoked.push([req.detail, a.via]); } });
    await g.decide(shellReq('build.ps1'));
    for (const via of ['session-grant', 'level-bypass', 'bridge-grant', 'legacy-binary'] as const) g.revokeGrant(shellReq('build.ps1'), allowed(via));
    expect(revoked).toEqual([]);
    expect(await g.decide(shellReq('build.ps1'))).toEqual({ decision: 'allow', via: 'session-grant' });
    expect(asked).toHaveLength(1);
  });

  it('「允许一次」的卡没有会话授权可收，但宿主钩子照样被调（它要收的是这张卡带出的桥合并授权）；钩子抛错不外溢', async () => {
    const seen: unknown[] = [];
    const g = new PermissionGatewayImpl(cards('allow-once').prompt, undefined, 90000, undefined, {
      onRevoked: (req, a) => { seen.push([req.sessionId, req.detail, a.via, a.requestId]); throw new Error('钩子自己坏了'); },
    });
    const a = await g.decide(shellReq('windows-notify show hi'));
    expect(a).toEqual({ decision: 'allow', via: 'user-once', requestId: 'CARD-1' });
    expect(() => g.revokeGrant(shellReq('windows-notify show hi'), allowed('user-once', 'CARD-1'))).not.toThrow();
    expect(seen).toEqual([['S1', 'windows-notify show hi', 'user-once', 'CARD-1']]);
  });

  it('revokeBridgeSession：收回后同会话同桥 kind 重新询问；别的会话、别的 kind 不动', async () => {
    const { prompt, asked } = cards('deny');
    const g = new PermissionGatewayImpl(prompt);
    g.grantBridgeSession('S1', 'bridge-notify');
    g.grantBridgeSession('S1', 'bridge-speak');
    g.grantBridgeSession('S2', 'bridge-notify');
    g.revokeBridgeSession('S1', 'bridge-notify');
    expect((await g.decide(bridgeReq('bridge-notify'))).decision).toBe('deny');
    expect(asked).toHaveLength(1);
    expect(await g.decide(bridgeReq('bridge-speak'))).toEqual({ decision: 'allow', via: 'bridge-grant' });
    expect(await g.decide(bridgeReq('bridge-notify', 'S2'))).toEqual({ decision: 'allow', via: 'bridge-grant' });
    expect(asked).toHaveLength(1);
  });

  it('revokeBridgeOnce：计数减一，减到零删条目；没有条目时什么都不做', async () => {
    const { prompt, asked } = cards('deny');
    const g = new PermissionGatewayImpl(prompt);
    g.grantBridgeOnce('S1', 'bridge-open');
    g.grantBridgeOnce('S1', 'bridge-open');
    g.revokeBridgeOnce('S1', 'bridge-open');
    // 两次授予、收回一次：还剩恰好一次静默放行
    expect(await g.decide(bridgeReq('bridge-open'))).toEqual({ decision: 'allow', via: 'bridge-grant' });
    expect((await g.decide(bridgeReq('bridge-open'))).decision).toBe('deny');
    expect(asked).toHaveLength(1);
    // 授予一次、收回一次：不剩；再收回是空操作，不会欠成负数
    g.grantBridgeOnce('S1', 'bridge-open');
    g.revokeBridgeOnce('S1', 'bridge-open');
    g.revokeBridgeOnce('S1', 'bridge-open');
    expect(g.hasBridgeGrant('S1')).toBe(false);
    expect((await g.decide(bridgeReq('bridge-open'))).decision).toBe('deny');
    g.grantBridgeOnce('S1', 'bridge-open');
    expect(await g.decide(bridgeReq('bridge-open'))).toEqual({ decision: 'allow', via: 'bridge-grant' });
    expect(asked).toHaveLength(2);
  });

  it('回给模型的话与收回之后的实际一致：record-failed 的文案说批准已失效、会重新询问', () => {
    const text = denialText(denied('invalidated', 'record-failed', { requestId: 'CARD-1' }), { kind: 'shell', detail: 'build.ps1' });
    expect(text).toContain('这次批准已失效');
    expect(text).toContain('会重新询问');
  });
});

describe('F05 收回授权的接线（源码守卫，先剥注释）', () => {
  const codeOf = (rel: string): string => stripComments(readFileSync(join(__dirname, '..', 'src', 'minisd', rel), 'utf8').replace(/\r\n/g, '\n'));

  it('运行记录器在把放行改成 record-failed 的那一处收回授权，且先于记审计', () => {
    const rec = codeOf('agent/run-recorder.ts');
    expect(rec.match(/\.revokeGrant\?\.\(/g)).toHaveLength(1);
    const failed = rec.indexOf("denied('invalidated', 'record-failed'");
    const revoke = rec.indexOf('inner.revokeGrant?.(req, o)');
    const report = rec.indexOf('reportDenied(inner, req, d');
    expect(failed).toBeGreaterThan(0);
    expect(revoke).toBeGreaterThan(failed);
    expect(report).toBeGreaterThan(revoke);
  });

  it('index.ts 的网关接着 onRevoked：shell 卡带出的桥合并授权按批准时的方式收回（探测用同一个函数）', async () => {
    // 调引擎真正交给网关的回调，按user-session/user-once收回对应桥授权。
    const w = watchEngine();
    await qStart();
    const gateway = w.made('new PermissionGatewayImpl');
    const hook = w.args('new PermissionGatewayImpl')[4].onRevoked;
    const cache = w.made('createStableCache');
    expect(typeof hook).toBe('function');
    const methods = {
      'user-session': 'gateway.revokeBridgeSession', 'user-once': 'gateway.revokeBridgeOnce',
      'level-bypass': 'gateway.revokeBridgeOnce', 'session-grant': 'gateway.revokeBridgeOnce',
      'bridge-grant': 'gateway.revokeBridgeOnce', 'legacy-binary': 'gateway.revokeBridgeOnce',
    } satisfies Record<PermissionAllowVia, string>;
    const commands = {
      'bridge-notify': 'windows-notify show hi', 'bridge-clipboard-read': 'windows-clipboard get',
      'bridge-clipboard-write': 'windows-clipboard set hi', 'bridge-open': 'windows-open open q',
      'bridge-speak': 'windows-speak say hi', 'bridge-screenshot': 'windows-screenshot capture',
      'bridge-device': 'windows-device info',
    } satisfies Record<BridgePermissionKind, string>;
    for (const via of Object.keys(methods) as PermissionAllowVia[]) {
      for (const kind of Object.keys(commands) as BridgePermissionKind[]) {
        const method = methods[via];
        const other = method === 'gateway.revokeBridgeSession' ? 'gateway.revokeBridgeOnce' : 'gateway.revokeBridgeSession';
        const sid = 'Q20A-' + via + '-' + kind;
        gateway[via === 'user-session' ? 'grantBridgeSession' : 'grantBridgeOnce'](sid, kind);
        const from = callMark();
        qObserved(w, method, gateway, [sid, kind], () => hook(shellReq(commands[kind], sid), allowed(via, 'Q20A-CARD')));
        expect(w.count(other, from)).toBe(0);
        expect(w.count('stable.invalidate', from)).toBe(1);
        expect(w.args('stable.invalidate')).toEqual([sid]);
        expectSame(w.spy('stable.invalidate').mock.contexts.at(-1), cache);
        expect(gateway.hasBridgeGrant(sid)).toBe(false);
        // notify 在默认档位会重询问；其它桥能力可由自己的策略直接放行，授权消失已由上句证明。
        if (kind === 'bridge-notify') {
          let requestId = '';
          const broker = w.made('new PermissionBroker');
          const answer = gateway.decide(bridgeReq(kind, sid), { signal: new AbortController().signal, origin: 'tool', onIssued: (id: string) => { requestId = id; } });
          await qUntil('收回后重新发权限卡', () => requestId !== '');
          broker.settleWhere((entry: any) => entry.requestId === requestId, { reason: 'cancelled', cause: 'user-stop' });
          expect((await answer).decision).toBe('deny');
          }
      }
    }
    // 非shell与无桥触发的边界输入不撤授权、不动缓存；这些回调全是同步的。
    const from = callMark();
    const nonShell = {
      'file-write': true, 'file-read': true, 'web-fetch': true, 'web-search': true, mcp: true,
      'bridge-notify': true, 'bridge-clipboard-read': true, 'bridge-clipboard-write': true,
      'bridge-open': true, 'bridge-speak': true, 'bridge-screenshot': true, 'bridge-device': true,
    } satisfies Record<Exclude<PermissionRequest['kind'], 'shell'>, true>;
    for (const kind of Object.keys(nonShell)) hook({ ...shellReq('windows-notify show hi'), kind }, allowed('user-once', 'Q20A-CARD'));
    hook(shellReq(''), allowed('user-session', 'Q20A-CARD'));
    expect(w.count('gateway.revokeBridgeSession', from)).toBe(0);
    expect(w.count('gateway.revokeBridgeOnce', from)).toBe(0);
    expect(w.count('stable.invalidate', from)).toBe(0);
  }, 60000);
});
