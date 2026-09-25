/**
 * W1b-2d · file_read 分段读取（止血设计稿 §4.1 表格第一行；侦察 tools.md「W1b-datagate」、engine.md「W2a-honest」风险条）。
 *
 * 旧行为：file_read 只能整读，超过 1MB 直接失败并叫模型「用 shell_execute 分页读取」；卸载读回超过
 * READBACK_MAX 时也叫模型用 shell 分段读。卸载文件在数据根里，W1b-2 起 shell 只读命令点到数据根回落 gated，
 * 照提示读卸载内容每次都弹卡——而当前会话的 offloads 对文件工具本来免审。
 *
 * 新规则：
 * - 可选 offset（非负整数，按 UTF-16 码元的字符偏移，默认 0）与 limit（正整数，最多返回的字符数，上限 100000）；
 *   非法值返回 success:false 与一句中文说明，不抛；
 * - 切点不落在代理对中间：起点落在低代理项上后移一位，终点前一位是高代理项前移一位；注明的是实际返回的范围；
 * - 带任一参数时文件大小上限放宽到 16MB，片段末尾另起一行「[第 a–b 字符，共 N 字符，…]」写明有无下一段；
 *   offset 越过末尾返回空片段加这一行、success:true；
 * - 不带参数时行为与输出逐字不变；超过 1MB 的提示改指 file_read 分段读取，超过 16MB 才提示 shell_execute。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { fileReadTool, FILE_READ_LIMIT_MAX, FILE_READ_SUGGESTED_LIMIT, MAX_READ_PAGED } from '../src/minisd/tools/files';
import { OffloadEngine } from '../src/minisd/agent/offload';
import { MinisPaths } from '../src/minisd/paths';
import type { PermissionDecision, PermissionRequest, ToolContext } from '../src/minisd/tools/types';

class RecordingGateway {
  asked: PermissionRequest[] = [];
  constructor(private decision: PermissionDecision) {}
  async check(r: PermissionRequest): Promise<PermissionDecision> { this.asked.push(r); return this.decision; }
  hasBridgeGrant(): boolean { return false; }
}

let root: string; let ws: string; let reg: ToolRegistry; let gate: RecordingGateway; let ctx: ToolContext;
let seen: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dm-paged-'));
  const paths = new MinisPaths(root);
  paths.ensureSessionDirs('S1');
  ws = paths.workspaceOf('S1');
  gate = new RecordingGateway('allow');
  seen = [];
  ctx = { sessionId: 'S1', paths, permissions: gate, onFileRead: (p) => seen.push(p) };
  reg = new ToolRegistry();
  reg.register(fileReadTool);
});
/** 本文件建的临时目录（数据根与「数据根之外」）跑完即删，不在系统临时目录里越积越多 */
const scratch: string[] = [];
beforeEach(() => { scratch.push(root); });
afterEach(() => { for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true }); });

const read = (args: Record<string, unknown>, c: ToolContext = ctx) =>
  reg.execute('file_read', JSON.stringify({ ...args, tool_title: '分段读' }), c);

/** 没有孤立代理项：严格的 JSON 端见到半个 emoji 会 400。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** 拆出片段与末行注记。 */
function split(out: string): { body: string; note: string } {
  const i = out.lastIndexOf('\n[');
  return { body: out.slice(0, i), note: out.slice(i + 1) };
}

