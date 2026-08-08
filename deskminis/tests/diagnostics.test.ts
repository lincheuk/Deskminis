import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startMinisd } from '../src/minisd/index';
import { createDiagnosticsMethods, classifyBridgeNode, type DryRunDeps } from '../src/minisd/diagnostics';
import type { RpcConnection, AuthMode } from '../src/minisd/rpc/server';
import { InMemoryVault } from '../src/minisd/store/provider-store';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let stop: (() => Promise<void>) | undefined;
afterEach(async () => { await stop?.(); stop = undefined; });

function rpcClient(port: number, token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  let idc = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
  });
  const ready = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  function call(method: string, params?: unknown): Promise<any> {
    const id = ++idc;
    return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); });
  }
  return { ready, call, close: () => ws.close() };
}

async function boot(opts?: { permTimeoutMs?: number; dataDir?: string }) {
  const dataDir = opts?.dataDir ?? mkdtempSync(join(tmpdir(), 'dm-diag-'));
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0, permTimeoutMs: opts?.permTimeoutMs });
  stop = srv.close;
  return { ...srv, dataDir };
}

/** 创建一个带 key 的 anthropic provider 并设为默认，返回 provider id。 */
async function createDefaultProvider(c: { call: (m: string, p?: unknown) => Promise<any> }, modelId = 'claude-sonnet-4-20250514'): Promise<string> {
  const r = (await c.call('provider.instances.create', { name: 'Test', kind: 'anthropic', modelId, apiKey: 'sk-test-xxx' })).result;
  await c.call('provider.setDefault', { id: r.id });
  return r.id;
}

/** 单元级 fake RpcConnection（参照 remote-rpc.test.ts makeConn 模式）。 */
function makeConn(mode: AuthMode): RpcConnection {
  return { authMode: mode, notify: () => {} };
}

