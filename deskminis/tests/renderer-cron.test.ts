/** K2 守卫：定时任务前端——人话调度描述纯模块 + 面板/店面接线源文本断言
 *  （设计稿 2026-08-20-cron-design.md §5）。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const { _rpcCall, _rpcOn, _handlers, _rpcLost, _rpcConnect } = vi.hoisted(() => {
  const handlers = new Map<string, (params: any) => unknown>();
  return { _rpcCall: vi.fn(), _rpcOn: vi.fn((method: string, handler: (params: any) => unknown) => { handlers.set(method, handler); }), _handlers: handlers, _rpcLost: vi.fn(), _rpcConnect: vi.fn(async () => {}) };
});
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: _rpcCall, on: _rpcOn, onLost: _rpcLost, connect: _rpcConnect } }));

import fs from 'node:fs';
import path from 'node:path';
import { describeSchedule } from '../src/renderer/src/lib/cron/describe';
import { sfcBlocks } from './sfc-blocks';
import { useChat } from '../src/renderer/src/stores/chat';
import { resetStoreRpc, settleStore, dispatchStore, deferred, type Equal, type Chat } from './renderer-store-fixture';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

const _probe = { call: _rpcCall, on: _rpcOn, handlers: _handlers, lost: _rpcLost, connect: _rpcConnect };
// 每例使用新的真实 Pinia；RPC 桩只记调用与订阅，由用例放行应答。
beforeEach(() => { resetStoreRpc(_probe); });
afterEach(() => { vi.restoreAllMocks(); });

describe('describeSchedule（人话描述，描述不了就给原表达式不硬编）', () => {
  it('interval：分钟与整小时两档', () => {
    expect(describeSchedule('interval', '30')).toBe('每 30 分钟');
    expect(describeSchedule('interval', '120')).toBe('每 2 小时');
  });
  it('once：本地时刻一次', () => {
    const sec = Math.floor(new Date(2026, 11, 31, 9, 5).getTime() / 1000);
    expect(describeSchedule('once', String(sec))).toBe('2026-12-31 09:05 一次');
  });
  it('cron 常见形：每天/每周X/工作日/每 n 分钟/整点', () => {
    expect(describeSchedule('cron', '0 9 * * *')).toBe('每天 09:00');
    expect(describeSchedule('cron', '30 18 * * 5')).toBe('每周五 18:30');
    expect(describeSchedule('cron', '0 9 * * 1-5')).toBe('工作日 09:00');
    expect(describeSchedule('cron', '*/15 * * * *')).toBe('每 15 分钟');
    expect(describeSchedule('cron', '5 * * * *')).toBe('每小时的第 5 分');
  });
  it('描述不了的形态回落原表达式；坏表达式也回落原文（描述器不抛）', () => {
    expect(describeSchedule('cron', '0 9 1,15 * *')).toBe('cron: 0 9 1,15 * *');
    expect(describeSchedule('cron', 'not a cron')).toBe('cron: not a cron');
  });
});

