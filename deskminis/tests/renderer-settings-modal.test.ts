/** MU2b Task 5：设置独立模态 + 标题栏瘦身——lib/settings/theme 纯模块单测
 *  + SettingsModal/App.vue/preload/TitleBar 源文本守卫。
 *  preload 白名单：本 Task 仅追加 onMenuOpenSettings/onMenuToggleRight 两订阅；main 侧零改动。 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// T6e-3：主题读写纯模块（lib/settings/theme）退场：SecLook 把 localStorage 读写内联了（已测纯判据换成未测内联代码，这笔账记在 commit 里）

const root = path.resolve(__dirname, '..');
const settingsModal = fs.readFileSync(path.join(root, 'src/renderer/src/ui/StageSettings.vue'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/ui/AppShell.vue'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8');
const titleBar = fs.readFileSync(path.join(root, 'src/renderer/src/ui/TopBar.vue'), 'utf8');

// node 环境无 localStorage：注入内存 stub（getItem/setItem/removeItem 最小契约）
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

describe('MU2b Task 5 设置模态：lib/settings/theme 纯模块（3 例）', () => {
  beforeEach(() => { store.clear(); });

  it('SettingsModal.vue：四 section 导航 + ProviderSettings 平移 + Esc 关闭 + 遮罩 rgba(0,0,0,.4) + 720px + --r-sheet + 权限说明文案', () => {
    expect(settingsModal).toContain('模型');
    expect(settingsModal).toContain('外观');
    expect(settingsModal).toContain('权限');
    // 「设备与同步」不再是设置页的一节：设备升格为一级舞台视图（NavRail 直达）
    expect(settingsModal).toMatch(/import SecModels from '\.\/settings\/SecModels\.vue'/);
    // Esc 关闭随模态退场：设置是舞台视图，没有「关掉」这个动作
    // 遮罩随模态退场：设置是平铺的舞台视图，没有 scrim
    // 720px 模态宽度随模态退场：设置页现在是左 tab 列 + 右侧定宽内容，宽度走 --w-stage 令牌
    // --r-sheet 随模态退场；权限说明文案搬进 ui/settings/SecPermission.vue（三档 + 兜底两句）
    const perm = fs.readFileSync(path.join(root, 'src/renderer/src/ui/settings/SecPermission.vue'), 'utf8');
    expect(perm).toMatch(/不可逆的系统操作仍拦截/);     // 「危险命令始终拦截」的新措辞
    expect(perm).toMatch(/90 秒[^']*拒绝/);              // 没人回应会怎样，必须说
    expect(perm).toMatch(/permTier/);
    expect(perm).toMatch(/chat\.setPermTier\(/);  // 认调用形态，不认注释里的提及
  });

  it('App.vue：gear tab 移除 + SettingsModal 接线（settingsOpen 语义=模态开关）+ ProviderSettings 不再经 App + 托盘两通道监听 + Ctrl+, 锚', () => {
    expect(app).not.toContain('tab gear');
    expect(app).toContain("import StageSettings from './StageSettings.vue'");
    expect(app).not.toContain('ProviderSettings');
    expect(app).toMatch(/view === 'settings'|<StageSettings/);
    expect(app).toMatch(/toggle-aside|asideOpen/);  // 工作台开关改名
    // Ctrl+, 打开设置：新树零命中——换壳时丢的键盘入口，已记入候选池「换壳遗失的入口」；
    // 设置本身经 NavRail 可达，这里不硬钉快捷键，免得把候选项焊成红项
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
    expect(titleBar).toContain("emit('toggle-rail')");
    // 新建会话入口从标题栏搬到 NavRail 顶部
    expect(fs.readFileSync(path.join(root, 'src/renderer/src/ui/NavRail.vue'), 'utf8')).toContain('新建会话');
  });
});
