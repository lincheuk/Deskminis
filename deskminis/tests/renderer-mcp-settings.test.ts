/** D6 渲染端守卫：McpSettings.vue 设置页 + SettingsModal 'mcp' section 接入 + chat store 五 action。
 *  .vue 不在 typecheck 覆盖内——读源文本锚点断言即源码守卫
 *  （MU6 血案：v-for 挂带 scoped 类名元素引发 renderList 抛错；MU5：scoped 类名撞车）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const modal = fs.readFileSync(path.join(root, 'src/renderer/src/ui/StageSettings.vue'), 'utf8');
// 新组件尚不存在时给空串：让断言失败（红）而不是文件加载崩掉整组用例
const mcpPath = path.join(root, 'src/renderer/src/ui/settings/SecMcp.vue');
const mcp = fs.existsSync(mcpPath) ? fs.readFileSync(mcpPath, 'utf8') : '';
const chat = fs.readFileSync(path.join(root, 'src/renderer/src/stores/chat.ts'), 'utf8');

describe('D6 SettingsModal：mcp section 行级接入', () => {
  it("NAV 增 'mcp'（标题「MCP」）且排在技能之后；import 与 v-else-if 接线，其余 section 不动", () => {
    // T6e-3 重指：设置从模态（SettingsModal + section）换成舞台（StageSettings + sec），
    // 分节各自独立成 ui/settings/Sec*.vue。锚**这一节存在、接得进去、次序对**三件事。
    expect(modal).toMatch(/import SecMcp from '\.\/settings\/SecMcp\.vue'/);
    expect(modal).toContain("{ k: 'mcp', icon: 'puzzle', label: 'MCP' }");
    expect(modal).toContain(`<SecMcp v-else-if="sec === 'mcp'" />`);
    expect(modal.indexOf("k: 'skills'")).toBeLessThan(modal.indexOf("k: 'mcp'"));
    // 助手不再是设置页的一节（换壳后独立成舞台视图），所以这里只钉 mcp 相对技能的次序。
    expect(modal).toMatch(/type Sec =[^;]*'mcp'/);
  });
});

describe('D6 McpSettings.vue 守卫', () => {
  it('configError 页顶警示条：固定文案，不回显解析原文', () => {
    expect(mcp).toContain('configError');
    expect(mcp).toContain('servers.json 解析失败，已按空配置加载——请检查文件语法');
  });

  it('三种连接状态都有去处 + lastError 可见 + 显示工具数', () => {
    // 新树把彩点换成了带文字的标签（「N 个工具」/「连不上」/「空闲」）——
    // 锚的是**三态都说得出话**，不是「必须是个点」。
    expect(mcp).toMatch(/statusOf\(/);
    expect(mcp).toContain("=== 'connected'");
    expect(mcp).toContain("=== 'error'");
    expect(mcp).toMatch(/空闲/);                 // 第三态（idle）的人话
    expect(mcp).toMatch(/lastError/);            // 连不上的原因要能看到
    expect(mcp).toMatch(/toolCount/);            // 连上了要说清连上了什么
  });

  it('env/headers 值旁的敏感值提示：$$环境变量名（发起连接时才解析）', () => {
    // 这条断言退场：它锚的是 env / headers 编辑器旁边的提示，而**新页面没有 env/headers 编辑器**
    // （要配环境变量只能手改 servers.json）。提示没了不是文案丢了，是它注解的那个控件不在了。
    // 「MCP env/headers 编辑」已记入候选池。
  });

  it('试连接可用，且成功/失败都给内联结论', () => {
    // 旧页面「表单内 + 列表行」两处都能试连；新页面只保留表单内那处。
    // 断言收窄到**至少有一条可用的试连路径且结论内联显示**，
    // 「列表行逐台试连」这条已记入候选池，不在这里硬钉。
    expect(mcp).toContain('testMcpServer');
    expect(mcp).toMatch(/试连接|测试连接/);
    expect(mcp).toMatch(/testResult/);
    expect(mcp).toMatch(/连上了/);      // 成功文案
    expect(mcp).toMatch(/连不上/);      // 失败文案，且带原因
  });

  it('列表行是单个元素，v-for 的作用域覆盖整行', () => {
    // 原断言是「v-for 一律挂 <template>」——那锚的是**旧结构**：旧页面把一行拆成
    // 行本体与行内操作区两个**兄弟节点**，v-for 挂在其中一个上时另一个拿不到 s，
    // 整个列表渲染直接抛错。新 SecMcp 把开关 / 信息 / 状态 / 按钮全包进同一个 .mrow，
    // 单元素上挂 v-for 是对的，继续禁止 <div v-for> 反而会把正确写法判红。
    // 保留的是**意图**：迭代变量在整行范围内都可见。
    const row = mcp.match(/<div v-for="s in list"[\s\S]*?\n    <\/div>/)?.[0] ?? '';
    expect(row, '找不到列表行').not.toBe('');
    expect(row).toContain('s.name');       // 行内确实用得到迭代变量
    expect(row).toMatch(/f-switch|f-btn/); // 操作控件也在同一个作用域里
  });

  it('列表行操作：enabled 开关 / 编辑 / 删除二次确认', () => {
    expect(mcp).toContain('toggleMcpServer');
    expect(mcp).toMatch(/confirming/);  // 二次确认改名不改事
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
