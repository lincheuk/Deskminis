/** 执行隔离方案第 0 步（止血）。
 *
 *  1. 危险规则补缺口：磁盘级 cmdlet、.NET 静态删除、robocopy 镜像。
 *  2. 经 cmd /c、powershell -Command / -EncodedCommand 嵌进去的里层命令同样过危险规则；认出是编码命令却解不开的按危险拒绝。
 *  3. 完全访问档下，点到 DeskMinis 数据目录或 AppData 的命令仍询问。
 *  4. 端口文件默认不再带 authToken，只有 DESKMINIS_PERSIST_AUTH_TOKEN=1 时才写。
 *
 *  这些都还是按命令写法判断，挡不住换了写法的（拼接出来的命令名、cmd 的 %变量% 展开）；真正的边界是方案后面的沙箱。 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { asksInFullMode, classifyShellCommand, expandNestedShells, PermissionGatewayImpl } from '../src/minisd/tools/permissions';
import type { PermissionRequest } from '../src/minisd/tools/types';
import { persistAuthTokenEnabled, startMinisd } from '../src/minisd/index';
import { restoreEngineBuiltins } from './engine-wiring';

/** PowerShell -EncodedCommand 的格式：UTF-16LE 再 base64。 */
const enc = (script: string): string => Buffer.from(script, 'utf16le').toString('base64');

describe('危险规则补缺口', () => {
  it.each([
    'Format-Volume -DriveLetter D',
    'Clear-Disk -Number 1 -RemoveData',
    'Initialize-Disk -Number 2',
    'Get-Partition -DiskNumber 1 | Remove-Partition',
    '[IO.File]::Delete("C:\\a.txt")',
    '[System.IO.Directory]::Delete("C:\\proj", $true)',
    '[ System.IO.File ]::Delete("C:\\a.txt")',
    '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory("C:\\proj", "DeleteAllContents")',
    'robocopy C:\\empty C:\\proj /MIR',
    'robocopy.exe C:\\src D:\\dst /E /PURGE',
  ])('%s → danger', (cmd) => {
    expect(classifyShellCommand(cmd)).toBe('danger');
  });

  it.each([
    ['robocopy C:\\src D:\\dst /E', 'gated'],
    ['[IO.File]::ReadAllText("a.txt")', 'gated'],
    ['rg "Format" src', 'readonly'],
  ])('%s 不受新规则误伤 → %s', (cmd, cls) => {
    expect(classifyShellCommand(cmd)).toBe(cls);
  });
});

describe('嵌套 shell 的里层命令', () => {
  it.each([
    'cmd /c del /s /q C:\\proj',
    'cmd /c "rd /s /q C:\\proj"',
    'cmd.exe /C rmdir /s /q build',
    'cmd /s /c "dir & del x"',
    'cmd /d /c "echo hi && erase a.txt"',
    'cmd /c"del x"',
    'cmd /k @del x',
    'cmd /c d^el /q x', // cmd 把引号外的 ^ 当转义吞掉
    'C:\\Windows\\System32\\cmd.exe /c del x',
    '& "C:\\Windows\\System32\\cmd.exe" /c del x',
    'npm run build; cmd /c "rd /s /q dist"',
    'powershell -NoProfile -Command "rm -r x"',
    'powershell -c "ri x"',
    'pwsh -nop -c \'del x\'',
    'powershell -ExecutionPolicy Bypass -Command "rd x"',
    'powershell rm x', // 位置参数形式的命令
    `powershell -enc ${enc('Remove-Item -Recurse C:\\proj')}`,
    `powershell -EncodedCommand ${enc('rm -r x')}`,
    `powershell.exe -NoProfile -e ${enc('del x')}`,
    `pwsh -ec ${enc('Format-Volume -DriveLetter D')}`,
    `cmd /c powershell -enc ${enc('rd /s /q x')}`, // 两层
    'powershell -enc not-base64!!', // 认得出是编码命令、解不开
    'powershell -enc QQ==', // 合法 base64，但不是 UTF-16 文本
    'powershell -enc', // 编码参数后面没有值
  ])('%s → danger', (cmd) => {
    expect(classifyShellCommand(cmd)).toBe('danger');
  });

  it.each([
    ['cmd /c dir', 'gated'],
    ['cmd /c "npm run build"', 'gated'],
    [`powershell -enc ${enc('Get-ChildItem')}`, 'gated'],
    ['powershell -NoProfile -File build.ps1', 'gated'],
    ['powershell -ExecutionPolicy', 'gated'], // 参数缺值：不展开，也不会卡住
    ['pwsh -Version', 'gated'],
    ['rg "cmd /c" src', 'readonly'],
    ['rg powershell src', 'readonly'],
    ['git log --oneline', 'readonly'],
    ['npm test', 'gated'],
  ])('%s → %s（不误伤）', (cmd, cls) => {
    expect(classifyShellCommand(cmd)).toBe(cls);
  });

  it('展开结果带上各层文本；编码命令解出原文', () => {
    const r = expandNestedShells(`cmd /c powershell -enc ${enc('Get-Date')}`);
    expect(r.undecodable).toBe(false);
    expect(r.texts).toContain('Get-Date');
  });

  it('层数超过上限按解不开处理', () => {
    let cmd = 'dir';
    for (let i = 0; i < 6; i++) cmd = `cmd /c ${cmd}`;
    expect(expandNestedShells(cmd).undecodable).toBe(true);
    expect(classifyShellCommand(cmd)).toBe('danger');
  });
});

