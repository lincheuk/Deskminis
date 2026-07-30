import { describe, it, expect, afterAll } from 'vitest';
import { PersistentShell, ShellManager, makeShellTool } from '../src/minisd/tools/shell';
import type { PermissionRequest, PermissionDecision } from '../src/minisd/tools/types';
import { MinisPaths } from '../src/minisd/paths';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shells: PersistentShell[] = [];
afterAll(() => { for (const s of shells) s.dispose(); });
function mk(cwd = tmpdir()): PersistentShell { const s = new PersistentShell(cwd); shells.push(s); return s; }

describe('PersistentShell (真实 powershell)', () => {
  it('echo 输出与退出码 0', async () => {
    const r = await mk().run('Write-Output "你好世界"');
    expect(r.output.trim()).toBe('你好世界');
    expect(r.exitCode).toBe(0);
  });
  it('原生命令退出码穿透', async () => {
    const r = await mk().run('cmd /c exit 3');
    expect(r.exitCode).toBe(3);
  });
  it('cd 跨命令持久', async () => {
    const s = mk();
    const target = mkdtempSync(join(tmpdir(), 'dm-cd-'));
    await s.run(`cd "${target}"`);
    const r = await s.run('(Get-Location).Path');
    expect(r.output.trim().toLowerCase()).toBe(target.toLowerCase());
  });
  it('stderr 并入输出', async () => {
    const s = mk();
    const native = await s.run('cmd /c "echo ERRLINE 1>&2"');
    expect(native.output).toContain('ERRLINE');
    const psError = await s.run('Write-Error "oops-marker"');
    expect(psError.output).toContain('oops-marker');
  });
  it('超时杀进程, 下条命令自动重建', async () => {
    const s = mk();
    const r = await s.run('Start-Sleep -Seconds 60', 1500);
    expect(r.exitCode).toBe(124);
    const r2 = await s.run('Write-Output ok');
    expect(r2.output.trim()).toBe('ok');
  }, 20000);
  it('spawn 失败被兜住: 返回工具错误而不是杀死进程', async () => {
    const bad = mk('C:\\definitely-not-a-real-dir-xyz\\workspace');
    const r = await bad.run('Write-Output x'); // 必须 resolve，不能 reject、不能悬挂
    expect([127, 129]).toContain(r.exitCode);
    expect(true).toBe(true); // 本测试进程仍然活着（未被 unhandled 'error' 杀掉）
    const healthy = await mk().run('Write-Output alive'); // 之后新建的健康 shell 照常工作
    expect(healthy.output.trim()).toBe('alive');
    expect(healthy.exitCode).toBe(0);
  }, 20000);
  it('子进程死于 spawn 前后, 连发命令的 stdin 异步错误被吞: minisd 不被杀死', async () => {
    // cwd 无效 → 子进程在 spawn 期间/之后即死。此时向其 stdin 写入会在 stdin 流上异步发 'error'(EPIPE)；
    // 若该流没挂 error 监听器, 事件会冒泡到进程级 unhandled 处理并杀死整个 minisd(同步 try/catch 兜不住异步事件)。
    // 连发两条命令给该路径加压: 两条都必须 resolve, 不能 reject / 悬挂 / 杀进程。
    const bad = mk('C:\\definitely-not-a-real-dir-xyz\\workspace');
    const r1 = await bad.run('Write-Output x');
    const r2 = await bad.run('Write-Output y'); // 第二条命中已死/正在关闭的 stdin
    expect([127, 129, 130]).toContain(r1.exitCode);
    expect([127, 129, 130]).toContain(r2.exitCode);
    // 本测试进程仍然活着(未被 unhandled stdin 'error' 杀掉): 新建的健康 shell 照常返回 exitCode 0。
    const healthy = await mk().run('Write-Output alive');
    expect(healthy.output.trim()).toBe('alive');
    expect(healthy.exitCode).toBe(0);
  }, 20000);
  it('dispose 后不再复活进程', async () => {
    const s = mk();
    const first = await s.run('Write-Output ok');
    expect(first.output.trim()).toBe('ok');
    s.dispose();
    const after = await s.run('Write-Output again');
    expect(after.exitCode).toBe(130);
    expect(after.output).toContain('已释放');
  }, 20000);
});

describe('shell_execute 工具', () => {
  it('权限 deny 时不执行', async () => {
    const asked: PermissionRequest[] = [];
    const gateway = { async check(r: PermissionRequest): Promise<PermissionDecision> { asked.push(r); return 'deny'; } };
    const root = mkdtempSync(join(tmpdir(), 'dm-sh-'));
    const paths = new MinisPaths(root); paths.ensureSessionDirs('S1');
    const mgr = new ShellManager();
    const tool = makeShellTool(mgr);
    const r = await tool.execute({ command: 'Write-Output x', tool_title: '测试' }, { sessionId: 'S1', paths, permissions: gateway });
    expect(r.success).toBe(false);
    expect(asked[0]).toMatchObject({ kind: 'shell', detail: 'Write-Output x' });
    mgr.disposeAll();
  });

  it('envFor 注入的变量在会话 shell 可见（MINIS_* 桥环境）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dm-sh-env-'));
    const paths = new MinisPaths(root); paths.ensureSessionDirs('S1');
    const mgr = new ShellManager();
    const tool = makeShellTool(mgr, ctx => ({ MINIS_CHAT_SESSION_ID: ctx.sessionId, MINIS_BRIDGE_PIPE: '\\\\.\\pipe\\deskminis-deadbeef' }));
    const allowAll = { async check(): Promise<PermissionDecision> { return 'allow'; } };
    const r = await tool.execute({ command: '$env:MINIS_CHAT_SESSION_ID + "|" + $env:MINIS_BRIDGE_PIPE', tool_title: '读桥环境变量' }, { sessionId: 'S1', paths, permissions: allowAll });
    expect(r.success).toBe(true);
    expect(r.output).toContain('S1|\\\\.\\pipe\\deskminis-deadbeef');
    mgr.disposeAll();
  });
});
