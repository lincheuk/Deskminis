/**
 * F13：PermissionGatewayImpl.decide——每个出口带对原因；许可范围与改动前逐项相同（差分 + 金表）；
 * 非允许的终态不留任何授权；连续无人答复有上限且只会多拒。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PermissionGatewayImpl, classifyShellCommand, MAX_UNANSWERED_STREAK,
  type PermissionClass, type PermissionLevel, type PermissionPreset, type PromptAnswer, type PromptControl,
} from '../src/minisd/tools/permissions';
import type { BridgePermissionKind, PermissionDecision, PermissionGateway, PermissionRequest } from '../src/minisd/tools/types';
import type { PermissionDenied, PermissionOutcome, UserDecision } from '../src/shared/permission';

afterEach(() => { vi.useRealTimers(); });

const req = (kind: PermissionRequest['kind'], detail: string, sessionId = 'S1'): PermissionRequest => ({ kind, detail, sessionId, toolTitle: 't' });

/** 记录每次询问、按测试给的函数答复的询问函数。 */
function scripted(answer: (r: PermissionRequest, n: number, ctl: PromptControl) => Promise<PromptAnswer | UserDecision> | PromptAnswer | UserDecision | undefined) {
  const calls: PermissionRequest[] = [];
  const ctls: PromptControl[] = [];
  const prompt = async (r: PermissionRequest, ctl: PromptControl): Promise<PromptAnswer | UserDecision> => {
    calls.push(r); ctls.push(ctl);
    return (await answer(r, calls.length, ctl)) as PromptAnswer | UserDecision;
  };
  return { prompt, calls, ctls };
}
const never = (): Promise<never> => new Promise<never>(() => { /* 永不答复 */ });

// ---------------------------------------------------------------------------------------------------------------
// G2 的对照物：改动前 PermissionGatewayImpl 的逐字副本（base ccbca3b 的 permissions.ts:301-424，
// 含 DEFAULT_LEVELS、BRIDGE_ONCE_TTL_MS、字段、构造、applyPreset、三个 grant、check）。分类器从 src 引入。
// 这一段不要跟着产品代码改：它就是「原行为」。
// ---------------------------------------------------------------------------------------------------------------
type LegacyPrompt = (req: PermissionRequest) => Promise<'allow-once' | 'allow-session' | 'deny'>;
const DEFAULT_LEVELS: Record<PermissionClass, PermissionLevel> = {
  danger: 'notAllowed',
  readonly: 'bypass',
  gated: 'askOnce', 'file-write': 'askOnce', 'file-read': 'askOnce',
  'web-fetch': 'askOnce',
  'web-search': 'askOnce',
  'mcp': 'askOnce',
  'bridge-device': 'bypass',
  'bridge-notify': 'askOnce',
  'bridge-clipboard-read': 'askOnce',
  'bridge-clipboard-write': 'askOnce',
  'bridge-open': 'askOnce',
  'bridge-speak': 'askOnce',
  'bridge-screenshot': 'askOnce',
};
const BRIDGE_ONCE_TTL_MS = 120_000;

class LegacyGateway implements PermissionGateway {
  private levels: Record<PermissionClass, PermissionLevel>;
  private sessionGrants = new Set<string>();
  private sessionBridgeGrants = new Set<string>();
  private bridgeOnce = new Map<string, { count: number; grantedAt: number }>();

  constructor(
    private prompt: LegacyPrompt,
    levels?: Partial<Record<PermissionClass, PermissionLevel>>,
    private askTimeoutMs = 90000,
    private now: () => number = Date.now,
  ) {
    this.levels = { ...DEFAULT_LEVELS, ...levels };
  }

  applyPreset(preset: PermissionPreset): void {
    if (preset === 'full') {
      this.levels = {
        danger: 'notAllowed',
        readonly: 'bypass', gated: 'bypass', 'file-write': 'bypass', 'file-read': 'bypass',
        'web-fetch': 'bypass',
        'web-search': 'bypass',
        'mcp': 'bypass',
        'bridge-device': 'bypass', 'bridge-notify': 'bypass',
        'bridge-clipboard-read': 'bypass', 'bridge-clipboard-write': 'bypass',
        'bridge-open': 'bypass', 'bridge-speak': 'bypass', 'bridge-screenshot': 'bypass',
      };
    } else {
      this.levels = { ...DEFAULT_LEVELS };
    }
  }

  grantBridgeSession(sessionId: string, kind: BridgePermissionKind): void {
    this.sessionBridgeGrants.add(`${sessionId}\u0000${kind}`);
  }

  grantBridgeOnce(sessionId: string, kind: BridgePermissionKind): void {
    const key = `${sessionId}\u0000${kind}`;
    const cur = this.bridgeOnce.get(key);
    this.bridgeOnce.set(key, { count: (cur?.count ?? 0) + 1, grantedAt: this.now() });
  }

  hasBridgeGrant(sessionId: string): boolean {
    const prefix = `${sessionId}\u0000`;
    for (const k of this.sessionBridgeGrants) if (k.startsWith(prefix)) return true;
    for (const [k, v] of this.bridgeOnce) {
      if (k.startsWith(prefix) && this.now() - v.grantedAt <= BRIDGE_ONCE_TTL_MS) return true;
    }
    return false;
  }

