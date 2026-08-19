/** D6 渲染端守卫：McpSettings.vue 设置页 + SettingsModal 'mcp' section 接入 + chat store 五 action。
 *  .vue 不在 typecheck 覆盖内——读源文本锚点断言即源码守卫
 *  （MU6 血案：v-for 挂带 scoped 类名元素引发 renderList 抛错；MU5：scoped 类名撞车）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const modal = fs.readFileSync(path.join(root, 'src/renderer/src/components/SettingsModal.vue'), 'utf8');
// 新组件尚不存在时给空串：让断言失败（红）而不是文件加载崩掉整组用例
const mcpPath = path.join(root, 'src/renderer/src/components/McpSettings.vue');
const mcp = fs.existsSync(mcpPath) ? fs.readFileSync(mcpPath, 'utf8') : '';
const chat = fs.readFileSync(path.join(root, 'src/renderer/src/stores/chat.ts'), 'utf8');

describe('D6 SettingsModal：mcp section 行级接入', () => {
  it("NAV 增 'mcp'（标题「MCP」）且排在技能之后；import 与 v-else-if 接线，其余 section 不动", () => {
    expect(modal).toContain("import McpSettings from './McpSettings.vue'");
    expect(modal).toContain("{ id: 'mcp', label: 'MCP' }");
    expect(modal).toContain('<McpSettings v-else-if="section === \'mcp\'" />');
    expect(modal.indexOf("{ id: 'skills'")).toBeLessThan(modal.indexOf("{ id: 'mcp'"));
    expect(modal.indexOf("{ id: 'mcp'")).toBeLessThan(modal.indexOf("{ id: 'appearance'"));
    expect(modal).toContain("'model' | 'skills' | 'mcp'");
  });
});

describe('D6 McpSettings.vue 守卫', () => {
  it('configError 页顶警示条：固定文案，不回显解析原文', () => {
    expect(mcp).toContain('configError');
    expect(mcp).toContain('servers.json 解析失败，已按空配置加载——请检查文件语法');
  });

  it('状态点三态锚点（idle 灰 / connected 绿 / error 红）+ lastError + 工具数', () => {
    expect(mcp).toContain('mxdot');
    expect(mcp).toContain("'idle'");
    expect(mcp).toContain("'connected'");
    expect(mcp).toContain("'error'");
    expect(mcp).toContain('lastError');
    expect(mcp).toContain('toolCount');
  });

  it('env/headers 值旁的敏感值提示：$$环境变量名（发起连接时才解析）', () => {
    expect(mcp).toContain('敏感值建议填 $$环境变量名（发起连接时才解析）');
  });

  it('测试连接两处（表单内完整条目 / 列表行 { name }）+ 结果内联文案', () => {
    expect(mcp).toContain('测试连接');
    expect(mcp).toContain('✓ 连接成功');
    expect(mcp).toContain('✗');
    expect(mcp).toContain('testMcpServer');
  });

  it('MU6 红线：v-for 一律挂 <template> 包裹兄弟节点，不直接挂元素', () => {
    expect(mcp).toContain('<template v-for');
    expect(mcp).not.toMatch(/<(div|span|button|li|input|label)\s+v-for/);
  });

  it('列表行操作：enabled 开关 / 编辑 / 删除二次确认', () => {
    expect(mcp).toContain('toggleMcpServer');
    expect(mcp).toContain('confirmRemove');
    expect(mcp).toContain('确认删除');
    expect(mcp).toContain('removeMcpServer');
  });
});

describe('D6 chat store：MCP state 与五 action', () => {
  it('state.mcpServers 含 servers / statuses / configError', () => {
    expect(chat).toContain('mcpServers');
    expect(chat).toContain('statuses');
    expect(chat).toContain('configError');
  });

  it('五 action 对应五个 RPC 名', () => {
    for (const a of ['fetchMcpServers', 'upsertMcpServer', 'removeMcpServer', 'toggleMcpServer', 'testMcpServer']) {
      expect(chat).toContain(a);
    }
    for (const r of ['mcp.servers.list', 'mcp.servers.upsert', 'mcp.servers.remove', 'mcp.servers.toggle', 'mcp.servers.test']) {
      expect(chat).toContain(`'${r}'`);
    }
  });
});