describe('offset / limit 基本语义与末行注记', () => {
  beforeEach(() => { writeFileSync(join(ws, 'a.txt'), 'abcdefghij', 'utf8'); });

  it('offset + limit：返回 [offset, offset+limit) 并注明范围与下一段的 offset', async () => {
    const r = await read({ path: 'a.txt', offset: 2, limit: 3 });
    expect(r).toEqual({ success: true, output: 'cde\n[第 2–5 字符，共 10 字符，未读完，下一段 offset=5]', readRange: { start: 2, end: 5, total: 10 } });
  });

  it('读到末尾：注明「已读到末尾」，不再给下一段', async () => {
    const r = await read({ path: 'a.txt', offset: 8, limit: 5 });
    expect(r).toEqual({ success: true, output: 'ij\n[第 8–10 字符，共 10 字符，已读到末尾]', readRange: { start: 8, end: 10, total: 10 } });
  });

  it('只给 offset：从 offset 读到末尾；只给 limit：从 0 读 limit 个；offset 显式为 0 也算带参数', async () => {
    expect((await read({ path: 'a.txt', offset: 7 })).output).toBe('hij\n[第 7–10 字符，共 10 字符，已读到末尾]');
    expect((await read({ path: 'a.txt', limit: 4 })).output).toBe('abcd\n[第 0–4 字符，共 10 字符，未读完，下一段 offset=4]');
    expect((await read({ path: 'a.txt', offset: 0 })).output).toBe('abcdefghij\n[第 0–10 字符，共 10 字符，已读到末尾]');
  });

  it('offset 恰在末尾或越过末尾：空片段加注记一行，success:true', async () => {
    expect(await read({ path: 'a.txt', offset: 10, limit: 5 })).toEqual({ success: true, output: '\n[第 10–10 字符，共 10 字符，已读到末尾]', readRange: { start: 10, end: 10, total: 10 } });
    const past = await read({ path: 'a.txt', offset: 99 });
    expect(past.success).toBe(true);
    expect(past.output.startsWith('\n[第 10–10 字符，共 10 字符，已读到末尾')).toBe(true);
    expect(past.output).toContain('99');
    expect(past.output.split('\n')).toHaveLength(2);
    expect(past.readRange).toEqual({ start: 10, end: 10, total: 10 });
  });

  it('limit 取到上限 100000 合法', async () => {
    expect(FILE_READ_LIMIT_MAX).toBe(100_000);
    const r = await read({ path: 'a.txt', limit: FILE_READ_LIMIT_MAX });
    expect(r.output).toBe('abcdefghij\n[第 0–10 字符，共 10 字符，已读到末尾]');
  });

  it('onFileRead 按「读了一次这个文件」计：分段读只在从头读起的那一段计一次，后续段与越界的空片段不计', async () => {
    // 技能 use_count 靠它；一个 SKILL.md 分 N 段读完，不该算用了 N 次（W1b-2d 审查 nit）
    const first = await read({ path: 'a.txt', offset: 0, limit: 4 });
    expect(first.output).toBe('abcd\n[第 0–4 字符，共 10 字符，未读完，下一段 offset=4]');
    expect(seen).toEqual([join(ws, 'a.txt')]);
    const r = await read({ path: 'a.txt', offset: 4, limit: 1 });
    expect(r.output).toBe('e\n[第 4–5 字符，共 10 字符，未读完，下一段 offset=5]');
    await read({ path: 'a.txt', offset: 99 });
    expect(seen).toEqual([join(ws, 'a.txt')]);
    // 整读照旧每次都计
    await read({ path: 'a.txt' });
    expect(seen).toEqual([join(ws, 'a.txt'), join(ws, 'a.txt')]);
  });

  it('建议的每段长度连同末行注记不超过卸载阈值：照建议读工作区文件不会被卸载成桩', async () => {
    // 片段加注记超过 20000 字符就会被 loop 卸载，模型得再读一次卸载文件（W1b-2d 审查 nit：提示写每段最多 100000，照着取反而绕远）
    writeFileSync(join(ws, 'long.txt'), '汉'.repeat(3 * FILE_READ_SUGGESTED_LIMIT), 'utf8');
    const e = new OffloadEngine(new MinisPaths(root));
    for (const offset of [0, 1_234_567 % FILE_READ_SUGGESTED_LIMIT, 2 * FILE_READ_SUGGESTED_LIMIT - 7]) {
      const r = await read({ path: 'long.txt', offset, limit: FILE_READ_SUGGESTED_LIMIT });
      expect(r.success).toBe(true);
      expect(e.shouldOffload(r.output), `offset=${offset} 长 ${r.output.length}`).toBe(false);
    }
  });
});

