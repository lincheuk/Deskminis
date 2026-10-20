/** 能力入口清单（T6e-3 改写；前身是 MU6 的「能力接线守卫」）。
 *
 *  **本文件是全库唯一守「后端能力必须有 UI 入口」的地方。**
 *  MU6 立项时数过：`src/minisd` 注册 45 个方法，24 个渲染端零引用，其中 17 个是真缺入口。
 *  MU6 接了三组（会话操作 / 技能管理 / 同步控制），T 波换壳时**又掉了一批**——
 *  1917 例全绿、typecheck 0，没有任何守卫响，因为旧守卫锚在旧组件上、
 *  旧组件还在，红不了。这正是「有守卫 ≠ 有覆盖」。
 *
 *  ## 手法：双向绊线
 *
 *  - **已接的能力** → 断言 `ui/` 下确实有入口。退化（换壳、重构时漏搬）立刻红。
 *  - **已知缺口** → 断言 ① store action 与 minisd 注册项都还在（能力没从后端悄悄消失）、
 *    ② `ui/` 下确实**零引用**。
 *    ②看着别扭，是故意的：谁哪天把入口补上，这条会红，**逼他回来把这一项挪进「已接」组**。
 *    与本项目六处 `user_version` 钉同一手法——用一次强制的红，换一份不会烂掉的账。
 *    今天全绿；两个方向的漂移都会响。
 *
 *  ## 缺口不是 bug，是记在账上的债
 *
 *  用户 2026-09-10 裁定：换壳遗失的入口里**只补工作区**，其余入候选池。
 *  所以下面 GAPS 里的每一条都是**已知且已被接受**的现状，不是新发现的问题。
 *  README 对应行已按 🟡 体例标注（T6c）。
 *
 *  ⚠️ 手法边界（MU5 起反复重申）：源码文本守卫只能证明「调用写出来了」，
 *  证明不了「点下去后端真的收到了」。运行态实测不可被本文件替代。 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { parse as parseVue } from 'vue/compiler-sfc';
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');
import path from 'node:path';
import { startCapturedEngine, type CapturedEngine } from './engine-assembly';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

const probe = vi.hoisted(() => ({ call: vi.fn(), on: vi.fn(), handlers: new Map<string, (p: any) => unknown>(), lost: vi.fn(), connect: vi.fn(async () => {}) }));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: probe.call, on: probe.on.mockImplementation((m: string, h: (p: any) => unknown) => probe.handlers.set(m, h)), onLost: probe.lost, connect: probe.connect } }));
import { useChat } from '../src/renderer/src/stores/chat';
import { resetStoreRpc, settleStore, type Chat, type Equal } from './renderer-store-fixture';
beforeEach(() => resetStoreRpc(probe));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

import { readSourceSet } from './source-set';
const store = readSourceSet(['src/renderer/src/stores']);
let qCapabilityEngine: CapturedEngine;
beforeAll(async () => { qCapabilityEngine = await startCapturedEngine(); }, 60000);
afterAll(async () => { await qCapabilityEngine.close(); vi.restoreAllMocks(); });

/** 递归收集 ui/ 下所有源文件正文——入口在哪个组件里无所谓，有没有才是重点。 */
function uiTree(): string {
  const base = path.join(root, 'src/renderer/src/ui');
  const out: string[] = [];
  (function walk(d: string): void {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(fs.readFileSync(p, 'utf8'));
    }
  })(base);
  return out.join('\n');
}
const ui = uiTree();

/** 「调用了」而不是「提到了」。
 *  ⚠️ 初版写的是 `ui.includes(action)`，自检时（故意把 `chat.setWorkspace` 改名）**没有变红**——
 *  因为同文件的注释里还写着「setWorkspace 会带着空 sessionId 发出去」，裸字符串照样命中。
 *  一个能被注释喂饱的守卫等于没有守卫，这正是本文件开头那句「有守卫 ≠ 有覆盖」。
 *  改成认调用形态 `.action(`：注释里的散文提及不算数。 */
const calls = (src: string, action: string): boolean =>
  new RegExp(`\\.${action}\\s*\\(`).test(src);

interface Cap { name: string; action: string; rpc: string; where?: string; since?: string }

