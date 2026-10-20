import type { ToolContext, ToolExecutor, ToolOutcome } from './types';
import type { AgentToolDefinition } from '../../shared/types';

/** 已过预检的一次调用（F04）：执行器对象与解析好的入参。调度器在入队那一刻拿到它，规划（算锁）与执行落在同一个对象上。 */
export interface PreparedCall { tool: ToolExecutor; input: Record<string, unknown> }

export class ToolRegistry {
  private tools = new Map<string, ToolExecutor>();

  register(t: ToolExecutor): void { this.tools.set(t.definition.name, t); }

  /** D5 MCP 动态工具生命周期：server 崩溃/空闲驱逐/list_changed 重列时摘除其工具。
   *  工具表每 run 现取（loop definitions()），unregister 后下一轮请求模型即看不到。 */
  unregister(name: string): void { this.tools.delete(name); }

  definitions(): AgentToolDefinition[] { return [...this.tools.values()].map(t => t.definition); }

  /** F04：只读查表。调度器拿到锁之后用它复核「排队时规划的那个执行器是否还是表里这一个」——
   *  注册表是全局的，排队到执行之间隔着等锁，MCP 工具可能被摘（forget / 空闲驱逐 / 崩溃）或被同名重新注册。 */
  get(name: string): ToolExecutor | undefined { return this.tools.get(name); }

  /** 预检（F04 从 execute 拆出）：查表、解析 JSON、必填检查。同步，不抛。
   *  preflight 用发布给模型的同一 schema（无漂移）；一切失败都以错误 outcome 返回喂给模型。 */
  prepare(name: string, inputJson: string): PreparedCall | { error: ToolOutcome } {
    const tool = this.tools.get(name);
    if (!tool) return { error: { output: `未知工具: ${name}`, success: false } };
    let input: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(inputJson || '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { error: { output: `工具参数必须是 JSON 对象，实际收到: ${inputJson}`, success: false } };
      }
      input = parsed as Record<string, unknown>;
    } catch (e) {
      return { error: { output: `工具参数不是合法 JSON: ${String(e)}`, success: false } };
    }
    for (const req of tool.definition.required) {
      if (input[req] === undefined || input[req] === null) return { error: { output: `缺少必填参数: ${req}`, success: false } };
    }
    return { tool, input };
  }

  /** 执行已过预检的调用（F04 从 execute 拆出）：异常兜成失败 outcome，从不抛。 */
  async run(p: PreparedCall, ctx: ToolContext): Promise<ToolOutcome> {
    try { return await p.tool.execute(p.input, ctx); }
    catch (e) { return { output: `工具执行异常: ${String(e)}`, success: false }; }
  }

  /** 预检 + 执行，签名与行为同拆分之前。循环不走这里（经调度器的 prepare / run），留给直接调工具的调用方与单测。 */
  async execute(name: string, inputJson: string, ctx: ToolContext): Promise<ToolOutcome> {
    const p = this.prepare(name, inputJson);
    return 'error' in p ? p.error : this.run(p, ctx);
  }
}
