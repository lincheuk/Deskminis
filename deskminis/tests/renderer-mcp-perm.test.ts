/** D5 权限类目 mcp 的渲染端文案：copy.ts TITLES 收录 'mcp'（permTitle「请求调用 MCP 工具」）。 */
import { describe, it, expect } from 'vitest';
import { permTitle, permTriggerLabel } from '../src/renderer/src/lib/perm/copy';

describe('权限卡文案 mcp 类目', () => {
  it("permTitle('mcp') → 请求调用 MCP 工具", () => {
    expect(permTitle('mcp')).toBe('请求调用 MCP 工具');
  });
  it('未知 kind 兜底不受影响（回归例）', () => {
    expect(permTitle('mystery')).toBe('请求权限');
    expect(permTriggerLabel('mystery')).toBe('权限');
  });
});
