import { describe, expect, it } from 'vitest';
import { eventCopy, humanizeError } from '../src/renderer/src/lib/eventnote/copy';

describe('N22 地区拒绝短句', () => {
  it.each([
    '403 RegionError',
    '403 This model is not available in your country',
    'HTTP 403 {"error":{"code":"RegionError","message":"This model is not available in your country"}}',
    '403: not available in your region',
    '403 unsupported_country_region_territory',
    '403 unsupported_country',
    '403 model unavailable in this region',
  ])('%s', raw => {
    const short = '该模型在当前网络所在地区不可用（403）：检查系统代理';
    expect(humanizeError(raw)).toBe(short);
    expect(eventCopy('error', raw)).toEqual({ icon: 'alert', short, tone: 'err' });
  });

  it.each([
    ['403 insufficient balance', '余额不足或额度受限（403）'],
    ['HTTP 403 Forbidden', '访问被拒绝（403）：检查 Key 权限或账户余额'],
    ['HTTP 403 region endpoint quota exhausted', '余额不足或额度受限（403）'],
    ['401 RegionError', 'API Key 无效或过期'],
  ])('%s 保留原分类', (raw, short) => expect(humanizeError(raw)).toBe(short));
});