/** 有 UI 入口的能力。`where` 只作说明，断言不锚具体文件——入口搬家不该红。 */
const WIRED = [
  { name: '目录服务商查询', action: 'getCatalogProviders', rpc: 'provider.catalog.providers', where: 'settings/SecModels.vue' },
  { name: '进程树托管诊断', action: 'fetchProcSnapshot', rpc: 'proc.trees.snapshot', where: 'settings/SecDiagnostics.vue' },
  { name: '检查点占用诊断', action: 'fetchCheckpointUsage', rpc: 'checkpoints.usage', where: 'settings/SecDiagnostics.vue' },
  { name: '配置自检', action: 'runDiagnostics', rpc: 'diagnostics.dryRun', where: 'settings/SecDiagnostics.vue' },
  { name: '审计记录查询', action: 'fetchAuditRecords', rpc: 'audit.list', where: 'settings/SecDiagnostics.vue' },
  { name: '技能启停', action: 'setSkillEnabled', rpc: 'skills.setEnabled', where: 'settings/SecSkills.vue' },
  { name: '技能删除', action: 'deleteSkill', rpc: 'skills.delete', where: 'settings/SecSkills.vue' },
  { name: '技能目录导入', action: 'importSkillFolder', rpc: 'skills.import', where: 'settings/SecSkills.vue' },
  { name: '工作区绑定', action: 'setWorkspace', rpc: 'workspace.set', where: 'WorkspacePanel.vue' },
  { name: '工作区恢复默认', action: 'resetWorkspace', rpc: 'workspace.reset', where: 'WorkspacePanel.vue' },
  { name: '工作区目录选择器', action: 'pickWorkspaceFolder', rpc: 'workspace.get', where: 'WorkspacePanel.vue' },
  { name: 'MCP 服务器增删改', action: 'upsertMcpServer', rpc: 'mcp.servers.upsert', where: 'settings/SecMcp.vue' },
  { name: 'MCP 试连接', action: 'testMcpServer', rpc: 'mcp.servers.test', where: 'settings/SecMcp.vue' },
  // Y 波（2026-09-10）成批补回的六条——T 波换壳丢、在 GAPS 里躺了一波
  { name: '删除会话', action: 'deleteSession', rpc: 'chat.sessions.delete', where: 'NavRail.vue' },
  { name: '重命名会话', action: 'renameSession', rpc: 'chat.sessions.rename', where: 'NavRail.vue' },
  { name: '会话置顶', action: 'setSessionPinned', rpc: 'chat.sessions.setPinned', where: 'NavRail.vue' },
  { name: '会话记忆开关', action: 'setSessionMemory', rpc: 'chat.sessions.setMemoryEnabled', where: 'NavRail.vue' },
  { name: '会话绑定模型', action: 'setSessionModelBinding', rpc: 'chat.sessions.setModelBinding', where: 'NavRail.vue' },
  { name: '会话级禁用 MCP', action: 'setSessionMcpDisabled', rpc: 'chat.sessions.setMcpDisabled', where: 'Composer.vue' },
  { name: '同步暂停/恢复', action: 'setSyncPaused', rpc: 'control.pause', where: 'StageDevices.vue' },
  // F11B：恢复被其他设备删除、本机留着内容的会话（设备页「已在其他设备删除」一节）
  { name: '恢复被其他设备删除的会话', action: 'restoreSession', rpc: 'chat.sessions.restore', where: 'StageDevices.vue' },
  // F11B：彻底删除保留副本走专门的方法（只清此刻仍是保留副本的），不复用通用的 chat.sessions.delete
  { name: '彻底删除保留副本', action: 'purgeRetainedSession', rpc: 'chat.sessions.purgeRetained', where: 'StageDevices.vue' },
  // Z 波（2026-09-24）：模型组的界面——M2b 后端就全了，界面从来没有过（不是换壳遗失，是一直缺）
  { name: '模型组新建', action: 'createModelGroup', rpc: 'modelgroup.create', where: 'settings/SecModelGroups.vue' },
  { name: '模型组修改', action: 'updateModelGroup', rpc: 'modelgroup.update', where: 'settings/SecModelGroups.vue' },
  { name: '模型组删除', action: 'deleteModelGroup', rpc: 'modelgroup.delete', where: 'settings/SecModelGroups.vue' },
  // W2b-4（2026-09-24）：欢迎页在已存在的空会话上选助手，发送前套用 / 解绑——此前后端没有这个能力，欢迎页的承诺是空话
  { name: '空会话套用助手', action: 'applyAssistantToSession', rpc: 'chat.sessions.applyAssistant', where: 'Composer.vue' },
] as const satisfies readonly Cap[];

/** 后端通、store 通、**界面上够不着**。每条都注明是哪一波立的、哪一波弄丢的。
 *  Y 波（2026-09-10）把 T 波丢的六条全部补回后本组清空——**空是目标态，不是清单写成了空话**：
 *  下面的「自守」例改为可计算的不变量，谁再让一个 store action 在 ui/ 下失去调用，那条会红并逼他登记到这里。 */
