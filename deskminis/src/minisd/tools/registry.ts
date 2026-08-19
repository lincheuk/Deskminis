import type { ToolContext, ToolExecutor, ToolOutcome } from './types';
import type { AgentToolDefinition } from '../../shared/types';

export class ToolRegistry {
  private tools = new Map<string, ToolExecutor>();

  register(t: ToolExecutor): void { this.tools.set(t.definition.name, t); }

  /** D5 MCP 动态工具生命周期：server 崩溃/空闲驱逐/list_changed 重列时摘除其工具。
   *  工具表每 run 现取（loop definitions()），unregister 后下一轮请求模型即看不到。 */
  unregister(name: string): void { this.tools.delete(name); }

  definitions(): AgentToolDefinition[] { return [...this.tools.values()].map(t => t.definition); }

  /** preflight 用发布给模型的同一 schema（无漂移）；一切失败都以错误 outcome 返回喂给模型。 */
  async execute(name: string, inputJson: string, ctx: ToolContext): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) return { output: `未知工具: ${name}`, success: false };
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(inputJson || '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { output: `工具参数必须是 JSON 对象，实际收到: ${inputJson}`, success: false };
      }
      input = parsed as Record<string, unknown>;
    } catch (e) {
      return { output: `工具参数不是合法 JSON: ${String(e)}`, success: false };
    }
    for (const req of tool.definition.required) {
      if (input[req] === undefined || input[req] === null) return { output: `缺少必填参数: ${req}`, success: false };
    }
    try { return await tool.execute(input, ctx); }
    catch (e) { return { output: `工具执行异常: ${String(e)}`, success: false }; }
  }
}
