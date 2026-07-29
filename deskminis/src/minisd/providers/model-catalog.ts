import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { ThinkingLevel } from '../../shared/types';
import type { FetchLike } from './types';

export interface ModelCatalogEntry {
  contextWindow?: number;
  maxOutputTokens?: number;
  thinking?: boolean;
}

const API_URL = 'https://models.dev/api.json';
const TTL_MS = 24 * 60 * 60 * 1000;

/** 内置兜底表：models.dev 与磁盘缓存都不可用时仍可用。按模型族前缀正则，先中先赢。 */
const BUILTIN: [RegExp, ModelCatalogEntry][] = [
  [/^claude-/i, { contextWindow: 200_000, thinking: true }],
  [/^gpt-5/i, { contextWindow: 400_000, thinking: true }],
  [/^gpt-4/i, { contextWindow: 128_000, thinking: false }],
  [/^gemini-/i, { contextWindow: 1_000_000, thinking: true }],
  [/^qwen3/i, { contextWindow: 128_000, thinking: true }],
  [/^deepseek-r1/i, { contextWindow: 128_000, thinking: true }],
  [/^deepseek-v/i, { contextWindow: 128_000, thinking: false }],
  [/^llama/i, { contextWindow: 128_000, thinking: false }],
  [/^mistral/i, { contextWindow: 128_000, thinking: false }],
];

interface CacheFile { fetchedAt: number; models: Record<string, ModelCatalogEntry> }

/**
 * 模型能力目录（设计 §4.1「模型能力目录」段）：
 * models.dev API 拉取 + 磁盘缓存（24h TTL）+ 内置兜底表。
 * 任何一环失败都静默回退下一环——目录永远可用，只是可能不新鲜。
 */
export class ModelCatalog {
  private models: Record<string, ModelCatalogEntry> = {};
  private fetchedAt = 0;
  private fetchImpl: FetchLike;

  constructor(private cacheFile: string, fetchImpl?: FetchLike) {
    this.fetchImpl = fetchImpl ?? fetch;
    if (existsSync(cacheFile)) {
      try {
        const c = JSON.parse(readFileSync(cacheFile, 'utf8')) as CacheFile;
        this.models = c.models ?? {};
        this.fetchedAt = c.fetchedAt ?? 0;
      } catch { /* 缓存损坏按无缓存处理 */ }
    }
  }

  /** 拉取 models.dev；TTL 内新鲜缓存直接跳过。返回是否真的拉取并成功。 */
  async refresh(force = false): Promise<boolean> {
    if (!force && Date.now() - this.fetchedAt < TTL_MS) return false;
    try {
      const res = await this.fetchImpl(API_URL);
      if (!res.ok) return false;
      const data = await res.json() as Record<string, { models?: Record<string, { limit?: { context?: number; output?: number }; reasoning?: boolean }> }>;
      const models: Record<string, ModelCatalogEntry> = {};
      for (const vendor of Object.values(data)) {
        for (const [id, m] of Object.entries(vendor.models ?? {})) {
          models[id] = { contextWindow: m.limit?.context, maxOutputTokens: m.limit?.output, thinking: m.reasoning === true };
        }
      }
      this.models = models;
      this.fetchedAt = Date.now();
      const tmp = this.cacheFile + '.tmp';
      writeFileSync(tmp, JSON.stringify({ fetchedAt: this.fetchedAt, models } satisfies CacheFile), 'utf8');
      renameSync(tmp, this.cacheFile); // 原子写（对齐 providers.json 模式）
      return true;
    } catch { return false; } // 离线/格式变化：静默回退磁盘缓存与内置表
  }

  private lookup(modelId: string): ModelCatalogEntry | undefined {
    const direct = this.models[modelId];
    if (direct) return direct;
    const slash = modelId.lastIndexOf('/');
    const tail = slash >= 0 ? modelId.slice(slash + 1) : modelId;
    if (this.models[tail]) return this.models[tail];
    for (const [re, entry] of BUILTIN) if (re.test(modelId) || re.test(tail)) return entry;
    return undefined;
  }

  /** M2a ContextPolicy 的窗口查询入口；未知模型返回 undefined（M2a 回退其内置映射）。 */
  getModelContextWindow(modelId: string): number | undefined {
    return this.lookup(modelId)?.contextWindow;
  }

  /** 按模型族钳制 thinking 档位：目录/内置表判定不支持推理的模型一律钳到 off（设计 §4.1）。 */
  clampThinkingLevel(modelId: string, level: ThinkingLevel): ThinkingLevel {
    if (level === 'off') return 'off';
    const info = this.lookup(modelId);
    if (!info || info.thinking !== true) return 'off';
    return level;
  }
}
