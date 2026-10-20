import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, isVNode, nextTick, type VNode } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelCatalog } from '../src/minisd/providers/model-catalog';
import { createModelMetadataMethods } from '../src/minisd/providers/model-metadata-rpc';
import { useChat } from '../src/renderer/src/stores/chat';
import { runSetup, type SetupRun } from './sfc-setup';
import { GO_MODEL, GO_URL, n21CatalogFixture } from './n21-catalog-fixture';

const probe = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: probe.call, on: vi.fn(), onLost: vi.fn(), connect: vi.fn() } }));
const SEC = join(__dirname, '../src/renderer/src/ui/settings/SecModels.vue');
type Render = (ctx: object, cache: unknown[]) => VNode;
let root: string;
let catalog: ModelCatalog;
let run: SetupRun<Render> | undefined;
let chat: ReturnType<typeof useChat>;
const config = { id: 'P21', name: '合成OpenCode Go', kind: 'openai-compat', baseUrl: GO_URL, modelId: GO_MODEL, hasApiKey: true };

function all(v: unknown): VNode[] { return Array.isArray(v) ? v.flatMap(all) : isVNode(v) ? [v, ...all(v.children)] : []; }
function text(v: unknown): string { return Array.isArray(v) ? v.map(text).join('') : isVNode(v) ? text(v.children) : typeof v === 'string' || typeof v === 'number' ? String(v) : ''; }
async function view(p = config) {
  chat.providers = [p];
  run = await runSetup<Render>(SEC, {}, effectScope(), { inlineTemplate: true });
  const cache: unknown[] = [], render = () => run!.bindings({}, cache);
  run.mount();
  all(render()).find(n => n.type === 'button' && text(n) === '编辑')!.props!.onClick();
  await nextTick();
  await vi.advanceTimersByTimeAsync(250);
  await nextTick();
  const select = () => all(render()).find(n => n.type === 'select' && n.props?.['data-override'] === 'catalog-provider')!;
  const choose = async (value: string) => { select().props!['onUpdate:modelValue'](value); await nextTick(); await vi.advanceTimersByTimeAsync(250); await nextTick(); };
  const submit = () => all(render()).find(n => n.type === 'form')!.props!.onSubmit({ preventDefault() {}, stopPropagation() {} });
  return { render, select, choose, submit };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dm-n21-renderer-'));
  catalog = new ModelCatalog(join(root, 'catalog.json'), async () => new Response(JSON.stringify(n21CatalogFixture())));
  await catalog.refresh(true);
  setActivePinia(createPinia()); chat = useChat();
  const methods = createModelMetadataMethods(catalog);
  probe.call.mockReset();
  probe.call.mockImplementation(async (method: string, params: any) => {
    if (method in methods) return (methods as any)[method](params);
    if (method === 'provider.instances.list') return [config];
    if (method === 'provider.getDefault') return { id: '' };
    return { ok: true };
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => { run?.unmount(); run = undefined; vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

describe('N21 模型配置目录服务商入口', () => {

  it('store action 调对RPC并返回原应答', async () => {
    const result = await chat.getCatalogProviders();
    expect(probe.call).toHaveBeenCalledWith('provider.catalog.providers');
    expect(result.providers).toEqual(Object.entries(catalog.providerApiUrls()).sort(([a], [b]) => a < b ? -1 : 1).map(([id, api]) => ({ id, api })));
  });

  it('下拉自动项在前，同主机按id分组，不比较整个路径', async () => {
    const ui = await view();
    const options = all(ui.select()).filter(n => n.type === 'option');
    expect(options[0].props?.value).toBe('');
    expect(text(options[0])).toBe('自动（按地址判断）');
    const groups = all(ui.select()).filter(n => n.type === 'optgroup');
    expect(groups.map(n => n.props?.label)).toEqual(['与地址同主机', '其它服务商']);
    expect(all(groups[0]).filter(n => n.type === 'option').map(n => n.props?.value)).toEqual(['opencode-go', 'opencode-z']);
    const others = all(groups[1]).filter(n => n.type === 'option').map(n => String(n.props?.value));
    expect(others).toEqual([...others].sort());
    expect(others[0]).toBe('aaa-other');
    expect(text(ui.render())).toContain('自动判断：中转或未收录的端点');
    expect(ui.select().props?.disabled).toBe(false);
  });

  it('指定后规格与每行依据都写手动服务商，自动判断仍显示真实地址结果', async () => {
    const ui = await view();
    await ui.choose('opencode-go');
    const tree = ui.render();
    expect(text(tree)).toContain('自动判断：中转或未收录的端点');
    expect(text(tree)).toContain('Cat Jam · 手动指定为 models.dev / opencode-go');
    const rows = all(tree).filter(n => n.type === 'tr' && String(n.props?.class).startsWith('st-'));
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      const cells = all(row).filter(n => n.type === 'td');
      expect(cells).toHaveLength(2); // 首列是行标题th，第二个td才是“依据 / 原因”。
      expect(text(cells[1])).toContain('手动指定为 models.dev / opencode-go');
    }
    expect(text(tree)).toContain('端点声明：档位 low/medium/high/max');
  });

  it('保存带字段，选回自动明确发null', async () => {
    const ui = await view();
    await ui.choose('opencode-go');
    await ui.submit();
    expect(probe.call).toHaveBeenCalledWith('provider.instances.update', expect.objectContaining({ id: 'P21', catalogProviderId: 'opencode-go' }));
    run!.unmount(); run = undefined;
    const auto = await view({ ...config, catalogProviderId: 'opencode-go' } as typeof config);
    await auto.choose('');
    await auto.submit();
    expect(probe.call).toHaveBeenCalledWith('provider.instances.update', expect.objectContaining({ id: 'P21', catalogProviderId: null }));
  });

  it('官方端点置灰并说明，仍按官方结果预览', async () => {
    const ui = await view({ ...config, baseUrl: 'https://api.openai.com/v1' });
    expect(ui.select().props?.disabled).toBe(true);
    expect(text(ui.render())).toContain('官方端点按地址认定，不用手动指定');
    expect(text(ui.render())).toContain('自动判断：官方端点');
  });

  it('未知的已存id保留在下拉，不在读取时擅自清掉', async () => {
    const ui = await view({ ...config, catalogProviderId: 'temporarily-missing' } as typeof config);
    expect(all(ui.select()).some(n => n.type === 'option' && n.props?.value === 'temporarily-missing')).toBe(true);
    expect(text(ui.render())).toContain('temporarily-missing（当前目录未收录）');
    expect(text(ui.render())).toContain('已忽略');
    await ui.submit();
    expect(probe.call).toHaveBeenCalledWith('provider.instances.update', expect.objectContaining({ catalogProviderId: 'temporarily-missing' }));
  });
});
