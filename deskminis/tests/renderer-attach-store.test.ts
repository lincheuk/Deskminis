/**
 * F11A · 渲染端附件状态的接线：真跑 store 的动作、StageChat 与 PreviewPane 的 <script setup>（rpc 是桩）。
 *
 * renderer-attach-status.test.ts 里的源码守卫只证明「这几个调用写在那儿」，证明不了接得对。
 * 变异核对里有四处改坏了、那边的守卫照样全绿（work/logs/F11A-mutation.json 的 M71、M73、M74、M75）：
 *   - StageChat 把 chip 上的「取消」与「重试 / 下载」两个动作接反；
 *   - 重试没有真的发起（本机已暂停 / 没有设备在线 / 对方版本不支持）时，store 不把原因告诉用户；
 *   - 等 attachments.status 期间换了会话，旧会话迟到的状态盖到新会话上；
 *   - PreviewPane 把「图片用 data: 地址显示、其余进文本视图」的判断写反。
 * 这里按行为钉住这四处，顺带钉住：状态表按 relativePath 建、旧引擎没有这个方法时置空、attachments.changed 只刷当前会话、
 * 点开附件只在文件在本机时走附件的 guest 路径、「模型暂时看不到」的判据是本机有没有文件、
 * 预览区对附件 / docx / 老格式 / 工作区文件各走哪条读取路。
 *
 * 做法同 renderer-run-tracking / renderer-tool-steps：vi.mock 桩掉 rpc，store 真跑；两个组件经 tests/sfc-setup.ts 真跑 setup。
 * 桩不到的是模板本身（按钮画没画、disabled 生没生效、<img> 的 src 绑没绑），那一段仍靠源码守卫与实拍截图。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import * as vue from 'vue';

// ── 桩掉 renderer 的 rpc：call 走可控实现，on 把处理器收进 handlers，测试里直接派发广播 ──
const { rpcCallMock, handlers } = vi.hoisted(() => ({
  rpcCallMock: vi.fn(),
  handlers: new Map<string, (p: any) => void>(),
}));

vi.mock('../src/renderer/src/rpc', () => ({
  rpc: {
    call: rpcCallMock,
    connect: async () => {},
    on: (method: string, h: (p: any) => void) => { handlers.set(method, h); },
    off: () => {},
    onLost: vi.fn(),
  },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { createPinia, setActivePinia } from 'pinia';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';
// eslint-disable-next-line import/first
import { ATTACHMENT_GUEST_PREFIX, ATTACHMENT_STATE_TEXT, type AttachmentView } from '../src/shared/attachments';
// eslint-disable-next-line import/first
import { runSetup } from './sfc-setup';

const root = path.resolve(__dirname, '..');
const STAGE_FILE = path.join(root, 'src/renderer/src/ui/StageChat.vue');

const view = (name: string, over: Partial<AttachmentView> = {}): AttachmentView => ({
  name, relativePath: `attachments/${name}`, mimeType: 'image/png', state: 'ready', conflict: false,
  localAvailable: true, canRetry: false, canCancel: false, ...over,
});
const statusOf = (sessionId: string, items: AttachmentView[]) => ({ sessionId, syncPaused: false, items });

/** 每个会话的 attachments.status 怎么答：返回值、挂着不回的 Promise、或抛错（旧引擎没有这个方法）。 */
let status: Record<string, () => unknown>;
let retryResult: unknown;
let cancelFails: Error | undefined;
/** attachments.read 按附件名怎么答：结果对象，或 Error（被拒）。 */
let reads: Record<string, unknown>;
const OFFICE_DOC = { kind: 'docx', blocks: [] };

