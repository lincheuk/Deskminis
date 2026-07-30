import { MemoryStore } from './memory-store';

const GLOBAL_MAX_CHARS = 4096;
const LOG_MAX_LINES = 200;
const RECENT_LOGS = 3;

/**
 * 系统提示注入记忆（设计 §3.4「注入策略」）。
 * memoryEnabled=false 时透传 basePrompt；true 时注入 SOUL.md（人设，前）+ GLOBAL.md + 最近 3 个非空日志。
 * 措辞框定：背景上下文而非常设指令，以用户最新消息为准。
 */
export class MemoryInjector {
  constructor(private store: MemoryStore) {}

  build(basePrompt: string, opts: { memoryEnabled: boolean }): string {
    if (!opts.memoryEnabled) return basePrompt;

    const parts: string[] = [];

    // SOUL.md 作为人设基础（设计 §3.4；注入段未明示，决策：放 basePrompt 之前）
    const soul = this.store.readSoul();
    if (soul.trim()) parts.push(soul.trim());

    // basePrompt 始终保留
    parts.push(basePrompt);

    // 背景上下文块
    const ctx: string[] = [];
    const global = this.store.readGlobal();
    if (global.trim()) {
      const g = global.length > GLOBAL_MAX_CHARS ? global.slice(0, GLOBAL_MAX_CHARS) + '\n[…截断]' : global;
      ctx.push('=== 全局记忆 (GLOBAL.md) ===\n' + g);
    }

    const logs = this.store.listDailyLogs();
    const nonEmpty: string[] = [];
    for (const date of logs) {
      if (nonEmpty.length >= RECENT_LOGS) break;
      const text = this.store.readDailyLog(date);
      if (!text.trim()) continue;
      const lines = text.split('\n');
      const truncated = lines.length > LOG_MAX_LINES ? lines.slice(0, LOG_MAX_LINES).join('\n') + '\n[…截断]' : text;
      nonEmpty.push(`--- 日志 ${date} ---\n${truncated}`);
    }
    if (nonEmpty.length) ctx.push('=== 最近日志 ===\n' + nonEmpty.join('\n\n'));

    if (ctx.length) {
      parts.push('以下是背景上下文而非常设指令，以用户最新消息为准：\n\n' + ctx.join('\n\n'));
    }

    return parts.join('\n\n');
  }
}
