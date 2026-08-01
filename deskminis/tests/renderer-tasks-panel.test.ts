/** M2d Task 5：任务面板视图层 + store 增量（源文本守卫，不启动浏览器）。
 *  覆盖：chat.ts 7 条增量（a-f + turnEnd 刷新）、TasksPanel.vue 6 类 UI 组成、App.vue 2 处追加（#3 演进关系：Task 4 基线上只加 import TasksPanel + 填实 tasks 页签）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const chatTs = fs.readFileSync(path.join(root, 'src/renderer/src/stores/chat.ts'), 'utf8');
const tasksPanel = fs.readFileSync(path.join(root, 'src/renderer/src/components/TasksPanel.vue'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/App.vue'), 'utf8');

describe('M2d Task 5 任务面板（store 增量 + 视图 + App 接线，7 例）', () => {
  it('Step 1 a. UiMessage 接口补 tokenUsage（与 shared/types TokenUsage 同构），旧 parts 与 role 保留', () => {
    expect(chatTs).toContain("tokenUsage?: { inputTokens: number; outputTokens: number }");
  });

  it('Step 1 b. state 末追加 7 字段：lastStopReason + eventNotes + fallbackState + compactedState + offloadedState + contextInfo（#10 四事件 + #7 水位缓存）', () => {
    expect(chatTs).toContain("lastStopReason");
    expect(chatTs).toContain("eventNotes");
    expect(chatTs).toContain("fallbackState");
    expect(chatTs).toContain("compactedState");
    expect(chatTs).toContain("offloadedState");
    expect(chatTs).toContain("contextInfo");
    expect(chatTs).toContain("windowTokens");
    expect(chatTs).toContain("usedTokens");
  });

  it('Step 1 c/d. open(id) 与 send(text) 首段清零追加 lastStopReason/eventNotes/fallback/compacted/offloaded/contextInfo（不丢老的 lastError/retryNote/running）', () => {
    // open 切换时清零：
    expect(chatTs).toMatch(/if \(id !== this\.activeId\) \{[\s\S]*this\.lastStopReason = ''[\s\S]*this\.eventNotes = \[\][\s\S]*this\.fallbackState = null[\s\S]*this\.compactedState = null[\s\S]*this\.offloadedState = null[\s\S]*this\.contextInfo = null/);
    // send 前清零（至少包含 lastStopReason 与 eventNotes 清空）
    expect(chatTs).toMatch(/send\s*\(.*\)[\s\S]*this\.lastStopReason = ''[\s\S]*this\.eventNotes = \[\]/);
  });

  it('Step 1 e. init 里首次调 fetchContextInfo + actions 里定义 async fetchContextInfo（调 rpc.call chat.contextInfo 存 state，catch 不抛）', () => {
    expect(chatTs).toContain("void this.fetchContextInfo();");
    expect(chatTs).toContain("async fetchContextInfo()");
    expect(chatTs).toContain("rpc.call('chat.contextInfo', { sessionId: this.activeId })");
    expect(chatTs).toContain("catch");
  });

  it('Step 1 f. onEvent 里 fallback/compacted/offloaded 三个新分支（#10 事件 UI 接线），每分支都调了 fetchContextInfo；turnEnd 分支末尾也调 fetchContextInfo；M2c skills/slash 状态保留', () => {
    expect(chatTs).toContain("e.kind === 'fallback'");
    expect(chatTs).toContain("e.kind === 'compacted'");
    expect(chatTs).toContain("e.kind === 'offloaded'");
    expect(chatTs).toContain("this.fallbackState = {");
    expect(chatTs).toContain("this.compactedState = {");
    expect(chatTs).toContain("this.offloadedState = {");
    expect(chatTs).toContain("this.eventNotes = [...this.eventNotes.slice(-9)");
    // 三处 fetchContextInfo 调用（三事件分支各 1，turnEnd 末尾 1，init 1，open/send 不清零不调用）：
    // turnEnd 分支末尾有 `void this.fetchContextInfo();`（`this.open(...)` 后单独一行）
    const afterTurnEnd = chatTs.slice(chatTs.indexOf("e.kind === 'turnEnd'"));
    expect(afterTurnEnd.indexOf("void this.fetchContextInfo()")).toBeGreaterThan(afterTurnEnd.indexOf("void this.open(this.activeId)"));
    // M2c skills/slash 状态锚：store 保留 skills 列表、技能相关 actions；ChatView 组件保留 slashOpen（红线：#3 ChatView 不碰）
    expect(chatTs).toContain("refreshSkills");
    expect(chatTs).toContain("skills: [] as UiSkill[]");
  });

  it('Step 2. TasksPanel.vue 视图组成：回合区（running/toolCards/stopReason/retryNote）+ 用量区（lastUsage + totals）+ 水位条（watermark.contextInfo 优先，pct <60 绿 85 橙）+ #10 事件状态卡', () => {
    // 模板里插值 `{{ lastUsage ? ... }}` 不写 .value；computed 本身引用里会出现 `lastUsage` 名
    expect(tasksPanel).toContain("lastUsage");
    expect(tasksPanel).toContain("totals");
    expect(tasksPanel).toContain("chat.contextInfo");
    expect(tasksPanel).toContain("watermark");
    expect(tasksPanel).toContain("pct < 60");
    expect(tasksPanel).toContain("toolCards.filter");
    expect(tasksPanel).toContain("STOP_LABEL");
    expect(tasksPanel).toContain("chat.lastStopReason");
    expect(tasksPanel).toContain("chat.retryNote");
    expect(tasksPanel).toContain("chat.running");
    // #10 事件三卡（卡片命名/字段与 loop.ts 真实载荷对齐：fix(m2d) 本次同步修订）
    expect(tasksPanel).toContain("chat.fallbackState");
    expect(tasksPanel).toContain("chat.compactedState");
    expect(tasksPanel).toContain("chat.offloadedState");
    expect(tasksPanel).toContain("模型已降级");
    expect(tasksPanel).toContain("上下文已压缩");
    expect(tasksPanel).toContain("大工具输出已卸载"); // 与 loop.ts 的 offloaded(toolUseId,relativePath) 语义对齐：非「历史消息」而是大工具输出逐条约盘
  });

  it('Step 3. App.vue 2 处增量（Task 4 → Task 5 串行演进；MU2b Task 1 修订：tasks 页签名改 progress，断言语义不变只换名）：import TasksPanel；rightTab===progress 时 v-show v-if visited.progress；terminal/files 页签 v-show 保留；import TerminalPanel/FilesPanel 不变', () => {
    expect(app).toContain("import TasksPanel from './components/TasksPanel.vue'");
    expect(app).toContain("v-show=\"rightTab === 'progress'\"");
    expect(app).toContain("TasksPanel v-if=\"visited.progress\"");
    // 另外两页签 v-show 仍然是懒挂载保活（演进 #3 串行：Task 3 + Task 4 保留）
    expect(app).toContain("v-show=\"rightTab === 'terminal'\"");
    expect(app).toContain("v-show=\"rightTab === 'files'\"");
    expect(app).toContain("import TerminalPanel from './components/TerminalPanel.vue'");
    expect(app).toContain("import FilesPanel from './components/FilesPanel.vue'");
  });
});
