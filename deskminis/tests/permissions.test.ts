import { describe, it, expect } from 'vitest';
import { classifyShellCommand, PermissionGatewayImpl } from '../src/minisd/tools/permissions';
import type { PermissionRequest } from '../src/minisd/tools/types';

describe('classifyShellCommand', () => {
  it.each([
    ['dir', 'read'], ['Get-ChildItem -Recurse', 'read'], ['git status', 'read'], ['type a.txt', 'read'], ['cat a.txt', 'read'],
    ['npm install', 'write'], ['git commit -m x', 'write'], ['echo hi > a.txt', 'write'],
    ['Remove-Item -Recurse -Force C:\\x', 'danger'], ['rm -r node_modules', 'danger'], ['del /s /q *', 'danger'],
    ['format d:', 'danger'], ['reg delete HKLM\\x', 'danger'], ['shutdown /s', 'danger'], ['rmdir /s build', 'danger'],
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
