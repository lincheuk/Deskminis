/** L5 会话级 MCP 勾选 UI 守卫（设计稿 2026-08-20-pool-batch-design.md §5）。
 *  后端全通（sessions.mcp_disabled_json + chat.sessions.setMcpDisabled + 双保险执行），
 *  本步纯补 renderer 入口——守卫锚定：store 镜像 + composer pill + 行内面板（wspanel 成例）。
 *  .vue 不进 typecheck，故按源文接线断言（renderer-* 守卫成例）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

describe('L5 store：sessions 镜像 mcpDisabled + setSessionMcpDisabled 动作', () => {
  it('sessions 类型带 mcpDisabled；动作调 chat.sessions.setMcpDisabled 后重拉列表', () => {
    const st = read('src/renderer/src/stores/chat.ts');
    expect(st).toContain('mcpDisabled?: string[]'); // 后端 listSessions 本就返回，此前前端类型未声明（读不到）
    expect(st).toContain('async setSessionMcpDisabled(');
    expect(st).toContain("'chat.sessions.setMcpDisabled'");
    // 写后重拉：列表即最新事实（D6 MCP 管理页同一成例），不就地改本地态
    expect(st.slice(st.indexOf('async setSessionMcpDisabled('))).toContain('refreshSessions()');
  });
});

/* T6e-3：「L5 ChatView：composer MCP pill + 行内面板」整组退场。
   会话级 MCP 禁用入口（输入卡上的 pill + 行内逐 server 勾选「本会话禁用」）随 ChatView 退场，
   新树没有重建——`setSessionMcpDisabled` 在 ui/ 下零引用。**这是能力缺失，不是重指得了的**。
   守它的是 tests/mu6-capability-wiring.test.ts 的 GAPS 绊线：谁补上入口那条就红，逼他更新清单。
   上面 store 例照旧——能力在后端与 store 里都还在，补入口之前别把它当死代码清掉。 */
