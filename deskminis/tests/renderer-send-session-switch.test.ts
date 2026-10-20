/**
 * W1b-4 审查回归：chat.prompt 被拒回来时，用户可能已经在看另一个会话。这时错误不能落到那个会话上。
 *
 * 背景：W1b-4 起，会话在 ensureForRun（连 MCP）期间被删或被停止，chat.prompt 会以「会话已取消」拒绝，
 * 而且要等 MCP 连接超时才拒绝，可能是几秒到十几秒之后。store.send 的 catch 以前不核对会话，直接改当前会话：
 * 写 lastError、置 running=false、按乐观 id 过滤 messages；输入卡随后还把草稿交回（takeDraft）。
 * 用户先切到 B 再删 A，A 的「会话已取消」就顶在 B 的输入卡上；B 正在跑的话还会被误标成没在跑。
 *
 * 这里用 vi.mock 桩掉 rpc，真跑 store（与 renderer-permtier 同一种做法）。store 守卫也真跑，输入卡源码守卫保留，
 * store 枚举未切换、切走、切回三种会话关系；输入卡原守卫仍先剥注释再匹配（交接 §2 第 10 条）。
 * Composer.vue 的 <script> 段里没有在字符串或正则字面量中写 // 或 /* 的地方，stripComments 按正则去注释不会误删代码。
 *
 * 二审补：输入卡的 send() 也要真跑。源码守卫只钉了 sid 在寄存草稿之前记，没钉它在「欢迎页先建会话」之后记；
 * 把 sid 提到建会话之前，欢迎页首条消息被拒（未配置模型）时草稿会被当成「换了会话」丢掉，而当时 14 个相关文件全绿。
 * 仓库里没有挂载 .vue 的测试设施（无 DOM 库、vitest 未接 vue 插件），又不许加依赖，所以这里用 vue 自带的
 * vue/compiler-sfc 编译 <script setup>、typescript 转成 CommonJS，在 effectScope 里直接调组件的 setup：
 * 开发态编译产物的 setup 会把全部顶层绑定（send、text、atts）返回出来。import 按表喂真模块，rpc 与 store 用同一份桩。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { rpcCallMock } = vi.hoisted(() => ({ rpcCallMock: vi.fn() }));

vi.mock('../src/renderer/src/rpc', () => ({
  rpc: { call: rpcCallMock, connect: async () => {}, on: vi.fn() },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createPinia, setActivePinia } from 'pinia';
import * as vue from 'vue';
import { parse, compileScript } from 'vue/compiler-sfc';
import * as rpcModule from '../src/renderer/src/rpc';
import * as chatModule from '../src/renderer/src/stores/chat';
import * as autogrowModule from '../src/renderer/src/lib/composer/autogrow';
import * as historyModule from '../src/renderer/src/lib/composer/history';
import * as atFilesModule from '../src/renderer/src/lib/composer/at-files';
import * as downsampleModule from '../src/renderer/src/lib/attach/downsample';
import * as bindingModule from '../src/renderer/src/lib/models/binding';
import * as welcomeAssistantModule from '../src/renderer/src/lib/welcome/assistant';
import { stripComments } from './strip-comments';

const { useChat } = chatModule;
// typescript 是 export = 形态，tsconfig 没开 esModuleInterop，用 require 取
const ts = createRequire(import.meta.url)('typescript') as typeof import('typescript');

/** chat.prompt 挂住不回，由用例决定何时、以什么原因拒绝（模拟 ensureForRun 等 MCP 超时）。 */
let rejectPrompt: (e: Error) => void = () => {};
const B_MSGS = [{ id: 'm-b-1', role: 'user', parts: [{ type: 'text', value: 'B 里早先的一句' }], createdAt: 1 }];

beforeEach(() => {
  rpcCallMock.mockReset();
  setActivePinia(createPinia());
  rpcCallMock.mockImplementation((method: string, params?: { sessionId?: string }) => {
    if (method === 'chat.prompt') return new Promise((_resolve, reject) => { rejectPrompt = reject; });
    if (method === 'chat.messages.list') return Promise.resolve(params?.sessionId === 'B' ? B_MSGS.map(m => ({ ...m })) : []);
    if (method === 'skills.list') return Promise.resolve([]);
    // 欢迎页首条消息先建会话（newSession：create → list → open）
    if (method === 'chat.sessions.create') return Promise.resolve({ id: 'S1' });
    if (method === 'chat.sessions.list') return Promise.resolve([{ id: 'S1', title: '新会话' }]);
    return Promise.resolve(undefined);
  });
});

