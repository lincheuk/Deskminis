/**
 * F13 测试夹具（不是测试文件）：真实 PermissionBroker + 真实 PermissionGatewayImpl，按 index.ts 的写法接线。
 * 运行时引入 F13 的新模块，只给 broker / 网关 / 循环级用例用（先红用例用 permission-fixture.ts）。
 */
import { PermissionGatewayImpl, classifyShellCommand, type PermissionClass, type PermissionLevel } from '../src/minisd/tools/permissions';
import { PermissionBroker, type PendingView } from '../src/minisd/tools/permission-broker';
import { detectBridgeTriggers } from '../src/minisd/bridge/detect';
import type { PermissionRequest } from '../src/minisd/tools/types';

export interface AuditRow { eventType: string; payload: any; opts: { sessionId?: string; peerFingerprint?: string } }

/** 内存审计：failOn 命中的事件类型一律抛（库写失败的替身）。 */
export class MemAudit {
  rows: AuditRow[] = [];
  failOn = new Set<string>();
  append(eventType: string, payload: unknown, opts: { sessionId?: string; peerFingerprint?: string } = {}): void {
    if (this.failOn.has(eventType)) throw new Error('注入：审计写入失败');
    this.rows.push({ eventType, payload, opts });
  }
  of(eventType: string, requestId?: string): AuditRow[] {
    return this.rows.filter(r => r.eventType === eventType && (requestId === undefined || r.payload.requestId === requestId));
  }
}

/** 广播记录：failOn 命中的方法一律抛（不记录这一次）。 */
export class Wire {
  sent: { method: string; params: any }[] = [];
  failOn = new Set<string>();
  broadcast(method: string, params: unknown): void {
    if (this.failOn.has(method)) throw new Error('注入：广播失败');
    this.sent.push({ method, params });
  }
  of(method: string, requestId?: string): { method: string; params: any }[] {
    return this.sent.filter(s => s.method === method && (requestId === undefined || s.params.requestId === requestId));
  }
  /** 已广播的卡片 id，按发出序。 */
  cards(): string[] { return this.of('permission.request').map(s => s.params.requestId as string); }
}

export interface StackOpts {
  timeoutMs?: number; askTimeoutMs?: number;
  levels?: Partial<Record<PermissionClass, PermissionLevel>>;
  /** 不给 = broker 不做连接检查。 */
  connSeq?: () => number;
  newId?: () => string; recentLimit?: number; now?: () => number;
  /** 该会话有没有 run 在跑（index.ts 接的是 inFlight.has）。不给 = 网关不接这个钩子：桥询问不计数、不受限。 */
  runActive?: (sessionId: string) => boolean;
}

export function mkStack(o: StackOpts = {}) {
  const audit = new MemAudit();
  const wire = new Wire();
  const warns: string[] = [];
  const approved: { requestId: string; decision: string }[] = [];
  const timeoutMs = o.timeoutMs ?? 90_000;
  // 与 index.ts 同一接法：onApproved / onUserSeen 是延迟执行的闭包，引用后面才赋值的 gateway
  let gateway!: PermissionGatewayImpl;
  const broker = new PermissionBroker({
    timeoutMs,
    broadcast: (m, p) => wire.broadcast(m, p),
    audit: (t, p, opts) => audit.append(t, p, opts),
    ...(o.connSeq ? { connSeq: o.connSeq } : {}),
    onUserSeen: sid => gateway.resetUnanswered(sid),
    describe: (req: PermissionRequest) => {
      if (req.kind !== 'shell') return {};
      const t = detectBridgeTriggers(req.detail);
      return { riskClass: classifyShellCommand(req.detail), ...(t.length > 0 ? { bridgeTriggers: t } : {}) };
    },
    onApproved: (e: PendingView, decision) => {
      approved.push({ requestId: e.requestId, decision });
      for (const k of e.bridgeTriggers) decision === 'allow-session' ? gateway.grantBridgeSession(e.req.sessionId, k) : gateway.grantBridgeOnce(e.req.sessionId, k);
    },
    warn: (msg, e) => { warns.push(`${msg} ${String(e ?? '')}`); },
    ...(o.newId ? { newId: o.newId } : {}),
    ...(o.recentLimit !== undefined ? { recentLimit: o.recentLimit } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  gateway = new PermissionGatewayImpl(broker.ask, o.levels, o.askTimeoutMs ?? timeoutMs, o.now, {
    onDenied: (req, d, opts) => {
      const { preview: _p, ...reqNoPreview } = req;
      audit.append('permission.denied', { req: reqNoPreview, outcome: d, origin: opts?.origin ?? 'tool', ...(opts?.toolUseId ? { toolUseId: opts.toolUseId } : {}) }, { sessionId: req.sessionId });
    },
    ...(o.runActive ? { runActive: o.runActive } : {}),
  });
  return { broker, gateway, audit, wire, warns, approved };
}
export type Stack = ReturnType<typeof mkStack>;
