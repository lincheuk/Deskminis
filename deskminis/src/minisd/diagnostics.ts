// M4 Task 4：dry-run 预检（diagnostics.dryRun RPC + CLI 包装）
// 不调模型/不执行工具/不连桥，纯静态解析 ready/warning/blocked + 具体下一步建议。
// 覆盖 providers/vault/model-catalog/技能/桥/M3c 配对/系统提示预览与 token 估算。
//
// 红线：
//   - authMode=local（仅本机渲染进程/CLI 可调，remote/pairing 全拒）
//   - side-effect free（只读，不实例化 provider、不调模型、不连桥）
//   - 零新依赖（用原生 fs/path + 既有模块）

import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { ProviderStore, SecretVault } from './store/provider-store';
import type { ModelCatalog } from './providers/model-catalog';
import type { SkillStore } from './skills/store';
import type { PairingService } from './remote/pairing';
import type { PromptConfig } from './agent/system-prompt';
import { buildSystemPrompt } from './agent/system-prompt';
import { buildDisciplineBlock } from './agent/model-discipline';
import { buildSkillsBlock } from './skills/prompt';
import { resolveBridgeNode } from './bridge/server';
import type { RpcConnection, RpcMethods } from './rpc/server';

export interface CheckResult {
  status: 'ready' | 'warning' | 'blocked';
  detail?: string;
}

export interface DryRunResult {
  overall: 'ready' | 'warning' | 'blocked';
  checks: {
    providers: CheckResult;
    defaultProvider: CheckResult;
    fallbackChain: CheckResult;
    modelCatalog: CheckResult;
    skills: CheckResult[];
    bridgeNode: CheckResult;
    /** M3c 已配对设备列表（计划内修正：pairing 是数组而非 CheckResult，匹配测试 Array.isArray 断言） */
    pairing: Array<{ peerFingerprint: string; peerName: string; address?: string }>;
  };
  promptPreview: string;
  estimatedTokens: number;
}

export interface DryRunDeps {
  providers: ProviderStore;
  vault: SecretVault;
  catalog: ModelCatalog;
  skillStore: SkillStore;
  pairingService: PairingService;
  /** 技能根目录（检查 SKILL.md 可读性用，计划内修正：增 skillsRoot 字段） */
  skillsRoot: string;
  config: PromptConfig;
}

/**
 * 静态预检：逐项检查系统就绪状态，不调模型/不执行工具/不连桥。
 * 结果分级：ready（全通）/ warning（非阻断问题）/ blocked（阻断问题）。
 */
