import { describe, it, expect } from 'vitest';
import { runAgentLoop, type LoopEvent } from '../src/minisd/agent/loop';
import { OffloadEngine, READBACK_MAX } from '../src/minisd/agent/offload';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { fileReadTool } from '../src/minisd/tools/files';
import { MinisPaths } from '../src/minisd/paths';
import type { AgentProvider, StreamRequest } from '../src/minisd/providers/types';
import type { AgentStreamEvent } from '../src/shared/types';
import type { PermissionRequest, ToolContext } from '../src/minisd/tools/types';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * W2a-5（设计稿 §4 W2a-5 · 附录 engine.md W2a-honest）：读回卸载文件不再被二次卸载。
 * 旧行为：file_read 读回 25000 字的卸载文件，结果又超 20000 阈值，被写成一个新的卸载文件、
 * 落库的又是一个桩——模型照着桩去读，永远只拿到下一个桩，卸载的内容实际上取不回来。
 */

/** 按调用次数吐脚本事件的假 Provider。 */
class ScriptedProvider implements AgentProvider {
  readonly name = 'scripted'; readonly modelId = 'fake';
  calls = 0;
  constructor(private scripts: AgentStreamEvent[][]) {}
  async *streamAgentMessage(_req: StreamRequest): AsyncIterable<AgentStreamEvent> {
    const s = this.scripts[this.calls++] ?? [{ kind: 'done', stopReason: 'endTurn' } as AgentStreamEvent];
    for (const e of s) yield e;
  }
}

/** 真实 file_read + 与工具共用同一 MinisPaths 的卸载引擎（生产装配 index.ts 就是同一个 paths）。
 *  权限网关记下每次询问：读当前会话自己的 offloads 桶必须零询问。 */
