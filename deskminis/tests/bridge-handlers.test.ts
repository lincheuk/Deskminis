import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeBridgeDispatcher, runPowerShell, BridgeError,
  type BridgeRequest, type BridgeDeps, type PsRunner,
} from '../src/minisd/bridge/handlers';
import { MinisPaths } from '../src/minisd/paths';
import type { PermissionGateway, PermissionRequest } from '../src/minisd/tools/types';

const SESSION = 'A1B2C3D4-E5F6-4789-ABCD-EF0123456789';

function allowGateway(captured: PermissionRequest[]): PermissionGateway {
  return { async check(r) { captured.push(r); return 'allow'; } };
}
function denyGateway(): PermissionGateway {
  return { async check() { return 'deny'; } };
}
/** 假执行器：记录调用；stdin JSON 里带 path 时落一个假 PNG（配合截图 handler 的 statSync）；
 *  设备信息脚本返回固定 JSON；其余返回指定 stdout。 */
function fakeRunPs(calls: { script: string; stdin?: string; timeoutMs?: number }[], result: { stdout?: string; stderr?: string; exitCode?: number } = {}): PsRunner {
  return async (script, stdin, timeoutMs) => {
    calls.push({ script, stdin, timeoutMs });
    if (script.includes('Win32_OperatingSystem')) {
      return { stdout: '{"osVersion":"Microsoft Windows 11 10.0.22631","computerName":"FAKE-PC","userName":"fake","cpuCount":8,"totalMemoryMB":16384,"psVersion":"5.1.22621.1"}', stderr: '', exitCode: 0 };
    }
    if (stdin) {
      try {
        const p = JSON.parse(stdin);
        if (typeof p.path === 'string') {
          const { writeFileSync, mkdirSync } = await import('node:fs');
          const { dirname } = await import('node:path');
          mkdirSync(dirname(p.path), { recursive: true });
          writeFileSync(p.path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        }
      } catch { /* 非 JSON stdin（剪贴板文本等），忽略 */ }
    }
    return { stdout: result.stdout ?? '1920x1080', stderr: result.stderr ?? '', exitCode: result.exitCode ?? 0 };
  };
}

function mkDeps(gateway: PermissionGateway, runPs: PsRunner): { deps: BridgeDeps; paths: MinisPaths } {
  const root = mkdtempSync(join(tmpdir(), 'dm-br-'));
  const paths = new MinisPaths(root);
  paths.ensureSessionDirs(SESSION);
  return { deps: { permissions: gateway, paths, runPs }, paths };
}
const req = (tool: string, action: string, args: Record<string, string> = {}, stdin?: string): BridgeRequest =>
  ({ tool, action, args, sessionId: SESSION, ...(stdin !== undefined ? { stdin } : {}) }) as BridgeRequest;

describe('分发与权限定域', () => {
  it.each([
    ['windows-notify', 'show', { title: 't' }, 'bridge-notify'],
    ['windows-clipboard', 'get', {}, 'bridge-clipboard-read'],
    ['windows-clipboard', 'set', { text: 'x' }, 'bridge-clipboard-write'],
    ['windows-open', 'open', { target: 'https://example.com' }, 'bridge-open'],
    ['windows-speak', 'say', { text: 'x' }, 'bridge-speak'],
    ['windows-screenshot', 'capture', {}, 'bridge-screenshot'],
    ['windows-device', 'info', {}, 'bridge-device'],
  ])('%s %s → 权限类目 %s，detail 为能力串', async (tool, action, args, kind) => {
    const captured: PermissionRequest[] = [];
    const calls: { script: string; stdin?: string }[] = [];
    const { deps } = mkDeps(allowGateway(captured), fakeRunPs(calls));
    await makeBridgeDispatcher(deps)(req(tool, action, args));
    expect(captured).toHaveLength(1);
    expect(captured[0].kind).toBe(kind);
    expect(captured[0].detail).toBe(`${tool} ${action}`);
    expect(captured[0].sessionId).toBe(SESSION);
    expect(captured[0].toolTitle.length).toBeGreaterThan(0);
  });

  it('未知工具 → INVALID_ARGS，且不问权限', async () => {
    const captured: PermissionRequest[] = [];
    const { deps } = mkDeps(allowGateway(captured), fakeRunPs([]));
    const env = await makeBridgeDispatcher(deps)(req('windows-nuke', 'boom'));
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_ARGS');
    expect(captured).toHaveLength(0);
  });

  it('已知工具未知动作 → INVALID_ARGS', async () => {
    const { deps } = mkDeps(allowGateway([]), fakeRunPs([]));
    const env = await makeBridgeDispatcher(deps)(req('windows-clipboard', 'delete'));
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_ARGS');
  });

  it.each([[''], ['not-a-uuid'], ['..\\..\\Windows'], ['A1B2C3D4-E5F6-4789-ABCD-EF01234567890']])(
    '非法 sessionId %j → INVALID_ARGS，且不问权限（防路径注入）', async (bad) => {
      const captured: PermissionRequest[] = [];
      const { deps } = mkDeps(allowGateway(captured), fakeRunPs([]));
      const env = await makeBridgeDispatcher(deps)({ tool: 'windows-device', action: 'info', args: {}, sessionId: bad });
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe('INVALID_ARGS');
      expect(captured).toHaveLength(0);
    });

  it('权限 deny → PERMISSION_DENIED，且不执行 PowerShell', async () => {
    const calls: { script: string }[] = [];
    const { deps } = mkDeps(denyGateway(), fakeRunPs(calls));
    const env = await makeBridgeDispatcher(deps)(req('windows-clipboard', 'get'));
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('PERMISSION_DENIED');
    expect(calls).toHaveLength(0);
  });

  it('信封形状：ok/data/timestamp(epoch秒浮点) 齐全；错误时 error{code,message} 且无 data', async () => {
    const { deps } = mkDeps(allowGateway([]), fakeRunPs([]));
    const okEnv = await makeBridgeDispatcher(deps)(req('windows-device', 'info'));
    expect(okEnv.ok).toBe(true);
    expect(okEnv.tool).toBe('windows-device');
    expect(okEnv.action).toBe('info');
    expect(okEnv.timestamp).toBeGreaterThan(1_700_000_000);
    expect(okEnv.error).toBeUndefined();
    const errEnv = await makeBridgeDispatcher(deps)(req('windows-nope', 'x'));
    expect(errEnv.ok).toBe(false);
    expect(errEnv.data).toBeUndefined();
    expect(typeof errEnv.error?.message).toBe('string');
  });
});

describe('六个 handler', () => {
  it('notify：载荷经 stdin JSON 传入，脚本零插值', async () => {
    const calls: { script: string; stdin?: string }[] = [];
    const { deps } = mkDeps(allowGateway([]), fakeRunPs(calls));
    const env = await makeBridgeDispatcher(deps)(req('windows-notify', 'show', { title: '构建完成', body: '附"引号"与\n换行' }));
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ shown: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].script).not.toContain('构建完成'); // 载荷绝不出现在脚本源码里
    expect(JSON.parse(calls[0].stdin!)).toEqual({ title: '构建完成', body: '附"引号"与\n换行' });
  });

  it('notify：title/body 缺省有默认值', async () => {
    const calls: { script: string; stdin?: string }[] = [];
    const { deps } = mkDeps(allowGateway([]), fakeRunPs(calls));
    const env = await makeBridgeDispatcher(deps)(req('windows-notify', 'show'));
    expect(env.ok).toBe(true);
    expect(JSON.parse(calls[0].stdin!)).toEqual({ title: 'DeskMinis', body: '' });
  });

  it('clipboard get：返回文本；超 1MB 截断并标记', async () => {
    const { deps } = mkDeps(allowGateway([]), fakeRunPs([], { stdout: '剪贴板内容' }));
    const env = await makeBridgeDispatcher(deps)(req('windows-clipboard', 'get'));
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ text: '剪贴板内容', truncated: false });

    const big = 'x'.repeat(1024 * 1024 + 100);
    const { deps: deps2 } = mkDeps(allowGateway([]), fakeRunPs([], { stdout: big }));
    const env2 = await makeBridgeDispatcher(deps2)(req('windows-clipboard', 'get'));
    expect(env2.ok).toBe(true);
    const d2 = env2.data as { text: string; truncated: boolean };
    expect(d2.truncated).toBe(true);
    expect(d2.text.length).toBe(1024 * 1024);
  });

  it('clipboard set：--text 优先于 stdin；两者皆无 → INVALID_ARGS', async () => {
    const calls: { script: string; stdin?: string }[] = [];
    const { deps } = mkDeps(allowGateway([]), fakeRunPs(calls));
    const env = await makeBridgeDispatcher(deps)(req('windows-clipboard', 'set', { text: '参数文本' }, '管道文本'));
    expect(env.ok).toBe(true);
    expect(JSON.parse(calls[0].stdin!)).toEqual({ text: '参数文本' });

    const { deps: deps2 } = mkDeps(allowGateway([]), fakeRunPs(calls));
    const env2 = await makeBridgeDispatcher(deps2)(req('windows-clipboard', 'set', {}, '管道文本'));
    expect(env2.ok).toBe(true);
    expect(JSON.parse(calls[1].stdin!)).toEqual({ text: '管道文本' });

    const { deps: deps3 } = mkDeps(allowGateway([]), fakeRunPs([]));
    const env3 = await makeBridgeDispatcher(deps3)(req('windows-clipboard', 'set'));
    expect(env3.ok).toBe(false);
    expect(env3.error?.code).toBe('INVALID_ARGS');
  });

  it('open：http(s) 直放；本机存在路径放行；不存在且非网址 → INVALID_ARGS', async () => {
    const calls: { script: string; stdin?: string }[] = [];
    const { deps, paths } = mkDeps(allowGateway([]), fakeRunPs(calls));
    const env = await makeBridgeDispatcher(deps)(req('windows-open', 'open', { target: 'https://example.com' }));
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ opened: 'https://example.com' });

    const realFile = join(paths.sessionBucket(SESSION, 'workspace'), 'a.txt');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(realFile, 'x');
    const env2 = await makeBridgeDispatcher(deps)(req('windows-open', 'open', { target: realFile }));
    expect(env2.ok).toBe(true);

    const env3 = await makeBridgeDispatcher(deps)(req('windows-open', 'open', { target: 'C:\\绝\\对\\不\\存\\在.txt' }));
    expect(env3.ok).toBe(false);
    expect(env3.error?.code).toBe('INVALID_ARGS');
    const env4 = await makeBridgeDispatcher(deps)(req('windows-open', 'open', {}));
    expect(env4.ok).toBe(false);
    expect(env4.error?.code).toBe('INVALID_ARGS');
  });

  it('speak：rate 合法直放；非整数/超界 → INVALID_ARGS；--text 与 stdin 兜底', async () => {
    const calls: { script: string; stdin?: string; timeoutMs?: number }[] = [];
    const { deps } = mkDeps(allowGateway([]), fakeRunPs(calls));
    const env = await makeBridgeDispatcher(deps)(req('windows-speak', 'say', { text: '你好', rate: '-2' }));
    expect(env.ok).toBe(true);
    expect(JSON.parse(calls[0].stdin!)).toEqual({ text: '你好', rate: -2 });
    expect(calls[0].timeoutMs).toBe(120000); // 播报耗时与文本长度相关，放宽到 120s

    const env2 = await makeBridgeDispatcher(deps)(req('windows-speak', 'say', { text: 'x', rate: '11' }));
    expect(env2.ok).toBe(false);
    expect(env2.error?.code).toBe('INVALID_ARGS');
    const env3 = await makeBridgeDispatcher(deps)(req('windows-speak', 'say', { text: 'x', rate: '1.5' }));
    expect(env3.ok).toBe(false);
    const env4 = await makeBridgeDispatcher(deps)(req('windows-speak', 'say', {}, 'stdin 文本'));
    expect(env4.ok).toBe(true);
    expect(JSON.parse(calls[1].stdin!)).toEqual({ text: 'stdin 文本' });
    const env5 = await makeBridgeDispatcher(deps)(req('windows-speak', 'say', {}));
    expect(env5.ok).toBe(false);
    expect(env5.error?.code).toBe('INVALID_ARGS');
  });

  it('screenshot：PNG 落会话 attachments，返回 {path,width,height,bytes}', async () => {
    const { deps } = mkDeps(allowGateway([]), fakeRunPs([]));
    const env = await makeBridgeDispatcher(deps)(req('windows-screenshot', 'capture'));
    expect(env.ok).toBe(true);
    const d = env.data as { path: string; width: number; height: number; bytes: number };
    expect(d.path).toContain('attachments');
    expect(d.path).toMatch(/screenshot-.*\.png$/);
    expect(d.width).toBe(1920);
    expect(d.height).toBe(1080);
    expect(d.bytes).toBe(4); // 假 PNG 四字节
    expect(existsSync(d.path)).toBe(true);
  });

  it('device：解析 PowerShell 输出 JSON 为 data', async () => {
    const { deps } = mkDeps(allowGateway([]), fakeRunPs([]));
    const env = await makeBridgeDispatcher(deps)(req('windows-device', 'info'));
    expect(env.ok).toBe(true);
    const d = env.data as Record<string, unknown>;
    expect(d.computerName).toBe('FAKE-PC');
    expect(d.cpuCount).toBe(8);
  });

  it('PowerShell 非零退出 → EXEC_ERROR（带 stderr）', async () => {
    const { deps } = mkDeps(allowGateway([]), fakeRunPs([], { stdout: '', stderr: '爆栈了', exitCode: 1 }));
    const env = await makeBridgeDispatcher(deps)(req('windows-notify', 'show', { title: 'x' }));
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('EXEC_ERROR');
    expect(env.error?.message).toContain('爆栈了');
  });
});

