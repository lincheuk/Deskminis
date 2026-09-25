/**
 * W1b-5：关停 / 删除会话时，挂着的权限卡由后台按 deny 了结、紧接着 abort（denyPendingPerms 之后 stopRun，同一段同步代码）。
 * 这不是用户点了「拒绝」。工具在权限闸之后要先看取消、再看拒绝：
 * 否则落库的 toolResult 写「写入被用户拒绝（可在设置-权限中调整）」，重开会话时界面与模型都以为是用户拒绝的。
 * MCP 调用（mcp/manager.ts）一直是先查取消再看拒绝；本文件把文件、抓网页、搜索、shell 四处拉齐。
 *
 * 网关替身：check 里先 abort 再回 deny，时序与 minisd 了结权限卡时一致（工具的续体在两者之后才跑）。
 * 路径用 /var/minis/skills 与数据根内的 minis.db（W1b-2 之后走卡），不用 POSIX 绝对路径（Linux 上走不到网关）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { fileWriteTool, guardRead, guardWrite } from '../src/minisd/tools/files';
import { makeWebFetchTool } from '../src/minisd/tools/web';
import { makeWebSearchTool } from '../src/minisd/tools/web-search';
import { makeShellTool, ShellManager } from '../src/minisd/tools/shell';
import { MinisPaths } from '../src/minisd/paths';
import type { PermissionDecision, PermissionRequest, ToolContext } from '../src/minisd/tools/types';

/** 模拟后台了结：询问到来时先中止会话，再回 deny。abortFirst=false 时只回 deny（用户真的点了拒绝）。 */
class SystemDenyGateway {
  asked: PermissionRequest[] = [];
  constructor(private controller: AbortController, private abortFirst: boolean) {}
  async check(r: PermissionRequest): Promise<PermissionDecision> {
    this.asked.push(r);
    if (this.abortFirst) this.controller.abort('shutdown');
    return 'deny';
  }
  hasBridgeGrant(): boolean { return false; }
}

let root: string; let paths: MinisPaths; let reg: ToolRegistry;
let netHits: number;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dm-cancel-deny-'));
  paths = new MinisPaths(root);
  paths.ensureSessionDirs('S1');
  netHits = 0;
  const fakeFetch = (async () => { netHits++; return new Response('x'); }) as unknown as typeof fetch;
  reg = new ToolRegistry();
  reg.register(fileWriteTool);
  reg.register(makeWebFetchTool(fakeFetch));
  reg.register(makeWebSearchTool(() => ({ kind: 'searxng', baseUrl: 'http://127.0.0.1:9' }), fakeFetch));
  // deny / 取消两条路径都在起 shell 之前返回，Linux 上也能跑
  reg.register(makeShellTool(new ShellManager()));
});

function ctxWith(abortFirst: boolean): { ctx: ToolContext; gw: SystemDenyGateway } {
  const controller = new AbortController();
  const gw = new SystemDenyGateway(controller, abortFirst);
  return { ctx: { sessionId: 'S1', paths, permissions: gw, signal: controller.signal }, gw };
}

const CASES: [string, Record<string, unknown>][] = [
  ['file_write', { path: '/var/minis/skills/x/SKILL.md', content: 'x' }],
  ['web_fetch', { url: 'http://127.0.0.1:9/page' }],
  ['web_search', { query: '天气' }],
  ['shell_execute', { command: 'npm install left-pad' }],
];

describe('W1b-5 权限闸之后先看取消、再看拒绝', () => {
  for (const [name, args] of CASES) {
    it(`${name}：卡在权限上时被关停了结 → [已取消]，不写「被用户拒绝」，也不执行`, async () => {
      const { ctx, gw } = ctxWith(true);
      const r = await reg.execute(name, JSON.stringify({ ...args, tool_title: '测' }), ctx);
      expect(gw.asked, '应当走到权限闸').toHaveLength(1);
      expect(r).toEqual({ output: '[已取消]', success: false });
      expect(netHits).toBe(0);
    });
    it(`${name}：用户真的拒绝（未取消）→ 仍写「被用户拒绝」`, async () => {
      const { ctx, gw } = ctxWith(false);
      const r = await reg.execute(name, JSON.stringify({ ...args, tool_title: '测' }), ctx);
      expect(gw.asked).toHaveLength(1);
      expect(r.success).toBe(false);
      expect(r.output).toContain('被用户拒绝');
    });
  }

  it('guardWrite / guardRead（office 与 file_edit 也走这两道门）：先看取消', async () => {
    const w = ctxWith(true);
    expect(await guardWrite(join(root, 'skills', 'x', 'SKILL.md'), w.ctx, '写')).toBe('[已取消]');
    const r = ctxWith(true);
    expect(await guardRead(join(root, 'minis.db'), r.ctx, '读')).toBe('[已取消]');
    expect(existsSync(join(root, 'skills', 'x', 'SKILL.md'))).toBe(false);
  });
});
