/** MU2b Task 4：左栏变体 A 任务卡——lib/session/status + lib/time/relative 纯模块单测
 *  + SessionList.vue 重做 / App.vue 232px 源文本守卫。
 *  数据源诚实说明：chat.sessions.list RPC 无 running/messages 字段，非活动会话徽标与产物角标
 *  一期不可得 → sessionBadge(live=null) 返回 null、scount 仅活动会话显示（计划 Task 4 明示）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sessionBadge, artifactCountOf } from '../src/renderer/src/lib/session/status';
import { fmtRelative } from '../src/renderer/src/lib/time/relative';

const root = path.resolve(__dirname, '..');
const sessionList = fs.readFileSync(path.join(root, 'src/renderer/src/components/SessionList.vue'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/App.vue'), 'utf8');

describe('MU2b Task 4 左栏任务卡：lib/session/status 纯模块（4 例）', () => {
  it('非活动会话（live=null）→ null（RPC 无 running 字段，一期不显示徽标）', () => {
    expect(sessionBadge({ id: 's1' }, null)).toBeNull();
  });

  it('running → running（优先级最高，压过 waiting/failed）', () => {
    const live = { running: true, pendingPerms: [{}], lastStopReason: 'maxTokens' };
    expect(sessionBadge({ id: 's1' }, live)).toBe('running');
  });

  it('pendingPerms>0 → waiting；maxTokens/refusal（error 系）→ failed；endTurn/toolUse（完成过回合）→ done；空会话 → null', () => {
    const base = { running: false, pendingPerms: [] as unknown[], lastStopReason: '' };
    expect(sessionBadge({ id: 's1' }, { ...base, pendingPerms: [{}] })).toBe('waiting');
    expect(sessionBadge({ id: 's1' }, { ...base, lastStopReason: 'maxTokens' })).toBe('failed');
    expect(sessionBadge({ id: 's1' }, { ...base, lastStopReason: 'refusal' })).toBe('failed');
    expect(sessionBadge({ id: 's1' }, { ...base, lastStopReason: 'endTurn' })).toBe('done');
    expect(sessionBadge({ id: 's1' }, { ...base, lastStopReason: 'toolUse' })).toBe('done');
    expect(sessionBadge({ id: 's1' }, base)).toBeNull();
  });

  it('artifactCountOf：复用 Task 3 collect（file_write/file_edit 去重计数）；空 → 0', () => {
    const messages = [{ parts: [
      { type: 'toolUse', value: { name: 'file_write', input: JSON.stringify({ path: '/var/minis/workspace/a.txt', content: '1' }) } },
      { type: 'toolUse', value: { name: 'file_edit', input: JSON.stringify({ path: '/var/minis/workspace/b.txt', old_string: 'x', new_string: 'y' }) } },
      { type: 'toolUse', value: { name: 'shell_execute', input: JSON.stringify({ command: 'ls' }) } },
    ] }];
    expect(artifactCountOf(messages)).toBe(2);
    expect(artifactCountOf([])).toBe(0);
  });
});

describe('MU2b Task 4 左栏任务卡：lib/time/relative 纯模块（3 例）', () => {
  const now = new Date(2026, 7, 1, 14, 30, 0).getTime() / 1000; // 2026-08-01 14:30:00 本地

  it('<60s → 刚刚；<60min → N 分钟前', () => {
    expect(fmtRelative(now - 30, now)).toBe('刚刚');
    expect(fmtRelative(now - 59, now)).toBe('刚刚');
    expect(fmtRelative(now - 60, now)).toBe('1 分钟前');
    expect(fmtRelative(now - 5 * 60, now)).toBe('5 分钟前');
    expect(fmtRelative(now - 59 * 60, now)).toBe('59 分钟前');
  });

  it('今天 ≥1h → HH:MM；昨天 → 昨天', () => {
    const today9 = new Date(2026, 7, 1, 9, 5, 0).getTime() / 1000;
    expect(fmtRelative(today9, now)).toBe('09:05');
    const yesterday = new Date(2026, 6, 31, 18, 40, 0).getTime() / 1000;
    expect(fmtRelative(yesterday, now)).toBe('昨天');
  });

  it('前天及更早 → M-D（不补零）', () => {
    const d = new Date(2026, 6, 29, 10, 0, 0).getTime() / 1000;
    expect(fmtRelative(d, now)).toBe('7-29');
    const prevYear = new Date(2025, 11, 31, 10, 0, 0).getTime() / 1000;
    expect(fmtRelative(prevYear, now)).toBe('12-31');
  });
});

describe('MU2b Task 4 左栏任务卡：SessionList/App.vue 守卫（2 例）', () => {
  it('SessionList.vue：.scard 卡结构 + .sbadge 四态类（run/wait/fail/done）+ .scount 角标 + datehead 分组保留 + .lfoot 底部两按钮（设置/设备）+ 纯模块引用', () => {
    expect(sessionList).toContain('class="scard"');
    // MU5 重锚（锚失效 + 一处刻意形态变更）：状态由「文字徽标 .sbadge」改「色点 .sdot」，
    // 依据是拍板稿的会话行「点 + 标题 + 右对齐时间」。四态区分与状态色令牌一个没少，
    // 变的是编码方式。**丢掉文字标签是真损失**（颜色成了唯一编码，色觉障碍读不到），
    // 故 badgeText() 把同一状态文字挂到行 title 上——补偿本身也纳入守卫，
    // 否则将来有人删掉 title，没有任何测试会发现。
    expect(sessionList).toContain('sdot');
    expect(sessionList).toContain('badgeText');
    expect(sessionList).toContain(':title="badgeText(s)"');
    expect(sessionList).toContain('run');
    expect(sessionList).toContain('wait');
    expect(sessionList).toContain('fail');
    expect(sessionList).toContain('done');
    expect(sessionList).toContain('scount');
    expect(sessionList).toContain('datehead');
    expect(sessionList).toContain('lfoot');
    expect(sessionList).toContain('设置');
    expect(sessionList).toContain('设备');
    expect(sessionList).toContain('sessionBadge');
    expect(sessionList).toContain('artifactCountOf');
    expect(sessionList).toContain('fmtRelative');
    expect(sessionList).toContain("inject('openSettings')");
    // 进行中绿/等待批准橙/失败红/完成灰（令牌消费，禁写死色值）
    expect(sessionList).toContain('var(--state-ok)');
    expect(sessionList).toContain('var(--state-warn)');
    expect(sessionList).toContain('var(--state-err)');
  });

  /** MU5 重锚：布局 B 把展开态压到 212px；I6 再重锚 240px（AionUi 新版宽侧栏，
   *  用户 2026-08-20 截图指令）——同一守卫换锚不换意图，历史档位全列反向锚。 */
  it('App.vue：.pane-l 展开态宽 212px → 240px（I6；折叠态另走 52px 图标轨）', () => {
    expect(app).toContain('width: 240px');
    expect(app).not.toContain('width: 260px');
    expect(app).not.toContain('width: 232px');
    expect(app).not.toContain('width: 212px');
  });
});
