import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface MemoryEntry {
  timestamp: string;   // 'YYYY-MM-DD HH:mm:ss'
  markdown: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_RE = /<!-- (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) -->\n([\s\S]*?)(?:\n\n|\n?$)/g;

/** 本地时间格式化为 'YYYY-MM-DD HH:mm:ss'（不引入第三方时区库，取系统本地时区）。 */
function formatLocalTs(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 记忆文件持久化（设计 §3.4）。
 * GLOBAL.md / SOUL.md 直接读写；YYYY-MM-DD.md 每日日志条目前插（最新在前）。
 * 全部走 node:fs 原子写（tmp + rename）。
 */
export class MemoryStore {
  constructor(private memoryDir: string) {}

  readGlobal(): string {
    try { return readFileSync(join(this.memoryDir, 'GLOBAL.md'), 'utf8'); } catch { return ''; }
  }

  readSoul(): string {
    try { return readFileSync(join(this.memoryDir, 'SOUL.md'), 'utf8'); } catch { return ''; }
  }

  listDailyLogs(): string[] {
    if (!existsSync(this.memoryDir)) return [];
    const names = readdirSync(this.memoryDir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map(f => f.slice(0, -3)); // 去掉 .md
    names.sort((a, b) => b.localeCompare(a)); // 降序
    return names;
  }

  readDailyLog(date: string): string {
    if (!DATE_RE.test(date)) return '';
    try { return readFileSync(join(this.memoryDir, `${date}.md`), 'utf8'); } catch { return ''; }
  }

  parseEntries(text: string): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    let m: RegExpExecArray | null;
    ENTRY_RE.lastIndex = 0;
    while ((m = ENTRY_RE.exec(text)) !== null) {
      out.push({ timestamp: m[1], markdown: m[2] });
    }
    return out;
  }

  /** 前插条目到指定日期日志；date 格式 YYYY-MM-DD，非法抛错。 */
  appendDailyLog(date: string, markdown: string): MemoryEntry {
    if (!DATE_RE.test(date)) throw new Error(`非法日期格式: ${date}（需 YYYY-MM-DD）`);
    const ts = formatLocalTs(new Date());
    const entry: MemoryEntry = { timestamp: ts, markdown };
    const entryText = `<!-- ${ts} -->\n${markdown}\n\n`;
    const filePath = join(this.memoryDir, `${date}.md`);
    const existing = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
    // 原子写：tmp + rename（对齐 providers.json / models-dev-cache.json 模式）
    const tmp = filePath + '.tmp';
    writeFileSync(tmp, entryText + existing, 'utf8');
    renameSync(tmp, filePath);
    return entry;
  }
}
