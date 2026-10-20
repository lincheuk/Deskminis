import { afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { MinisPaths } from '../src/minisd/paths';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { ToolScheduler } from '../src/minisd/tools/scheduler';
import { runAgentLoop, type RunOptions } from '../src/minisd/agent/loop';
import type { ToolContext, ToolExecutor } from '../src/minisd/tools/types';
import type { AgentProvider, StreamRequest } from '../src/minisd/providers/types';
import type { AgentMessage, AgentStreamEvent, ContentPart } from '../src/shared/types';

const closes: (() => void)[] = [];
afterEach(() => { for (const close of closes.splice(0)) close(); });
export const answer: AgentStreamEvent[] = [{ kind: 'textDelta', text: 'done' }, { kind: 'done', stopReason: 'endTurn' }];
export function call(name = 'test_tool', input: Record<string, unknown> = { value: 'x' }, id = 'T'): AgentStreamEvent[] {
  return [{ kind: 'toolCallComplete', name, input: JSON.stringify(input), toolUseId: id }, { kind: 'done', stopReason: 'toolUse' }];
}
export const testTool = (execute: ToolExecutor['execute'] = async () => ({ success: false, output: 'failed < & >' })): ToolExecutor => ({
  definition: { name: 'test_tool', description: 'synthetic test tool', parameters: {}, required: [] }, execute,
});
export class Capture implements AgentProvider {
  readonly name = 'w1w2-script'; readonly modelId = 'unlisted-model';
  readonly requests: StreamRequest[] = [];
  constructor(private script: (n: number, req: StreamRequest) => AgentStreamEvent[] = () => answer) {}
  async *streamAgentMessage(req: StreamRequest): AsyncIterable<AgentStreamEvent> {
    const n = this.requests.push(structuredClone(req));
    if (n > 30) throw Error('unbounded test requests');
    yield* this.script(n, req);
  }
}
export function fixture(tool: ToolExecutor = testTool()) {
  const db = openDb(':memory:'); closes.push(() => db.close());
  const store = new ChatStore(db); const sessionId = store.createSession().id;
  const root = mkdtempSync(join(tmpdir(), 'dm-w1w2-'));
  const paths = new MinisPaths(root); paths.ensureSessionDirs(sessionId);
  const tools = new ToolRegistry(); tools.register(tool);
  const scheduler = new ToolScheduler();
  const toolContext: ToolContext = { sessionId, paths, permissions: { async check() { return 'allow'; }, hasBridgeGrant: () => false } };
  let at = store.nowEpoch() - 60;
  const add = (role: 'user' | 'assistant', parts: ContentPart[]) => store.appendMessage({
    id: store.newId(), sessionId, role, parts, createdAt: (at += 0.01), streamInterruptCount: 0,
  });
  add('user', [{ type: 'text', value: 'user < & > untouched' }]);
  const history = () => store.listMessages(sessionId);
  const outputs = () => history().flatMap(m => m.parts.filter(p => p.type === 'toolResult').map(p => (p.value as { output: string }).output));
  const seed = (output: string, id = 'old', thoughtSignature?: string) => {
    add('assistant', [{ type: 'toolUse', value: { toolUseId: id, name: 'test_tool', input: '{"tool_title":"old","value":"<&>"}', ...(thoughtSignature ? { thoughtSignature } : {}) } }]);
    add('user', [{ type: 'toolResult', value: { toolUseId: id, output, success: true, status: 'success' } }]);
  };
  const run = async (provider: AgentProvider, extra: Partial<RunOptions> = {}) => {
    const events = [];
    for await (const e of runAgentLoop(store, { sessionId, provider, tools, toolContext, scheduler, systemPrompt: 'sys', retryDelaysMs: [], ...extra })) events.push(e);
    return events;
  };
  return { db, store, sessionId, root, paths, tools, scheduler, toolContext, add, seed, history, outputs, run };
}
export function resultOutputs(messages: AgentMessage[]): string[] {
  return messages.flatMap(m => m.parts.filter(p => p.type === 'toolResult').map(p => (p.value as { output: string }).output));
}
export function text(messages: AgentMessage[]): string {
  return messages.flatMap(m => m.parts.filter(p => p.type === 'text').map(p => String(p.value))).join('\n');
}
export const hints = (req: StreamRequest): string[] => req.messages.flatMap(m => m.parts.filter(p => p.type === 'text' && String(p.value).startsWith('[系统提醒：你已经')).map(p => String(p.value)));
export const expectedWrap = (raw: string): string => '<tool-output>\n' + raw.split('</tool-output>').join('</tool-\u200Boutput>') + '\n</tool-output>';
