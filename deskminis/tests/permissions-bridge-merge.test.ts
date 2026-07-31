import { describe, it, expect } from 'vitest';
import { PermissionGatewayImpl } from '../src/minisd/tools/permissions';
import type { BridgePermissionKind, PermissionRequest } from '../src/minisd/tools/types';

const bReq = (kind: BridgePermissionKind, detail: string, sessionId = 'S1'): PermissionRequest =>
  ({ kind, detail, sessionId, toolTitle: 't' });

describe('桥双段合并授权（决策 4c）', () => {
  it('grantBridgeSession：同会话同桥 kind 静默放行且 prompt 不再被调；异会话仍问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    g.grantBridgeSession('S1', 'bridge-clipboard-read');
    expect(await g.check(bReq('bridge-clipboard-read', 'windows-clipboard get', 'S1'))).toBe('allow');
    expect(asked).toBe(0);
    expect(await g.check(bReq('bridge-clipboard-read', 'windows-clipboard get', 'S2'))).toBe('deny');
    expect(asked).toBe(1);
  });

  it('grantBridgeOnce：首次消费放行（prompt 0 次）；第二次走 prompt（计数只减不增）', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    g.grantBridgeOnce('S1', 'bridge-notify');
    expect(await g.check(bReq('bridge-notify', 'windows-notify show'))).toBe('allow');
    expect(asked).toBe(0);
    expect(await g.check(bReq('bridge-notify', 'windows-notify show'))).toBe('deny');
    expect(asked).toBe(1);
  });

  it('档位优先：bridge-device bypass 不受合并授权影响仍直行', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    g.grantBridgeSession('S1', 'bridge-device');
    g.grantBridgeOnce('S1', 'bridge-device');
    expect(await g.check(bReq('bridge-device', 'windows-device info'))).toBe('allow');
    expect(asked).toBe(0);
  });

  it('档位优先：levels 覆盖为 notAllowed 的桥 kind 不被合并授权复活', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; }, { 'bridge-clipboard-read': 'notAllowed' });
    g.grantBridgeSession('S1', 'bridge-clipboard-read');
    g.grantBridgeOnce('S1', 'bridge-clipboard-read');
    expect(await g.check(bReq('bridge-clipboard-read', 'windows-clipboard get'))).toBe('deny');
    expect(asked).toBe(0);
  });

  it('既有 sessionGrants 精确 key 语义不回归：prompt 路径 allow-session 不产生 kind 级静默', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(bReq('bridge-open', 'detail-A'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(bReq('bridge-open', 'detail-A'))).toBe('allow'); // 精确 key 命中
    expect(asked).toBe(1);
    expect(await g.check(bReq('bridge-open', 'detail-B'))).toBe('allow'); // 精确 miss 且无合并授权 → 重新问
    expect(asked).toBe(2);
  });

  it('grantBridgeOnce TTL：超过 120s 未消费 → 不消费、懒清理、走 prompt', async () => {
    let now = 1_000_000;
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; }, undefined, 90000, () => now);
    g.grantBridgeOnce('S1', 'bridge-speak');
    now += 120_001;
    expect(await g.check(bReq('bridge-speak', 'windows-speak say'))).toBe('deny');
    expect(asked).toBe(1);
    // 懒清理后重新授予 → 恰好一次静默（无僵尸计数残留）
    g.grantBridgeOnce('S1', 'bridge-speak');
    expect(await g.check(bReq('bridge-speak', 'windows-speak say'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(bReq('bridge-speak', 'windows-speak say'))).toBe('deny');
    expect(asked).toBe(2);
  });

  it('同 kind 二次 allow-once 累积 count=2：两次静默后第三次走 prompt', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    g.grantBridgeOnce('S1', 'bridge-open');
    g.grantBridgeOnce('S1', 'bridge-open');
    expect(await g.check(bReq('bridge-open', 'windows-open open'))).toBe('allow');
    expect(await g.check(bReq('bridge-open', 'windows-open open'))).toBe('allow');
    expect(asked).toBe(0);
    expect(await g.check(bReq('bridge-open', 'windows-open open'))).toBe('deny');
    expect(asked).toBe(1);
  });

  it('累积后整体过期：grantedAt 以最后一次 grant 为准，过期一并失效不残留', async () => {
    let now = 1_000_000;
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; }, undefined, 90000, () => now);
    g.grantBridgeOnce('S1', 'bridge-open');
    now += 60_000;
    g.grantBridgeOnce('S1', 'bridge-open'); // count=2，grantedAt 刷新到最后一次
    now += 119_999; // 距最后一次 < 120s → 仍有效
    expect(await g.check(bReq('bridge-open', 'windows-open open'))).toBe('allow');
    expect(asked).toBe(0);
    g.grantBridgeOnce('S1', 'bridge-open'); // 恢复 count=2
    now += 120_001; // 整体过期
    expect(await g.check(bReq('bridge-open', 'windows-open open'))).toBe('deny');
    expect(asked).toBe(1);
    expect(await g.check(bReq('bridge-open', 'windows-open open'))).toBe('deny'); // 不残留：第二次也走 prompt
    expect(asked).toBe(2);
  });
});
