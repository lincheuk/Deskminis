/**
 * Z3-Z5 · 模型组的界面（设计稿 docs/specs/2026-09-24-model-group-ui-design.md）。
 *
 * 后端 M2b 就全了（modelgroup.* 五个 RPC + group: 绑定解析 + 降级链），界面从来没有过：
 * store 零 group action、设置页零组编辑器、绑定下拉只列 provider、模型胶囊无视绑定。
 * 上半是 store 的行为测试（pinia + mock rpc，成例 renderer-default-provider）；
 * 下半是 .vue 源码守卫——.vue 不在 typecheck 覆盖内，断言认调用形态，不认散文。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sfcBlocks } from './sfc-blocks';

const { rpcCallMock } = vi.hoisted(() => ({ rpcCallMock: vi.fn() }));
vi.mock('../src/renderer/src/rpc', () => ({
  // W2b-3：init() 在 connect 之前订阅断线（onLost）；本文件不测断线，给个空订阅
  rpc: { call: rpcCallMock, connect: async () => {}, on: vi.fn(), onLost: vi.fn() },
}));

// eslint-disable-next-line import/first
import { createPinia, setActivePinia } from 'pinia';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';

const GROUPS = [{ id: 'G1', name: '主备', memberIds: ['P1', 'P2'], createdAt: 1 }];
const methods = (): string[] => rpcCallMock.mock.calls.map(c => String(c[0]));

beforeEach(() => { rpcCallMock.mockReset(); setActivePinia(createPinia()); });

describe('Z3 store — 模型组四个 action', () => {
  it('refreshModelGroups 读 modelgroup.list 原样落 state', async () => {
    rpcCallMock.mockImplementation(async (m: string) => (m === 'modelgroup.list' ? GROUPS : undefined));
    const chat = useChat();
    await chat.refreshModelGroups();
    expect(chat.modelGroups).toEqual(GROUPS);
  });

  it('create 传 name + 有序 memberIds，写后重拉', async () => {
    rpcCallMock.mockImplementation(async (m: string) => (m === 'modelgroup.list' ? GROUPS : { id: 'G1' }));
    const chat = useChat();
    await chat.createModelGroup('主备', ['P1', 'P2']);
    expect(rpcCallMock).toHaveBeenCalledWith('modelgroup.create', { name: '主备', memberIds: ['P1', 'P2'] });
    expect(methods().at(-1)).toBe('modelgroup.list');
    expect(chat.modelGroups).toEqual(GROUPS);
  });

  it('update 带 id 与 patch，写后重拉', async () => {
    rpcCallMock.mockImplementation(async (m: string) => (m === 'modelgroup.list' ? GROUPS : { ok: true }));
    const chat = useChat();
    await chat.updateModelGroup('G1', { name: '主备2', memberIds: ['P2', 'P1'] });
    expect(rpcCallMock).toHaveBeenCalledWith('modelgroup.update', { id: 'G1', name: '主备2', memberIds: ['P2', 'P1'] });
    expect(methods().at(-1)).toBe('modelgroup.list');
  });

  it('delete 带 confirm:true（后端强制，漏了就是「点了删除没反应」），写后重拉', async () => {
    rpcCallMock.mockImplementation(async (m: string) => (m === 'modelgroup.list' ? [] : { ok: true }));
    const chat = useChat();
    await chat.deleteModelGroup('G1');
    expect(rpcCallMock).toHaveBeenCalledWith('modelgroup.delete', { id: 'G1', confirm: true });
    expect(methods().at(-1)).toBe('modelgroup.list');
    expect(chat.modelGroups).toEqual([]);
  });

  it('init 拉一次组；组拉取失败不拖垮启动（后面的初始化照常进行）', async () => {
    rpcCallMock.mockImplementation(async (m: string) => {
      if (m === 'modelgroup.list') throw new Error('boom');
      if (m === 'provider.getDefault') return { id: '' };
      if (m === 'control.status') return { syncPaused: false };
      if (m === 'permission.getPreset') return { preset: 'ask' };
      if (['provider.instances.list', 'chat.sessions.list', 'assistants.list', 'skills.list'].includes(m)) return [];
      return undefined;
    });
    const chat = useChat();
    await expect(chat.init()).resolves.toBeUndefined();
    expect(methods()).toContain('modelgroup.list');
    const iGroups = methods().indexOf('modelgroup.list');
    expect(methods().indexOf('permission.getPreset')).toBeGreaterThan(iGroups);
  });
});

const UI = join(__dirname, '../src/renderer/src/ui/');
const read = (p: string): string => readFileSync(join(UI, p), 'utf8').replace(/\r\n/g, '\n');
/** 取 `function name(` 起到下一个顶层声明为止的函数体（够用的粗切）。 */
const fnBody = (src: string, name: string): string => {
  const i = src.search(new RegExp(`(?:async )?function ${name}\\(`));
  if (i < 0) return '';
  const rest = src.slice(i + 1);
  const j = rest.search(/\n(?:async )?function |\nconst |\n<\/script>/);
  return src.slice(i, j < 0 ? undefined : i + 1 + j);
};