  async check(req: PermissionRequest): Promise<PermissionDecision> {
    const cls: PermissionClass = req.kind === 'shell' ? classifyShellCommand(req.detail) : req.kind;
    if (this.levels[cls] === 'bypass') return 'allow';
    if (this.levels[cls] === 'notAllowed') return 'deny';
    const grantKey = `${req.sessionId}\u0000${req.kind}\u0000${req.detail}`;
    if (this.sessionGrants.has(grantKey)) return 'allow';

    if (req.kind.startsWith('bridge-')) {
      const bKey = `${req.sessionId}\u0000${req.kind}`;
      if (this.sessionBridgeGrants.has(bKey)) return 'allow';
      const once = this.bridgeOnce.get(bKey);
      if (once) {
        if (this.now() - once.grantedAt <= BRIDGE_ONCE_TTL_MS) {
          if (once.count > 1) once.count -= 1; else this.bridgeOnce.delete(bKey);
          return 'allow';
        }
        this.bridgeOnce.delete(bKey);
      }
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'deny'>(res => { timer = setTimeout(() => res('deny'), this.askTimeoutMs); });
    let answer: 'allow-once' | 'allow-session' | 'deny';
    try {
      answer = await Promise.race([this.prompt(req), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (answer === 'allow-session') { this.sessionGrants.add(grantKey); return 'allow'; }
    return answer === 'allow-once' ? 'allow' : 'deny';
  }
}

// ---------------------------------------------------------------------------------------------------------------

const BRIDGE_KINDS: BridgePermissionKind[] = ['bridge-notify', 'bridge-clipboard-read', 'bridge-clipboard-write', 'bridge-open', 'bridge-speak', 'bridge-screenshot', 'bridge-device'];
const PLAIN_KINDS: PermissionRequest['kind'][] = ['file-write', 'file-read', 'web-fetch', 'web-search', 'mcp'];
const SHELL = {
  readonly: ['git status', 'dir', 'Get-Content a.txt'],
  /** 只读写法，但碰数据根 / 网络路径 / 环境变量：回落到询问 */
  readonlyAsks: ['Get-Content $env:APPDATA\\DeskMinis\\minis.db', 'dir \\\\host\\share', 'gci env:'],
  gated: ['npm install'],
  danger: ['Remove-Item x', 'rm -r y'],
};
const PRESETS: Exclude<PermissionPreset, 'plan'>[] = ['ask', 'session', 'full'];

describe('语料自检：命令分级与预期一致（语料错了，G2 / G2b 就不可信）', () => {
  it('分类', () => {
    for (const c of SHELL.readonly) expect(classifyShellCommand(c), c).toBe('readonly');
    for (const c of [...SHELL.readonlyAsks, ...SHELL.gated]) expect(classifyShellCommand(c), c).toBe('gated');
    for (const c of SHELL.danger) expect(classifyShellCommand(c), c).toBe('danger');
  });
});

describe('G1 decide 各出口的 via / reason / cause', () => {
  it('档位 bypass：不询问，level-bypass', async () => {
    const s = scripted(() => 'deny');
    const gw = new PermissionGatewayImpl(s.prompt);
    expect(await gw.decide(req('shell', 'git status'))).toEqual({ decision: 'allow', via: 'level-bypass' });
    expect(await gw.decide(req('bridge-device', 'windows-device info'))).toEqual({ decision: 'allow', via: 'level-bypass' });
    expect(s.calls.length).toBe(0);
  });

  it('notAllowed：不询问；危险命令是 shell-danger，其余类目是 level-not-allowed；各报一条 onDenied', async () => {
    const s = scripted(() => 'allow-once');
    const noted: { r: PermissionRequest; d: PermissionDenied; o: unknown }[] = [];
    const gw = new PermissionGatewayImpl(s.prompt, { 'file-read': 'notAllowed' }, 90000, undefined, { onDenied: (r, d, o) => { noted.push({ r, d, o }); } });
    expect(await gw.decide(req('shell', 'Remove-Item x'), { toolUseId: 'T1' })).toEqual({ decision: 'deny', reason: 'rule-blocked', cause: 'shell-danger' });
    expect(await gw.decide(req('file-read', 'C:\\a.txt'))).toEqual({ decision: 'deny', reason: 'rule-blocked', cause: 'level-not-allowed' });
    expect(s.calls.length).toBe(0);
    expect(noted.map(n => [n.r.kind, n.d.cause, n.o])).toEqual([
      ['shell', 'shell-danger', { toolUseId: 'T1', origin: 'tool' }],
      ['file-read', 'level-not-allowed', { origin: 'tool' }],
    ]);
  });

  it('三种用户答复：user-once / user-session / user-denied；会话授权命中是 session-grant', async () => {
    const answers: UserDecision[] = ['allow-once', 'allow-session', 'deny'];
    const s = scripted((_r, n) => answers[n - 1]);
    const gw = new PermissionGatewayImpl(s.prompt);
    expect(await gw.decide(req('web-fetch', 'u1'))).toEqual({ decision: 'allow', via: 'user-once' });
    expect(await gw.decide(req('web-fetch', 'u2'))).toEqual({ decision: 'allow', via: 'user-session' });
    expect(await gw.decide(req('web-fetch', 'u3'))).toMatchObject({ decision: 'deny', reason: 'user-denied' });
    expect(await gw.decide(req('web-fetch', 'u2'))).toEqual({ decision: 'allow', via: 'session-grant' });
    expect(s.calls.length).toBe(3);
  });

  it('桥合并授权（会话级 / 一次性）：bridge-grant', async () => {
    const s = scripted(() => 'deny');
    const gw = new PermissionGatewayImpl(s.prompt);
    gw.grantBridgeSession('S1', 'bridge-open');
    gw.grantBridgeOnce('S1', 'bridge-speak');
    expect(await gw.decide(req('bridge-open', 'windows-open open'))).toEqual({ decision: 'allow', via: 'bridge-grant' });
    expect(await gw.decide(req('bridge-speak', 'windows-speak say'))).toEqual({ decision: 'allow', via: 'bridge-grant' });
    expect(s.calls.length).toBe(0);
    // 一次性授权已消费：再来要询问
    expect(await gw.decide(req('bridge-speak', 'windows-speak say'))).toMatchObject({ decision: 'deny', reason: 'user-denied' });
    expect(s.calls.length).toBe(1);
  });

  it('兜底时限：timeout / unanswered，带等待时长；询问函数收到的 signal 被 abort，原因是超时', async () => {
    vi.useFakeTimers();
    const s = scripted(never);
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 1000);
    const p = gw.decide(req('web-fetch', 'u'));
    await vi.advanceTimersByTimeAsync(999);
    expect(s.ctls[0].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toEqual({ decision: 'deny', reason: 'timeout', cause: 'unanswered', waitedMs: 1000 });
    expect(s.ctls[0].signal.aborted).toBe(true);
    expect(s.ctls[0].signal.reason).toMatchObject({ reason: 'timeout', cause: 'unanswered' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('询问函数先答复：兜底定时器已清', async () => {
    vi.useFakeTimers();
    const gw = new PermissionGatewayImpl(scripted(() => 'allow-once').prompt, undefined, 1000);
    expect((await gw.decide(req('web-fetch', 'u'))).decision).toBe('allow');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('询问方的 signal 已取消：不询问、不记审计；等待中取消：cancelled，cause 取自 signal 的 reason', async () => {
    const s = scripted(never);
    const noted: unknown[] = [];
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 90000, undefined, { onDenied: (...a) => { noted.push(a); } });
    const pre = new AbortController(); pre.abort('session-deleted');
    expect(await gw.decide(req('web-fetch', 'u'), { signal: pre.signal })).toEqual({ decision: 'deny', reason: 'cancelled', cause: 'session-deleted' });
    expect(s.calls.length).toBe(0);

    const c = new AbortController();
    const p = gw.decide(req('web-fetch', 'u'), { signal: c.signal, toolUseId: 'T9', origin: 'tool' });
    expect(s.calls.length).toBe(1);
    expect(s.ctls[0]).toMatchObject({ toolUseId: 'T9', origin: 'tool' });
    c.abort();
    expect(await p).toMatchObject({ decision: 'deny', reason: 'cancelled', cause: 'user-stop' });
    expect(s.ctls[0].signal.reason).toMatchObject({ reason: 'cancelled', cause: 'user-stop' });
    expect(noted).toEqual([]);
  });

  it('卡片 id：询问函数经 issued 回报的 id 进结果（即使答复里没带）；onIssued 抛错被吞掉', async () => {
    const s = scripted((_r, _n, ctl) => { ctl.issued?.('CARD-7'); return 'deny'; });
    const gw = new PermissionGatewayImpl(s.prompt);
    const seen: string[] = [];
    expect(await gw.decide(req('web-fetch', 'u'), { onIssued: id => { seen.push(id); throw new Error('观察者炸了'); } }))
      .toMatchObject({ decision: 'deny', reason: 'user-denied', requestId: 'CARD-7' });
    expect(seen).toEqual(['CARD-7']);
  });

  it('check 恒等于 decide 的 decision', async () => {
    const gw = new PermissionGatewayImpl(scripted((_r, n) => (n === 1 ? 'allow-once' : 'deny')).prompt);
    expect(await gw.check(req('web-fetch', 'a'))).toBe('allow');
    expect(await gw.check(req('web-fetch', 'b'))).toBe('deny');
    expect(await gw.check(req('shell', 'Remove-Item x'))).toBe('deny');
    expect(await gw.check(req('shell', 'dir'))).toBe('allow');
  });
});

describe('G2 差分：新 decide 的许可范围与改动前的 check 逐项相同', () => {
  type Step =
    | { do: 'ask'; r: PermissionRequest }
    | { do: 'grant-session' | 'grant-once'; sid: string; kind: BridgePermissionKind }
    | { do: 'tick'; ms: number }
    | { do: 'has'; sid: string };

  function corpus(): Step[] {
    const steps: Step[] = [];
    const ask = (r: PermissionRequest): void => { steps.push({ do: 'ask', r }); };
    for (const c of [...SHELL.readonly, ...SHELL.readonlyAsks, ...SHELL.gated, ...SHELL.danger]) {
      ask(req('shell', c)); ask(req('shell', c)); ask(req('shell', c, 'S2'));
    }
    for (const k of PLAIN_KINDS) {
      ask(req(k, 'detail-A')); ask(req(k, 'detail-A')); ask(req(k, 'detail-A'));
      ask(req(k, 'detail-A', 'S2')); ask(req(k, 'detail-B')); ask(req(k, 'Remove-Item x'));
    }
    for (const k of BRIDGE_KINDS) { ask(req(k, 'windows-x y')); ask(req(k, 'windows-x y')); ask(req(k, 'windows-x z', 'S2')); }
    steps.push({ do: 'has', sid: 'S1' });
    steps.push({ do: 'grant-session', sid: 'S1', kind: 'bridge-open' });
    ask(req('bridge-open', 'windows-open open')); ask(req('bridge-open', 'windows-open open')); ask(req('bridge-open', 'windows-open open', 'S2'));
    steps.push({ do: 'has', sid: 'S1' }, { do: 'has', sid: 'S2' });
    steps.push({ do: 'grant-once', sid: 'S2', kind: 'bridge-speak' }, { do: 'grant-once', sid: 'S2', kind: 'bridge-speak' });
    for (let i = 0; i < 4; i++) ask(req('bridge-speak', 'windows-speak say', 'S2'));
    steps.push({ do: 'has', sid: 'S2' });
    // 一次性授权过期：不消费，回到询问
    steps.push({ do: 'grant-once', sid: 'S3', kind: 'bridge-notify' }, { do: 'has', sid: 'S3' }, { do: 'tick', ms: 120_001 }, { do: 'has', sid: 'S3' });
    ask(req('bridge-notify', 'windows-notify show', 'S3')); ask(req('bridge-notify', 'windows-notify show', 'S3'));
    // TTL 之内
    steps.push({ do: 'grant-once', sid: 'S3', kind: 'bridge-screenshot' }, { do: 'tick', ms: 120_000 });
    ask(req('bridge-screenshot', 'windows-screenshot capture', 'S3')); ask(req('bridge-screenshot', 'windows-screenshot capture', 'S3'));
    return steps;
  }

  /** 第 n 次询问的答复：三种轮着来，两边用同一条序列。 */
  const ANSWERS: UserDecision[] = ['allow-once', 'deny', 'allow-session', 'deny', 'allow-session', 'allow-once', 'deny'];
  const answerOf = (n: number): UserDecision => ANSWERS[(n - 1) % ANSWERS.length];

  async function runOld(preset: PermissionPreset, steps: Step[]) {
    let t = 1_000_000;
    const asked: PermissionRequest[] = [];
    const gw = new LegacyGateway(async r => { asked.push(r); return answerOf(asked.length); }, undefined, 90000, () => t);
    gw.applyPreset(preset);
    const out: unknown[] = [];
    for (const s of steps) {
      if (s.do === 'ask') out.push(await gw.check(s.r));
      else if (s.do === 'grant-session') gw.grantBridgeSession(s.sid, s.kind);
      else if (s.do === 'grant-once') gw.grantBridgeOnce(s.sid, s.kind);
      else if (s.do === 'tick') t += s.ms;
      else out.push(gw.hasBridgeGrant(s.sid));
    }
    return { out, asked };
  }

  async function runNew(preset: PermissionPreset, steps: Step[], how: 'decide' | 'check') {
    let t = 1_000_000;
    const asked: PermissionRequest[] = [];
    const gw = new PermissionGatewayImpl(async r => { asked.push(r); return answerOf(asked.length); }, undefined, 90000, () => t);
    gw.applyPreset(preset);
    const out: unknown[] = [];
    const outcomes: PermissionOutcome[] = [];
    for (const s of steps) {
      if (s.do === 'ask') {
        if (how === 'check') out.push(await gw.check(s.r));
        else { const o = await gw.decide(s.r); outcomes.push(o); out.push(o.decision); }
      } else if (s.do === 'grant-session') gw.grantBridgeSession(s.sid, s.kind);
      else if (s.do === 'grant-once') gw.grantBridgeOnce(s.sid, s.kind);
      else if (s.do === 'tick') t += s.ms;
      else out.push(gw.hasBridgeGrant(s.sid));
    }
    return { out, asked, outcomes };
  }

  it('语料够大', () => {
    expect(corpus().filter(s => s.do === 'ask').length).toBeGreaterThanOrEqual(60);
  });

  it.each(PRESETS)('%s 档：决定序列、询问序列逐项相等', async preset => {
    const steps = corpus();
    const old = await runOld(preset, steps);
    for (const how of ['decide', 'check'] as const) {
      const cur = await runNew(preset, steps, how);
      expect(cur.out, `${how} 的决定序列`).toEqual(old.out);
      expect(cur.asked, `${how} 的询问序列`).toEqual(old.asked);
    }
    // 差分不是空转：ask / session 档确实问过、也确实有放有拒
    if (preset !== 'full') {
      expect(old.asked.length).toBeGreaterThan(20);
      expect(old.out).toContain('allow'); expect(old.out).toContain('deny');
    }
  });

  it('放行只有四种来源，且与「问没问」对得上', async () => {
    for (const preset of PRESETS) {
      const cur = await runNew(preset, corpus(), 'decide');
      for (const o of cur.outcomes) {
        if (o.decision === 'allow') expect(['level-bypass', 'session-grant', 'bridge-grant', 'user-once', 'user-session']).toContain(o.via);
        else expect(['user-denied', 'rule-blocked']).toContain(o.reason);
      }
      if (preset === 'full') {
        expect(cur.asked.length).toBe(0);
        for (const o of cur.outcomes) expect(o.decision === 'allow' ? o.via : o.cause).toMatch(/^(level-bypass|shell-danger)$/);
      }
    }
  });
});

describe('G2b 金表：三档 × 每个类目，期望写死在这里', () => {
  type Cell = 'allow' | 'deny' | 'ask';
  const SAMPLES: { cls: PermissionClass; r: PermissionRequest }[] = [
    { cls: 'danger', r: req('shell', 'Remove-Item x') },
    { cls: 'readonly', r: req('shell', 'git status') },
    { cls: 'gated', r: req('shell', 'npm install') },
    ...PLAIN_KINDS.map(k => ({ cls: k as PermissionClass, r: req(k, 'detail') })),
    ...BRIDGE_KINDS.map(k => ({ cls: k as PermissionClass, r: req(k, 'windows-x y') })),
  ];
  const ASK_ROW: Record<PermissionClass, Cell> = {
    danger: 'deny', readonly: 'allow', gated: 'ask', 'file-write': 'ask', 'file-read': 'ask', 'web-fetch': 'ask', 'web-search': 'ask', mcp: 'ask',
    'bridge-device': 'allow', 'bridge-notify': 'ask', 'bridge-clipboard-read': 'ask', 'bridge-clipboard-write': 'ask',
    'bridge-open': 'ask', 'bridge-speak': 'ask', 'bridge-screenshot': 'ask',
  };
  const FULL_ROW: Record<PermissionClass, Cell> = {
    danger: 'deny', readonly: 'allow', gated: 'allow', 'file-write': 'allow', 'file-read': 'allow', 'web-fetch': 'allow', 'web-search': 'allow', mcp: 'allow',
    'bridge-device': 'allow', 'bridge-notify': 'allow', 'bridge-clipboard-read': 'allow', 'bridge-clipboard-write': 'allow',
    'bridge-open': 'allow', 'bridge-speak': 'allow', 'bridge-screenshot': 'allow',
  };
  const GOLD: Record<Exclude<PermissionPreset, 'plan'>, Record<PermissionClass, Cell>> = { ask: ASK_ROW, session: ASK_ROW, full: FULL_ROW };

  it('覆盖了全部 15 个类目', () => {
    expect(SAMPLES.map(s => s.cls).sort()).toEqual(Object.keys(ASK_ROW).sort());
  });

  it.each(PRESETS)('%s 档逐格相等；不问即放行的 via 只能是 level-bypass', async preset => {
    for (const { cls, r } of SAMPLES) {
      // 每格一个新网关：不让上一格的答复影响这一格
      const s = scripted(() => 'deny');
      const gw = new PermissionGatewayImpl(s.prompt);
      gw.applyPreset(preset);
      const o = await gw.decide(r);
      const cell: Cell = s.calls.length > 0 ? 'ask' : o.decision;
      expect(cell, `${preset} / ${cls}`).toBe(GOLD[preset][cls]);
      if (cell === 'allow') expect(o, `${preset} / ${cls}`).toEqual({ decision: 'allow', via: 'level-bypass' });
      if (cell === 'deny') expect(o, `${preset} / ${cls}`).toEqual({ decision: 'deny', reason: 'rule-blocked', cause: 'shell-danger' });
    }
  });

  it('缺省（不调 applyPreset）与 ask 档相同', async () => {
    for (const { cls, r } of SAMPLES) {
      const s = scripted(() => 'deny');
      const o = await new PermissionGatewayImpl(s.prompt).decide(r);
      expect(s.calls.length > 0 ? 'ask' : o.decision, cls).toBe(ASK_ROW[cls]);
    }
  });
});

describe('G3 非允许的终态不留任何授权', () => {
  const SHELL_WITH_BRIDGE = req('shell', 'windows-clipboard get');
  const cases: { name: string; answer: () => Promise<PromptAnswer | UserDecision> | PromptAnswer | UserDecision; reason: string; abort?: boolean; timeout?: boolean }[] = [
    { name: '用户拒绝', answer: () => 'deny', reason: 'user-denied' },
    { name: '超时（网关兜底）', answer: never, reason: 'timeout', timeout: true },
    { name: '超时（询问函数给的）', answer: () => ({ answer: 'deny', reason: 'timeout' }), reason: 'timeout' },
    { name: '取消', answer: never, reason: 'cancelled', abort: true },
    { name: '失效', answer: () => ({ answer: 'deny', reason: 'invalidated', cause: 'mcp-disabled' }), reason: 'invalidated' },
    { name: '说不清的答复', answer: () => 'allow' as never, reason: 'unspecified' },
  ];
  it.each(cases)('$name 之后：同一请求再来仍会询问；没有桥授权', async c => {
    vi.useFakeTimers();
    let n = 0;
    const s = scripted(() => (++n === 1 ? c.answer() : 'deny'));
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 1000);
    const ac = new AbortController();
    const p = gw.decide(SHELL_WITH_BRIDGE, { signal: ac.signal });
    if (c.abort) ac.abort();
    if (c.timeout) await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toMatchObject({ decision: 'deny', reason: c.reason });
    expect(gw.hasBridgeGrant('S1')).toBe(false);
    expect(await gw.decide(SHELL_WITH_BRIDGE)).toMatchObject({ decision: 'deny', reason: 'user-denied' });
    expect(s.calls.length, '第二次仍然询问').toBe(2);
  });

  it('放弃之后旧式询问函数晚到的 allow-session 被丢弃，不写会话授权', async () => {
    vi.useFakeTimers();
    const resolvers: ((d: UserDecision) => void)[] = [];
    const calls: PermissionRequest[] = [];
    const gw = new PermissionGatewayImpl(r => new Promise<UserDecision>(res => { calls.push(r); resolvers.push(res); }), undefined, 1000);
    const p = gw.decide(req('web-fetch', 'u'));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await p).decision).toBe('deny');
    resolvers[0]('allow-session');
    await vi.advanceTimersByTimeAsync(0);
    const again = gw.decide(req('web-fetch', 'u'));
    expect(calls.length, '没有留下会话授权：再来仍要询问').toBe(2);
    resolvers[1]('deny');
    expect((await again).decision).toBe('deny');
  });
});

describe('G4 询问函数答复的归一', () => {
  it.each([
    ['allow-once', { decision: 'allow', via: 'user-once' }],
    ['allow-session', { decision: 'allow', via: 'user-session' }],
    ['deny', { decision: 'deny', reason: 'user-denied' }],
    [{ answer: 'allow-once', requestId: 'C1' }, { decision: 'allow', via: 'user-once', requestId: 'C1' }],
    [{ answer: 'allow-session' }, { decision: 'allow', via: 'user-session' }],
    [{ answer: 'deny', reason: 'user-denied', requestId: 'C2', waitedMs: 5 }, { decision: 'deny', reason: 'user-denied', requestId: 'C2', waitedMs: 5 }],
    [{ answer: 'deny', reason: 'timeout' }, { decision: 'deny', reason: 'timeout', cause: 'unanswered' }],
    [{ answer: 'deny', reason: 'cancelled', cause: 'shutdown' }, { decision: 'deny', reason: 'cancelled', cause: 'shutdown' }],
    [{ answer: 'deny', reason: 'invalidated', cause: 'mcp-removed' }, { decision: 'deny', reason: 'invalidated', cause: 'mcp-removed' }],
    [{ answer: 'deny', reason: 'invalidated', cause: '不认识的细分' }, { decision: 'deny', reason: 'invalidated' }],
    [{ answer: 'deny', reason: '胡写' }, { decision: 'deny', reason: 'unspecified', cause: 'invalid-outcome' }],
    [{ answer: 'deny', reason: 'rule-blocked' }, { decision: 'deny', reason: 'unspecified', cause: 'invalid-outcome' }],
    [{ answer: 'deny' }, { decision: 'deny', reason: 'unspecified', cause: 'invalid-outcome' }],
    [{ answer: 'allow' }, { decision: 'deny', reason: 'unspecified', cause: 'invalid-outcome' }],
    [{ decision: 'allow', via: 'user-once' }, { decision: 'deny', reason: 'unspecified', cause: 'invalid-outcome' }],
    [undefined, { decision: 'deny', reason: 'unspecified', cause: 'invalid-outcome' }],
    [null, { decision: 'deny', reason: 'unspecified', cause: 'invalid-outcome' }],
    ['allow', { decision: 'deny', reason: 'unspecified', cause: 'invalid-outcome' }],
    ['ALLOW-ONCE', { decision: 'deny', reason: 'unspecified', cause: 'invalid-outcome' }],
    [true, { decision: 'deny', reason: 'unspecified', cause: 'invalid-outcome' }],
  ])('%j', async (answer, expected) => {
    const gw = new PermissionGatewayImpl(async () => answer as never);
    expect(await gw.decide(req('web-fetch', 'u'))).toEqual(expected);
  });

  it('取属性抛错的答复：拒绝，不抛', async () => {
    // 只让 answer 抛（连 then 也抛的对象在 Promise 兑现时就被拒绝了，那是「询问函数失败」的路径，见下一条）
    const evil = Object.defineProperty({}, 'answer', { get() { throw new Error('注入'); }, enumerable: true });
    const gw = new PermissionGatewayImpl(async () => evil as never);
    expect(await gw.decide(req('web-fetch', 'u'))).toEqual({ decision: 'deny', reason: 'unspecified', cause: 'invalid-outcome' });
  });

  it('询问函数同步抛错 / 返回被拒绝的 Promise：decide 原样拒绝，定时器已清', async () => {
    vi.useFakeTimers();
    const sync = new PermissionGatewayImpl((() => { throw new Error('同步炸了'); }) as never, undefined, 1000);
    await expect(sync.decide(req('web-fetch', 'u'))).rejects.toThrow('同步炸了');
    const rejected = new PermissionGatewayImpl(async () => { throw new Error('异步炸了'); }, undefined, 1000);
    await expect(rejected.decide(req('web-fetch', 'u'))).rejects.toThrow('异步炸了');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('G6–G10 连续无人答复的上限', () => {
  /** 发起一次询问并让它超时（fake timers）。 */
  async function timedOut(gw: PermissionGatewayImpl, r: PermissionRequest, opts?: Parameters<PermissionGatewayImpl['decide']>[1]): Promise<PermissionOutcome> {
    const p = gw.decide(r, opts);
    await vi.advanceTimersByTimeAsync(20);
    return p;
  }

  it('G6 同一会话三个不同请求依次无人答复：只询问 2 次，第三个是 timeout / unattended、没有 requestId，报一条 onDenied', async () => {
    vi.useFakeTimers();
    const s = scripted(never);
    const noted: PermissionDenied[] = [];
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20, undefined, { onDenied: (_r, d) => { noted.push(d); } });
    expect(MAX_UNANSWERED_STREAK).toBe(2);
    expect(await timedOut(gw, req('web-fetch', 'u1'))).toMatchObject({ reason: 'timeout', cause: 'unanswered' });
    expect(await timedOut(gw, req('file-write', 'p2'))).toMatchObject({ reason: 'timeout', cause: 'unanswered' });
    const third = await gw.decide(req('mcp', 'srv'));
    expect(third).toEqual({ decision: 'deny', reason: 'timeout', cause: 'unattended' });
    expect(s.calls.length).toBe(2);
    expect(noted).toEqual([{ decision: 'deny', reason: 'timeout', cause: 'unattended' }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['allow-once', 'allow-session', 'deny'] as const)('G7 清零：计到 1 之后用户答复一次（%s），再连着两次无人答复才到上限', async answer => {
    vi.useFakeTimers();
    let mode: 'silent' | 'answer' = 'silent';
    const s = scripted(() => (mode === 'silent' ? never() : answer));
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20);
    await timedOut(gw, req('web-fetch', 'u1'));
    mode = 'answer';
    await gw.decide(req('web-fetch', 'u2'));
    mode = 'silent';
    await timedOut(gw, req('web-fetch', 'u3'));
    // 没清零的话这里已经是第 2 次，下一个就不问了
    expect(await timedOut(gw, req('web-fetch', 'u4'))).toMatchObject({ cause: 'unanswered' });
    expect(await gw.decide(req('web-fetch', 'u5'))).toMatchObject({ cause: 'unattended' });
    expect(s.calls.length).toBe(4);
  });

  it('G7 清零：resetUnanswered 之后重新询问；只清这个会话', async () => {
    vi.useFakeTimers();
    const s = scripted(never);
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20);
    for (const sid of ['S1', 'S2']) { await timedOut(gw, req('web-fetch', 'a', sid)); await timedOut(gw, req('web-fetch', 'b', sid)); }
    expect(await gw.decide(req('web-fetch', 'c', 'S1'))).toMatchObject({ cause: 'unattended' });
    gw.resetUnanswered('S1');
    expect(await timedOut(gw, req('web-fetch', 'c', 'S1'))).toMatchObject({ cause: 'unanswered' });
    expect(await gw.decide(req('web-fetch', 'c', 'S2')), 'S2 没被清').toMatchObject({ cause: 'unattended' });
  });

  it('G8 取消、失效不计数；别的会话不受影响；桥发起的询问不计数、也不受限', async () => {
    vi.useFakeTimers();
    let answer: () => Promise<PromptAnswer | UserDecision> | PromptAnswer = never;
    const s = scripted(() => answer());
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20);
    // 取消三次、失效三次：都不计数
    for (let i = 0; i < 3; i++) {
      const c = new AbortController();
      const p = gw.decide(req('web-fetch', `c${i}`), { signal: c.signal });
      c.abort();
      expect((await p as PermissionDenied).reason).toBe('cancelled');
    }
    answer = () => ({ answer: 'deny', reason: 'invalidated' });
    for (let i = 0; i < 3; i++) expect((await gw.decide(req('mcp', `m${i}`)) as PermissionDenied).reason).toBe('invalidated');
    // 桥发起的询问超时三次：不计数
    answer = never;
    for (let i = 0; i < 3; i++) expect(await timedOut(gw, req('bridge-open', 'windows-open open'), { origin: 'bridge' })).toMatchObject({ cause: 'unanswered' });
    // 以上都没让 S1 的计数前进：工具发起的询问照常弹卡
    const before = s.calls.length;
    expect(await timedOut(gw, req('web-fetch', 'x1'))).toMatchObject({ cause: 'unanswered' });
    expect(await timedOut(gw, req('web-fetch', 'x2'))).toMatchObject({ cause: 'unanswered' });
    expect(s.calls.length).toBe(before + 2);
    // S1 到上限：工具询问不再弹卡；S2 不受影响；S1 的桥询问照常弹卡
    expect(await gw.decide(req('web-fetch', 'x3'))).toMatchObject({ cause: 'unattended' });
    expect(await timedOut(gw, req('web-fetch', 'y', 'S2'))).toMatchObject({ cause: 'unanswered' });
    expect(await timedOut(gw, req('bridge-open', 'windows-open open'), { origin: 'bridge' })).toMatchObject({ cause: 'unanswered' });
    expect(s.calls.length).toBe(before + 4);
  });

  // ---- G8b：run 在跑时到达的桥询问也受上限管（复核 A1 / B1）----
  // 上面的 G8 用的是没接 runActive 钩子的网关，等于「没有 run 在跑」：桥询问是用户在终端面板里手动跑的命令，不计数、不受限。
  // 桥询问一律不受限的话，agent 的 shell 子进程（命令已获会话授权、又探测不到桥触发）能无人值守地一张接一张弹桥卡，
  // 一直弹到回合上限。所以该会话有 run 在跑时，桥询问与工具询问同样计数、同样受限。
  const BRIDGE = (sid = 'S1'): PermissionRequest => req('bridge-open', 'windows-open open', sid);
  const UNATTENDED = { decision: 'deny', reason: 'timeout', cause: 'unattended' };

  it('G8b run 在跑：桥询问连续两次无人答复后不再弹卡（timeout / unattended），报一条 origin 为 bridge 的 onDenied', async () => {
    vi.useFakeTimers();
    const s = scripted(never);
    const noted: { d: PermissionDenied; origin?: string }[] = [];
    const probed: string[] = [];
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20, undefined, {
      onDenied: (_r, d, o) => { noted.push({ d, origin: o?.origin }); },
      runActive: sid => { probed.push(sid); return true; },
    });
    expect(await timedOut(gw, BRIDGE(), { origin: 'bridge' })).toMatchObject({ reason: 'timeout', cause: 'unanswered' });
    expect(await timedOut(gw, BRIDGE(), { origin: 'bridge' })).toMatchObject({ reason: 'timeout', cause: 'unanswered' });
    // 第三次起：不弹卡、不等时限
    for (let i = 0; i < 3; i++) expect(await gw.decide(BRIDGE(), { origin: 'bridge' })).toEqual(UNATTENDED);
    expect(s.calls.length, '到上限之后桥询问还在弹卡').toBe(2);
    expect(noted).toEqual([1, 2, 3].map(() => ({ d: UNATTENDED, origin: 'bridge' })));
    expect(probed.every(sid => sid === 'S1'), '钩子拿到的是这次请求的会话 id').toBe(true);
    // 桥与工具共用一个计数：桥卡把额度用完之后，工具询问也不再弹卡
    expect(await gw.decide(req('web-fetch', 'u'))).toEqual(UNATTENDED);
    expect(s.calls.length).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('G8b 桥与工具共用一个计数：工具超时 1 次 + 桥超时 1 次即到上限；并排挂着的一张工具卡和一张桥卡一起超时只算一次', async () => {
    vi.useFakeTimers();
    const s = scripted(never);
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20, undefined, { runActive: () => true });
    expect(await timedOut(gw, req('web-fetch', 'u1'))).toMatchObject({ cause: 'unanswered' });
    expect(await timedOut(gw, BRIDGE(), { origin: 'bridge' })).toMatchObject({ cause: 'unanswered' });
    expect(await gw.decide(BRIDGE(), { origin: 'bridge' })).toEqual(UNATTENDED);
    expect(await gw.decide(req('web-fetch', 'u2'))).toEqual(UNATTENDED);
    expect(s.calls.length).toBe(2);

    // 另一个会话：shell 工具的卡与它子进程的桥卡同时挂着、一起超时——只算一段，下一次仍然询问
    const p1 = gw.decide(req('file-write', 'a', 'S2'));
    const p2 = gw.decide(BRIDGE('S2'), { origin: 'bridge' });
    await vi.advanceTimersByTimeAsync(20);
    expect(await p1).toMatchObject({ cause: 'unanswered' }); expect(await p2).toMatchObject({ cause: 'unanswered' });
    expect(await timedOut(gw, BRIDGE('S2'), { origin: 'bridge' }), '并排两张卡一起超时不该把额度用完').toMatchObject({ cause: 'unanswered' });
    expect(await gw.decide(BRIDGE('S2'), { origin: 'bridge' })).toEqual(UNATTENDED);
  });

  it('G8b 没有 run 在跑（钩子返回 false）：桥询问不计数、也不受限；只看这次请求的会话', async () => {
    vi.useFakeTimers();
    const s = scripted(never);
    const noted: PermissionDenied[] = [];
    // 只有 S1 有 run 在跑
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20, undefined, { onDenied: (_r, d) => { noted.push(d); }, runActive: sid => sid === 'S1' });
    // S2 没有 run：桥询问超时三次都照常弹卡，也没有计数——随后工具询问照常弹两次才到上限
    for (let i = 0; i < 3; i++) expect(await timedOut(gw, BRIDGE('S2'), { origin: 'bridge' })).toMatchObject({ cause: 'unanswered' });
    expect(await timedOut(gw, req('web-fetch', 'a', 'S2'))).toMatchObject({ cause: 'unanswered' });
    expect(await timedOut(gw, req('web-fetch', 'b', 'S2'))).toMatchObject({ cause: 'unanswered' });
    expect(await gw.decide(req('web-fetch', 'c', 'S2'))).toEqual(UNATTENDED);
    // S2 的工具询问已到上限，但它的桥询问（用户在终端面板里手动跑的）照常弹卡
    const before = s.calls.length;
    expect(await timedOut(gw, BRIDGE('S2'), { origin: 'bridge' })).toMatchObject({ cause: 'unanswered' });
    expect(s.calls.length).toBe(before + 1);
    expect(noted, '没有 run 的会话，桥询问不该被无人值守抑制').toEqual([UNATTENDED]);   // 只有上面那条工具询问
    // S1 有 run：同样的桥询问两次之后就不弹了
    await timedOut(gw, BRIDGE('S1'), { origin: 'bridge' }); await timedOut(gw, BRIDGE('S1'), { origin: 'bridge' });
    expect(await gw.decide(BRIDGE('S1'), { origin: 'bridge' })).toEqual(UNATTENDED);
  });

  it('G8b 有没有 run 只在发起那一刻判一次：等卡期间 run 结束 / 开始，不改变这张卡超时后记不记数', async () => {
    vi.useFakeTimers();
    const s = scripted(never);
    let running = true;
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20, undefined, { runActive: () => running });
    // run 在跑时发出的两张桥卡，各自在超时之前 run 就结束了：照样各记一次
    for (let i = 0; i < 2; i++) {
      running = true;
      const p = gw.decide(BRIDGE(), { origin: 'bridge' });
      running = false;
      await vi.advanceTimersByTimeAsync(20);
      expect(await p).toMatchObject({ cause: 'unanswered' });
    }
    expect(await gw.decide(req('web-fetch', 'u'))).toEqual(UNATTENDED);
    // 反过来：没有 run 时发出的桥卡，等卡期间 run 开始了——超时不记数
    gw.resetUnanswered('S1');
    for (let i = 0; i < 3; i++) {
      running = false;
      const p = gw.decide(BRIDGE(), { origin: 'bridge' });
      running = true;
      await vi.advanceTimersByTimeAsync(20);
      expect(await p).toMatchObject({ cause: 'unanswered' });
    }
    running = false;
    expect(await timedOut(gw, req('web-fetch', 'u')), '没有 run 时发出的桥卡不该计数').toMatchObject({ cause: 'unanswered' });
  });

  it('G8b 清零与只会多拒：用户答复桥卡 / resetUnanswered 之后重新询问；到上限后桥的放行出口（档位 bypass、两种合并授权）照常放行', async () => {
    vi.useFakeTimers();
    let answer: () => Promise<PromptAnswer | UserDecision> | UserDecision = never;
    const s = scripted(() => answer());
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20, undefined, { runActive: () => true });
    /** 从计数 0 起：连着两次无人答复（都弹了卡），第三次才被挡。计数没清零的话，前两次里就会有一次是 unattended。 */
    const toCap = async (): Promise<void> => {
      answer = never;
      expect(await timedOut(gw, BRIDGE(), { origin: 'bridge' })).toMatchObject({ cause: 'unanswered' });
      expect(await timedOut(gw, BRIDGE(), { origin: 'bridge' })).toMatchObject({ cause: 'unanswered' });
      expect(await gw.decide(BRIDGE(), { origin: 'bridge' })).toEqual(UNATTENDED);
    };
    await toCap();
    // 到上限后：免审的桥（bridge-device 默认 bypass）、会话级合并授权、一次性合并授权照常放行——上限排在所有放行出口之后
    expect(await gw.decide(req('bridge-device', 'windows-device info'), { origin: 'bridge' })).toEqual({ decision: 'allow', via: 'level-bypass' });
    gw.grantBridgeSession('S1', 'bridge-speak'); gw.grantBridgeOnce('S1', 'bridge-notify');
    expect(await gw.decide(req('bridge-speak', 'windows-speak say'), { origin: 'bridge' })).toEqual({ decision: 'allow', via: 'bridge-grant' });
    expect(await gw.decide(req('bridge-notify', 'windows-notify show'), { origin: 'bridge' })).toEqual({ decision: 'allow', via: 'bridge-grant' });
    // 一次性授权用掉之后同一个请求又要询问：仍被上限挡住，没有因此多放
    expect(await gw.decide(req('bridge-notify', 'windows-notify show'), { origin: 'bridge' })).toEqual(UNATTENDED);
    // 用户发新消息（resetUnanswered）：重新询问
    gw.resetUnanswered('S1');
    expect(await timedOut(gw, BRIDGE(), { origin: 'bridge' })).toMatchObject({ cause: 'unanswered' });
    // 用户亲自答了一张桥卡（拒绝也算在场）：计数清零，之后又要连着两次无人答复才到上限
    answer = () => 'deny';
    expect(await gw.decide(BRIDGE(), { origin: 'bridge' })).toMatchObject({ reason: 'user-denied' });
    await toCap();
  });

  it('G8b runActive 钩子抛错：decide 不抛，按「有 run 在跑」处理（只会少弹卡、多拒）', async () => {
    vi.useFakeTimers();
    const s = scripted(never);
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20, undefined, { runActive: () => { throw new Error('注入：钩子炸了'); } });
    expect(await timedOut(gw, BRIDGE(), { origin: 'bridge' })).toMatchObject({ cause: 'unanswered' });
    expect(await timedOut(gw, BRIDGE(), { origin: 'bridge' })).toMatchObject({ cause: 'unanswered' });
    expect(await gw.decide(BRIDGE(), { origin: 'bridge' })).toEqual(UNATTENDED);
    expect(s.calls.length).toBe(2);
  });

  // ---- G8c：桥卡被请求方断开提前了结，也算一段无人答复（复核 R1-1）----
  // shell_execute 的 timeout_seconds 由模型给（会话授权的键只含命令文本，换个超时值仍命中授权）。它小于卡片时限时，命令先被
  // shell 超时杀掉进程树，bridge-cli 随之退出、管道断开，桥卡按 cancelled / requester-gone 了结，而不是挂满时限按 timeout 了结。
  // 只认 timeout 的话这条路上计数一直是 0：模型拿到的是「[命令超时被终止]」（输出里没有任何权限提示），原样重跑又弹一张，
  // 一直弹到回合上限。所以 run 在跑时到达的桥询问，被请求方断开了结同样记一段。
  const GONE = { decision: 'deny', reason: 'cancelled', cause: 'requester-gone' };
  /** 桥询问弹了卡，时限（20ms）之前请求方的信号 abort。缺省按 BridgeServer 在管道先于应答关闭时的做法：reason 为 'requester-gone'。 */
  async function leftEarly(gw: PermissionGatewayImpl, sid = 'S1', abort: (c: AbortController) => void = c => c.abort('requester-gone')): Promise<PermissionOutcome> {
    const c = new AbortController();
    const p = gw.decide(BRIDGE(sid), { origin: 'bridge', signal: c.signal });
    await vi.advanceTimersByTimeAsync(5);
    abort(c);
    return p;
  }
  /** 这次桥询问（请求方还连着）被上限挡住：没弹卡、结果是 unattended。询问函数是在 decide 的同一拍被调的，弹没弹卡当场看得出——
   *  没被挡住时红在这条断言上，不用挂到用例超时。 */
  async function expectCapped(gw: PermissionGatewayImpl, s: { calls: PermissionRequest[] }, sid = 'S1'): Promise<void> {
    const before = s.calls.length;
    const p = gw.decide(BRIDGE(sid), { origin: 'bridge', signal: new AbortController().signal });
    expect(s.calls.length, '请求方断开的桥卡没有计数：到了该停的时候还在弹桥卡').toBe(before);
    expect(await p).toEqual(UNATTENDED);
  }

  it('G8c run 在跑：桥卡被请求方断开了结（cancelled / requester-gone）也记一段无人答复，两次之后不再弹卡；与超时共用一个计数', async () => {
    vi.useFakeTimers();
    const s = scripted(never);
    const noted: { d: PermissionDenied; origin?: string }[] = [];
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20, undefined, {
      onDenied: (_r, d, o) => { noted.push({ d, origin: o?.origin }); },
      runActive: () => true,
    });
    // 结果本身不变：仍是取消，不被说成超时
    expect(await leftEarly(gw)).toMatchObject(GONE);
    expect(await leftEarly(gw)).toMatchObject(GONE);
    // 第三次起：不弹卡、不等时限
    for (let i = 0; i < 3; i++) await expectCapped(gw, s);
    expect(s.calls.length).toBe(2);
    expect(noted).toEqual([1, 2, 3].map(() => ({ d: UNATTENDED, origin: 'bridge' })));
    // 桥与工具共用一个计数；上限排在放行出口之后，免审的桥照常放行
    expect(await gw.decide(req('web-fetch', 'u'))).toEqual(UNATTENDED);
    expect(await gw.decide(req('bridge-device', 'windows-device info'), { origin: 'bridge' })).toEqual({ decision: 'allow', via: 'level-bypass' });
    expect(s.calls.length).toBe(2);
    expect(vi.getTimerCount()).toBe(0);

    // 另一个会话：超时 1 次 + 请求方断开 1 次即到上限（两种无人答复记在同一个计数上）
    expect(await timedOut(gw, BRIDGE('S2'), { origin: 'bridge' })).toMatchObject({ cause: 'unanswered' });
    expect(await leftEarly(gw, 'S2')).toMatchObject(GONE);
    await expectCapped(gw, s, 'S2');
  });

  it('G8c 按段记：并排挂着的两张桥卡一起被请求方断开只算一次；resetUnanswered / 用户答复之后重新计', async () => {
    vi.useFakeTimers();
    let answer: () => Promise<PromptAnswer | UserDecision> | UserDecision = never;
    const s = scripted(() => answer());
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20, undefined, { runActive: () => true });
    // 同一条命令里并排的两个桥请求，命令被杀时一起断开：属于同一段
    const c1 = new AbortController(); const c2 = new AbortController();
    const p1 = gw.decide(BRIDGE(), { origin: 'bridge', signal: c1.signal });
    const p2 = gw.decide(BRIDGE(), { origin: 'bridge', signal: c2.signal });
    c1.abort('requester-gone'); c2.abort('requester-gone');
    expect(await p1).toMatchObject(GONE); expect(await p2).toMatchObject(GONE);
    expect(await leftEarly(gw), '并排两张卡一起断开不该把额度用完').toMatchObject(GONE);
    expect(s.calls.length).toBe(3);
    await expectCapped(gw, s);
    // 用户发新消息：重新询问，重新从 0 计
    gw.resetUnanswered('S1');
    expect(await leftEarly(gw)).toMatchObject(GONE);
    // 用户亲自答了一张卡（拒绝也算在场）：清零，之后又要连着两次才到上限
    answer = () => 'deny';
    expect(await gw.decide(BRIDGE(), { origin: 'bridge' })).toMatchObject({ reason: 'user-denied' });
    answer = never;
    expect(await leftEarly(gw)).toMatchObject(GONE);
    expect(await leftEarly(gw)).toMatchObject(GONE);
    await expectCapped(gw, s);
    expect(s.calls.length).toBe(7);
  });

  it('G8c 只多记这一种：没有 run 的桥询问、工具来源的取消、被用户停止 / 删除会话 / 关停了结的桥卡、没弹卡的取消都不计数', async () => {
    vi.useFakeTimers();
    let running = false;
    let answer: () => Promise<PromptAnswer | UserDecision> | PromptAnswer = never;
    const s = scripted(() => answer());
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20, undefined, { runActive: () => running });
    // (a) 没有 run 在跑：用户在终端面板里手动跑的桥命令，按了 Ctrl+C——人就在跟前，不计数
    for (let i = 0; i < 3; i++) expect(await leftEarly(gw)).toMatchObject(GONE);
    running = true;
    // (b) 工具来源的询问被取消：用户停止、关停——哪怕信号的 reason 写着 requester-gone（生产上只有 BridgeServer 给这个 reason）
    for (const reason of [undefined, 'shutdown', 'requester-gone']) {
      const c = new AbortController();
      const p = gw.decide(req('web-fetch', `c-${String(reason)}`), { signal: c.signal });
      c.abort(reason);
      expect((await p as PermissionDenied).reason).toBe('cancelled');
    }
    // (c) run 在跑，桥卡被别的原因取消：用户停止（人在场）、删除会话、关停——信号带来的，和 broker 的 settleWhere 直接了结的
    const otherAborts: [string, (c: AbortController) => void][] = [
      ['user-stop', c => c.abort()], ['session-deleted', c => c.abort('session-deleted')], ['shutdown', c => c.abort('shutdown')],
    ];
    for (const [cause, abort] of otherAborts) expect(await leftEarly(gw, 'S1', abort)).toMatchObject({ reason: 'cancelled', cause });
    for (const cause of ['user-stop', 'session-deleted', 'shutdown'] as const) {
      answer = () => ({ answer: 'deny', reason: 'cancelled', cause });
      expect(await gw.decide(BRIDGE(), { origin: 'bridge' })).toMatchObject({ reason: 'cancelled', cause });
    }
    answer = never;
    // (d) 进门前请求方就走了：没弹卡，谈不上无人答复
    const before = s.calls.length;
    for (let i = 0; i < 3; i++) {
      const c = new AbortController(); c.abort('requester-gone');
      expect(await gw.decide(BRIDGE(), { origin: 'bridge', signal: c.signal })).toEqual(GONE);
    }
    expect(s.calls.length).toBe(before);
    // 以上都没让计数前进：还要连着两次无人答复才到上限
    expect(await timedOut(gw, req('web-fetch', 'x1'))).toMatchObject({ cause: 'unanswered' });
    expect(await timedOut(gw, req('web-fetch', 'x2'))).toMatchObject({ cause: 'unanswered' });
    expect(await gw.decide(req('web-fetch', 'x3'))).toEqual(UNATTENDED);
  });

  it('G9 上限只会多拒：计数到 2 之后，bypass、会话授权、桥授权的请求照常放行', async () => {
    vi.useFakeTimers();
    let mode: 'silent' | 'session' = 'session';
    const s = scripted(() => (mode === 'session' ? 'allow-session' : never()));
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20);
    expect(await gw.decide(req('file-read', 'granted'))).toMatchObject({ via: 'user-session' });
    mode = 'silent';
    await timedOut(gw, req('web-fetch', 'u1')); await timedOut(gw, req('web-fetch', 'u2'));
    expect(await gw.decide(req('web-fetch', 'u3'))).toMatchObject({ cause: 'unattended' });
    gw.grantBridgeSession('S1', 'bridge-open'); gw.grantBridgeOnce('S1', 'bridge-speak');
    expect(await gw.decide(req('shell', 'git status'))).toEqual({ decision: 'allow', via: 'level-bypass' });
    expect(await gw.decide(req('file-read', 'granted'))).toEqual({ decision: 'allow', via: 'session-grant' });
    expect(await gw.decide(req('bridge-open', 'windows-open open'))).toEqual({ decision: 'allow', via: 'bridge-grant' });
    expect(await gw.decide(req('bridge-speak', 'windows-speak say'))).toEqual({ decision: 'allow', via: 'bridge-grant' });
    // 规则拦截仍是规则拦截，不被说成无人值守
    expect(await gw.decide(req('shell', 'Remove-Item x'))).toMatchObject({ reason: 'rule-blocked', cause: 'shell-danger' });
    // full 档下原本要问的请求照常放行
    gw.applyPreset('full');
    expect(await gw.decide(req('web-fetch', 'u3'))).toEqual({ decision: 'allow', via: 'level-bypass' });
  });

  it('G10(a)(c) 同时挂着的两张卡一起超时只算一次；再超时一次才到上限（时钟不走也一样）', async () => {
    vi.useFakeTimers();
    const s = scripted(never);
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20, () => 1000);
    const p1 = gw.decide(req('file-write', 'a')); const p2 = gw.decide(req('file-write', 'b'));
    await vi.advanceTimersByTimeAsync(20);
    expect(await p1).toMatchObject({ cause: 'unanswered' }); expect(await p2).toMatchObject({ cause: 'unanswered' });
    // (a) 第三个仍然询问
    expect(await timedOut(gw, req('file-write', 'c'))).toMatchObject({ cause: 'unanswered' });
    expect(s.calls.length).toBe(3);
    // (c) 第四个不再询问
    expect(await gw.decide(req('file-write', 'd'))).toEqual({ decision: 'deny', reason: 'timeout', cause: 'unattended' });
    expect(s.calls.length).toBe(3);
  });

  it('G10(b) 错开签发但重叠的两张卡先后超时，也只算一次', async () => {
    vi.useFakeTimers();
    const s = scripted(never);
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20, () => 1000);
    const p1 = gw.decide(req('file-write', 'a'));
    await vi.advanceTimersByTimeAsync(10);
    const p2 = gw.decide(req('file-write', 'b'));
    await vi.advanceTimersByTimeAsync(10);
    expect(await p1).toMatchObject({ cause: 'unanswered' });
    await vi.advanceTimersByTimeAsync(10);
    expect(await p2).toMatchObject({ cause: 'unanswered' });
    expect(await timedOut(gw, req('file-write', 'c')), '第三个仍然询问').toMatchObject({ cause: 'unanswered' });
    expect(s.calls.length).toBe(3);
    expect(await gw.decide(req('file-write', 'd'))).toMatchObject({ cause: 'unattended' });
  });

