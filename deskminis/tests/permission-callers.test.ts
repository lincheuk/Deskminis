/**
 * F13：权限调用方（12 个工具入口 + 桥分发器）。
 *
 * 本文件运行时不引入 F13 的新模块（只有 import type）：标「先红」的用例在实现之前就能加载、红在行为上，
 * 实现之后同一份用例文本转绿（设计 §7.2；先红日志 F13-impl-red）。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PermissionGatewayImpl, type PermissionClass, type PermissionLevel } from '../src/minisd/tools/permissions';
import type { PermissionRequest } from '../src/minisd/tools/types';
import type { PermissionDenied } from '../src/shared/permission';
import {
  callerHarness, outcomeGateway, binaryGateway, CALLERS, TOOL_CALLERS, JUNK_OUTCOMES,
  type Caller, type CallerHarness, type CallerResult,
} from './permission-fixture';
import { stripComments } from './strip-comments';
import { expectSame, callMark, onCall, yieldProbe } from './engine-trace';
import type { PermissionPreset } from '../src/minisd/tools/permissions';
import { watchEngine, type EngineWatch } from './engine-wiring';
import { startCapturedEngine, probeConnection, type CapturedEngine } from './engine-assembly';
import type { StartMinisdOpts } from '../src/minisd/index';

let h: CallerHarness;
beforeAll(async () => { h = await callerHarness(); });
afterAll(() => { h.dispose(); });
afterEach(() => {
  // 用例之间互不串：会话禁用名单与搜索配置复位
  h.chat.setMcpDisabled(h.sid, []);
  h.search.conf = { kind: 'brave', apiKey: 'KEY-1' };
});

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

async function qPending(w: EngineWatch, e: CapturedEngine): Promise<{ sid: string; release(): void; result: Promise<unknown> }> {
  let release!: () => void;
  w.spy('mcp.ensureForRun').mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
  const { id } = await qRpc(e, 'chat.sessions.create');
  const result = qRpc(e, 'chat.prompt', { sessionId: id, providerId: '__fake__', text: 'Q20A S3' }).catch(error => error);
  await qUntil('run进入MCP挂起点', () => typeof release === 'function');
  return { sid: id, release, result };
}

/** 永不答复的询问函数（计数）。 */
function silentPrompt(): { prompt: (req: PermissionRequest) => Promise<never>; calls: PermissionRequest[] } {
  const calls: PermissionRequest[] = [];
  return { calls, prompt: req => { calls.push(req); return new Promise<never>(() => { /* 永不答复 */ }); } };
}

describe('先红 C1a：询问超时无人答复，13 个调用方都不说「被用户拒绝」', () => {
  it.each(CALLERS)('%s', async caller => {
    const p = silentPrompt();
    const r = await h.run(caller, new PermissionGatewayImpl(p.prompt, undefined, 30));
    expect(p.calls.length, '确实走到了询问').toBe(1);
    expect(r.success).toBe(false);
    expect(r.effects, '没批准就没有副作用').toBe(0);
    expect(r.output).not.toContain('被用户拒绝');
    expect(r.output).not.toContain('权限拒绝');
  });
});

describe('先红 C2a：规则拦截（类目设成 notAllowed）不说成用户拒绝', () => {
  it('web_fetch', async () => {
    const p = silentPrompt();
    const r = await h.run('web_fetch', new PermissionGatewayImpl(p.prompt, { 'web-fetch': 'notAllowed' }));
    expect(p.calls.length, '规则拦截不询问').toBe(0);
    expect(r.success).toBe(false);
    expect(r.effects).toBe(0);
    expect(r.output).not.toContain('被用户拒绝');
  });
});

describe('先红 C4a：同一会话连续无人答复，不无限弹卡', () => {
  it('三次不同的 web_fetch：询问函数只被调 2 次，第三次直接说明没有再询问', async () => {
    const p = silentPrompt();
    const gw = new PermissionGatewayImpl(p.prompt, undefined, 20);
    const outs: string[] = [];
    for (const n of [1, 2, 3]) {
      const r = await h.run('web_fetch', gw, { input: { url: `https://example.com/f13-${n}`, tool_title: '抓网页' } });
      expect(r.success).toBe(false);
      expect(r.effects).toBe(0);
      outs.push(r.output);
    }
    expect(p.calls.length).toBe(2);
    expect(outs[2]).toContain('没有再询问');
    for (const o of outs) expect(o).not.toContain('被用户拒绝');
  });
});

describe('先红 C5a：MCP 等卡期间在本会话禁用这台，批准后不调用', () => {
  it('询问函数里禁用后回 allow-once：调用没有发出，输出是会话禁用的原话', async () => {
    const gw = new PermissionGatewayImpl(async () => { h.chat.setMcpDisabled(h.sid, ['a']); return 'allow-once'; });
    const r = await h.run('mcp__a__echo', gw);
    expect(r.effects, 'MCP 调用不该发出').toBe(0);
    expect(r.success).toBe(false);
    expect(r.output).toBe('该 MCP server 已在本会话禁用');
  });
});

describe('先红 C5b：web_search 等卡期间搜索配置被清除，批准后不出网', () => {
  it('清除配置后批准：fetch 0 次，输出说明已失效，并上报一条带同一张卡 id 的 search-config-changed', async () => {
    const gw = outcomeGateway(() => { h.search.conf = undefined; return { decision: 'allow', via: 'user-once', requestId: 'CARD-1' }; });
    const r = await h.run('web_search', gw);
    expect(r.effects, '旧配置（含旧密钥）不再出网').toBe(0);
    expect(r.success).toBe(false);
    expect(r.output).toContain('已失效');
    expect(r.output).not.toContain('被用户拒绝');
    expect(gw.noted.map(n => n.denied)).toEqual([
      { decision: 'deny', reason: 'invalidated', cause: 'search-config-changed', requestId: 'CARD-1' },
    ]);
  });
});

