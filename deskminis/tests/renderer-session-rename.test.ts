/** B1 会话标题 · renderer 守卫：SessionList 的重命名入口 + chat store 的 renameSession
 *  与 chat.sessions.changed 订阅。.vue 不在 typecheck 覆盖内，这层只能靠源码文本守卫兜底
 *  （沿用 renderer-sessioncard.test.ts 的做法）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const store = fs.readFileSync(path.join(root, 'src/renderer/src/stores/chat.ts'), 'utf8');

describe('B1 会话标题：renderer 守卫（2 例）', () => {
  it('chat store：renameSession 调 chat.sessions.rename，并订阅 chat.sessions.changed 刷列表（后端自动命名靠这条广播才看得见）', () => {
    expect(store).toContain('async renameSession(');
    expect(store).toContain("rpc.call('chat.sessions.rename'");
    expect(store).toContain("rpc.on('chat.sessions.changed'");
  });

  /* 「SessionList 菜单有重命名项」在 T6e-3 退场（T 波换壳时会话行的 ⋮ 菜单没搬过来，
     `chat.renameSession` 在 ui/ 下零引用）；Y1（2026-09-10）在 ui/NavRail.vue 上补回，本例复位。 */
  it('NavRail 会话行菜单有重命名项：预填现标题、Enter 或「确认」提交、后端拒绝原因落在菜单里（Y1 复位）', () => {
    const rail = fs.readFileSync(path.join(root, 'src/renderer/src/ui/NavRail.vue'), 'utf8');
    expect(rail).toMatch(/\.renameSession\(/);
    expect(rail).toMatch(/@click\.stop="startRename\(s\)"/);
    expect(rail).toMatch(/@keydown\.enter="submitRename\(s\.id\)"/);
    expect(rail).toContain('renameErr');
  });
});