function stubRpc(): void {
  rpcCallMock.mockImplementation(async (method: string, params?: { sessionId?: string }) => {
    if (method === 'permission.getPreset') return { preset: 'ask' };
    if (method === 'chat.sessions.list') return [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }];
    if (method === 'provider.instances.list') return [];
    if (method === 'provider.getDefault') return {};
    if (method === 'modelgroup.list') return [];
    if (method === 'assistants.list') return [];
    if (method === 'skills.list') return [];
    if (method === 'control.status') return { syncPaused: false };
    if (method === 'chat.messages.list') return [];
    if (method === 'chat.annotations.list') return { annotations: [] };
    if (method === 'workspace.get') return { root: '/w', isDefault: true };
    if (method === 'attachments.status') return status[params?.sessionId ?? '']?.();
    if (method === 'attachments.retry') { if (retryResult instanceof Error) throw retryResult; return retryResult; }
    if (method === 'attachments.cancel') { if (cancelFails) throw cancelFails; return { ok: true }; }
    if (method === 'attachments.read') {
      const r = reads[(params as { name?: string } | undefined)?.name ?? ''];
      if (r instanceof Error) throw r;
      return r;
    }
    if (method === 'office.read') return OFFICE_DOC;
    if (method === 'files.read') return { path: (params as { path?: string } | undefined)?.path, size: 3, content: 'abc', truncated: false, binary: false };
    return undefined;
  });
}

/** 让挂着的微任务与零延时回调跑完（open() 里的刷新是 void，不被它 await）。 */
const tick = (): Promise<void> => new Promise(r => setTimeout(r, 0));
const statusCalls = (sid: string): number =>
  rpcCallMock.mock.calls.filter(c => c[0] === 'attachments.status' && c[1]?.sessionId === sid).length;
/** 发给引擎的附件动作（不含取状态），按发出的先后。 */
const actions = (): Array<[string, unknown]> =>
  rpcCallMock.mock.calls.filter(c => c[0] === 'attachments.retry' || c[0] === 'attachments.cancel').map(c => [c[0], c[1]]);
const keys = (chat: ReturnType<typeof useChat>): string[] => Object.keys(chat.attachmentViews).sort();

let scope = vue.effectScope();
beforeEach(() => {
  rpcCallMock.mockReset();
  handlers.clear();
  setActivePinia(createPinia());
  status = {};
  retryResult = { ok: true, started: true };
  cancelFails = undefined;
  reads = {};
  stubRpc();
  scope = vue.effectScope();
  // StageChat 的贴底 watch 走 requestAnimationFrame（node 里没有）
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = () => 0;
});
afterEach(() => { scope.stop(); });

describe('F11A store：附件状态表', () => {
  it('open()：取这个会话的 attachments.status，按 relativePath 建表；旧引擎没有这个方法时表是空的', async () => {
    status.A = () => statusOf('A', [view('a.png'), view('b.png', { state: 'pending', reason: 'queued', localAvailable: false })]);
    status.B = () => { throw new Error('未知方法: attachments.status'); };
    const chat = useChat();
    await chat.open('A');
    await tick();
    expect(keys(chat)).toEqual(['attachments/a.png', 'attachments/b.png']);
    expect(chat.attachmentViews['attachments/b.png']).toMatchObject({ name: 'b.png', state: 'pending', localAvailable: false });
    await chat.open('B');
    await tick();
    expect(chat.attachmentViews).toEqual({});
  });

  it('等 attachments.status 期间换了会话：旧会话迟到的应答不盖到新会话上', async () => {
    let answerA: (v: unknown) => void = () => {};
    status.A = () => new Promise(r => { answerA = r; });
    status.B = () => statusOf('B', [view('b.png')]);
    const chat = useChat();
    await chat.open('A');                    // A 的状态挂着没回
    await chat.open('B');
    await tick();
    expect(keys(chat)).toEqual(['attachments/b.png']);
    answerA(statusOf('A', [view('a.png', { state: 'failed', reason: 'hash_mismatch', localAvailable: false, canRetry: true })]));
    await tick();
    expect(chat.activeId).toBe('B');
    expect(keys(chat), 'A 的状态不该出现在 B 里').toEqual(['attachments/b.png']);
  });

  it('attachments.changed 与 synced 事件：只在是当前会话时重取状态', async () => {
    status.A = () => statusOf('A', [view('a.png')]);
    status.B = () => statusOf('B', [view('b.png')]);
    const chat = useChat();
    await chat.init();
    await chat.open('A');
    await tick();
    const changed = handlers.get('attachments.changed');
    expect(changed, 'init() 没有订阅 attachments.changed').toBeTypeOf('function');
    const base = statusCalls('A');
    changed!({ sessionId: 'B' });            // 别的会话的附件变了：不重取，也不串台
    await tick();
    expect(statusCalls('A')).toBe(base);
    expect(statusCalls('B')).toBe(0);
    status.A = () => statusOf('A', [view('a.png'), view('late.png', { state: 'transferring', localAvailable: false, size: 10, received: 5, canCancel: true })]);
    changed!({ sessionId: 'A' });
    await tick();
    expect(statusCalls('A')).toBe(base + 1);
    expect(keys(chat)).toEqual(['attachments/a.png', 'attachments/late.png']);
    // 同步来的消息可能带新的附件引用
    handlers.get('chat.event')!({ kind: 'synced', sessionId: 'A', mergedCount: 1, fromDevice: 'peer-fp' });
    await tick();
    expect(statusCalls('A')).toBe(base + 2);
    handlers.get('chat.event')!({ kind: 'synced', sessionId: 'B', mergedCount: 1, fromDevice: 'peer-fp' });
    await tick();
    expect(statusCalls('A')).toBe(base + 2);
    expect(statusCalls('B')).toBe(0);
  });
});

