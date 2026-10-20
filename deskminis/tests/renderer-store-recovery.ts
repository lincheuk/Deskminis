/** Q20b：恢复入口的实际状态与调用观察。入口本身均为真实store方法。 */
import { expect, vi } from 'vitest';

import type { RecoveryHooks, LinkStatus, SyncInfo } from '../src/renderer/src/rpc';
import type { StateSnapshot, PendingPermissionView, AttachResult, WriteOutcome } from '../src/shared/event-stream';
import type { RunView } from '../src/shared/run';
import { markInFlightLoss } from '../src/renderer/src/lib/conn/in-doubt';
import { resetStoreRpc, initStore, dispatchStore, settleStore, minimalReply, deferred, type Chat, type StoreRpcProbe } from './renderer-store-fixture';

export interface RecoveryProbe extends StoreRpcProbe { resync: ReturnType<typeof vi.fn>; box: { hooks?: RecoveryHooks } }
const sessions = [{ id: 'A', title: 'A', createdAt: 1, updatedAt: 2 }, { id: 'B', title: 'B', createdAt: 3, updatedAt: 4 }];
export const permissionView = (): PendingPermissionView => ({
  requestId: 'R1', req: { sessionId: 'A', kind: 'file-write', detail: '写 a.txt', toolTitle: '写文件', preview: { oldText: '旧', newText: '新' }, note: '改应用配置' },
  meta: { timeoutMs: 90000, riskClass: 'high', bridgeTriggers: ['web-fetch'], toolUseId: 'tu1' }, origin: 'tool', askedAt: 123, remainingMs: 30000,
});
const run = (patch: Partial<RunView> = {}): RunView => ({ runId: 'run-A', sessionId: 'A', generation: 7, epoch: 1, state: 'running', step: 'model', toolBatches: 2, origin: { kind: 'user' }, createdAt: 1, updatedAt: 2, ...patch });
const snapshot = (patch: Partial<StateSnapshot> = {}): StateSnapshot => ({ epoch: 1, instanceId: 'I', revision: 1, lastSeq: 10, takenAt: 0, sessions, runs: [], executions: [], live: [], pendingPermissions: [], artifacts: [], ...patch });
const resume = (pendingPermissions: PendingPermissionView[] = []): Extract<AttachResult, { mode: 'resume' }> => ({ protocol: 1, epoch: 1, instanceId: 'I', lastSeq: 20, revision: 1, window: { firstSeq: 1, maxEvents: 30, maxChars: 10000 }, mode: 'resume', events: [], runs: [], pendingPermissions });
const snapInfo = { reason: 'no-cursor', cause: 'join', epochChanged: false } as const;
const prompt = (id = 'p1', sid = 'A') => ({ sessionId: sid, promptId: id, text: '待核对-' + id, attachments: ['a.txt'], optimisticId: 'local-' + id });

async function fresh(p: RecoveryProbe): Promise<Chat> {
  resetStoreRpc(p);
  p.on.mockImplementation((m: string, h: (value: any) => unknown) => p.handlers.set(m, h));
  p.resync.mockReset();
  p.box.hooks = undefined;
  p.call.mockImplementation(async (m: string) => {
    if (m === 'chat.sessions.list') return structuredClone(sessions);
    if (m === 'state.outcomes') return { epoch: 1, instanceId: 'I', outcomes: [] };
    return minimalReply(m);
  });
  const chat = await initStore(p);
  chat.activeId = 'A';
  expect(p.box.hooks).toBeDefined();
  expect(p.handlers.has('permission.request')).toBe(true);
  p.resync.mockImplementation(async () => p.box.hooks!.applySnapshot(snapshot({ session: { sessionId: 'A', exists: true, messages: [] } }), snapInfo));
  return chat;
}