// =================================================================================================================
// 以下是先红之外的用例（实现之后补写）。
// =================================================================================================================

/** 危险命令的规则拦截文案开头（permission-text.ts 的 RULE_BLOCKED；本文件运行时不引入新模块，这里只认关键句）。 */
const RULE_BLOCKED_HEAD = '命令未执行：它命中了危险命令规则';

describe('C1 调用方矩阵：13 个调用方 × 各种网关结果', () => {
  const CARD = 'CARD-C1';
  type Column = { name: string; outcome: unknown; reason: string; tool: (out: string) => void; bridge: (msg: string) => void };
  const COLUMNS: Column[] = [
    {
      name: 'user-denied', outcome: { decision: 'deny', reason: 'user-denied', requestId: CARD }, reason: 'user-denied',
      tool: out => { expect(out).toContain('被用户拒绝'); expect(out).toContain('可在设置-权限中调整'); },
      bridge: msg => { expect(msg).toBe('权限拒绝: windows-clipboard get'); },
    },
    {
      name: 'timeout', outcome: { decision: 'deny', reason: 'timeout', cause: 'unanswered', requestId: CARD, waitedMs: 90_000 }, reason: 'timeout',
      tool: out => { expect(out).toContain('等了 90 秒没有人答复'); expect(out).toContain('不是用户点了拒绝'); },
      bridge: msg => { expect(msg).toBe('权限请求超时无人答复，未执行: windows-clipboard get。这不是用户点了拒绝；用户可能暂时不在，不要立刻重试同一条命令。'); },
    },
    {
      name: 'rule-blocked', outcome: { decision: 'deny', reason: 'rule-blocked', cause: 'level-not-allowed' }, reason: 'rule-blocked',
      tool: out => { expect(out).toContain('当前权限规则不允许'); expect(out).toMatch(/不要.*绕过/); },
      bridge: msg => { expect(msg).toBe('权限规则不允许，未执行: windows-clipboard get'); },
    },
    {
      name: 'cancelled', outcome: { decision: 'deny', reason: 'cancelled', cause: 'user-stop', requestId: CARD }, reason: 'cancelled',
      tool: out => { expect(out).toBe('[已取消]'); },
      bridge: msg => { expect(msg).toBe('权限请求已取消，未执行: windows-clipboard get'); },
    },
    {
      name: 'invalidated', outcome: { decision: 'deny', reason: 'invalidated', requestId: CARD }, reason: 'invalidated',
      tool: out => { expect(out).toContain('这次权限请求已失效'); expect(out).toContain('重新发起'); },
      bridge: msg => { expect(msg).toBe('权限请求已失效，未执行: windows-clipboard get'); },
    },
  ];
  const USER_WORDS = ['被用户拒绝', '权限拒绝', '可在设置-权限中调整'];
  const expectUnspecified = (caller: Caller, r: CallerResult, label: string): void => {
    expect(r.success, label).toBe(false);
    expect(r.effects, `${label}：不是放行`).toBe(0);
    for (const w of USER_WORDS) expect(r.output, label).not.toContain(w);
    if (caller === 'bridge') {
      expect(r.code, label).toBe('PERMISSION_DENIED');
      expect(r.reason, label).toBe('unspecified');
      expect(r.output, label).toBe('未获许可，未执行: windows-clipboard get');
    } else {
      expect(r.output, label).toContain('没有获得许可');
    }
  };

  describe.each(CALLERS)('%s', caller => {
    it('允许：副作用发生', async () => {
      const gw = outcomeGateway(() => ({ decision: 'allow', via: 'user-once', requestId: CARD }));
      const r = await h.run(caller, gw);
      expect(gw.asked.length).toBe(1);
      expect(r.effects, r.output).toBeGreaterThan(0);
      expect(gw.noted).toEqual([]);
    });

    it.each(COLUMNS)('$name：不执行，文案属于这一类；只有 user-denied 说「被用户拒绝」', async col => {
      const gw = outcomeGateway(() => col.outcome);
      const r = await h.run(caller, gw);
      expect(gw.asked.length).toBe(1);
      expect(r.success).toBe(false);
      expect(r.effects).toBe(0);
      if (caller === 'bridge') {
        expect(r.code).toBe('PERMISSION_DENIED');
        expect(r.reason).toBe(col.reason);
        col.bridge(r.output);
      } else {
        col.tool(r.output);
      }
      if (col.name !== 'user-denied') for (const w of USER_WORDS) expect(r.output).not.toContain(w);
    });

    it('旧式二值网关的 deny：不说原因，不当成用户拒绝', async () => {
      const gw = binaryGateway('deny');
      const r = await h.run(caller, gw);
      expect(gw.asked.length).toBe(1);
      expectUnspecified(caller, r, '二值 deny');
    });

    it('旧式二值网关的 allow：照常放行', async () => {
      const r = await h.run(caller, binaryGateway('allow'));
      expect(r.effects, r.output).toBeGreaterThan(0);
    });

    it('形状不合法的结果（逐个）：一律拒绝，不执行', async () => {
      for (const junk of JUNK_OUTCOMES) {
        expectUnspecified(caller, await h.run(caller, outcomeGateway(() => junk.value)), `decide 返回 ${junk.label}`);
        // 旧式二值网关 check 返回垃圾值也一样：只有恰好 'allow' 才放行
        if (junk.value !== 'allow') expectUnspecified(caller, await h.run(caller, binaryGateway(junk.value)), `check 返回 ${junk.label}`);
      }
    });
  });

  it('shell：旧式二值网关拒掉危险命令，仍说是规则拦下的（危险规则不随网关实现变）', async () => {
    const r = await h.run('shell_execute', binaryGateway('deny'), { input: { command: 'Remove-Item x', tool_title: '删' } });
    expect(r.effects).toBe(0);
    expect(r.output.startsWith(RULE_BLOCKED_HEAD)).toBe(true);
    expect(r.output).not.toContain('被用户拒绝');
  });

  it('网关抛错：工具落「工具执行异常」，不执行', async () => {
    for (const caller of TOOL_CALLERS) {
      const r = await h.run(caller, outcomeGateway(() => { throw new Error('网关炸了'); }));
      expect(r.success, caller).toBe(false);
      expect(r.effects, caller).toBe(0);
      expect(r.output, caller).toContain('网关炸了');
    }
  });
});

