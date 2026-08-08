// 提示分层与条件注入（M4 Task 2）：stable/context 两层 + 桥段落条件注入。
// 参考 hermes agent/system_prompt.py（stable/context/volatile 三层，DeskMinis 不需要 volatile）。
//
// 分层定义：
//   - stable 段：基础身份 + 桥段落（条件注入）+ 纪律块（Task 3）。不含会话内容——跨轮稳定，prefix-cache 友好。
//   - context 段：技能块 + 记忆注入。每轮可变（技能开关/记忆文件更新）。
//
// 决策点 2：桥段落条件注入两层判据——全局配置开关（默认 full）+ 会话级桥授权状态。
// 决策点 3 方案 a：RunOptions.systemPrompt 改工厂函数，轮内动态重建 stable 段。

/** 基础身份段（不含桥段落，跨轮稳定）。 */
export const STABLE_IDENTITY = '你是 DeskMinis，一个运行在用户 Windows 电脑上的 AI Agent。你可以读写文件、执行 PowerShell 命令来帮助用户完成任务。危险操作会请求用户确认。';

/** 完整桥段落：六工具名 + 调用语法 + --help + 隐私确认。授权过桥的会话注入。 */
export const BRIDGE_SECTION_FULL = '本机提供六个 Windows 能力桥，在 shell 中调用：& "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" <工具> [参数]（若系统装有 Node.js，node "$env:MINIS_BRIDGE_CLI" ... 亦可）。工具：windows-notify（弹系统通知）、windows-clipboard（读/写剪贴板）、windows-open（用默认程序打开网址或文件）、windows-speak（语音播报文本）、windows-screenshot（截屏保存到会话附件目录）、windows-device（读取系统信息）。需要某个工具的详细参数时运行 & "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" <工具> --help 查看；剪贴板读取与截屏等隐私敏感操作会向用户请求确认。';

/** 精简桥提示：一句话 + --help。未授权桥的会话注入（让模型知道有桥能力但不展开六工具清单）。 */
export const BRIDGE_SECTION_MINIMAL = '本机提供 Windows 能力桥（剪贴板/通知/截屏等），运行 & "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" --help 查看可用工具与参数。';

/**
 * 向后兼容：原 SYSTEM_PROMPT 等价于 STABLE_IDENTITY + BRIDGE_SECTION_FULL。
 * 既有测试/调用方仍可 import { SYSTEM_PROMPT } 使用——等价于改前行为（无条件完整桥段落）。
 */
export const SYSTEM_PROMPT = STABLE_IDENTITY + BRIDGE_SECTION_FULL;

/** 提示层配置（providers.json prompt 段）。 */
export interface PromptConfig {
  /** 桥段落注入模式：'full'（默认，按会话授权状态选完整/精简）/ 'minimal'（始终精简）/ 'off'（不注入） */
  bridgeSection?: 'full' | 'minimal' | 'off';
  /** 纪律块开关（Task 3） */
  discipline?: { toolUseEnforcement?: boolean };
}

/** buildSystemPrompt 入参。 */
export interface BuildSystemPromptOpts {
  sessionId: string;
  /** 当前 activeSlot.provider.modelId——降级切换后传新 modelId，stable 缓存 miss 重建 */
  modelId: string;
  /** 会话是否曾授权过桥（PermissionGateway.hasBridgeGrant 查询结果） */
  bridgeGranted: boolean;
  config?: PromptConfig;
  /** 技能块（buildSkillsBlock 产物，context 段） */
  skillsBlock: string;
  /** 记忆注入模板（MemoryInjector.build('__BASE__', opts) 产物，含 __BASE__ 占位符；空串表示无记忆注入） */
  memoryBlock: string;
  /** 纪律块（buildDisciplineBlock 产物，Task 3 接入；可选） */
  disciplineBlock?: string;
}

/**
 * 组装系统提示：stable 段（基础身份 + 桥段落 + 纪律块）+ context 段（技能块 + 记忆注入）。
 * memoryBlock 含 __BASE__ 占位符时，用 stable + skillsBlock 替换占位符；否则直接拼接。
 */
export function buildSystemPrompt(opts: BuildSystemPromptOpts): string {
  const stable = buildStableSegment(opts.bridgeGranted, opts.config, opts.disciplineBlock);
  const base = stable + opts.skillsBlock;
  return opts.memoryBlock ? opts.memoryBlock.replace('__BASE__', base) : base;
}

/** 构建稳定段（基础身份 + 桥段落 + 纪律块）。供缓存使用。 */
function buildStableSegment(bridgeGranted: boolean, config?: PromptConfig, disciplineBlock?: string): string {
  const bridgeMode = config?.bridgeSection ?? 'full';
  let stable = STABLE_IDENTITY;
  if (bridgeMode === 'full') {
    stable += bridgeGranted ? BRIDGE_SECTION_FULL : BRIDGE_SECTION_MINIMAL;
  } else if (bridgeMode === 'minimal') {
    stable += BRIDGE_SECTION_MINIMAL;
  }
  // 'off' → 不注入桥段落
  if (disciplineBlock) stable += '\n\n' + disciplineBlock;
  return stable;
}

/** stable 段缓存键：sessionId + modelId + bridgeGranted + bridgeSection（三元组+配置）。 */
function stableCacheKey(sessionId: string, modelId: string, bridgeGranted: boolean, config?: PromptConfig): string {
  return `${sessionId}\u0000${modelId}\u0000${bridgeGranted}\u0000${config?.bridgeSection ?? 'full'}`;
}

/** stable 段缓存接口。 */
export interface StableCache {
  /** 按 sessionId+modelId+bridgeGranted+config 取缓存；未命中则重建并缓存。disciplineBlock 由 modelId 决定，同 key 固定，不入缓存键。 */
  get(sessionId: string, key: { bridgeGranted: boolean; modelId: string; config?: PromptConfig; disciplineBlock?: string }): string;
  /** 失效该会话所有缓存项（桥授权状态变化时调）。 */
  invalidate(sessionId: string): void;
  /** M4.6 Task 5：暴露内部 Map 供测试观测 size（残留设施，非公开 API——仅测试用）。 */
  _cache: Map<string, string>;
}

/** M4.6 Task 5：stable 缓存容量上限（插入序淘汰，止血无界增长，非性能优化）。 */
const STABLE_CACHE_MAX = 64;

/**
 * 创建 stable 段缓存（内存态 Map，不落库）。
 * 失效条件：桥授权状态变化（invalidate）/ 降级切换 provider（modelId 变 → 键变 → 自然 miss 重建）。
 * M4.6 Task 5：加容量上限 64，插入序淘汰（FIFO）——该缓存几乎零收益（buildStableSegment 仅 3 次字符串拼接），
 * 上限是消除无界增长的止血，命中率非关键，FIFO 挤掉热条目无实际代价。
 */
export function createStableCache(): StableCache {
  const cache = new Map<string, string>();
  return {
    get(sessionId, key) {
      const ck = stableCacheKey(sessionId, key.modelId, key.bridgeGranted, key.config);
      const cached = cache.get(ck);
      if (cached !== undefined) return cached;
      // 超限先删 Map 首键（Map 迭代序即插入序，删最旧），再 set——纯 FIFO，不 re-touch
      if (cache.size >= STABLE_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      const stable = buildStableSegment(key.bridgeGranted, key.config, key.disciplineBlock);
      cache.set(ck, stable);
      return stable;
    },
    invalidate(sessionId) {
      const prefix = `${sessionId}\u0000`;
      for (const k of cache.keys()) {
        if (k.startsWith(prefix)) cache.delete(k);
      }
    },
    _cache: cache,
  };
}
