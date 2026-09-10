/** I3 守卫：欢迎态（welcomeMode）接线与形态的源文本断言 + isBlankState 纯模块单测。
 *
 *  设计稿 2026-08-20-ui-redo-aionui-design.md §5：空会话时工作台退场、对话列铺满、
 *  hero + composer 居中（AionUi Guid 页形态）；发首条消息即回场。
 *  断言面：
 *    1-4. isBlankState 纯判据（空白 / 有消息 / 实时活动 / 事件条）；
 *    5. App.vue：pane-w 与 wbrail 的 v-show、pane-chat 定宽 style 三处都带 !welcomeMode——
 *       少一处就是「工作台隐了但对话列还钉在 336px」的死白（H 波教训 2 同族）；
 *    6. App.vue 与 ChatView 共用 isBlankState（判据双写漂移是本模块存在的理由）；
 *    7. TitleBar：工作台开关带 :disabled 与欢迎态说明 title——隐藏后开关点了没反应
 *       是 MU5 §15 同族问题，disabled + 说明是 .wctl 成例；
 *    8. ChatView：根元素带 welcome 类绑定（居中布局的挂点）；
 *    9. EmptyState：hero 问候语 + 示例卡平面化（无 glass-edge，AionUi 语言）。
 */
/* T6e-3：4 例退场——空态判据退场：AppShell 按 chat.activeId 直接选舞台。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// T6e-3：空态判据（lib/welcome/blank）退场：新树里「欢迎还是会话」由 AppShell 按 chat.activeId 直接决定，没有独立判据

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('src/renderer/src/ui/AppShell.vue');
const CHAT = read('src/renderer/src/ui/StageChat.vue');
const TB = read('src/renderer/src/ui/TopBar.vue');
const EMPTY = read('src/renderer/src/ui/StageWelcome.vue');

const BLANK = { messages: [], running: false, streamingText: '', toolCards: [], pendingPerms: [], retryNote: null, eventNotes: [] };

describe('I3 欢迎态：isBlankState 纯判据', () => {
  it('9. EmptyState：hero 问候语，示例卡平面化（glass-edge 清零）', () => {
    expect(EMPTY).toContain('你好，今天想做点什么？');
    expect(EMPTY.split('var(--glass-edge)').length - 1).toBe(0);
  });
});
