/**
 * F11A · 附件 chip 的状态映射与渲染端接线（设计 §4.12、§4.13）。
 *
 * 钉住的行为：
 *   ① chipOf：能不能点开只看本机有没有文件（localAvailable），与同步状态无关；
 *      未同步 / 传输中 / 失败都有可见的文案，能重试的给「重试」、被取消过的给「下载」、在途的给「取消」。
 *   ② 没有状态（旧引擎）时 chip 与以前一样。
 *   ③ 源码守卫：对话流用附件的 guest 路径开预览并接了重试 / 取消；预览区有附件分支；store 订阅了变更通知；
 *      设备页、README 不再说附件不同步。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const { _rpcCall, _rpcOn, _handlers, _rpcLost, _rpcConnect } = vi.hoisted(() => {
  const handlers = new Map<string, (params: any) => unknown>();
  return { _rpcCall: vi.fn(), _rpcOn: vi.fn((method: string, handler: (params: any) => unknown) => { handlers.set(method, handler); }), _handlers: handlers, _rpcLost: vi.fn(), _rpcConnect: vi.fn(async () => {}) };
});
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: _rpcCall, on: _rpcOn, onLost: _rpcLost, connect: _rpcConnect } }));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATTACHMENT_CONFLICT_TEXT, ATTACHMENT_STATE_TEXT, type AttachmentReason, type AttachmentState, type AttachmentView } from '../src/shared/attachments';
import { chipOf, decodeAttachmentText, retryNote, CHIP_ACTION_TEXT } from '../src/renderer/src/lib/attach/status';

import { resetStoreRpc, initStore, settleStore, dispatchStore, deferred, openCalls, minimalReply } from './renderer-store-fixture';

const ROOT = join(__dirname, '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

function view(state: AttachmentState, reason?: AttachmentReason, patch: Partial<AttachmentView> = {}): AttachmentView {
  return {
    name: 'paste-1.png', relativePath: 'attachments/paste-1.png', mimeType: 'image/png',
    state, reason, conflict: false, localAvailable: state === 'ready', canRetry: false, canCancel: false, ...patch,
  };
}

const _probe = { call: _rpcCall, on: _rpcOn, handlers: _handlers, lost: _rpcLost, connect: _rpcConnect };
// 每例使用新的真实 Pinia；RPC 桩只记调用与订阅，由用例放行应答。
beforeEach(() => { resetStoreRpc(_probe); });
afterEach(() => { vi.restoreAllMocks(); });

describe('F11A chipOf', () => {
  it('没有状态（旧引擎、还没取到）：没有小字，可以点', () => {
    expect(chipOf(undefined)).toEqual({ tone: 'ok', label: '', title: '', open: true });
  });

  it('ready：没有小字、可以打开；有冲突时带说明', () => {
    expect(chipOf(view('ready'))).toEqual({ tone: 'ok', label: '', title: '', open: true });
    expect(chipOf(view('ready', undefined, { conflict: true }))).toEqual({ tone: 'warn', label: '', title: ATTACHMENT_CONFLICT_TEXT, open: true });
  });

  it('传输中：百分比 + 取消；本机还没有文件，点不开', () => {
    const c = chipOf(view('transferring', undefined, { size: 4000, received: 1000, canCancel: true }));
    expect(c).toMatchObject({ tone: 'wait', label: '传输中 25%', open: false, action: 'cancel' });
    expect(chipOf(view('transferring', undefined, { size: 4000, received: 4000 })).label).toBe('传输中 99%');   // 校验发布之前不显示 100%
    expect(chipOf(view('transferring')).label).toBe('传输中 0%');
  });

  it('每种未同步 / 失败 / 不可用的状态都有文案，动作按 canRetry / canCancel 给', () => {
    const cases: Array<[AttachmentState, AttachmentReason | undefined, Partial<AttachmentView>, string, string | undefined]> = [
      ['pending', 'queued', { canCancel: true }, '等待同步', 'cancel'],
      ['pending', 'interrupted', { canRetry: true, canCancel: true }, '传输中断，会自动续传', 'retry'],
      ['pending', 'source_offline', { canRetry: true, canCancel: true }, '未同步：没有已配对设备在线', 'retry'],
      ['pending', 'peer_paused', { canRetry: true, canCancel: true }, '未同步：对方暂停了同步', 'retry'],
      ['paused', undefined, {}, '未同步：本机已暂停同步', undefined],
      ['held', undefined, { canRetry: true }, '未下载', 'download'],
      ['failed', 'hash_mismatch', { canRetry: true }, '同步失败：内容校验不通过', 'retry'],
      ['failed', 'bad_chunk', { canRetry: true }, '同步失败：对方的应答不合规', 'retry'],
      ['failed', 'io_error', { canRetry: true }, '同步失败：写入本机磁盘出错', 'retry'],
      ['failed', 'name_conflict', { canRetry: true }, '同步失败：本机已有同名但内容不同的文件', 'retry'],
      ['unavailable', 'peer_unsupported', {}, '不可用：对方的版本不支持附件同步', undefined],
      ['unavailable', 'no_source', { canRetry: true }, '不可用：在线的设备上没有这个文件', 'retry'],
      ['unavailable', 'too_large', {}, '不可用：超过 32 MB 上限', undefined],
      ['unavailable', 'quota', { canRetry: true }, '不可用：这个会话的附件已到上限', 'retry'],
      ['unavailable', 'bad_reference', {}, '不可用：引用的文件名不合规', undefined],
    ];
    for (const [state, reason, patch, label, action] of cases) {
      const c = chipOf(view(state, reason, patch));
      expect(c.label, `${state}/${reason}`).toBe(label);
      expect(c.action, `${state}/${reason}`).toBe(action);
      expect(c.open, `${state}/${reason}：本机没有文件就不能点开`).toBe(false);
      expect(c.tone).toBe(state === 'failed' || state === 'unavailable' ? 'err' : 'wait');
    }
    expect(CHIP_ACTION_TEXT).toEqual({ retry: '重试', download: '下载', cancel: '取消' });
  });

  it('「等待同步」而引擎说不能取消（还没有行：取消记不下任何东西）：只有文案，没有按钮', () => {
    const c = chipOf(view('pending', 'queued', { canRetry: false, canCancel: false }));
    expect(c).toMatchObject({ tone: 'wait', label: '等待同步', open: false });
    expect(c.action).toBeUndefined();
  });

  it('文件名不合规但文件在本机（模型读得到）：能打开，文案是「本机可用…不同步」，没有按钮', () => {
    const c = chipOf(view('unavailable', 'bad_reference', { localAvailable: true }));
    expect(c).toMatchObject({ open: true, tone: 'warn', label: ATTACHMENT_STATE_TEXT['local/bad_reference'] });
    expect(c.label).toBe('本机可用；文件名不合规，不同步到其它设备');
    expect(c.action).toBeUndefined();
  });

  it('open 只跟 localAvailable 走：文件在本机而这一份不同步时照样能打开，文案取 local/*', () => {
    const changed = chipOf(view('failed', 'local_changed', { localAvailable: true, canRetry: true }));
    expect(changed).toMatchObject({ open: true, tone: 'warn', label: ATTACHMENT_STATE_TEXT['failed/local_changed'], action: 'retry' });
    const conflict = chipOf(view('failed', 'name_conflict', { localAvailable: true, canRetry: false, conflict: true }));
    expect(conflict).toMatchObject({ open: true, tone: 'warn', label: ATTACHMENT_STATE_TEXT['local/name_conflict'] });
    expect(conflict.action).toBeUndefined();
    const big = chipOf(view('unavailable', 'too_large', { localAvailable: true }));
    expect(big).toMatchObject({ open: true, tone: 'warn', label: ATTACHMENT_STATE_TEXT['local/too_large'] });
    const other = chipOf(view('failed', 'io_error', { localAvailable: true, canRetry: true }));
    expect(other.label).toBe(`${ATTACHMENT_STATE_TEXT['failed/io_error']}${ATTACHMENT_STATE_TEXT['local/suffix']}`);
    expect(other.open).toBe(true);
    // 反过来：状态看着像本机问题、但本机没有文件，就是点不开
    expect(chipOf(view('failed', 'local_changed', { localAvailable: false })).open).toBe(false);
  });

  it('retryNote：没有真的发起时给出原因；发起了是空串', () => {
    expect(retryNote({ ok: true, started: true })).toBe('');
    expect(retryNote({ ok: true, started: false, reason: 'paused' })).toBe('未同步：本机已暂停同步');
    expect(retryNote({ ok: true, started: false, reason: 'source_offline' })).toBe('未同步：没有已配对设备在线');
    expect(retryNote({ ok: true, started: false, reason: 'peer_unsupported' })).toBe('不可用：对方的版本不支持附件同步');
    expect(retryNote(undefined)).toBe('');
  });

  it('decodeAttachmentText：文本解成 UTF-8；前 8KB 含 NUL 即二进制；坏 base64 当二进制', () => {
    expect(decodeAttachmentText(Buffer.from('你好，附件', 'utf8').toString('base64'))).toEqual({ content: '你好，附件', binary: false });
    expect(decodeAttachmentText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]).toString('base64'))).toEqual({ content: '', binary: true });
    expect(decodeAttachmentText('***')).toEqual({ content: '', binary: true });
    const late = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0])]);
    expect(decodeAttachmentText(late.toString('base64')).binary).toBe(false);      // NUL 在 8KB 之后：仍按文本
  });
});

describe('F11A 渲染端接线（源码守卫）', () => {
  const stage = read('src/renderer/src/ui/StageChat.vue');
  const preview = read('src/renderer/src/ui/PreviewPane.vue');

  it('对话流：chip 按状态渲染，用附件的 guest 路径开预览，接了重试与取消；不在历史 chip 上读附件字节', () => {
    expect(stage).toContain('chipOf(chat.attachmentViews[a.path])');
    expect(stage).toContain('chat.pendingFilePreview = ATTACHMENT_GUEST_PREFIX + view.name');
    expect(stage).toContain('chat.retryAttachment(view.name)');
    expect(stage).toContain('chat.cancelAttachment(view.name)');
    expect(stage).toMatch(/:disabled="!chipFor\(a\)\.open"/);
    expect(stage).toMatch(/v-if="chipFor\(a\)\.action"[^>]*@click="actAtt\(a\)"/);
    expect(stage).not.toContain('attachments.read');
  });

  it('「模型暂时看不到」一句的判据是本机有没有文件（localAvailable），不是同步状态', () => {
    const fn = stage.slice(stage.indexOf('function attsMissing('), stage.indexOf('function attsMissing(') + 260);
    expect(fn).toContain('!v.localAvailable');
    expect(fn).not.toMatch(/\.state\b/);
    expect(stage).toMatch(/v-if="attsMissing\(t\.user\)"[^>]*>\{\{ ATTACHMENT_MODEL_HINT \}\}/);
    expect(read('src/shared/attachments.ts')).toContain("ATTACHMENT_MODEL_HINT = '未同步到本机的附件，模型暂时看不到'");
  });

  it('预览区：附件走 attachments.read（图片用 data: 地址），OOXML 仍走 office.read；工作区文件的路不变', () => {
    expect(preview).toContain('startsWith(ATTACHMENT_GUEST_PREFIX)');
    expect(preview).toContain("rpc.call('attachments.read', { sessionId: chat.activeId, name: attName.value })");
    expect(preview).toContain('`data:${r.mimeType};base64,${r.base64}`');
    expect(preview).toContain('decodeAttachmentText(r.base64)');
    expect(preview).toContain("rpc.call('office.read', { sessionId: chat.activeId, path: props.path })");
    expect(preview).toContain("rpc.call('files.read', { sessionId: chat.activeId, path: props.path })");
  });

  it('store：订阅 attachments.changed，open() 与 synced 事件里刷新；旧引擎没有这个方法时状态表置空', async () => {
    // open 与两个广播入口真实刷新，逐个核对 session 参数和回流 state。
    const chat = await initStore(_probe);
    const item = { relativePath: 'attachments/a.png', state: 'ready', localAvailable: true };
    _rpcCall.mockImplementation(method => method === 'attachments.status' ? Promise.resolve({ items: [item] }) : minimalReply(method));
    await chat.open('A');
    await settleStore();
    expect(_rpcCall.mock.calls).toEqual(openCalls('A'));
    expect(chat.attachmentViews).toEqual({ 'attachments/a.png': item });
    expect(_rpcOn.mock.calls.filter(c => c[0] === 'attachments.changed')).toHaveLength(1);
    _rpcCall.mockClear();
    await dispatchStore(_probe, 'attachments.changed', { sessionId: 'A' });
    expect(_rpcCall.mock.calls).toEqual([['attachments.status', { sessionId: 'A' }]]);
    _rpcCall.mockClear();
    await dispatchStore(_probe, 'chat.event', { kind: 'synced', sessionId: 'A', mergedCount: 2, fromDevice: 'peerABC' });
    expect(_rpcCall.mock.calls).toEqual([['chat.sessions.list'], ['attachments.status', { sessionId: 'A' }]]);
    _rpcCall.mockClear();
    await dispatchStore(_probe, 'attachments.changed', { sessionId: 'B' });
    await dispatchStore(_probe, 'chat.event', { kind: 'synced', sessionId: 'B', mergedCount: 2, fromDevice: 'peerABC' });
    expect(_rpcCall.mock.calls).toEqual([['chat.sessions.list']]);

    // 旧引擎拒绝 status 被 try/catch 兜住；无会话与切走的在途应答也不串台。
    _rpcCall.mockRejectedValueOnce(new Error('unknown status'));
    await expect(chat.refreshAttachments()).resolves.toBeUndefined();
    expect(chat.attachmentViews).toEqual({});
    const pending = deferred();
    _rpcCall.mockReturnValueOnce(pending.promise);
    const refreshing = chat.refreshAttachments();
    chat.activeId = 'B';
    pending.resolve({ items: [item] });
    await refreshing;
    expect(chat.attachmentViews).toEqual({});
    chat.activeId = '';
    _rpcCall.mockClear();
    await chat.refreshAttachments();
    expect(_rpcCall.mock.calls).toEqual([]);

    // 重试与取消两个动作完整参数；失败也在动作完成后给确定结论。
    chat.activeId = 'A';
    _rpcCall.mockClear();
    _rpcCall.mockResolvedValueOnce({ started: true });
    await chat.retryAttachment('a.png');
    expect(_rpcCall.mock.calls[0]).toEqual(['attachments.retry', { sessionId: 'A', name: 'a.png' }]);
    expect(_rpcCall.mock.calls.slice(1)).toEqual([['attachments.status', { sessionId: 'A' }]]);
    _rpcCall.mockClear();
    await chat.cancelAttachment('a.png');
    expect(_rpcCall.mock.calls).toEqual([['attachments.cancel', { sessionId: 'A', name: 'a.png' }], ['attachments.status', { sessionId: 'A' }]]);
  });

  it('文案照实说：设备页与 README 说附件会传到对方、对方版本不支持时不可用；不再说附件不同步', () => {
    const devices = read('src/renderer/src/ui/StageDevices.vue');
    expect(devices).toContain('消息里的附件也会传到对方（两台都要是支持附件同步的版本）；设置、记忆文件不同步。');
    expect(devices).not.toContain('记忆文件和附件不同步');
    const readme = readFileSync(join(ROOT, '..', 'README.md'), 'utf8');
    const row = readme.split('\n').find(l => l.startsWith('| 设备同步 |'))!;
    expect(row).toContain('消息里的附件在两台设备都是支持附件同步的版本时，经同一条加密连接传到对方');
    expect(row).toContain('对方版本不支持时显示为不可用');
    expect(row).toContain('记忆文件与设置不同步');
    expect(row).not.toContain('附件文件与设置不同步');
    const changelog = readFileSync(join(ROOT, '..', 'CHANGELOG.md'), 'utf8');
    const known = changelog.slice(changelog.indexOf('### 已知边界'), changelog.indexOf('## 0.2.0'));
    expect(known).toContain('界面只能添加图片附件');
    expect(known).toContain('真实双机验证待做');
  });
});
