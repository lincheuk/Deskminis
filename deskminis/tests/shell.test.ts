import { describe, it, expect, afterAll } from 'vitest';
import { PersistentShell, ShellManager, makeShellTool, decodeShellOutput } from '../src/minisd/tools/shell';
import type { PermissionRequest, PermissionDecision } from '../src/minisd/tools/types';
import { MinisPaths } from '../src/minisd/paths';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeBridgeEnv, resolveBridgeCliPath, resolveBridgeNode } from '../src/minisd/bridge/server';

const shells: PersistentShell[] = [];
afterAll(() => { for (const s of shells) s.dispose(); });
function mk(cwd = tmpdir()): PersistentShell { const s = new PersistentShell(cwd); shells.push(s); return s; }

describe('PersistentShell (真实 powershell)', () => {
  it('echo 输出与退出码 0', async () => {
    const r = await mk().run('Write-Output "你好世界"');
    expect(r.output.trim()).toBe('你好世界');
    expect(r.exitCode).toBe(0);
  });
  it('GBK 原始字节兜底解码为可读中文', async () => {
    // 模拟硬编码 GBK 输出、不跟随 chcp 的老原生 exe：GetBytes(936) 绕过控制台代码页
    // 直吐 GBK 字节，任何机器上都命中宿主侧 decodeShellOutput 的 GBK 降级路径
    const r = await mk().run("$b=[Text.Encoding]::GetEncoding(936).GetBytes('汉字兜底'); [Console]::OpenStandardOutput().Write($b,0,$b.Length)");
    expect(r.output.trim()).toBe('汉字兜底');
  }, 20000);
  it('输出含坏字节不影响退出码解析（哨兵按字节切割）', async () => {
    // 0xFF 在 UTF-8 与 GBK 下都非法，解码后必成替换符——但具体码点随 ICU 版本而异
    // （node 解为 U+FFFD，Electron 的 ICU 解为 PUA 区 U+F8F5），断言锚定「恰好一个非 ASCII
    // 替换字符」即可；本用例真正的锚点是：坏字节混在输出里也绝不干扰哨兵定位与退出码提取
    const r = await mk().run('[Console]::OpenStandardOutput().Write([byte[]](255),0,1); cmd /c exit 7');
    expect(r.exitCode).toBe(7);
    expect([...r.output].length).toBe(1);
    expect(r.output.codePointAt(0)!).toBeGreaterThan(0x7f);
  }, 20000);
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
    // 超时杀掉的是整个常驻驱动，会话积累的 cd/环境变量随之丢失：
    // 重建后的下一条命令必须带重启提示，否则模型还误以为状态跨命令持久（本次修复核心）
    expect(r2.output.trim()).toBe('[提示：shell 已重启，工作目录与环境变量已复位到初始状态]\nok');
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
  it('interrupt 后当前命令以非零码 resolve 不悬挂', async () => {
    const mgr = new ShellManager();
    const p = mgr.run('S1', tmpdir(), 'Start-Sleep -Seconds 60', 30000);
    // 等驱动把命令真正发出去（进入睡眠）再杀，避免打断的是启动阶段
    await new Promise(r => setTimeout(r, 800));
    mgr.interrupt('S1'); // 会话级中断：杀进程但不释放会话，下一条命令自动重建
    const r = await p; // 必须 resolve，不能悬挂
    expect(r.exitCode).not.toBe(0);
    mgr.disposeAll();
  }, 15000);
  it('interrupt 后重建的 shell 下一条命令输出头部含重启提示', async () => {
    const s = mk();
    const p = s.run('Start-Sleep -Seconds 60', 30000);
    await new Promise(r => setTimeout(r, 800));
    s.interrupt();
    await p;
    const r2 = await s.run('Write-Output ok');
    // 状态丢失必须让模型知道：cd/环境变量已复位到初始，否则模型带着错误假设继续
    expect(r2.output.trim()).toMatch(/^\[提示：shell 已重启，工作目录与环境变量已复位到初始状态\]/);
    expect(r2.output).toContain('ok');
  }, 15000);
});

