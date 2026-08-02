import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BridgeServer } from '../src/minisd/bridge/server';
import { makeBridgeDispatcher, errEnvelope, runPowerShell, type BridgeEnvelope } from '../src/minisd/bridge/handlers';
import { MinisPaths } from '../src/minisd/paths';
import { uniquePipePath, startEchoServer } from './bridge-util';
import { withClipboardLock } from './clipboard-lock';

const CLI = fileURLToPath(new URL('../src/minisd/bridge-cli.mjs', import.meta.url));
const SESSION = 'A1B2C3D4-E5F6-4789-ABCD-EF0123456789';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function runCli(argv: string[], envExtra: NodeJS.ProcessEnv = {}, input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(res => {
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...envExtra };
    delete env.MINIS_BRIDGE_PIPE;
    delete env.MINIS_CHAT_SESSION_ID;
    Object.assign(env, envExtra);
    const proc = spawn(process.execPath, [CLI, ...argv], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', c => { stdout += c; });
    proc.stderr.on('data', c => { stderr += c; });
    proc.on('close', code => res({ code, stdout, stderr }));
    if (input !== undefined) proc.stdin.write(input);
    proc.stdin.end();
  });
}

const BRIDGE_ENV = (pipePath: string) => ({ MINIS_CHAT_SESSION_ID: SESSION, MINIS_BRIDGE_PIPE: pipePath });

describe('帮助与本地参数校验（无需管道）', () => {
  it('--help：列出六桥与退出码说明，退出 0', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    for (const t of ['windows-notify', 'windows-clipboard', 'windows-open', 'windows-speak', 'windows-screenshot', 'windows-device']) {
      expect(r.stdout).toContain(t);
    }
    expect(r.stdout).toContain('退出码');
  });

  it('<工具> --help：输出该工具用法，退出 0', async () => {
    const r = await runCli(['windows-notify', '--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--title');
    expect(r.stdout).toContain('--body');
  });

  it('缺工具名 → 退出 3 + INVALID_ARGS 信封', async () => {
    const r = await runCli([]);
    expect(r.code).toBe(3);
    const env = JSON.parse(r.stdout) as BridgeEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_ARGS');
  });

  it('未知工具 → 退出 3', async () => {
    const r = await runCli(['windows-nuke', 'boom'], BRIDGE_ENV('\\\\.\\pipe\\deskminis-whatever'));
    expect(r.code).toBe(3);
    expect((JSON.parse(r.stdout) as BridgeEnvelope).error?.code).toBe('INVALID_ARGS');
  });

  it('缺 MINIS_CHAT_SESSION_ID → 退出 3', async () => {
    const r = await runCli(['windows-device', 'info'], { MINIS_BRIDGE_PIPE: '\\\\.\\pipe\\deskminis-whatever' });
    expect(r.code).toBe(3);
    const env = JSON.parse(r.stdout) as BridgeEnvelope;
    expect(env.error?.code).toBe('INVALID_ARGS');
    expect(env.error?.message).toContain('MINIS_CHAT_SESSION_ID');
  });

  it('缺 MINIS_BRIDGE_PIPE → 退出 4（BRIDGE_UNAVAILABLE）', async () => {
    const r = await runCli(['windows-device', 'info'], { MINIS_CHAT_SESSION_ID: SESSION });
    expect(r.code).toBe(4);
    expect((JSON.parse(r.stdout) as BridgeEnvelope).error?.code).toBe('BRIDGE_UNAVAILABLE');
  });

  it('e2e缺陷复现: windows-clipboard --action set --text x → 静默落回默认动作get → 现在必须响亮报错退出3', async () => {
    // （无需管道：参数校验发生在环境检查之前；现状 CLI 吞掉 --action，action=默认get，模型误以为写成功）
    const r = await runCli(['windows-clipboard', '--action', 'set', '--text', 'x']);
    expect(r.code).toBe(3);
    const env = JSON.parse(r.stdout) as BridgeEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_ARGS');
    expect(env.error?.message).toContain('--action');
    expect(env.error?.message).toContain('动作是位置参数');
  });

  it('参数名拼错: windows-notify --tittle x → 退出3，报未知参数并列出支持参数', async () => {
    const r = await runCli(['windows-notify', '--tittle', 'x']);
    expect(r.code).toBe(3);
    const env = JSON.parse(r.stdout) as BridgeEnvelope;
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe('INVALID_ARGS');
    expect(env.error?.message).toContain('--tittle');
    // 支持参数列表：title, body（params 白名单）
    for (const p of ['title', 'body']) expect(env.error?.message).toContain(p);
  });

  it('合法参数照常通过（不触发白名单误报）', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const r1 = await runCli(['windows-notify', '--title', 't', '--body', 'b'], BRIDGE_ENV(pipePath));
    expect(r1.code).toBe(0);
    const r2 = await runCli(['windows-clipboard', 'set', '--text', 'x'], BRIDGE_ENV(pipePath));
    expect(r2.code).toBe(0);
    const r3 = await runCli(['windows-open', 'https://example.com'], BRIDGE_ENV(pipePath));
    expect(r3.code).toBe(0);
    const r4 = await runCli(['windows-speak', 'say', '--text', 'x', '--rate', '0'], BRIDGE_ENV(pipePath));
    expect(r4.code).toBe(0);
  });

  it('全局旗标 -q/--compact/--stdin 及 --help 不受白名单影响', async () => {
    const rh = await runCli(['windows-notify', '--help']);
    expect(rh.code).toBe(0);
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const rq = await runCli(['windows-device', '-q'], BRIDGE_ENV(pipePath));
    expect(rq.code).toBe(0);
    const rc = await runCli(['windows-device', '--compact'], BRIDGE_ENV(pipePath));
    expect(rc.code).toBe(0);
    const rs = await runCli(['windows-clipboard', 'set', '--stdin'], BRIDGE_ENV(pipePath), 't');
    expect(rs.code).toBe(0);
  });

  it('管道无服务监听 → 退出 4', async () => {
    const r = await runCli(['windows-device', 'info'], BRIDGE_ENV(uniquePipePath()));
    expect(r.code).toBe(4);
    expect((JSON.parse(r.stdout) as BridgeEnvelope).error?.code).toBe('BRIDGE_UNAVAILABLE');
  });
});

