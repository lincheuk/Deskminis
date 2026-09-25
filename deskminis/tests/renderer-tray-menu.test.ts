/** W2b-11a：托盘菜单两条通道的订阅（纯模块 lib/tray/menu.ts 的单测）。
 *
 *  立项事实（侦察 cross.md missing 末条、设计稿 §2「发布工程」末句）：托盘菜单的「打开设置」「切换右栏」
 *  在主进程里一直 webContents.send('menu:open-settings' / 'menu:toggle-right')，preload 也暴露了
 *  onMenuOpenSettings / onMenuToggleRight 两个订阅接口，但 src/renderer/src 里一处订阅都没有——点了没反应。
 *  这里钉订阅本身：两条都订上、回调各走各的动作、退订把两条都摘掉且只摘一次；拿不到 preload 时不抛。
 *  AppShell 那一侧（设置舞台、右栏开合、卸载退订）的行为测试在 renderer-tray-wiring.test.ts。 */
import { describe, it, expect } from 'vitest';
import { subscribeTrayMenu } from '../src/renderer/src/lib/tray/menu';

/** 仿 preload：按通道记监听，订阅返回退订函数（与 src/preload/index.ts 同形），另记退订被调了几次。 */
function fakeBridge() {
  const listeners = { settings: new Set<() => void>(), right: new Set<() => void>() };
  const offCalls = { settings: 0, right: 0 };
  return {
    listeners, offCalls,
    onMenuOpenSettings(cb: () => void) {
      listeners.settings.add(cb);
      return () => { offCalls.settings++; listeners.settings.delete(cb); };
    },
    onMenuToggleRight(cb: () => void) {
      listeners.right.add(cb);
      return () => { offCalls.right++; listeners.right.delete(cb); };
    },
    fire(ch: 'settings' | 'right') { for (const cb of [...listeners[ch]]) cb(); },
  };
}

describe('subscribeTrayMenu', () => {
  it('两条通道各订一次；「打开设置」只调 openSettings，「切换右栏」只调 toggleRight', () => {
    const b = fakeBridge();
    const calls: string[] = [];
    subscribeTrayMenu(b, { openSettings: () => calls.push('settings'), toggleRight: () => calls.push('right') });
    expect(b.listeners.settings.size).toBe(1);
    expect(b.listeners.right.size).toBe(1);
    b.fire('settings');
    b.fire('right');
    b.fire('right');
    expect(calls).toEqual(['settings', 'right', 'right']);
  });

  it('退订：两条都摘掉，之后主进程再 send 也不再触发；重复调用不重复退订', () => {
    const b = fakeBridge();
    const calls: string[] = [];
    const off = subscribeTrayMenu(b, { openSettings: () => calls.push('settings'), toggleRight: () => calls.push('right') });
    off();
    expect(b.listeners.settings.size).toBe(0);
    expect(b.listeners.right.size).toBe(0);
    b.fire('settings'); b.fire('right');
    expect(calls).toEqual([]);
    off();
    expect(b.offCalls).toEqual({ settings: 1, right: 1 });
  });

  it('拿不到 preload（普通浏览器里跑渲染端、测试环境）或少了接口：不抛，退订也不抛', () => {
    const h = { openSettings: () => {}, toggleRight: () => {} };
    for (const bridge of [undefined, null, {}]) {
      const off = subscribeTrayMenu(bridge, h);
      expect(() => off()).not.toThrow();
    }
    // 只有一个接口：有的那个照订
    const listeners: (() => void)[] = [];
    let hit = 0;
    subscribeTrayMenu({ onMenuToggleRight: (cb: () => void) => { listeners.push(cb); return () => {}; } }, { ...h, toggleRight: () => { hit++; } });
    listeners.forEach(cb => cb());
    expect(hit).toBe(1);
  });

  it('订阅接口没有返回退订函数（旧 preload）：退订时跳过，不抛', () => {
    const off = subscribeTrayMenu(
      { onMenuOpenSettings: () => undefined, onMenuToggleRight: () => 'x' },
      { openSettings: () => {}, toggleRight: () => {} },
    );
    expect(() => off()).not.toThrow();
  });
});
