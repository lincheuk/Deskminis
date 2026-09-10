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
  it('StageDevices：加入配对两输入（host:port + 配对码，免手抄公钥）+ 在线点', () => {
    const src = readFileSync(join(root, 'ui/StageDevices.vue'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('joinAddr');    // host:port 输入
    expect(src).toContain('joinCode');    // 配对码输入
    expect(src).toContain('joinPairing'); // 调 store action
    expect(src).not.toContain('joinPubKey'); // 无公钥输入（免手抄）
    expect(src).toMatch(/class="dot[^"]*"/); // 在线点
  });

  it('TopBar：同步状态点三态（syncing / idle / 未连接）+ 人话 title', () => {
    // T6e-3 重指：syncdot → syncDot，pulse 动画退场（改用颜色区分三态，title 说人话）。
    // ⚠️ 我先前把这条误判成「没搬」——按 syncdot 小写去搜自然零命中。守卫重指前要按**意图**搜，不按旧名。
    const src = readFileSync(join(root, 'ui/TopBar.vue'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('syncDot');
    expect(src).toMatch(/syncState === 'syncing'/);
    expect(src).toMatch(/syncState === 'idle'/);
    expect(src).toMatch(/正在与其它设备同步/);
    expect(src).toMatch(/未连接其它设备/);   // 第三态也要说得出话
    expect(src).toMatch(/:title="syncDot\.t"/); // 悬停可读
  });

  /* T6e-3 退场「ChatView：回合区消息设备标…」：消息来源设备标（originDeviceId → 「来自 xx 设备」）在新 StageChat 里没有对应物。store 的 UiMessage 仍带 originDeviceId，只是没人渲染。记入候选池「换壳遗失的入口」 */

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

  // M4.6 Task 3：joinPairing 需透传 listenPort 到 remote.pair.join，
  // 否则 begin 侧断线后没有 join 侧监听端口无法回拨（回复收敛只剩单方向）
  //
  // 强度边界（复核评审 2026-08-08）：本条是源码子串匹配，只能挡「整段被删除」，
  // 不能证明「listenPort 到达 join RPC」——写一行注释或没用到的 `const listenPort` 照样绿。
  // Task 3 验收依据是真行为测试 renderer-chat-joinpairing.test.ts（桩 rpc.call 断言值），
  // 本条仅作灰盒守卫保留，不作为验收证据。
  it('chat.ts：joinPairing 透传 listenPort 到 remote.pair.join（M4.6 Task 3，灰盒守卫）', () => {
    const src = readFileSync(join(root, 'stores/chat.ts'), 'utf8').replace(/\r\n/g, '\n');
    const start = src.indexOf('async joinPairing');
    const end = src.indexOf('async retryLast');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const seg = src.slice(start, end);
    expect(seg).toContain('remote.pair.join');
    expect(seg).toContain('listenPort'); // 当前缺失 → 红灯
  });
});
