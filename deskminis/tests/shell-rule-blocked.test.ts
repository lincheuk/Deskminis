/**
 * W1b-2g · 危险命令被规则拦下时，shell 回给模型的话要如实（止血设计稿 §4.1 W1b-2g 一行）。
 *
 * classifyShellCommand 判 danger 的命令在网关里是 notAllowed：不询问、任何档位都拒（applyPreset 三档都保留 danger 为 notAllowed）。
 * 网关对「规则拦下」与「用户点了拒绝」都只回 'deny'，shell 以前一律回「命令被用户拒绝（可在设置-权限中调整）」——
 * 用户没拒绝，设置里也调不了；模型会以为换个档位、再问一次就能过。
 * 这里用 shell 工具真跑一遍：spawn 换成记账的替身（一旦被调就是命令真要执行了），不会真的起 PowerShell。
 * 「先看取消、再看拒绝」（W1b-5）的顺序不动：关停 / 删除会话时后台了结卡片并 abort，那条仍写「[已取消]」。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawn } from 'node:child_process';
import { ToolRegistry } from '../src/minisd/tools/registry';
import { makeShellTool, ShellManager } from '../src/minisd/tools/shell';
import { PermissionGatewayImpl, type PermissionPreset } from '../src/minisd/tools/permissions';
import { MinisPaths } from '../src/minisd/paths';
import type { PermissionDecision, PermissionGateway, PermissionRequest, ToolContext } from '../src/minisd/tools/types';

const USER_DENIED = '命令被用户拒绝（可在设置-权限中调整）';

let paths: MinisPaths; let reg: ToolRegistry; let spawned: unknown[][];
beforeEach(() => {
  paths = new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-rule-blocked-')));
  paths.ensureSessionDirs('S1');
  spawned = [];
  const fakeSpawn = ((...args: unknown[]) => { spawned.push(args); throw new Error('不该启动 shell：命令要真的执行了'); }) as unknown as typeof spawn;
  reg = new ToolRegistry();
  reg.register(makeShellTool(new ShellManager({ spawnImpl: fakeSpawn })));
});

const run = (command: string, permissions: PermissionGateway, signal?: AbortSignal) => {
  const ctx: ToolContext = { sessionId: 'S1', paths, permissions, signal };
  return reg.execute('shell_execute', JSON.stringify({ command, tool_title: '清理' }), ctx);
};

/** 真网关：记下每一次询问，询问时按 answer 作答。 */
function realGateway(preset: PermissionPreset, answer: 'allow-once' | 'deny') {
  const asked: PermissionRequest[] = [];
  const gw = new PermissionGatewayImpl(async (r) => { asked.push(r); return answer; });
  gw.applyPreset(preset);
  return { gw, asked };
}

/** 规则拦下的说法：规则拦的、没执行、不是用户拒绝的、换档位也不放行；不再出现「被用户拒绝」和「可在设置-权限中调整」。 */
function expectRuleBlocked(r: { output: string; success: boolean }): void {
  expect(r.success).toBe(false);
  expect(r.output).toContain('未执行');
  expect(r.output).toContain('危险命令规则');
  expect(r.output).toContain('不是用户拒绝');
  expect(r.output).toContain('任何权限档位也不会放行');
  expect(r.output).not.toContain('被用户拒绝');
  expect(r.output).not.toContain('可在设置-权限中调整');
}

describe('危险命令被规则拦下：如实说是规则，不说用户拒绝', () => {
  for (const preset of ['ask', 'session', 'full'] as const) {
    it(`真网关 ${preset} 档：Remove-Item 被拦，零询问、不执行，回话说明是规则拦下`, async () => {
      const { gw, asked } = realGateway(preset, 'allow-once');
      const r = await run('Remove-Item -Recurse -Force C:\\work\\build', gw);
      expectRuleBlocked(r);
      expect(asked, '危险命令不经询问').toHaveLength(0);
      expect(spawned, '命令没有执行').toHaveLength(0);
    });
  }

  it('网关桩一律回 deny：命令位的 rm（DANGER_AT_COMMAND_POSITION）同样说是规则拦下', async () => {
    const stub: PermissionGateway = { check: async (): Promise<PermissionDecision> => 'deny', hasBridgeGrant: () => false };
    const r = await run('rm -r node_modules', stub);
    expectRuleBlocked(r);
    expect(spawned).toHaveLength(0);
  });
});

describe('对照：用户拒绝与取消的说法照旧', () => {
  it('gated 命令用户点了拒绝 → 仍是「命令被用户拒绝（可在设置-权限中调整）」', async () => {
    const { gw, asked } = realGateway('ask', 'deny');
    const r = await run('npm install left-pad', gw);
    expect(asked).toHaveLength(1);
    expect(r).toEqual({ output: USER_DENIED, success: false });
    expect(spawned).toHaveLength(0);
  });

  it('先看取消：后台了结时先 abort 再回 deny，危险命令也写 [已取消]', async () => {
    const controller = new AbortController();
    const stub: PermissionGateway = {
      check: async (): Promise<PermissionDecision> => { controller.abort('shutdown'); return 'deny'; },
      hasBridgeGrant: () => false,
    };
    const r = await run('Remove-Item -Force C:\\work\\a.txt', stub, controller.signal);
    expect(r).toEqual({ output: '[已取消]', success: false });
    expect(spawned).toHaveLength(0);
  });
});