export async function checkPermissionEntrances(p: RecoveryProbe): Promise<void> {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(10000);
  const chat = await fresh(p);
  const v = permissionView();
  const want = { requestId: 'R1', sessionId: 'A', detail: '写 a.txt', kind: 'file-write', toolTitle: '写文件', timeoutMs: 90000, riskClass: 'high', bridgeTriggers: ['web-fetch'], preview: { oldText: '旧', newText: '新' }, note: '改应用配置' };
  // 三个入口用同一份载荷，整张卡比较；重复项原位替换，前后邻居均不动。
  const entrances = {
    realtime: async (value: PendingPermissionView) => dispatchStore(p, 'permission.request', value),
    snapshot: async (value: PendingPermissionView) => p.box.hooks!.applySnapshot(snapshot({ pendingPermissions: [value] }), snapInfo),
    resume: async (value: PendingPermissionView) => p.box.hooks!.resumed(resume([value]), { cause: 'reconnect' }),
  } satisfies Record<'realtime' | 'snapshot' | 'resume', (value: PendingPermissionView) => unknown>;
  for (const [kind, enter] of Object.entries(entrances)) {
    chat.pendingPerms = [];
    await enter(v);
    await settleStore();
    expect(chat.pendingPerms).toEqual([{ ...want, deadlineMs: 10000 + (kind === 'realtime' ? 90000 : 30000) }]);
    const next = { ...v, req: { ...v.req, note: '替换说明' } };
    await enter(next);
    await settleStore();
    expect(chat.pendingPerms).toEqual([{ ...want, note: '替换说明', deadlineMs: 10000 + (kind === 'realtime' ? 90000 : 30000) }]);
  }
  // 实时重复项有邻居时仍留在原索引；续传会摘掉权威列表中不存在的卡。
  await dispatchStore(p, 'permission.request', { ...v, requestId: 'R2' });
  await dispatchStore(p, 'permission.request', { ...v, req: { ...v.req, note: '原位' } });
  expect(chat.pendingPerms.map(c => [c.requestId, c.note])).toEqual([['R1', '原位'], ['R2', v.req.note]]);
  p.box.hooks!.resumed(resume([v]), { cause: 'reconnect' });
  expect(chat.pendingPerms).toEqual([{ ...want, deadlineMs: 40000 }]);
}

function seedRecovery(chat: Chat): void {
  chat.activeId = 'A';
  chat.syncOn = true;
  chat.engineEpoch = 1;
  chat.inDoubtPrompts = [prompt()];
  chat.inDoubtPerms = [{ requestId: 'uncertain-perm', sessionId: 'A' }];
  chat.undelivered = prompt('undelivered');
  chat.pendingPerms = [{ requestId: 'pending-perm', sessionId: 'A', detail: '待批', kind: 'file-write', toolTitle: '写文件' }];
  chat.messages = [{ id: 'local-p1', role: 'user', parts: [{ type: 'text', value: '待核对-p1' }], createdAt: 1 }];
  chat.running = true;
  chat.runningSessions = ['A'];
  chat.streamingText = '正文';
  chat.streamingThinking = '思考';
  chat.joinedTail = true;
}

