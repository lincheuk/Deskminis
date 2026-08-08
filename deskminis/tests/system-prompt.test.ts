import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  createStableCache,
  STABLE_IDENTITY,
  BRIDGE_SECTION_FULL,
  BRIDGE_SECTION_MINIMAL,
  SYSTEM_PROMPT,
  type PromptConfig,
} from '../src/minisd/agent/system-prompt';
import { runAgentLoop, type LoopEvent } from '../src/minisd/agent/loop';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { ProviderError, type AgentProvider, type StreamRequest } from '../src/minisd/providers/types';
import type { AgentStreamEvent } from '../src/shared/types';
import type { ToolContext, ToolExecutor } from '../src/minisd/tools/types';
import { MinisPaths } from '../src/minisd/paths';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ===== buildSystemPrompt：桥段落条件注入 =====

describe('buildSystemPrompt 桥段落条件注入', () => {
  it('未授权桥会话 + 配置 full → 精简桥段落（含 --help，不含六工具名）', () => {
    const r = buildSystemPrompt({ sessionId: 's1', modelId: 'gpt-5', bridgeGranted: false, config: { bridgeSection: 'full' }, skillsBlock: '', memoryBlock: '' });
    expect(r).toContain('MINIS_BRIDGE_CLI');
    expect(r).toContain('--help');
    expect(r).not.toContain('windows-notify');
  });

  it('授权过桥会话 + 配置 full → 完整桥段落（六工具名）', () => {
    const r = buildSystemPrompt({ sessionId: 's1', modelId: 'gpt-5', bridgeGranted: true, config: { bridgeSection: 'full' }, skillsBlock: '', memoryBlock: '' });
    expect(r).toContain('windows-notify');
    expect(r).toContain('windows-clipboard');
    expect(r).toContain('windows-screenshot');
  });

  it('配置 off → 不注入桥段落', () => {
    const r = buildSystemPrompt({ sessionId: 's1', modelId: 'gpt-5', bridgeGranted: true, config: { bridgeSection: 'off' }, skillsBlock: '', memoryBlock: '' });
    expect(r).not.toContain('MINIS_BRIDGE');
  });

  it('配置 minimal → 始终精简（即使已授权）', () => {
    const r = buildSystemPrompt({ sessionId: 's1', modelId: 'gpt-5', bridgeGranted: true, config: { bridgeSection: 'minimal' }, skillsBlock: '', memoryBlock: '' });
    expect(r).toContain('MINIS_BRIDGE_CLI');
    expect(r).toContain('--help');
    expect(r).not.toContain('windows-notify');
  });

  it('无配置时默认 full + 未授权 → 精简桥段落', () => {
    const r = buildSystemPrompt({ sessionId: 's1', modelId: 'gpt-5', bridgeGranted: false, skillsBlock: '', memoryBlock: '' });
    expect(r).toContain('MINIS_BRIDGE_CLI');
    expect(r).not.toContain('windows-notify');
  });

  it('skillsBlock 拼接在 stable 段之后', () => {
    const r = buildSystemPrompt({ sessionId: 's1', modelId: 'gpt-5', bridgeGranted: false, skillsBlock: '<skills>test</skills>', memoryBlock: '' });
    expect(r).toContain('<skills>test</skills>');
    expect(r.indexOf('DeskMinis')).toBeLessThan(r.indexOf('<skills>'));
  });

  it('memoryBlock 拼接在最外层（base + skills 后）', () => {
    const r = buildSystemPrompt({ sessionId: 's1', modelId: 'gpt-5', bridgeGranted: false, skillsBlock: '<skills>x</skills>', memoryBlock: 'SOUL内容\n\n__BASE__' });
    expect(r).toContain('SOUL内容');
    expect(r).toContain('DeskMinis');
    expect(r).toContain('<skills>x</skills>');
    // SOUL 在 base 之前
    expect(r.indexOf('SOUL内容')).toBeLessThan(r.indexOf('DeskMinis'));
  });
});

// ===== token 估算 =====

describe('token 估算', () => {
  it('未用桥会话 stable 段 < 350 字符（精简桥提示）', () => {
    const r = buildSystemPrompt({ sessionId: 's1', modelId: 'gpt-5', bridgeGranted: false, config: { bridgeSection: 'full' }, skillsBlock: '', memoryBlock: '' });
    expect(r.length).toBeLessThan(350);
  });

  it('授权桥会话 stable 段含完整桥段落（字符数更高但仍合理）', () => {
    const r = buildSystemPrompt({ sessionId: 's1', modelId: 'gpt-5', bridgeGranted: true, config: { bridgeSection: 'full' }, skillsBlock: '', memoryBlock: '' });
    expect(r.length).toBeGreaterThan(300);
    expect(r).toContain('windows-notify');
  });
});

// ===== SYSTEM_PROMPT 向后兼容 =====