function mkCtx() {
  const store = new ChatStore(openDb(':memory:'));
  const s = store.createSession();
  const tools = new ToolRegistry(); tools.register(fileReadTool);
  const root = mkdtempSync(join(tmpdir(), 'dm-readback-'));
  const paths = new MinisPaths(root); paths.ensureSessionDirs(s.id);
  const asked: PermissionRequest[] = [];
  const toolContext: ToolContext = {
    sessionId: s.id, paths,
    permissions: { async check(req) { asked.push(req); return 'allow'; }, hasBridgeGrant: () => false },
  };
  const offloadEngine = new OffloadEngine(paths);
  store.appendMessage({ id: 'U1', sessionId: s.id, role: 'user', parts: [{ type: 'text', value: '读回来看看' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
  return { store, tools, toolContext, sessionId: s.id, paths, offloadEngine, asked };
}

async function collect(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const out: LoopEvent[] = []; for await (const e of gen) out.push(e); return out;
}

/** 让模型发一次 file_read(path)，再收尾。 */
function readThenEnd(toolUseId: string, path: string): ScriptedProvider {
  return new ScriptedProvider([
    [
      { kind: 'toolCallComplete', toolUseId, name: 'file_read', input: JSON.stringify({ path, tool_title: '读回卸载内容' }) },
      { kind: 'done', stopReason: 'toolUse' },
    ],
    [{ kind: 'textDelta', text: '看完了' }, { kind: 'done', stopReason: 'endTurn' }],
  ]);
}

/** 库里这次工具调用落下的 toolResult.output。 */
function storedOutput(store: ChatStore, sessionId: string, toolUseId: string): string {
  for (const m of store.listMessages(sessionId)) {
    for (const p of m.parts) {
      if (p.type !== 'toolResult') continue;
      const v = p.value as { toolUseId: string; output: string };
      if (v.toolUseId === toolUseId) return v.output;
    }
  }
  throw new Error(`库里没有 ${toolUseId} 的 toolResult`);
}

describe('卸载读回（loop 级，真实 file_read）', () => {
  it('① guest 路径读回 25000 字的卸载文件：落库原文，不再生成新卸载文件、不发 offloaded 事件', async () => {
    const { store, tools, toolContext, sessionId, paths, offloadEngine, asked } = mkCtx();
    const bucket = paths.sessionBucket(sessionId, 'offloads');
    writeFileSync(join(bucket, 'T1.txt'), 'X'.repeat(25_000), 'utf8');
    const provider = readThenEnd('R1', '/var/minis/offloads/T1.txt');
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', offloadEngine }));
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    expect(storedOutput(store, sessionId, 'R1')).toBe('X'.repeat(25_000));
    expect(events.filter(e => e.kind === 'offloaded')).toEqual([]);
    expect(readdirSync(bucket).filter(f => f.includes('R1'))).toEqual([]);
    // 读当前会话自己的 offloads 桶不弹卡（数据根内免审；W1b 收窄数据根时这条必须仍成立）
    expect(asked).toEqual([]);
  });

  it('③ 读回 60000 字：落库截到前 50000 字并如实注明全长、分段读法与宿主位置；toolEnd 仍广播全文', async () => {
    const { store, tools, toolContext, sessionId, paths, offloadEngine } = mkCtx();
    const bucket = paths.sessionBucket(sessionId, 'offloads');
    const abs = join(bucket, 'T1.txt');
    writeFileSync(abs, 'X'.repeat(60_000), 'utf8');
    const provider = readThenEnd('R1', '/var/minis/offloads/T1.txt');
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', offloadEngine }));
    const out = storedOutput(store, sessionId, 'R1');
    expect(out.startsWith('X'.repeat(50_000))).toBe(true);
    expect(out.slice(50_000).startsWith('X')).toBe(false);
    expect(out).toContain('已截断');
    expect(out).toContain('共 60000 字符');
    expect(out).toContain('每段不超过 20000 字符');
    expect(out).toContain(abs);
    expect(out.length).toBeLessThan(50_600);
    expect(events.filter(e => e.kind === 'offloaded')).toEqual([]);
    expect(readdirSync(bucket).filter(f => f.includes('R1'))).toEqual([]);
    const toolEnd = events.find(e => e.kind === 'toolEnd') as Extract<LoopEvent, { kind: 'toolEnd' }>;
    expect(toolEnd.output.length).toBe(60_000);
  });

  it('④ 回归：file_read 读工作区里的 25000 字大文件，照旧卸载并发 offloaded 事件', async () => {
    const { store, tools, toolContext, sessionId, paths, offloadEngine } = mkCtx();
    writeFileSync(join(paths.workspaceOf(sessionId), 'big.txt'), 'W'.repeat(25_000), 'utf8');
    const provider = readThenEnd('R1', 'big.txt');
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', offloadEngine }));
    expect(events.filter(e => e.kind === 'offloaded')).toEqual([{ kind: 'offloaded', toolUseId: 'R1', relativePath: 'offloads/R1.txt' }]);
    expect(storedOutput(store, sessionId, 'R1')).toContain('[CONTEXT OFFLOADED: offloads/R1.txt (25000 字符)]');
  });

  it('读回失败（文件不存在）：落库的是工具的错误结果', async () => {
    const { store, tools, toolContext, sessionId, offloadEngine } = mkCtx();
    const provider = readThenEnd('R1', '/var/minis/offloads/NOPE.txt');
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', offloadEngine }));
    const toolEnd = events.find(e => e.kind === 'toolEnd') as Extract<LoopEvent, { kind: 'toolEnd' }>;
    expect(toolEnd.success).toBe(false);
    expect(storedOutput(store, sessionId, 'R1')).toBe(toolEnd.output);
  });

  it('失败的 file_read 不算读回：输出是错误信息不是文件内容，超阈值照旧卸载', async () => {
    const { store, toolContext, sessionId, offloadEngine } = mkCtx();
    // 真 file_read 的失败输出都很短，构造不出超阈值的失败；用同名桩工具直接钉住 loop 里的 success 前提
    const tools = new ToolRegistry();
    tools.register({ definition: fileReadTool.definition, async execute() { return { output: 'E'.repeat(25_000), success: false }; } });
    const provider = readThenEnd('R1', '/var/minis/offloads/T1.txt');
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', offloadEngine }));
    expect(events.filter(e => e.kind === 'offloaded')).toHaveLength(1);
    expect(storedOutput(store, sessionId, 'R1')).toContain('[CONTEXT OFFLOADED: offloads/R1.txt');
  });
});

describe('OffloadEngine.offload 桩的第三行按长度如实', () => {
  it('⑤ 超过 READBACK_MAX：桩说明 file_read 只能取回前 50000 字符，不再说「取回完整内容」', () => {
    const paths = new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-readback-')));
    const e = new OffloadEngine(paths);
    const { stub } = e.offload('SID', 'T9', 'Y'.repeat(60_000));
    expect(stub).toContain('前 50000 字符');
    expect(stub).toContain('全文 60000 字符');
    expect(stub).not.toContain('取回完整内容');
    expect(stub.split('\n')).toHaveLength(3);
  });

  it('恰好 READBACK_MAX：仍是原文案（一次 file_read 能完整取回）', () => {
    const paths = new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-readback-')));
    const e = new OffloadEngine(paths);
    const { stub } = e.offload('SID', 'T8', 'Y'.repeat(READBACK_MAX));
    expect(stub.split('\n')[2]).toBe('使用 file_read 工具读取 /var/minis/offloads/T8.txt 取回完整内容');
  });
});

describe('OffloadEngine.readBackOf（单元）', () => {
  const SID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  const OTHER = 'FFFFFFFF-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  const mk = () => {
    const paths = new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-readback-')));
    return { paths, e: new OffloadEngine(paths) };
  };
  const input = (path: unknown) => JSON.stringify({ path, tool_title: 't' });

  it('guest 路径 /var/minis/offloads/<id>.txt 命中，给出宿主绝对路径', () => {
    const { paths, e } = mk();
    expect(e.readBackOf(SID, 'file_read', input('/var/minis/offloads/T1.txt')))
      .toEqual({ absPath: join(paths.sessionBucket(SID, 'offloads'), 'T1.txt') });
    // 桶里名字以「..」开头的文件仍在桶内（相对路径是「..x.txt」，不是「../」）
    expect(e.readBackOf(SID, 'file_read', input('/var/minis/offloads/..x.txt')))
      .toEqual({ absPath: join(paths.sessionBucket(SID, 'offloads'), '..x.txt') });
  });

  it('不是 file_read 不算（shell 读回的输出本来就该按原规则卸载）', () => {
    const { e } = mk();
    expect(e.readBackOf(SID, 'shell_execute', input('/var/minis/offloads/T1.txt'))).toBeUndefined();
    expect(e.readBackOf(SID, 'file_write', input('/var/minis/offloads/T1.txt'))).toBeUndefined();
  });

  it('入参坏了或 path 不是字符串：返回 undefined，不抛', () => {
    const { e } = mk();
    expect(e.readBackOf(SID, 'file_read', '{')).toBeUndefined();
    expect(e.readBackOf(SID, 'file_read', '{}')).toBeUndefined();
    expect(e.readBackOf(SID, 'file_read', input(42))).toBeUndefined();
  });

  it('offloads 桶本身、别的桶、穿越出桶都不算', () => {
    const { e } = mk();
    expect(e.readBackOf(SID, 'file_read', input('/var/minis/offloads'))).toBeUndefined();
    expect(e.readBackOf(SID, 'file_read', input('/var/minis/offloads/'))).toBeUndefined();
    expect(e.readBackOf(SID, 'file_read', input('/var/minis/workspace/T1.txt'))).toBeUndefined();
    expect(e.readBackOf(SID, 'file_read', input('/var/minis/offloads/../workspace/T1.txt'))).toBeUndefined();
    expect(e.readBackOf(SID, 'file_read', input('T1.txt'))).toBeUndefined();
  });

  it('别的会话的 offloads 不算（工作区被绑到别的会话的 offloads 桶时，相对路径解析过去也不命中）', () => {
    const { paths, e } = mk();
    paths.setWorkspaceResolver(() => paths.sessionBucket(OTHER, 'offloads'));
    expect(e.readBackOf(SID, 'file_read', input('T1.txt'))).toBeUndefined();
  });

  it('宿主绝对路径：resolveGuestPath 抛错（Linux 上的 POSIX 绝对路径）时返回 undefined 而不是抛；Windows 上盘符路径照常命中', () => {
    const { paths, e } = mk();
    const abs = join(paths.sessionBucket(SID, 'offloads'), 'T1.txt');
    // 同一个断言在两个平台上各自成立：paths.ts 只认盘符开头的宿主绝对路径，POSIX 绝对路径直接抛「不支持的绝对 guest 路径」
    const expected = process.platform === 'win32' ? { absPath: abs } : undefined;
    expect(() => e.readBackOf(SID, 'file_read', input(abs))).not.toThrow();
    expect(e.readBackOf(SID, 'file_read', input(abs))).toEqual(expected);
  });
});

describe('OffloadEngine.clampReadBack（单元）', () => {
  const e = new OffloadEngine(new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-readback-'))));
  const ABS = join(tmpdir(), 'x', 'offloads', 'T1.txt');

  it('不超过上限原样返回', () => {
    const s = 'Z'.repeat(READBACK_MAX);
    expect(e.clampReadBack(s, ABS)).toBe(s);
  });

  it('超过上限：截在代理对之前，不留半个 emoji，注明实际返回的字数', () => {
    // 第 50000 个码元是 emoji 的低代理项：直接按码元切会留下一个孤立高代理项，严格的 JSON 端会 400
    const s = 'a'.repeat(READBACK_MAX - 1) + '😀' + 'b'.repeat(20_000);
    const out = e.clampReadBack(s, ABS);
    expect(out.startsWith('a'.repeat(READBACK_MAX - 1) + '\n[已截断')).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(out).toContain(`共 ${s.length} 字符`);
    expect(out).toContain(`前 ${READBACK_MAX - 1} 字符`);
  });
});
