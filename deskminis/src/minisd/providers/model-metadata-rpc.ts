import type { ThinkingPlanView } from '../../shared/runtime-model';
import type { ModelCatalog } from './model-catalog';
import { resolveRuntimeModel, thinkingIsServerAdaptive, decideThinking, type RuntimeModelInput } from './runtime-model';
import type { ProviderInstance } from '../store/provider-store';

const KINDS = new Set(['anthropic', 'openai-compat', 'gemini', 'ollama']);

/** Public catalog queries never receive provider credentials or conversation content. */
export function createModelMetadataMethods(catalog: ModelCatalog, deps: { getInstance?: (id: string) => ProviderInstance | undefined } = {}) {
  return {
    'provider.catalog.get': async () => { await catalog.refresh(); return catalog.getStatus(); },
    'provider.catalog.providers': () => {
      const apis = catalog.providerApiUrls();
      return { providers: Object.keys(apis).sort().map(id => ({ id, api: apis[id] })) };
    },
    'provider.catalog.refresh': async () => ({ refreshed: await catalog.refresh(true), status: catalog.getStatus() }),
    'provider.models.metadata': async (params: unknown) => {
      const p = params as { modelId?: unknown; providerId?: unknown } | null | undefined;
      if (typeof p?.modelId !== 'string' || !p.modelId.trim() || p.modelId.length > 256) throw new Error('modelId 必须是非空字符串（最多 256 字符）');
      if (p.providerId !== undefined && (typeof p.providerId !== 'string' || !p.providerId.trim() || p.providerId.length > 128)) throw new Error('providerId 必须是非空字符串（最多 128 字符）');
      await catalog.refresh();
      return { metadata: catalog.getModelMetadata(p.modelId.trim(), (p.providerId as string | undefined)?.trim()), status: catalog.getStatus() };
    },
    /**
     * F01：运行时规格（与 chat.prompt 交给 Agent 循环的是同一个 resolver）。两种入参：
     *  - { id }：已保存的配置实例；
     *  - { kind, modelId, baseUrl?, contextWindow?, maxOutputTokens?, capabilityOverrides? }：设置页还没保存的表单。
     *    手动值原样交给 resolver 归一——不合法的进 runtime.overrides.invalid 给界面显示，而不是整个预览报错。
     * 不收密钥、不发探测请求；目录按 24 小时有效期刷新（与 provider.models.metadata 相同）。
     */
    'provider.runtime.resolve': async (params: unknown) => {
      const p = (params ?? {}) as Record<string, unknown>;
      let input: RuntimeModelInput;
      if (p.id !== undefined) {
        if (typeof p.id !== 'string' || !p.id.trim() || p.id.length > 128) throw new Error('id 必须是非空字符串（最多 128 字符）');
        const inst = deps.getInstance?.(p.id.trim());
        if (!inst) throw new Error(`provider 不存在: ${p.id}`);
        input = inst;
      } else {
        if (typeof p.kind !== 'string' || !KINDS.has(p.kind)) throw new Error('kind 必须是 anthropic/openai-compat/gemini/ollama 之一');
        if (typeof p.modelId !== 'string' || !p.modelId.trim() || p.modelId.length > 256) throw new Error('modelId 必须是非空字符串（最多 256 字符）');
        if (p.baseUrl !== undefined && p.baseUrl !== null && (typeof p.baseUrl !== 'string' || p.baseUrl.length > 512)) throw new Error('baseUrl 必须是字符串（最多 512 字符）');
        input = {
          kind: p.kind as RuntimeModelInput['kind'], modelId: p.modelId.trim(),
          ...(typeof p.baseUrl === 'string' && p.baseUrl.trim() ? { baseUrl: p.baseUrl.trim() } : {}),
          ...(typeof p.name === 'string' ? { name: p.name.slice(0, 128) } : {}),
          contextWindow: p.contextWindow, maxOutputTokens: p.maxOutputTokens, capabilityOverrides: p.capabilityOverrides,
          catalogProviderId: p.catalogProviderId,
        };
      }
      await catalog.refresh();
      const runtime = resolveRuntimeModel(input, catalog);
      const preview = (level: 'xhigh' | 'max'): ThinkingPlanView => {
        const plan = decideThinking(runtime, level, runtime.requestMaxTokens, runtime.instanceName || runtime.modelId);
        return { ...plan, level: plan.effort ?? plan.level };
      };
      return { runtime, status: catalog.getStatus(), thinkingServerAdaptive: thinkingIsServerAdaptive(runtime),
        thinkingPreview: { xhigh: preview('xhigh'), max: preview('max') } };
    },
  };
}
