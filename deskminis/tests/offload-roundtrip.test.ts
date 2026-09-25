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

/** 让模型发一次 file_read(path, ...extra)，再收尾。 */
function readThenEnd(toolUseId: string, path: string, extra: Record<string, unknown> = {}): ScriptedProvider {
  return new ScriptedProvider([
    [
      { kind: 'toolCallComplete', toolUseId, name: 'file_read', input: JSON.stringify({ path, ...extra, tool_title: '读回卸载内容' }) },
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

  it('③ 读回 60000 字：落库截到前 50000 字并如实注明全长与 file_read 分段读法（不再指向 shell）；toolEnd 仍广播全文', async () => {
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
    // W1b-2d：卸载文件在数据根里，W1b-2 起 shell 只读命令点到它就回落询问；当前会话的 offloads 对文件工具免审，
    // 所以改指 file_read 分段读取：path 不变、offset 从实际返回的终点起、limit 不超过读回上限。
    // 「每段不超过 20000 否则会再次被卸载」是假话（读回不会再卸载），宿主位置也只对 shell 有用，一并删掉
    expect(out).toContain('file_read');
    expect(out).toContain('path 不变');
    expect(out).toContain('offset=50000');
    expect(out).toContain(`limit 不超过 ${READBACK_MAX}`);
    expect(out).not.toContain('shell_execute');
    expect(out).not.toContain('再次被卸载');
    expect(out).not.toContain(abs);
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

  it('带 offset / limit 的分段读回照样命中（只看 path），这样分段读回也走 clampReadBack 封顶、不再卸载', () => {
    const { paths, e } = mk();
    const paged = JSON.stringify({ path: '/var/minis/offloads/T1.txt', offset: 50_000, limit: 100_000, tool_title: 't' });
    expect(e.readBackOf(SID, 'file_read', paged)).toEqual({ absPath: join(paths.sessionBucket(SID, 'offloads'), 'T1.txt') });
  });

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

  it('不超过上限原样返回', () => {
    const s = 'Z'.repeat(READBACK_MAX);
    expect(e.clampReadBack(s)).toBe(s);
  });

  it('超过上限：截在代理对之前，不留半个 emoji，注明实际返回的字数，下一段 offset 从实际终点起', () => {
    // 第 50000 个码元是 emoji 的低代理项：直接按码元切会留下一个孤立高代理项，严格的 JSON 端会 400
    const s = 'a'.repeat(READBACK_MAX - 1) + '😀' + 'b'.repeat(20_000);
    const out = e.clampReadBack(s);
    expect(out.startsWith('a'.repeat(READBACK_MAX - 1) + '\n[已截断')).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(out).toContain(`共 ${s.length} 字符`);
    expect(out).toContain(`前 ${READBACK_MAX - 1} 字符`);
    expect(out).toContain(`offset=${READBACK_MAX - 1}`);
    expect(out).toContain(`limit 不超过 ${READBACK_MAX}`);
  });

  it('分段读回（带 readRange）片段不超过上限：原样返回，file_read 自己的末行注记不算进上限', () => {
    const body = 'q'.repeat(READBACK_MAX);
    const out = `${body}\n[第 100–${100 + READBACK_MAX} 字符，共 200000 字符，未读完，下一段 offset=${100 + READBACK_MAX}]`;
    expect(e.clampReadBack(out, { start: 100, end: 100 + READBACK_MAX, total: 200_000 })).toBe(out);
  });

  it('分段读回片段超过上限：按文件坐标注明实际返回的范围，下一段 offset = 起点 + 实际返回的字数', () => {
    const start = 1000;
    const body = 'c'.repeat(READBACK_MAX - 1) + '😀' + 'd'.repeat(30_000);
    const end = start + body.length;
    const out = e.clampReadBack(`${body}\n[第 ${start}–${end} 字符，共 300000 字符，未读完，下一段 offset=${end}]`, { start, end, total: 300_000 });
    expect(out.startsWith('c'.repeat(READBACK_MAX - 1) + '\n[已截断')).toBe(true);
    expect(out).toContain('共 300000 字符');
    expect(out).toContain(`第 ${start}–${start + READBACK_MAX - 1} 字符`);
    expect(out).toContain(`offset=${start + READBACK_MAX - 1}`);
    // 被截掉的 file_read 注记不能留下：它给的下一段 offset（${end}）会让模型跳过中间那段
    expect(out).not.toContain(`offset=${end}`);
    expect(out).not.toContain('shell_execute');
  });
});

/**
 * W1b-2d 端到端：照 clampReadBack 尾注与 file_read 末行注记给的参数一段段读回长卸载文件。
 * 这个「模型」只看上一条工具结果的最后一行：有 offset=<n> 就接着读（limit 取提示里写的上限，没写就沿用上一次），
 * 读到末尾就收尾。它看到的是请求里的历史，也就是落库后的 output——与真模型所见一致。
 */
class FollowHintsProvider implements AgentProvider {
  readonly name = 'follow-hints'; readonly modelId = 'fake';
  calls: Array<Record<string, unknown>> = [];
  constructor(private path: string, private first: Record<string, unknown>) {}
  async *streamAgentMessage(req: StreamRequest): AsyncIterable<AgentStreamEvent> {
    let args: Record<string, unknown> | undefined;
    if (this.calls.length === 0) args = { ...this.first };
    else {
      const out = lastToolOutput(req);
      const tail = out.slice(out.lastIndexOf('\n[') + 1);
      const off = /offset=(\d+)/.exec(tail);
      if (off) {
        const lim = /limit 不超过 (\d+)/.exec(tail);
        args = { offset: Number(off[1]), limit: lim ? Number(lim[1]) : this.calls.at(-1)?.limit };
      }
    }
    if (!args || this.calls.length > 20) {
      yield { kind: 'textDelta', text: '读完了' };
      yield { kind: 'done', stopReason: 'endTurn' };
      return;
    }
    this.calls.push(args);
    yield { kind: 'toolCallComplete', toolUseId: `P${this.calls.length}`, name: 'file_read', input: JSON.stringify({ path: this.path, ...args, tool_title: '分段读回' }) };
    yield { kind: 'done', stopReason: 'toolUse' };
  }
}

function lastToolOutput(req: StreamRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    for (const p of req.messages[i].parts) {
      if (p.type === 'toolResult') return (p.value as { output: string }).output;
    }
  }
  throw new Error('请求里没有工具结果');
}

/** 落库 output 去掉最后一行注记（截断尾注或 file_read 的范围注记），剩下的就是这一段正文。 */
const bodyOf = (out: string): string => out.slice(0, out.lastIndexOf('\n['));

/** 边界上故意放代理对：前 50000 截断点、第二段的终点都落在代理对中间。总长 130001 > READBACK_MAX。
 *  正文按行（每 80 个码元一个换行）：卸载的多是命令输出，本来就按行；也避开请求侧 sanitizeMultiline 的
 *  URL 凭据正则在几万字的单行上的平方级耗时（那是已知的旧开销，与本测无关，只会把用例拖到十几秒）。 */
function longOffloadText(): string {
  const base = Array.from({ length: 130_001 }, (_, i) => (i % 80 === 79 ? '\n' : i % 7 === 0 ? '汉' : String.fromCharCode(0x61 + (i % 26)))).join('');
  const text = base.slice(0, 49_999) + '😀' + base.slice(50_001, 99_998) + '𝄞' + base.slice(100_000);
  expect(text.length).toBe(130_001);
  expect(text.charCodeAt(49_999)).toBeGreaterThanOrEqual(0xd800);
  expect(text.charCodeAt(99_998)).toBeGreaterThanOrEqual(0xd800);
  return text;
}

describe('W1b-2d 分段读回长卸载文件（loop 级，真实 file_read）', () => {
  it('照尾注与注记给的参数一段段 file_read：拼回与原文逐字相等，全程零询问、不再卸载', async () => {
    const { store, tools, toolContext, sessionId, paths, offloadEngine, asked } = mkCtx();
    const bucket = paths.sessionBucket(sessionId, 'offloads');
    const text = longOffloadText();
    expect(text.length).toBeGreaterThan(READBACK_MAX);
    writeFileSync(join(bucket, 'T1.txt'), text, 'utf8');
    // 第一次照卸载桩的指引整读，后面全凭上一段结果的最后一行
    const provider = new FollowHintsProvider('/var/minis/offloads/T1.txt', {});
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', offloadEngine }));
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    // 整读 → 从 49999 起 50000 → 从 99998 起读到末尾（两处切点都让开了代理对）
    expect(provider.calls).toEqual([{}, { offset: 49_999, limit: READBACK_MAX }, { offset: 99_998, limit: READBACK_MAX }]);
    const outs = provider.calls.map((_, i) => storedOutput(store, sessionId, `P${i + 1}`));
    expect(outs.map(bodyOf).join('')).toBe(text);
    expect(outs.at(-1)).toContain('已读到末尾');
    for (const o of outs) {
      expect(o).not.toContain('shell_execute');
      expect(o.length).toBeLessThan(READBACK_MAX + 300);
    }
    expect(asked).toEqual([]);
    expect(events.filter(e => e.kind === 'offloaded')).toEqual([]);
    expect(readdirSync(bucket)).toEqual(['T1.txt']);
  });

  it('分段读回的 limit 超过读回上限：仍被 clampReadBack 封顶，尾注按文件坐标给下一段 offset，照着读完不丢字', async () => {
    const { store, tools, toolContext, sessionId, paths, offloadEngine, asked } = mkCtx();
    const bucket = paths.sessionBucket(sessionId, 'offloads');
    const text = longOffloadText();
    writeFileSync(join(bucket, 'T1.txt'), text, 'utf8');
    const provider = new FollowHintsProvider('/var/minis/offloads/T1.txt', { offset: 10, limit: 100_000 });
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', offloadEngine }));
    expect(events.at(-1)).toEqual({ kind: 'turnEnd', stopReason: 'endTurn' });
    const outs = provider.calls.map((_, i) => storedOutput(store, sessionId, `P${i + 1}`));
    // 第一段请求了 100000 字，落库只留 READBACK_MAX 字，下一段从 10 + 50000 起
    expect(bodyOf(outs[0]).length).toBe(READBACK_MAX);
    expect(outs[0]).toContain('已截断');
    expect(provider.calls[1]).toEqual({ offset: 10 + READBACK_MAX, limit: READBACK_MAX });
    expect(outs.map(bodyOf).join('')).toBe(text.slice(10));
    // toolEnd 仍广播 file_read 的完整输出（UI 可见），封顶只作用于落库
    const firstEnd = events.find(e => e.kind === 'toolEnd' && e.toolUseId === 'P1') as Extract<LoopEvent, { kind: 'toolEnd' }>;
    expect(firstEnd.output.startsWith(text.slice(10, 10 + 100_000))).toBe(true);
    expect(asked).toEqual([]);
    expect(events.filter(e => e.kind === 'offloaded')).toEqual([]);
  });

  it('别的会话的 offloads：带 offset/limit 读仍要走卡（note 说明其它会话），也不算读回——超阈值照旧卸载', async () => {
    const { store, tools, toolContext, sessionId, paths, offloadEngine, asked } = mkCtx();
    const OTHER = 'FFFFFFFF-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
    paths.ensureSessionDirs(OTHER);
    writeFileSync(join(paths.sessionBucket(OTHER, 'offloads'), 'T1.txt'), 'O'.repeat(60_000), 'utf8');
    // Linux 上 POSIX 绝对路径进不了工具（paths.ts 直接抛），把工作区绑到别的会话的 offloads 桶，用相对路径点过去
    paths.setWorkspaceResolver(() => paths.sessionBucket(OTHER, 'offloads'));
    const provider = readThenEnd('R1', 'T1.txt', { offset: 0, limit: 30_000 });
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', offloadEngine }));
    expect(asked).toHaveLength(1);
    expect(asked[0].kind).toBe('file-read');
    expect(asked[0].note ?? '').toContain('其它会话');
    expect(events.filter(e => e.kind === 'offloaded')).toHaveLength(1);
    expect(storedOutput(store, sessionId, 'R1')).toContain('[CONTEXT OFFLOADED: offloads/R1.txt');
  });
});