describe('SYSTEM_PROMPT 向后兼容', () => {
  it('SYSTEM_PROMPT = STABLE_IDENTITY + BRIDGE_SECTION_FULL（等价于改前）', () => {
    expect(SYSTEM_PROMPT).toBe(STABLE_IDENTITY + BRIDGE_SECTION_FULL);
    expect(SYSTEM_PROMPT).toContain('DeskMinis');
    expect(SYSTEM_PROMPT).toContain('windows-notify');
  });
});

// ===== stable 段缓存 =====

describe('createStableCache', () => {
  it('同 sessionId+modelId+bridgeGranted 两次调用返回同实例（缓存命中）', () => {
    const c = createStableCache();
    const a = c.get('s1', { bridgeGranted: false, modelId: 'gpt-5', config: { bridgeSection: 'full' } });
    const b = c.get('s1', { bridgeGranted: false, modelId: 'gpt-5', config: { bridgeSection: 'full' } });
    expect(a).toBe(b);
  });

  it('bridgeGranted 变化 → 重建（不同实例）', () => {
    const c = createStableCache();
    const a = c.get('s1', { bridgeGranted: false, modelId: 'gpt-5', config: { bridgeSection: 'full' } });
    const b = c.get('s1', { bridgeGranted: true, modelId: 'gpt-5', config: { bridgeSection: 'full' } });
    expect(a).not.toBe(b);
    expect(b).toContain('windows-notify');
  });

  it('modelId 变化 → 缓存键不同（Task 3 纪律块接入后内容也会不同）', () => {
    // Task 2 阶段 stable 段不含纪律块，不同 modelId 产出相同内容（string 同值必 toBe 相等）。
    // modelId 在缓存键中是为 Task 3 纪律块预留——届时不同 modelId → 不同纪律块 → 不同内容。
    const c = createStableCache();
    const a = c.get('s1', { bridgeGranted: false, modelId: 'gpt-5', config: { bridgeSection: 'full' } });
    const b = c.get('s1', { bridgeGranted: false, modelId: 'claude-opus-4', config: { bridgeSection: 'full' } });
    // Task 2 阶段：内容相同（无纪律块），但缓存键不同（modelId 在键中）——Task 3 接入后 a!==b
    expect(a).toBe(b); // Task 2: 同内容（无纪律块）
  });

  it('invalidate(sessionId) 清该会话所有缓存项 → 下次 get 重建', () => {
    const c = createStableCache();
    const a = c.get('s1', { bridgeGranted: false, modelId: 'gpt-5', config: { bridgeSection: 'full' } });
    c.invalidate('s1');
    const b = c.get('s1', { bridgeGranted: true, modelId: 'gpt-5', config: { bridgeSection: 'full' } });
    expect(a).not.toBe(b);
    expect(b).toContain('windows-notify');
  });

  it('invalidate 只清指定会话，不影响其他会话缓存', () => {
    const c = createStableCache();
    const a = c.get('s1', { bridgeGranted: false, modelId: 'gpt-5', config: { bridgeSection: 'full' } });
    c.invalidate('s2');
    const b = c.get('s1', { bridgeGranted: false, modelId: 'gpt-5', config: { bridgeSection: 'full' } });
    expect(a).toBe(b); // s1 未被清，缓存命中
  });

  // M4.6 Task 5：容量上限 64（插入序淘汰，止血无界增长）
  it('容量上限：插入 65 条后 size 保持 64，最旧被淘汰（FIFO）', () => {
    const c = createStableCache();
    // 用不同 modelId 构造 65 个不同缓存键
    for (let i = 0; i < 65; i++) {
      c.get('s1', { bridgeGranted: false, modelId: `m-${i}`, config: { bridgeSection: 'full' } });
    }
    // 第 65 条插入后应触发淘汰，size 保持 64（当前实现无上限 → 65，红灯）
    expect(c._cache.size).toBe(64);
  });

  it('容量上限：被淘汰最旧键不在缓存中（重建后命中，size 不超上限）', () => {
    const c = createStableCache();
    for (let i = 0; i < 65; i++) {
      c.get('s1', { bridgeGranted: false, modelId: `m-${i}`, config: { bridgeSection: 'full' } });
    }
    // m-0 被淘汰 → 不在缓存中
    expect(c._cache.has(`s1\u0000m-0\u0000false\u0000full`)).toBe(false);
    // 重新 get 会重建并命中，size 仍不超上限
    const rebuilt = c.get('s1', { bridgeGranted: false, modelId: 'm-0', config: { bridgeSection: 'full' } });
    expect(typeof rebuilt).toBe('string');
    expect(rebuilt.length).toBeGreaterThan(0);
    expect(c._cache.size).toBe(64);
  });

  it('容量上限：同键重复 get 命中不重复插入（size 不涨）', () => {
    const c = createStableCache();
    for (let i = 0; i < 40; i++) {
      c.get('s1', { bridgeGranted: false, modelId: `m-${i}`, config: { bridgeSection: 'full' } });
    }
    // 重复 get 已存在的键 20 次
    for (let j = 0; j < 20; j++) {
      c.get('s1', { bridgeGranted: false, modelId: 'm-5', config: { bridgeSection: 'full' } });
    }
    expect(c._cache.size).toBe(40); // 命中不涨
  });
});

