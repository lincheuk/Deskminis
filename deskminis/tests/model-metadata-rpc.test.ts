import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { RpcServer } from '../src/minisd/rpc/server';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { createModelMetadataMethods } from '../src/minisd/providers/model-metadata-rpc';

let server: RpcServer | undefined;
let socket: WebSocket | undefined;
let dir: string | undefined;
afterEach(async () => {
  socket?.terminate();
  await server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  server = undefined; socket = undefined; dir = undefined;
});

it('serves metadata and forced-refresh status over authenticated JSON-RPC', async () => {
  dir = mkdtempSync(join(tmpdir(), 'dm-meta-rpc-'));
  let calls = 0;
  const catalog = new ModelCatalog(join(dir, 'catalog.json'), async () => {
    calls++;
    return new Response(JSON.stringify({ google: { models: { sample: {
      limit: { context: 1000, output: 100 }, tool_call: true,
      modalities: { input: ['text', 'video'], output: ['text'] },
    } } } }));
  });
  server = new RpcServer(createModelMetadataMethods(catalog), 'metadata-test-token');
  const port = await server.listen('127.0.0.1', 0);
  socket = new WebSocket(`ws://127.0.0.1:${port}/?token=metadata-test-token`);
  await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject); });
  let id = 0;
  const call = (method: string, params?: unknown): Promise<any> => new Promise(resolve => {
    socket!.once('message', data => resolve(JSON.parse(String(data))));
    socket!.send(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }));
  });
  expect((await call('provider.catalog.get')).result.primarySource).toBe('models.dev');
  const metadata = await call('provider.models.metadata', { modelId: ' sample ', providerId: ' google ' });
  expect(metadata.result.metadata).toMatchObject({ source: 'models.dev', providerId: 'google', inputModalities: ['text', 'video'], outputModalities: ['text'] });
  expect(calls).toBe(1);
  expect((await call('provider.catalog.refresh')).result).toMatchObject({ refreshed: true, status: { source: 'models.dev', modelCount: 1 } });
  expect(calls).toBe(2);
  expect((await call('provider.models.metadata', {})).error.message).toContain('modelId');
  expect((await call('provider.models.metadata', { modelId: 'sample', providerId: 42 })).error.message).toContain('providerId');
});

describe('metadata request validation', () => {
  it.each([undefined, null, {}, { modelId: '' }, { modelId: 'x'.repeat(257) }])('rejects missing/invalid identifiers before fetching: %j', async params => {
    const catalog = new ModelCatalog(join(tmpdir(), 'nonexistent-metadata-test.json'), async () => { throw new Error('must not fetch'); });
    const methods = createModelMetadataMethods(catalog);
    await expect(methods['provider.models.metadata'](params)).rejects.toThrow('modelId');
  });
});
