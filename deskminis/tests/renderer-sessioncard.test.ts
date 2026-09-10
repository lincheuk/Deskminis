/** MU2b Task 4：左栏变体 A 任务卡——lib/session/status + lib/time/relative 纯模块单测
 *  + SessionList.vue 重做 / App.vue 232px 源文本守卫。
 *  数据源诚实说明：chat.sessions.list RPC 无 running/messages 字段，非活动会话徽标与产物角标
 *  一期不可得 → sessionBadge(live=null) 返回 null、scount 仅活动会话显示（计划 Task 4 明示）。 */
/* T6e-3：4 例退场——会话状态徽标判据随 SessionList 退场：新 NavRail 的会话行不显示运行态徽标（能力缺失，非重构）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
// T6e-3：会话状态判据（lib/session/status）随 SessionList 一起退场：新 NavRail 的会话行不显示运行态徽标
import { fmtRelative } from '../src/renderer/src/lib/time/relative';

const root = path.resolve(__dirname, '..');
const sessionList = fs.readFileSync(path.join(root, 'src/renderer/src/ui/NavRail.vue'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/renderer/src/ui/AppShell.vue'), 'utf8');

describe('MU2b Task 4 左栏任务卡：lib/session/status 纯模块（4 例）', () => {
  it('左栏宽度走 --w-rail 令牌，折叠态另有 --w-rail-mini（T6e-3 重指）', () => {
    const rail = fs.readFileSync(path.join(root, 'src/renderer/src/ui/NavRail.vue'), 'utf8');
    expect(rail).toMatch(/width: var\(--w-rail\)/);
    expect(rail).toMatch(/var\(--w-rail-mini\)/);
    // 不再钉具体像素：212→240→220 三改其值，改的都是裁定不是 bug，守卫只钉「走令牌」
    expect(app).not.toContain('width: 232px');
    expect(app).not.toContain('width: 212px');
  });
});
