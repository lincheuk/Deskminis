/** 执行隔离 AppContainer 原型（方案文档「第 4 步评估」选项 2）：scripts/appcontainer-probe.ps1。
 *  这一步只做评估，产品代码不变。这里钉住脚本的几个硬要求，并在 Windows 上把它真跑一遍、把结论打到日志里。 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WIN = process.platform === 'win32';
const SCRIPT = resolve(__dirname, '..', 'scripts', 'appcontainer-probe.ps1');

describe('AppContainer 原型脚本', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  it('带 UTF-8 BOM（Windows PowerShell 5.1 没有 BOM 时按 ANSI 读，中文会坏）', () => {
    expect(src.charCodeAt(0)).toBe(0xfeff);
  });
  it('起容器进程用 SECURITY_CAPABILITIES 属性；三次运行：不给能力、只给 internetClient、再加上级目录可列；跑完去掉加的权限、删掉容器与测试凭据', () => {
    expect(src).toContain('(IntPtr)0x00020009');
    expect(src).toContain("$runs = [ordered]@{ none = @(); internetClient = @('S-1-15-3-1'); ancestors = @('S-1-15-3-1') }");
    expect(src).toContain("& icacls $d /remove ('*' + $sid) /Q");
    expect(src).toContain('[DeskMinisAcProbe]::DeleteProfile($name)');
    expect(src).toContain('& cmdkey "/delete:$credTarget"');
    for (const id of ['started', 'token', 'ws-write', 'user-read', 'cred-read', 'dpapi', 'loop-self', 'loop-sibling', 'loop-host', 'pipe-host', 'net-direct', 'npm-install']) {
      expect(src).toContain(`'${id}'`);
    }
  });
});

describe.runIf(WIN)('Windows 真跑 AppContainer 原型', () => {
  const made: string[] = [];
  afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

  it('脚本跑完、写出报告，结论打到日志里', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ac-probe-'));
    made.push(base);
    const out = join(base, 'probe.json');
    const { spawnSync } = await import('node:child_process');
    const r = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Out', out],
      { encoding: 'utf8', timeout: 900_000, windowsHide: true });
    console.log(r.stdout, r.stderr);
    const raw = readFileSync(out, 'utf8').replace(/^\uFEFF/, '');
    console.log(`__AC_PROBE_REPORT__ ${JSON.stringify(JSON.parse(raw))}`);
    const report = JSON.parse(raw);
    expect(report.error, report.error).toBeUndefined();
    expect(Object.keys(report.runs)).toEqual(['none', 'internetClient', 'ancestors']);
  }, 960_000);
});