describe('K2 接线守卫', () => {
  it('store：cronJobs 状态 + 刷新/CRUD/runNow + cron.changed 订阅', async () => {
    // 声明全集用精确类型比较；scheduleKind 全取值逐个真走刷新。
    type Cron = { id: string; name: string; prompt: string; scheduleKind: 'interval' | 'once' | 'cron'; scheduleValue: string; assistantId?: string; workspaceRoot?: string; enabled: boolean; nextRunAt?: number; lastRunAt?: number; lastSessionId?: string; lastStatus: string };
    const cronType: true = true as Equal<Chat['cronJobs'], Cron[]>;
    expect(cronType).toBe(true);
    const chat = useChat();
    expect(chat.cronJobs).toEqual([]);
    await chat.init();
    await settleStore();
    const kinds = { interval: '60', once: '2026-10-15T12:00:00', cron: '0 * * * *' } satisfies Record<Cron['scheduleKind'], string>;
    for (const scheduleKind of Object.keys(kinds) as Cron['scheduleKind'][]) {
      const row = { id: 'C', name: 'job', prompt: 'run', scheduleKind, scheduleValue: kinds[scheduleKind], enabled: true, lastStatus: 'idle' };
      _rpcCall.mockClear();
      _rpcCall.mockResolvedValueOnce([row]);
      await chat.refreshCronJobs();
      expect(_rpcCall.mock.calls).toEqual([['cron.list']]);
      expect(chat.cronJobs).toEqual([row]);
      const input = { name: 'new', prompt: 'task', scheduleKind, scheduleValue: kinds[scheduleKind], assistantId: 'AS', workspaceRoot: 'C:/work' };
      _rpcCall.mockClear();
      _rpcCall.mockResolvedValueOnce(row).mockResolvedValueOnce([row]);
      expect(await chat.createCronJob(input)).toEqual(row);
      expect(_rpcCall.mock.calls).toEqual([['cron.create', input], ['cron.list']]);
      _rpcCall.mockClear();
      _rpcCall.mockResolvedValueOnce(row).mockResolvedValueOnce([row]);
      expect(await chat.updateCronJob('C', { name: 'changed', enabled: false })).toEqual(row);
      expect(_rpcCall.mock.calls).toEqual([['cron.update', { id: 'C', name: 'changed', enabled: false }], ['cron.list']]);
    }

    // 删除与立即运行都等应答；runNow 的两次重拉严格按 cron→sessions。
    _rpcCall.mockClear();
    const remove = deferred();
    _rpcCall.mockReturnValueOnce(remove.promise);
    const removing = chat.deleteCronJob('C');
    expect(_rpcCall.mock.calls).toEqual([['cron.delete', { id: 'C', confirm: true }]]);
    remove.resolve({ ok: true });
    await removing;
    expect(_rpcCall.mock.calls).toEqual([['cron.delete', { id: 'C', confirm: true }], ['cron.list']]);
    _rpcCall.mockClear();
    const run = deferred();
    _rpcCall.mockReturnValueOnce(run.promise);
    const running = chat.runCronNow('C');
    expect(_rpcCall.mock.calls).toEqual([['cron.runNow', { id: 'C' }]]);
    run.resolve({ ok: true });
    await running;
    expect(_rpcCall.mock.calls).toEqual([['cron.runNow', { id: 'C' }], ['cron.list'], ['chat.sessions.list']]);
    _rpcCall.mockClear();
    await dispatchStore(_probe, 'cron.changed', {});
    expect(_rpcOn.mock.calls.filter(c => c[0] === 'cron.changed')).toHaveLength(1);
    expect(_rpcCall.mock.calls).toEqual([['cron.list']]);
  });

  it('App：工作台「定时」tab（market 全局 tab 成例：懒挂载 + 不随会话重置）', () => {
    const app = read('src/renderer/src/ui/AppShell.vue');
    expect(app).toMatch(/'cron'/);  // 定时从工作台 tab 升格为一级舞台视图（NavRail 直达）
    expect(app).toMatch(/<StageCron v-else-if="view === 'cron'"/);  // 定时是一级舞台视图，不再懒挂载
    // 惰性挂载（visited）随旧外壳退场：舞台按 view 切换，不需要「访问过才挂」
  });

  it('CronPanel：CRUD/立即运行/启停接线 + 删除二次确认 + 运行边界与权限文案', () => {
    const p = read('src/renderer/src/ui/StageCron.vue');
    expect(p).toContain('createCronJob');
    expect(p).toContain('updateCronJob');
    expect(p).toContain('deleteCronJob');
    expect(p).toContain('runCronNow');
    expect(p).toMatch(/confirming/);
    expect(p).toContain('describeSchedule');
    // §0 两条裁定的用户可见面：不假装 24/7；无人值守权限语义说清
    // W2b-11a 有意重指：原断言 /应用没开就不会跑|应用运行时/ 读的是原文，文件头注释就能喂饱；它钉的那句
    // 「应用没开就不会跑——它不是后台服务」本身也不实：关窗只是隐藏到托盘（main/index.ts 的 close 处理），
    // minisd 照常每 30 秒 tick，错过的任务下次启动补跑一次（cron/store.ts dueJobs / markRun）。
    // 改为在剥过注释的模板上钉三件事：关窗后仍在托盘里跑、退出或关机才停、错过的补一次；「不是后台服务」不许回来。
    const tpl = sfcBlocks(p, 'StageCron.vue').template;
    expect(tpl).toMatch(/关掉窗口后应用仍在托盘里运行/);
    expect(tpl).toMatch(/从托盘退出或关机后就不会跑/);
    expect(tpl).toMatch(/补跑一次/);
    expect(tpl).not.toMatch(/不是后台服务/);
    expect(p).toMatch(/90\s*秒.*自动拒绝/);
    // F13：同一会话连续两次无人回应之后，后面的请求不再等 90 秒、直接按未批准处理。在剥过注释的模板上认：
    // 「90 秒后会自动拒绝」对第三个起的请求不成立，说明里要有这半句
    expect(tpl).toMatch(/90 秒后会自动拒绝<\/b>；连续两次之后的请求不再等待，直接拒绝/);
    // 最近会话跳转（chat.open）
    expect(p).toContain('chat.open(');
  });
});
