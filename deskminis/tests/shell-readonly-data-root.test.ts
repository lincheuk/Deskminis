/**
 * W1b-2 · shell 只读白名单读数据根时回落询问（止血设计稿 §2「shell 只读白名单读数据根」）。
 *
 * 只读判定命中的命令默认 bypass、静默执行：文件工具那边已经把「读 minis.db / servers.json / 凭据」收成走卡，
 * shell 这边一句 Get-Content $env:APPDATA\DeskMinis\minis.db 就能绕过去。
 * 设计稿不采纳「含未加引号的 $ 就改询问」（PowerShell 的 $_ 等变量太常见，会让大量只读命令弹卡），
 * 定为：只读判定命中、但命令文本（不区分大小写）含 deskminis、$env:、%appdata%、%localappdata% 之一时回落为 gated。
 */
import { describe, it, expect } from 'vitest';
import { classifyShellCommand, PermissionGatewayImpl } from '../src/minisd/tools/permissions';
import type { PermissionRequest } from '../src/minisd/tools/types';

describe('只读命令点到数据根 → gated', () => {
  it.each([
    'Get-Content $env:APPDATA\\DeskMinis\\minis.db',
    'gc $Env:AppData\\DeskMinis\\minisd-port.json',
    'type %APPDATA%\\DeskMinis\\providers.json',
    'dir %LocalAppData%',
    'Get-ChildItem $env:LOCALAPPDATA -Recurse',
    'cat C:\\Users\\me\\AppData\\Roaming\\DeskMinis\\mcp-servers\\servers.json',
    'Get-ChildItem C:\\Users\\me\\AppData\\Roaming\\deskminis-dev',
    'rg NEEDLE C:\\Users\\me\\AppData\\Roaming\\DESKMINIS',
    'Get-ChildItem C:\\Users\\me\\AppData\\Roaming\\DeskMinis | Select-Object Name',
    // 下面两条既不含 deskminis 也不含 $env:，只靠 %appdata% 这个字样回落——单独钉住这一个字样
    'dir %AppData%',
    'type %APPDATA%\\x.txt',
  ])('%s', (cmd) => {
    expect(classifyShellCommand(cmd)).toBe('gated');
  });
});

describe('回归：不点数据根的只读命令照旧免批，危险命令照旧硬拦', () => {
  it.each([
    'dir',
    'Get-ChildItem -Recurse src',
    'git status',
    'Get-Content 报告.txt',
    // 设计稿 §2 明确不因 $ 回落：$PWD / $HOME 这类变量在只读命令里很常见
    'Get-ChildItem $PWD',
    'Get-Process | Select-Object Name',
  ])('%s → readonly', (cmd) => {
    expect(classifyShellCommand(cmd)).toBe('readonly');
  });

  it('危险层先行：删数据根仍是 danger，不被降成 gated', () => {
    expect(classifyShellCommand('Remove-Item $env:APPDATA\\DeskMinis\\minis.db')).toBe('danger');
  });
});

describe('网关：回落后按 gated 的档位走', () => {
  const req = (detail: string): PermissionRequest => ({ kind: 'shell', detail, sessionId: 'S1', toolTitle: '看看' });

  it('默认档：弹卡询问；普通只读命令仍静默放行', async () => {
    const prompted: string[] = [];
    const gw = new PermissionGatewayImpl(async (r) => { prompted.push(r.detail); return 'deny'; });
    expect(await gw.check(req('Get-Content $env:APPDATA\\DeskMinis\\minis.db'))).toBe('deny');
    expect(await gw.check(req('Get-ChildItem src'))).toBe('allow');
    expect(prompted).toEqual(['Get-Content $env:APPDATA\\DeskMinis\\minis.db']);
  });

  it('full 档：gated 跟随档位放行（与文件工具「走卡类跟随档位」一致）', async () => {
    const prompted: string[] = [];
    const gw = new PermissionGatewayImpl(async (r) => { prompted.push(r.detail); return 'deny'; });
    gw.applyPreset('full');
    expect(await gw.check(req('Get-Content $env:APPDATA\\DeskMinis\\minis.db'))).toBe('allow');
    expect(prompted).toEqual([]);
  });
});
