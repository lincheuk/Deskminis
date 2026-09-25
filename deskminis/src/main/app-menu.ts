import type { MenuItemConstructorOptions } from 'electron';

/**
 * 打包版的应用菜单（W2b-6c）。窗口无边框，菜单栏本身看不见，这里只为快捷键服务。
 *
 * 为什么不是 Electron 的默认菜单：默认菜单带 Ctrl+R 重载与 Ctrl+Shift+I 开发者工具——回合中途按到 Ctrl+R，
 * 流式正文、待批的权限卡、输入框里没发出去的字全没了（W2b-11a 三审）。
 * 为什么不是 null（W2b-6b 的做法）：null 把缩放（Ctrl 加 + / - / 0）与 F11 全屏一起拿掉了，应用里没有别的缩放入口，
 * 对要放大字号的用户是退步（W2b-6b 审查）。
 * 所以只留编辑与视图两组角色：编辑组在 Windows 上 Chromium 本就会处理，列出来是为了不依赖这一点；
 * 视图组只有缩放与全屏。重载、强制重载、开发者工具一个都不放（tests/app-menu.test.ts 钉着）。
 */
export const PACKAGED_MENU_TEMPLATE: MenuItemConstructorOptions[] = [
  {
    label: '编辑',
    submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ],
  },
  {
    label: '视图',
    submenu: [
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  },
];