describe('diagnostics.dryRun', () => {
  it('默认 provider 存在且有 key → ready', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    await createDefaultProvider(c);
    const r = (await c.call('diagnostics.dryRun', {})).result;
    expect(r.overall).toBe('ready');
    expect(r.checks.defaultProvider.status).toBe('ready');
    c.close();
  });

  it('默认 provider 缺 key → blocked', async () => {
    const { port, authToken, dataDir } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const pid = await createDefaultProvider(c);
    // 删 vault 里的 key（InMemoryVault.forDataRoot 返回 startMinisd 使用的同一单例）
    const vault = InMemoryVault.forDataRoot(dataDir);
    vault.delete(`provider:${pid}`);
    const r = (await c.call('diagnostics.dryRun', {})).result;
    expect(r.overall).toBe('blocked');
    expect(r.checks.defaultProvider.status).toBe('blocked');
    expect(r.checks.defaultProvider.detail).toContain('缺少 API Key');
    c.close();
  });

  it('model-catalog 能解析窗口 → ready', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    await createDefaultProvider(c, 'claude-sonnet-4-20250514');
    const r = (await c.call('diagnostics.dryRun', {})).result;
    expect(r.checks.modelCatalog.status).toBe('ready');
    expect(r.checks.modelCatalog.detail).toMatch(/\d+/); // 窗口数字
    c.close();
  });

  it('model-catalog 未知模型 → warning（含两个后果说明 + 修法建议）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    // 配 unknown modelId（claude- 前缀会被内置表匹配，用完全未知的前缀）
    await createDefaultProvider(c, 'unknown-model-xyz');
    const r = (await c.call('diagnostics.dryRun', {})).result;
    expect(r.checks.modelCatalog.status).toBe('warning');
    expect(r.checks.modelCatalog.detail).toContain('回退 128K');           // 后果 A（窗口低估）
    expect(r.checks.modelCatalog.detail).toContain('窗口可能低估');         // 后果 A
    expect(r.checks.modelCatalog.detail).toContain('thinking 被钳到 off'); // 后果 B
    expect(r.checks.modelCatalog.detail).toContain('contextWindow');       // 修法
    c.close();
  });

  it('技能 SKILL.md 不可读 → warning', async () => {
    // 在 boot 前创建 skill 目录 + SKILL.md，让孤儿收养导入；boot 后删 SKILL.md 制造不可读
    const dataDir = mkdtempSync(join(tmpdir(), 'dm-diag-skill-'));
    mkdirSync(join(dataDir, 'skills', 'test-skill'), { recursive: true });
    writeFileSync(join(dataDir, 'skills', 'test-skill', 'SKILL.md'), '---\nname: Test Skill\ndescription: A test skill\n---\nTest content');
    const { port, authToken } = await boot({ dataDir });
    const c = rpcClient(port, authToken); await c.ready;
    // 确认技能已导入
    const skills = (await c.call('skills.list')).result;
    expect(skills.length).toBeGreaterThan(0);
    // 删 SKILL.md 制造不可读
    rmSync(join(dataDir, 'skills', 'test-skill', 'SKILL.md'));
    const r = (await c.call('diagnostics.dryRun', {})).result;
    expect(r.checks.skills.some((s: any) => s.status === 'warning')).toBe(true);
    c.close();
  });

  it('桥 node 解析 → ready 或 warning（无 node 则 warning）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const r = (await c.call('diagnostics.dryRun', {})).result;
    expect(['ready', 'warning']).toContain(r.checks.bridgeNode.status);
    c.close();
  });

  it('classifyBridgeNode：真 node.exe → ready', () => {
    expect(classifyBridgeNode('C:\\Program Files\\nodejs\\node.exe').status).toBe('ready');
  });

  it('classifyBridgeNode：随包 .cmd 垫片 → ready（Task 5，垫片即可用 Node 运行时）', () => {
    const r = classifyBridgeNode('C:\\Program Files\\DeskMinis\\resources\\bridge-node.cmd');
    expect(r.status).toBe('ready');
  });

  it('classifyBridgeNode：无 node 且无垫片（回退 electron.exe）→ warning 且 detail 明确「windows 桥不可用」', () => {
    const r = classifyBridgeNode('C:\\Program Files\\DeskMinis\\DeskMinis.exe');
    expect(r.status).toBe('warning');
    expect(r.detail).toContain('windows 桥不可用');
  });

  it('M3c 配对状态 → 列出已配对设备', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const r = (await c.call('diagnostics.dryRun', {})).result;
    expect(Array.isArray(r.checks.pairing)).toBe(true);
    c.close();
  });

  it('系统提示预览 + token 估算', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const r = (await c.call('diagnostics.dryRun', {})).result;
    expect(r.promptPreview).toContain('DeskMinis');
    expect(r.estimatedTokens).toBeGreaterThan(100);
    c.close();
  });

  it('降级链完整性 → ready 或 warning', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const r = (await c.call('diagnostics.dryRun', {})).result;
    expect(r.checks.fallbackChain).toBeDefined();
    expect(['ready', 'warning', 'blocked']).toContain(r.checks.fallbackChain.status);
    c.close();
  });

  it('providers.json 完整性 → ready', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const r = (await c.call('diagnostics.dryRun', {})).result;
    expect(r.checks.providers.status).toBe('ready');
    c.close();
  });

  it('authMode=local（非本机 token 拒绝）', async () => {
    // 单元级测试：createDiagnosticsMethods 返回的方法对 remote/pairing 模式直接抛错
    const minimalDeps = {
      providers: { list: () => [], getDefaultId: () => undefined, listGroups: () => [] },
      vault: { get: () => undefined, set: () => {}, delete: () => {} },
      catalog: { getModelContextWindow: () => undefined },
      skillStore: { list: () => [], listEnabledForSession: () => [], nowEpoch: () => 0 },
      pairingService: { listWithAddress: () => [], myFingerprint: 'abc' },
      skillsRoot: '/tmp',
      config: {},
    } as unknown as DryRunDeps;
    const methods = createDiagnosticsMethods(minimalDeps);
    // remote token 调 diagnostics.dryRun 应被拒
    await expect(methods['diagnostics.dryRun']({}, makeConn('remote'))).rejects.toThrow();
    // pairing 模式也应被拒
    await expect(methods['diagnostics.dryRun']({}, makeConn('pairing'))).rejects.toThrow();
  });

  it('不调模型/不执行工具/不连桥（side-effect free）', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    // 记录调用前后状态，确认无副作用
    const beforeProviders = (await c.call('provider.instances.list')).result;
    const beforeSkills = (await c.call('skills.list')).result;
    const beforeDevices = (await c.call('remote.status')).result;
    await c.call('diagnostics.dryRun', {});
    const afterProviders = (await c.call('provider.instances.list')).result;
    const afterSkills = (await c.call('skills.list')).result;
    const afterDevices = (await c.call('remote.status')).result;
    expect(afterProviders).toEqual(beforeProviders);
    expect(afterSkills).toEqual(beforeSkills);
    expect(afterDevices).toEqual(beforeDevices);
    c.close();
  });
});