// ===== RunOptions.systemPrompt 工厂函数接口（决策点 3 方案 a）=====

/** 脚本化假 Provider：支持自定义 modelId + 降级脚本。 */
class ScriptedProvider2 implements AgentProvider {
  readonly name: string;
  readonly modelId: string;
  calls = 0;
  seen: StreamRequest[] = [];
  constructor(opts: { modelId: string; scripts: (AgentStreamEvent[] | ProviderError)[]; name?: string }) {
    this.modelId = opts.modelId;
    this.name = opts.name ?? 'scripted';
    this.scripts = opts.scripts;
  }
  private scripts: (AgentStreamEvent[] | ProviderError)[];
  async *streamAgentMessage(req: StreamRequest): AsyncIterable<AgentStreamEvent> {
    const n = this.calls++;
    this.seen.push(req);
    const s = this.scripts[n];
    if (s instanceof ProviderError) throw s;
    for (const e of s) yield e;
  }
}

const echoTool: ToolExecutor = {
  definition: { name: 'echo', description: 'echo', parameters: { text: { type: 'string', description: 't' }, tool_title: { type: 'string', description: 't' } }, required: ['text', 'tool_title'] },
  async execute(input) { return { output: `echo:${String(input.text)}`, success: true }; },
};

function mkCtx(): { store: ChatStore; tools: ToolRegistry; toolContext: ToolContext; sessionId: string } {
  const store = new ChatStore(openDb(':memory:'));
  const s = store.createSession();
  const tools = new ToolRegistry(); tools.register(echoTool);
  const root = mkdtempSync(join(tmpdir(), 'dm-sp-'));
  const paths = new MinisPaths(root); paths.ensureSessionDirs(s.id);
  const toolContext: ToolContext = { sessionId: s.id, paths, permissions: { async check() { return 'allow'; }, hasBridgeGrant: () => false } };
  return { store, tools, toolContext, sessionId: s.id };
}

async function collect(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const out: LoopEvent[] = []; for await (const e of gen) out.push(e); return out;
}

describe('RunOptions.systemPrompt 工厂函数接口', () => {
  it('传字符串（非工厂）仍正常工作——既有调用方兼容', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'hi' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider2({ modelId: 'gpt-5', scripts: [[ { kind: 'textDelta', text: 'ok' }, { kind: 'done', stopReason: 'endTurn' } ]] });
    const events = await collect(runAgentLoop(store, {
      sessionId, provider, tools, toolContext,
      systemPrompt: 'plain string prompt',
      retryDelaysMs: [0],
    }));
    expect(events.some(e => e.kind === 'turnEnd')).toBe(true);
    expect(provider.seen[0].systemPrompt).toBe('plain string prompt');
  });

  it('传工厂函数：每轮用当前 activeSlot.provider.modelId 调工厂', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'hi' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const called: string[] = [];
    const factory = (ctx: { modelId: string; sessionId: string }) => {
      called.push(ctx.modelId);
      return `prompt for ${ctx.modelId}`;
    };
    const provider = new ScriptedProvider2({ modelId: 'gpt-5', scripts: [[ { kind: 'textDelta', text: 'ok' }, { kind: 'done', stopReason: 'endTurn' } ]] });
    await collect(runAgentLoop(store, {
      sessionId, provider, tools, toolContext,
      systemPrompt: factory,
      retryDelaysMs: [0],
    }));
    expect(called.length).toBeGreaterThanOrEqual(1);
    expect(called[0]).toBe('gpt-5');
    expect(provider.seen[0].systemPrompt).toBe('prompt for gpt-5');
  });

  it('降级切换后工厂用新 modelId 调（纪律块跟着变）', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: 'hi' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const called: string[] = [];
    const factory = (ctx: { modelId: string; sessionId: string }) => {
      called.push(ctx.modelId);
      return `prompt for ${ctx.modelId}`;
    };
    const mainProvider = new ScriptedProvider2({ modelId: 'gpt-5', scripts: [ new ProviderError('down', { retryable: false, fallbackable: true }) ] });
    const backupProvider = new ScriptedProvider2({ modelId: 'claude-opus-4', scripts: [[ { kind: 'textDelta', text: 'ok' }, { kind: 'done', stopReason: 'endTurn' } ]] });
    await collect(runAgentLoop(store, {
      sessionId, provider: mainProvider, tools, toolContext,
      systemPrompt: factory,
      retryDelaysMs: [0],
      fallbackChain: [{ provider: backupProvider, label: 'backup' }],
    }));
    expect(called).toContain('gpt-5');
    expect(called).toContain('claude-opus-4');
    // 降级后 backup 收到的 systemPrompt 用新 modelId
    expect(backupProvider.seen[0].systemPrompt).toBe('prompt for claude-opus-4');
  });
});
