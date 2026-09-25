/** W2b-6c：打包版的应用菜单只留编辑与视图两组快捷键（src/main/app-menu.ts）。
 *
 *  为什么要钉：默认菜单带 Ctrl+R 重载与 Ctrl+Shift+I 开发者工具，回合中途按到 Ctrl+R，流式正文、待批的权限卡、没发出去的字全没了；
 *  可一把菜单设成 null，缩放（Ctrl 加 + / - / 0）与 F11 全屏也跟着没了，应用里没有别的缩放入口（W2b-6b 审查）。
 *  这里只看模板本身：有哪些角色、有没有带 click 或自定义快捷键的项；打包版真的设了它，由
 *  tests/main-window-guard-wiring-packaged.test.ts 钉。 */
import { describe, it, expect } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';
import { PACKAGED_MENU_TEMPLATE } from '../src/main/app-menu';

/** 模板里（含子菜单）每一项，逐层展开 */
function items(tpl: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return tpl.flatMap((it) => [it, ...(Array.isArray(it.submenu) ? items(it.submenu as MenuItemConstructorOptions[]) : [])]);
}
const all = items(PACKAGED_MENU_TEMPLATE);
/** Electron 认角色名不分大小写，比较前统一小写 */
const roles = new Set(all.map((it) => String(it.role ?? '').toLowerCase()).filter(Boolean));

describe('打包版应用菜单模板', () => {
  it('留着缩放与全屏：resetZoom、zoomIn、zoomOut、togglefullscreen', () => {
    for (const r of ['resetzoom', 'zoomin', 'zoomout', 'togglefullscreen']) expect(roles, r).toContain(r);
  });

  it('留着编辑组：undo、redo、cut、copy、paste、selectAll', () => {
    for (const r of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectall']) expect(roles, r).toContain(r);
  });

  it('没有重载、强制重载、开发者工具——换个大小写写法也不行', () => {
    for (const r of roles) expect(r, `菜单里不该有 ${r}`).not.toMatch(/reload|devtools/);
  });

  it('只用内置角色：没有 click 回调，也没有自定义快捷键（不能另挂一个 Ctrl+R、F5、Ctrl+Shift+I、F12）', () => {
    for (const it of all) {
      expect(it.click, JSON.stringify(it)).toBeUndefined();
      expect(it.accelerator, JSON.stringify(it)).toBeUndefined();
      // 分隔线与分组标题以外，每一项都要有角色：没有角色的项只能靠 click 干活
      if (it.type !== 'separator' && !Array.isArray(it.submenu)) expect(it.role, JSON.stringify(it)).toBeTruthy();
    }
  });
});
