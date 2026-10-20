import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, isVNode, type ComputedRef, type VNode } from 'vue';
import { join } from 'node:path';
import type { ProcSnapshot } from '../src/shared/proc';
import type { CheckpointUsage } from '../src/shared/checkpoint';
import type { DryRunResult } from '../src/minisd/diagnostics';

const probe = vi.hoisted(() => ({
  call: vi.fn(), on: vi.fn(), handlers: new Map<string, (p: any) => unknown>(),
  lost: vi.fn(), connect: vi.fn(async () => {})
}));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: {
  call: probe.call,
  on: probe.on.mockImplementation((m: string, h: (p: any) => unknown) => probe.handlers.set(m, h)),
  onLost: probe.lost, connect: probe.connect
} }));
import { useChat } from '../src/renderer/src/stores/chat';
import { resetStoreRpc, deferred, settleStore } from './renderer-store-fixture';
import { runSetup, type SetupRun } from './sfc-setup';

const proc: ProcSnapshot = { epoch: 7, takenAt: 100, ownership: { state: 'disabled', reason: '合成停用原因', lastFailure: '合成失败原因' }, trees: [] };
const usage: CheckpointUsage = { usedBytes: 8192, quotaBytes: 1048576, blobCount: 2, checkpointCount: 3, retentionDays: 30, maxFileBytes: 65536, protectedBytes: 4096, overQuota: false };
const ready = { status: 'ready' as const, detail: '合成检查说明' };
const dry: DryRunResult = {
  overall: 'warning', estimatedTokens: 9, promptPreview: '合成系统提示 <script>不执行</script>',
  checks: {
    providers: ready, defaultProvider: { status: 'blocked', detail: '未配置默认模型' },
    fallbackChain: ready, modelCatalog: ready, bridgeNode: ready,
    skills: [{ status: 'warning', detail: '合成技能说明' }], pairing: [],
    syncState: ready, processOwnership: { status: 'warning', detail: '合成托管说明' }
  }
};
const records = { total: 23, rows: [{ id: 'R', eventType: 'permission.preset', sessionId: 'S', payload: { command: '合成命令', token: undefined } }] };
const replies: Record<string, unknown> = {
  'proc.trees.snapshot': proc, 'checkpoints.usage': usage, 'diagnostics.dryRun': dry, 'audit.list': records
};
type State<T> = { data?: T; busy: boolean; error: string };
interface Bindings {
  processes: State<ProcSnapshot>;
  checkpoints: State<CheckpointUsage>;
  audit: State<typeof records>;
  selfCheck: State<DryRunResult>;
  ownershipText: ComputedRef<string>;
  checks: ComputedRef<Array<{ label: string; status: string; detail?: string }>>;
  refreshProcesses(): Promise<void>;
  refreshCheckpoints(): Promise<void>;
  refreshAudit(): Promise<void>;
  runSelfCheck(): Promise<void>;
}
let component: SetupRun<Bindings> | undefined;
beforeEach(() => {
  resetStoreRpc(probe);
  probe.call.mockImplementation(async (m: string) => structuredClone(replies[m]));
});
afterEach(() => {
  component?.unmount();
  component = undefined;
  vi.restoreAllMocks();
});
async function setup() {
  component = await runSetup<Bindings>(join(__dirname, '../src/renderer/src/ui/settings/SecDiagnostics.vue'), {}, effectScope());
  return component.bindings;
}

describe('N04 真实 store 的四个只读 action', () => {

  const actions = [
    ['fetchProcSnapshot', 'proc.trees.snapshot'],
    ['fetchCheckpointUsage', 'checkpoints.usage'],
    ['runDiagnostics', 'diagnostics.dryRun'],
    ['fetchAuditRecords', 'audit.list']
  ] as const;
  for (const [action, method] of actions) {
    it(action + ' 精确参数、原样应答与失败传播', async () => {
      // action 只发指定查询，不把结果写到会话里；审计固定最近 20 条。
      const chat = useChat();
      chat.activeId = '原会话';
      const before = structuredClone(JSON.parse(JSON.stringify(chat.$state)));
      const response = replies[method];
      probe.call.mockResolvedValueOnce(response);
      expect(await chat[action]()).toBe(response);
      expect(probe.call.mock.calls).toEqual([method === 'audit.list' ? [method, { limit: 20, offset: 0 }] : [method]]);
      expect(chat.$state).toEqual(before);

      // 错误由组件负责说明，store 不把失败伪装成空列表。
      const error = new Error('合成查询失败');
      probe.call.mockRejectedValueOnce(error);
      await expect(chat[action]()).rejects.toBe(error);
      expect(chat.$state).toEqual(before);
    });
  }
});

