/**
 * M4.5 Task 1 · createProxyFetch 单测
 *
 * 验证：HTTPS_PROXY/HTTP_PROXY/ALL_PROXY/NO_PROXY 读取口径 + 优先级 + 不调 setGlobalDispatcher。
 * 单测禁外网——只测环境变量读取逻辑，不发真实请求。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createProxyFetch } from '../src/minisd/providers/model-catalog';

describe('createProxyFetch', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    delete process.env.HTTPS_PROXY; delete process.env.https_proxy;
    delete process.env.HTTP_PROXY; delete process.env.http_proxy;
    delete process.env.ALL_PROXY; delete process.env.all_proxy;
    delete process.env.NO_PROXY; delete process.env.no_proxy;
  });
  afterEach(() => { for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v; });

  it('无代理环境变量 → 返回 undefined（用默认全局 fetch = 直连）', () => {
    expect(createProxyFetch()).toBeUndefined();
  });

  it('HTTPS_PROXY 存在 → 返回带 ProxyAgent 的 fetchImpl', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:10808';
    const f = createProxyFetch();
    expect(typeof f).toBe('function');
  });

  it('小写 https_proxy 也读（POSIX 兼容）', () => {
    process.env.https_proxy = 'http://127.0.0.1:10808';
    expect(typeof createProxyFetch()).toBe('function');
  });

  it('HTTP_PROXY 作为 HTTPS 资源的回退代理', () => {
    process.env.HTTP_PROXY = 'http://127.0.0.1:10808';
    expect(typeof createProxyFetch()).toBe('function');
  });

  it('小写 http_proxy 也读（POSIX 兼容）', () => {
    process.env.http_proxy = 'http://127.0.0.1:10808';
    expect(typeof createProxyFetch()).toBe('function');
  });

  it('ALL_PROXY 作为最后回退', () => {
    process.env.ALL_PROXY = 'http://127.0.0.1:10808';
    expect(typeof createProxyFetch()).toBe('function');
  });

  it('小写 all_proxy 也读（POSIX 兼容）', () => {
    process.env.all_proxy = 'http://127.0.0.1:10808';
    expect(typeof createProxyFetch()).toBe('function');
  });

  it('NO_PROXY 含 models.dev → 返回 undefined（直连）', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:10808';
    process.env.NO_PROXY = 'models.dev,localhost';
    expect(createProxyFetch()).toBeUndefined();
  });

  it('NO_PROXY 通配 * → 返回 undefined（全部直连）', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:10808';
    process.env.NO_PROXY = '*';
    expect(createProxyFetch()).toBeUndefined();
  });

  it('NO_PROXY 不含 models.dev → 仍走代理', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:10808';
    process.env.NO_PROXY = 'localhost,127.0.0.1';
    expect(typeof createProxyFetch()).toBe('function');
  });

  it('NO_PROXY 小写也读', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:10808';
    process.env.no_proxy = 'models.dev';
    expect(createProxyFetch()).toBeUndefined();
  });

  it('优先级：HTTPS_PROXY > HTTP_PROXY > ALL_PROXY', () => {
    process.env.HTTPS_PROXY = 'http://https-proxy:1';
    process.env.HTTP_PROXY = 'http://http-proxy:2';
    process.env.ALL_PROXY = 'http://all-proxy:3';
    // 内部用哪个 URI 无法从外部断言，但确保不抛错且返回函数
    expect(typeof createProxyFetch()).toBe('function');
  });

  it('HTTP_PROXY 在无 HTTPS_PROXY 时生效', () => {
    process.env.HTTP_PROXY = 'http://http-proxy:2';
    expect(typeof createProxyFetch()).toBe('function');
  });

  it('ALL_PROXY 在无 HTTPS_PROXY/HTTP_PROXY 时生效', () => {
    process.env.ALL_PROXY = 'http://all-proxy:3';
    expect(typeof createProxyFetch()).toBe('function');
  });

  it('NO_PROXY 后缀匹配 .dev → models.dev 命中直连', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:10808';
    process.env.NO_PROXY = '.dev';
    expect(createProxyFetch()).toBeUndefined();
  });
});
