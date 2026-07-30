import { describe, it, expect } from 'vitest';
import { ProviderError, isRetryable, isFallbackable } from '../src/minisd/providers/types';

describe('ProviderError 错误分类', () => {
  it('网络错误（无 status）→ retryable, 不 fallbackable', () => {
    const e = new ProviderError('网络错误: x', { retryable: true });
    expect(isRetryable(e)).toBe(true);
    expect(isFallbackable(e)).toBe(false);
  });
  it('529/503/500 → retryable, 不 fallbackable', () => {
    for (const s of [500, 502, 503, 504, 529]) {
      const e = new ProviderError('x', { status: s });
      expect(isRetryable(e)).toBe(true);
      expect(isFallbackable(e)).toBe(false);
    }
  });
  it('429 限流 → 不 retryable, fallbackable', () => {
    const e = new ProviderError('rate limited', { status: 429 });
    expect(isRetryable(e)).toBe(false);
    expect(isFallbackable(e)).toBe(true);
  });
  it('401/403 无效 key → fallbackable, 不 retryable', () => {
    for (const s of [401, 403]) {
      const e = new ProviderError('bad key', { status: s });
      expect(isFallbackable(e)).toBe(true);
      expect(isRetryable(e)).toBe(false);
    }
  });
  it('400/404/422 provider 请求错误 → fallbackable', () => {
    for (const s of [400, 404, 422]) {
      expect(isFallbackable(new ProviderError('x', { status: s }))).toBe(true);
    }
  });
  it('显式旗标覆盖默认推导', () => {
    const e = new ProviderError('自定义', { status: 500, fallbackable: true });
    expect(isFallbackable(e)).toBe(true);
    const e2 = new ProviderError('自定义2', { status: 429, retryable: true });
    expect(isRetryable(e2)).toBe(true);
  });
  it('非 ProviderError 一律 false', () => {
    expect(isRetryable(new Error('x'))).toBe(false);
    expect(isFallbackable('x')).toBe(false);
    expect(isFallbackable(undefined)).toBe(false);
  });
});
