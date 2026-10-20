/**
 * F01 渲染端：设置页规格卡显示的是运行时解析结果（provider.runtime.resolve），手动修正只随本配置提交；
 * 聊天侧的能力兼容事件看得见、不给无意义的重试。
 * 真跑 SecModels.vue 的 setup（sfc-setup），rpc 桩把调用转给真 resolver + 夹具目录——卡片拿到的就是后端会算出的东西。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vue from 'vue';

const { rpcCall } = vi.hoisted(() => ({ rpcCall: vi.fn() }));
vi.mock('../src/renderer/src/rpc', () => ({
  rpc: { call: rpcCall, connect: async () => {}, on: () => {}, off: () => {}, onLost: () => {} },
}));

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部，此处 import 拿到的是桩
import { createPinia, setActivePinia } from 'pinia';
// eslint-disable-next-line import/first
import { useChat } from '../src/renderer/src/stores/chat';
// eslint-disable-next-line import/first
import { eventCopy, errorShortByCode, fallbackShortByCause } from '../src/renderer/src/lib/eventnote/copy';
// eslint-disable-next-line import/first
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
// eslint-disable-next-line import/first
import { resolveRuntimeModel, type RuntimeModelInput } from '../src/minisd/providers/runtime-model';
// eslint-disable-next-line import/first
import { runSetup } from './sfc-setup';
// eslint-disable-next-line import/first
import { sfcBlocks } from './sfc-blocks';
// eslint-disable-next-line import/first
import { catalogFixtureF01R, jsonResponse } from './runtime-model-fixture';
// eslint-disable-next-line import/first
import type { Capability, LimitValue, RuntimeModel } from '../src/shared/runtime-model';

const SEC = join(__dirname, '../src/renderer/src/ui/settings/SecModels.vue');

type Row = { key: string; label: string; cap: Capability; why: string };
type SecBindings = {
  form: Record<string, string>;
  err: { value: string };
  runtime: { value: RuntimeModel | null };
  capabilityRows: { value: Row[] };
  declaredMedia: { value: string };
  windowPlaceholder: { value: string };
  outputPlaceholder: { value: string };
  limitText(l: LimitValue, fallback: string): string;
  startEdit(p: Record<string, unknown>): void;
  submit(): Promise<void>;
};

let dir: string;
let catalog: ModelCatalog;
let scope = vue.effectScope();
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dm-sec-runtime-'));
  // F01R：换成超集夹具（原有 id 的结果不变，另有输出上限写成等于窗口的 ctx-out 等）
  catalog = new ModelCatalog(join(dir, 'c.json'), async () => jsonResponse(catalogFixtureF01R()));
  await catalog.refresh(true);
  setActivePinia(createPinia());
  scope = vue.effectScope();
  rpcCall.mockReset();
  rpcCall.mockImplementation(async (method: string, params: Record<string, unknown>) => {
    if (method === 'provider.runtime.resolve') return { runtime: resolveRuntimeModel(params as unknown as RuntimeModelInput, catalog), status: catalog.getStatus() };
    if (method === 'provider.catalog.get') return catalog.getStatus();
    if (method === 'provider.instances.list') return [];
    if (method === 'provider.getDefault') return { id: '' };
    if (method === 'chat.messages.list') return [];
    return { ok: true };
  });
});
afterEach(() => { scope.stop(); rmSync(dir, { recursive: true, force: true }); });

const settle = async (): Promise<void> => {
  await new Promise(r => setTimeout(r, 320)); // 卡片查询防抖 250ms
  await vue.nextTick();
};

describe('F01 设置页规格卡：按运行时解析显示，三层交集', () => {
  it('理解视频的文本模型：视频输入「不可用」并写明模型支持、应用未接入；没有「视频生成」一行；手动修正随查询带上', async () => {
    const { bindings, mount } = await runSetup<SecBindings>(SEC, {}, scope);
    mount();
    bindings.startEdit({ id: 'P1', name: 'Gemini', kind: 'gemini', baseUrl: '', modelId: 'gem-v', contextWindow: 500_000, capabilityOverrides: { imageInput: false } });
    await settle();
    expect(rpcCall).toHaveBeenCalledWith('provider.runtime.resolve', expect.objectContaining({
      kind: 'gemini', modelId: 'gem-v', contextWindow: '500000', maxOutputTokens: null, capabilityOverrides: { imageInput: false },
    }));
    const rows = bindings.capabilityRows.value;
    const video = rows.find(r => r.label === '视频输入');
    expect(video?.cap.state).toBe('unavailable');
    expect(video?.why).toContain('模型支持视频输入');
    expect(rows.some(r => r.label === '视频生成')).toBe(false);
    expect(rows.find(r => r.label === '文本输出')?.cap.state).toBe('supported');
    // 手动标「不支持」：结论随修正，但目录声明（支持图片）仍在——下一行的「目录声明」照常列出图片
    expect(rows.find(r => r.label === '图片输入')).toMatchObject({ cap: { state: 'unsupported', manual: false, catalog: { value: true } } });
    expect(rows.find(r => r.label === '图片输入')?.why).toContain('手动标为不支持');
    expect(rows.find(r => r.label === '推理')?.why).toContain('端点声明：档位 minimal/low/medium/high');
    expect(bindings.declaredMedia.value).toBe('目录声明：输入 文本、图片、音频、视频、PDF；输出 文本');
    expect(bindings.runtime.value?.limits.contextWindow).toEqual({ value: 500_000, source: 'manual', declared: 1_048_576 });
    expect(bindings.windowPlaceholder.value).toContain('1,048,576');
  });

  it('只出视频的模型：「视频生成」一行出现但不可用，文本输出「不支持」', async () => {
    const { bindings, mount } = await runSetup<SecBindings>(SEC, {}, scope);
    mount();
    bindings.startEdit({ id: 'P2', name: '中转', kind: 'openai-compat', baseUrl: 'https://relay.example/v1', modelId: 'veo-x' });
    await settle();
    const rows = bindings.capabilityRows.value;
    expect(rows.find(r => r.label === '视频生成')).toMatchObject({ cap: { state: 'unavailable' } });
    expect(rows.find(r => r.label === '视频生成')?.why).toContain('当前应用只接入文本输出');
    expect(rows.find(r => r.label === '文本输出')?.cap.state).toBe('unsupported');
  });

  it('保存：清空的修正显式发 null（JSON 会丢掉 undefined）；不合法的数字当场拦下、不发请求', async () => {
    const { bindings, mount } = await runSetup<SecBindings>(SEC, {}, scope);
    mount();
    bindings.startEdit({ id: 'P1', name: 'Gemini', kind: 'gemini', baseUrl: '', modelId: 'gem-v', contextWindow: 500_000, maxOutputTokens: 9_000, capabilityOverrides: { toolCall: false } });
    bindings.form.maxOutputTokens = '12k';
    await bindings.submit();
    expect(bindings.err.value).toContain('最大输出必须是正整数');
    expect(rpcCall.mock.calls.some(([m]) => m === 'provider.instances.update')).toBe(false);
    bindings.form.contextWindow = '';
    bindings.form.maxOutputTokens = '';
    bindings.form.capTools = 'auto';
    bindings.form.capReasoning = 'off';
    await bindings.submit();
    expect(rpcCall).toHaveBeenCalledWith('provider.instances.update', expect.objectContaining({
      id: 'P1', contextWindow: null, maxOutputTokens: null, capabilityOverrides: { reasoning: false },
    }));
  });

  it('模板：能力表三列（能力 / 当前接入 / 依据或原因），不合法的手动值照实显示「已忽略」', () => {
    const { template } = sfcBlocks(readFileSync(SEC, 'utf8').replace(/\r\n/g, '\n'), 'SecModels.vue');
    expect(template).toMatch(/v-for="row in capabilityRows"/);
    expect(template).toMatch(/capabilityStateLabel\(row\.cap\.state\)/);
    expect(template).toMatch(/\{\{ row\.why \}\}/);
    expect(template).toMatch(/runtime\.overrides\.invalid\.join/);
    expect(template).toMatch(/v-model="form\.capImage"/);
  });
});

describe('F01R 设置页规格卡：没被采用的目录输出上限、未确认的推理都照实显示', () => {
  /** 等规格卡拿到这个型号的解析结果（查询有防抖；按条件等，不靠固定时长）。 */
  const resolved = async (bindings: SecBindings, modelId: string): Promise<RuntimeModel> => {
    await vi.waitFor(() => { expect(bindings.runtime.value?.modelId).toBe(modelId); }, { timeout: 5000, interval: 20 });
    await vue.nextTick();
    return bindings.runtime.value!;
  };

  it('目录把输出上限写成等于窗口（ctx-out）：显示实际发送的佐证值与目录原值，占位按实际发送值', async () => {
    const { bindings, mount } = await runSetup<SecBindings>(SEC, {}, scope);
    mount();
    bindings.startEdit({ id: 'P3', name: '甲', kind: 'openai-compat', baseUrl: 'https://api.vendor-a.example/v1', modelId: 'ctx-out' });
    const rt = await resolved(bindings, 'ctx-out');
    expect(rt.limits.maxOutputTokens).toMatchObject({ value: 65_536, declared: 262_144 });
    expect(rt.limits.maxOutputTokens.note).toContain('未采用');
    const shown = bindings.limitText(rt.limits.maxOutputTokens, '按 65,536 计');
    expect(shown).toContain('65,536 tokens');
    expect(shown).toContain('目录 262,144');
    expect(bindings.outputPlaceholder.value).toBe('留空 = 按资料（65,536）');
  });

  it('目录值不可信又没有佐证值（中转上的 veo-x，窗口 480）：写明「未采用目录值」与实际发送值', async () => {
    const { bindings, mount } = await runSetup<SecBindings>(SEC, {}, scope);
    mount();
    bindings.startEdit({ id: 'P4', name: '中转', kind: 'openai-compat', baseUrl: 'https://relay.example/v1', modelId: 'veo-x' });
    const rt = await resolved(bindings, 'veo-x');
    expect(rt.requestMaxTokens).toBe(360);
    expect(bindings.limitText(rt.limits.maxOutputTokens, '按 360 计')).toBe('未采用目录值 8,192（按 360 计）');
    // 兜底值不是目录资料：占位不能写成「按资料（360）」，与上面那一行的口径一致
    expect(bindings.outputPlaceholder.value).toBe('留空 = 按 360 计（目录无可用值）');
    // 目录压根没写的仍是「未确认」
    expect(bindings.limitText({ source: 'none' }, '按 8,192 计')).toBe('未确认（按 8,192 计）');
  });

  it('最大输出输入框的占位：只有确实采用了目录值才写「按资料」；没有资料、目录明写 0 时写的是兜底值，不冒充资料', async () => {
    const { bindings, mount } = await runSetup<SecBindings>(SEC, {}, scope);
    mount();
    const placeholderOf = async (id: string, baseUrl: string, modelId: string): Promise<string> => {
      bindings.startEdit({ id, name: id, kind: 'openai-compat', baseUrl, modelId });
      await resolved(bindings, modelId);
      return bindings.outputPlaceholder.value;
    };
    // 中转上目录没收录的型号：窗口与输出都没有资料，相邻两个输入框口径一致（都不说成资料值）
    expect(await placeholderOf('P6', 'https://relay.example/v1', 'not-in-catalog')).toBe('留空 = 按 8,192 计（目录无可用值）');
    expect(bindings.runtime.value?.limits.maxOutputTokens).toEqual({ source: 'none' });
    expect(bindings.windowPlaceholder.value).toBe('留空 = 按资料（暂无，按 128,000 计）');
    expect(bindings.limitText(bindings.runtime.value!.limits.maxOutputTokens, '按 8,192 计')).toBe('未确认（按 8,192 计）');
    // 目录只有窗口、没有输出上限
    expect(await placeholderOf('P7', 'https://relay.example/v1', 'bare-model')).toBe('留空 = 按 8,192 计（目录无可用值）');
    // 目录明写 0（只出图的型号）：0 不能当 max_tokens，请求走兜底值
    expect(await placeholderOf('P8', 'https://relay.example/v1', 'painter')).toBe('留空 = 按 8,192 计（目录无可用值）');
    expect(bindings.runtime.value?.limits.maxOutputTokens).toMatchObject({ value: 0 });
    // 对照：端点记录可信，占位就是资料值
    expect(await placeholderOf('P9', 'https://api.vendor-a.example/v1', 'shared-model')).toBe('留空 = 按资料（32,000）');
  });

  it('未确认的推理（中转上的 shared-model）：说明不发送推理参数，不再写「当前接入以…发送」', async () => {
    const { bindings, mount } = await runSetup<SecBindings>(SEC, {}, scope);
    mount();
    bindings.startEdit({ id: 'P5', name: '中转', kind: 'openai-compat', baseUrl: 'https://relay.example/v1', modelId: 'shared-model' });
    await resolved(bindings, 'shared-model');
    const row = bindings.capabilityRows.value.find(r => r.label === '推理');
    expect(row?.cap.state).toBe('unknown');
    expect(row?.why).toContain('未确认时不发送推理参数');
    expect(row?.why).not.toContain('当前接入以');
  });

  it('模板：最大输出按实际发送值兜底、其下有一行原因；底部说明与新规则一致', () => {
    const { template } = sfcBlocks(readFileSync(SEC, 'utf8').replace(/\r\n/g, '\n'), 'SecModels.vue');
    expect(template).toMatch(/limitText\(runtime\.limits\.maxOutputTokens, `按 \$\{formatCount\(runtime\.requestMaxTokens\)\} 计`\)/);
    expect(template).toMatch(/v-if="runtime\.limits\.maxOutputTokens\.note"/);
    expect(template).toMatch(/\{\{ runtime\.limits\.maxOutputTokens\.note \}\}/);
    expect(template).toContain('推理参数在未确认时不发送');
    expect(template).not.toContain('推理只在目录声明支持时才开');
  });
});

