/** MU2a Task 10：权限卡 v2（设计 §5.2 + 审计 H2/H3/X-7）。
 *  纯模块 lib/perm/copy.ts（8 例）+ lib/perm/countdown.ts（2 例）
 *  + PermissionCard.vue/chat.ts 源文本守卫（含超时留条 2 例——守卫并入计数）。
 *  守卫工具：源文本读取统一归一化 CRLF→LF。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const { _rpcCall, _rpcOn, _handlers, _rpcLost, _rpcConnect } = vi.hoisted(() => {
  const handlers = new Map<string, (params: any) => unknown>();
  return { _rpcCall: vi.fn(), _rpcOn: vi.fn((method: string, handler: (params: any) => unknown) => { handlers.set(method, handler); }), _handlers: handlers, _rpcLost: vi.fn(), _rpcConnect: vi.fn(async () => {}) };
});
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: _rpcCall, on: _rpcOn, onLost: _rpcLost, connect: _rpcConnect } }));

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { permTitle, permTriggerLabel } from '../src/renderer/src/lib/perm/copy';
import { remainSeconds, countdownTone } from '../src/renderer/src/lib/perm/countdown';
import { stripComments } from './strip-comments';

import { toRaw } from 'vue';
import { resetStoreRpc, initStore, dispatchStore, type Equal, type Chat, type PendingCard } from './renderer-store-fixture';
import { prepareRun, RUN_ORIGINS, type RunOrigin } from './renderer-store-events';

import type { PermissionResolvedReason } from '../src/shared/permission';

const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const permCard = R('../src/renderer/src/ui/PermCard.vue');

const _probe = { call: _rpcCall, on: _rpcOn, handlers: _handlers, lost: _rpcLost, connect: _rpcConnect };
// 每例初始化真实 Pinia，记录桩；固定时钟用于事件 timestamp 与 deadline，不以墙钟上界判未发生。
beforeEach(() => {
  resetStoreRpc(_probe);
  vi.spyOn(Date, 'now').mockReturnValue(10000);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('MU2a Task 10 permTitle（8 例）', () => {
  it('bridge-notify → 请求发送通知', () => { expect(permTitle('bridge-notify')).toBe('请求发送通知'); });
  it('bridge-clipboard-read → 请求读取剪贴板', () => { expect(permTitle('bridge-clipboard-read')).toBe('请求读取剪贴板'); });
  it('bridge-clipboard-write → 请求写入剪贴板', () => { expect(permTitle('bridge-clipboard-write')).toBe('请求写入剪贴板'); });
  it('bridge-open → 请求打开链接或文件', () => { expect(permTitle('bridge-open')).toBe('请求打开链接或文件'); });
  it('bridge-speak → 请求语音播报', () => { expect(permTitle('bridge-speak')).toBe('请求语音播报'); });
  it('bridge-screenshot → 请求截屏', () => { expect(permTitle('bridge-screenshot')).toBe('请求截屏'); });
  it('bridge-device → 请求读取设备信息', () => { expect(permTitle('bridge-device')).toBe('请求读取设备信息'); });
  it('web-fetch → 请求访问网络（perm/copy.ts 两处文案守卫：标题 + 触发短标）', () => {
    expect(permTitle('web-fetch')).toBe('请求访问网络');
    expect(permTriggerLabel('web-fetch')).toBe('访问网络权限');
  });
  it('既有三类保留 + 未知 kind 兜底「请求权限」', () => {
    expect(permTitle('shell')).toBe('请求执行命令');
    expect(permTitle('file-write')).toBe('请求写入文件');
    expect(permTitle('file-read')).toBe('请求读取文件');
    expect(permTitle('mystery')).toBe('请求权限');
  });
});

describe('MU2a Task 10 双段告知短标 + 倒计时（4 例）', () => {
  it('permTriggerLabel：桥七类「xx 权限」短标，未知兜底「权限」', () => {
    expect(permTriggerLabel('bridge-notify')).toBe('通知权限');
    expect(permTriggerLabel('bridge-clipboard-read')).toBe('读取剪贴板权限');
    expect(permTriggerLabel('bridge-clipboard-write')).toBe('写入剪贴板权限');
    expect(permTriggerLabel('bridge-open')).toBe('打开链接或文件权限');
    expect(permTriggerLabel('bridge-speak')).toBe('语音播报权限');
    expect(permTriggerLabel('bridge-screenshot')).toBe('截屏权限');
    expect(permTriggerLabel('bridge-device')).toBe('读取设备信息权限');
    expect(permTriggerLabel('mystery')).toBe('权限');
  });
  it('remainSeconds：ceil 取整 + clamp ≥0', () => {
    expect(remainSeconds(100_000, 0)).toBe(100);
    expect(remainSeconds(10_500, 10_000)).toBe(1); // 0.5s .ceil→1
    expect(remainSeconds(9_000, 10_000)).toBe(0); // 负值钳到 0
  });
  it('countdownTone：≤10s urgent，其余 normal', () => {
    expect(countdownTone(90)).toBe('normal');
    expect(countdownTone(11)).toBe('normal');
    expect(countdownTone(10)).toBe('urgent');
    expect(countdownTone(0)).toBe('urgent');
  });
});

describe('MU2a Task 10 PermissionCard.vue 守卫', () => {
  it('倒计时读秒：remain 驱动 + mono 字体 + urgent ≤10s 变橙（--c-warn）', () => {
    expect(permCard).toContain('remainSeconds(');
    expect(permCard).toContain('countdownTone(');
    expect(permCard).toContain('remain');
    expect(permCard).toContain('setInterval');
    expect(permCard).toContain('clearInterval'); // unmount 清定时器
    expect(permCard).toContain('--f-mono');
    expect(permCard).toContain('urgent');
    expect(permCard).toContain('--c-warn');
  });
  it('盾牌分级：danger --c-err / 其余 --c-warn + 分级副文案', () => {
    expect(permCard).toContain("riskClass === 'danger'");
    expect(permCard).toContain('--c-err');
    expect(permCard).toContain('高风险操作');
    expect(permCard).toContain('需要你的批准');
  });
  it('标题经 permTitle( 映射（七类桥 + 既有三类）', () => {
    expect(permCard).toContain('permTitle(');
  });
  it('双段告知块：bridgeTriggers?.length 时才渲染「此命令将触发」列表', () => {
    expect(permCard).toContain('此命令将触发');
    expect(permCard).toContain('perm.bridgeTriggers?.length');
    expect(permCard).toContain('permTriggerLabel(');
  });
  it('按钮三枚：允许（--c-brand 实底主钮）/ 本会话允许 / 拒绝；预选 .pre 2px --c-brand 边框', async () => {
    expect(permCard).toContain('允许');
    expect(permCard).toContain('本会话允许');
    expect(permCard).toContain('拒绝');
    expect(permCard).toContain("'allow-once'");
    expect(permCard).toContain("'allow-session'");
    expect(permCard).toContain("'deny'");
    // 主钮实底 + 预选 2px 边框
    expect(R('../src/renderer/src/styles/theme.css')).toMatch(/\.f-btn\.primary[^}]*background:\s*var\(--c-brand\)/);
    // 预选环从 border 换成了 box-shadow：观感一样，但 border 会把按钮撑大 2px、
    // 让预选项与另两枚不等高。锚「有 2px 品牌色环、且不改布局」这个意图。
    expect(permCard).toMatch(/\.pb\.pre[^}]*box-shadow:[^}]*2px var\(--c-brand\)/);
    expect(permCard).not.toMatch(/\.pb\.pre[^}]*border:\s*2px/);
    // W8：四档只有session预选本会话允许；以真实store/SFC推导验证。
    const { runSetup } = await import('./sfc-setup');
    const { effectScope } = await import('vue');
    const { useChat } = await import('../src/renderer/src/stores/chat');
    const chat = await initStore(_probe);
    const view = await runSetup<any>(resolve(__dirname, '../src/renderer/src/ui/PermCard.vue'), { perm: { requestId: 'r', kind: 'web-fetch', detail: 'x' } }, effectScope());
    try { for (const tier of ['ask', 'session', 'plan', 'full'] as const) { chat.permTier = tier; expect(view.bindings.preselect.value).toBe(tier === 'session' ? 'allow-session' : 'allow-once'); } }
    finally { view.unmount(); }
  });
  it('既有锚不回归：逐字完整 detail 区 + respondPerm 接线', () => {
    expect(permCard).toContain('perm.detail');
    expect(permCard).toContain('chat.respondPerm(perm.requestId');
    expect(permCard).toContain('word-break: break-all');
  });
  it('按钮不折字：.btn nowrap + min-width、.btns flex-wrap（窄列下按钮整颗换行而非文字断行）', () => {
    // 「本会话允许」在 336px 对话列里曾被折成「本会话允/许」两行——文字断行比按钮换行难看得多
    // 按钮样式换壳后收归 theme.css 的全局原语 .f-btn，卡片里只留容器规则
    const theme = R('../src/renderer/src/styles/theme.css');
    expect(theme).toMatch(/\.f-btn \{[^}]*white-space:\s*nowrap/);
    // min-width 不再需要：.f-btn 是 flex:0 0 auto，宽度由内容决定，配 nowrap 已经压不扁
    expect(permCard).toMatch(/\.btns\s*\{[^}]*flex-wrap:\s*wrap/);
  });
});

describe('MU2a Task 10 chat.ts 守卫', () => {
  it('PendingPerm 扩字段 + permission.request 并入 meta + deadlineMs push 时计算', async () => {
    // 全部卡片字段类型精确比较；meta 三个取值与 push 当时的 deadline。
    const cardType: true = true as Equal<Chat['pendingPerms'][number], PendingCard>;
    expect(cardType).toBe(true);
    const chat = await initStore(_probe);
    const req = { sessionId: 'A', detail: 'full detail', kind: 'file-write', toolTitle: 'write', preview: { oldText: 'old', newText: 'new' }, note: 'warning' };
    for (const timeoutMs of [0, 2000, undefined]) {
      vi.mocked(Date.now).mockReturnValue(10000);
      const meta = { timeoutMs, riskClass: 'danger', bridgeTriggers: ['clipboard', 'open'] };
      await dispatchStore(_probe, 'permission.request', { requestId: 'R', req, meta });
      expect(chat.pendingPerms).toHaveLength(1);
      expect(chat.pendingPerms[0]).toEqual({ requestId: 'R', sessionId: 'A', detail: 'full detail', kind: 'file-write', toolTitle: 'write', timeoutMs, riskClass: 'danger', bridgeTriggers: ['clipboard', 'open'], preview: req.preview, note: 'warning', deadlineMs: timeoutMs === undefined ? undefined : 10000 + timeoutMs });
      expect(toRaw(chat.pendingPerms[0].preview)).toBe(req.preview);
      expect(toRaw(chat.pendingPerms[0].bridgeTriggers)).toBe(meta.bridgeTriggers);
      vi.mocked(Date.now).mockReturnValue(50000);
      expect(chat.pendingPerms[0].deadlineMs).toBe(timeoutMs === undefined ? undefined : 10000 + timeoutMs);
    }
    expect(_rpcOn.mock.calls.filter(c => c[0] === 'permission.request')).toHaveLength(1);
    expect(_rpcCall.mock.calls).toEqual([]);
  });
  it('超时留条：resolved reason===timeout → 摘卡 + eventNotes 追加「权限请求已超时，自动拒绝」（retryable:false）', async () => {
    // 当前会话、其它会话、未知卡三种归属；每个长度边界均等 resolved 回调完成再检查。
    for (const owner of ['A', 'B', 'missing'])
      for (const n of [0, 9, 10, 11]) {
        resetStoreRpc(_probe);
        const chat = await initStore(_probe);
        chat.activeId = 'A';
        if (owner !== 'missing')
          await dispatchStore(_probe, 'permission.request', { requestId: 'R', req: { sessionId: owner, detail: 'd', kind: 'file', toolTitle: 't' }, meta: {} });
        await dispatchStore(_probe, 'permission.request', { requestId: 'other', req: { sessionId: 'A', detail: 'other', kind: 'file', toolTitle: 't' }, meta: {} });
        const old = Array.from({ length: n }, (_, i) => ({ kind: 'retry' as const, ts: i, detail: 'old-' + i }));
        chat.eventNotes = old;
        await dispatchStore(_probe, 'permission.resolved', { requestId: 'R', reason: 'timeout' });
        expect(chat.pendingPerms.map(p => p.requestId)).toEqual(['other']);
        expect(chat.eventNotes).toEqual(owner === 'A' ? [...old.slice(-9), { kind: 'error', ts: 10000, detail: '权限请求已超时，自动拒绝', retryable: false }] : old);
        expect(_rpcCall.mock.calls).toEqual([]);
      }
  });
  it('answered/无 reason → 只摘卡不补条（分流结构存在，摘卡 filter 未删）', async () => {

    // reason 全集 × 当前/其它/未知卡 × 三个运行来源；回调完成之后核对禁止的写入。
    const reasons = { answered: false, timeout: true, cancelled: false, 'session-deleted': false, shutdown: false, invalidated: false } satisfies Record<PermissionResolvedReason, boolean>;
    for (const reason of [...Object.keys(reasons), undefined]) {
      for (const owner of ['A', 'B', 'missing']) {
        for (const origin of Object.keys(RUN_ORIGINS) as RunOrigin[]) {
          const chat = await prepareRun(_probe, origin);
          chat.lastError = 'keep error';
          chat.streamingText = 'keep text';
          chat.streamingThinking = 'keep thinking';
          const before = [chat.running, chat.midRun, chat.lastError, chat.streamingText, chat.streamingThinking];
          if (owner !== 'missing') await dispatchStore(_probe, 'permission.request', { requestId: 'R', req: { sessionId: owner, detail: 'd', kind: 'file', toolTitle: 't' }, meta: {} });
          await dispatchStore(_probe, 'permission.resolved', { requestId: 'R', reason });
          expect(chat.pendingPerms).toEqual([]);
          expect([chat.running, chat.midRun, chat.lastError, chat.streamingText, chat.streamingThinking]).toEqual(before);
          if (reason === 'timeout' && owner === 'A') expect(chat.eventNotes).toEqual([{ kind: 'error', ts: 10000, detail: '权限请求已超时，自动拒绝', retryable: false }]);
          else if (reason === 'invalidated' && owner === 'A') {
            expect(chat.eventNotes).toHaveLength(1);
            expect(chat.eventNotes[0]).toMatchObject({ kind: 'error', retryable: false });
            expect(chat.eventNotes[0].detail).not.toContain('已超时');
          } else expect(chat.eventNotes).toEqual([]);
          expect(_rpcCall.mock.calls).toEqual([]);
        }
      }
    }

  });
});

// 审批前变更预览：file_write/file_edit 权限卡带 preview 时在路径行下方渲染差分区
// （复用 ToolLine 同款 DiffView + diffLines/countAddDel），写文件审批不再是盲批。
describe('变更预览（审批前差分）守卫', () => {
  it('PermissionCard：perm.preview 存在时渲染 DiffView（diffLines/countAddDel 驱动 +N/−N）', () => {
    expect(permCard).toContain('perm.preview');
    expect(permCard).toContain('UiDiff');
    expect(permCard).toContain('diffLines(');
    expect(permCard).toContain('countAddDel(');
    // 差分区在模板里位于路径行（.args）之后（脚本段 props.perm.preview 不算，只看 <template> 内）
    const tpl = permCard.split('<template>')[1] ?? '';
    const argsIdx = tpl.indexOf('class="args"');
    const previewIdx = tpl.indexOf('perm.preview');
    expect(argsIdx).toBeGreaterThan(-1);
    expect(previewIdx).toBeGreaterThan(argsIdx);
  });
  it('chat.ts：PendingPerm 透传 preview（req.preview → push 字段）', async () => {
    // preview 可选完整结构由 tsc 比较；有/没有两个值实际穿过 request 处理器。
    const cardType: true = true as Equal<Chat['pendingPerms'][number], PendingCard>;
    expect(cardType).toBe(true);
    const chat = await initStore(_probe);
    for (const preview of [{ oldText: 'old', newText: 'new' }, undefined]) {
      await dispatchStore(_probe, 'permission.request', { requestId: 'R', req: { sessionId: 'A', detail: 'd', kind: 'file', toolTitle: 't', preview }, meta: {} });
      expect(chat.pendingPerms[0].preview).toEqual(preview);
      expect(toRaw(chat.pendingPerms[0].preview)).toBe(preview);
    }
    expect(_rpcCall.mock.calls).toEqual([]);
  });
});

// W1b-2（止血设计稿 §3 第 6 条 PermissionRequest.note）：数据根内的操作带一句说明，
// 权限卡在路径区之后整句显示。.vue 不在 typecheck 覆盖内，守卫先剥注释再认调用形态，
// 否则注释里留一句 `note: req.note` 就能把断言喂饱（交接 §2 第 10 条）。
// 脚本侧用共用的 stripComments：它连行尾的 // 注释也剥（只剥整行的话，`preview: req.preview, // note: req.note`
// 这种行尾注释照样喂饱三条断言，W1b-2 审查实测过），同时保留 `://`。
describe('W1b-2 权限卡 note 行', () => {

  const tpl = permCard.slice(permCard.indexOf('<template>'), permCard.lastIndexOf('</template>')).replace(/<!--[\s\S]*?-->/g, '');
  const css = permCard.slice(permCard.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '');
  const script = stripComments(permCard.slice(permCard.indexOf('<script'), permCard.indexOf('</script>')));

  it('chat.ts：PendingPerm 声明 note?: string，permission.request 处理器把 req.note 拷进卡片', async () => {
    // note 可选字符串与原始内容逐值透传，不能靠别处出现 note 字样通过。
    const cardType: true = true as Equal<Chat['pendingPerms'][number], PendingCard>;
    expect(cardType).toBe(true);
    const chat = await initStore(_probe);
    for (const note of ['warning\nfull note', '', undefined]) {
      await dispatchStore(_probe, 'permission.request', { requestId: 'R', req: { sessionId: 'A', detail: 'd', kind: 'file', toolTitle: 't', note }, meta: {} });
      expect(chat.pendingPerms[0].note).toBe(note);
    }
    expect(_rpcCall.mock.calls).toEqual([]);
  });

  it('PermCard：props 声明 note?: string；模板在 .args 之后渲染 v-if="perm.note" 的 .note 行并插值 perm.note', () => {
    expect(script).toMatch(/\bnote\?:\s*string/);
    const argsIdx = tpl.indexOf('class="args"');
    const m = /<div v-if="perm\.note" class="note"[^>]*>[\s\S]*?<\/div>/.exec(tpl);
    expect(argsIdx).toBeGreaterThan(-1);
    expect(m, '缺 .note 行').not.toBeNull();
    expect(m!.index).toBeGreaterThan(argsIdx);
    expect(m![0]).toMatch(/\{\{\s*perm\.note\s*\}\}/);
  });

  it('note 行整句换行、不截断，底色走警示色', () => {
    const rules = [...css.matchAll(/\.note[\w-]*\s*\{([^}]*)\}/g)].map(x => x[1]).join('\n');
    expect(rules).not.toBe('');
    expect(rules).not.toMatch(/text-overflow|white-space:\s*nowrap|-webkit-line-clamp/);
    expect(rules).toMatch(/overflow-wrap:\s*anywhere|word-break:\s*break-all/);
    expect(rules).toMatch(/var\(--c-warn/);
  });
});
