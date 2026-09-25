/** W2b-11a：托盘菜单「打开设置」「切换右栏」的订阅（纯函数，单测见 tests/renderer-tray-menu.test.ts）。
 *
 *  为什么需要：主进程的托盘菜单一直在 webContents.send('menu:open-settings' / 'menu:toggle-right')，
 *  preload 也暴露了 onMenuOpenSettings / onMenuToggleRight，渲染端却从没订阅——两项点了没反应（死通道）。
 *  AppShell 在 setup 里调这里订上，返回的退订函数挂在组件作用域上，卸载时两条一起摘。
 *
 *  拿不到 preload（普通浏览器里开渲染端、测试环境）或少了某个接口时照常返回退订函数，什么也不做——
 *  托盘只是多一个入口，不能因为它让外壳起不来。订阅接口没返回退订函数（旧 preload）时退订跳过它。 */

export interface TrayMenuBridge {
  onMenuOpenSettings?: (cb: () => void) => unknown;
  onMenuToggleRight?: (cb: () => void) => unknown;
}

export interface TrayMenuHandlers {
  /** 托盘「打开设置」 */
  openSettings: () => void;
  /** 托盘「切换右栏」——调用方传标题栏右栏钮的同一个函数 */
  toggleRight: () => void;
}

/** 订上两条通道，返回退订函数（可重复调用，只退一次）。 */
export function subscribeTrayMenu(bridge: TrayMenuBridge | null | undefined, h: TrayMenuHandlers): () => void {
  const offs: unknown[] = [];
  if (typeof bridge?.onMenuOpenSettings === 'function') offs.push(bridge.onMenuOpenSettings(() => h.openSettings()));
  if (typeof bridge?.onMenuToggleRight === 'function') offs.push(bridge.onMenuToggleRight(() => h.toggleRight()));
  let done = false;
  return () => {
    if (done) return;
    done = true;
    for (const off of offs) if (typeof off === 'function') off();
  };
}
