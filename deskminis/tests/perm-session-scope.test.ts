/**
 * W2b-2 · 权限卡按会话区分（止血设计稿 §2「渲染端」、§3 第 6 条、§4 W2b-2；侦察 renderer.md「W2b-permscope」；cross.md S19b）。
 *
 * 旧实现的三处串台：
 *   ① StageChat 用 chat.pendingPerms 渲染所有会话的卡——会话 B 的回合卡在权限上，卡却出现在 A 的对话流里，
 *      用户在 A 里点「允许」放行的其实是 B 的操作；
 *   ② permission.resolved 的超时分支无条件往当前会话的 eventNotes 补一条超时留条——B 的卡超时，A 的对话流里冒出一条；
 *   ③ 任务面板「N 个请求等在对话里」与工作区面板任务 tab 的警示点数的是全局的卡，替别的会话报数。
 *
 * 本文件钉：
 *   - store：PendingPerm 带上引擎广播的 req.sessionId；超时留条只写给卡所属的会话（它得是当前会话）；
 *     换会话（切走再切回）与当前会话的回合结束 / 出错都不动别的会话的卡——提示行、盾牌标、切回去还批得了，都靠卡还在；
 *   - lib/perm/scope 三个纯函数：某会话自己的卡、在等批准的会话集合、除当前会话之外在等的会话；
 *   - 界面（源码守卫，先剥注释再认调用形态）：ui/ 下凡读 chat.pendingPerms 都先过 scope；StageChat 只渲染当前会话的卡，
 *     其余会话在等时对话流顶部（滚动区之外）给「另有 N 个会话在等你批准」、点了切到最早在等的那个；
 *     NavRail 会话行在等批准时带盾牌标；TaskPanel 与 WorkspacePanel 只数当前会话的卡。
 *   - 审查补修：提示行插在滚动区之上以后，注释层的浮条与气泡照样落在设计位置——落点算在 lib/annotations/place 两个纯函数里，
 *     原点量注释层自己的根 .anno（浮条与气泡 position:absolute 挂在它里面），滚动区只当夹紧的边界；AnnoLayer 的接线另用源码守卫钉。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { stripComments } from './strip-comments';
import { sfcBlocks } from './sfc-blocks';
import { parse } from 'vue/compiler-sfc';

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
    // W2b-3：init() 在 connect 之前订阅断线；本文件不测断线，给个空订阅
    onLost: vi.fn(),
  },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { createPinia, setActivePinia } from 'pinia';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';

const root = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
/** 纯模块按需加载：模块还不存在时只让用到它的例子红，不连累同文件的其它例子一起加载失败。 */
const loadScope = () => import('../src/renderer/src/lib/perm/scope');
const loadPlace = () => import('../src/renderer/src/lib/annotations/place');

function stubRpc(): void {
  rpcCallMock.mockImplementation(async (method: string) => {
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
    return undefined;
  });
}

async function boot(active = 'A') {
  stubRpc();
  const chat = useChat();
  await chat.init();
  await chat.open(active);
  return chat;
}

function dispatch(method: string, payload: unknown): void {
  const h = handlers.get(method);
  if (!h) throw new Error(`init() 没有订阅 ${method}`);
  h(payload);
}
/** 模拟 minisd 的 permission.request 广播（index.ts 的 prompt 发出的形态：{ requestId, req: PermissionRequest, meta }）。 */
const request = (requestId: string, sessionId: string, extra: Record<string, unknown> = {}) => dispatch('permission.request', {
  requestId,
  req: { sessionId, kind: 'web-fetch', detail: `http://127.0.0.1/${requestId}`, toolTitle: '抓取示例页', ...extra },
  meta: { timeoutMs: 90000 },
});
const resolved = (requestId: string, reason?: string) =>
  dispatch('permission.resolved', reason === undefined ? { requestId } : { requestId, reason });
const TIMEOUT_NOTE = '权限请求已超时，自动拒绝';

beforeEach(() => {
  rpcCallMock.mockReset();
  handlers.clear();
  setActivePinia(createPinia());
});

