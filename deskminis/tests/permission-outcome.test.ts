/**
 * F13：权限结果的纯函数——解析（shared/permission）、询问入口的归一（tools/permission-outcome）、文案表（tools/permission-text）。
 */
import { describe, it, expect } from 'vitest';
import {
  allowed, cancelCauseOf, denied, parsePermissionOutcome,
  PERMISSION_ALLOW_VIAS, PERMISSION_DENY_CAUSES, PERMISSION_DENY_REASONS,
  type PermissionDenied, type PermissionDenyCause,
} from '../src/shared/permission';
import { askPermission, decidePermission, reportDenied } from '../src/minisd/tools/permission-outcome';
import { bridgeDenialMessage, denialText, permissionFailure, RULE_BLOCKED } from '../src/minisd/tools/permission-text';
import type { PermissionRequest } from '../src/minisd/tools/types';
import { binaryGateway, outcomeGateway, JUNK_OUTCOMES } from './permission-fixture';

const REQ: PermissionRequest = { kind: 'web-fetch', detail: 'https://example.com/', sessionId: 'S1', toolTitle: '抓' };
const INVALID = { decision: 'deny', reason: 'unspecified', cause: 'invalid-outcome' };

describe('O1 parsePermissionOutcome：失败关闭', () => {
  it.each(JUNK_OUTCOMES)('形状不合法的值是拒绝，不是放行：$label', ({ value }) => {
    expect(parsePermissionOutcome(value)).toEqual(INVALID);
  });

  it('合法的允许 / 拒绝通过，返回新对象、只带认识的字段', () => {
    for (const via of PERMISSION_ALLOW_VIAS) {
      const raw = { decision: 'allow', via, requestId: 'R1', extra: 'x' };
      const o = parsePermissionOutcome(raw);
      expect(o).toEqual({ decision: 'allow', via, requestId: 'R1' });
      expect(o).not.toBe(raw);
    }
    for (const reason of PERMISSION_DENY_REASONS) {
      expect(parsePermissionOutcome({ decision: 'deny', reason, junk: 1 })).toEqual({ decision: 'deny', reason });
      for (const cause of PERMISSION_DENY_CAUSES[reason]) {
        expect(parsePermissionOutcome({ decision: 'deny', reason, cause, requestId: 'R2', waitedMs: 1500 }))
          .toEqual({ decision: 'deny', reason, cause, requestId: 'R2', waitedMs: 1500 });
      }
    }
  });

  it('不认识的 cause（或属于别的 reason 的 cause）被丢掉，reason 保留', () => {
    expect(parsePermissionOutcome({ decision: 'deny', reason: 'timeout', cause: '将来才有的细分' })).toEqual({ decision: 'deny', reason: 'timeout' });
    expect(parsePermissionOutcome({ decision: 'deny', reason: 'timeout', cause: 'mcp-disabled' })).toEqual({ decision: 'deny', reason: 'timeout' });
    expect(parsePermissionOutcome({ decision: 'deny', reason: 'cancelled', cause: 42 })).toEqual({ decision: 'deny', reason: 'cancelled' });
  });

  it('requestId / waitedMs 类型不对就不带', () => {
    expect(parsePermissionOutcome({ decision: 'allow', via: 'user-once', requestId: 7 })).toEqual({ decision: 'allow', via: 'user-once' });
    expect(parsePermissionOutcome({ decision: 'deny', reason: 'timeout', waitedMs: -1 })).toEqual({ decision: 'deny', reason: 'timeout' });
    expect(parsePermissionOutcome({ decision: 'deny', reason: 'timeout', waitedMs: Number.NaN })).toEqual({ decision: 'deny', reason: 'timeout' });
  });

  it('cancelCauseOf：只认三种系统原因，其余都是 user-stop', () => {
    expect(cancelCauseOf(undefined)).toBe('user-stop');
    expect(cancelCauseOf({})).toBe('user-stop');
    expect(cancelCauseOf({ reason: new Error('x') })).toBe('user-stop');
    expect(cancelCauseOf({ reason: 'session-deleted' })).toBe('session-deleted');
    expect(cancelCauseOf({ reason: 'shutdown' })).toBe('shutdown');
    expect(cancelCauseOf({ reason: 'requester-gone' })).toBe('requester-gone');
    const c = new AbortController(); c.abort();
    expect(cancelCauseOf(c.signal)).toBe('user-stop');
  });
});