describe('经 echo 服务的线协议行为', () => {
  it('默认美化输出（多行）+ echo 保真（tool/action/args/sessionId/stdin）', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const r = await runCli(['windows-notify', 'show', '--title', '标题①'], BRIDGE_ENV(pipePath));
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n').length).toBeGreaterThan(1); // 美化缩进
    const env = JSON.parse(r.stdout) as BridgeEnvelope;
    const echo = (env.data as { echo: Record<string, unknown> }).echo;
    expect(echo.tool).toBe('windows-notify');
    expect(echo.action).toBe('show');
    expect((echo.args as Record<string, string>).title).toBe('标题①');
    expect(echo.sessionId).toBe(SESSION);
    expect(env.timestamp).toBeGreaterThan(1_700_000_000);
  });

  it('-q 单行紧凑输出', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const r = await runCli(['windows-device', 'info', '-q'], BRIDGE_ENV(pipePath));
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    expect((JSON.parse(r.stdout) as BridgeEnvelope).ok).toBe(true);
  });

  it('省略动作用默认动作；windows-open 位置参数当 target', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const r1 = await runCli(['windows-device'], BRIDGE_ENV(pipePath));
    expect((JSON.parse(r1.stdout) as BridgeEnvelope).action).toBe('info');
    const r2 = await runCli(['windows-open', 'https://example.com'], BRIDGE_ENV(pipePath));
    const env2 = JSON.parse(r2.stdout) as BridgeEnvelope;
    expect(env2.action).toBe('open');
    expect(((env2.data as { echo: Record<string, unknown> }).echo.args as Record<string, string>).target).toBe('https://example.com');
  });

  it('--stdin 文本载荷转发到管道', async () => {
    const { pipePath, close } = await startEchoServer();
    cleanups.push(close);
    const r = await runCli(['windows-clipboard', 'set', '--stdin'], BRIDGE_ENV(pipePath), '多行\n文本①');
    expect(r.code).toBe(0);
    const echo = (JSON.parse(r.stdout) as BridgeEnvelope).data as { echo: Record<string, unknown> };
    expect(echo.echo.stdin).toBe('多行\n文本①');
  });

  it('PERMISSION_DENIED 信封 → 退出 2', async () => {
    const pipePath = uniquePipePath();
    const server = new BridgeServer(async req => errEnvelope(req.tool, req.action, 'PERMISSION_DENIED', '被用户拒绝'));
    await server.listen(pipePath);
    cleanups.push(() => server.close());
    const r = await runCli(['windows-clipboard', 'get'], BRIDGE_ENV(pipePath));
    expect(r.code).toBe(2);
    expect((JSON.parse(r.stdout) as BridgeEnvelope).error?.code).toBe('PERMISSION_DENIED');
  });

  it('EXEC_ERROR 信封 → 退出 1', async () => {
    const pipePath = uniquePipePath();
    const server = new BridgeServer(async req => errEnvelope(req.tool, req.action, 'EXEC_ERROR', 'PowerShell 退出码 1'));
    await server.listen(pipePath);
    cleanups.push(() => server.close());
    const r = await runCli(['windows-notify', '--title', 'x'], BRIDGE_ENV(pipePath));
    expect(r.code).toBe(1);
  });
});