describe('N04 诊断组件的实际 setup', () => {

  it('进页只取三块状态，自检由用户触发，四个应答分别落到对应块', async () => {
    // 挂载前不发请求；挂载后没有自动运行自检。
    const b = await setup();
    expect(probe.call).not.toHaveBeenCalled();
    component!.mount();
    await settleStore();
    expect(probe.call.mock.calls).toEqual([
      ['proc.trees.snapshot'], ['checkpoints.usage'], ['audit.list', { limit: 20, offset: 0 }]
    ]);
    expect(b.processes.data).toEqual(proc);
    expect(b.checkpoints.data).toEqual(usage);
    expect(b.audit.data).toEqual(records);
    expect(b.selfCheck.data).toBeUndefined();
    expect(b.checks.value).toEqual([]);
    expect(b.ownershipText.value).toBe('进程托管已停用');

    // 显式按钮入口发第四个 RPC，各检查项的状态与说明原样保留。
    await b.runSelfCheck();
    expect(probe.call.mock.calls.at(-1)).toEqual(['diagnostics.dryRun']);
    expect(b.selfCheck.data).toEqual(dry);
    expect(b.checks.value).toEqual([
      { label: '模型配置', ...ready }, { label: '默认模型', ...dry.checks.defaultProvider },
      { label: '模型组', ...ready }, { label: '模型目录', ...ready }, { label: 'Windows 桥', ...ready },
      { label: '同步状态', ...ready }, { label: '进程托管', ...dry.checks.processOwnership },
      { label: '技能 1', ...dry.checks.skills[0] }
    ]);
  });

  it('每块失败独立显示、清掉旧结果，刷新可恢复', async () => {
    const b = await setup();
    // 逐块证明失败不会显示旧的成功结果，也不破坏其它块。
    for (const [key, refresh, method] of [
      ['processes', 'refreshProcesses', 'proc.trees.snapshot'],
      ['checkpoints', 'refreshCheckpoints', 'checkpoints.usage'],
      ['audit', 'refreshAudit', 'audit.list'],
      ['selfCheck', 'runSelfCheck', 'diagnostics.dryRun']
    ] as const) {
      await b[refresh]();
      expect(b[key].data).toEqual(replies[method]);
      probe.call.mockRejectedValueOnce(new Error('合成读取失败：' + key));
      await b[refresh]();
      expect(b[key]).toEqual({ data: undefined, busy: false, error: '合成读取失败：' + key });
      await b[refresh]();
      expect(b[key].data).toEqual(replies[method]);
      expect(b[key].error).toBe('');
    }
    expect(b.processes.data).toEqual(proc);
    expect(b.checkpoints.data).toEqual(usage);
    expect(b.audit.data).toEqual(records);
    expect(b.selfCheck.data).toEqual(dry);
  });

  it('等待中抑制重复点击、显示忙状态，普通拒绝值也给出说明', async () => {
    const b = await setup();
    const gate = deferred<DryRunResult>();
    probe.call.mockReturnValueOnce(gate.promise);
    const running = b.runSelfCheck();
    expect(b.selfCheck.busy).toBe(true);
    await b.runSelfCheck();
    expect(probe.call.mock.calls).toEqual([['diagnostics.dryRun']]);
    gate.resolve(dry);
    await running;
    expect(b.selfCheck.busy).toBe(false);

    // 非 Error 的 RPC 拒绝也不能丢掉具体原因。
    probe.call.mockRejectedValueOnce('字符串原因');
    await b.refreshAudit();
    expect(b.audit.error).toBe('字符串原因');
    expect(b.audit.busy).toBe(false);
  });

  it('托管三种状态各有说明，未取到数据时没有伪造的状态', async () => {
    const b = await setup();
    expect(b.ownershipText.value).toBe('');
    for (const [state, text] of [
      ['active', '作业对象已生效'], ['untested', '本次运行还没有启动过子进程'], ['disabled', '进程托管已停用']
    ] as const) {
      probe.call.mockResolvedValueOnce({ ...proc, ownership: { state } });
      await b.refreshProcesses();
      expect(b.ownershipText.value).toBe(text);
    }
  });
});

describe('N04 设置页的实际导航与选中分节', () => {

  it('诊断登记在外观与关于之间，点击后仅渲染诊断页并使用 check 图标', async () => {
    // 编译真实设置页的 setup 和模板；子组件保持辅助原有的空壳，用 VNode 类型识别选中了谁。
    const stage = await runSetup<() => VNode>(
      join(__dirname, '../src/renderer/src/ui/StageSettings.vue'), {}, effectScope(), { inlineTemplate: true }
    );
    const nodes = (node: unknown): VNode[] => {
      if (Array.isArray(node)) return node.flatMap(nodes);
      if (!isVNode(node)) return [];
      return [node, ...nodes(node.children)];
    };
    const text = (node: VNode): string => nodes(node)
      .map(child => typeof child.children === 'string' ? child.children : '').join('');
    const sections = (tree: VNode): string[] => nodes(tree)
      .map(node => typeof node.type === 'object' && 'name' in node.type ? String(node.type.name) : '')
      .filter(name => name.startsWith('./settings/'));
    try {
      const before = stage.bindings();
      const buttons = nodes(before).filter(node => node.type === 'button');
      const labels = buttons.map(text);
      const index = labels.indexOf('诊断');
      expect(labels.filter(label => label === '诊断')).toHaveLength(1);
      expect(labels.slice(index - 1, index + 2)).toEqual(['外观', '诊断', '关于']);
      expect(buttons[index].props?.['aria-pressed']).toBe(false);
      expect(sections(before)).not.toContain('./settings/SecDiagnostics.vue');
      const icon = nodes(buttons[index]).find(node =>
        typeof node.type === 'object' && 'name' in node.type && node.type.name === './UiIcon.vue');
      expect(icon?.props?.name).toBe('check');

      // 调实际按钮上的处理器，再执行同一渲染闭包，不能只把 sec 手工改成诊断。
      const click = buttons[index].props?.onClick;
      expect(click).toBeTypeOf('function');
      click();
      const after = stage.bindings();
      expect(sections(after)).toEqual(['./settings/SecDiagnostics.vue']);
      const selected = nodes(after).filter(node => node.type === 'button' && node.props?.['aria-pressed'] === true);
      expect(selected.map(text)).toEqual(['诊断']);
    } finally { stage.unmount(); }
  });
});
