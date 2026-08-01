/** MU2b Task 5：设置独立模态 + 标题栏瘦身——lib/settings/theme 纯模块单测
 *  + SettingsModal/App.vue/preload/TitleBar 源文本守卫。
 *  preload 白名单：本 Task 仅追加 onMenuOpenSettings/onMenuToggleRight 两订阅；main 侧零改动。 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadTheme, saveTheme } from '../src/renderer/src/lib/settings/theme';

const root = path.resolve(__dirname, '..');
const settingsModal = fs.readFileSync(path.join(root, 'src/renderer/src/components/SettingsModal.vue'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/App.vue'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8');
const titleBar = fs.readFileSync(path.join(root, 'src/renderer/src/components/TitleBar.vue'), 'utf8');

// node 环境无 localStorage：注入内存 stub（getItem/setItem/removeItem 最小契约）
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

describe('MU2b Task 5 设置模态：lib/settings/theme 纯模块（3 例）', () => {
  beforeEach(() => { store.clear(); });

  it('localStorage 无存 → system；非法值 → system', () => {
    expect(loadTheme()).toBe('system');
    store.set('deskminis.theme', 'blue');
    expect(loadTheme()).toBe('system');
  });

  it('合法值 system/light/dark 原样读回', () => {
    for (const t of ['system', 'light', 'dark'] as const) {
      store.set('deskminis.theme', t);
      expect(loadTheme()).toBe(t);
    }
  });

  it('saveTheme 落盘 deskminis.theme，loadTheme 可读回', () => {
    saveTheme('dark');
    expect(store.get('deskminis.theme')).toBe('dark');
    expect(loadTheme()).toBe('dark');
    saveTheme('light');
    expect(loadTheme()).toBe('light');
  });
});

describe('MU2b Task 5 设置模态：组件与接线守卫（5 例）', () => {
  it('SettingsModal.vue：四 section 导航 + ProviderSettings 平移 + Esc 关闭 + 遮罩 rgba(0,0,0,.4) + 720px + --r-sheet + 权限说明文案', () => {
    expect(settingsModal).toContain('模型');
    expect(settingsModal).toContain('外观');
    expect(settingsModal).toContain('权限');
    expect(settingsModal).toContain('设备与同步');
    expect(settingsModal).toContain("import ProviderSettings from './ProviderSettings.vue'");
    expect(settingsModal).toContain('Escape');
    expect(settingsModal).toContain('rgba(0,0,0,.4)');
    expect(settingsModal).toContain('720px');
    expect(settingsModal).toContain('var(--r-sheet)');
    expect(settingsModal).toContain('危险命令始终拦截');
    expect(settingsModal).toContain('每次确认默认 90 秒未响应自动拒绝');
    expect(settingsModal).toContain('chat.permTier');
    expect(settingsModal).toContain('setPermTier');
  });

  it('App.vue：gear tab 移除 + SettingsModal 接线（settingsOpen 语义=模态开关）+ ProviderSettings 不再经 App + 托盘两通道监听 + Ctrl+, 锚', () => {
    expect(app).not.toContain('tab gear');
    expect(app).toContain("import SettingsModal from './components/SettingsModal.vue'");
    expect(app).toContain('SettingsModal v-if="settingsOpen"');
    expect(app).not.toContain('ProviderSettings');
    expect(app).toContain('onMenuOpenSettings');
    expect(app).toContain('onMenuToggleRight');
    expect(app).toContain("e.key === ','");
  });

  it('App.vue theme 接线：启动 loadTheme + setTheme 落盘（saveTheme）+ cycleTheme 保留', () => {
    expect(app).toContain('loadTheme');
    expect(app).toContain('saveTheme');
    expect(app).toContain('setTheme');
    expect(app).toContain('cycleTheme');
  });

  it('preload/index.ts：追加 onMenuOpenSettings/onMenuToggleRight（ipcRenderer.on 包装 + 返回取消订阅函数）；既有 minisdPort/minisdInfo 不动', () => {
    expect(preload).toContain('onMenuOpenSettings');
    expect(preload).toContain('onMenuToggleRight');
    expect(preload).toContain('ipcRenderer.on');
    expect(preload).toContain('removeListener');
    expect(preload).toContain('minisdPort');
    expect(preload).toContain('minisdInfo');
  });

  it('TitleBar.vue：前进/后退移除 + noop 项全删（新建工作区/导入技能…/文档/键盘快捷键/更新日志/诊断信息/关于 DeskMinis）；侧栏开关/标题/主题键保留', () => {
    expect(titleBar).not.toContain('tb-nav');
    expect(titleBar).not.toContain('name="back"');
    expect(titleBar).not.toContain('name="forward"');
    for (const label of ['新建工作区', '导入技能…', '文档', '键盘快捷键', '更新日志', '诊断信息', '关于 DeskMinis']) {
      expect(titleBar).not.toContain(label);
    }
    expect(titleBar).not.toContain("'noop'");
    expect(titleBar).toContain("emit('toggle-sidebar')");
    expect(titleBar).toContain('tb-title');
    expect(titleBar).toContain('新建会话');
  });
});