describe('真分发端到端（真 PowerShell）', () => {
  async function startRealServer(): Promise<{ pipePath: string; close: () => Promise<void> }> {
    const root = mkdtempSync(join(tmpdir(), 'dm-cli-real-'));
    const paths = new MinisPaths(root);
    paths.ensureSessionDirs(SESSION);
    const dispatch = makeBridgeDispatcher({ permissions: { async check() { return 'allow' as const; }, hasBridgeGrant: () => false }, paths });
    const pipePath = uniquePipePath();
    const server = new BridgeServer(dispatch);
    await server.listen(pipePath);
    return { pipePath, close: () => server.close() };
  }

  it('windows-device info：stub→管道→真 PowerShell 全链路', async () => {
    const { pipePath, close } = await startRealServer();
    cleanups.push(close);
    const r = await runCli(['windows-device', 'info'], BRIDGE_ENV(pipePath));
    expect(r.code).toBe(0);
    const env = JSON.parse(r.stdout) as BridgeEnvelope;
    expect(env.ok).toBe(true);
    expect((env.data as Record<string, unknown>).computerName).toBe(process.env.COMPUTERNAME);
  }, 30000);

  // withClipboardLock 跨文件互斥：避免 vitest fileParallelism 下与
  // bridge-handlers.test.ts 的剪贴板往返用例竞态（set→get 之间被另一个 worker 的 set 打断）。
  // 同时补上此前缺失的「保存用户旧值 → 断言 → finally 恢复」，
  // 不再在全量跑完后把用户剪贴板残留成测试字符串。
  it('windows-clipboard set/get 经 CLI 往返（会短暂改写本机剪贴板，跨文件互斥）', async () => {
    await withClipboardLock(async () => {
      // 保存用户剪贴板
      const saved = await runPowerShell(`[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
[Console]::Out.Write([System.Windows.Forms.Clipboard]::GetText())`);
      const { pipePath, close } = await startRealServer();
      cleanups.push(close);
      try {
        const set = await runCli(['windows-clipboard', 'set', '--text', 'CLI-端到端①'], BRIDGE_ENV(pipePath));
        expect(set.code).toBe(0);
        expect((JSON.parse(set.stdout) as BridgeEnvelope).data).toEqual({ length: 8 });
        const get = await runCli(['windows-clipboard', 'get'], BRIDGE_ENV(pipePath));
        expect(get.code).toBe(0);
        expect(((JSON.parse(get.stdout) as BridgeEnvelope).data as { text: string }).text).toBe('CLI-端到端①');
      } finally {
        await runPowerShell(`[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$t = [Console]::In.ReadToEnd()
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText($t)`, saved.stdout);
      }
    });
  }, 60000);

  it('windows-open 不存在目标：服务端 INVALID_ARGS → 退出 3', async () => {
    const { pipePath, close } = await startRealServer();
    cleanups.push(close);
    const r = await runCli(['windows-open', 'C:\\绝\\对\\不\\存\\在\\x.txt'], BRIDGE_ENV(pipePath));
    expect(r.code).toBe(3);
    expect((JSON.parse(r.stdout) as BridgeEnvelope).error?.code).toBe('INVALID_ARGS');
  }, 30000);
});