describe('W2b-2 store：卡片记下所属会话，超时留条只写给卡所属的会话', () => {
  it('permission.request 把引擎广播的 req.sessionId 拷进卡片（当前会话是 A、卡属于 B），其余字段照旧', async () => {
    const chat = await boot('A');
    request('R1', 'B', { note: '要读的是别的会话的数据' });
    expect(chat.pendingPerms).toHaveLength(1);
    expect(chat.pendingPerms[0]).toMatchObject({
      requestId: 'R1', sessionId: 'B', kind: 'web-fetch', detail: 'http://127.0.0.1/R1',
      toolTitle: '抓取示例页', note: '要读的是别的会话的数据', timeoutMs: 90000,
    });
    expect(typeof chat.pendingPerms[0].deadlineMs).toBe('number');
  });

  it('别的会话的卡超时：摘卡，但不往当前会话的对话流里写留条；当前会话自己的卡超时照旧留一条（不可重试）', async () => {
    const chat = await boot('A');
    request('R1', 'B');
    request('R2', 'A');
    resolved('R1', 'timeout');
    expect(chat.pendingPerms.map(p => p.requestId)).toEqual(['R2']);
    expect(chat.eventNotes).toEqual([]);
    // 回归：卡属于当前会话 A 时，超时留条照旧
    resolved('R2', 'timeout');
    expect(chat.pendingPerms).toHaveLength(0);
    expect(chat.eventNotes).toHaveLength(1);
    expect(chat.eventNotes[0]).toMatchObject({ kind: 'error', detail: TIMEOUT_NOTE, retryable: false });
  });

  it('判的是卡片自己记下的会话：A 的卡挂着时切到 B，A 的卡超时不写进 B 的对话流', async () => {
    const chat = await boot('A');
    request('R1', 'A');
    await chat.open('B');
    // 前提：切到 B 以后 A 的卡还在，只是不属于当前会话。换会话时卡若被清掉，下面「不写留条」照样成立，
    // 这一例就分不出「按卡片记下的会话判」与「手里已经没有这张卡」
    expect(chat.pendingPerms.map(p => p.requestId)).toEqual(['R1']);
    resolved('R1', 'timeout');
    expect(chat.pendingPerms).toHaveLength(0);
    expect(chat.eventNotes).toEqual([]);
  });

  it('换会话不动待批的卡：A 的卡挂着时切到 B 再切回 A，卡一直在、仍记着 A，回到 A 取得到、批得了', async () => {
    const { permsOf, waitingElsewhere } = await loadScope();
    const chat = await boot('A');
    // 真实形态：卡挂着的会话正卡在权限上，回合在跑——先让 A 的回合跑起来再来卡（W2b-2 三审：
    // 没跑的 A 切回来 midRun 为假，挡不挡卡都一样，这一例就测不到「midRun 时卡照样渲染」这条承重不变量）
    dispatch('chat.event', { sessionId: 'A', event: { kind: 'textDelta', text: '先查一下' } });
    request('R1', 'A');
    await chat.open('B');
    // 在 B：卡还在、仍记着 A——B 顶部的「另有 1 个会话在等你批准」与 A 行的盾牌标都从它来
    expect(chat.pendingPerms.map(p => `${p.requestId}@${p.sessionId}`)).toEqual(['R1@A']);
    expect(permsOf(chat.pendingPerms, chat.activeId)).toEqual([]);
    expect(waitingElsewhere(chat.pendingPerms, chat.activeId)).toEqual(['A']);
    // 切回 A，走点提示的同一条路：打开 waitingElsewhere 的第一个
    await chat.open(waitingElsewhere(chat.pendingPerms, chat.activeId)[0]);
    expect(chat.activeId).toBe('A');
    // 中途接上的回合：running 与 midRun 都为真，实时块只显示「仍在运行…」占位——卡不能跟着被挡住，
    // 模板一侧由下面「权限卡与提示行不挂在任何条件分支下」一例钉住
    expect(chat.running).toBe(true);
    expect(chat.midRun).toBe(true);
    expect(chat.pendingPerms.map(p => `${p.requestId}@${p.sessionId}`)).toEqual(['R1@A']);
    // 当前会话取得到它（模板照 permsHere 渲染）。换走时卡若被清掉，切回来无卡可批，A 的回合静默挂满 90 秒后被自动拒绝
    expect(permsOf(chat.pendingPerms, chat.activeId).map(p => p.requestId)).toEqual(['R1']);
    // 批得了：卡上的「允许」按 requestId 回给引擎，卡随即摘掉
    rpcCallMock.mockClear();
    await chat.respondPerm('R1', 'allow-once');
    expect(rpcCallMock).toHaveBeenCalledWith('permission.respond', { requestId: 'R1', decision: 'allow-once' });
    expect(chat.pendingPerms).toEqual([]);
  });

  it('当前会话的回合结束或出错（随后 open 自刷新）不动别的会话的卡', async () => {
    // turnEnd / error 分支与它们随后调的 open(activeId) 是清缓冲的地方，单会话时代顺手清卡也无害；
    // 现在 B 的卡跟 A 的回合无关，在这里清掉的话，B 的回合要静默挂满 90 秒后被自动拒绝
    const chat = await boot('A');
    request('R1', 'B');
    const flush = () => new Promise(r => setTimeout(r, 0));
    dispatch('chat.event', { sessionId: 'A', event: { kind: 'textDelta', text: '一段' } });
    dispatch('chat.event', { sessionId: 'A', event: { kind: 'turnEnd', stopReason: 'endTurn' } });
    await flush();
    expect(chat.pendingPerms.map(p => `${p.requestId}@${p.sessionId}`)).toEqual(['R1@B']);
    dispatch('chat.event', { sessionId: 'A', event: { kind: 'textDelta', text: '又一段' } });
    dispatch('chat.event', { sessionId: 'A', event: { kind: 'error', message: '上游 500' } });
    await flush();
    expect(chat.pendingPerms.map(p => `${p.requestId}@${p.sessionId}`)).toEqual(['R1@B']);
  });

  it('手里没有这张卡（渲染端重载后才收到超时）：不猜它属于谁，不写留条', async () => {
    const chat = await boot('A');
    resolved('RX', 'timeout');
    expect(chat.eventNotes).toEqual([]);
  });

  it('answered 与不带 reason 的 resolved：只摘卡不留条，当前会话与别的会话的卡一样', async () => {
    const chat = await boot('A');
    request('R1', 'A');
    request('R2', 'B');
    resolved('R1', 'answered');
    resolved('R2');
    expect(chat.pendingPerms).toHaveLength(0);
    expect(chat.eventNotes).toEqual([]);
  });
});