describe('非法值：success:false 与一句中文说明，不抛、不弹卡、不计数', () => {
  const BAD: Array<[string, Record<string, unknown>]> = [
    ['offset 负数', { offset: -1 }],
    ['offset 小数', { offset: 1.5 }],
    ['offset 数字字符串', { offset: '3' }],
    ['offset 布尔', { offset: true }],
    ['offset 对象', { offset: {} }],
    ['limit 为 0', { limit: 0 }],
    ['limit 负数', { limit: -5 }],
    ['limit 小数', { limit: 2.5 }],
    ['limit 超上限', { limit: 100_001 }],
    ['limit 非数字', { limit: 'x' }],
  ];
  for (const [label, args] of BAD) {
    it(label, async () => {
      // 路径放在数据根与工作区之外：参数先校验，非法时不该先弹一张权限卡再报参数错
      const outDir = mkdtempSync(join(tmpdir(), 'dm-paged-out-'));
      scratch.push(outDir);
      const outside = join(outDir, 'o.txt');
      writeFileSync(outside, 'abc');
      const r = await read({ path: outside, ...args });
      expect(r.success, label).toBe(false);
      const key = Object.keys(args)[0];
      expect(r.output).toContain(key);
      expect(r.output).toMatch(/[一-鿿]/);
      expect(r.output).not.toContain('工具执行异常');
      expect(r.output.split('\n')).toHaveLength(1);
      expect(gate.asked).toEqual([]);
      expect(seen).toEqual([]);
    });
  }

  it('非法值原样回显有长度上限：超长字符串不整段抄进工具结果', async () => {
    const r = await read({ path: 'a.txt', offset: 'x'.repeat(5000) });
    expect(r.success).toBe(false);
    expect(r.output).toContain('offset');
    expect(r.output.length).toBeLessThan(200);
  });

  it('null 当作没给（与 registry 的必填检查同一口径）：输出与不带参数逐字相同', async () => {
    writeFileSync(join(ws, 'n.txt'), '原文\n', 'utf8');
    expect(await read({ path: 'n.txt', offset: null, limit: null })).toEqual({ success: true, output: '原文\n' });
  });
});

describe('切点不落在代理对中间', () => {
  // 'a' + 😀（高 \uD83D、低 \uDE00）+ 'b'：码元 0=a，1=高，2=低，3=b
  beforeEach(() => { writeFileSync(join(ws, 'e.txt'), 'a😀b', 'utf8'); });

  it('起点落在低代理项上：后移一位，注明实际起点', async () => {
    expect((await read({ path: 'e.txt', offset: 2 })).output).toBe('b\n[第 3–4 字符，共 4 字符，已读到末尾]');
  });

  it('终点前一位是高代理项：前移一位，下一段从高代理项起', async () => {
    expect((await read({ path: 'e.txt', offset: 0, limit: 2 })).output).toBe('a\n[第 0–1 字符，共 4 字符，未读完，下一段 offset=1]');
  });

  it('limit=1 正好落在一个代理对上：返回整个字符而不是空片段（否则照注记的 offset 永远原地打转）', async () => {
    expect((await read({ path: 'e.txt', offset: 1, limit: 1 })).output).toBe('😀\n[第 1–3 字符，共 4 字符，未读完，下一段 offset=3]');
  });

  it('照注记给的 offset 一段段读，拼回与原文逐字相等，每段都没有孤立代理项', async () => {
    const text = Array.from({ length: 200 }, (_, i) => (i % 3 === 0 ? '😀' : i % 3 === 1 ? '汉' : 'x')).join('') + '𝄞尾';
    writeFileSync(join(ws, 'walk.txt'), text, 'utf8');
    for (const limit of [1, 2, 3, 7]) {
      let offset = 0; let got = ''; let guard = 0;
      for (;;) {
        const r = await read({ path: 'walk.txt', offset, limit });
        expect(r.success).toBe(true);
        const { body, note } = split(r.output);
        expect(body).not.toMatch(LONE_SURROGATE);
        got += body;
        const next = /下一段 offset=(\d+)/.exec(note);
        if (!next) { expect(note).toContain('已读到末尾'); break; }
        expect(Number(next[1])).toBeGreaterThan(offset);
        offset = Number(next[1]);
        if (++guard > 1000) throw new Error('没有推进');
      }
      expect(got, `limit=${limit}`).toBe(text);
    }
  });
});

