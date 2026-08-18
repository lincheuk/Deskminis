/** MU2a Task 10：权限卡 v2（设计 §5.2 + 审计 H2/H3/X-7）。
 *  纯模块 lib/perm/copy.ts（8 例）+ lib/perm/countdown.ts（2 例）
 *  + PermissionCard.vue/chat.ts 源文本守卫（含超时留条 2 例——守卫并入计数）。
 *  守卫工具：源文本读取统一归一化 CRLF→LF。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { permTitle, permTriggerLabel } from '../src/renderer/src/lib/perm/copy';
import { remainSeconds, countdownTone } from '../src/renderer/src/lib/perm/countdown';

const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const permCard = R('../src/renderer/src/components/PermissionCard.vue');
const chatTs = R('../src/renderer/src/stores/chat.ts');

describe('MU2a Task 10 permTitle（8 例）', () => {
  it('bridge-notify → 请求发送通知', () => { expect(permTitle('bridge-notify')).toBe('请求发送通知'); });
  it('bridge-clipboard-read → 请求读取剪贴板', () => { expect(permTitle('bridge-clipboard-read')).toBe('请求读取剪贴板'); });
  it('bridge-clipboard-write → 请求写入剪贴板', () => { expect(permTitle('bridge-clipboard-write')).toBe('请求写入剪贴板'); });
  it('bridge-open → 请求打开链接或文件', () => { expect(permTitle('bridge-open')).toBe('请求打开链接或文件'); });
  it('bridge-speak → 请求语音播报', () => { expect(permTitle('bridge-speak')).toBe('请求语音播报'); });
  it('bridge-screenshot → 请求截屏', () => { expect(permTitle('bridge-screenshot')).toBe('请求截屏'); });
  it('bridge-device → 请求读取设备信息', () => { expect(permTitle('bridge-device')).toBe('请求读取设备信息'); });
  it('web-fetch → 请求访问网络（perm/copy.ts 两处文案守卫：标题 + 触发短标）', () => {
    expect(permTitle('web-fetch')).toBe('请求访问网络');
    expect(permTriggerLabel('web-fetch')).toBe('访问网络权限');
  });
  it('既有三类保留 + 未知 kind 兜底「请求权限」', () => {
    expect(permTitle('shell')).toBe('请求执行命令');
    expect(permTitle('file-write')).toBe('请求写入文件');
    expect(permTitle('file-read')).toBe('请求读取文件');
    expect(permTitle('mystery')).toBe('请求权限');
  });
});

describe('MU2a Task 10 双段告知短标 + 倒计时（4 例）', () => {
  it('permTriggerLabel：桥七类「xx 权限」短标，未知兜底「权限」', () => {
    expect(permTriggerLabel('bridge-notify')).toBe('通知权限');
    expect(permTriggerLabel('bridge-clipboard-read')).toBe('读取剪贴板权限');
    expect(permTriggerLabel('bridge-clipboard-write')).toBe('写入剪贴板权限');
    expect(permTriggerLabel('bridge-open')).toBe('打开链接或文件权限');
    expect(permTriggerLabel('bridge-speak')).toBe('语音播报权限');
    expect(permTriggerLabel('bridge-screenshot')).toBe('截屏权限');
    expect(permTriggerLabel('bridge-device')).toBe('读取设备信息权限');
    expect(permTriggerLabel('mystery')).toBe('权限');
  });
  it('remainSeconds：ceil 取整 + clamp ≥0', () => {
    expect(remainSeconds(100_000, 0)).toBe(100);
    expect(remainSeconds(10_500, 10_000)).toBe(1); // 0.5s .ceil→1
    expect(remainSeconds(9_000, 10_000)).toBe(0); // 负值钳到 0
  });
  it('countdownTone：≤10s urgent，其余 normal', () => {
    expect(countdownTone(90)).toBe('normal');
    expect(countdownTone(11)).toBe('normal');
    expect(countdownTone(10)).toBe('urgent');
    expect(countdownTone(0)).toBe('urgent');
  });
});

describe('MU2a Task 10 PermissionCard.vue 守卫', () => {
  it('倒计时读秒：remain 驱动 + mono 字体 + urgent ≤10s 变橙（--state-warn）', () => {
    expect(permCard).toContain('remainSeconds(');
    expect(permCard).toContain('countdownTone(');
    expect(permCard).toContain('remain');
    expect(permCard).toContain('setInterval');
    expect(permCard).toContain('clearInterval'); // unmount 清定时器
    expect(permCard).toContain('--font-mono');
    expect(permCard).toContain('urgent');
    expect(permCard).toContain('--state-warn');
  });
  it('盾牌分级：danger --state-err / 其余 --state-warn + 分级副文案', () => {
    expect(permCard).toContain("riskClass === 'danger'");
    expect(permCard).toContain('--state-err');
    expect(permCard).toContain('高风险操作');
    expect(permCard).toContain('需要你的批准');
  });
  it('标题经 permTitle( 映射（七类桥 + 既有三类）', () => {
    expect(permCard).toContain('permTitle(');
  });
  it('双段告知块：bridgeTriggers?.length 时才渲染「此命令将触发」列表', () => {
    expect(permCard).toContain('此命令将触发');
    expect(permCard).toContain('perm.bridgeTriggers?.length');
    expect(permCard).toContain('permTriggerLabel(');
  });
  it('按钮三枚：允许（--action 实底主钮）/ 本会话允许 / 拒绝；预选 .pre 2px --action 边框', () => {
    expect(permCard).toContain('允许');
    expect(permCard).toContain('本会话允许');
    expect(permCard).toContain('拒绝');
    expect(permCard).toContain("'allow-once'");
    expect(permCard).toContain("'allow-session'");
    expect(permCard).toContain("'deny'");
    // 主钮实底 + 预选 2px 边框
    expect(permCard).toMatch(/\.btn\.primary[^}]*background:\s*var\(--action\)/);
    expect(permCard).toMatch(/\.btn\.pre[^}]*border:\s*2px solid var\(--action\)/);
    // preselect 逻辑保留（permTier 映射不变）
    expect(permCard).toContain("permTier === 'ask'");
  });
  it('既有锚不回归：逐字完整 detail 区 + respondPerm 接线', () => {
    expect(permCard).toContain('perm.detail');
    expect(permCard).toContain('chat.respondPerm(perm.requestId');
    expect(permCard).toContain('word-break: break-all');
  });
  it('按钮不折字：.btn nowrap + min-width、.btns flex-wrap（窄列下按钮整颗换行而非文字断行）', () => {
    // 「本会话允许」在 336px 对话列里曾被折成「本会话允/许」两行——文字断行比按钮换行难看得多
    expect(permCard).toMatch(/\.btn\s*\{[^}]*white-space:\s*nowrap/);
    expect(permCard).toMatch(/\.btn\s*\{[^}]*min-width:/);
    expect(permCard).toMatch(/\.btns\s*\{[^}]*flex-wrap:\s*wrap/);
  });
});

describe('MU2a Task 10 chat.ts 守卫', () => {
  it('PendingPerm 扩字段 + permission.request 并入 meta + deadlineMs push 时计算', () => {
    expect(chatTs).toContain('timeoutMs?: number');
    expect(chatTs).toContain('riskClass?: string');
    expect(chatTs).toContain('bridgeTriggers?: string[]');
    expect(chatTs).toContain('deadlineMs');
    expect(chatTs).toContain('Date.now() + ');
    // meta 并入（permission.request 处理器消费 params.meta）
    expect(chatTs).toContain('meta');
  });
  it('超时留条：resolved reason===timeout → 摘卡 + eventNotes 追加「权限请求已超时，自动拒绝」（retryable:false）', () => {
    expect(chatTs).toContain("reason === 'timeout'");
    expect(chatTs).toContain('权限请求已超时，自动拒绝');
    // 留条走 error 类事件条且不可重试
    expect(chatTs).toMatch(/reason === 'timeout'[\s\S]{0,400}kind: 'error'/);
    expect(chatTs).toMatch(/权限请求已超时，自动拒绝[\s\S]{0,200}retryable: false/);
  });
  it('answered/无 reason → 只摘卡不补条（分流结构存在，摘卡 filter 未删）', () => {
    // 摘卡行为保留（两分支共用或各自 filter）
    expect(chatTs).toContain('pendingPerms = this.pendingPerms.filter');
    // 补条只挂在 timeout 分支：摘卡段（timeout 判定之前）不得出现留条文案
    const resolvedHandler = chatTs.split("rpc.on('permission.resolved'")[1] ?? '';
    const beforeTimeoutCheck = resolvedHandler.split("reason === 'timeout'")[0] ?? '';
    expect(beforeTimeoutCheck).not.toContain('已超时'); // timeout 判定前的摘卡段无留条文案
  });
});

// 审批前变更预览：file_write/file_edit 权限卡带 preview 时在路径行下方渲染差分区
// （复用 ToolLine 同款 DiffView + diffLines/countAddDel），写文件审批不再是盲批。
describe('变更预览（审批前差分）守卫', () => {
  it('PermissionCard：perm.preview 存在时渲染 DiffView（diffLines/countAddDel 驱动 +N/−N）', () => {
    expect(permCard).toContain('perm.preview');
    expect(permCard).toContain('DiffView');
    expect(permCard).toContain('diffLines(');
    expect(permCard).toContain('countAddDel(');
    // 差分区在模板里位于路径行（.args）之后（脚本段 props.perm.preview 不算，只看 <template> 内）
    const tpl = permCard.split('<template>')[1] ?? '';
    const argsIdx = tpl.indexOf('class="args"');
    const previewIdx = tpl.indexOf('perm.preview');
    expect(argsIdx).toBeGreaterThan(-1);
    expect(previewIdx).toBeGreaterThan(argsIdx);
  });
  it('chat.ts：PendingPerm 透传 preview（req.preview → push 字段）', () => {
    expect(chatTs).toContain('preview?: { oldText: string; newText: string }');
    expect(chatTs).toContain('preview: req.preview');
  });
});
