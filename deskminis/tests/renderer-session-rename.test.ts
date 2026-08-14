/** B1 会话标题 · renderer 守卫：SessionList 的重命名入口 + chat store 的 renameSession
 *  与 chat.sessions.changed 订阅。.vue 不在 typecheck 覆盖内，这层只能靠源码文本守卫兜底
 *  （沿用 renderer-sessioncard.test.ts 的做法）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const sessionList = fs.readFileSync(path.join(root, 'src/renderer/src/components/SessionList.vue'), 'utf8');
const store = fs.readFileSync(path.join(root, 'src/renderer/src/stores/chat.ts'), 'utf8');

describe('B1 会话标题：renderer 守卫（2 例）', () => {
  it('chat store：renameSession 调 chat.sessions.rename，并订阅 chat.sessions.changed 刷列表（后端自动命名靠这条广播才看得见）', () => {
    expect(store).toContain('async renameSession(');
    expect(store).toContain("rpc.call('chat.sessions.rename'");
    expect(store).toContain("rpc.on('chat.sessions.changed'");
  });

  it('SessionList：菜单有「重命名」项 + 行内输入行（Enter 或确认提交）+ 失败文本留在菜单内', () => {
    expect(sessionList).toContain('重命名');
    expect(sessionList).toContain('renameFor');
    expect(sessionList).toContain('renameText');
    expect(sessionList).toContain('renameErr');
    expect(sessionList).toContain('chat.renameSession');
    // Enter 提交：菜单里没有 form，不接这个键就只能用鼠标点确认
    expect(sessionList).toContain('@keydown.enter');
    // 错误只在菜单内展示（不弹窗、不吞掉）——沿用 .smenu-ask 那套行内文本
    expect(sessionList).toContain('smenu-err');
  });
});
