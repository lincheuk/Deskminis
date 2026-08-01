/**
 * M3c Task 7 · UI 源文本守卫测试（小项 7d）
 *
 * 参照 MU2 renderer-* 先例：读 .vue/.ts 源码断言关键 class/结构/action 存在，不启动浏览器。
 * CDP 断言（DevicesModal 交互/TitleBar 渲染）并入 Task 8 e2e 第 9 步。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '../src/renderer/src');

describe('M3c UI 源文本守卫', () => {
  it('DevicesModal：加入配对两输入（host:port + 配对码，免手抄公钥）+ 在线点 dot class', () => {
    const src = readFileSync(join(root, 'components/DevicesModal.vue'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('joinAddr'); // host:port 输入
    expect(src).toContain('joinCode'); // 配对码输入（既有，M3c 启用）
    expect(src).toContain('joinPairing'); // 调 store action
    expect(src).not.toContain('joinPubKey'); // 无公钥输入（免手抄）
    expect(src).toMatch(/class="dot[^"]*"/); // 在线点
  });

  it('TitleBar：同步状态点三态（offline/idle/syncing）+ pulse 动画', () => {
    const src = readFileSync(join(root, 'components/TitleBar.vue'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('syncdot');
    expect(src).toContain('offline');
    expect(src).toContain('idle');
    expect(src).toContain('syncing');
    expect(src).toContain('pulse');
  });

  it('ChatView：回合区消息设备标（originDeviceId 映射）', () => {
    const src = readFileSync(join(root, 'components/ChatView.vue'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('originDeviceId');
  });

  it('chat.ts：joinPairing action + syncState state + synced 事件处理', () => {
    const src = readFileSync(join(root, 'stores/chat.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('joinPairing');
    expect(src).toContain('syncState');
    expect(src).toContain('synced'); // 事件处理
  });

  it('chat.ts：devices 项增 online/lastSeenAt 字段', () => {
    const src = readFileSync(join(root, 'stores/chat.ts'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('online');
    expect(src).toContain('lastSeenAt');
  });
});
