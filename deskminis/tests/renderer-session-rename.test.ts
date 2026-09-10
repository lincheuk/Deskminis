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

  /* 「SessionList 菜单有重命名项」在 T6e-3 退场：**不是不变量失效，是入口整个没了**。
     T 波换壳时会话行的 ⋮ 菜单没搬过来，`chat.renameSession` 在 ui/ 下零引用。
     退场理由必须写清楚，否则下一个人只会看到「测试少了一条」。
     这条缺口由 `tests/mu6-capability-wiring.test.ts` 的能力入口清单接管——
     它断言 store action 与 RPC 都还在、且 ui/ 下确实零引用，谁哪天补上入口它就会红。
     上面那条 store 断言留着：后端能力还在，别在补入口之前先把它删了。 */
});