export async function dryRun(deps: DryRunDeps): Promise<DryRunResult> {
  const { providers, catalog, skillStore, pairingService, skillsRoot, config } = deps;

  // 1. providers.json 完整性（文件可加载即 ready，空列表不是错误）
  const providersCheck: CheckResult = { status: 'ready' };
  let providerList: ReturnType<typeof providers.list>;
  try {
    providerList = providers.list();
    providersCheck.detail = `${providerList.length} 个 provider 已配置`;
  } catch (e) {
    providerList = [] as ReturnType<typeof providers.list>;
    providersCheck.status = 'blocked';
    providersCheck.detail = `providers.json 解析失败: ${e instanceof Error ? e.message : String(e)}`;
  }

  // 2. 默认 provider（缺 key = blocked，阻断请求）
  const defaultId = providers.getDefaultId();
  let defaultProviderCheck: CheckResult;
  let defaultModelId: string | undefined;
  if (!defaultId) {
    defaultProviderCheck = { status: 'blocked', detail: '未配置默认 provider' };
  } else {
    const dp = providerList.find(p => p.id === defaultId);
    if (!dp) {
      defaultProviderCheck = { status: 'blocked', detail: '默认 provider 不存在' };
    } else if (dp.kind !== 'ollama' && !dp.hasApiKey) {
      defaultProviderCheck = { status: 'blocked', detail: `缺少 API Key（provider: ${dp.name}）` };
    } else {
      defaultProviderCheck = { status: 'ready', detail: dp.name };
      defaultModelId = dp.modelId;
    }
  }

  // 3. 降级链完整性（模型组成员缺 key = warning，非阻断——首 provider 仍可用）
  const fallbackCheck: CheckResult = { status: 'ready' };
  try {
    const groups = providers.listGroups();
    if (groups.length > 0) {
      const issues: string[] = [];
      for (const g of groups) {
        for (const mid of g.memberIds) {
          const p = providerList.find(x => x.id === mid);
          if (!p) {
            issues.push(`${g.name}:成员已删除`);
          } else if (p.kind !== 'ollama' && !p.hasApiKey) {
            issues.push(`${g.name}:${p.name} 缺少 API Key`);
          }
        }
      }
      if (issues.length > 0) {
        fallbackCheck.status = 'warning';
        fallbackCheck.detail = issues.join('; ');
      } else {
        fallbackCheck.detail = `${groups.length} 个模型组配置正常`;
      }
    } else {
      fallbackCheck.detail = '未配置模型组';
    }
  } catch {
    fallbackCheck.status = 'warning';
    fallbackCheck.detail = '模型组配置解析失败';
  }

  // 4. model-catalog 窗口解析（未知模型 = warning，回退 FALLBACK_WINDOW 仍可运行但有两个后果）
  let modelCatalogCheck: CheckResult;
  if (defaultModelId) {
    const window = catalog.getModelContextWindow(defaultModelId);
    if (window !== undefined) {
      modelCatalogCheck = { status: 'ready', detail: String(window) };
    } else {
      // M4.5 Task 4：说清两个后果 + 给出修法（models.dev/basellm/BUILTIN/手动 contextWindow 均未命中时）
      modelCatalogCheck = {
        status: 'warning',
        detail: `未知模型 ${defaultModelId}，回退 32K 档（offload 过早触发且永不 compact）+ thinking 被钳到 off。修法：在 providers.json 为该 provider 配 contextWindow 字段，或等待 models.dev 目录更新`
      };
    }
  } else {
    modelCatalogCheck = { status: 'warning', detail: '无默认 provider，无法解析模型窗口' };
  }

  // 5. 技能 SKILL.md 可读性（仅检查启用技能；不可读 = warning，非阻断）
  const skillsChecks: CheckResult[] = [];
  for (const skill of skillStore.list()) {
    if (!skill.isEnabled) continue;
    const skillMd = join(skillsRoot, skill.id, 'SKILL.md');
    if (!existsSync(skillMd)) {
      skillsChecks.push({ status: 'warning', detail: `技能 ${skill.name} 的 SKILL.md 不存在` });
    } else {
      try {
        readFileSync(skillMd, 'utf8');
        skillsChecks.push({ status: 'ready', detail: skill.name });
      } catch {
        skillsChecks.push({ status: 'warning', detail: `技能 ${skill.name} 的 SKILL.md 不可读` });
      }
    }
  }

  // 6. 桥 node 解析（无 node.exe = warning，桥命令不可用但不阻断主流程）
  const bridgeNodePath = resolveBridgeNode();
  const isNodeExe = basename(bridgeNodePath).toLowerCase() === 'node.exe';
  const bridgeNodeCheck: CheckResult = isNodeExe
    ? { status: 'ready', detail: bridgeNodePath }
    : { status: 'warning', detail: `未找到 node.exe，回退到 ${bridgeNodePath}` };

  // 7. M3c 配对状态（列出已配对设备，纯信息性）
  const pairing = pairingService.listWithAddress().map(d => ({
    peerFingerprint: d.peerFingerprint,
    peerName: d.peerName,
    address: d.address,
  }));

  // 8. 系统提示预览 + token 估算（用 bridgeGranted=true 展示完整提示）
  const modelId = defaultModelId ?? 'gpt-5';
  const disciplineBlock = buildDisciplineBlock(modelId, config.discipline ?? {});
  const enabledSkills = skillStore.list().filter(s => s.isEnabled).map(s => ({
    id: s.id, name: s.name, description: s.description,
    updatedAt: s.updatedAt, useCount: s.useCount, importSource: s.importSource,
  }));
  const skillsBlock = buildSkillsBlock(enabledSkills, skillsRoot, Math.floor(Date.now() / 1000));
  const promptPreview = buildSystemPrompt({
    sessionId: '__dryrun__',
    modelId,
    bridgeGranted: true,
    config,
    skillsBlock,
    memoryBlock: '',
    disciplineBlock,
  });
  const estimatedTokens = Math.ceil(promptPreview.length / 4);

  // 计算 overall：blocked > warning > ready
  const allChecks: CheckResult[] = [
    providersCheck, defaultProviderCheck, fallbackCheck, modelCatalogCheck, bridgeNodeCheck, ...skillsChecks,
  ];
  const overall: DryRunResult['overall'] = allChecks.some(c => c.status === 'blocked')
    ? 'blocked'
    : allChecks.some(c => c.status === 'warning')
      ? 'warning'
      : 'ready';

  return {
    overall,
    checks: {
      providers: providersCheck,
      defaultProvider: defaultProviderCheck,
      fallbackChain: fallbackCheck,
      modelCatalog: modelCatalogCheck,
      skills: skillsChecks,
      bridgeNode: bridgeNodeCheck,
      pairing,
    },
    promptPreview,
    estimatedTokens,
  };
}

/**
 * 创建 diagnostics.* RPC 方法集。
 * authMode=local 守卫：仅本机渲染进程/CLI 可调，remote/pairing 全拒。
 * guardBusinessMethod（index.ts 装配时包装）另拒 pairing——双重保险。
 */
export function createDiagnosticsMethods(deps: DryRunDeps): RpcMethods {
  return {
    'diagnostics.dryRun': async (_p, conn: RpcConnection) => {
      if (conn.authMode !== 'local') {
        throw new Error(`diagnostics.dryRun 需要 authMode=local，当前=${conn.authMode}`);
      }
      return dryRun(deps);
    },
  };
}
