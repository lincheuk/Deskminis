/** humanizeError 403 细分（MU2a Task 8 后续）：聚合端点（如 nodetect）的 403 多数是余额/额度问题，
 *  旧文案把 401/403 合并成「API Key 无效或过期」会误导用户去换 key。纯函数 node 直测。 */
import { describe, it, expect } from 'vitest';
import { humanizeError } from '../src/renderer/src/lib/eventnote/copy';

describe('humanizeError 401/403 细分', () => {
  it('401 → API Key 无效或过期（先于 403 判定，含双码消息时 401 优先）', () => {
    expect(humanizeError('Request failed with status code 401')).toBe('API Key 无效或过期');
    expect(humanizeError('HTTP 401 Unauthorized: invalid api key')).toBe('API Key 无效或过期');
  });

  it('403 + 英文余额关键词 → 余额不足或额度受限（403）', () => {
    expect(humanizeError('HTTP 403: insufficient balance')).toBe('余额不足或额度受限（403）');
    expect(humanizeError('403 Forbidden: quota exceeded')).toBe('余额不足或额度受限（403）');
    expect(humanizeError('403 credit exhausted')).toBe('余额不足或额度受限（403）');
  });

  it('403 + 中文「余额不足」等关键词 → 余额不足或额度受限（403）', () => {
    expect(humanizeError('HTTP 403: 余额不足')).toBe('余额不足或额度受限（403）');
    expect(humanizeError('403 欠费停服')).toBe('余额不足或额度受限（403）');
    expect(humanizeError('403: 额度已用完')).toBe('余额不足或额度受限（403）');
  });

  it('裸 403（无余额关键词）→ 访问被拒绝，提示查 Key 权限或账户余额', () => {
    expect(humanizeError('HTTP 403 Forbidden')).toBe('访问被拒绝（403）：检查 Key 权限或账户余额');
    expect(humanizeError('Request failed with status code 403')).toBe('访问被拒绝（403）：检查 Key 权限或账户余额');
  });

  it('429 回归：仍为请求过频或额度不足', () => {
    expect(humanizeError('HTTP 429 Too Many Requests')).toBe('请求过频或额度不足');
  });

  it('80 字截断回归：剥不出模式 → 折叠空白后截 80 字加省略号', () => {
    const out = humanizeError('x'.repeat(120));
    expect(out.length).toBeLessThanOrEqual(81);
    expect(out.startsWith('x'.repeat(80))).toBe(true);
    expect(out.endsWith('…')).toBe(true);
  });
});
