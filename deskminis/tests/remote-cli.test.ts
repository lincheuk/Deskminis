import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMinisd } from '../src/minisd/index';

const CLI = fileURLToPath(new URL('../src/cli/remote-cli.mjs', import.meta.url));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

function runCli(argv: string[], envExtra: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(res => {
    const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...envExtra };
    const proc = spawn(process.execPath, [CLI, ...argv], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.setEncoding('utf8'); proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', c => stdout += c);
    proc.stderr.on('data', c => stderr += c);
    proc.on('close', code => res({ code, stdout, stderr }));
    proc.on('error', err => res({ code: -1, stdout, stderr: String(err) }));
    proc.stdin.end();
  });
}

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), 'dm-cli-m3a-'));
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  cleanups.push(() => srv.close());
  cleanups.push(() => { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* 尽力 */ } });
  return srv;
}

describe('help 与参数校验', () => {
  it('--help 列子命令，退出 0', async () => {
    const r = await runCli(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('pair');
    expect(r.stdout).toContain('connect');
    expect(r.stdout).toContain('status');
    expect(r.stdout).toContain('unpair');
  });

  it('缺子命令 → 退出 3', async () => {
    const r = await runCli([]);
    expect(r.code).toBe(3);
  });

  it('未知子命令 → 退出 3', async () => {
    const r = await runCli(['frobnicate']);
    expect(r.code).toBe(3);
  });

  it('缺 MINISD_PORT/TOKEN → 退出 4', async () => {
    const r = await runCli(['status'], {});
    expect(r.code).toBe(4);
  });
});

describe('pair / connect / status / unpair', () => {
  it('pair 返回 pairingCode + myFingerprint；connect 完成配对；status 列出；unpair 移除', async () => {
    const { port, authToken } = await boot();
    const env = { MINISD_PORT: String(port), MINISD_TOKEN: authToken };

    // pair：生成配对码 + 桌面端公钥/指纹
    const pair = await runCli(['pair'], env);
    expect(pair.code).toBe(0);
    const pj = JSON.parse(pair.stdout);
    expect(pj.pairingCode).toHaveLength(8);
    expect(pj.myFingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(pj.myPublicKeyB64).toBeTruthy();
    expect(pj.expiresIn).toBe(300);

    // pair 只 begin 未 complete → status 列 0 条
    const st0 = await runCli(['status'], env);
    expect(st0.code).toBe(0);
    expect(st0.stdout).not.toContain(pj.myFingerprint);

    // connect：扮演手机端，用 code + 桌面端公钥完成握手
    const conn = await runCli(['connect', pj.pairingCode, pj.myPublicKeyB64], env);
    expect(conn.code).toBe(0);
    const cj = JSON.parse(conn.stdout);
    // connect 返回手机端的 fingerprint（自己生成的），与桌面端不同
    expect(cj.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(cj.fingerprint).not.toBe(pj.myFingerprint);

    // status 列出手机端的 fingerprint
    const st2 = await runCli(['status'], env);
    expect(st2.code).toBe(0);
    expect(st2.stdout).toContain(cj.fingerprint);

    // unpair 移除
    const del = await runCli(['unpair', cj.fingerprint], env);
    expect(del.code).toBe(0);
    const st3 = await runCli(['status'], env);
    expect(st3.stdout).not.toContain(cj.fingerprint);
  });

  it('connect 缺参数 → 退出 3', async () => {
    const { port, authToken } = await boot();
    const env = { MINISD_PORT: String(port), MINISD_TOKEN: authToken };
    const r = await runCli(['connect', 'ONLYCODE'], env);
    expect(r.code).toBe(3);
  });

  it('unpair 缺 fingerprint → 退出 3', async () => {
    const { port, authToken } = await boot();
    const env = { MINISD_PORT: String(port), MINISD_TOKEN: authToken };
    const r = await runCli(['unpair'], env);
    expect(r.code).toBe(3);
  });

  it('pair 连不上 minisd（错 port）→ 退出 4', async () => {
    const env = { MINISD_PORT: '1', MINISD_TOKEN: 'wrong' };
    const r = await runCli(['pair'], env);
    expect(r.code).toBe(4);
  });
});