  it('清零之后，清零之前发出、仍挂着的卡再超时，照常记 1 次', async () => {
    vi.useFakeTimers();
    const s = scripted(never);
    const gw = new PermissionGatewayImpl(s.prompt, undefined, 20);
    await timedOut(gw, req('file-write', 'a'));
    const hanging = gw.decide(req('file-write', 'b'));
    gw.resetUnanswered('S1');
    await vi.advanceTimersByTimeAsync(20);
    await hanging;
    expect(await timedOut(gw, req('file-write', 'c'))).toMatchObject({ cause: 'unanswered' });
    expect(await gw.decide(req('file-write', 'd'))).toMatchObject({ cause: 'unattended' });
  });
});

describe('G11 onDenied 抛错不影响判定', () => {
  it('规则拦截、无人值守抑制、外部 noteDenied：照常返回对应的拒绝，不抛', async () => {
    vi.useFakeTimers();
    let thrown = 0;
    const gw = new PermissionGatewayImpl(never, undefined, 20, undefined, { onDenied: () => { thrown++; throw new Error('注入：审计钩子炸了'); } });
    expect(await gw.decide(req('shell', 'Remove-Item x'))).toMatchObject({ reason: 'rule-blocked' });
    for (const u of ['a', 'b']) { const p = gw.decide(req('web-fetch', u)); await vi.advanceTimersByTimeAsync(20); await p; }
    expect(await gw.decide(req('web-fetch', 'c'))).toMatchObject({ reason: 'timeout', cause: 'unattended' });
    expect(() => gw.noteDenied(req('file-write', 'p'), { decision: 'deny', reason: 'rule-blocked', cause: 'core-data' })).not.toThrow();
    expect(thrown).toBe(3);
  });

  it('没有 hooks：noteDenied 是空操作', () => {
    const gw = new PermissionGatewayImpl(never);
    expect(() => gw.noteDenied(req('file-write', 'p'), { decision: 'deny', reason: 'rule-blocked', cause: 'core-data' })).not.toThrow();
  });
});
