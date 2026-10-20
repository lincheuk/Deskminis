/**
 * F05 P 组：内置工具「权限决议之前零副作用」。
 *
 * 账本把「停在首次审批上就中断的调用」判成未执行（cancelled / approval-expired，告诉模型可以重新发起），
 * 依赖的就是这一条：有副作用的工具在权限询问返回之前不动手。哪个工具在询问之前就产生了副作用，
 * 崩溃后它会被误报成「没有执行」，模型据此重做就是重复副作用——那个工具在这里就红。
 * 以后新增有副作用的工具（或 MCP 之外的新执行器）要补进这张表。
 *
 * 用 F13 的调用方夹具（真实工具、副作用全部可数）；权限网关挂住不答，由测试决定何时拒绝 / 批准。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionGateway, PermissionOutcome, PermissionRequest } from '../src/minisd/tools/types';
import { callerHarness, settle, waitFor, type CallerHarness, type ToolCaller } from './permission-fixture';

/** 有副作用、且走权限卡的工具入口（只读的 file_read / office_read / file_list / file_glob / file_grep 不在此列）。 */
const SIDE_EFFECT_CALLERS: ToolCaller[] = ['file_write', 'file_edit', 'office_write', 'shell_execute', 'web_fetch', 'web_search', 'mcp__a__echo'];

let h: CallerHarness;
// F08：接上真实的检查点存储——不接的话这条路径永远不建检查点，「零行、零内容文件」就是恒真的空断言
beforeAll(async () => { h = await callerHarness({ checkpoints: true }); });
afterAll(() => { h.dispose(); });

/** 挂住不答的网关：记下收到的询问，由测试放行或拒绝。 */
function heldGateway(): { gw: PermissionGateway; asked: PermissionRequest[]; answer(o: PermissionOutcome): void } {
  const asked: PermissionRequest[] = [];
  let release: (o: PermissionOutcome) => void = () => undefined;
  const gw: PermissionGateway = {
    async check(req) { return (await gw.decide!(req)).decision; },
    decide(req) { asked.push(req); return new Promise<PermissionOutcome>(r => { release = r; }); },
    hasBridgeGrant: () => false,
  };
  return { gw, asked, answer: o => release(o) };
}

/** F08：检查点也是副作用——记录行数加内容文件数（建在审批之前的话，挂起那一刻这里就不是零）。 */
let checkpointBase = 0;
function checkpointTotal(): number {
  const rows = (h.db.prepare('SELECT COUNT(*) AS n FROM file_checkpoints').get() as { n: number }).n;
  const dir = join(h.root, 'checkpoints', 'blobs');
  const blobs = existsSync(dir) ? readdirSync(dir).reduce((n, sub) => n + readdirSync(join(dir, sub)).length, 0) : 0;
  return rows + blobs;
}
/** 相对本条用例开始那一刻的增量：夹具的库在各条用例之间共用，前面的用例留下的检查点不算在这一条头上。 */
const checkpointEffects = (): number => checkpointTotal() - checkpointBase;

/** 此刻已经发生的副作用次数（直接看磁盘与各假出口的计数，不等工具返回）。 */
function effectsNow(caller: ToolCaller): number {
  switch (caller) {
    case 'file_write': return (existsSync(h.abs('/var/minis/skills/f13/a.md')) ? 1 : 0) + checkpointEffects();
    case 'file_edit': return (readFileSync(h.abs('/var/minis/skills/f13/e.md'), 'utf8') === 'OLD' ? 0 : 1) + checkpointEffects();
    case 'office_write': return (existsSync(h.abs('/var/minis/skills/f13/a.docx')) ? 1 : 0) + checkpointEffects();
    case 'shell_execute': return h.spawned.length;
    case 'web_fetch': case 'web_search': return h.fetchCalls.length;
    case 'mcp__a__echo': return h.mcpClients.reduce((n, c) => n + c.callLog.length, 0);
    default: throw new Error(`没有为 ${caller} 准备副作用探针`);
  }
}

describe('F05 权限决议之前零副作用', () => {
  it.each(SIDE_EFFECT_CALLERS)('%s：权限挂起时零副作用，拒绝后仍为零', async caller => {
    checkpointBase = checkpointTotal();
    const g = heldGateway();
    const running = h.run(caller, g.gw);
    await waitFor(`${caller} 走到权限询问`, () => g.asked.length === 1);
    // 让出事件循环若干轮：在询问返回之前就动手的工具，此刻副作用已经发生
    await settle(10);
    expect(effectsNow(caller), '权限还挂着，不该有任何副作用').toBe(0);
    g.answer({ decision: 'deny', reason: 'user-denied' });
    const r = await running;
    expect(r.success).toBe(false);
    expect(r.effects).toBe(0);
    expect(effectsNow(caller)).toBe(0);
    expect(g.asked).toHaveLength(1);
  });

  it.each(SIDE_EFFECT_CALLERS)('%s：批准之后副作用确实发生（探针测得到，上面的零不是假阴性）', async caller => {
    checkpointBase = checkpointTotal();
    const g = heldGateway();
    const running = h.run(caller, g.gw);
    await waitFor(`${caller} 走到权限询问`, () => g.asked.length === 1);
    await settle(3);
    expect(effectsNow(caller)).toBe(0);
    const before = caller === 'file_write' || caller === 'file_edit' || caller === 'office_write' ? checkpointEffects() : 0;
    g.answer({ decision: 'allow', via: 'user-once' });
    const r = await running;
    expect(r.effects).toBeGreaterThan(0);
    // F08：三个写工具批准之后确实留下了检查点（行数增加；file_edit 改的是已有文件，另有 1 个内容文件）
    if (caller === 'file_write' || caller === 'file_edit' || caller === 'office_write') {
      expect(checkpointEffects(), '批准之后应当有检查点：探针测得到').toBeGreaterThan(before);
      const rows = h.db.prepare("SELECT tool_name, state, before_exists, before_blob FROM file_checkpoints ORDER BY seq DESC LIMIT 1").get() as { tool_name: string; state: string; before_exists: number; before_blob: string | null };
      expect(rows).toMatchObject({ tool_name: '', state: 'applied' });
      if (caller === 'file_edit') { expect(rows.before_exists).toBe(1); expect(rows.before_blob).not.toBeNull(); }
    }
  });
});