describe('文件大小上限：不带参数 1MB，带参数 16MB', () => {
  it('不带参数、超过 1MB：失败，提示改用 file_read 的 offset/limit 分段读取并写明每段上限，不再叫模型用 shell', async () => {
    writeFileSync(join(ws, 'big.txt'), 'x'.repeat(1024 * 1024 + 1), 'utf8');
    const r = await read({ path: 'big.txt' });
    expect(r.success).toBe(false);
    expect(r.output).toContain('1MB');
    expect(r.output).toContain('file_read');
    expect(r.output).toContain('offset');
    expect(r.output).toContain('limit');
    expect(r.output).toContain(String(FILE_READ_LIMIT_MAX));
    // 同时给出不会被卸载的建议段长，并说明更长的一段会被卸载
    expect(r.output).toContain(String(FILE_READ_SUGGESTED_LIMIT));
    expect(r.output).toContain('卸载');
    expect(r.output).not.toContain('shell_execute');
    expect(seen).toEqual([]);
  });

  it('同一个 1MB 以上的文件带参数：照常分段读出', async () => {
    const text = 'x'.repeat(1024 * 1024) + 'TAIL';
    writeFileSync(join(ws, 'big.txt'), text, 'utf8');
    const r = await read({ path: 'big.txt', offset: text.length - 6, limit: 10 });
    expect(r).toEqual({ success: true, output: `xxTAIL\n[第 ${text.length - 6}–${text.length} 字符，共 ${text.length} 字符，已读到末尾]`, readRange: { start: text.length - 6, end: text.length, total: text.length } });
  });

  it('超过 16MB：带不带参数都失败，这时才提示 shell_execute', async () => {
    expect(MAX_READ_PAGED).toBe(16 * 1024 * 1024);
    const huge = join(ws, 'huge.txt');
    writeFileSync(huge, '');
    truncateSync(huge, MAX_READ_PAGED + 1);
    for (const args of [{}, { offset: 0, limit: 10 }]) {
      const r = await read({ path: 'huge.txt', ...args });
      expect(r.success, JSON.stringify(args)).toBe(false);
      expect(r.output).toContain('16MB');
      expect(r.output).toContain('shell_execute');
    }
    expect(seen).toEqual([]);
  });

  it('恰好 16MB 带参数：仍可分段读', async () => {
    const edge = join(ws, 'edge.txt');
    writeFileSync(edge, '');
    truncateSync(edge, MAX_READ_PAGED);
    const r = await read({ path: 'edge.txt', offset: MAX_READ_PAGED - 2 });
    expect(r).toEqual({ success: true, output: `\0\0\n[第 ${MAX_READ_PAGED - 2}–${MAX_READ_PAGED} 字符，共 ${MAX_READ_PAGED} 字符，已读到末尾]`, readRange: { start: MAX_READ_PAGED - 2, end: MAX_READ_PAGED, total: MAX_READ_PAGED } });
  });
});

describe('不带参数：行为与输出逐字不变', () => {
  it('整读原样返回，没有末行注记', async () => {
    const text = '第一行\r\n第二行 😀\n[第 0–1 字符，共 1 字符，已读到末尾]';
    writeFileSync(join(ws, 'plain.txt'), text, 'utf8');
    const r = await read({ path: 'plain.txt' });
    expect(r).toEqual({ success: true, output: text });
    // toEqual 不看值为 undefined 的键：整读的结果对象上干脆不该出现 readRange
    expect(r).not.toHaveProperty('readRange');
  });

  it('恰好 1MB：仍整读', async () => {
    const text = 'y'.repeat(1024 * 1024);
    writeFileSync(join(ws, 'mb.txt'), text, 'utf8');
    const r = await read({ path: 'mb.txt' });
    expect(r.success).toBe(true);
    expect(r.output).toBe(text);
  });
});

describe('工具定义', () => {
  it('offset / limit 是可选的整数参数，描述里讲清分段读法', () => {
    const d = fileReadTool.definition;
    expect(d.parameters.offset?.type).toBe('integer');
    expect(d.parameters.limit?.type).toBe('integer');
    expect(d.required).toEqual(['path', 'tool_title']);
    expect(d.parameters.limit?.description).toContain(String(FILE_READ_LIMIT_MAX));
    expect(d.parameters.limit?.description).toContain(String(FILE_READ_SUGGESTED_LIMIT));
    // 切点让开代理对，实际返回可能比 limit 少 1 个或（limit=1 时）多 1 个码元：写进描述，模型不会被吓到
    expect(d.parameters.limit?.description).toMatch(/代理对|emoji/);
    expect(d.description).toContain('offset');
    expect(d.description).toContain('limit');
  });
});