const GAPS: Cap[] = [];


// 参数表与WIRED的action联合类型精确对齐；目录选择器另走原生桥。
const invoke = {
  getCatalogProviders: (c: Chat) => c.getCatalogProviders(),
  fetchProcSnapshot: (c: Chat) => c.fetchProcSnapshot(),
  fetchCheckpointUsage: (c: Chat) => c.fetchCheckpointUsage(),
  runDiagnostics: (c: Chat) => c.runDiagnostics(),
  fetchAuditRecords: (c: Chat) => c.fetchAuditRecords(),
  setSkillEnabled: (c: Chat) => c.setSkillEnabled('SK', false),
  deleteSkill: (c: Chat) => c.deleteSkill('SK'),
  importSkillFolder: (c: Chat) => c.importSkillFolder('/skill'),
  setWorkspace: (c: Chat) => c.setWorkspace('/project'),
  resetWorkspace: (c: Chat) => c.resetWorkspace(),
  pickWorkspaceFolder: (c: Chat) => c.pickWorkspaceFolder(),
  upsertMcpServer: (c: Chat) => c.upsertMcpServer({ name: 'srv', transport: 'stdio', command: 'tool' }),
  testMcpServer: (c: Chat) => c.testMcpServer({ name: 'srv' }),
  deleteSession: (c: Chat) => c.deleteSession('B'),
  renameSession: (c: Chat) => c.renameSession('B', '新标题'),
  setSessionPinned: (c: Chat) => c.setSessionPinned('B', true),
  setSessionMemory: (c: Chat) => c.setSessionMemory('B', false),
  setSessionModelBinding: (c: Chat) => c.setSessionModelBinding('B', 'group:G'),
  setSessionMcpDisabled: (c: Chat) => c.setSessionMcpDisabled('B', ['srv']),
  setSyncPaused: (c: Chat) => c.setSyncPaused(true),
  restoreSession: (c: Chat) => c.restoreSession('B'),
  purgeRetainedSession: (c: Chat) => c.purgeRetainedSession('B'),
  createModelGroup: (c: Chat) => c.createModelGroup('组', ['P']),
  updateModelGroup: (c: Chat) => c.updateModelGroup('G', { name: '改名', memberIds: ['P2'] }),
  deleteModelGroup: (c: Chat) => c.deleteModelGroup('G'),
  applyAssistantToSession: (c: Chat) => c.applyAssistantToSession('A', 'AS'),
} satisfies Record<(typeof WIRED)[number]['action'], (c: Chat) => Promise<unknown>>;

async function checkCapability(c: Cap): Promise<void> {
  const chat = useChat();
  chat.activeId = 'A';
  if (c.action !== 'pickWorkspaceFolder') {
    expect(invoke[c.action as keyof typeof invoke], c.action).toBeTypeOf('function');
    await invoke[c.action as keyof typeof invoke](chat);
    await settleStore();
    expect(probe.call.mock.calls[0]?.[0]).toBe(c.rpc);
    return;
  }
  const pick = vi.fn(async (): Promise<string | null> => '/chosen');
  vi.stubGlobal('window', { deskminis: { pickFolder: pick } });
  expect(await chat.pickWorkspaceFolder()).toBe('/chosen');
  expect(pick.mock.calls).toEqual([[]]);
  pick.mockResolvedValueOnce(null);
  expect(await chat.pickWorkspaceFolder()).toBeNull();
  for (const bridge of [undefined, {}]) {
    vi.stubGlobal('window', { deskminis: bridge });
    expect(await chat.pickWorkspaceFolder()).toBeNull();
  }
  const error = new Error('选择器失败');
  pick.mockRejectedValueOnce(error);
  vi.stubGlobal('window', { deskminis: { pickFolder: pick } });
  await expect(chat.pickWorkspaceFolder()).rejects.toBe(error);
  expect(pick.mock.calls).toEqual([[], [], []]);
  expect(probe.call.mock.calls).toEqual([]);
}

describe('能力入口清单 · 已接的必须还在（退化即红）', () => {
  for (const c of WIRED) {
    it(`${c.name}：store action + RPC + ui/ 入口三者齐全`, async () => {
      await checkCapability(c);
      expect(qCapabilityEngine.methods, `minisd 没注册 ${c.rpc}`).toHaveProperty(c.rpc, expect.any(Function));
      // 只问「ui/ 树里有没有人调它」，不问在哪个文件——入口搬家是自由，消失不是
      expect(calls(ui, c.action), `${c.name} 的界面入口没了（原在 ${c.where}）`).toBe(true);
    });
  }
});

