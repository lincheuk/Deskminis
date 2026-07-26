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
    // ---- 第 3 轮：求值形态绕过（裸括号是求值操作符，旧实现只拦 $( 与 @( ）----
    ['echo (Set-Content C:\\important.txt -Value pwned)', 'write'],
    ['Get-Date (Start-Process calc)', 'write'],
    ['type (Move-Item C:\\a C:\\b)', 'write'],
    ['@(Get-Content a.txt)', 'write'],
    ['Get-Content `nSet-Content b.txt', 'write'],
    // ---- 第 3 轮：影子命名提权（长驻 shell 中自定义函数冒充 get-* 白名单）----
    ['Get-Stuff', 'write'],
    ['get-payload.ps1', 'write'],
    ['function Get-Stuff { Set-Content C:\\x -Value p }', 'danger'],
    ['Set-Alias dir Remove-Item', 'danger'],
    ['Set-Item alias:dir -Value Remove-Item', 'danger'],
    ['New-Item -Path function:dir -Value { Move-Item C:\\a C:\\b }', 'danger'],
    ['doskey dir=del $*', 'danger'],
    // ---- 第 3 轮：git 只读前缀 + 无约束尾巴 ----
    ['git branch -D main', 'write'],
    ['git remote remove origin', 'write'],
    ['git config --get user.name', 'write'],
    // ---- 第 3 轮：多行字符串可串联多条命令 ----
    ['dir\nnpm install', 'write'],
    ['git status\r\nnpm publish', 'write'],
    // ---- 第 3 轮：误报缓解——短别名只在命令位算危险，散文里不算（用户仍会被询问）----
    ['git commit -m "del old code"', 'write'],
    ['echo "rm is dangerous"', 'write'],
    // ---- 第 3 轮：可用性守护——正常只读命令必须仍然直行 ----
    ['Get-Content 报告.txt', 'read'],
    ['git log --oneline', 'read'],
    ['Get-ChildItem -Recurse', 'read'],
    ['Test-Path C:\\Users\\me\\a.txt', 'read'],
    ['findstr /i TODO src\\*.ts', 'read'],
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
  it('求值绕过已封堵：裸括号里的写操作不再静默放行，必须过询问路径', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    expect(await g.check(req('echo (Set-Content C:\\x -Value p)'))).toBe('deny');
    expect(asked).toBe(1); // 关键：被问过恰好一次，即不再属于 bypass 只读层
  });
  it('影子命名提权已封堵：自定义函数名不冒充只读，定义本身判 danger', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    expect(await g.check(req('function Get-Stuff { Set-Content C:\\x -Value p }'))).toBe('deny');
    expect(asked).toBe(0); // 定义直接拦
    expect(await g.check(req('Get-Stuff'))).toBe('deny');
    expect(asked).toBe(1); // 调用降级为需确认，不再静默
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
