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

describe('L5 ChatView：composer MCP pill + 行内面板', () => {
  const cv = read('src/renderer/src/components/ChatView.vue');
  it('pill 仅活动会话且存在已启用 server 时显示；挂载即拉取 server 列表', () => {
    expect(cv).toContain('enabledMcpServers');
    expect(cv).toContain('mcpPillVisible');
    expect(cv).toContain('v-if="mcpPillVisible"');
    expect(cv).toContain('fetchMcpServers()'); // 不拉取则 pill 永不出现（mcpServers 初值为空）
    expect(cv).toContain('class="cpill mcpbtn"');
  });
  it('行内面板走 wspanel 成例（非浮层，.ctools overflow 裁浮层的老坑）；逐 server checkbox「本会话禁用」', () => {
    expect(cv).toContain('class="mcpanel"');
    expect(cv).toContain('本会话禁用');
    expect(cv).toContain('setSessionMcpDisabled(');
    expect(cv).toContain('下一回合'); // 生效时点文案（设计 §5：面板说明禁用生效时机）
    // 两个行内面板互斥展开：都开着会把 composer 顶出屏（336px 窄列实测过 wspanel 挤压事故）
    expect(cv).toMatch(/wsOpen\.value = false;?\s*\n?\s*mcpOpen\.value = !mcpOpen\.value/);
    expect(cv).toMatch(/mcpOpen\.value = false;?\s*\n?\s*wsOpen\.value = !wsOpen\.value/);
  });
});