describe('F11A store：重试与取消', () => {
  it('重试没有真的发起时把原因写给用户看；发起了不写；两种情况都重取状态', async () => {
    status.A = () => statusOf('A', [view('a.png', { state: 'held', localAvailable: false, canRetry: true })]);
    const chat = useChat();
    await chat.open('A');
    await tick();
    const cases = [
      ['paused', ATTACHMENT_STATE_TEXT.paused],
      ['source_offline', ATTACHMENT_STATE_TEXT['pending/source_offline']],
      ['peer_unsupported', ATTACHMENT_STATE_TEXT['unavailable/peer_unsupported']],
    ] as const;
    for (const [reason, text] of cases) {
      retryResult = { ok: true, started: false, reason };
      chat.lastError = '';
      const before = statusCalls('A');
      await chat.retryAttachment('a.png');
      expect(text.length, reason).toBeGreaterThan(0);
      expect(chat.lastError, reason).toBe(text);
      expect(statusCalls('A'), reason).toBe(before + 1);
    }
    retryResult = { ok: true, started: true };
    chat.lastError = '';
    const before = statusCalls('A');
    await chat.retryAttachment('a.png');
    expect(chat.lastError).toBe('');
    expect(statusCalls('A')).toBe(before + 1);
    expect(actions().every(([m, p]) => m === 'attachments.retry' && JSON.stringify(p) === JSON.stringify({ sessionId: 'A', name: 'a.png' }))).toBe(true);
    expect(actions()).toHaveLength(4);
  });

  it('重试或取消被引擎拒绝：错误写给用户看，状态照样重取', async () => {
    status.A = () => statusOf('A', [view('a.png', { state: 'pending', reason: 'interrupted', localAvailable: false, canRetry: true, canCancel: true })]);
    const chat = useChat();
    await chat.open('A');
    await tick();
    retryResult = new Error('非法附件名');
    let before = statusCalls('A');
    await chat.retryAttachment('a.png');
    expect(chat.lastError).toBe('非法附件名');
    expect(statusCalls('A')).toBe(before + 1);
    cancelFails = new Error('minisd 未连接');
    chat.lastError = '';
    before = statusCalls('A');
    await chat.cancelAttachment('a.png');
    expect(chat.lastError).toBe('minisd 未连接');
    expect(statusCalls('A')).toBe(before + 1);
  });

  it('取消：发 attachments.cancel（当前会话、这个名字），随后重取状态；没有打开会话时什么都不发', async () => {
    const chat = useChat();
    await chat.retryAttachment('a.png');
    await chat.cancelAttachment('a.png');
    expect(actions()).toEqual([]);
    status.A = () => statusOf('A', [view('a.png', { state: 'transferring', localAvailable: false, canCancel: true })]);
    await chat.open('A');
    await tick();
    const before = statusCalls('A');
    status.A = () => statusOf('A', [view('a.png', { state: 'held', localAvailable: false, canRetry: true })]);
    await chat.cancelAttachment('a.png');
    expect(actions()).toEqual([['attachments.cancel', { sessionId: 'A', name: 'a.png' }]]);
    expect(statusCalls('A')).toBe(before + 1);
    expect(chat.attachmentViews['attachments/a.png'].state).toBe('held');
  });
});