export async function checkRecoveryNoWrites(p: RecoveryProbe): Promise<void> {
  const forbidden = ['chat.prompt', 'permission.respond', 'chat.cancel', 'chat.input.send'];
  const forbiddenActions = ['send', 'respondPerm', 'retryLast', 'cancel'];
  async function observe(label: string, enter: (c: Chat) => unknown): Promise<void> {
    const chat = await fresh(p);
    seedRecovery(chat);
    const actions: string[] = [];
    const stop = chat.$onAction(({ name }) => actions.push(name));
    p.call.mockClear();
    await enter(chat);
    await settleStore();
    stop();
    expect(p.call.mock.calls.map(c => c[0]).filter(m => forbidden.includes(m)), label).toEqual([]);
    expect(actions.filter(a => forbiddenActions.includes(a)), label).toEqual([]);
  }
  // 值域映射与真实入口表均受类型约束，缺项会编译失败。
  const states = { open: true, reconnecting: true, lost: true } satisfies Record<LinkStatus['state'], true>;
  const reasons = { exhausted: true, 'engine-exited': true } satisfies Record<NonNullable<LinkStatus['reason']>, true>;
  const causes = { initial: true, join: true, reconnect: true, gap: true, foreign: true, probe: true, retry: true } satisfies Record<SyncInfo['cause'], true>;
  const vias = { resume: true, snapshot: true } satisfies Record<SyncInfo['via'], true>;
  const terminals = { completed: true, failed: true, cancelled: true, interrupted: true } satisfies Record<Exclude<RunView['state'], 'starting' | 'running'>, true>;
  const entries = {
    onLinkStatus: async () => {
      for (const state of Object.keys(states) as LinkStatus['state'][]) for (const reason of state === 'lost' ? [undefined, ...Object.keys(reasons) as NonNullable<LinkStatus['reason']>[]] : [undefined]) await observe('status/' + state + '/' + reason, c => c.onLinkStatus({ state, reason, attempt: 2, maxAttempts: 4, retryInMs: 123 }));
    },
    applySnapshot: async () => {
      for (const current of [false, true]) for (const exists of [false, true]) for (const busy of [false, true]) for (const epochChanged of [false, true]) await observe('snapshot/' + [current, exists, busy, epochChanged], c => c.applySnapshot(snapshot({ runs: busy ? [run()] : [], ...(current ? { session: { sessionId: 'A', exists, messages: [] } } : {}) }), { ...snapInfo, epochChanged }));
    },
    reconcileResume: async () => {
      for (const busy of [false, true]) await observe('resume/' + busy, c => c.reconcileResume({ ...resume(), runs: busy ? [run()] : [] }));
    },
    afterSync: async () => {
      const methods = ['chat.prompt', 'permission.respond', 'chat.cancel', 'chat.input.send', 'workspace.set', 'chat.sessions.delete', 'chat.messages.list'];
      const doubtful = [[], ...methods.map(m => [m]), methods];
      for (const cause of Object.keys(causes) as SyncInfo['cause'][]) for (const via of Object.keys(vias) as SyncInfo['via'][]) for (const missed of [false, true]) for (const methods of doubtful) await observe('afterSync/' + [cause, via, missed, methods.join(',')], c => c.afterSync({ cause, via, missed, epochChanged: false, revision: 2, inDoubt: methods.map(method => ({ method, params: { sessionId: 'A' } })) }));
    },
    settleInDoubt: async () => {
      const outcomes = {
        active: { kind: 'prompt', sessionId: 'A', promptId: 'p1', status: 'accepted', run: run() },
        ended: { kind: 'prompt', sessionId: 'A', promptId: 'p1', status: 'accepted', run: run({ state: 'completed' }) },
        rejected: { kind: 'prompt', sessionId: 'A', promptId: 'p1', status: 'not-accepted' },
        error: { kind: 'prompt', sessionId: 'A', promptId: 'p1', status: 'not-accepted', error: '未配置' },
        gone: { kind: 'prompt', sessionId: 'A', promptId: 'p1', status: 'accepted', run: run() },
      } satisfies Record<'active' | 'ended' | 'rejected' | 'error' | 'gone', WriteOutcome>;
      const acceptedStates = { starting: true, running: true, completed: true, failed: true, cancelled: true, interrupted: true } satisfies Record<RunView['state'], true>;
      const expanded = [...Object.entries(outcomes), ...Object.keys(acceptedStates).map(state => [state, { kind: 'prompt', sessionId: 'A', promptId: 'p1', status: 'accepted', run: run({ state: state as RunView['state'] }) }] as [string, WriteOutcome])];
      for (const [kind, outcome] of expanded) await observe('settle-prompt/' + kind, async c => {
        const gate = deferred();
        p.call.mockImplementation((m: string) => m === 'state.outcomes' ? gate.promise : minimalReply(m));
        const checking = c.settleInDoubt();
        await settleStore();
        expect(p.call.mock.calls.some(x => x[0] === 'state.outcomes')).toBe(true);
        if (kind === 'gone') c.markGone(['A']);
        gate.resolve({ epoch: 1, instanceId: 'I', outcomes: [outcome] });
        await checking;
      });
      const permissions = {
        settled: { kind: 'permission', requestId: 'uncertain-perm', status: 'settled', source: 'ledger', sessionId: 'A', toolUseId: 'tu', epoch: 1, approval: { state: 'allowed' }, execution: 'completed' },
        pending: { kind: 'permission', requestId: 'uncertain-perm', status: 'pending', sessionId: 'A' },
        unknown: { kind: 'permission', requestId: 'uncertain-perm', status: 'unknown' },
      } satisfies Record<Extract<WriteOutcome, { kind: 'permission' }>['status'], WriteOutcome>;
      for (const [kind, outcome] of Object.entries(permissions)) await observe('settle-permission/' + kind, async c => {
        p.call.mockImplementation(async (m: string) => m === 'state.outcomes' ? { epoch: 1, instanceId: 'I', outcomes: [outcome] } : minimalReply(m));
        await c.settleInDoubt();
      });
      await observe('settle-permission/reappeared', c => {
        c.pendingPerms.push({ requestId: 'uncertain-perm', sessionId: 'A', detail: '再出现', kind: 'file-write', toolTitle: '写' });
        return c.settleInDoubt();
      });
    },
    reloadActive: async () => {
      await observe('reload/snapshot', c => c.reloadActive());
      await observe('reload/open', c => {
        c.syncOn = false;
        return c.reloadActive();
      });
    },
    refreshJoinedHistory: async () => observe('joined-history', c => c.refreshJoinedHistory()),
    refreshAll: async () => observe('refresh-all', c => c.refreshAll()),
    concludeRun: async () => {
      for (const state of Object.keys(terminals) as (keyof typeof terminals)[]) await observe('conclude/' + state, c => {
        c.runOf.A = { runId: 'run-A', generation: 7, ended: false };
        c.concludeRun(run({ state, stopReason: 'error', stopDetail: '结束' }));
      });
    },
  } satisfies Record<keyof Pick<Chat, 'onLinkStatus' | 'applySnapshot' | 'reconcileResume' | 'afterSync' | 'settleInDoubt' | 'reloadActive' | 'refreshJoinedHistory' | 'refreshAll' | 'concludeRun'>, () => Promise<void>>;
  for (const enter of Object.values(entries)) await enter();

  // refs逐项比形状与顺序；不能靠方法名存在就算核对过。
  let chat = await fresh(p);
  chat.inDoubtPrompts = [prompt('p1'), prompt('p2', 'B')];
  chat.inDoubtPerms = [{ requestId: 'm1', sessionId: 'A' }, { requestId: 'm2', sessionId: 'B' }];
  await chat.settleInDoubt();
  expect(p.call.mock.calls).toEqual([['state.outcomes', { refs: [{ kind: 'prompt', sessionId: 'A', promptId: 'p1' }, { kind: 'prompt', sessionId: 'B', promptId: 'p2' }, { kind: 'permission', requestId: 'm1' }, { kind: 'permission', requestId: 'm2' }] }]]);

  // 在途丢失保留提交的五个字段、气泡与运行态，另外两种错误分支按普通拒绝收口。
  for (const [syncOn, inFlight] of [[true, true], [false, true], [true, false]] as const) {
    chat = await fresh(p);
    chat.syncOn = syncOn;
    const gate = deferred();
    p.call.mockImplementation((m: string) => m === 'chat.prompt' ? gate.promise : minimalReply(m));
    const sending = chat.send('原样文本', ['a.txt', 'b.png']);
    expect(p.call.mock.calls).toHaveLength(1);
    const args = p.call.mock.calls[0][1];
    const bubble = JSON.parse(JSON.stringify(chat.messages.at(-1)));
    expect(p.call.mock.calls[0]).toEqual(['chat.prompt', { sessionId: 'A', text: '原样文本', attachments: ['a.txt', 'b.png'], promptId: expect.any(String) }]);
    gate.reject(inFlight ? markInFlightLoss(new Error('断线')) : new Error('普通拒绝'));
    await sending;
    await settleStore();
    if (syncOn && inFlight) {
      expect(chat.inDoubtPrompts).toEqual([{ sessionId: 'A', promptId: args.promptId, text: '原样文本', attachments: ['a.txt', 'b.png'], optimisticId: bubble.id }]);
      expect(chat.messages).toEqual([bubble]);
      expect(chat.running).toBe(true);
      expect(chat.runningSessions).toEqual(['A']);
      expect(chat.lastError).toBe('');
    } else {
      expect(chat.inDoubtPrompts).toEqual([]);
      expect(chat.messages).toEqual([]);
      expect(chat.running).toBe(false);
      expect(chat.runningSessions).toEqual([]);
      expect(chat.lastError).toBe(inFlight ? '断线' : '普通拒绝');
    }
    expect(p.call.mock.calls).toEqual([['chat.prompt', args]]);
  }
}