describe('W2b-2 lib/perm/scope 纯函数', () => {
  const perms = [
    { requestId: 'R1', sessionId: 'B' },
    { requestId: 'R2', sessionId: 'A' },
    { requestId: 'R3', sessionId: 'C' },
    { requestId: 'R4', sessionId: 'B' },
    { requestId: 'R5', sessionId: 'A' },
  ];

  it('permsOf：只留这个会话自己的卡，保持到达先后；没有会话或别的会话都不串进来', async () => {
    const { permsOf } = await loadScope();
    expect(permsOf(perms, 'A').map(p => p.requestId)).toEqual(['R2', 'R5']);
    expect(permsOf(perms, 'B').map(p => p.requestId)).toEqual(['R1', 'R4']);
    expect(permsOf(perms, 'Z')).toEqual([]);
    expect(permsOf(perms, '')).toEqual([]);
    expect(permsOf([], 'A')).toEqual([]);
  });

  it('waitingSessionIds：在等批准的会话去重，按各自最早那张卡的到达先后', async () => {
    const { waitingSessionIds } = await loadScope();
    const s = waitingSessionIds(perms);
    expect([...s]).toEqual(['B', 'A', 'C']);
    expect(s.has('C')).toBe(true);
    expect(s.has('Z')).toBe(false);
    expect(waitingSessionIds([]).size).toBe(0);
  });

  it('waitingElsewhere：除当前会话外在等的会话，去重、最早在等的排第一；当前会话自己的卡不算', async () => {
    const { waitingElsewhere } = await loadScope();
    expect(waitingElsewhere(perms, 'A')).toEqual(['B', 'C']);
    expect(waitingElsewhere(perms, 'B')).toEqual(['A', 'C']);
    expect(waitingElsewhere(perms, 'Z')).toEqual(['B', 'A', 'C']);
    expect(waitingElsewhere(perms.filter(p => p.sessionId === 'A'), 'A')).toEqual([]);
  });
});