// ── StageChat：chip 上的动作接到哪个 RPC（真跑 setup） ─────────────────────────────────────────
type StageBindings = {
  chipFor(a: { path: string }): { tone: string; label: string; open: boolean; action?: string };
  actionText(a: { path: string }): string;
  openAtt(a: { path: string }): void;
  actAtt(a: { path: string }): void;
  attsMissing(m: unknown): boolean;
};
const P = (name: string): { path: string } => ({ path: `attachments/${name}` });
const userMsg = (...names: string[]) => ({
  id: 'u1', role: 'user', createdAt: 1,
  parts: names.map(n => ({ type: 'mediaRef', value: { id: n, relativePath: `attachments/${n}`, mimeType: 'image/png' } })),
});

/** 当前会话 A，状态表由 items 给出（之后每次重取也回同一份，动作后的刷新不会把表清掉）。 */
async function runStage(items: AttachmentView[]): Promise<{ chat: ReturnType<typeof useChat>; b: StageBindings }> {
  status.A = () => statusOf('A', items);
  const chat = useChat();
  await chat.open('A');
  await tick();
  const { bindings } = await runSetup<StageBindings>(STAGE_FILE, { narrow: false }, scope);
  return { chat, b: bindings };
}

describe('F11A StageChat：chip 的动作与点开（真跑 setup）', () => {
  const ITEMS = [
    view('ready.png'),
    view('moving.png', { state: 'transferring', localAvailable: false, size: 100, received: 50, canCancel: true }),
    view('queued.png', { state: 'pending', reason: 'queued', localAvailable: false, canCancel: true }),
    view('held.png', { state: 'held', localAvailable: false, canRetry: true }),
    view('failed.png', { state: 'failed', reason: 'hash_mismatch', localAvailable: false, canRetry: true }),
    view('gone.png', { state: 'unavailable', reason: 'no_source', localAvailable: false, canRetry: true }),
    view('changed.png', { state: 'failed', reason: 'local_changed', localAvailable: true, canRetry: true }),
    view('old-peer.png', { state: 'unavailable', reason: 'peer_unsupported', localAvailable: false }),
  ];

  it('传输中 / 等待同步的 chip 点的是取消；未下载、失败、找不到来源、本机被改过的 chip 点的是重试；没有动作的 chip 什么都不发', async () => {
    const { b } = await runStage(ITEMS);
    const act = async (name: string): Promise<Array<[string, unknown]>> => {
      const from = actions().length;
      b.actAtt(P(name));
      await tick();
      return actions().slice(from);
    };
    // 按钮上的字与实际发出的动作要对得上
    expect(b.actionText(P('moving.png'))).toBe('取消');
    expect(await act('moving.png')).toEqual([['attachments.cancel', { sessionId: 'A', name: 'moving.png' }]]);
    expect(b.actionText(P('queued.png'))).toBe('取消');
    expect(await act('queued.png')).toEqual([['attachments.cancel', { sessionId: 'A', name: 'queued.png' }]]);
    expect(b.actionText(P('held.png'))).toBe('下载');
    expect(await act('held.png')).toEqual([['attachments.retry', { sessionId: 'A', name: 'held.png' }]]);
    for (const name of ['failed.png', 'gone.png', 'changed.png']) {
      expect(b.actionText(P(name)), name).toBe('重试');
      expect(await act(name), name).toEqual([['attachments.retry', { sessionId: 'A', name }]]);
    }
    for (const name of ['ready.png', 'old-peer.png', 'no-view.png']) {
      expect(b.actionText(P(name)), name).toBe('');
      expect(await act(name), name).toEqual([]);
    }
  });

  it('点开：文件在本机才开，走附件的 guest 路径；不在本机不开；没有状态（旧引擎）沿用原来的相对路径', async () => {
    const { chat, b } = await runStage(ITEMS);
    expect(chat.pendingFilePreview).toBeNull();
    for (const name of ['moving.png', 'held.png', 'failed.png', 'old-peer.png']) {
      expect(b.chipFor(P(name)).open, name).toBe(false);
      b.openAtt(P(name));
      expect(chat.pendingFilePreview, name).toBeNull();
    }
    b.openAtt(P('ready.png'));
    expect(chat.pendingFilePreview).toBe(`${ATTACHMENT_GUEST_PREFIX}ready.png`);
    // 文件在本机、只是这一份不同步：照样打得开
    expect(b.chipFor(P('changed.png')).open).toBe(true);
    b.openAtt(P('changed.png'));
    expect(chat.pendingFilePreview).toBe(`${ATTACHMENT_GUEST_PREFIX}changed.png`);
    b.openAtt(P('no-view.png'));
    expect(chat.pendingFilePreview).toBe('attachments/no-view.png');
  });

  it('「模型暂时看不到」：只在这条消息里有本机没有的附件时提示；文件在本机而不同步、或没有状态时不提示', async () => {
    const { b } = await runStage(ITEMS);
    expect(b.attsMissing(userMsg('ready.png'))).toBe(false);
    expect(b.attsMissing(userMsg('ready.png', 'moving.png'))).toBe(true);
    expect(b.attsMissing(userMsg('failed.png'))).toBe(true);
    expect(b.attsMissing(userMsg('changed.png'))).toBe(false);      // 状态是失败，但文件就在本机，模型读得到
    expect(b.attsMissing(userMsg('no-view.png'))).toBe(false);
    expect(b.attsMissing(userMsg())).toBe(false);
  });
});