describe('F01 聊天侧：能力兼容事件看得见，capability 错误不给重试', () => {
  it('capability 事件进事件条（逐条进详情）；capability 错误不可重试；按能力换模型的降级有专门短句', () => {
    const chat = useChat();
    chat.activeId = 'S1';
    chat.onEvent({ kind: 'capability', label: '乙', notices: ['乙 不支持工具调用：本轮不提供工具', '乙 不支持图片输入：历史中 1 张图片改以文字占位发送'] });
    expect(chat.eventNotes.at(-1)).toMatchObject({ kind: 'capability', detail: '乙 不支持工具调用：本轮不提供工具\n乙 不支持图片输入：历史中 1 张图片改以文字占位发送' });
    chat.onEvent({ kind: 'fallback', from: '乙', to: '甲', reason: '乙 不支持图片输入', cause: 'capability' });
    expect(chat.eventNotes.at(-1)).toMatchObject({ kind: 'fallback', short: '当前模型不支持这条消息的内容，本轮改用 甲' });
    chat.onEvent({ kind: 'error', code: 'capability', message: '乙 不支持图片输入；模型组里也没有能接这一轮的备选模型' });
    expect(chat.eventNotes.at(-1)).toMatchObject({ kind: 'error', retryable: false, short: '没有能处理这条消息的模型，未发送' });
    // F01R：新增的提示种类是「未确认、照常发送」，原句「已按兼容方式发送」不准，改成中性句
    expect(eventCopy('capability')).toEqual({ icon: 'alert', short: '模型能力未确认或不符，处理方式见详情', tone: 'warn' });
    expect(errorShortByCode('capability')).toBe('没有能处理这条消息的模型，未发送');
    expect(fallbackShortByCause('capability', '甲')).toBe('当前模型不支持这条消息的内容，本轮改用 甲');
  });
});