describe('C2 规则拦截：真网关把各类目设成 notAllowed', () => {
  const ALL_BLOCKED: Partial<Record<PermissionClass, PermissionLevel>> = {
    gated: 'notAllowed', 'file-write': 'notAllowed', 'file-read': 'notAllowed', 'web-fetch': 'notAllowed',
    'web-search': 'notAllowed', mcp: 'notAllowed', 'bridge-clipboard-read': 'notAllowed',
  };
  it.each(CALLERS)('%s：不询问；说明是规则、不是用户拒绝、不要绕过；报一条 level-not-allowed', async caller => {
    const p = silentPrompt();
    const noted: PermissionDenied[] = [];
    const gw = new PermissionGatewayImpl(p.prompt, ALL_BLOCKED, 90_000, undefined, { onDenied: (_r, d) => { noted.push(d); } });
    const r = await h.run(caller, gw);
    expect(p.calls.length).toBe(0);
    expect(r.success).toBe(false);
    expect(r.effects).toBe(0);
    expect(r.output).toContain('规则');
    expect(r.output).not.toContain('可在设置-权限中调整');
    expect(r.output).not.toContain('被用户拒绝');
    if (caller === 'bridge') {
      expect(r.reason).toBe('rule-blocked');
    } else {
      expect(r.output).toContain('不是用户拒绝');
      expect(r.output).toMatch(/不要.*绕过/);
    }
    expect(noted).toEqual([{ decision: 'deny', reason: 'rule-blocked', cause: 'level-not-allowed' }]);
  });

  it('危险命令（默认档位）：RULE_BLOCKED，报一条 shell-danger', async () => {
    const p = silentPrompt();
    const noted: PermissionDenied[] = [];
    const gw = new PermissionGatewayImpl(p.prompt, undefined, 90_000, undefined, { onDenied: (_r, d) => { noted.push(d); } });
    const r = await h.run('shell_execute', gw, { input: { command: 'Remove-Item x', tool_title: '删' } });
    expect(p.calls.length).toBe(0);
    expect(r.effects).toBe(0);
    expect(r.output.startsWith(RULE_BLOCKED_HEAD)).toBe(true);
    expect(noted).toEqual([{ decision: 'deny', reason: 'rule-blocked', cause: 'shell-danger' }]);
  });

  it('核心数据（dataGate 直接拒）：不询问，原有的拒绝串，报一条 core-data', async () => {
    const gw = outcomeGateway(() => ({ decision: 'allow', via: 'user-once' }));
    const r = await h.run('file_write', gw, { input: { path: join(h.root, 'providers.json'), content: 'x', tool_title: '写' } });
    expect(gw.asked.length, '核心数据不进网关').toBe(0);
    expect(r.success).toBe(false);
    expect(r.output).toContain('核心数据');
    expect(gw.noted.map(n => [n.req.kind, n.denied])).toEqual([['file-write', { decision: 'deny', reason: 'rule-blocked', cause: 'core-data' }]]);
  });
});

describe('C3 allow 与取消同一拍：不执行；被批准的那张卡记一条', () => {
  it.each(TOOL_CALLERS)('%s：[已取消]，副作用 0，noted 恰好一条（同一个 requestId）', async caller => {
    const c = new AbortController();
    const gw = outcomeGateway(() => { c.abort(); return { decision: 'allow', via: 'user-once', requestId: 'CARD-C3' }; });
    const r = await h.run(caller, gw, { signal: c.signal });
    expect(r).toMatchObject({ output: '[已取消]', success: false, effects: 0 });
    expect(gw.noted.map(n => n.denied)).toEqual([{ decision: 'deny', reason: 'cancelled', cause: 'user-stop', requestId: 'CARD-C3' }]);
  });

  it.each(TOOL_CALLERS)('%s：没弹卡的放行（不带 requestId）被取消——不执行，也不记', async caller => {
    const c = new AbortController();
    const gw = outcomeGateway(() => { c.abort(); return { decision: 'allow', via: 'level-bypass' }; });
    const r = await h.run(caller, gw, { signal: c.signal });
    expect(r).toMatchObject({ output: '[已取消]', success: false, effects: 0 });
    expect(gw.noted).toEqual([]);
  });
});

