/** MU2b Task 2：进度 tab（ProgressPanel 替换 TasksPanel）——chat.ts 增量 + 视图 + App/ChatView 接线（源文本守卫）。
 *  Global Constraints 源文本守卫同步修订清单允许：本文件在同 Task 内整体改写为 ProgressPanel 守卫；
 *  M2d 语义回归锚（chat.ts 7 字段/open·send 清零/fetchContextInfo/三事件分支/turnEnd）原样保留。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const chatTs = fs.readFileSync(path.join(root, 'src/renderer/src/stores/chat.ts'), 'utf8');
const progressPanel = fs.readFileSync(path.join(root, 'src/renderer/src/components/ProgressPanel.vue'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/App.vue'), 'utf8');
const chatView = fs.readFileSync(path.join(root, 'src/renderer/src/components/ChatView.vue'), 'utf8');

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
    expect(app).toContain("import ProgressPanel from './components/ProgressPanel.vue'");
    expect(app).toContain("ProgressPanel v-if=\"visited.progress\"");
    expect(app).not.toContain("TasksPanel");
  });

  it('S6. ProgressPanel 组成：任务句（sessions 找 activeId 标题）+ 步骤列表（toolCards + fmtDuration）+ Token（lastUsage/totals）+ 水位（contextInfo 优先 + pct<60 + --state-ok/warn 色槽）+ 事件三卡', () => {
    // 任务句区
    expect(progressPanel).toContain("chat.sessions.find");
    expect(progressPanel).toContain("activeId");
    // 步骤列表（与对话流 ToolLine 同数据）
    expect(progressPanel).toContain("chat.toolCards");
    expect(progressPanel).toContain("fmtDuration");
    // Token 两行（M2d 平移）
    expect(progressPanel).toContain("lastUsage");
    expect(progressPanel).toContain("totals");
    // 水位条：contextInfo 优先（M2d #7 语义）+ 色槽替写死（--green/--orange 变量引用退场，换 --state-ok/warn/err）
    expect(progressPanel).toContain("chat.contextInfo");
    expect(progressPanel).toContain("watermark");
    expect(progressPanel).toContain("pct < 60");
    expect(progressPanel).toContain("--state-ok");
    expect(progressPanel).toContain("--state-warn");
    // 事件三卡（M2d #10 平移，语义字段不变）
    expect(progressPanel).toContain("chat.fallbackState");
    expect(progressPanel).toContain("chat.compactedState");
    expect(progressPanel).toContain("chat.offloadedState");
    expect(progressPanel).toContain("模型已降级");
    expect(progressPanel).toContain("上下文已压缩");
    expect(progressPanel).toContain("大工具输出已卸载");
  });

  it('S7. 等待批准显著化：pendingPerms>0 → 「⏸ 等待批准」卡 + 「去处理」写 chat.permFocusRequestId；App.vue 进度 tab 带 dot-warn；ChatView watch + scrollIntoView 定位权限卡并清空', () => {
    expect(progressPanel).toContain("chat.pendingPerms.length > 0");
    expect(progressPanel).toContain("去处理");
    expect(progressPanel).toContain("chat.permFocusRequestId = ");
    // MU5 重锚（锚失效，非真回归）：标签条改数组渲染后，dot-warn 的条件里多了一项
    // 「限定进度标签」——MU2b 四枚等分 tab 各写各的，位置本身即区分；数组渲染后必须显式判 id。
    // 行为一字未变：pendingPerms>0 → 进度标签出橙点；MU5 起同一信号还并行出现在图标轨徽标上。
    expect(app).toMatch(/'dot-warn':[^}]*chat\.pendingPerms\.length > 0/);
    expect(app).toMatch(/\.wtab\.dot-warn::after/);
    expect(chatView).toContain("chat.permFocusRequestId");
    expect(chatView).toContain("scrollIntoView");
  });

  it('S8. M2d 语义回归锚：toolStats 三计数（成功/失败/进行中）+ STOP_LABEL 映射 + lastStopReason/retryNote/running 沿用', () => {
    expect(progressPanel).toContain("toolStats");
    expect(progressPanel).toContain("toolCards.filter");
    expect(progressPanel).toContain("STOP_LABEL");
    expect(progressPanel).toContain("chat.lastStopReason");
    expect(progressPanel).toContain("chat.retryNote");
    expect(progressPanel).toContain("chat.running");
  });
});
