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

  const fr = (detail: string): PermissionRequest => ({ kind: 'file-read', detail, sessionId: 'S1', toolTitle: 't' });

  it('file-read 默认 askOnce：数据根外的读取必须问过用户，deny 即拒', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    expect(await g.check(fr('C:\\Users\\u\\.ssh\\id_rsa'))).toBe('deny');
    expect(asked).toBe(1);
  });

  it('file-read 按路径记忆：allow-session 后同路径静默，不同路径重新问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(fr('C:\\a.txt'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(fr('C:\\a.txt'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(fr('C:\\b.txt'))).toBe('allow');
    expect(asked).toBe(2);
  });

  it('file-read 的 detail 是路径，不走 shell 分类器（含危险词的路径仍然只是询问）', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    // 作为 shell 命令这条会被判 danger（\bdiskpart\b）→ 若路由错误就会静默 deny 且从不询问
    expect(await g.check(fr('C:\\tools\\diskpart\\notes.txt'))).toBe('allow');
    expect(asked).toBe(1);
  });

  it('file-read 与 file-write 的会话批准互不串用', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(fr('C:\\x.txt'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check({ kind: 'file-write', detail: 'C:\\x.txt', sessionId: 'S1', toolTitle: 't' })).toBe('allow');
    expect(asked).toBe(2); // 读的批准不等于写的批准
  });
});

describe('桥类目（M2e 扩展）', () => {
  const bridgeReq = (kind: PermissionRequest['kind'], detail: string, sessionId = 'S1'): PermissionRequest =>
    ({ kind, detail, sessionId, toolTitle: 't' });

  it('bridge-device 默认 bypass：放行且从不询问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    expect(await g.check(bridgeReq('bridge-device', 'windows-device info'))).toBe('allow');
    expect(asked).toBe(0);
  });

  it('bridge-clipboard-read / bridge-screenshot 默认 askOnce：先问，allow-session 后按能力串静默', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(bridgeReq('bridge-clipboard-read', 'windows-clipboard get'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(bridgeReq('bridge-clipboard-read', 'windows-clipboard get'))).toBe('allow'); // 同能力 → 静默
    expect(asked).toBe(1);
    expect(await g.check(bridgeReq('bridge-screenshot', 'windows-screenshot capture'))).toBe('allow'); // 不同能力 → 重新问
    expect(asked).toBe(2);
  });

  it('六个 askOnce 桥类目逐个验证：notify/open/speak/clipboard-read/clipboard-write/screenshot', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    const cases: PermissionRequest['kind'][] = [
      'bridge-notify', 'bridge-open', 'bridge-speak',
      'bridge-clipboard-read', 'bridge-clipboard-write', 'bridge-screenshot',
    ];
    for (const kind of cases) {
      expect(await g.check(bridgeReq(kind, `detail-of-${kind}`))).toBe('allow');
    }
    expect(asked).toBe(6); // allow-once 不持久，每个类目都问了
  });

  it('桥 kind 不经 shell 分类器：detail 含危险词也只是按桥级别询问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    // 'Remove-Item' 作为 shell 命令是 danger → 若路由错误会静默 deny 且从不询问（对齐 M1 file-read 路由回归用例）
    expect(await g.check(bridgeReq('bridge-notify', 'Remove-Item'))).toBe('allow');
    expect(asked).toBe(1);
  });

  it('桥授权按会话隔离：S1 的 allow-session 不惠及 S2', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    expect(await g.check(bridgeReq('bridge-open', 'windows-open open', 'S1'))).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check(bridgeReq('bridge-open', 'windows-open open', 'S2'))).toBe('allow');
    expect(asked).toBe(2);
  });

  it('既有行为不回归：danger 硬拦不问、gated 问、file-read 问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    expect(await g.check({ kind: 'shell', detail: 'Remove-Item -Recurse C:\\x', sessionId: 'S1', toolTitle: 't' })).toBe('deny');
    expect(asked).toBe(0);
    expect(await g.check({ kind: 'shell', detail: 'dir', sessionId: 'S1', toolTitle: 't' })).toBe('allow');
    expect(asked).toBe(1);
    expect(await g.check({ kind: 'file-read', detail: 'C:\\a.txt', sessionId: 'S1', toolTitle: 't' })).toBe('allow');
    expect(asked).toBe(2);
  });
});

describe('applyPreset（权限选择器三档真实作用于网关）', () => {
  it("'full' 放行 gated/file-read/file-write 与全部 bridge-*，且从不询问", async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    g.applyPreset('full');
    expect(await g.check(req('dir'))).toBe('allow'); // gated
    expect(await g.check({ kind: 'file-read', detail: 'C:\\a.txt', sessionId: 'S1', toolTitle: 't' })).toBe('allow');
    expect(await g.check({ kind: 'file-write', detail: 'C:\\b.txt', sessionId: 'S1', toolTitle: 't' })).toBe('allow');
    // 桥七类全部放行
    const bridgeKinds: PermissionRequest['kind'][] = [
      'bridge-notify', 'bridge-clipboard-read', 'bridge-clipboard-write',
      'bridge-open', 'bridge-speak', 'bridge-screenshot', 'bridge-device',
    ];
    for (const kind of bridgeKinds) expect(await g.check({ kind, detail: `detail-${kind}`, sessionId: 'S1', toolTitle: 't' })).toBe('allow');
    expect(asked).toBe(0);
  });

  it("'full' 下 danger 仍 deny（不可逆系统操作拦截）且从不询问", async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    g.applyPreset('full');
    expect(await g.check(req('Remove-Item -Recurse C:\\'))).toBe('deny');
    expect(asked).toBe(0);
  });

  it("'full' 切回 'ask'：恢复询问（gated 不再静默放行）", async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    g.applyPreset('full');
    expect(await g.check(req('dir'))).toBe('allow');
    expect(asked).toBe(0);
    g.applyPreset('ask');
    expect(await g.check(req('dir'))).toBe('deny');
    expect(asked).toBe(1); // 恢复询问
  });

  it("'session' 与 'ask' 网关行为一致（都恢复 DEFAULT_LEVELS）", async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    g.applyPreset('full');
    g.applyPreset('session');
    expect(await g.check(req('dir'))).toBe('deny');
    expect(asked).toBe(1);
  });
});