describe('Z4 设置页 — 模型组编辑器（SecModelGroups）', () => {
  const f = (): string => read('settings/SecModelGroups.vue');

  it('组件存在，挂在「模型」tab、provider 列表之后', () => {
    expect(existsSync(join(UI, 'settings/SecModelGroups.vue'))).toBe(true);
    const s = read('StageSettings.vue');
    expect(s).toContain("import SecModelGroups from './settings/SecModelGroups.vue'");
    expect(s).toMatch(/v-if="sec === 'models'"[^>]*>\s*<SecModels \/>\s*<SecModelGroups \/>/);
  });

  it('增删改三个 action 都有调用，进页重拉一次且把错误显示出来', () => {
    const g = f();
    expect(g).toMatch(/await chat\.createModelGroup\(/);
    expect(g).toMatch(/await chat\.updateModelGroup\(/);
    expect(g).toMatch(/await chat\.deleteModelGroup\(/);
    expect(fnBody(g, 'refresh')).toMatch(/await chat\.refreshModelGroups\(\)[\s\S]*catch \(e\) \{\s*err\.value = /);
    expect(g).toMatch(/onMounted\(refresh\)/);
  });

  it('保存前先在前端拦空名与空成员（后端对空 memberIds 静默忽略——不拦就是谎报已保存）', () => {
    const save = fnBody(f(), 'save');
    const iName = save.indexOf("'给模型组起个名字'");
    const iMem = save.indexOf("'至少选一个模型'");
    const iCall = save.search(/chat\.(create|update)ModelGroup\(/);
    expect(iName).toBeGreaterThan(-1);
    expect(iMem).toBeGreaterThan(-1);
    expect(iCall).toBeGreaterThan(iName);
    expect(iCall).toBeGreaterThan(iMem);
  });

  it('成员有序：上移 / 下移 / 移出，加入下拉只列还没进组的 provider', () => {
    const g = f();
    expect(g).toMatch(/function moveMember\(i: number, d: -1 \| 1\)/);
    expect(g).toMatch(/function removeMember\(i: number\)/);
    for (const t of ['上移', '下移', '移出']) expect(g).toContain(`title="${t}"`);
    expect(g).toMatch(/chat\.providers\.filter\(p => !fMembers\.value\.includes\(p\.id\)\)/);
  });

  it('两句说明照事实写：什么情况立刻换 / 重试后再换；换成功后会话改绑、不回组；单成员不降级', () => {
    const g = f();
    expect(g).toContain('限流、密钥失效、请求被拒会立刻换');
    expect(g).toContain('重试约一分钟再换');
    expect(g).toContain('改绑到接手的模型');
    expect(g).toContain('只有一个成员时不会降级');
  });

  it('列表按成员顺序给出整条链（已删成员如实标出）', () => {
    expect(f()).toMatch(/groupChain\(g, chat\.providers\)/);
    expect(f()).toContain("from '../../lib/models/binding'");
  });

  it('删除确认先数绑定：会话与助手各几个，并说出删除后的真实后果', () => {
    const g = f();
    expect(g).toMatch(/chat\.sessions\.filter\(s => s\.modelBinding === 'group:' \+ id\)/);
    expect(g).toMatch(/chat\.assistants\.filter\(a => a\.modelBinding === 'group:' \+ id\)/);
    expect(g).toContain('模型组无可用成员');
  });
});

describe('Z4 — 删 provider 前告知它在几个模型组里', () => {
  it('SecModels 的删除确认数组内成员', () => {
    const m = read('settings/SecModels.vue');
    expect(m).toMatch(/chat\.modelGroups\.filter\(g => g\.memberIds\.includes\(id\)\)\.length/);
    expect(m).toContain('个模型组里');
  });
});

describe('Z5 — 绑定入口认组', () => {
  it('会话菜单：模型组 optgroup，值带 group: 前缀；绑定对象已删时如实显示一个禁用项', () => {
    const r = read('NavRail.vue');
    expect(r).toMatch(/<optgroup v-if="chat\.modelGroups\.length" label="模型组">/);
    expect(r).toMatch(/<option v-for="g in chat\.modelGroups" :key="g\.id" :value="'group:' \+ g\.id">\{\{ g\.name \}\}<\/option>/);
    expect(r).toMatch(/<option v-if="bindingView\(s\)\.missing" :value="bindingValue\(s\)" disabled>/);
    // 归一化收进纯模块（lib/models/binding），这里只委托
    expect(r).toMatch(/function bindingValue\(s: S\): string \{\s*return normalizeBinding\(s\.modelBinding\);\s*\}/);
  });

  it('助手编辑器：同一套 optgroup；列表标签走 describeBinding，不再自己拼前缀', () => {
    const a = read('StageAssistants.vue');
    expect(a).toMatch(/<optgroup v-if="chat\.modelGroups\.length" label="模型组">/);
    expect(a).toMatch(/:value="'group:' \+ g\.id"/);
    expect(a).toMatch(/describeBinding\(a\.modelBinding, chat\.providers, chat\.modelGroups, chat\.defaultProviderId\)/);
    expect(a).not.toContain('providerNameOf');
  });

  it('输入卡模型胶囊显示实际生效的绑定：会话绑定 > 欢迎页选中助手的绑定 > 默认', () => {
    const c = read('Composer.vue');
    // 脚本段先剥注释再断言：读原文的话，代码退回旧三元式、上方留一行写着新调用的注释，正则照样命中
    // （W2b-4 审查实测过这个变异；交接 §2 第 10 条）。
    // 脚本 / 模板 / 样式三段都由 SFC 解析器切出再各剥注释（W2b-4b 第二次审查补）：原来在原文上找块边界，
    // 脚本里一行 // 注释写着 <template> 或 <style>、样式注释里写着 </template>、文件顶部 <!-- --> 里写着 <script，
    // 边界就落进注释，注释里的旧胶囊、旧规则、旧调用跟着进了切片，本段剥不到，下面各条照样全绿（审查沙箱实测 4 个变异）
    const { script: cs, template: ct, style: cy } = sfcBlocks(c, 'Composer.vue');
    expect(cs).toContain("from '../lib/models/binding'");
    // W2b-4 重指：原来逐字锚「有会话看会话绑定、否则看欢迎页所选助手」的三元式——空会话上选了助手时，
    // 发送前会先套用它，三元式却仍显示会话的旧绑定。三档取舍收进纯模块 previewBinding（语义由
    // tests/renderer-welcome-assistant.test.ts 的单测接住），这里只认调用形态。
    // W2b-4b：调用形态连入参一起认——原来的三元式钉住了「看会话的绑定、看所选助手的绑定」，只认调用头的话，
    // 入参换成 { ...state, sessionBinding: '' } 与 [] 胶囊就永远说「默认 · X」，照样全绿（第三轮审查变异 3）。
    // 入参由纯模块 applyStateOf 从 store 组装，逐字段的单测也在 renderer-welcome-assistant 里
    expect(cs).toMatch(/const effectiveBinding = computed\(\(\) => previewBinding\(applyStateOf\(chat\), chat\.assistants\)\);/);
    expect(cs).toMatch(/import \{[^}]*\bapplyStateOf\b[^}]*\} from '\.\.\/lib\/welcome\/assistant'/);
    expect(cs).toMatch(/describeBinding\(effectiveBinding\.value, chat\.providers, chat\.modelGroups, chat\.defaultProviderId\)/);
    // W2b-4b 审查补：模板与样式此前读的是原文 c——`<span>{{ permLabel }}<!-- {{ modelView.label }} --></span>`
    // 让胶囊不再显示生效的模型，照样全绿。模板段剥 <!-- -->、样式段剥 /* */ 后再断言（ct、cy 见上）
    expect(ct).toMatch(/:name="modelView\.kind === 'group' \? 'link' : 'robot'"/);
    expect(ct).toMatch(/:title="modelView\.title"/);
    expect(ct).toMatch(/\{\{ modelView\.label \}\}/);
    // 绑定对象已删：胶囊要变色，不能照常显示
    expect(ct).toMatch(/:class="\{ bad: modelView\.missing \}"/);
    expect(cy).toMatch(/\.cap\.bad\s*\{[^}]*var\(--c-warn\)/);
    // 上面几样须长在同一枚 .cap 胶囊上：散落到别处（比如 label 挪进一个 v-if="false" 的元素）也要红
    expect(ct).toMatch(/<span class="cap" :class="\{ bad: modelView\.missing \}" :title="modelView\.title">\s*<UiIcon :name="modelView\.kind === 'group' \? 'link' : 'robot'" :size="13" \/>\s*<span>\{\{ modelView\.label \}\}<\/span>\s*<\/span>/);
  });
});
