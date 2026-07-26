import { describe, it, expect } from 'vitest';
import { classifyShellCommand, PermissionGatewayImpl } from '../src/minisd/tools/permissions';
import type { PermissionRequest } from '../src/minisd/tools/types';

describe('classifyShellCommand', () => {
  it.each([
    // ---- danger（不变的灾难集）：不可逆/系统级，顺序无关 ----
    ['Remove-Item -Recurse -Force C:\\x', 'danger'],
    ['rm -r node_modules', 'danger'],
    ['del /s /q *', 'danger'],
    ['format d:', 'danger'],
    ['reg delete HKLM\\x', 'danger'],
    ['shutdown /s', 'danger'],
    ['rmdir /s build', 'danger'],
    ['Remove-Item -Force C:\\important.txt', 'danger'],
    ['dir; Remove-Item -Force C:\\x', 'danger'],
    ['Get-ChildItem -Recurse | Remove-Item -Force', 'danger'],
    // ---- danger（影子命名原语现被硬拦）：把无害名字重绑为任意行为 ----
    ['function Get-Stuff { Set-Content C:\\x -Value p }', 'danger'],
    ['Set-Alias dir Remove-Item', 'danger'],
    ['nal whoami C:\\evil\\payload.exe', 'danger'],
    ['sal x Remove-Item', 'danger'],
    ['Set-Item alias:dir -Value Remove-Item', 'danger'],
    // ---- gated（所有非危险命令——不再有只读静默层，一律先给用户看）----
    // 以下含原先被启发式“证明只读”的命令：现在同样只是 gated → 都会弹确认，这正是重点。
    ['dir', 'gated'],
    ['Get-ChildItem -Recurse', 'gated'],
    ['git status', 'gated'],
    ['git log --oneline', 'gated'],
    ['cat a.txt', 'gated'],
    ['npm install', 'gated'],
    // 误报缓解仍在：散文里的短别名不在命令位，不判危险，落入 gated（用户仍会被询问）
    ['git commit -m "del old code"', 'gated'],
    ['echo "rm is dangerous"', 'gated'],
    // former bypasses（git --output / 裸括号 / UNC 求值形态）现在只是 gated → 走确认
    ['git diff --output=C:\\tmp\\a.txt', 'gated'],
    ['echo (Set-Content C:\\x -Value p)', 'gated'],
    ['Get-Content 报告.txt', 'gated'],
  ])('%s → %s', (cmd, cls) => { expect(classifyShellCommand(cmd)).toBe(cls); });
});

const req = (detail: string, sessionId = 'S1'): PermissionRequest => ({ kind: 'shell', detail, sessionId, toolTitle: 't' });

describe('PermissionGatewayImpl', () => {
  it('danger 硬拦：即便 prompt 返回 allow-once 仍 deny，且从不询问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    expect(await g.check(req('Remove-Item -Recurse C:\\'))).toBe('deny');
    expect(asked).toBe(0);
  });

  it('首次遭遇必问：连普通 dir 也不再静默放行', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    expect(await g.check(req('dir'))).toBe('deny');
    expect(asked).toBe(1);
  });

  it('allow-once 不持久：同命令两次都要问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    expect(await g.check(req('npm install'))).toBe('allow');
    expect(await g.check(req('npm install'))).toBe('allow');
    expect(asked).toBe(2);
  });

  it('allow-session 按精确命令持久；不同命令串重新问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(req('npm test'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(req('npm test'))).toBe('allow'); // 同串原样重复 → 静默
    expect(asked).toBe(1);
    expect(await g.check(req('npm run build'))).toBe('allow'); // 不同串 → 重新问
    expect(asked).toBe(2);
  });

  it('会话批准按会话隔离：S1 批准不影响 S2', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(req('npm test'))).toBe('allow'); // S1
    expect(asked).toBe(1);
    expect(await g.check(req('npm test', 'S2'))).toBe('allow'); // S2 重新问
    expect(asked).toBe(2);
  });

  it('询问超时 → deny', async () => {
    const g = new PermissionGatewayImpl(() => new Promise(() => { /* 永不响应 */ }), undefined, 50);
    expect(await g.check(req('npm install'))).toBe('deny');
  });

  it('file-write 按路径 askOnce：allow-session 后同路径静默，不同路径重新问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    const fw = (detail: string): PermissionRequest => ({ kind: 'file-write', detail, sessionId: 'S1', toolTitle: 't' });
    expect(await g.check(fw('C:\\x.txt'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(fw('C:\\x.txt'))).toBe('allow'); // 同路径 → 静默
    expect(asked).toBe(1);
    expect(await g.check(fw('C:\\y.txt'))).toBe('allow'); // 不同路径 → 重新问
    expect(asked).toBe(2);
  });
});