describe('O2 decidePermission：旧式二值网关与无效结果', () => {
  it("只有 check 的网关：恰好 'allow' 才放行，'deny' 不说原因", async () => {
    expect(await decidePermission(binaryGateway('allow'), REQ)).toEqual({ decision: 'allow', via: 'legacy-binary' });
    expect(await decidePermission(binaryGateway('deny'), REQ)).toEqual({ decision: 'deny', reason: 'unspecified', cause: 'legacy-binary' });
  });

  it.each([undefined, 'ALLOW', 'allow-once', true, { decision: 'allow' }, { decision: 'allow', via: 'user-once' }])(
    'check 返回 %j：拒绝', async v => {
      expect(await decidePermission(binaryGateway(v), REQ)).toEqual(INVALID);
    });

  it.each(JUNK_OUTCOMES)('带 decide 的网关返回无效结果是拒绝：$label', async ({ value }) => {
    const gw = outcomeGateway(() => value);
    expect(await decidePermission(gw, REQ)).toEqual(INVALID);
    expect(gw.asked.length).toBe(1);
  });

  it('带 decide 的网关：结果原样（经解析）交回，opts 原样传下去；不再调 check', async () => {
    const gw = outcomeGateway(() => ({ decision: 'deny', reason: 'timeout', cause: 'unanswered', requestId: 'C1', waitedMs: 9 }));
    const signal = new AbortController().signal;
    const o = await decidePermission(gw, REQ, { toolUseId: 'T1', origin: 'bridge', signal });
    expect(o).toEqual({ decision: 'deny', reason: 'timeout', cause: 'unanswered', requestId: 'C1', waitedMs: 9 });
    expect(gw.askedOpts[0]).toMatchObject({ toolUseId: 'T1', origin: 'bridge', signal });
  });

  it('网关抛错原样外抛', async () => {
    const gw = outcomeGateway(() => { throw new Error('网关炸了'); });
    await expect(decidePermission(gw, REQ)).rejects.toThrow('网关炸了');
  });

  it('reportDenied：网关没实现 noteDenied 或它抛错，都不影响调用方', () => {
    expect(() => reportDenied(binaryGateway('deny'), REQ, denied('rule-blocked', 'core-data'))).not.toThrow();
    const bad = { ...binaryGateway('deny'), noteDenied() { throw new Error('审计炸了'); } };
    expect(() => reportDenied(bad, REQ, denied('rule-blocked', 'core-data'))).not.toThrow();
  });
});

describe('O4 askPermission：取消优先', () => {
  it('进门已取消：不询问，交回 cancelled（cause 取自 signal 的 reason）', async () => {
    const gw = outcomeGateway(() => allowed('user-once', 'CARD'));
    const c = new AbortController(); c.abort('shutdown');
    expect(await askPermission({ permissions: gw, signal: c.signal }, REQ)).toEqual({ decision: 'deny', reason: 'cancelled', cause: 'shutdown' });
    expect(gw.asked.length).toBe(0);
    expect(gw.noted).toEqual([]);
  });

  it('批准晚于取消：不放行；被批准的那张卡记一条 cancelled（同一个 requestId）', async () => {
    const c = new AbortController();
    const gw = outcomeGateway(() => { c.abort(); return allowed('user-once', 'CARD-9'); });
    const o = await askPermission({ permissions: gw, signal: c.signal }, REQ);
    expect(o).toEqual({ decision: 'deny', reason: 'cancelled', cause: 'user-stop', requestId: 'CARD-9' });
    expect(gw.noted.map(n => n.denied)).toEqual([{ decision: 'deny', reason: 'cancelled', cause: 'user-stop', requestId: 'CARD-9' }]);
  });

  it('没弹卡的放行被取消：不记', async () => {
    const c = new AbortController();
    const gw = outcomeGateway(() => { c.abort(); return allowed('level-bypass'); });
    expect((await askPermission({ permissions: gw, signal: c.signal }, REQ)).decision).toBe('deny');
    expect(gw.noted).toEqual([]);
  });

  it('拒绝晚于取消：交回 cancelled，不重复记', async () => {
    const c = new AbortController();
    const gw = outcomeGateway(() => { c.abort(); return denied('user-denied', undefined, { requestId: 'CARD-3' }); });
    expect(await askPermission({ permissions: gw, signal: c.signal }, REQ)).toEqual({ decision: 'deny', reason: 'cancelled', cause: 'user-stop', requestId: 'CARD-3' });
    expect(gw.noted).toEqual([]);
  });

  it('没有取消：结果原样', async () => {
    const gw = outcomeGateway(() => allowed('session-grant'));
    expect(await askPermission({ permissions: gw }, REQ)).toEqual({ decision: 'allow', via: 'session-grant' });
  });

  // 变异检查补的：askPermission 不把 signal 交下去时上面几条都不红——它们的网关替身自己 abort，不看 opts
  it('把 ctx.signal 交给网关：询问方在等卡期间取消，网关据此当场了结卡片（不经调度器包装层的调用方靠这一条）', async () => {
    const c = new AbortController();
    const gw = outcomeGateway(() => allowed('session-grant'));
    await askPermission({ permissions: gw, signal: c.signal }, REQ);
    expect(gw.askedOpts.length).toBe(1);
    expect(gw.askedOpts[0]?.signal, '网关收到的就是调用方的取消信号').toBe(c.signal);
  });
});

