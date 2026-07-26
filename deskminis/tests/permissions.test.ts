import { describe, it, expect } from 'vitest';
import { classifyShellCommand, PermissionGatewayImpl } from '../src/minisd/tools/permissions';
import type { PermissionRequest } from '../src/minisd/tools/types';

describe('classifyShellCommand', () => {
  it.each([
    ['dir', 'read'], ['Get-ChildItem -Recurse', 'read'], ['git status', 'read'], ['type a.txt', 'read'], ['cat a.txt', 'read'],
    ['npm install', 'write'], ['git commit -m x', 'write'], ['echo hi > a.txt', 'write'],
    ['Remove-Item -Recurse -Force C:\\x', 'danger'], ['rm -r node_modules', 'danger'], ['del /s /q *', 'danger'],
    ['format d:', 'danger'], ['reg delete HKLM\\x', 'danger'], ['shutdown /s', 'danger'], ['rmdir /s build', 'danger'],
    // 回归：危险规则顺序无关（原 CRITICAL 绕过 + IMPORTANT 顺序 bug）
    ['dir; Remove-Item -Force C:\\important.txt', 'danger'],
    ['Get-ChildItem -Recurse | Remove-Item -Force', 'danger'],
    ['Remove-Item -Force C:\\important.txt', 'danger'],
    // 回归：组合符使只读白名单降级为 write
    ['dir; npm install', 'write'],
    ['Get-Content a.txt | Set-Content b.txt', 'write'],
    ['Write-Output $(whoami)', 'write'],
    // 回归：单一简单只读命令仍为 read
    ['git log --oneline', 'read'],
    ['Get-Date', 'read'],
  ])('%s → %s', (cmd, cls) => { expect(classifyShellCommand(cmd)).toBe(cls); });
});

const req = (detail: string, sessionId = 'S1'): PermissionRequest => ({ kind: 'shell', detail, sessionId, toolTitle: 't' });

describe('PermissionGatewayImpl', () => {
  it('read 直行不问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    expect(await g.check(req('git log'))).toBe('allow');
    expect(asked).toBe(0);
  });
  it('danger 直接拒绝不问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    expect(await g.check(req('Remove-Item -Recurse C:\\'))).toBe('deny');
    expect(asked).toBe(0);
  });
  it('命令串联绕过已封堵：read 动词开头 + 危险动词 → deny 且不询问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    expect(await g.check(req('dir; Remove-Item -Force C:\\x'))).toBe('deny');
    expect(asked).toBe(0);
  });
  it('write 询问; allow-session 后同会话同类不再问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(req('npm install'))).toBe('allow');
    expect(await g.check(req('git commit -m x'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(req('npm install', 'S2'))).toBe('allow'); // 另一会话重新问
    expect(asked).toBe(2);
  });
  it('询问超时 deny', async () => {
    const g = new PermissionGatewayImpl(() => new Promise(() => { /* 永不响应 */ }), undefined, 50);
    expect(await g.check(req('npm install'))).toBe('deny');
  });
  it('file-write 走 askOnce', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    expect(await g.check({ kind: 'file-write', detail: 'C:\\x.txt', sessionId: 'S1', toolTitle: 't' })).toBe('allow');
    expect(asked).toBe(1);
  });
});