describe('能力入口清单 · 已知缺口（补上了就会红，红了请更新本清单）', () => {
  // Y 波清账后本组为空；vitest 不允许空 suite，留一条说明例——它不断言别的，只把「为空」写进报告
  if (GAPS.length === 0) it('当前没有登记在案的缺口（Y 波 2026-09-10 清账；再出缺口由下面的自守例逼着登记）', () => { expect(GAPS).toHaveLength(0); });
  for (const c of GAPS) {
    it(`${c.name}：后端与 store 还在，但 ui/ 下零引用（${c.since}）`, async () => {
      // 上半：能力别在补入口之前先被人当死代码清掉了
      await checkCapability(c);
      expect(qCapabilityEngine.methods, `minisd 的 ${c.rpc} 没了`).toHaveProperty(c.rpc, expect.any(Function));
      // 下半：绊线。补上入口这条就红——**这是设计意图，不是坏了**。
      // 处理方式：把这一条从 GAPS 挪到 WIRED，顺手把 README 的 🟡 改回 ✅。
      expect(calls(ui, c.action), `${c.name} 已经有界面入口了 → 请把它移进 WIRED 并更新 README`).toBe(false);
    });
  }
});

describe('能力入口清单 · 非 store action 的界面能力（T 波丢、Y 波补回，改正向钉）', () => {
  it('消息锚点导航轨：turn 节带 data-turn-id，右缘 .trail 原生按钮点', () => {
    // 右缘一条按回合分布的锚点轨，点一下跳到那一回合。它不走 store action，
    // 是纯渲染侧能力（data-turn-id + 轨道组件），所以上面的清单钉不住它，单独钉。
    // T6e-3 起这里曾是反向绊线（「回来了就红」）；Y5 补回后翻成正向。
    const chatv = read('src/renderer/src/ui/StageChat.vue');
    expect(chatv).toContain(':data-turn-id="t.id"');
    expect(chatv).toContain('class="trail"');
  });

  it('助手 ↔ 技能绑定：store/后端的 skillIds 都在，编辑器也有这个字段了', async () => {
    // J 波立的能力：助手可绑定若干技能（assistants.create/update 的 skillIds）。
    // 旧 AssistantSettings 用 allSkills 渲一组勾选框；T 波换壳后 StageAssistants 一度没有此字段，Y4 补回。
    const createType: true = true as Equal<Parameters<Chat['createAssistant']>[0]['skillIds'], string[] | undefined>;
    const updateType: true = true as Equal<Parameters<Chat['updateAssistant']>[1]['skillIds'], string[] | undefined>;
    expect([createType, updateType]).toEqual([true, true]);
    const chat = useChat();
    const input = { name: '助手', avatar: '头像', rules: '规则', modelBinding: 'group:G', skillIds: ['S1', 'S2'], prompts: ['提示'] };
    await chat.createAssistant(input);
    await chat.updateAssistant('AS', input);
    expect(probe.call.mock.calls).toEqual([['assistants.create', input], ['assistants.list'], ['assistants.update', { id: 'AS', ...input }], ['assistants.list']]);
    expect(typeof qCapabilityEngine.methods['assistants.update']).toBe('function');
    expect(read('src/renderer/src/ui/StageAssistants.vue')).toMatch(/skillIds: fSkills\.value/);
  });
});

describe('本清单自守：别把清单写成一句空话', () => {
  it('已接组非空，且没有同一个 action 同时出现在两边', () => {
    expect(WIRED.length).toBeGreaterThan(0);
    const dup = WIRED.filter(w => GAPS.some(g => g.action === w.action)).map(w => w.action);
    expect(dup, `同一能力不能既算已接又算缺口: ${dup.join(', ')}`).toHaveLength(0);
  });

  /** Y 波加的可计算不变量：清单不靠人手数。
   *  store 的每个 action 要么 ui/ 下有人调，要么 store 内部自己调（refreshXxx / onEvent 这类 helper），
   *  否则它就是一个没人能够到的入口——必须登记在 GAPS 里。再丢一个入口，这条先红。 */
  it('store 里零 UI 调用的 action，要么是 store 内部 helper，要么登记在 GAPS', () => {
    const chat = useChat();
    const actions = Object.keys(chat).filter(k => !k.startsWith('$') && !k.startsWith('_') && typeof (chat as any)[k] === 'function');
    expect(actions.length).toBeGreaterThan(20);
    const orphans = actions.filter(a => !calls(ui, a) && !new RegExp(`this\\.${a}\\s*\\(`).test(store));
    const unlisted = orphans.filter(a => !GAPS.some(g => g.action === a));
    expect(unlisted, `这些 store action 在 ui/ 下没人调、store 内部也没人调，请补入口或登记到 GAPS: ${unlisted.join(', ')}`).toHaveLength(0);
  });
});