describe('W1b-4 审查：chat.prompt 被拒时只改发它的那个会话', () => {
  it('A 的 prompt 挂着时切到 B，A 被拒（会话已取消）：B 的 lastError、running、messages 都不动', async () => {
    const chat = useChat();
    await chat.open('A');
    const sending = chat.send('帮我整理一下今天的待办');
    expect(rpcCallMock).toHaveBeenCalledWith('chat.prompt', expect.objectContaining({ sessionId: 'A' }));
    expect(chat.running).toBe(true);

    await chat.open('B');
    chat.running = true; // B 自己也在跑：误标成没在跑的话，停止钮会消失、还能再发
    const bMessages = JSON.stringify(chat.messages);

    rejectPrompt(new Error('会话已取消'));
    await sending;

    expect(chat.activeId).toBe('B');
    expect(chat.lastError).toBe('');
    expect(chat.running).toBe(true);
    expect(JSON.stringify(chat.messages)).toBe(bMessages);
  });

  it('没换会话：照旧写 lastError、置 running=false、撤掉从未落库的乐观消息', async () => {
    const chat = useChat();
    await chat.open('A');
    const sending = chat.send('帮我整理一下今天的待办');
    expect(chat.messages.map(m => m.role)).toEqual(['user']);

    rejectPrompt(new Error('会话已取消'));
    await sending;

    expect(chat.activeId).toBe('A');
    expect(chat.lastError).toBe('会话已取消');
    expect(chat.running).toBe(false);
    expect(chat.messages).toEqual([]);
  });

  it('切走又切回 A 再被拒：错误照常落在 A 上（它就是发的那个会话）', async () => {
    const chat = useChat();
    await chat.open('A');
    const sending = chat.send('帮我整理一下今天的待办');
    await chat.open('B');
    await chat.open('A');
    chat.running = true;

    rejectPrompt(new Error('会话已取消'));
    await sending;

    expect(chat.activeId).toBe('A');
    expect(chat.lastError).toBe('会话已取消');
    expect(chat.running).toBe(false);
  });
});