describe('shell_execute 工具', () => {
  it('权限 deny 时不执行', async () => {
    const asked: PermissionRequest[] = [];
    const gateway = { async check(r: PermissionRequest): Promise<PermissionDecision> { asked.push(r); return 'deny'; }, hasBridgeGrant: () => false };
    const root = mkdtempSync(join(tmpdir(), 'dm-sh-'));
    const paths = new MinisPaths(root); paths.ensureSessionDirs('S1');
    const mgr = new ShellManager();
    const tool = makeShellTool(mgr);
    const r = await tool.execute({ command: 'Write-Output x', tool_title: '测试' }, { sessionId: 'S1', paths, permissions: gateway });
    expect(r.success).toBe(false);
    expect(asked[0]).toMatchObject({ kind: 'shell', detail: 'Write-Output x' });
    mgr.disposeAll();
  });

  it('权限等待期间取消（批准晚于取消）→ 返回取消且命令根本不启动', async () => {
    // 开头 aborted 检查过闸后，权限询问可挂 90 秒；期间点停止、之后卡片才批准。
    // 已 abort 的 signal 挂 abort 监听不会触发（事件不补发）——闸后必须重查，
    // 否则命令会原样跑完（重查生效的证据：本用例从头到尾没有 PowerShell 被拉起，瞬时完成）。
    const controller = new AbortController();
    const lateAllow = { async check(): Promise<PermissionDecision> { controller.abort(); return 'allow'; }, hasBridgeGrant: () => false };
    const root = mkdtempSync(join(tmpdir(), 'dm-sh-late-'));
    const paths = new MinisPaths(root); paths.ensureSessionDirs('S1');
    const mgr = new ShellManager();
    const tool = makeShellTool(mgr);
    const r = await tool.execute({ command: 'Write-Output leaked', tool_title: '测试' }, { sessionId: 'S1', paths, permissions: lateAllow, signal: controller.signal });
    expect(r.success).toBe(false);
    expect(r.output).toContain('已取消');
    mgr.disposeAll();
  });

  it('envFor 注入的变量在会话 shell 可见（MINIS_* 桥环境）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dm-sh-env-'));
    const paths = new MinisPaths(root); paths.ensureSessionDirs('S1');
    const mgr = new ShellManager();
    const tool = makeShellTool(mgr, ctx => ({ MINIS_CHAT_SESSION_ID: ctx.sessionId, MINIS_BRIDGE_PIPE: '\\\\.\\pipe\\deskminis-deadbeef' }));
    const allowAll = { async check(): Promise<PermissionDecision> { return 'allow'; }, hasBridgeGrant: () => false };
    const r = await tool.execute({ command: '$env:MINIS_CHAT_SESSION_ID + "|" + $env:MINIS_BRIDGE_PIPE', tool_title: '读桥环境变量' }, { sessionId: 'S1', paths, permissions: allowAll });
    expect(r.success).toBe(true);
    expect(r.output).toContain('S1|\\\\.\\pipe\\deskminis-deadbeef');
    mgr.disposeAll();
  });

  it('真实 PowerShell 链路：& "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" --help 输出桥帮助（electron GUI PE 的 stdout 缺陷回归）', async () => {
    // 手工验收步骤 1 发现：electron.exe 是 GUI 子系统 PE，PowerShell & 直调不等待/不接管 stdout，
    // 输出全空且 $LASTEXITCODE 不设；node.exe（CONSOLE 子系统）正常。
    // 本用例用 ShellManager + makeShellTool 真起 PowerShell，envFor 注入 makeBridgeEnv，
    // 调用系统提示主推的 & 形式，确保 --help 纯本地链路拿到真实输出。
    const root = mkdtempSync(join(tmpdir(), 'dm-sh-br-'));
    const paths = new MinisPaths(root); paths.ensureSessionDirs('S1');
    const bridgeCli = resolveBridgeCliPath();
    expect(bridgeCli).toBeTruthy(); // 先决：stub 能定位（否则本用例挂起也没意义）
    const mgr = new ShellManager();
    const tool = makeShellTool(mgr, ctx => makeBridgeEnv(ctx.sessionId, undefined, bridgeCli!, resolveBridgeNode()));
    const allowAll = { async check(): Promise<PermissionDecision> { return 'allow'; }, hasBridgeGrant: () => false };
    const cmd = '& "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" --help';
    const r = await tool.execute({ command: cmd, tool_title: '调用桥 CLI --help' }, { sessionId: 'S1', paths, permissions: allowAll });
    expect(r.success).toBe(true); // exitCode===0 → success=true（shell.ts 153 行）
    expect(r.output).toContain('DeskMinis windows-* 桥 CLI');
    expect(r.output).toContain('[exit=0, '); // shell 工具把 exitCode 拼进 output
    mgr.disposeAll();
  }, 60000);
});

describe('decodeShellOutput（纯函数）', () => {
  it('纯 UTF-8 中文：无替换符，直接采用不降级', () => {
    expect(decodeShellOutput(Buffer.from('你好世界', 'utf8'))).toBe('你好世界');
  });
  it('GBK 字节：UTF-8 解码含替换符，降级解出中文', () => {
    // 「你好」的 GBK 编码 C4 E3 BA C3 不是合法 UTF-8，UTF-8 解码必产生 U+FFFD → 触发降级
    expect(decodeShellOutput(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))).toBe('你好');
  });
  it('纯 ASCII：合法 UTF-8 子集，解码即终', () => {
    expect(decodeShellOutput(Buffer.from('hello shell'))).toBe('hello shell');
  });
});