describe('runPowerShell（真实 powershell.exe）', () => {
  it('stdin 透传：脚本 ReadToEnd 原样读回（含中文）', async () => {
    // [Console]::Out.Write 显式无换行：PowerShell 表达式结果自动追加换行会破坏信封。
    const r = await runPowerShell('[Console]::Out.Write([Console]::In.ReadToEnd())', '你好，桥');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('你好，桥');
  });

  it('原生命令退出码穿透', async () => {
    const r = await runPowerShell('exit 3');
    expect(r.exitCode).toBe(3);
  });

  it('超时杀进程返回 124', async () => {
    const r = await runPowerShell('Start-Sleep -Seconds 60', '', 1500);
    expect(r.exitCode).toBe(124);
  }, 20000);
});

describe('真实 PowerShell 集成（allow-all 网关）', () => {
  const realDeps = (): BridgeDeps => {
    const root = mkdtempSync(join(tmpdir(), 'dm-br-real-'));
    const paths = new MinisPaths(root);
    paths.ensureSessionDirs(SESSION);
    return { permissions: { async check() { return 'allow' as const; } }, paths };
  };

  // 用户剪贴板是系统全局资源——本 describe 的 clipboard 用例会改写它，
  // 必须先存旧值、测后恢复，避免破坏用户当前剪贴板内容。
  let savedClipboard = '';
  beforeAll(async () => {
    const r = await runPowerShell(`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
[Console]::Out.Write([System.Windows.Forms.Clipboard]::GetText())`);
    savedClipboard = r.stdout;
  });
  afterAll(async () => {
    await runPowerShell(`[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$t = [Console]::In.ReadToEnd()
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText($t)`, savedClipboard);
  });

  it('clipboard set→get 往返（会短暂改写本机剪贴板）', async () => {
    const dispatch = makeBridgeDispatcher(realDeps());
    const setEnv = await dispatch(req('windows-clipboard', 'set', { text: 'DeskMinis-M2E-测试①' }));
    expect(setEnv.ok).toBe(true);
    const getEnv = await dispatch(req('windows-clipboard', 'get'));
    expect(getEnv.ok).toBe(true);
    expect((getEnv.data as { text: string }).text).toBe('DeskMinis-M2E-测试①');
  });

  it('device info 返回本机真实字段', async () => {
    const env = await makeBridgeDispatcher(realDeps())(req('windows-device', 'info'));
    expect(env.ok).toBe(true);
    const d = env.data as Record<string, unknown>;
    expect(d.computerName).toBe(process.env.COMPUTERNAME);
    expect(typeof d.totalMemoryMB).toBe('number');
    expect((d.cpuCount as number) > 0).toBe(true);
  });

  it('screenshot 真截屏存 PNG（需交互式桌面会话）', async () => {
    const env = await makeBridgeDispatcher(realDeps())(req('windows-screenshot', 'capture'));
    expect(env.ok).toBe(true);
    const d = env.data as { path: string; width: number; height: number; bytes: number };
    const head = readFileSync(d.path).subarray(0, 4);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG 魔数
    expect(d.width).toBeGreaterThan(0);
    expect(d.bytes).toBeGreaterThan(1000);
  }, 30000);
});
