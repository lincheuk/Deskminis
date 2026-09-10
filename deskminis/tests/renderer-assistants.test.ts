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
const EMPTY = read('src/renderer/src/ui/StageWelcome.vue');
const SETTINGS = read('src/renderer/src/ui/StageSettings.vue');
const ASSIST = 'src/renderer/src/ui/StageAssistants.vue';
const SESSIONLIST = read('src/renderer/src/ui/NavRail.vue');

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

  it('2. StageWelcome：选中助手 → 开场提示来自它的 prompts → 点一条填进输入卡（T6e-3 重指）', () => {
    // 旧欢迎页是三张写死示例卡 + emit('fill')；新欢迎页的开场提示来自**选中助手自带的 prompts**，
    // 点一条直接 composer.fill()。「空手进来的人有东西可点」这个意图没变，机制更对了。
    expect(EMPTY).toMatch(/picked\.prompts/);
    expect(EMPTY).toMatch(/composer\.value\?\.fill\(/);
    expect(EMPTY).toMatch(/chat\.sessions\.slice\(0, \d\)/);   // 最近会话
    expect(EMPTY).toMatch(/aria-pressed="chat\.welcomeAssistantId === a\.id"/); // 选中态可被读出
  });

  it('2b. I6 欢迎屏次序与发送接线：hero → composer → 助手区下移；send 按选择建会话', () => {
    // T6e-3 重指：欢迎屏是独立舞台 ui/StageWelcome.vue，次序 = hero → 输入卡 → 助手网格
    const chatView = read('src/renderer/src/ui/StageWelcome.vue');
    const iHero = chatView.indexOf('class="hero"');
    const iComposer = chatView.indexOf('<Composer');
    const iBelow = chatView.indexOf('class="acard"');
    expect(iHero).toBeGreaterThan(-1);
    expect(iBelow).toBeGreaterThan(-1);
    expect(iHero).toBeLessThan(iComposer);
    expect(iComposer).toBeLessThan(iBelow);
    // 发送时消费选择态：无会话 + 选了助手 → newSessionWithAssistant；否则普通新建
    // 发送时消费选择态：谁负责「选了助手就用它建会话」——输入卡或欢迎页，二者其一即可
    const composer = read('src/renderer/src/ui/Composer.vue');
    expect(chatView + composer).toMatch(/newSessionWithAssistant|welcomeAssistantId/);
    expect(chatView).toContain('welcomeAssistantId');
  });

  it('3. SettingsModal：NAV「助手」项 + 组件接入', () => {
    // 助手从设置页的一节升格为一级舞台视图（NavRail 直达）
    expect(SESSIONLIST).toMatch(/emit\('view', 'assistants'\)/);
    expect(read('src/renderer/src/ui/AppShell.vue')).toContain('StageAssistants');  // 助手是一级舞台
    expect(read('src/renderer/src/ui/AppShell.vue')).toMatch(/<StageAssistants v-else-if="view === 'assistants'"/);
  });

  /* T6e-3 退场「4. AssistantSettings：CRUD + 二次确认 + provider: 前缀 + allSkills 数据源…」：CRUD/二次确认/provider: 前缀三项已由 tests/renderer-stage-views.test.ts（T5 + T6a2）在 ui/StageAssistants.vue 上重钉；**allSkills 数据源没有对应物**——新助手编辑器整个没有技能绑定字段（store 与后端的 skillIds 仍在）。这是换壳遗失的入口，已记入 mu6 能力清单与候选池 */

  it('5. SessionList：会话行助手 emoji 前缀', () => {
    expect(SESSIONLIST).toContain('emojiOf');  // 改名
    expect(SESSIONLIST).toContain('assistantId');
  });

  /* T6e-3 退场「6. 随动修缺：SessionList 模型绑定写 provider: 前缀…」：会话级模型绑定入口（setSessionModelBinding）随 SessionList 退场，已在 mu6 能力清单 GAPS 里；助手侧同一 bug 的守卫在 tests/renderer-stage-views.test.ts（T6a2） */

  it('7. I6 侧栏对齐：品牌行 + New Chat 行式（newbtn 类名与键盘通路不动）', () => {
    expect(SESSIONLIST).toContain('class="brand"');
    expect(SESSIONLIST).toContain('DeskMinis');
    expect(SESSIONLIST).toContain('class="newbtn"');
  });

  /* T6e-3 退场「8. I6 标题栏净化：三文字菜单收纳为单 ☰ 菜单…」：新 TopBar 的 ☰ 只剩主题切换（@menu="toggleTheme"），重载/退出在主进程原生菜单（main/index.ts Menu.buildFromTemplate）。「三区切换 / 新建 / 复制」这几项没了渲染端入口——属于换壳时的收窄，记入候选池 */
});