describe('W1b-4 审查：源码守卫（剥注释后匹配）', () => {
  it('store.send：开头记下 sid（在第一个 await 即 chat.prompt 之前），catch 里只在 this.activeId === sid 时才写错误态', async () => {
    // 原守卫重复同文件前三例；这里仍在原 it 内枚举没换、切走、切回三条路径。
    for (const route of ['stay', 'away', 'back'] as const) {
      setActivePinia(createPinia());
      const chat = useChat();
      await chat.open('A');
      const history = { id: 'old-A', role: 'assistant', parts: [], createdAt: 1 };
      chat.messages = [history];
      rpcCallMock.mockClear();
      const sending = chat.send('guarded text', ['attachments/a.png']);

      // 第一个 await 之前已经以 A 发出唯一 prompt，每个实参都来自本次发送。
      expect(rpcCallMock.mock.calls).toEqual([
        ['chat.prompt', { sessionId: 'A', text: 'guarded text', attachments: ['attachments/a.png'], promptId: expect.stringMatching(/^[A-Za-z0-9._:-]{1,128}$/) }],
      ]);
      expect(chat.running).toBe(true);
      const optimisticId = chat.messages.at(-1)!.id;
      expect(optimisticId).not.toBe(history.id);

      // 拒绝发生时制造三种会话关系；切走后给 B 的三个字段放非默认哨兵。
      if (route !== 'stay') await chat.open('B');
      if (route === 'back') {
        await chat.open('A');
        chat.messages = [history, { id: optimisticId, role: 'user', parts: [], createdAt: 2 }];
      }
      chat.lastError = route === 'away' ? 'B own error' : '';
      chat.running = true;
      const beforeMessages = JSON.parse(JSON.stringify(chat.messages));
      const writes: string[] = [];
      const stop = vue.watch(() => chat.lastError, () => writes.push('lastError'), { flush: 'sync' });
      const stopRunning = vue.watch(() => chat.running, () => writes.push('running'), { flush: 'sync' });
      const stopMessages = vue.watch(() => chat.messages, () => writes.push('messages'), { flush: 'sync' });

      // await send 的拒绝处理完成后再查“没有发生”，同步监听也能抓到写后又还原。
      try {
        rejectPrompt(new Error('guard rejection'));
        await expect(sending).resolves.toBeUndefined();
        expect(chat.activeId).toBe(route === 'away' ? 'B' : 'A');
        if (route === 'away') {
          expect(chat.lastError).toBe('B own error');
          expect(chat.running).toBe(true);
          expect(chat.messages).toEqual(beforeMessages);
          expect(writes).toEqual([]);
        } else {
          expect(chat.lastError).toBe('guard rejection');
          expect(chat.running).toBe(false);
          expect(chat.messages).toEqual([history]);
          expect(writes.sort()).toEqual(['lastError', 'messages', 'running']);
        }
      } finally {
        stop();
        stopRunning();
        stopMessages();
      }
    }
  });

  it('输入卡：send 返回时已换了会话，就丢掉草稿、不交回（不往另一个会话的输入框里塞）', () => {
    const src = readFileSync(join(__dirname, '../src/renderer/src/ui/Composer.vue'), 'utf8').replace(/\r\n/g, '\n');
    const script = stripComments(src.slice(src.indexOf('<script'), src.indexOf('</script>')));
    const start = script.search(/async function send\(requestedMode\?: InputMode\): Promise<void> \{/);
    expect(start).toBeGreaterThan(-1);
    const body = script.slice(start, script.indexOf('\nfunction takeDraft', start));
    const sidIdx = body.search(/const sid = chat\.activeId;/);
    const draftIdx = body.search(/chat\.draft = \{ text: text\.value/);
    const sendIdx = body.search(/await chat\.send\(/);
    expect(sidIdx).toBeGreaterThan(-1);
    // sid 必须在「欢迎页先建会话」那一块之后记：记在前面的话欢迎页 sid 恒为 ''，newSession 之后
    // activeId !== sid 恒真，首条消息被拒（未配置模型）时草稿被当成「换了会话」丢掉（审查变异实测，14 个文件全绿）。
    // 用括号配对找 `if (!chat.activeId) {` 的收口，不认缩进
    const blockIdx = body.search(/if \(!chat\.activeId\) \{/);
    expect(blockIdx).toBeGreaterThan(-1);
    let depth = 0;
    let blockEnd = -1;
    for (let i = body.indexOf('{', blockIdx); i < body.length; i++) {
      if (body[i] === '{') depth++;
      else if (body[i] === '}' && --depth === 0) { blockEnd = i; break; }
    }
    expect(blockEnd).toBeGreaterThan(blockIdx);
    expect(body.slice(blockIdx, blockEnd)).toMatch(/else await chat\.newSession\(\);/);
    expect(sidIdx).toBeGreaterThan(blockEnd);
    expect(draftIdx).toBeGreaterThan(sidIdx);
    expect(sendIdx).toBeGreaterThan(draftIdx);
    expect(body.slice(sendIdx)).toMatch(
      /await chat\.send\([^\n]*\);\n\s*if \(chat\.activeId !== sid\) chat\.draft = null;\n\s*else if \(chat\.lastError\) takeDraft\(\); else chat\.draft = null;/,
    );
  });
});

// ---- 输入卡 send() 真跑 ----

const COMPOSER_DEPS: Record<string, unknown> = {
  vue,
  '../stores/chat': chatModule,
  '../rpc': rpcModule,
  '../lib/composer/autogrow': autogrowModule,
  '../lib/composer/history': historyModule,
  '../lib/composer/at-files': atFilesModule,
  '../lib/attach/downsample': downsampleModule,
  '../lib/models/binding': bindingModule,
  '../lib/welcome/assistant': welcomeAssistantModule, // W2b-4 起 send() 按欢迎页选择套用助手
  './InputQueue.vue': { default: {} }, // This harness executes setup; child rendering is covered by the browser fixture.
  './UiIcon.vue': { default: {} }, // 只跑 setup、不渲染，子组件用空壳
};

type ComposerBindings = {
  send: (mode?: 'steer' | 'queue') => Promise<void>;
  canSend: { value: boolean };
  text: { value: string };
  atts: { value: { path: string; dataUrl: string }[] };
  sending: { value: boolean };
};

/** 编译 Composer.vue 的 <script setup> 并执行一次 setup，拿回它的顶层绑定。 */
function setupComposer(variant: 'hero' | 'chat'): ComposerBindings {
  const file = join(__dirname, '../src/renderer/src/ui/Composer.vue');
  const { descriptor, errors } = parse(readFileSync(file, 'utf8'), { filename: file });
  if (errors.length) throw errors[0];
  const { content } = compileScript(descriptor, { id: 'composer-runtime-test' });
  const js = ts.transpileModule(content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const req = (id: string): unknown => {
    if (!(id in COMPOSER_DEPS)) throw new Error(`Composer.vue 新 import 了 ${id}：在 COMPOSER_DEPS 里补上它`);
    return COMPOSER_DEPS[id];
  };
  const mod: { exports: { default?: { setup: (p: object, ctx: object) => ComposerBindings } } } = { exports: {} };
  new Function('require', 'module', 'exports', js)(req, mod, mod.exports);
  const setup = mod.exports.default?.setup;
  if (!setup) throw new Error('编译产物里没有 setup');
  const b = scope.run(() => setup({ variant }, { expose: () => {}, emit: () => {}, attrs: {}, slots: {} }));
  if (!b) throw new Error('setup 没有返回绑定');
  return b;
}

let scope = vue.effectScope();
beforeEach(() => { scope = vue.effectScope(); });
afterEach(() => { scope.stop(); });

/** 等 chat.prompt 真的发出去（send 前面还有建会话的几个 await）。 */
async function promptSent(): Promise<void> {
  await vi.waitFor(() => {
    expect(rpcCallMock.mock.calls.some(c => c[0] === 'chat.prompt')).toBe(true);
  });
}

describe('W1b-4 二审：输入卡 send() 真跑（compiler-sfc 编译 <script setup>）', () => {
  it('欢迎页首条消息被拒（未配置模型）：send 先建会话，草稿交回输入框，不因建会话被当成换了会话', async () => {
    const chat = useChat();
    expect(chat.activeId).toBe('');
    const c = setupComposer('hero');
    c.text.value = '帮我整理一下今天的待办';

    const sending = c.send();
    await promptSent();
    expect(chat.activeId).toBe('S1');
    expect(rpcCallMock).toHaveBeenCalledWith('chat.prompt', expect.objectContaining({ sessionId: 'S1' }));
    expect(c.text.value).toBe(''); // 发出去时清框、草稿寄存在 store
    expect(chat.draft?.text).toBe('帮我整理一下今天的待办');

    rejectPrompt(new Error('尚未配置任何模型 provider'));
    await sending;

    expect(chat.activeId).toBe('S1');
    expect(chat.lastError).toBe('尚未配置任何模型 provider');
    expect(c.text.value).toBe('帮我整理一下今天的待办');
    expect(chat.draft).toBeNull(); // 交回之后清寄存，不会在下一个实例上再交回一次
    expect(c.sending.value).toBe(false);
  });

  it('会话页同一会话里被拒：照旧交回草稿（回归网）', async () => {
    const chat = useChat();
    await chat.open('A');
    const c = setupComposer('chat');
    c.text.value = '帮我整理一下今天的待办';

    const sending = c.send();
    await promptSent();
    rejectPrompt(new Error('会话已取消'));
    await sending;

    expect(chat.activeId).toBe('A');
    expect(c.text.value).toBe('帮我整理一下今天的待办');
    expect(chat.draft).toBeNull();
  });

  it('A 发出后切到 B，A 被拒（会话已取消）：草稿不塞进 B 的输入框，寄存也清掉', async () => {
    const chat = useChat();
    await chat.open('A');
    const c = setupComposer('chat');
    c.text.value = '帮我整理一下今天的待办';

    const sending = c.send();
    await promptSent();
    await chat.open('B');
    // B 自己正顶着一条报错：只靠 store 丢掉 A 的拒绝不够，输入卡若只看 lastError 就会把 A 的话交回 B 的输入框
    chat.lastError = 'B 自己的报错';
    rejectPrompt(new Error('会话已取消'));
    await sending;

    expect(chat.activeId).toBe('B');
    expect(chat.lastError).toBe('B 自己的报错');
    expect(c.text.value).toBe('');
    expect(chat.draft).toBeNull();
  });
});

describe('F05：send() 发出的 chat.prompt 带 promptId', () => {
  it('每次发送带一个合法的 promptId，连发两次不相同', async () => {
    const chat = useChat();
    await chat.open('A');
    const first = chat.send('第一条');
    rejectPrompt(new Error('会话已取消'));
    await first;
    const second = chat.send('第二条');
    rejectPrompt(new Error('会话已取消'));
    await second;
    const ids = rpcCallMock.mock.calls.filter(c => c[0] === 'chat.prompt').map(c => (c[1] as { promptId?: unknown }).promptId);
    expect(ids).toHaveLength(2);
    // 与引擎一侧的校验同一条规则（shared/run.ts 的 PROMPT_ID_RE）
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(typeof ids[0]).toBe('string');
    expect(ids[0]).not.toBe(ids[1]);
  });
});


describe('F07 preserves Composer entry guards with compiled setup', () => {
  it('C1 pending first-session creation blocks reentry and releases the gate after rejection', async () => {
    let release!: (value: unknown) => void;
    rpcCallMock.mockImplementation(method => method === 'chat.sessions.create'
      ? new Promise(resolve => { release = resolve; })
      : method === 'chat.prompt' ? new Promise((_resolve, reject) => { rejectPrompt = reject; })
      : Promise.resolve(method === 'chat.sessions.list' ? [{id:'S1',title:'new'}] : method === 'skills.list' || method === 'chat.messages.list' ? [] : undefined));
    const c = setupComposer('hero'); c.text.value = 'first draft';
    const first = c.send(); expect(c.sending.value).toBe(true); expect(c.canSend.value).toBe(false);
    await c.send(); expect(rpcCallMock.mock.calls.filter(x => x[0] === 'chat.sessions.create')).toHaveLength(1);
    release({id:'S1'}); await promptSent(); rejectPrompt(Error('rejected')); await first;
    expect(c.sending.value).toBe(false); expect(c.text.value).toBe('first draft'); expect(c.canSend.value).toBe(true);
  });
  it('C2 pending queue admission blocks another send and preserves text typed while awaiting rejection', async () => {
    const chat = useChat(); await chat.open('A'); chat.inputsOn = true; chat.running = true;
    chat.runOf = {A:{runId:'R',generation:1,ended:false}}; chat.streamingText = 'partial';
    let reject!: (e: Error) => void;
    rpcCallMock.mockImplementation(method => method === 'chat.input.send' ? new Promise((_r, r) => {reject=r;}) : Promise.resolve(undefined));
    const c = setupComposer('chat'); c.text.value = 'queued draft'; const first = c.send('queue');
    c.text.value = 'new text'; expect(c.canSend.value).toBe(false); await c.send('queue');
    expect(rpcCallMock.mock.calls.filter(x => x[0] === 'chat.input.send')).toHaveLength(1);
    reject(Error('queue full')); await first;
    expect(c.text.value).toBe('queued draft\nnew text'); expect(c.sending.value).toBe(false);
    expect(chat.streamingText).toBe('partial'); expect(chat.running).toBe(true);
  });
  it('C3 both disconnection states disable sending and Enter retains the original draft without RPC', async () => {
    const chat = useChat(); await chat.open('A'); chat.inputsOn = true; chat.running = true;
    const c = setupComposer('chat'); c.text.value = 'offline draft'; rpcCallMock.mockClear();
    for (const state of ['reconnecting','lost'] as const) {
      chat.connection = state; expect(c.canSend.value).toBe(false); await c.send('queue');
      expect(c.text.value).toBe('offline draft'); expect(c.sending.value).toBe(false); expect(rpcCallMock).not.toHaveBeenCalled();
    }
  });
  it('C4 older engines keep the running guard and retain an unsent draft', async () => {
    const chat = useChat(); await chat.open('A'); chat.inputsOn = false; chat.running = true;
    chat.runOf = {A:{runId:'R',generation:1,ended:false}}; // F06 identity exists even when F07 support is absent.
    const c = setupComposer('chat'); c.text.value = 'legacy draft'; rpcCallMock.mockClear();
    await c.send(); expect(rpcCallMock).not.toHaveBeenCalled(); expect(c.text.value).toBe('legacy draft'); expect(c.sending.value).toBe(false); expect(chat.lastError).toBe(''); expect(chat.draft).toBeNull();
  });
});
