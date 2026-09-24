import { describe, it, expect } from 'vitest';
import { pruneOldToolResults } from '../src/minisd/agent/prune';
import type { AgentMessage } from '../src/shared/types';

/**
 * W2a-5（设计稿 §4 W2a-5 · 附录 engine.md W2a-honest）：修剪桩不再指向 offloads。
 * 能被修剪的结果（> 2000 字）要么从没超过 20000 字卸载阈值、根本没落盘，要么是读回来的卸载内容；
 * 真正卸载过的结果落库的是几百字的卸载桩，达不到修剪门槛。旧桩说「完整内容通常在 /var/minis/offloads/」，
 * 模型照着去找只会扑空。
 */
function tr(output: string, toolUseId: string): AgentMessage {
  return { role: 'user', parts: [{ type: 'toolResult', value: { toolUseId, output, success: true, status: 'success' } }] };
}

describe('修剪桩如实', () => {
  it('⑥ 桩不提 offloads，说明「重新调用」取回，保留「已修剪」与「原 N 字符」', () => {
    const history: AgentMessage[] = [tr('B'.repeat(3000), 'T_old'), ...Array.from({ length: 12 }, (_, i) => tr('short', `T${i}`))];
    const { pruned, history: out } = pruneOldToolResults(history);
    expect(pruned).toBe(1);
    const stub = (out[0].parts[0] as { value: { output: string } }).value.output;
    expect(stub).not.toMatch(/offloads/);
    expect(stub).toContain('重新调用');
    expect(stub).toContain('已修剪');
    expect(stub).toContain('原 3000 字符');
  });
});