describe('O3 文案表', () => {
  const KINDS: PermissionRequest['kind'][] = ['shell', 'file-write', 'file-read', 'web-fetch', 'web-search', 'mcp', 'bridge-open'];
  const reqOf = (kind: PermissionRequest['kind']) => ({ kind, detail: kind === 'shell' ? 'npm install' : 'C:\\w\\a.txt' });
  const all: { d: PermissionDenied; kind: PermissionRequest['kind']; text: string }[] = [];
  for (const reason of PERMISSION_DENY_REASONS) {
    const causes: (PermissionDenyCause | undefined)[] = [undefined, ...PERMISSION_DENY_CAUSES[reason]];
    for (const cause of causes) for (const kind of KINDS) {
      const d = denied(reason, cause, reason === 'timeout' ? { waitedMs: 90_000 } : undefined);
      all.push({ d, kind, text: denialText(d, reqOf(kind)) });
    }
  }

  it('用户拒绝的六句与改动前逐字相同', () => {
    const d = denied('user-denied');
    expect(denialText(d, { kind: 'file-write', detail: 'C:\\w\\a.txt' })).toBe('写入被用户拒绝: C:\\w\\a.txt（可在设置-权限中调整）');
    expect(denialText(d, { kind: 'file-read', detail: 'C:\\w\\a.txt' })).toBe('读取被用户拒绝: C:\\w\\a.txt（可在设置-权限中调整）');
    expect(denialText(d, { kind: 'shell', detail: 'npm i' })).toBe('命令被用户拒绝（可在设置-权限中调整）');
    expect(denialText(d, { kind: 'web-fetch', detail: 'u' })).toBe('抓取被用户拒绝（可在设置-权限中调整）');
    expect(denialText(d, { kind: 'web-search', detail: 'q' })).toBe('搜索被用户拒绝（可在设置-权限中调整）');
    expect(denialText(d, { kind: 'mcp', detail: 's' })).toBe('MCP 调用被用户拒绝（可在设置-权限中调整）');
    expect(bridgeDenialMessage(d, { detail: 'windows-open open' })).toBe('权限拒绝: windows-open open');
  });

  it('「被用户拒绝」「可在设置-权限中调整」只出现在 user-denied 一行', () => {
    for (const { d, text } of all) {
      const isUser = d.reason === 'user-denied';
      expect(text.includes('被用户拒绝'), `${d.reason}/${d.cause}: ${text}`).toBe(isUser);
      expect(text.includes('可在设置-权限中调整'), `${d.reason}/${d.cause}: ${text}`).toBe(isUser);
    }
    for (const reason of PERMISSION_DENY_REASONS) {
      // 桥的话同样按「原因 × 各 cause」全表过一遍（超时的两种 cause 是两句不同的话）
      for (const cause of [undefined, ...PERMISSION_DENY_CAUSES[reason]] as (PermissionDenyCause | undefined)[]) {
        const text = bridgeDenialMessage(denied(reason, cause), { detail: 'x y' });
        expect(text.includes('权限拒绝'), `${reason}/${cause}: ${text}`).toBe(reason === 'user-denied');
        expect(text.includes('被用户拒绝'), `${reason}/${cause}: ${text}`).toBe(false);
        expect(text.includes('可在设置-权限中调整'), `${reason}/${cause}: ${text}`).toBe(false);
      }
    }
  });

  it('超时：说明没人答复、不是用户点了拒绝、档位没变；带等待秒数', () => {
    for (const { d, text } of all.filter(x => x.d.reason === 'timeout' && x.d.cause !== 'unattended')) {
      expect(text, String(d.cause)).toContain('等了 90 秒没有人答复');
      expect(text).toContain('不是用户点了拒绝');
      expect(text).toContain('权限档位也没有改变');
    }
    // 没有 waitedMs 或不足 1 秒：省去「等了 N 秒」
    expect(denialText(denied('timeout', 'unanswered'), reqOf('web-fetch'))).toContain('权限请求没有人答复');
    expect(denialText(denied('timeout', 'unanswered', { waitedMs: 300 }), reqOf('web-fetch'))).toContain('权限请求没有人答复');
    expect(denialText(denied('timeout', 'unanswered', { waitedMs: 1499 }), reqOf('web-fetch'))).toContain('等了 1 秒');
  });

  it('无人值守抑制：说明这次没有再询问、让模型停止重试', () => {
    for (const { text } of all.filter(x => x.d.cause === 'unattended')) {
      expect(text).toContain('本轮已连续 2 次权限请求无人答复，这次没有再询问');
      expect(text).toContain('请停止重试');
    }
  });

  it('规则拦截：明说是规则、不是用户拒绝的，不建议绕过', () => {
    for (const { d, kind, text } of all.filter(x => x.d.reason === 'rule-blocked')) {
      if (d.cause === 'shell-danger') { expect(text).toBe(RULE_BLOCKED); continue; }
      expect(text, `${kind}/${d.cause}`).toContain('规则');
      expect(text).toContain('不是用户拒绝');
      expect(text).toMatch(/不要.*绕过/);
    }
    expect(RULE_BLOCKED).toMatch(/不要.*绕过/);
  });

  it('文件两类带路径，其余不带 detail', () => {
    for (const { d, kind, text } of all) {
      if (d.reason === 'cancelled' || d.reason === 'invalidated' || text === RULE_BLOCKED) continue;
      expect(text.includes('C:\\w\\a.txt'), `${kind}/${d.reason}`).toBe(kind === 'file-write' || kind === 'file-read');
    }
  });

  it('取消、失效、未说明', () => {
    for (const { text } of all.filter(x => x.d.reason === 'cancelled')) expect(text).toBe('[已取消]');
    for (const { text } of all.filter(x => x.d.reason === 'invalidated')) { expect(text).toContain('已失效'); expect(text).toContain('重新发起'); }
    for (const { kind, text } of all.filter(x => x.d.reason === 'unspecified')) {
      expect(text, kind).toContain('没有获得许可');
      expect(text).toContain('不能当作用户拒绝');
    }
    // 旧式二值网关拒掉危险命令：仍说是规则拦下的（危险规则不随网关实现变）
    expect(denialText(denied('unspecified', 'legacy-binary'), { kind: 'shell', detail: 'Remove-Item x' })).toBe(RULE_BLOCKED);
    // 非 shell 的 detail 不喂给命令分类器
    expect(denialText(denied('unspecified', 'legacy-binary'), { kind: 'file-read', detail: 'C:\\tools\\Remove-Item\\a.txt' })).toContain('没有获得许可');
  });

  it('桥的 message 按原因区分', () => {
    const msg = (r: PermissionDenied['reason']) => bridgeDenialMessage(denied(r), { detail: 'windows-open open' });
    // 超时：桥的话 agent 的 shell 子进程里的模型也会看到（bridge-cli 退出码 2），要说明不是用户拒绝、别原样重跑
    const TIMEOUT = '权限请求超时无人答复，未执行: windows-open open。这不是用户点了拒绝；用户可能暂时不在，不要立刻重试同一条命令。';
    expect(msg('timeout')).toBe(TIMEOUT);
    expect(bridgeDenialMessage(denied('timeout', 'unanswered', { waitedMs: 90_000 }), { detail: 'windows-open open' })).toBe(TIMEOUT);
    // 无人值守抑制（该会话有 run 在跑、连续无人答复已到上限）：这次没有弹卡，与「等到超时」不是一句话
    expect(bridgeDenialMessage(denied('timeout', 'unattended'), { detail: 'windows-open open' })).toBe(
      '本轮已连续 2 次权限请求无人答复，这次没有再询问，未执行: windows-open open。'
      + '请停止重试，把需要批准的内容告诉用户；用户发来新消息或本回合结束后会重新询问。');
    expect(msg('rule-blocked')).toBe('权限规则不允许，未执行: windows-open open');
    expect(msg('cancelled')).toBe('权限请求已取消，未执行: windows-open open');
    expect(msg('invalidated')).toBe('权限请求已失效，未执行: windows-open open');
    expect(msg('unspecified')).toBe('未获许可，未执行: windows-open open');
  });

  it('permissionFailure 是失败结果', () => {
    expect(permissionFailure(denied('cancelled', 'user-stop'), reqOf('shell'))).toEqual({ output: '[已取消]', success: false });
  });
});
