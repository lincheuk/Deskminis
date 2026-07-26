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
});