describe('C3b 桥分发器：请求方走了就不问、不执行', () => {
  it('(a) 批准的同一拍请求方断开：PERMISSION_DENIED / cancelled，PowerShell 0 次，记一条 requester-gone（origin: bridge）', async () => {
    const c = new AbortController();
    const gw = outcomeGateway(() => { c.abort('requester-gone'); return { decision: 'allow', via: 'user-once', requestId: 'CARD-B' }; });
    const r = await h.run('bridge', gw, { bridgeCtl: { signal: c.signal } });
    expect(r).toMatchObject({ success: false, effects: 0, code: 'PERMISSION_DENIED', reason: 'cancelled' });
    expect(r.output).toBe('权限请求已取消，未执行: windows-clipboard get');
    expect(gw.askedOpts[0]).toMatchObject({ origin: 'bridge', signal: c.signal });
    expect(gw.noted.map(n => [n.denied, n.opts])).toEqual([
      [{ decision: 'deny', reason: 'cancelled', cause: 'requester-gone', requestId: 'CARD-B' }, { origin: 'bridge' }],
    ]);
  });

  it('(a′) 免审放行（不带 requestId）时请求方已断开：同样不执行，记一条不带 requestId 的', async () => {
    const c = new AbortController();
    const gw = outcomeGateway(() => { c.abort('requester-gone'); return { decision: 'allow', via: 'level-bypass' }; });
    const r = await h.run('bridge', gw, { bridgeCtl: { signal: c.signal } });
    expect(r).toMatchObject({ effects: 0, code: 'PERMISSION_DENIED', reason: 'cancelled' });
    expect(gw.noted.map(n => n.denied)).toEqual([{ decision: 'deny', reason: 'cancelled', cause: 'requester-gone' }]);
  });

  it('(b) 进门前请求方已断开：不询问，同样的信封，PowerShell 0 次', async () => {
    const c = new AbortController(); c.abort('requester-gone');
    const gw = outcomeGateway(() => ({ decision: 'allow', via: 'user-once', requestId: 'CARD-B' }));
    const r = await h.run('bridge', gw, { bridgeCtl: { signal: c.signal } });
    expect(gw.asked).toEqual([]);
    expect(r).toMatchObject({ success: false, effects: 0, code: 'PERMISSION_DENIED', reason: 'cancelled' });
    expect(gw.noted).toEqual([]);
  });

  it('请求方还在：照常执行；拒绝时请求方断开，交回的也是 cancelled 且不重复记', async () => {
    const live = new AbortController();
    const ok = await h.run('bridge', outcomeGateway(() => ({ decision: 'allow', via: 'user-once', requestId: 'CARD-B' })), { bridgeCtl: { signal: live.signal } });
    expect(ok).toMatchObject({ success: true, effects: 1 });
    const c = new AbortController();
    const gw = outcomeGateway(() => { c.abort('requester-gone'); return { decision: 'deny', reason: 'user-denied', requestId: 'CARD-B' }; });
    expect(await h.run('bridge', gw, { bridgeCtl: { signal: c.signal } })).toMatchObject({ effects: 0, reason: 'cancelled' });
    expect(gw.noted).toEqual([]);
  });
});

describe('C5 MCP：闸前拒绝留痕；闸后复查停用 / 会话禁用 / 改配置', () => {
  const allowCard = { decision: 'allow', via: 'user-once', requestId: 'CARD-M' };
  const restoreServer = (): void => { h.mcpStore.upsert({ name: 'a', command: 'echo', args: [], enabled: true }); };

  it('(a) 闸前拒绝 × 四种：原有的句子，不问权限、不发调用，各报一条对应 cause', async () => {
    const run = async (): Promise<{ r: CallerResult; noted: PermissionDenied[]; asked: number }> => {
      const gw = outcomeGateway(() => allowCard);
      const r = await h.run('mcp__a__echo', gw);
      return { r, noted: gw.noted.map(n => n.denied), asked: gw.asked.length };
    };
    const expectRefused = (x: Awaited<ReturnType<typeof run>>, output: string, cause: string): void => {
      expect(x.r).toMatchObject({ output, success: false, effects: 0 });
      expect(x.asked).toBe(0);
      expect(x.noted).toEqual([{ decision: 'deny', reason: 'invalidated', cause }]);
    };
    try {
      h.mcpStore.toggle('a', false);
      expectRefused(await run(), '该 MCP server 已停用', 'mcp-disabled');
      h.mcpStore.toggle('a', true);

      h.chat.setMcpDisabled(h.sid, ['a']);
      expectRefused(await run(), '该 MCP server 已在本会话禁用', 'mcp-session-disabled');
      h.chat.setMcpDisabled(h.sid, []);

      h.mcpStore.remove('a');
      expectRefused(await run(), '该 MCP server 已不在配置中', 'mcp-removed');
      restoreServer();

      const good = readFileSync(h.mcpConfigFile);
      writeFileSync(h.mcpConfigFile, '{"mcpServers": 写坏了', 'utf8');
      h.mcpStore.refresh();
      expect(h.mcpStore.loadErrorKind).toBeDefined();
      expectRefused(await run(), 'servers.json 读不出来（格式有误或无法读取），修好前暂不能调用 MCP 工具', 'mcp-config-unreadable');
      writeFileSync(h.mcpConfigFile, good);
      h.mcpStore.refresh();
    } finally {
      restoreServer(); h.mcpStore.toggle('a', true);
    }
    // 复原之后照常可调
    expect((await run()).r).toMatchObject({ success: true, effects: 1 });
  });

  it('(b) 卡片因会话禁用被作废（decide 返回 invalidated）：给出现查到的那句原话', async () => {
    const gw = outcomeGateway(() => { h.chat.setMcpDisabled(h.sid, ['a']); return { decision: 'deny', reason: 'invalidated', cause: 'mcp-session-disabled', requestId: 'CARD-M' }; });
    expect(await h.run('mcp__a__echo', gw)).toMatchObject({ output: '该 MCP server 已在本会话禁用', success: false, effects: 0 });
    // 卡片已经了结过，不再另记一条
    expect(gw.noted).toEqual([]);
  });

  it('(b′) 失效了但现查不出原因（刚停又启）：兜底句', async () => {
    const r = await h.run('mcp__a__echo', outcomeGateway(() => ({ decision: 'deny', reason: 'invalidated', cause: 'mcp-disabled', requestId: 'CARD-M' })));
    expect(r.effects).toBe(0);
    expect(r.output).toContain('这次权限请求已失效');
  });

  it('(c) 等卡期间手改配置停用（没经过 RPC），之后批准：闸后拒绝，记一条带同一个 requestId 的', async () => {
    try {
      const gw = outcomeGateway(() => { h.mcpStore.toggle('a', false); return allowCard; });
      expect(await h.run('mcp__a__echo', gw)).toMatchObject({ output: '该 MCP server 已停用', success: false, effects: 0 });
      expect(gw.noted.map(n => n.denied)).toEqual([{ decision: 'deny', reason: 'invalidated', cause: 'mcp-disabled', requestId: 'CARD-M' }]);
    } finally { h.mcpStore.toggle('a', true); }
  });

  it('(c′) 等卡期间配置被改并 forget（代次变了），之后批准：不执行，记 mcp-config-changed', async () => {
    try {
      const gw = outcomeGateway(() => { h.mcp.forget('a'); return allowCard; });
      const r = await h.run('mcp__a__echo', gw);
      expect(r).toMatchObject({ output: '该 MCP server 配置刚被修改，本次调用未执行', success: false, effects: 0 });
      expect(gw.noted.map(n => n.denied)).toEqual([{ decision: 'deny', reason: 'invalidated', cause: 'mcp-config-changed', requestId: 'CARD-M' }]);
    } finally { await h.mcp.ensureForRun(); }
  });
});