describe('W2b-2 界面：卡只在自己的会话里渲染，别处给提示与标记（源码守卫，先剥注释）', () => {
  const vue = (rel: string) => sfcBlocks(read(rel), path.basename(rel));
  const stage = vue('src/renderer/src/ui/StageChat.vue');
  const rail = vue('src/renderer/src/ui/NavRail.vue');
  const task = vue('src/renderer/src/ui/TaskPanel.vue');
  const ws = vue('src/renderer/src/ui/WorkspacePanel.vue');

  /** 取脚本里一个函数的函数体（到下一个顶层 function / const / watch 为止——这几个组件的函数都不嵌套声明）。 */
  function fnBody(script: string, name: string): string {
    const start = script.search(new RegExp(`(?:async\\s+)?function ${name}\\(`));
    if (start < 0) return '';
    const rest = script.slice(start + 1);
    const end = rest.search(/\n(?:async\s+)?function |\nconst |\nwatch\(/);
    return end < 0 ? rest : rest.slice(0, end);
  }

  it('ui/ 下凡读 chat.pendingPerms 的地方都先过 lib/perm/scope——全局那份不直接拿来渲染或计数', () => {
    // 扫整棵 ui/（含子目录、.vue 与 .ts）：卡按会话分开以后，哪个组件再直接数全局的卡，就又替别的会话报数了。
    // 挪进别的组件、别的目录也逃不过这条
    const base = path.join(root, 'src/renderer/src/ui');
    const offenders: string[] = [];
    const users: string[] = [];
    (function walk(d: string): void {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { walk(p); continue; }
        let code = '';
        if (e.name.endsWith('.vue')) { const b = sfcBlocks(fs.readFileSync(p, 'utf8'), e.name); code = `${b.script}\n${b.template}`; }
        else if (e.name.endsWith('.ts')) code = stripComments(fs.readFileSync(p, 'utf8'));
        else continue;
        const rel = path.relative(base, p);
        for (const m of code.matchAll(/\bpendingPerms\b/g)) {
          const before = code.slice(Math.max(0, m.index! - 40), m.index!);
          if (/\b(?:permsOf|waitingSessionIds|waitingElsewhere)\(\s*chat\.$/.test(before)) { if (!users.includes(rel)) users.push(rel); }
          else offenders.push(`${rel}: …${before.slice(-24)}pendingPerms`);
        }
      }
    })(base);
    expect(offenders).toEqual([]);
    // 不许是空扫：四个读卡的地方都在经 scope 读
    expect(users.sort()).toEqual(['NavRail.vue', 'StageChat.vue', 'TaskPanel.vue', 'WorkspacePanel.vue']);
  });

  it('StageChat：PermCard 只渲染当前会话的卡（permsHere = permsOf(chat.pendingPerms, chat.activeId)），贴底 watch 也改数它', () => {
    expect(stage.script).toMatch(/import \{[^}]*\bpermsOf\b[^}]*\} from '\.\.\/lib\/perm\/scope'/);
    expect(stage.script).toMatch(/const permsHere = computed\(\(\) => permsOf\(chat\.pendingPerms, chat\.activeId\)\)/);
    expect(stage.template).toMatch(/<div v-for="p in permsHere" :key="p\.requestId"[^>]*>\s*<PermCard :perm="p" \/>/);
    expect(stage.template).not.toMatch(/v-for="p in chat\.pendingPerms"/);
    const w = /watch\(\s*\(\) => \[([^\]]*)\] as const,\s*stickBottom/.exec(stage.script);
    expect(w, '找不到贴底 watch').not.toBeNull();
    expect(w![1]).toMatch(/\bpermsHere\.value\.length\b/);
  });

  it('StageChat：其余会话在等时，对话流顶部（滚动区之外，不随对话滚走）给「另有 N 个会话在等你批准」，点了切到最早在等的那个会话', () => {
    expect(stage.script).toMatch(/import \{[^}]*\bwaitingElsewhere\b[^}]*\} from '\.\.\/lib\/perm\/scope'/);
    expect(stage.script).toMatch(/const elsewhere = computed\(\(\) => waitingElsewhere\(chat\.pendingPerms, chat\.activeId\)\)/);
    const hintIdx = stage.template.search(/v-if="elsewhere\.length"/);
    const scrollIdx = stage.template.search(/<div ref="scroller" class="scroll"/);
    expect(hintIdx, '缺提示行').toBeGreaterThan(-1);
    expect(scrollIdx).toBeGreaterThan(-1);
    expect(hintIdx, '提示行要在滚动区之前：放进滚动区，贴底跟随时它就滚出视野了').toBeLessThan(scrollIdx);
    const hint = stage.template.slice(hintIdx, stage.template.indexOf('</button>', hintIdx));
    expect(hint).toMatch(/<button\b[^>]*\btype="button"[^>]*@click="openWaiting(?:\(\))?"/);
    expect(hint).toMatch(/另有 \{\{ elsewhere\.length \}\} 个会话在等你批准/);
    expect(hint).toMatch(/<UiIcon name="shield"/);
    const body = fnBody(stage.script, 'openWaiting');
    expect(body, '缺 openWaiting').not.toBe('');
    // 打开的得是 elsewhere 的第一个（等得最久的）：直接当实参，或先取进一个局部变量（下标或解构）再传。
    // 只认「取了 elsewhere.value[0]」加「调了 chat.open」的话，chat.open(chat.activeId) 这种点了原地不动的写法也能过
    const firsts = [
      ...[...body.matchAll(/\b(?:const|let)\s+(\w+)\s*=\s*elsewhere\.value\[0\]/g)].map(m => m[1]),
      ...[...body.matchAll(/\b(?:const|let)\s+\[\s*(\w+)\s*\]\s*=\s*elsewhere\.value\b/g)].map(m => m[1]),
    ];
    const opened = [...body.matchAll(/\bchat\.open\(\s*([^()]*?)\s*\)/g)].map(m => m[1]);
    expect(opened, 'openWaiting 没调 chat.open').not.toEqual([]);
    for (const arg of opened) {
      expect(arg === 'elsewhere.value[0]' || firsts.includes(arg), `chat.open 的实参不是最早在等的会话：${arg}`).toBe(true);
    }
  });

  it('StageChat：权限卡与提示行不挂在任何条件分支下——只要会话视图在，midRun 占位时卡也照样渲染（按模板 AST 判）', () => {
    // W2b-2 三审：批别的会话的卡只剩一条路——切过去。那个会话正卡在权限上、回合在跑，open() 置 midRun，
    // 实时块只剩「仍在运行…」占位。卡块要是挪进实时回合的 v-else，或加 v-show="!chat.midRun"，
    // 13 个相关测试文件全绿，真应用里点「去批准」过去却看不到卡，回合挂满 90 秒被自动拒绝（审查实拍 X1b）。
    // 按模板 AST 判：注释不是元素，喂不饱；v-for 在 permsHere 上的元素与提示行，自身和祖先链上都不许有
    // v-if / v-else-if / v-else / v-show（提示行自己的 v-if="elsewhere.length" 除外）
    const src = fs.readFileSync(path.join(__dirname, '../src/renderer/src/ui/StageChat.vue'), 'utf8');
    const { descriptor } = parse(src, { filename: 'StageChat.vue' });
    type El = { type: number; tag?: string; props?: Array<{ type: number; name: string; exp?: { content?: string } }>; children?: El[] };
    const COND = new Set(['if', 'else-if', 'else', 'show']);
    const found: Array<{ what: string; bad: string[] }> = [];
    const walk = (node: El, chain: El[]): void => {
      if (node.type !== 1) return;
      const dirs = (node.props ?? []).filter(d => d.type === 7);
      const vfor = dirs.find(d => d.name === 'for');
      const vif = dirs.find(d => d.name === 'if');
      const isCard = !!vfor && /\bin\s+permsHere\b/.test(vfor.exp?.content ?? '');
      const isHint = !!vif && (vif.exp?.content ?? '').trim() === 'elsewhere.length';
      if (isCard || isHint) {
        const own = dirs.filter(d => COND.has(d.name) && !(isHint && d === vif)).map(d => `自身 v-${d.name}="${d.exp?.content ?? ''}"`);
        const anc = chain.flatMap(a => (a.props ?? []).filter(d => d.type === 7 && COND.has(d.name)).map(d => `<${a.tag}> v-${d.name}="${d.exp?.content ?? ''}"`));
        found.push({ what: isCard ? '权限卡 v-for' : '提示行', bad: [...own, ...anc] });
      }
      for (const c of node.children ?? []) walk(c, [...chain, node]);
    };
    walk({ type: 1, tag: 'template', props: [], children: (descriptor.template?.ast?.children ?? []) as unknown as El[] }, []);
    expect(found.map(f => f.what).sort(), '模板里恰好一处权限卡 v-for、一处提示行').toEqual(['提示行', '权限卡 v-for']);
    for (const f of found) expect(f.bad, `${f.what} 挂在条件分支下`).toEqual([]);
  });

  it('NavRail：会话行在等批准时，行按钮里、标题之后带盾牌标（警示色，与权限卡、任务面板同一图标同一令牌）', () => {
    expect(rail.script).toMatch(/import \{[^}]*\bwaitingSessionIds\b[^}]*\} from '\.\.\/lib\/perm\/scope'/);
    expect(rail.script).toMatch(/const waiting = computed\(\(\) => waitingSessionIds\(chat\.pendingPerms\)\)/);
    const row = /<button type="button" class="srow"[^>]*>([\s\S]*?)<\/button>/.exec(rail.template)?.[1] ?? '';
    expect(row, '找不到会话行按钮').not.toBe('');
    const titleIdx = row.search(/class="stitle"/);
    const markIdx = row.search(/<span v-if="waiting\.has\(s\.id\)"[^>]*class="swait"/);
    expect(titleIdx).toBeGreaterThan(-1);
    expect(markIdx, '缺等待标').toBeGreaterThan(titleIdx);
    const mark = row.slice(markIdx);
    expect(mark).toMatch(/^<span[^>]*title="有权限请求等你批准"/);
    expect(mark).toMatch(/<UiIcon name="shield"/);
    const rules = [...rail.style.matchAll(/\.swait\s*\{([^}]*)\}/g)].map(m => m[1]).join('\n');
    expect(rules).toMatch(/color:\s*var\(--c-warn\)/);
  });

  it('TaskPanel：「等你批准」一节只数当前会话的卡', () => {
    expect(task.script).toMatch(/const permsHere = computed\(\(\) => permsOf\(chat\.pendingPerms, chat\.activeId\)\)/);
    expect(task.template).toMatch(/<section v-if="permsHere\.length" class="blk">/);
    expect(task.template).toMatch(/\{\{ permsHere\.length \}\} 个请求等在对话里——回合正卡在这/);
  });

  it('WorkspacePanel：任务 tab 的警示点只看当前会话的卡', () => {
    expect(ws.script).toMatch(/const permsHere = computed\(\(\) => permsOf\(chat\.pendingPerms, chat\.activeId\)\)/);
    expect(ws.template).toMatch(/任务<span v-if="permsHere\.length" class="n dot">·<\/span>/);
  });
});

