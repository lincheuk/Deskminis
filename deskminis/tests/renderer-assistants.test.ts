/** J2 守卫：助手体系前端接线的源文本断言（设计稿 2026-08-20-assistants-design.md §5/§6）。
 *
 *  断言面：
 *    1. store：assistants 状态 + refreshAssistants→assistants.list + CRUD 三件（删除带 confirm）
 *       + newSessionWithAssistant→chat.sessions.create 扩参 + assistants.changed 订阅；
 *    2. EmptyState：未绑态助手卡区（点卡开绑定会话）/ 绑定态助手 hero + 预设 prompts 走
 *       既有 @fill 通路；三通用示例卡与最近任务锚不动（renderer-composer 守卫的地基）；
 *       助手卡键盘可达（tabindex+role+keydown 成例）；
 *    3. SettingsModal：NAV 增「助手」项 + AssistantSettings 组件接入；
 *    4. AssistantSettings：CRUD 接线 + 删除二次确认 + 模型选择写 provider: 前缀 +
 *       技能复选来自 allSkills（管理页数据源，含禁用项）；
 *    5. SessionList：会话行助手 emoji 前缀；
 *    6. 随动修缺（申报）：SessionList 模型绑定 select 写 'provider:' 前缀值——此前存裸 id，
 *       chat.prompt 解析只认前缀，绑定静默失效走默认模型（J2 调研实锤的休眠 bug）。
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const STORE = read('src/renderer/src/stores/chat.ts');
const EMPTY = read('src/renderer/src/components/EmptyState.vue');
const SETTINGS = read('src/renderer/src/components/SettingsModal.vue');
const ASSIST = 'src/renderer/src/components/AssistantSettings.vue';
const SESSIONLIST = read('src/renderer/src/components/SessionList.vue');

describe('J2 助手体系前端接线', () => {
  it('1. store：状态 + 刷新 + CRUD + 扩参建会话 + 广播订阅', () => {
    expect(STORE).toContain('assistants: [] as UiAssistant[]');
    expect(STORE).toContain("await rpc.call('assistants.list')");
    expect(STORE).toContain("rpc.on('assistants.changed'");
    expect(STORE).toContain('async newSessionWithAssistant(');
    expect(STORE).toMatch(/chat\.sessions\.create',\s*\{\s*assistantId/);
    expect(STORE).toMatch(/assistants\.delete',\s*\{\s*id[^}]*confirm:\s*true/);
    expect(STORE).toContain('assistantId?: string'); // sessions 状态字段与后端 SessionMeta 对齐
  });

  it('2. EmptyState：选中再输入（I6 药丸流）+ @fill 通路与既有锚不破 + 键盘可达', () => {
    expect(EMPTY).toContain('boundAssistant');
    // I6 改锚（用户 2026-08-20 截图指令）：点助手不再立刻建会话——chip 只写选择态
    // welcomeAssistantId，会话在**发送时**由 ChatView 按选择创建（AionUi Guid 页语义）
    expect(EMPTY).toContain('welcomeAssistantId');
    expect(EMPTY).not.toContain('newSessionWithAssistant');
    // 预设 prompts 走既有 fill 通路（不自动发送——与示例卡同语义）
    expect(EMPTY).toMatch(/prompts[\s\S]*emit\('fill'/);
    // renderer-composer 守卫的地基锚原样保留
    for (const anchor of ['读代码', '写脚本', '跑命令', 'chat.sessions.slice(0, 3)', "emit('fill'", 'chat.open(']) {
      expect(EMPTY).toContain(anchor);
    }
    // 助手 chip 键盘可达（a11y-keyboard-reachable 成例：tabindex + role + enter/space）
    const card = EMPTY.match(/class="ascard"[^>]*>/);
    expect(card, 'EmptyState 应有 .ascard 助手 chip').toBeTruthy();
    expect(card![0]).toContain('tabindex');
    expect(card![0]).toContain('role="button"');
    expect(card![0]).toContain('@keydown.enter');
  });

  it('2b. I6 欢迎屏次序与发送接线：hero → composer → 助手区下移；send 按选择建会话', () => {
    const chatView = read('src/renderer/src/components/ChatView.vue');
    // 源序：stream 里的 hero 部（part="hero"）在 .composer 之前，.wbelow（part="below"）在其后
    const iHero = chatView.indexOf('part="hero"');
    const iComposer = chatView.indexOf('<div class="composer">');
    const iBelow = chatView.indexOf('class="wbelow"');
    expect(iHero).toBeGreaterThan(-1);
    expect(iBelow).toBeGreaterThan(-1);
    expect(iHero).toBeLessThan(iComposer);
    expect(iComposer).toBeLessThan(iBelow);
    // 发送时消费选择态：无会话 + 选了助手 → newSessionWithAssistant；否则普通新建
    expect(chatView).toContain('newSessionWithAssistant');
    expect(chatView).toContain('welcomeAssistantId');
  });

  it('3. SettingsModal：NAV「助手」项 + 组件接入', () => {
    expect(SETTINGS).toContain("{ id: 'assistants', label: '助手' }");
    expect(SETTINGS).toContain('AssistantSettings');
    expect(SETTINGS).toMatch(/AssistantSettings v-else-if="section === 'assistants'"/);
  });

  it('4. AssistantSettings：CRUD + 二次确认 + provider: 前缀 + allSkills 数据源', () => {
    const src = read(ASSIST);
    expect(src).toContain('createAssistant');
    expect(src).toContain('updateAssistant');
    expect(src).toContain('deleteAssistant');
    expect(src).toContain('confirmDelete');
    expect(src).toContain("'provider:' + p.id");
    expect(src).toContain('allSkills');
  });

  it('5. SessionList：会话行助手 emoji 前缀', () => {
    expect(SESSIONLIST).toContain('avatarOf');
    expect(SESSIONLIST).toContain('assistantId');
  });

  it('6. 随动修缺：SessionList 模型绑定写 provider: 前缀（裸 id 静默失效 bug）', () => {
    expect(SESSIONLIST).toContain("'provider:' + p.id");
    // 反向锚：裸 id 选项不得再出现（:value="p.id" 是坏形态）
    expect(SESSIONLIST).not.toMatch(/:value="p\.id"/);
  });

  it('7. I6 侧栏对齐：品牌行 + New Chat 行式（newbtn 类名与键盘通路不动）', () => {
    expect(SESSIONLIST).toContain('class="brand"');
    expect(SESSIONLIST).toContain('DeskMinis');
    expect(SESSIONLIST).toContain('class="newbtn"'); // a11y 守卫锚（renderer-a11y-keyboard）不动
  });

  it('8. I6 标题栏净化：三文字菜单收纳为单 ☰ 菜单（功能项全保留）', () => {
    const tb = read('src/renderer/src/components/TitleBar.vue');
    // 单菜单：menus 数组只剩一项；全部动作项仍在（新建/切换三区/主题/重载/退出/编辑五件）
    expect(tb.match(/\{ id: '[a-z]+', label: '[^']*', items:/g) ?? []).toHaveLength(1);
    for (const act of ["act: 'new'", "act: 'sidebar'", "act: 'chat'", "act: 'right'", "act: 'theme'", "act: 'reload'", "act: 'quit'", "act: 'copy'"]) {
      expect(tb).toContain(act);
    }
  });
});
