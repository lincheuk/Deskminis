import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('node:module', async original => {
  const real = await original<typeof import('node:module')>();
  return { ...real, createRequire: (url: string | URL) => {
    const require = real.createRequire(url);
    return (id: string) => id === 'electron' ? { net: electron } : require(id);
  } };
});
import { createOutboundFetch, isDirectUrl } from '../src/minisd/net/outbound-fetch';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('N22 出口选择', () => {
  it('非 utilityProcess 保留全局 fetch，原样传入对象、信号与返回值', async () => {
    vi.stubGlobal('process', { ...process, type: undefined });
    const response = new Response('direct');
    const fetch = vi.fn().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetch);
    const request = new Request('https://outside.example/test');
    const init = { headers: { 'x-n22': 'test' }, signal: new AbortController().signal };
    expect(await createOutboundFetch()(request, init)).toBe(response);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(request, init);
    expect(electron.fetch).not.toHaveBeenCalled();
  });

  it('utilityProcess 对外走 Electron net.fetch，原样传参且不构造环境变量出口', async () => {
    vi.stubGlobal('process', { ...process, type: 'utility' });
    const direct = vi.fn(); vi.stubGlobal('fetch', direct);
    const fallback = vi.fn();
    const response = new Response('proxied', { status: 403 });
    electron.fetch.mockResolvedValue(response);
    const request = new Request('https://outside.example/test', { method: 'POST', body: 'payload' });
    const init = { signal: new AbortController().signal, headers: { authorization: 'synthetic' } };
    expect(await createOutboundFetch(fallback)(request, init)).toBe(response);
    expect(electron.fetch).toHaveBeenCalledExactlyOnceWith(request, init);
    expect(direct).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
  });

  it('utilityProcess 外部 URL 对象转成 Electron 支持的字符串', async () => {
    vi.stubGlobal('process', { ...process, type: 'utility' });
    const response = new Response('URL'); electron.fetch.mockResolvedValue(response);
    const url = new URL('https://outside.example/url');
    expect(await createOutboundFetch()(url)).toBe(response);
    expect(electron.fetch).toHaveBeenCalledExactlyOnceWith(url.href, undefined);
  });

  it('utilityProcess 私有 URL 走直连，跳过 Electron 和环境变量出口', async () => {
    vi.stubGlobal('process', { ...process, type: 'utility' });
    const response = new Response('LAN'), direct = vi.fn().mockResolvedValue(response), fallback = vi.fn();
    vi.stubGlobal('fetch', direct);
    const url = new URL('http://192.168.10.3:8080/v1');
    const init = { signal: new AbortController().signal };
    expect(await createOutboundFetch(fallback)(url, init)).toBe(response);
    expect(direct).toHaveBeenCalledExactlyOnceWith(url, init);
    expect(electron.fetch).not.toHaveBeenCalled(); expect(fallback).not.toHaveBeenCalled();
  });

  it('CLI 目录延迟且仅构造一次原环境变量出口', async () => {
    vi.stubGlobal('process', { ...process, type: undefined });
    const response = new Response('catalog'), proxy = vi.fn().mockResolvedValue(response), factory = vi.fn(() => proxy);
    const direct = vi.fn(); vi.stubGlobal('fetch', direct);
    const fetch = createOutboundFetch(factory);
    expect(factory).not.toHaveBeenCalled();
    expect(await fetch('https://models.dev/api.json')).toBe(response);
    expect(await fetch('https://models.dev/second')).toBe(response);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(proxy.mock.calls).toEqual([['https://models.dev/api.json', undefined], ['https://models.dev/second', undefined]]);
    expect(direct).not.toHaveBeenCalled();
  });
});

describe('N22 本机和私有段边界', () => {
  it.each([
    'localhost', 'LOCALHOST.', 'ollama.local', 'printer.LOCAL.',
    '127.0.0.0', '127.255.255.255',
    '10.0.0.0', '10.255.255.255',
    '172.16.0.0', '172.31.255.255',
    '192.168.0.0', '192.168.255.255',
    '169.254.0.0', '169.254.255.255',
    '[::1]', '[fc00::]', '[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]',
    '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[::ffff:c0a8:100]',
  ])('%s 直连', host => expect(isDirectUrl('http://' + host + ':8080/path')).toBe(true));

  it.each([
    'localhost.example', 'local.example', 'notlocal',
    '126.255.255.255', '128.0.0.0', '9.255.255.255', '11.0.0.0',
    '172.15.255.255', '172.32.0.0', '192.167.255.255', '192.169.0.0',
    '169.253.255.255', '169.255.0.0', '[::]', '[::2]', '[fbff:ffff::]', '[fe00::]',
    '[::ffff:8.8.8.8]',
  ])('%s 跟随系统代理', host => expect(isDirectUrl('https://' + host + '/path')).toBe(false));
});