describe('W2b-2 审查补修：提示行把滚动区往下推以后，注释层的浮条与气泡仍落在设计位置', () => {
  // 几何取自审查实拍（1280×800）：.stage 顶边在 TopBar 之下 y=40；提示行 36px 高、上边距 12px，把滚动区（host）推下 48px。
  // 注释层 .anno 是 inset:0 铺满 .stage 的，浮条与气泡 position:absolute 挂在它里面，left/top 的原点是 .anno 的左上角。
  // 改前原点量的是 host：有提示行时浮条落在选区上方 56px（该是 8px）、压住上面两三行；
  // 气泡开在点击点上方 38px（该是下方 10px）、盖住刚点的那处高亮
  type Box = { left: number; top: number; width: number; height: number };
  const layer: Box = { left: 220, top: 40, width: 816, height: 760 };
  const hostNoHint: Box = { left: 220, top: 40, width: 816, height: 630 };
  const hostHint: Box = { left: 220, top: 88, width: 816, height: 582 };
  const sel: Box = { left: 272, top: 366, width: 140, height: 22 };

  it('浮条：底边在选区顶边上方 8px、中点对齐选区中点——有没有提示行都一样', async () => {
    const { placeBar } = await loadPlace();
    for (const host of [hostNoHint, hostHint]) {
      // 换回视口坐标来比：浮条自身 translate(-50%, -100%)，y 是它的底边、x 是它的中点
      const at = placeBar(layer, host, sel);
      expect(layer.top + at.y, `滚动区顶边 ${host.top}`).toBe(sel.top - 8);
      expect(layer.left + at.x, `滚动区顶边 ${host.top}`).toBe(sel.left + sel.width / 2);
    }
  });

  it('气泡：顶边在点击点下方 10px——有没有提示行都一样', async () => {
    const { placePop } = await loadPlace();
    for (const host of [hostNoHint, hostHint]) {
      // 气泡自身 translateX(-50%)：x 是中点、y 是顶边
      const at = placePop(layer, host, 480, 378);
      expect(layer.top + at.y, `滚动区顶边 ${host.top}`).toBe(378 + 10);
      expect(layer.left + at.x, `滚动区顶边 ${host.top}`).toBe(480);
    }
  });

  it('夹紧照旧以滚动区为界：浮条底边不高于滚动区顶边下 8px、中点离左右边至少半宽 74；气泡顶边不低于滚动区底边上 40、中点离左右边至少半宽 130', async () => {
    const { placeBar, placePop } = await loadPlace();
    // 选区已滚到滚动区顶边之上（被提示行挡着）：浮条停在滚动区顶边下 8px，而不是 .stage 顶边下 8px
    expect(layer.top + placeBar(layer, hostHint, { ...sel, top: 60 }).y).toBe(hostHint.top + 8);
    expect(layer.left + placeBar(layer, hostHint, { ...sel, left: 225, width: 10 }).x).toBe(hostHint.left + 74);
    expect(layer.left + placeBar(layer, hostHint, { ...sel, left: 1020, width: 10 }).x).toBe(hostHint.left + hostHint.width - 74);
    expect(layer.top + placePop(layer, hostHint, 480, 660).y).toBe(hostHint.top + hostHint.height - 40);
    expect(layer.left + placePop(layer, hostHint, 230, 378).x).toBe(hostHint.left + 130);
    expect(layer.left + placePop(layer, hostHint, 1030, 378).x).toBe(hostHint.left + hostHint.width - 130);
    // 横向同理：注释层与滚动区左边不齐时，原点仍是注释层、边界仍是滚动区
    const wider: Box = { ...layer, left: 200, width: 836 };
    expect(wider.left + placeBar(wider, hostHint, sel).x).toBe(sel.left + sel.width / 2);
    expect(wider.left + placeBar(wider, hostHint, { ...sel, left: 225, width: 10 }).x).toBe(hostHint.left + 74);
    expect(wider.left + placePop(wider, hostHint, 230, 378).x).toBe(hostHint.left + 130);
  });

  it('没有提示行时（注释层与滚动区重合）与改前按滚动区量的原式逐点相同', async () => {
    const { placeBar, placePop } = await loadPlace();
    // 改前 AnnoLayer 里的两条原式，照抄作参照
    const oldBar = (r: Box, box: Box) => ({
      x: Math.min(Math.max(r.left + r.width / 2 - box.left, 74), box.width - 74),
      y: Math.max(r.top - box.top - 8, 8),
    });
    const oldPop = (cx: number, cy: number, box: Box) => ({
      x: Math.min(Math.max(cx - box.left, 130), box.width - 130),
      y: Math.min(cy - box.top + 10, box.height - 40),
    });
    const box = hostNoHint;
    for (const top of [20, 44, 300, 660]) {
      for (const left of [222, 400, 1000]) {
        const r: Box = { left, top, width: 30, height: 20 };
        expect(placeBar(box, box, r)).toEqual(oldBar(r, box));
      }
    }
    for (const cy of [50, 300, 700]) {
      for (const cx of [230, 600, 1030]) expect(placePop(box, box, cx, cy)).toEqual(oldPop(cx, cy, box));
    }
  });

  it('AnnoLayer：浮条与气泡都经 place 落位，原点量注释层自己的根（.anno 上挂的 ref），滚动区（host）只当边界', () => {
    const a = sfcBlocks(read('src/renderer/src/ui/AnnoLayer.vue'), 'AnnoLayer.vue');
    const imported = (/import \{([^}]*)\} from '\.\.\/lib\/annotations\/place'/.exec(a.script)?.[1] ?? '').split(',').map(s => s.trim());
    expect(imported, 'AnnoLayer 没从 lib/annotations/place 引入落点函数').toEqual(expect.arrayContaining(['placeBar', 'placePop']));

    // 前提：浮条与气泡 position:absolute，挂在模板根 .anno 里，.anno 自己是定位元素——它们的 left/top 从 .anno 的左上角算起
    const root = /^\s*<div\b([^>]*)>/.exec(a.template);
    expect(root?.[1] ?? '', '模板根不是 .anno').toMatch(/\bclass="anno"/);
    const rules = [...a.style.matchAll(/([^{}]+)\{([^}]*)\}/g)].map(m => ({ sels: m[1].split(',').map(s => s.trim()), body: m[2] }));
    const positionOf = (cls: string) => rules.filter(r => r.sels.includes(cls)).map(r => /\bposition:\s*([\w-]+)/.exec(r.body)?.[1]).filter(Boolean).pop();
    expect(positionOf('.anno')).toMatch(/^(?:absolute|relative|fixed|sticky)$/);
    expect(positionOf('.abar')).toBe('absolute');
    expect(positionOf('.apop')).toBe('absolute');

    // 原点：.anno 上 ref 的矩形；边界：props.host 的矩形——直接写在实参里，或先存进一个局部变量
    const refName = /\bref="(\w+)"/.exec(root?.[1] ?? '')?.[1] ?? '';
    expect(refName, '.anno 上没挂 ref：量不到注释层自己的矩形').not.toBe('');
    expect(a.script).toMatch(new RegExp(`\\bconst ${refName} = ref\\b`));
    const rect = (el: string) => `${el}(?:\\?|!)?\\.getBoundingClientRect\\(\\)`;
    const aliasesOf = (el: string) => [...a.script.matchAll(new RegExp(`\\b(?:const|let)\\s+(\\w+)\\s*=\\s*${rect(el)}`, 'g'))].map(m => m[1]);
    // 变量名按整个脚本认：同一个名字若一处量注释层、另一处量滚动区（两个函数各声明一次），认不出实参指的是哪个——直接判红
    const bothWays = aliasesOf(`${refName}\\.value`).filter(n => aliasesOf('props\\.host').includes(n));
    expect(bothWays, '同一个变量名有的地方量注释层、有的地方量滚动区').toEqual([]);
    const isRectOf = (arg: string, el: string) => new RegExp(`^${rect(el)}$`).test(arg.trim()) || aliasesOf(el).includes(arg.trim());
    const ARG = String.raw`((?:[^,()]|\([^()]*\))+)`;
    const calls = [...a.script.matchAll(new RegExp(String.raw`\b(placeBar|placePop)\(${ARG},${ARG},`, 'g'))];
    expect([...new Set(calls.map(c => c[1]))].sort(), '浮条（placeBar）与气泡（placePop）都要经 place 落位').toEqual(['placeBar', 'placePop']);
    for (const [, fn, origin, bounds] of calls) {
      expect(isRectOf(origin, `${refName}\\.value`), `${fn} 的原点不是注释层自己的矩形：${origin.trim()}`).toBe(true);
      expect(isRectOf(bounds, 'props\\.host'), `${fn} 的边界不是滚动区的矩形：${bounds.trim()}`).toBe(true);
    }
    // 回退形态：拿滚动区的顶边、左边当原点直接相减（改前两处都是这么写的）
    for (const h of aliasesOf('props\\.host')) {
      expect(a.script, `${h}（滚动区的矩形）的顶边 / 左边被当成了原点`).not.toMatch(new RegExp(`-\\s*${h}\\.(?:top|left)\\b`));
    }
    expect(a.script).not.toMatch(new RegExp(`${rect('props\\.host')}\\.(?:top|left)\\b`));
  });
});
