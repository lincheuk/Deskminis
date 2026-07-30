import type { ToolExecutor } from './types';
import { MemoryStore, type MemoryEntry } from '../store/memory-store';
import { join } from 'node:path';

const MAX_ENTRIES = 60;
const MAX_OUTPUT_BYTES = 30 * 1024;

const MEMORY_DIR_REL = 'memory';

export const MEMORY_TOOL_NAMES = ['memory_write', 'memory_get'] as const;

/** 构造工具时需要传入 MemoryStore（由 index.ts 在启动时创建）。 */
function makeStore(ctx: { paths: { root: string } }): MemoryStore {
  return new MemoryStore(join(ctx.paths.root, MEMORY_DIR_REL));
}

/** 分词：英文数字按词（≥2 连续），中文按滑动二字组（bigram）。
 *  中文单字高频字（的/不/在/关…）几乎命中一切中文文本，会让「未找到」分支不可达；
 *  bigram 让无关文本自然得 0 命中。连续汉字段长度为 1 时退化为单字。 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const en = text.match(/[A-Za-z0-9]{2,}/g);
  if (en) tokens.push(...en.map(s => s.toLowerCase()));
  const runs = text.match(/[\u4e00-\u9fa5]+/g);
  if (runs) for (const run of runs) {
    if (run.length === 1) { tokens.push(run); continue; }
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
  }
  return [...new Set(tokens)];
}

/** 关键词命中率：query 分词后在 markdown 中命中的词数 / query 总词数。 */
function hitRate(query: string, markdown: string): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) return 0;
  const lower = markdown.toLowerCase();
  const hit = tokens.filter(t => lower.includes(t.toLowerCase()));
  return hit.length / tokens.length;
}

/** 新近度：1 / (1 + daysSince)。 */
function recency(entry: MemoryEntry): number {
  // entry.timestamp 形如 '2026-07-30 14:05:00'，Date 能直接解析（V8 接受空格分隔的 ISO 风格）
  const ts = new Date(entry.timestamp);
  const days = (Date.now() - ts.getTime()) / (1000 * 60 * 60 * 24);
  return 1 / (1 + Math.max(0, days));
}

function todayDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export const memoryWriteTool: ToolExecutor = {
  definition: {
    name: 'memory_write',
    description: '将一条记忆写入每日日志文件。适用于记录用户偏好、项目决策、待办等需要跨会话保留的信息。',
    parameters: {
      markdown: { type: 'string', description: '要记录的记忆内容（markdown）' },
      date: { type: 'string', description: '日期 YYYY-MM-DD，省略则写当日' },
      tool_title: { type: 'string', description: '5-10 词中文摘要，用于 UI 卡片' },
    },
    required: ['markdown', 'tool_title'],
  },
  async execute(input, ctx) {
    const markdown = String(input.markdown ?? '').trim();
    if (!markdown) return { output: '记忆内容不能为空', success: false };
    const date = String(input.date ?? '').trim() || todayDate();
    const store = makeStore(ctx);
    store.appendDailyLog(date, markdown);
    return { output: `已写入 ${date} 日志`, success: true };
  },
};

export const memoryGetTool: ToolExecutor = {
  definition: {
    name: 'memory_get',
    description: '按关键词检索记忆日志。返回评分排序的条目（0.5×关键词命中 + 0.5×新近度），上限 60 条/30KB。',
    parameters: {
      query: { type: 'string', description: '搜索关键词' },
      limit: { type: 'integer', description: '返回条目上限，默认 60' },
      tool_title: { type: 'string', description: '5-10 词中文摘要，用于 UI 卡片' },
    },
    required: ['query', 'tool_title'],
  },
  async execute(input, ctx) {
    const query = String(input.query ?? '').trim();
    if (!query) return { output: '查询不能为空', success: false };
    const limit = Math.min(Number(input.limit ?? MAX_ENTRIES), MAX_ENTRIES);
    const store = makeStore(ctx);

    // 收集命中条目：评分公式只用于命中条目的排序，未命中不参与返回
    const all: { entry: MemoryEntry; date: string; score: number }[] = [];
    let parsedCount = 0;
    for (const date of store.listDailyLogs()) {
      const text = store.readDailyLog(date);
      for (const entry of store.parseEntries(text)) {
        parsedCount++;
        const hr = hitRate(query, entry.markdown);
        if (hr === 0) continue;            // 关键词命中是检索前提
        const score = 0.5 * hr + 0.5 * recency(entry);
        all.push({ entry, date, score });
      }
    }

    if (parsedCount === 0) return { output: '暂无记忆日志', success: true };
    if (all.length === 0) return { output: '未找到匹配的记忆条目', success: true };

    // 按评分降序
    all.sort((a, b) => b.score - a.score);
    const top = all.slice(0, limit);

    // 30KB 上限
    const lines: string[] = [];
    let bytes = 0;
    for (const { entry, date, score } of top) {
      const line = `[${entry.timestamp} | ${date} | 评分${score.toFixed(2)}] ${entry.markdown}`;
      if (bytes + line.length > MAX_OUTPUT_BYTES) break;
      lines.push(line);
      bytes += line.length + 1;
    }

    if (lines.length === 0) return { output: '未找到匹配的记忆条目', success: true };
    return { output: lines.join('\n'), success: true };
  },
};
