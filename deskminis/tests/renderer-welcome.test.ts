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
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { isBlankState } from '../src/renderer/src/lib/welcome/blank';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const APP = read('src/renderer/src/App.vue');
const CHAT = read('src/renderer/src/components/ChatView.vue');
const TB = read('src/renderer/src/components/TitleBar.vue');
const EMPTY = read('src/renderer/src/components/EmptyState.vue');

const BLANK = { messages: [], running: false, streamingText: '', toolCards: [], pendingPerms: [], retryNote: null, eventNotes: [] };

describe('I3 欢迎态：isBlankState 纯判据', () => {
  it('1. 全空 → true', () => {
    expect(isBlankState(BLANK)).toBe(true);
  });
  it('2. 有历史消息（含乐观 local- 消息）→ false', () => {
    expect(isBlankState({ ...BLANK, messages: [{ id: 'local-1' }] })).toBe(false);
  });
  it('3. 实时活动（running / 流式 / 工具卡 / 权限卡 / 重试注记）任一 → false', () => {
    expect(isBlankState({ ...BLANK, running: true })).toBe(false);
    expect(isBlankState({ ...BLANK, streamingText: '思' })).toBe(false);
    expect(isBlankState({ ...BLANK, toolCards: [{}] })).toBe(false);
    expect(isBlankState({ ...BLANK, pendingPerms: [{}] })).toBe(false);
    expect(isBlankState({ ...BLANK, retryNote: { n: 1 } })).toBe(false);
  });
  it('4. 事件条残留 → false（错误条还在就不是「空白起点」）', () => {
    expect(isBlankState({ ...BLANK, eventNotes: [{}] })).toBe(false);
  });
});

describe('I3 欢迎态：源文本接线守卫', () => {
  it('5. App.vue：pane-w/wbrail v-show 与 pane-chat 定宽 style 三处都带 !welcomeMode', () => {
    expect(APP).toContain('v-show="workbenchOpen && workbenchExpanded && !welcomeMode"');
    expect(APP).toContain('v-show="workbenchOpen && !workbenchExpanded && !welcomeMode"');
    expect(APP).toMatch(/workbenchOpen && workbenchExpanded && !welcomeMode \? \{ width/);
  });
  it('6. App.vue 与 ChatView 共用 isBlankState（判据不双写）', () => {
    expect(APP).toContain("from './lib/welcome/blank'");
    expect(CHAT).toContain("from '../lib/welcome/blank'");
    expect(CHAT).not.toMatch(/chat\.messages\.length === 0 && !hasLive/);
  });
  it('7. TitleBar：工作台开关带 :disabled="welcome" 与欢迎态说明 title', () => {
    expect(TB).toContain(':disabled="welcome"');
    expect(TB).toMatch(/欢迎页/);
  });
  it('8. ChatView：根元素带 welcome 类绑定', () => {
    expect(CHAT).toContain(":class=\"{ welcome: isEmpty }\"");
    expect(CHAT).toContain('.pane-c.welcome');
  });
  it('9. EmptyState：hero 问候语，示例卡平面化（glass-edge 清零）', () => {
    expect(EMPTY).toContain('你好，今天想做点什么？');
    expect(EMPTY.split('var(--glass-edge)').length - 1).toBe(0);
  });
});