// ── PreviewPane：附件走哪条读取路、读回来的东西进哪个视图（真跑 setup） ─────────────────────────
// 变异核对的 M75：把「图片进 <img>、其余进文本视图」的判断写反，renderer-attach-status 的守卫（只看那几个调用在不在）全绿，
// 接收端点开同步来的图片看到的却是一屏乱码。
const PREVIEW_FILE = path.join(root, 'src/renderer/src/ui/PreviewPane.vue');
type PreviewBindings = {
  data: { value: { path: string; size: number; content: string; truncated: boolean; binary: boolean } | null };
  officeDoc: { value: unknown };
  failed: { value: string };
  officeFailed: { value: string };
  attImgSrc: { value: string };
  attTooBig: { value: boolean };
  loading: { value: boolean };
};
const ATT = (name: string): string => `${ATTACHMENT_GUEST_PREFIX}${name}`;
const b64 = (s: string | Buffer): string => Buffer.from(s).toString('base64');
const readOk = (name: string, mimeType: string, body: Buffer | undefined, size = body?.length ?? 9 * 1024 * 1024) => ({
  name, mimeType, size, localPath: `C:\\data\\sessions\\A\\attachments\\${name}`, ...(body ? { base64: b64(body) } : {}),
});
/** 预览区发出的读取调用（哪条路、什么参数），按先后。 */
const readCalls = (): Array<[string, unknown]> =>
  rpcCallMock.mock.calls.filter(c => c[0] === 'attachments.read' || c[0] === 'office.read' || c[0] === 'files.read').map(c => [c[0], c[1]]);