describe('C5b web_search 闸后配置复查的其余变体', () => {
  const allowCard = { decision: 'allow', via: 'user-once', requestId: 'CARD-S' };
  it.each([
    ['换 kind', { kind: 'brave', apiKey: 'KEY-1' }, { kind: 'tavily', apiKey: 'KEY-1' }],
    ['换密钥', { kind: 'brave', apiKey: 'KEY-1' }, { kind: 'brave', apiKey: 'KEY-2' }],
    ['换 baseUrl', { kind: 'searxng', baseUrl: 'http://127.0.0.1:9' }, { kind: 'searxng', baseUrl: 'http://127.0.0.1:10' }],
    ['清掉密钥（配置不可用）', { kind: 'tavily', apiKey: 'KEY-1' }, { kind: 'tavily' }],
  ] as const)('%s：fetch 0 次，已失效，记一条 search-config-changed', async (_n, before, after) => {
    h.search.conf = { ...before };
    const gw = outcomeGateway(() => { h.search.conf = { ...after }; return allowCard; });
    const r = await h.run('web_search', gw);
    expect(r.effects).toBe(0);
    expect(r.success).toBe(false);
    expect(r.output).toContain('已失效');
    expect(r.output).not.toContain('被用户拒绝');
    expect(gw.noted.map(n => n.denied)).toEqual([{ decision: 'deny', reason: 'invalidated', cause: 'search-config-changed', requestId: 'CARD-S' }]);
  });

  it('配置没变：照常出网 1 次，不记', async () => {
    const gw = outcomeGateway(() => { h.search.conf = { kind: 'brave', apiKey: 'KEY-1' }; return allowCard; });
    const r = await h.run('web_search', gw);
    expect(r.effects).toBe(1);
    expect(gw.noted).toEqual([]);
  });

  it('没弹卡的放行（档位 bypass）之后配置变了：同样不出网，记一条不带 requestId 的', async () => {
    const gw = outcomeGateway(() => { h.search.conf = undefined; return { decision: 'allow', via: 'level-bypass' }; });
    const r = await h.run('web_search', gw);
    expect(r.effects).toBe(0);
    expect(gw.noted.map(n => n.denied)).toEqual([{ decision: 'deny', reason: 'invalidated', cause: 'search-config-changed' }]);
  });
});

describe('C6 取消优先：进门前已取消', () => {
  it.each(TOOL_CALLERS)('%s：不询问，[已取消]', async caller => {
    const c = new AbortController(); c.abort();
    const gw = outcomeGateway(() => ({ decision: 'allow', via: 'user-once', requestId: 'X' }));
    const r = await h.run(caller, gw, { signal: c.signal });
    expect(gw.asked).toEqual([]);
    expect(r).toMatchObject({ output: '[已取消]', success: false, effects: 0 });
    expect(gw.noted).toEqual([]);
  });
});

