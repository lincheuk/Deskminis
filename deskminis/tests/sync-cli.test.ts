import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMinisd } from '../src/minisd/index';
import WebSocket from 'ws';

// 适配说明：计划伪代码用 out/main/minisd.js 子进程启动——但该 build 产物在 M3b 期间未重建（缺 sync.* 方法）。
// 改用 startMinisd 进程内启动（与 remote-cli.test.ts 同款模式），Produces 接口不变：仍测 CLI 行为。
const CLI = fileURLToPath(new URL('../src/cli/sync-cli.mjs', import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function runCli(args: string[], envExtra: NodeJS.ProcessEnv = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(res => {
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...envExtra };
    const p = spawn(process.execPath, [CLI, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', c => out += c);
    p.stderr.on('data', c => err += c);
    p.on('close', code => res({ code: code ?? 0, stdout: out, stderr: err }));
    p.on('error', () => res({ code: -1, stdout: out, stderr: err }));
    p.stdin.end();
  });
}

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-synccli-'));
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  cleanups.push(() => srv.close());
  cleanups.push(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 尽力 */ } });
  return srv;
}

async function createSession(port: number, token: string): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
  await new Promise(r => ws.on('open', r));
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chat.sessions.create', params: {} }));
  const resp = await new Promise<any>(r => ws.on('message', d => r(JSON.parse(String(d)))));
  ws.close();
  return resp.result.id;
}

describe('sync-cli.mjs（手动同步按钮等价命令行）', () => {
  it('status 子命令：列出本地会话 + cursor', async () => {
    const srv = await boot();
    await createSession(srv.port, srv.authToken);
    const r = await runCli(['status'], { MINISD_PORT: String(srv.port), MINISD_TOKEN: srv.authToken });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('sessions');
  }, 15000);

  it('pull <sid>：拉取本地会话（自拉自，验证链路通）', async () => {
    const srv = await boot();
    const sid = await createSession(srv.port, srv.authToken);
    const r = await runCli(['pull', sid], { MINISD_PORT: String(srv.port), MINISD_TOKEN: srv.authToken });
    expect(r.code).toBe(0);
  }, 15000);

  it('无 MINISD_PORT/MINISD_TOKEN → 退出 2', async () => {
    const r = await runCli(['status'], { MINISD_PORT: '', MINISD_TOKEN: '' });
    expect(r.code).toBe(2);
  });
});