/** N04：这条守卫只证明方法名有渲染端引用，运行行为由上面的 action 表和诊断行为测试证明。
 *  引擎全集取真实装配结果；渲染端递归读整个 src/renderer，解析脚本的字符串字面值。
 *  注释里的方法名不算引用，.vue 只取 script / script setup；跨目录搬家不影响结论。
 *  动态方法和刻意没有 UI 的接口无法用这类静态集合证明，逐条记在下面并反向检查。 */
const RPC_WITHOUT_LITERAL_UI: Record<string, string> = {
  'chat.input.cancel': 'InputQueue.vue 调 chat.changeInput，方法由 chat.input.${action} 动态组成；cancel 是合法 action。',
  // InputQueue.vue 取消编辑经 chat.resumeQueueInput 字面调用 chat.input.resume，无需动态例外。
  'modelgroup.get': '设置页由 modelgroup.list 取得完整组（id/name/memberIds），SecModelGroups.startEdit 直接从列表取组，无需另取单组。',
  'provider.models.metadata': 'resolveRuntime 上方说明已用 provider.runtime.resolve 替代；原始目录查询刻意保留给其它本机客户端。',
  'remote.pair.complete': '配对中的对端完成握手，由 remote/pair-client 调用；本机界面通过 remote.pair.connect 发起。',
  'sync.ack': '对端同步确认，由 sync/coordinator 调用，不是本机界面操作。',
  'sync.att.get': '对端附件分块读取，由 sync/attachments/engine 调用，不是本机界面操作。',
  'sync.att.manifest': '对端附件清单协商，由 sync/attachments/engine 调用，不是本机界面操作。',
  'sync.att.put': '对端附件分块传送，由 sync/attachments/engine 调用，不是本机界面操作。',
  'sync.cursor': '对端增量同步游标，由 sync/coordinator 调用，不是本机界面操作。',
  'sync.hello': '对端同步能力握手，由 sync/outbound-client 调用，不是本机界面操作。',
  'sync.list': '对端同步会话清单，由 sync/coordinator 调用，不是本机界面操作。',
  'sync.pull': '对端同步拉取，由 sync/coordinator 调用，不是本机界面操作。',
  'sync.push': '对端同步推送，由 sync/coordinator 调用，不是本机界面操作。',
};

function rendererRpcLiterals(): Set<string> {
  const literals = new Set<string>();
  function script(text: string, file: string): void {
    const source = ts.createSourceFile(file + '.ts', text, ts.ScriptTarget.Latest, true);
    function visit(node: import('typescript').Node): void {
      if (ts.isStringLiteralLike(node)) literals.add(node.text);
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.(vue|[cm]?[jt]s)$/.test(file)) {
        const text = fs.readFileSync(file, 'utf8');
        if (file.endsWith('.vue')) {
          const { descriptor, errors } = parseVue(text, { filename: file });
          expect(errors, file).toEqual([]);
          for (const block of [descriptor.script, descriptor.scriptSetup]) if (block) script(block.content, file);
        } else script(text, file);
      }
    }
  }
  walk(path.join(root, 'src/renderer'));
  return literals;
}

describe('N04 真实方法全集与整个渲染端的引用守卫', () => {

  it('全部 RPC 有字面引用或逐项例外，白名单不能容纳已接界面的方法', () => {
    const names = Object.keys(qCapabilityEngine.methods);
    const literals = rendererRpcLiterals();
    expect(names.length).toBeGreaterThan(100);
    const missing = names.filter(name => !literals.has(name) && !Object.hasOwn(RPC_WITHOUT_LITERAL_UI, name));
    expect(missing, '新增能力必须接界面或逐项说明例外').toEqual([]);
    for (const [name, reason] of Object.entries(RPC_WITHOUT_LITERAL_UI)) {
      expect(names, '过期白名单：' + name).toContain(name);
      expect(reason.trim().length, name + ' 必须注明依据').toBeGreaterThan(20);
      expect(literals.has(name), '已有字面引用，不得放入白名单：' + name).toBe(false);
      expect(WIRED.some(c => c.rpc === name), '已接能力不得豁免：' + name).toBe(false);
    }
  });
});