describe('完全访问档下点到数据目录的命令仍询问', () => {
  it.each([
    ['Set-Content $env:APPDATA\\DeskMinis\\providers.json x', true],
    ['Get-Content C:\\Users\\u\\AppData\\Roaming\\DeskMinis\\minisd-port.json', true],
    ['setx DESKMINIS_PERSIST_AUTH_TOKEN 1', true],
    ['node -e "require(\'fs\').readFileSync(process.env.APPDATA)"', true],
    ["[Environment]::GetFolderPath('ApplicationData')", true],
    ['type %LOCALAPPDATA%\\x', true],
    ['Get-Content "$env:App""Data\\x"', true], // 引号拆开的写法去掉引号再认
    [`powershell -enc ${enc('gc $env:APPDATA\\DeskMinis\\providers.json')}`, true],
    ['npm test', false],
    ['$env:NODE_ENV = "test"; npm test', false],
    ['git commit -am "fix"', false],
  ])('%s → %s', (cmd, asks) => {
    expect(asksInFullMode(cmd)).toBe(asks);
  });

  const req = (detail: string): PermissionRequest => ({ kind: 'shell', detail, sessionId: 'S1', toolTitle: 't' });

  it('full 档：点到数据目录的弹卡，其余照旧免问', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'deny'; });
    g.applyPreset('full');
    expect(await g.check(req('npm install'))).toBe('allow');
    expect(asked).toBe(0);
    expect(await g.check(req('Set-Content $env:APPDATA\\DeskMinis\\providers.json x'))).toBe('deny');
    expect(asked).toBe(1);
    // 只读命令点到数据目录，原本就回落 gated，full 档下同样弹卡
    expect(await g.check(req('Get-Content $env:APPDATA\\DeskMinis\\minisd-port.json'))).toBe('deny');
    expect(asked).toBe(2);
  });

  it('full 档：用户点了「本会话允许」后同一条命令不再弹卡', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-session'; });
    g.applyPreset('full');
    const cmd = req('Copy-Item $env:APPDATA\\DeskMinis\\skills\\a C:\\backup -Recurse');
    expect(await g.check(cmd)).toBe('allow');
    expect(await g.check(cmd)).toBe('allow');
    expect(asked).toBe(1);
  });

  it('危险命令在 full 档仍直接拒绝、不弹卡', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    g.applyPreset('full');
    expect(await g.check(req('cmd /c del /s /q C:\\proj'))).toBe('deny');
    expect(asked).toBe(0);
  });

  it('ask 档行为不变：点到数据目录的命令照常弹卡', async () => {
    let asked = 0;
    const g = new PermissionGatewayImpl(async () => { asked++; return 'allow-once'; });
    expect(await g.check(req('Set-Content $env:APPDATA\\DeskMinis\\x.txt y'))).toBe('allow');
    expect(asked).toBe(1);
  });
});

describe('端口文件默认不带 authToken', () => {
  it('只认 DESKMINIS_PERSIST_AUTH_TOKEN=1', () => {
    expect(persistAuthTokenEnabled({})).toBe(false);
    expect(persistAuthTokenEnabled({ DESKMINIS_PERSIST_AUTH_TOKEN: '0' })).toBe(false);
    expect(persistAuthTokenEnabled({ DESKMINIS_PERSIST_AUTH_TOKEN: 'true' })).toBe(false);
    expect(persistAuthTokenEnabled({ DESKMINIS_PERSIST_AUTH_TOKEN: '1' })).toBe(true);
  });

  const dirs: string[] = [];
  const saved = process.env.DESKMINIS_PERSIST_AUTH_TOKEN;
  beforeAll(() => {
    process.env.DESKMINIS_TEST = '1';
    process.env.DESKMINIS_FAKE_PROVIDER = '1';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.DESKMINIS_PERSIST_AUTH_TOKEN; else process.env.DESKMINIS_PERSIST_AUTH_TOKEN = saved;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    restoreEngineBuiltins();
  });

  async function portFileOf(env: string | undefined): Promise<{ port?: number; authToken?: string }> {
    if (env === undefined) delete process.env.DESKMINIS_PERSIST_AUTH_TOKEN; else process.env.DESKMINIS_PERSIST_AUTH_TOKEN = env;
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-step0-port-'));
    dirs.push(dataDir);
    const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
    try {
      return JSON.parse(readFileSync(join(dataDir, 'minisd-port.json'), 'utf8')) as { port?: number; authToken?: string };
    } finally {
      await srv.close();
    }
  }

  it('默认：只有端口', async () => {
    const f = await portFileOf(undefined);
    expect(typeof f.port).toBe('number');
    expect(f).not.toHaveProperty('authToken');
  }, 30_000);

  it('开发者显式开启时写 token', async () => {
    const f = await portFileOf('1');
    expect(typeof f.authToken).toBe('string');
  }, 30_000);
});