describe('C7 源码守卫（先剥注释）', () => {
  const SRC = join(__dirname, '../src');
  const walk = (dir: string, rel: string, out: { rel: string; code: string }[]): { rel: string; code: string }[] => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, r, out);
      else if (name.endsWith('.ts')) out.push({ rel: r, code: stripComments(readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')) });
    }
    return out;
  };
  const all = walk(SRC, '', []);
  const minisd = all.filter(f => f.rel.startsWith('minisd/')).map(f => ({ rel: f.rel.slice('minisd/'.length), code: f.code }));
  const codeOf = (rel: string): string => {
    const f = minisd.find(x => x.rel === rel);
    if (!f) throw new Error(`找不到源文件 ${rel}`);
    return f.code;
  };
  const filesMatching = (re: RegExp): string[] => minisd.filter(f => re.test(f.code)).map(f => f.rel).sort();
  /** 调用方文件：写死的集合，不按目录扫（tools/ 下的 scheduler / permissions / permission-* 不在其内）。 */
  const CALLER_FILES = ['tools/files.ts', 'tools/shell.ts', 'tools/web.ts', 'tools/web-search.ts', 'tools/office.ts', 'tools/search.ts', 'mcp/manager.ts', 'bridge/handlers.ts'];

  it('(a) 网关的 .check( 只在询问入口的旧网关兼容分支里调；permissions.ts / scheduler.ts 里只有 check 的定义', () => {
    expect(filesMatching(/\.check\(/)).toEqual(['tools/permission-outcome.ts']);
    expect(codeOf('tools/permission-outcome.ts').match(/\.check\(/g)).toHaveLength(1);
    expect(codeOf('tools/permissions.ts')).toMatch(/async check\(req: PermissionRequest\)/);
    expect(codeOf('tools/scheduler.ts')).toMatch(/async check\(req: PermissionRequest\)/);
  });

  it('(b) 调 askPermission / decidePermission 的文件集合固定', () => {
    expect(filesMatching(/\b(askPermission|decidePermission)\(/)).toEqual([
      // F05：运行记录器的权限接缝（套在真实网关外、取消赛跑层内）同样只经 decidePermission 这一个入口问
      'agent/run-recorder.ts',
      'bridge/handlers.ts', 'mcp/manager.ts', 'tools/files.ts', 'tools/permission-outcome.ts', 'tools/scheduler.ts',
      'tools/shell.ts', 'tools/web-search.ts', 'tools/web.ts',
    ]);
  });

  it('(c)「被用户拒绝」「权限拒绝:」只出现在文案表里；调用方文件不对权限结果做与 deny 的比较', () => {
    expect(filesMatching(/被用户拒绝/)).toEqual(['tools/permission-text.ts']);
    expect(filesMatching(/权限拒绝:/)).toEqual(['tools/permission-text.ts']);
    expect(filesMatching(/可在设置-权限中调整/)).toEqual(['tools/permission-text.ts']);
    let gateVerdicts = 0;
    for (const rel of CALLER_FILES) {
      // gate.verdict === 'deny' 是 dataGate 的判定，不是权限结果：逐字去掉后，剩下的代码不得有任何与 'deny' 的比较
      const parts = codeOf(rel).split("gate.verdict === 'deny'");
      gateVerdicts += parts.length - 1;
      const rest = parts.join('');
      expect(rest, rel).not.toMatch(/[!=]==?\s*'deny'/);
      expect(rest, rel).not.toMatch(/'deny'\s*[!=]==?/);
      expect(rest, rel).not.toMatch(/permissions\.check\(/);
    }
    expect(gateVerdicts, 'dataGate 的 deny 判定恰好两处（guardWrite / guardRead）').toBe(2);
  });

  it('(d) applyPreset( 只在 index.ts 的两处与定义处：别处不动档位', async () => {
    expect(codeOf('tools/permissions.ts').match(/applyPreset\(/g)).toHaveLength(1);
    // RPC改档位与重启读回各执行一次，参数和this都是实际装配的网关。
    const w = watchEngine();
    const presets = { ask: true, session: true, plan: true, full: true } satisfies Record<PermissionPreset, true>;
    for (const preset of Object.keys(presets) as PermissionPreset[]) {
      const first = await qStart();
      const from = callMark();
      await qRpc(first, 'permission.setPreset', { preset });
      expect(w.count('gateway.applyPreset', from)).toBe(1);
      expect(w.args('gateway.applyPreset')).toEqual([preset]);
      expectSame(w.spy('gateway.applyPreset').mock.contexts.at(-1), w.made('new PermissionGatewayImpl'));
      await first.handle.close();
      const second = await qStart({ dataDir: first.root });
      expect(w.count('gateway.applyPreset', from)).toBe(2);
      expect(w.args('gateway.applyPreset')).toEqual([preset]);
      expectSame(w.spy('gateway.applyPreset').mock.contexts.at(-1), w.made('new PermissionGatewayImpl'));
      expect(await qRpc(second, 'permission.getPreset')).toEqual({ preset });
      const db = w.made('db.open');
      db.prepare('INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES (?,?,0)').run('permission.preset', 'Q20A-INVALID');
      await second.handle.close();
      const badFrom = callMark();
      const bad = await qStart({ dataDir: first.root });
      expect(w.count('gateway.applyPreset', badFrom)).toBe(0);
      // getPreset 当前原样读库，不替产品规范化脏值；这里钉启动不 apply 非法档位。
    expect(await qRpc(bad, 'permission.getPreset')).toEqual({ preset: 'Q20A-INVALID' });
      await bad.handle.close();
    }
  }, 60000);

  it('(e) 生产路径只构造一次网关，询问函数是 broker', async () => {
    // 真装配各只造一个网关和broker，网关直接持有这份broker的ask。
    const w = watchEngine();
    await qStart();
    expect(w.count('new PermissionGatewayImpl')).toBe(1);
    expect(w.count('new PermissionBroker')).toBe(1);
    expect(w.args('new PermissionGatewayImpl')[0]).toBe(w.made('new PermissionBroker').ask);
  }, 60000);

  it('(f) 了结出口只有 broker：index.ts 不再自己维护待批表；关停与 stopRun 的写法和先后不变', async () => {
    // 无run的会话也有真正挂着的卡，删除先通过broker了结；不是靠自己的待批表。
    const w = watchEngine();
    const e = await qStart();
    const broker = w.made('new PermissionBroker');
    const idle = await qRpc(e, 'chat.sessions.create');
    const req = { kind: 'shell', detail: 'Q20A-IDLE', sessionId: idle.id, toolTitle: 'q' };
    const card = broker.ask(req, { signal: new AbortController().signal, origin: 'tool' });
    let from = callMark();
    await qRpc(e, 'chat.sessions.delete', { sessionId: idle.id, confirm: true });
    expect(w.seq(['broker.settleWhere', 'abort'], from)).toEqual(['broker.settleWhere']);
    expect(broker.pending()).toEqual([]);
    expect(await card).toMatchObject({ answer: 'deny', reason: 'cancelled', cause: 'session-deleted' });
    // 有run的删除走同一入口，卡收口→中止之间没有await，停止后才删会话。
    const active = await qPending(w, e);
    const gaps = yieldProbe(w.spy('broker.settleWhere'), w.spy('abort'));
    from = callMark();
    const deleting = qRpc(e, 'chat.sessions.delete', { sessionId: active.sid, confirm: true });
    await qUntil('删除中止已执行', () => w.count('abort', from) === 1);
    expect(w.seq(['broker.settleWhere', 'abort'], from)).toEqual(['broker.settleWhere', 'abort']);
    expect(gaps).toEqual([false]);
    active.release();
    await deleting;
    await active.result;
    // chat.cancel的收口抛错时finally仍abort；精确错误与中止次数都验证。
    const cancel = await qPending(w, e);
    const settle = w.spy('broker.settleWhere').getMockImplementation()!;
    w.spy('broker.settleWhere').mockImplementationOnce(function(this: unknown, ...args: unknown[]) {
      settle.apply(this, args);
      throw new Error('Q20A-CANCEL-SETTLE-FAIL');
    });
    from = callMark();
    await expect(qRpc(e, 'chat.cancel', { sessionId: cancel.sid })).rejects.toThrow('Q20A-CANCEL-SETTLE-FAIL');
    expect(w.seq(['broker.settleWhere', 'abort'], from)).toEqual(['broker.settleWhere', 'abort']);
    expect(w.args('broker.settleWhere')[1]).toEqual({ reason: 'cancelled', cause: 'user-stop' });
    expect(w.args('abort')).toEqual([]);
    cancel.release();
    await cancel.result;
    // 关停的全体收口仅一次，真正两张无run卡都以shutdown完成。
    const a = broker.ask({ ...req, sessionId: 'Q20A-A' }, { signal: new AbortController().signal, origin: 'tool' });
    const b = broker.ask({ ...req, sessionId: 'Q20A-B' }, { signal: new AbortController().signal, origin: 'tool' });
    from = callMark();
    await e.handle.close();
    expect(w.count('broker.settleWhere', from)).toBe(1);
    expect(broker.pending()).toEqual([]);
    expect(await a).toMatchObject({ reason: 'cancelled', cause: 'shutdown' });
    expect(await b).toMatchObject({ reason: 'cancelled', cause: 'shutdown' });
  }, 60000);

  it('(g) chat.prompt 清无人答复计数；permission.respond 把应答连接交给 broker', async () => {
    // 真prompt执行reset；直接调装配回调仍问该网关，边界id原样转交。
    const w = watchEngine();
    const e = await qStart();
    const from = callMark();
    const run = await qPending(w, e);
    expect(w.count('gateway.resetUnanswered', from)).toBe(1);
    expect(w.args('gateway.resetUnanswered')).toEqual([run.sid]);
    expect(w.spy('gateway.resetUnanswered').mock.contexts.at(-1)).toBe(w.made('new PermissionGatewayImpl'));
    const deps = w.args('new PermissionBroker')[0];
    qObserved(w, 'gateway.resetUnanswered', w.made('new PermissionGatewayImpl'), ['Q20A-NO-SESSION'], () => deps.onUserSeen('Q20A-NO-SESSION'));
    qObserved(w, 'rpc.lastConnSeq', w.spy('rpc.listen').mock.contexts[0], [], () => deps.connSeq());
    // RPC把连接的seq/指纹传给同一个broker，未知卡也返回该broker的原结果。
    const fp = await e.pair();
    const connections = [
      { conn: { ...probeConnection('local'), seq: 17, peerFingerprint: 'Q20A-CONNECTION' }, responder: { via: 'local', seq: 17, peerFingerprint: 'Q20A-CONNECTION' } },
      { conn: { ...probeConnection('local'), peerFingerprint: undefined }, responder: { via: 'local' } },
      { conn: { ...probeConnection('remote', undefined, fp), seq: 28 }, responder: { via: 'remote', seq: 28, peerFingerprint: fp } },
    ];
    for (const { conn, responder } of connections) {
      for (const decision of ['deny', 'allow-once', 'allow-session']) {
        const mark = callMark();
        const answer = await qRpc(e, 'permission.respond', { requestId: 'Q20A-NO-CARD', decision }, conn);
        expect(w.count('broker.respond', mark)).toBe(1);
        expect(w.args('broker.respond')).toEqual(['Q20A-NO-CARD', decision, responder]);
        expectSame(w.spy('broker.respond').mock.contexts.at(-1), w.made('new PermissionBroker'));
        expect(answer).toBe(w.spy('broker.respond').mock.results.at(-1)?.value);
      }
    }
    run.release();
    await run.result;
  }, 60000);

  it('(i) 网关接着「会话有没有 run 在跑」：run 在跑时到达的桥询问受无人答复上限约束（复核 A1 / B1）', async () => {
    // 回调随真实run占位变化：不存在/闲置false，MCP挂起时true，终态完成后false。
    const w = watchEngine();
    const e = await qStart();
    expect(w.count('new PermissionGatewayImpl')).toBe(1);
    const active = w.args('new PermissionGatewayImpl')[4].runActive;
    expect(typeof active).toBe('function');
    expect(active('Q20A-NEVER-EXISTED')).toBe(false);
    const s = await qRpc(e, 'chat.sessions.create');
    expect(active(s.id)).toBe(false);
    const run = await qPending(w, e);
    expect(active(run.sid)).toBe(true);
    run.release();
    await run.result;
    await qUntil('真实run占位已释放', () => !active(run.sid));
    expect(active(run.sid)).toBe(false);
  }, 60000);

  it('(h) 询问入口不引网关实现、不做命令分类；调度器只经询问入口对接权限', () => {
    const entry = codeOf('tools/permission-outcome.ts');
    expect(entry).not.toMatch(/classifyShellCommand/);
    expect(entry).not.toMatch(/from '\.\/permissions'/);
    expect(entry).not.toMatch(/from '\.\/permission-(text|broker)'/);
    const sched = codeOf('tools/scheduler.ts');
    const permImports = [...sched.matchAll(/from '(\.\/permission[\w-]*)'/g)].map(m => m[1]);
    expect(permImports).toEqual(['./permission-outcome']);
  });

  it('五处 MCP 失效钩子都接着', async () => {
    // 五个实际入口及upsert旧名都即时了结指定服务器的卡；不同服务器/会话不受影响。
    const w = watchEngine();
    const e = await qStart();
    const broker = w.made('new PermissionBroker');
    const sid = (await qRpc(e, 'chat.sessions.create')).id;
    const otherSid = (await qRpc(e, 'chat.sessions.create')).id;
    const entry = { name: 'Q20A-SRV', command: 'Q20A-NOT-EXECUTED', args: [], enabled: true };
    const changed = w.args('new MarketInstaller')[0].onMcpChanged;
    for (const kind of ['toggle', 'remove', 'upsert', 'session', 'market']) {
      if (kind !== 'upsert')
        await qRpc(e, 'mcp.servers.upsert', entry);
      await qRpc(e, 'mcp.servers.upsert', { ...entry, name: 'Q20A-OLD' });
      const settled: string[] = [];
      const ids = new Map<string, string>();
      const controllers: AbortController[] = [];
      const promises: Promise<any>[] = [];
      const ask = (label: string, server: string, sessionId = sid, requestKind = 'mcp') => {
        const controller = new AbortController();
        controllers.push(controller);
        const p = broker.ask({ kind: requestKind, detail: server, sessionId, toolTitle: 'q' }, { signal: controller.signal, origin: 'tool', issued: (id: string) => { ids.set(label, id); } });
        p.then(() => { settled.push(label); });
        promises.push(p);
        return p;
      };
      const selected = ask('selected', entry.name);
      const old = ask('old', 'Q20A-OLD');
      ask('other-server', 'Q20A-OTHER');
      ask('other-session', entry.name, otherSid);
      ask('shell', entry.name, sid, 'shell');
      const from = callMark();
      let cause: string;
      if (kind === 'toggle') {
        await qRpc(e, 'mcp.servers.toggle', { name: entry.name, enabled: true });
        expect(w.count('broker.settleWhere', from)).toBe(0);
        await qRpc(e, 'mcp.servers.toggle', { name: entry.name, enabled: false });
        cause = 'mcp-disabled';
        for (const [i, enabled] of [undefined, null, 0, 1, 'false', 'true', {}, []].entries()) {
          const extra = ask('toggle-' + i, entry.name);
          const boundary = callMark();
          await qRpc(e, 'mcp.servers.toggle', { name: entry.name, enabled });
          expect(w.count('broker.settleWhere', boundary)).toBe(1);
          expect(broker.statusOf(ids.get('toggle-' + i))?.status).toBe('settled');
          expect(await extra).toMatchObject({ reason: 'invalidated', cause: 'mcp-disabled' });
        }
      }
      else if (kind === 'remove') {
        await qRpc(e, 'mcp.servers.remove', { name: entry.name });
        cause = 'mcp-removed';
      }
      else if (kind === 'upsert') {
        await qRpc(e, 'mcp.servers.upsert', { ...entry, renameFrom: 'Q20A-OLD' });
        cause = 'mcp-config-changed';
      }
      else if (kind === 'session') {
        await qRpc(e, 'chat.sessions.setMcpDisabled', { sessionId: sid, servers: [entry.name] });
        cause = 'mcp-session-disabled';
      }
      else {
        changed(entry.name);
        cause = 'mcp-config-changed';
      }
      expect(w.count('broker.settleWhere', from)).toBe(kind === 'upsert' ? 2 : kind === 'toggle' ? 9 : 1);
      // 真卡完成后才判未被选中的卡仍挂着；直接同步入口已经走过全部收口调用。
      expect(broker.statusOf(ids.get('selected'))?.status).toBe('settled');
      if (kind === 'upsert')
        expect(broker.statusOf(ids.get('old'))?.status).toBe('settled');
      expect(await selected).toMatchObject({ answer: 'deny', reason: 'invalidated', cause });
      if (kind === 'upsert')
        expect(await old).toMatchObject({ reason: 'invalidated', cause });
      expect(settled.filter(label => !label.startsWith('toggle-')).sort()).toEqual((kind === 'upsert' ? ['selected', 'old', 'other-session'] : kind === 'session' ? ['selected'] : ['selected', 'other-session']).sort());
      if (kind === 'market') {
        expect(w.seq(['mcp.forget', 'broker.settleWhere'], from)).toEqual(['mcp.forget', 'broker.settleWhere']);
        expect(w.args('mcp.forget')).toEqual([entry.name]);
        expect(w.spy('mcp.forget').mock.contexts.at(-1)).toBe(w.made('new McpManager'));
      }
      for (const controller of controllers)
        controller.abort();
      await Promise.all(promises);
    }
  }, 60000);
});
