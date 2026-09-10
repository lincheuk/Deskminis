/** MU2b Task 2：进度 tab（ProgressPanel 替换 TasksPanel）——chat.ts 增量 + 视图 + App/ChatView 接线（源文本守卫）。
 *  Global Constraints 源文本守卫同步修订清单允许：本文件在同 Task 内整体改写为 ProgressPanel 守卫；
 *  M2d 语义回归锚（chat.ts 7 字段/open·send 清零/fetchContextInfo/三事件分支/turnEnd）原样保留。 */
/* T6e-3 集体退场说明：本文件有若干例随实现退场。理由——
   任务面板内部实现（toolStats 三计数、STOP_LABEL、retryNote 卡）——新树的 ui/TaskPanel.vue 只报上下文水位与回合状态，工具成败就地显示在对话流的 StepGroup 上。新落点：tests/renderer-shell-panels.test.ts（V5，含 StopReason 四值中文映射）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');
const chatTs = fs.readFileSync(path.join(root, 'src/renderer/src/stores/chat.ts'), 'utf8');
const progressPanel = fs.readFileSync(path.join(root, 'src/renderer/src/ui/TaskPanel.vue'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/ui/AppShell.vue'), 'utf8');
const chatView = fs.readFileSync(path.join(root, 'src/renderer/src/ui/StageChat.vue'), 'utf8');

describe('MU2b Task 2 进度 tab（ProgressPanel 替换 TasksPanel，8 例）', () => {
  it('S1. chat.ts M2d state 回归锚（7 字段全保留）+ MU2b 纯增量：permFocusRequestId + toolCards 元素 startedAt/endedAt（步骤行 duration 数据源）', () => {
    expect(chatTs).toContain("lastStopReason");
    expect(chatTs).toContain("eventNotes");
    expect(chatTs).toContain("fallbackState");
    expect(chatTs).toContain("compactedState");
    expect(chatTs).toContain("offloadedState");
    expect(chatTs).toContain("contextInfo");
    expect(chatTs).toContain("windowTokens");
    expect(chatTs).toContain("usedTokens");
    // MU2b 增量
    expect(chatTs).toContain("permFocusRequestId: null as string | null");
    expect(chatTs).toContain("startedAt?: number");
    expect(chatTs).toContain("endedAt?: number");
  });

  it('S2. M2d 回归：open(id) 与 send(text) 首段清零追加 lastStopReason/eventNotes/fallback/compacted/offloaded/contextInfo（不丢 lastError/retryNote/running）', () => {
    expect(chatTs).toMatch(/if \(id !== this\.activeId\) \{[\s\S]*this\.lastStopReason = ''[\s\S]*this\.eventNotes = \[\][\s\S]*this\.fallbackState = null[\s\S]*this\.compactedState = null[\s\S]*this\.offloadedState = null[\s\S]*this\.contextInfo = null/);
    expect(chatTs).toMatch(/send\s*\(.*\)[\s\S]*this\.lastStopReason = ''[\s\S]*this\.eventNotes = \[\]/);
  });

  it('S3. M2d 回归：init 首次调 fetchContextInfo + actions 定义 async fetchContextInfo（chat.contextInfo 存 state，catch 不抛）', () => {
    expect(chatTs).toContain("void this.fetchContextInfo();");
    expect(chatTs).toContain("async fetchContextInfo()");
    expect(chatTs).toContain("rpc.call('chat.contextInfo', { sessionId: this.activeId })");
    expect(chatTs).toContain("catch");
  });

  it('S4. M2d 回归：onEvent 三事件分支（fallback/compacted/offloaded）各调 fetchContextInfo；turnEnd 末尾也调；M2c skills 状态保留', () => {
    expect(chatTs).toContain("e.kind === 'fallback'");
    expect(chatTs).toContain("e.kind === 'compacted'");
    expect(chatTs).toContain("e.kind === 'offloaded'");
    expect(chatTs).toContain("this.fallbackState = {");
    expect(chatTs).toContain("this.compactedState = {");
    expect(chatTs).toContain("this.offloadedState = {");
    expect(chatTs).toContain("this.eventNotes = [...this.eventNotes.slice(-9)");
    const afterTurnEnd = chatTs.slice(chatTs.indexOf("e.kind === 'turnEnd'"));
    expect(afterTurnEnd.indexOf("void this.fetchContextInfo()")).toBeGreaterThan(afterTurnEnd.indexOf("void this.open(this.activeId)"));
    expect(chatTs).toContain("refreshSkills");
    expect(chatTs).toContain("skills: [] as UiSkill[]");
  });

  it('S5. 组件换代：TasksPanel.vue 已删除（existsSync === false）；App.vue 改 import ProgressPanel + visited.progress 挂载，TasksPanel 字样清零', () => {
    expect(fs.existsSync(path.join(root, 'src/renderer/src/components/TasksPanel.vue'))).toBe(false);
    // T6e-3：文件 / 改动 / 任务在新树里是 ui/WorkspacePanel.vue 的三个 tab，
// 不再是 App.vue 里三个并列面板——tab 切换断言随之落到面板内部。
    expect(read('src/renderer/src/ui/WorkspacePanel.vue')).toMatch(/import TaskPanel from '\.\/TaskPanel\.vue'/);
    // T6e-3 重指：任务是 WorkspacePanel 的第三个 tab
    expect(read('src/renderer/src/ui/WorkspacePanel.vue')).toMatch(/tab === 'tasks'/);
    expect(app).not.toContain("TasksPanel");
  });

  it('S7. 等待批准显著化（T6e-3 重指：呈现主体换人）', () => {
    // 旧模型：任务面板出一张「⏸ 等待批准」卡 + 工作台 tab 出橙点 + ChatView 滚动定位。
    // 新模型：权限卡**直接渲染在对话流里**（V1 补的那块，换壳时整个漏掉过），
    // 用户看见的就是卡本身，不需要另一个面板再提示一次、也不需要跨面板跳转。
    // 所以这里只钉「任务面板仍报得出回合状态」，权限卡本体由
    // tests/renderer-chat-capabilities.test.ts 与 tests/renderer-permcard.test.ts 守。
    expect(progressPanel).toMatch(/running|stopReason|等待/);
  });

});