/** 当前会话 A，预览 p：setup 里的 watch(immediate) 立刻去读，等它读完。 */
async function runPreview(p: string): Promise<PreviewBindings> {
  const chat = useChat();
  chat.activeId = 'A';
  rpcCallMock.mockClear();
  const { bindings } = await runSetup<PreviewBindings>(PREVIEW_FILE, { path: p }, scope);
  await tick();
  expect(bindings.loading.value).toBe(false);
  return bindings;
}

describe('F11A PreviewPane：打开附件（真跑 setup）', () => {
  it('图片附件：经 attachments.read 读本机附件桶，用 data: 地址显示，不进文本视图', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    reads['pic.png'] = readOk('pic.png', 'image/png', png);
    const p = await runPreview(ATT('pic.png'));
    expect(readCalls()).toEqual([['attachments.read', { sessionId: 'A', name: 'pic.png' }]]);
    expect(p.attImgSrc.value).toBe(`data:image/png;base64,${b64(png)}`);
    expect(p.data.value).toBeNull();
    expect(p.attTooBig.value).toBe(false);
    expect(p.failed.value).toBe('');
  });

  it('文本附件进文本视图；二进制附件标成二进制、不当文本显示；两者都不当图片', async () => {
    reads['notes.txt'] = readOk('notes.txt', 'text/plain', Buffer.from('第一行\nsecond line'));
    const text = await runPreview(ATT('notes.txt'));
    expect(readCalls()).toEqual([['attachments.read', { sessionId: 'A', name: 'notes.txt' }]]);
    expect(text.attImgSrc.value).toBe('');
    expect(text.data.value).toEqual({ path: ATT('notes.txt'), size: Buffer.byteLength('第一行\nsecond line'), content: '第一行\nsecond line', truncated: false, binary: false });

    reads['blob.bin'] = readOk('blob.bin', 'application/octet-stream', Buffer.from([1, 2, 0, 3]));
    const bin = await runPreview(ATT('blob.bin'));
    expect(bin.attImgSrc.value).toBe('');
    expect(bin.data.value).toMatchObject({ binary: true, content: '' });
  });

  it('超过应用内预览上限（引擎不带 base64）：既不显示图片也不进文本视图，标成太大', async () => {
    reads['big.png'] = readOk('big.png', 'image/png', undefined);
    const p = await runPreview(ATT('big.png'));
    expect(p.attTooBig.value).toBe(true);
    expect(p.attImgSrc.value).toBe('');
    expect(p.data.value).toBeNull();
  });

  it('docx 附件走 office.read（guest 路径原样传）；老版 Office 与 PDF 不读内容；工作区文件仍走 files.read', async () => {
    const docx = await runPreview(ATT('report.docx'));
    expect(readCalls()).toEqual([['office.read', { sessionId: 'A', path: ATT('report.docx') }]]);
    expect(docx.officeDoc.value).toEqual(OFFICE_DOC);

    const pdf = await runPreview(ATT('old.pdf'));
    expect(readCalls()).toEqual([]);
    expect(pdf.data.value).toBeNull();
    expect(pdf.attImgSrc.value).toBe('');

    const ws = await runPreview('notes/a.md');
    expect(readCalls()).toEqual([['files.read', { sessionId: 'A', path: 'notes/a.md' }]]);
    expect(ws.data.value).toMatchObject({ path: 'notes/a.md', content: 'abc' });
    expect(ws.attImgSrc.value).toBe('');
  });

  it('附件还没同步到本机（attachments.read 被拒）：把引擎的那句话显示出来，不显示任何内容', async () => {
    reads['late.png'] = new Error('附件尚未同步到本机');
    const p = await runPreview(ATT('late.png'));
    expect(readCalls()).toEqual([['attachments.read', { sessionId: 'A', name: 'late.png' }]]);
    expect(p.failed.value).toBe('附件尚未同步到本机');
    expect(p.attImgSrc.value).toBe('');
    expect(p.data.value).toBeNull();
  });
});
