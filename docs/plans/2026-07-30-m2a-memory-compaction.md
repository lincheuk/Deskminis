# DeskMinis M2a（上下文压缩/卸载 + 记忆系统）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 minisd 补齐设计 §3.4（记忆）与 §4.2（大工具结果卸载 + 上下文水位检查 + LLM 压缩摘要）两块能力。记忆侧落地 `GLOBAL.md` / `SOUL.md` / `YYYY-MM-DD.md` 三类文件持久化、每轮系统提示注入、`memory_write` / `memory_get` 工具（随会话 `memory_enabled` 开关整体进出 schema）。压缩侧落地 `ContextPolicy`（消费 M2b `ModelCatalog.getModelContextWindow` 做分层水位决策）、`OffloadEngine`（>20k 字符工具结果落 `offloads/` 并替换为桩）、`CompactEngine`（LLM 摘要存 `compact_markers`、推理时合成 `effectiveAgentHistory`、不改写存储历史、保留最近 3 个用户回合原文、锚点丢失按 createdAt 自愈），并把三者插进 M2b 现状 Agent 循环（`activeSlot` / `fallbackChain` / 空响应两路）。

**Architecture:** 沿用 M1 单方法 Provider 契约与 M2b 降级链结构。记忆是纯文件层（`<dataRoot>/memory/`），不经 SQLite，注入发生在 `chat.prompt` 入口构建 `systemPrompt` 时刻（一次注入整轮复用——记忆文件在单次对话中变化影响有限，`memory_write` 后下一次 `chat.prompt` 才重新注入；该决策简化实现且不违背设计"每轮注入"语义，因为单轮内记忆文件不变）。卸载在 `tool_result` 落库**前**就地把 `output` 替换为桩并写 `offloads/<toolUseId>.txt`——落库即桩，`effectiveAgentHistory` 无需二次替换；`toolEnd` 事件仍广播完整 `output` 供 UI 展示。压缩的数据流：每轮**先** `buildEffectiveHistory(history, getLatestCompactMarker)` 合成 effectiveHistory，**再**在其上 `ContextPolicy.decide(modelId, estimateTokens(effectiveHistory))`——raw history 只用于 `summarize` 取材与落库、永不改写，estimate/decide/请求构建一律基于 effectiveHistory（这样压缩写 marker 后 effectiveHistory 变小、水位自然下降，不会出现「存储不改写 → 水位永不降 → 每次都重复压缩到 3 次上限」的缺陷）。`decide` 返回 `compact` 且本循环压缩次数 < 3 时调用当前 `activeSlot.provider` 生成摘要写入 `compact_markers`（M1 已建表，M2a 追加 `MIGRATIONS[1]` 建索引），压缩轮不消耗 `turn` 额度；`summarize` 不足 3 个真正用户回合（`role==='user'` 且含 text part 且不含 toolResult part——本仓库 tool_result 也落库为 user 消息）时返回 `undefined`、不写 marker、不 continue，直接用现有 effectiveHistory 继续流式请求（避免毒 marker 抹掉上下文 + 避免死循环）。`effectiveAgentHistory` = `[摘要 as user text]` + `[lastCompactedMessageId 之后的消息]`，`pairToolResults` 在其上做配对（M2b 既有，不动）。设计依据见 `../specs/2026-07-26-deskminis-design.md` §3.4、§4.2。

**Tech Stack:** TypeScript (strict) / vitest / 无新增运行时依赖（记忆走 `node:fs`，压缩走既有 `AgentProvider`，卸载走 `node:fs`）

## Global Constraints

- 代码基线：**M1 + M2b 已完成**（189 个测试全绿）。假定其他 M2 子计划（M2c 技能、M2d 右栏 UI、M2e windows-* 桥）均未执行
- 所有代码在 `deskminis/` 子目录（仓库根 `<repo>\`）
- TypeScript `strict: true`；测试命令统一 `npm test`（vitest run），单文件 `npm test -- tests/xxx.test.ts`
- 提交信息用 conventional commits + 中文（如 `feat(m2a): …`）；全文中文
- 压缩摘要的 LLM 调用一律用**脚本化假 Provider 回放**（复用 `agent-loop.test.ts` 的 `ScriptedProvider` 模式），禁止真连网络
- 记忆文件用 `node:fs` 原子写（tmp + rename，对齐 `providers.json` / `models-dev-cache.json` 模式）；条目格式严格 `<!-- YYYY-MM-DD HH:mm:ss -->\n{markdown}\n\n`，前插（最新在前）
- `compact_markers` 表 M1 已建（`db.ts` MIGRATIONS[0]），M2a 只补 CRUD + 追加 `MIGRATIONS[1]` 建索引（不能改 MIGRATIONS[0]——迁移一经发布不可改，已发布库 user_version=1 不会重跑 [0]）；存储历史**永不改写**（压缩只追加 marker + 推理时合成）
- 卸载**改写落库**（设计 §4.2 原文"历史替换为桩"）：`tool_result` 落库前替换 `output` 为桩并写 offload 文件；`toolEnd` 事件广播替换前的完整 `output`
- `ContextPolicy` 直接消费 M2b `ModelCatalog.getModelContextWindow`（已存在，非假定），未知模型回退 32K 保守档
- 时间戳一律 epoch 秒（浮点）；ID 一律 `crypto.randomUUID().toUpperCase()`（M1/M2b 约束延续）
- 本计划只覆盖 minisd 侧；记忆文件管理 UI、压缩进度展示组件属 M2d 右栏 UI 子计划，不在此范围

## 文件结构总览

```
deskminis/
  src/minisd/store/memory-store.ts      Create（Task 1）：GLOBAL/SOUL/日志 文件 CRUD
  src/minisd/store/memory-injector.ts   Create（Task 2）：buildSystemPrompt 注入记忆
  src/minisd/tools/memory.ts            Create（Task 3）：memory_write / memory_get 工具
  src/minisd/store/chat-store.ts        Modify：compact_markers CRUD + setMemoryEnabled + getSession 读 memory_enabled
  src/minisd/store/db.ts                Modify：compact_markers 增加 index（性能，M1 已建表）
  src/minisd/agent/context-policy.ts    Create（Task 4）：水位分层决策 + token 估算
  src/minisd/agent/offload.ts           Create（Task 5）：大工具结果卸载
  src/minisd/agent/compact.ts           Create（Task 6）：CompactEngine + buildEffectiveHistory
  src/minisd/agent/loop.ts              Modify（Task 7）：插入水位检查/压缩/卸载/effectiveHistory
  src/minisd/index.ts                   Modify（Task 7）：记忆注入 + memory_enabled 开关 + 装配 ContextPolicy/Offload/Compact
  src/shared/types.ts                   Modify：SessionMeta 增加 memoryEnabled?
  tests/memory-store.test.ts            Create（Task 1）
  tests/memory-injector.test.ts         Create（Task 2）
  tests/memory-tools.test.ts            Create（Task 3）
  tests/context-policy.test.ts          Create（Task 4）
  tests/offload.test.ts                 Create（Task 5）
  tests/compact.test.ts                 Create（Task 6）
  tests/agent-loop.test.ts              Append（Task 7）：压缩触发/卸载/记忆装配 用例
  tests/chat-store.test.ts              Append（Task 6）：compact_markers CRUD 用例
  tests/rpc.test.ts                     Append（Task 7）：setMemoryEnabled RPC 用例
```

任务依赖：1 → 2 → 3 → 4 → 5 → 6 → 7（严格串行，后续任务消费前序任务的签名）。

---

### Task 1: MemoryStore（记忆文件持久化）

**Files:**
- Create: `deskminis/src/minisd/store/memory-store.ts`
- Test: `deskminis/tests/memory-store.test.ts`

**Interfaces:**
- Consumes: 无
- Produces（Task 2/3 依赖）:
  - `interface MemoryEntry { timestamp: string; markdown: string }` — `timestamp` 形如 `2026-07-30 14:05:00`
  - `class MemoryStore {
      constructor(memoryDir: string);
      readGlobal(): string;            // GLOBAL.md 全文，不存在返回 ''
      readSoul(): string;              // SOUL.md 全文，不存在返回 ''
      listDailyLogs(): string[];       // ['2026-07-30', '2026-07-29', ...] 降序
      readDailyLog(date: string): string; // 指定日期全文，不存在返回 ''
      parseEntries(text: string): MemoryEntry[]; // 解析 <!-- ts -->\n{md}\n\n
      appendDailyLog(date: string, markdown: string): MemoryEntry; // 前插条目，原子写
    }`

**语义**（设计 §3.4）：`GLOBAL.md` 用户维护 agent 只读（`MemoryStore` 不提供写接口）；`SOUL.md` 人设（YAML frontmatter + 正文）；`YYYY-MM-DD.md` 每日日志，条目格式 `<!-- YYYY-MM-DD HH:mm:ss -->\n{markdown}\n\n`，前插（最新在前）。`date` 参数格式 `YYYY-MM-DD`，非法格式抛错。`appendDailyLog` 用系统本地时区（不硬编码——`new Date()` 取系统本地时间，`formatLocalTs` 用 `d.getFullYear()/getMonth()/...` 系列本地访问器拼出 `YYYY-MM-DD HH:mm:ss`，全程不碰 UTC，与 `toISOString` 无关）。原子写：先写 `tmp` 再 `rename`。

- [x] **Step 1: 写失败测试**

`deskminis/tests/memory-store.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/minisd/store/memory-store';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dm-mem-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('MemoryStore', () => {
  it('readGlobal: 文件不存在返回空串', () => {
    const s = new MemoryStore(dir);
    expect(s.readGlobal()).toBe('');
  });

  it('readGlobal: 读出 GLOBAL.md 全文', () => {
    writeFileSync(join(dir, 'GLOBAL.md'), '# 我的全局\n用户偏好\n', 'utf8');
    expect(new MemoryStore(dir).readGlobal()).toBe('# 我的全局\n用户偏好\n');
  });

  it('readSoul: 文件不存在返回空串', () => {
    expect(new MemoryStore(dir).readSoul()).toBe('');
  });

  it('listDailyLogs: 无日志返回空数组', () => {
    expect(new MemoryStore(dir).listDailyLogs()).toEqual([]);
  });

  it('listDailyLogs: 列出日志文件名并按日期降序', () => {
    writeFileSync(join(dir, '2026-07-29.md'), 'x', 'utf8');
    writeFileSync(join(dir, '2026-07-30.md'), 'y', 'utf8');
    writeFileSync(join(dir, '2026-07-28.md'), 'z', 'utf8');
    expect(new MemoryStore(dir).listDailyLogs()).toEqual(['2026-07-30', '2026-07-29', '2026-07-28']);
  });

  it('listDailyLogs: 忽略非日志格式文件', () => {
    writeFileSync(join(dir, 'GLOBAL.md'), 'x', 'utf8');
    writeFileSync(join(dir, 'notes.txt'), 'y', 'utf8');
    writeFileSync(join(dir, '2026-07-30.md'), 'z', 'utf8');
    expect(new MemoryStore(dir).listDailyLogs()).toEqual(['2026-07-30']);
  });

  it('readDailyLog: 不存在返回空串', () => {
    expect(new MemoryStore(dir).readDailyLog('2026-07-30')).toBe('');
  });

  it('appendDailyLog: 新文件创建 + 条目前插', () => {
    const s = new MemoryStore(dir);
    s.appendDailyLog('2026-07-30', '第一条记忆');
    s.appendDailyLog('2026-07-30', '第二条记忆');
    const text = readFileSync(join(dir, '2026-07-30.md'), 'utf8');
    // 第二条在前（前插）
    expect(text.indexOf('第二条记忆')).toBeLessThan(text.indexOf('第一条记忆'));
    // 条目格式：<!-- timestamp -->\n{markdown}\n\n
    expect(text).toMatch(/<!-- \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} -->\n第二条记忆\n\n/);
  });

  it('appendDailyLog: 非法 date 抛错', () => {
    const s = new MemoryStore(dir);
    expect(() => s.appendDailyLog('invalid', 'x')).toThrow();
    expect(() => s.appendDailyLog('2026-7-30', 'x')).toThrow();
  });

  it('parseEntries: 解析条目列表', () => {
    const text = '<!-- 2026-07-30 10:00:00 -->\n第一条\n\n<!-- 2026-07-30 11:00:00 -->\n第二条\n\n';
    const entries = new MemoryStore(dir).parseEntries(text);
    expect(entries).toHaveLength(2);
    expect(entries[0].timestamp).toBe('2026-07-30 10:00:00');
    expect(entries[0].markdown).toBe('第一条');
    expect(entries[1].markdown).toBe('第二条');
  });

  it('parseEntries: 空文本返回空数组', () => {
    expect(new MemoryStore(dir).parseEntries('')).toEqual([]);
  });

  it('parseEntries: 容错——无尾随空行的末条目仍能解析', () => {
    const text = '<!-- 2026-07-30 10:00:00 -->\n末条无空行';
    const entries = new MemoryStore(dir).parseEntries(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].markdown).toBe('末条无空行');
  });

  it('appendDailyLog: 原子写（tmp 不残留）', () => {
    const s = new MemoryStore(dir);
    s.appendDailyLog('2026-07-30', 'x');
    expect(existsSync(join(dir, '2026-07-30.md.tmp'))).toBe(false);
    expect(existsSync(join(dir, '2026-07-30.md'))).toBe(true);
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/memory-store.test.ts`
Expected: FAIL（`MemoryStore` 未导出）

- [x] **Step 3: 创建 memory-store.ts**

`deskminis/src/minisd/store/memory-store.ts`:

```typescript
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
```

- [x] **Step 4: 跑测试确认通过 + M2b 测试不回归**

Run: `cd deskminis && npm test -- tests/memory-store.test.ts`
Expected: PASS（13 个用例）

Run: `cd deskminis && npm test`
Expected: 全部通过（M2b 的 189 个测试不受影响——纯新增文件）

- [x] **Step 5: Commit**

```bash
cd "<repo>" && git add deskminis/src/minisd/store/memory-store.ts deskminis/tests/memory-store.test.ts && git commit -m "feat(m2a): MemoryStore 记忆文件持久化（GLOBAL/SOUL/日志 CRUD + 条目前插 + 原子写）"
```

---

### Task 2: MemoryInjector（系统提示注入记忆）

**Files:**
- Create: `deskminis/src/minisd/store/memory-injector.ts`
- Test: `deskminis/tests/memory-injector.test.ts`

**Interfaces:**
- Consumes: `MemoryStore`（Task 1）
- Produces（Task 7 依赖）:
  - `class MemoryInjector {
      constructor(store: MemoryStore);
      build(basePrompt: string, opts: { memoryEnabled: boolean }): string;
    }`
  - `memoryEnabled === false` → 只返回 `basePrompt`
  - `memoryEnabled === true` → 注入 SOUL.md（前）+ GLOBAL.md + 最近 3 个非空日志（各 ≤200 行），措辞框定为背景上下文

**语义**（设计 §3.4）：注入完整 `GLOBAL.md` + 最近 3 个非空日志（各 200 行内），措辞框定为"背景上下文而非常设指令，以用户最新消息为准"。`SOUL.md` 设计文档未在注入段明示，但它是人设文件——决策：注入到 `basePrompt` 之前作为人设基础（不存在则跳过）。`GLOBAL.md` 截断到 4096 字符（防爆），单条日志截断到 200 行。

- [x] **Step 1: 写失败测试**

`deskminis/tests/memory-injector.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryInjector } from '../src/minisd/store/memory-injector';
import { MemoryStore } from '../src/minisd/store/memory-store';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let store: MemoryStore;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dm-inj-')); store = new MemoryStore(dir); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('MemoryInjector', () => {
  it('memoryEnabled=false: 只返回 basePrompt', () => {
    const inj = new MemoryInjector(store);
    expect(inj.build('你是助手', { memoryEnabled: false })).toBe('你是助手');
  });

  it('memoryEnabled=true 但无任何记忆文件: 只返回 basePrompt', () => {
    const inj = new MemoryInjector(store);
    const out = inj.build('你是助手', { memoryEnabled: true });
    expect(out).toBe('你是助手');
  });

  it('注入 GLOBAL.md', () => {
    writeFileSync(join(dir, 'GLOBAL.md'), '用户喜欢简洁回复', 'utf8');
    const out = new MemoryInjector(store).build('你是助手', { memoryEnabled: true });
    expect(out).toContain('用户喜欢简洁回复');
    expect(out).toContain('你是助手');
  });

  it('注入 SOUL.md 作为人设（在 basePrompt 之前）', () => {
    writeFileSync(join(dir, 'SOUL.md'), '你是一个严谨的工程师', 'utf8');
    const out = new MemoryInjector(store).build('你是助手', { memoryEnabled: true });
    expect(out).toContain('你是一个严谨的工程师');
    expect(out).toContain('你是助手');
    expect(out.indexOf('你是一个严谨的工程师')).toBeLessThan(out.indexOf('你是助手'));
  });

  it('注入最近 3 个非空日志', () => {
    store.appendDailyLog('2026-07-28', '28号的记忆');
    store.appendDailyLog('2026-07-29', '29号的记忆');
    store.appendDailyLog('2026-07-30', '30号的记忆');
    store.appendDailyLog('2026-07-27', '27号的记忆'); // 第 4 个，不应被注入
    const out = new MemoryInjector(store).build('你是助手', { memoryEnabled: true });
    expect(out).toContain('30号的记忆');
    expect(out).toContain('29号的记忆');
    expect(out).toContain('28号的记忆');
    expect(out).not.toContain('27号的记忆');
  });

  it('空日志文件不算"非空"（跳过）', () => {
    writeFileSync(join(dir, '2026-07-29.md'), '', 'utf8');
    store.appendDailyLog('2026-07-30', '30号记忆');
    const out = new MemoryInjector(store).build('你是助手', { memoryEnabled: true });
    expect(out).toContain('30号记忆');
    // 2026-07-29.md 是空文件，不算非空日志，不应注入任何内容
    expect(out.match(/2026-07-29/g)).toBeNull();
  });

  it('措辞框定包含"背景上下文"提示', () => {
    writeFileSync(join(dir, 'GLOBAL.md'), 'x', 'utf8');
    const out = new MemoryInjector(store).build('你是助手', { memoryEnabled: true });
    expect(out).toContain('背景上下文');
  });

  it('GLOBAL.md 超 4096 字符被截断', () => {
    writeFileSync(join(dir, 'GLOBAL.md'), 'A'.repeat(5000), 'utf8');
    const out = new MemoryInjector(store).build('你是助手', { memoryEnabled: true });
    // 截断后应包含截断标记
    expect(out).toContain('A'.repeat(4096));
    expect(out).not.toContain('A'.repeat(4097));
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/memory-injector.test.ts`
Expected: FAIL（`MemoryInjector` 未导出）

- [x] **Step 3: 创建 memory-injector.ts**

`deskminis/src/minisd/store/memory-injector.ts`:

```typescript
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
```

- [x] **Step 4: 跑测试确认通过 + 全量不回归**

Run: `cd deskminis && npm test -- tests/memory-injector.test.ts`
Expected: PASS（8 个用例）

Run: `cd deskminis && npm test`
Expected: 全部通过（Task 1 的 memory-store.test.ts + M2b 189 个测试不受影响）

- [x] **Step 5: Commit**

```bash
cd "<repo>" && git add deskminis/src/minisd/store/memory-injector.ts deskminis/tests/memory-injector.test.ts && git commit -m "feat(m2a): MemoryInjector 系统提示注入记忆（SOUL/GLOBAL/最近3日志 + 措辞框定 + 截断）"
```

---

### Task 3: memory_write / memory_get 工具

**Files:**
- Create: `deskminis/src/minisd/tools/memory.ts`
- Test: `deskminis/tests/memory-tools.test.ts`

**Interfaces:**
- Consumes: `MemoryStore`（Task 1）、`ToolExecutor`（M1 既有 `src/minisd/tools/types.ts`）
- Produces（Task 7 依赖）:
  - `const memoryWriteTool: ToolExecutor` — input: `{ markdown: string; date?: string; tool_title: string }` → 写当日（或指定日期）日志
  - `const memoryGetTool: ToolExecutor` — input: `{ query: string; limit?: number; tool_title: string }` → 评分检索（0.5×关键词命中 + 0.5×新近度，上限 60 条/30KB）
  - `const MEMORY_TOOL_NAMES = ['memory_write', 'memory_get'] as const` — 供 Task 7 按会话开关过滤

**语义**（设计 §3.4）：`memory_write` 写当日日志（`date` 省略时取本地今天）；`memory_get` 遍历所有日志条目，按 `0.5×关键词命中率 + 0.5×新近度` 评分降序，上限 60 条 / 30KB。关键词命中率 = query 分词后在 markdown 中命中的词数 / query 总词数（中文按单字、英文按空格分词，简单实现不引分词库）。新近度 = `1 / (1 + daysSinceTimestamp)`。会话级 `memory_enabled` 关闭时工具整个从 schema 移除（Task 7 在 `index.ts` 按会话过滤，本 Task 只造工具）。

- [x] **Step 1: 写失败测试**

`deskminis/tests/memory-tools.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { memoryWriteTool, memoryGetTool, MEMORY_TOOL_NAMES } from '../src/minisd/tools/memory';
import { MemoryStore } from '../src/minisd/store/memory-store';
import { MinisPaths } from '../src/minisd/paths';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let store: MemoryStore;
let paths: MinisPaths;
let sessionId: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dm-mtool-'));
  store = new MemoryStore(join(dir, 'memory'));
  paths = new MinisPaths(dir);
  sessionId = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  paths.ensureSessionDirs(sessionId);
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('memory_write 工具', () => {
  it('定义: name=memory_write + 必含 tool_title', () => {
    expect(memoryWriteTool.definition.name).toBe('memory_write');
    expect(memoryWriteTool.definition.required).toContain('tool_title');
    expect(memoryWriteTool.definition.required).toContain('markdown');
  });

  it('写当日日志（date 省略）', async () => {
    const ctx = { sessionId, paths, permissions: { async check() { return 'allow'; } } };
    const r = await memoryWriteTool.execute(JSON.stringify({ markdown: '测试记忆条目', tool_title: '写记忆' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('已写入');
    // 验证落盘
    const today = new Date();
    const p = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(store.readDailyLog(p)).toContain('测试记忆条目');
  });

  it('指定 date 写日志', async () => {
    const ctx = { sessionId, paths, permissions: { async check() { return 'allow'; } } };
    await memoryWriteTool.execute(JSON.stringify({ markdown: '历史记忆', date: '2026-07-01', tool_title: '写记忆' }), ctx);
    expect(store.readDailyLog('2026-07-01')).toContain('历史记忆');
  });

  it('markdown 为空时报错', async () => {
    const ctx = { sessionId, paths, permissions: { async check() { return 'allow'; } } };
    const r = await memoryWriteTool.execute(JSON.stringify({ markdown: '', tool_title: '写记忆' }), ctx);
    expect(r.success).toBe(false);
    expect(r.output).toContain('不能为空');
  });
});

describe('memory_get 工具', () => {
  it('定义: name=memory_get + 必含 tool_title + query', () => {
    expect(memoryGetTool.definition.name).toBe('memory_get');
    expect(memoryGetTool.definition.required).toContain('query');
    expect(memoryGetTool.definition.required).toContain('tool_title');
  });

  it('按关键词命中排序返回条目', async () => {
    store.appendDailyLog('2026-07-29', '今天研究了 Rust 异步');
    store.appendDailyLog('2026-07-30', '今天研究了 TypeScript 类型');
    const ctx = { sessionId, paths, permissions: { async check() { return 'allow'; } } };
    const r = await memoryGetTool.execute(JSON.stringify({ query: 'TypeScript', tool_title: '查记忆' }), ctx);
    expect(r.success).toBe(true);
    // 命中的条目出现；未命中的条目（Rust 异步）不参与返回（bigram 语义：命中是检索前提）
    expect(r.output).toContain('TypeScript 类型');
    expect(r.output).not.toContain('Rust 异步');
  });

  it('无匹配时返回提示而非空', async () => {
    store.appendDailyLog('2026-07-30', '无关内容');
    const ctx = { sessionId, paths, permissions: { async check() { return 'allow'; } } };
    const r = await memoryGetTool.execute(JSON.stringify({ query: '不存在的关键词', tool_title: '查记忆' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('未找到');
  });

  it('无任何记忆时返回空提示', async () => {
    const ctx = { sessionId, paths, permissions: { async check() { return 'allow'; } } };
    const r = await memoryGetTool.execute(JSON.stringify({ query: '任意', tool_title: '查记忆' }), ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('暂无记忆');
  });

  it('上限 60 条 / 30KB（构造 80 条验证截断）', async () => {
    for (let i = 0; i < 80; i++) store.appendDailyLog('2026-07-30', `条目${i}内容`);
    const ctx = { sessionId, paths, permissions: { async check() { return 'allow'; } } };
    const r = await memoryGetTool.execute(JSON.stringify({ query: '条目', tool_title: '查记忆' }), ctx);
    expect(r.success).toBe(true);
    // 30KB 上限
    expect(r.output.length).toBeLessThanOrEqual(35 * 1024); // 含格式开销留余量
  });
});

describe('MEMORY_TOOL_NAMES', () => {
  it('包含 memory_write 和 memory_get', () => {
    expect(MEMORY_TOOL_NAMES).toContain('memory_write');
    expect(MEMORY_TOOL_NAMES).toContain('memory_get');
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/memory-tools.test.ts`
Expected: FAIL（`memoryWriteTool` / `memoryGetTool` / `MEMORY_TOOL_NAMES` 未导出）

- [x] **Step 3: 创建 memory.ts**

`deskminis/src/minisd/tools/memory.ts`:

```typescript
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
  async execute(inputStr, ctx) {
    let input: { markdown?: string; date?: string };
    try { input = JSON.parse(inputStr || '{}'); } catch { input = {}; }
    const markdown = (input.markdown ?? '').trim();
    if (!markdown) return { output: '记忆内容不能为空', success: false };
    const date = (input.date ?? '').trim() || todayDate();
    const store = makeStore(ctx as { paths: { root: string } });
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
  async execute(inputStr, ctx) {
    let input: { query?: string; limit?: number };
    try { input = JSON.parse(inputStr || '{}'); } catch { input = {}; }
    const query = (input.query ?? '').trim();
    if (!query) return { output: '查询不能为空', success: false };
    const limit = Math.min(input.limit ?? MAX_ENTRIES, MAX_ENTRIES);
    const store = makeStore(ctx as { paths: { root: string } });

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
```

- [x] **Step 4: 跑测试确认通过 + 全量不回归**

Run: `cd deskminis && npm test -- tests/memory-tools.test.ts`
Expected: PASS（11 个用例）

Run: `cd deskminis && npm test`
Expected: 全部通过（Task 1/2 + M2b 189 个测试不受影响）

- [x] **Step 5: Commit**

```bash
cd "<repo>" && git add deskminis/src/minisd/tools/memory.ts deskminis/tests/memory-tools.test.ts && git commit -m "feat(m2a): memory_write/memory_get 工具（关键词+新近度评分检索 + 60条/30KB 上限）"
```

---

### Task 4: ContextPolicy（水位分层决策 + token 估算）

**Files:**
- Create: `deskminis/src/minisd/agent/context-policy.ts`
- Test: `deskminis/tests/context-policy.test.ts`

**Interfaces:**
- Consumes: `ModelCatalog.getModelContextWindow`（M2b 已存在，非假定）、`AgentMessage`（M1 `shared/types`，`{ role, parts }`）
- Produces（Task 7 依赖）:
  - `type ContextAction = 'none' | 'offload' | 'compact'`
  - `class ContextPolicy {
      constructor(catalog: { getModelContextWindow(modelId: string): number | undefined });
      estimateTokens(history: AgentMessage[]): number;
      decide(modelId: string, tokenCount: number): ContextAction;
    }`

**语义**（设计 §4.2「上下文水位检查」）：按模型窗口分层——`<32K` 不管；`32-64K` 超 70% → offload；`64-128K` 超 50% → offload，超 70% → compact；`≥128K` 超 40% → offload，超 60% → compact。未知窗口（`getModelContextWindow` 返回 `undefined`）回退 32K 保守档（只 offload 不 compact）。`estimateTokens` 入参是 **`AgentMessage[]`**（不是 `RawMessage[]`）——水位检查发生在 `buildEffectiveHistory` 之后，此时只剩 `{ role, parts }`，`reasoningContent` 不在 effectiveHistory 里（它随 RawMessage → AgentMessage 映射被丢弃），故估算只算 `JSON.stringify(parts).length / 4`（英文 ~4 字符/token，中文偏保守，不引 tokenizer 库）。

- [x] **Step 1: 写失败测试**

`deskminis/tests/context-policy.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ContextPolicy, type ContextAction } from '../src/minisd/agent/context-policy';
import type { AgentMessage } from '../src/shared/types';

/** 假目录：固定窗口大小。 */
function fakeCatalog(window: number | undefined) {
  return { getModelContextWindow: () => window };
}

function msg(text: string): AgentMessage {
  return { role: 'user', parts: [{ type: 'text', value: text }] };
}

describe('ContextPolicy.estimateTokens', () => {
  it('空历史 0 token', () => {
    const p = new ContextPolicy(fakeCatalog(200_000));
    expect(p.estimateTokens([])).toBe(0);
  });

  it('粗估：parts JSON 字符数 / 4', () => {
    const p = new ContextPolicy(fakeCatalog(200_000));
    const history: AgentMessage[] = [msg('a'.repeat(400))];
    const t = p.estimateTokens(history);
    // JSON.stringify([{type:'text',value:'aaa...'}]) 长度 = 400 + 固定壳 ~22 → ~422/4 ≈ 106
    expect(t).toBe(Math.ceil((JSON.stringify(history[0].parts).length) / 4));
  });

  it('effectiveHistory 视角：只看 role+parts，没有 reasoningContent 字段可估', () => {
    // 印证签名从 RawMessage[] 改为 AgentMessage[] 的理由：reasoningContent 在
    // buildEffectiveHistory 时已被丢弃，水位估算拿不到它，所以这里也只算 parts。
    const p = new ContextPolicy(fakeCatalog(200_000));
    const history: AgentMessage[] = [{ role: 'assistant', parts: [{ type: 'text', value: 'b'.repeat(200) }] }];
    const t = p.estimateTokens(history);
    expect(t).toBe(Math.ceil(JSON.stringify(history[0].parts).length / 4));
  });
});

describe('ContextPolicy.decide', () => {
  it('未知窗口（undefined）→ 回退 32K 档：超 70% offload，不 compact', () => {
    const p = new ContextPolicy(fakeCatalog(undefined));
    expect(p.decide('unknown', 10_000)).toBe('none');     // 10K < 22.4K (70% of 32K)
    expect(p.decide('unknown', 24_000)).toBe('offload');  // > 70%
    expect(p.decide('unknown', 50_000)).toBe('offload');  // 仍只 offload（保守档不压缩）
  });

  it('32K 窗口：超 70% offload，不 compact', () => {
    const p = new ContextPolicy(fakeCatalog(32_000));
    expect(p.decide('m', 20_000)).toBe('none');
    expect(p.decide('m', 23_000)).toBe('offload'); // > 0.7 * 32000 = 22400
  });

  it('64K 窗口：超 50% offload，超 70% compact', () => {
    const p = new ContextPolicy(fakeCatalog(64_000));
    expect(p.decide('m', 30_000)).toBe('none');
    expect(p.decide('m', 35_000)).toBe('offload'); // > 0.5 * 64000 = 32000
    expect(p.decide('m', 50_000)).toBe('compact'); // > 0.7 * 64000 = 44800
  });

  it('128K 窗口：超 50% offload，超 70% compact', () => {
    const p = new ContextPolicy(fakeCatalog(128_000));
    expect(p.decide('m', 60_000)).toBe('none');
    expect(p.decide('m', 70_000)).toBe('offload'); // > 0.5 * 128000 = 64000
    expect(p.decide('m', 95_000)).toBe('compact'); // > 0.7 * 128000 = 89600
  });

  it('200K 窗口（≥128K 档）：超 40% offload，超 60% compact', () => {
    const p = new ContextPolicy(fakeCatalog(200_000));
    expect(p.decide('m', 70_000)).toBe('none');
    expect(p.decide('m', 90_000)).toBe('offload'); // > 0.4 * 200000 = 80000
    expect(p.decide('m', 130_000)).toBe('compact'); // > 0.6 * 200000 = 120000
  });

  it('边界：正好等于阈值取更激进档', () => {
    const p = new ContextPolicy(fakeCatalog(200_000));
    expect(p.decide('m', 80_000)).toBe('offload'); // == 0.4 阈值
    expect(p.decide('m', 120_000)).toBe('compact'); // == 0.6 阈值
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/context-policy.test.ts`
Expected: FAIL（`ContextPolicy` 未导出）

- [x] **Step 3: 创建 context-policy.ts**

`deskminis/src/minisd/agent/context-policy.ts`:

```typescript
import type { AgentMessage } from '../../shared/types';

export type ContextAction = 'none' | 'offload' | 'compact';

/** 模型窗口未知时的保守回退窗口（只 offload 不 compact）。 */
const FALLBACK_WINDOW = 32_000;

/**
 * 上下文水位检查（设计 §4.2「上下文水位检查」段）。
 * 消费 M2b ModelCatalog.getModelContextWindow，按窗口分层决策。
 *
 * 注意：estimateTokens 的入参是 AgentMessage[]（不是 RawMessage[]）——
 * 水位检查在 loop.ts 里发生在 buildEffectiveHistory 之后，此时只剩 { role, parts }，
 * reasoningContent 已被丢弃，故估算只算 parts JSON 字符数 / 4。
 */
export class ContextPolicy {
  constructor(private catalog: { getModelContextWindow(modelId: string): number | undefined }) {}

  /** 粗估 token 数：parts JSON 字符数 / 4。
   *  英文 ~4 字符/token；中文偏保守（实际 2 字符/token，这里高估触发更早，安全侧）。 */
  estimateTokens(history: AgentMessage[]): number {
    let chars = 0;
    for (const m of history) chars += JSON.stringify(m.parts).length;
    return Math.ceil(chars / 4);
  }

  /** 按窗口分层决策（设计 §4.2 阈值表）。
   *  档位边界：32K/64K/128K。128K 归入「64-128K」档（语义段以范围表述，
   *  测试「128K 窗口：超 50% offload，超 70% compact」锚定此归属）。 */
  decide(modelId: string, tokenCount: number): ContextAction {
    const window = this.catalog.getModelContextWindow(modelId) ?? FALLBACK_WINDOW;
    const ratio = tokenCount / window;

    if (window > 128_000) {
      if (ratio >= 0.6) return 'compact';
      if (ratio >= 0.4) return 'offload';
      return 'none';
    }
    if (window >= 64_000) {  // 64K - 128K（含 128K）
      if (ratio >= 0.7) return 'compact';
      if (ratio >= 0.5) return 'offload';
      return 'none';
    }
    if (window >= 32_000) {
      if (ratio >= 0.7) return 'offload';
      return 'none';
    }
    // < 32K：不管（设计原文）
    return 'none';
  }
}
```

- [x] **Step 4: 跑测试确认通过 + 全量不回归**

Run: `cd deskminis && npm test -- tests/context-policy.test.ts`
Expected: PASS（9 个用例）

Run: `cd deskminis && npm test`
Expected: 全部通过（Task 1-3 + M2b 189 个测试不受影响）

- [x] **Step 5: Commit**

```bash
cd "<repo>" && git add deskminis/src/minisd/agent/context-policy.ts deskminis/tests/context-policy.test.ts && git commit -m "feat(m2a): ContextPolicy 水位分层决策（消费 ModelCatalog 窗口 + token 估算 + 4 档阈值）"
```

---

### Task 5: OffloadEngine（大工具结果卸载）

**Files:**
- Create: `deskminis/src/minisd/agent/offload.ts`
- Test: `deskminis/tests/offload.test.ts`

**Interfaces:**
- Consumes: `MinisPaths.sessionBucket('offloads')`（M1 既有）
- Produces（Task 7 依赖）:
  - `class OffloadEngine {
      constructor(paths: MinisPaths);
      shouldOffload(output: string): boolean;
      offload(sessionId: string, toolUseId: string, output: string): { stub: string; relativePath: string };
    }`
  - `shouldOffload`: `output.length > 20_000`
  - `offload`: 写 `<root>/sessions/<sessionId>/offloads/<toolUseId>.txt`，返回 `{ stub, relativePath }`
  - stub 格式：`[CONTEXT OFFLOADED: offloads/<toolUseId>.txt (N 字符)]\n使用 file_read 工具读取 /var/minis/offloads/<toolUseId>.txt 取回完整内容`

**语义**（设计 §4.2「大工具结果卸载」）：>20k 字符写 `offloads/`，历史替换为桩。决策：**落库时替换**（设计原文"历史替换为桩"），`toolEnd` 事件广播替换前完整 `output`（UI 可见），落库的 `tool_result.parts` 存桩。`toolUseId` 已是 UUID 大写（M1 约束），直接作文件名安全。原子写（tmp + rename）。`relativePath` 是相对 session 目录的路径（`offloads/<toolUseId>.txt`），供桩引用。

- [x] **Step 1: 写失败测试**

`deskminis/tests/offload.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { OffloadEngine } from '../src/minisd/agent/offload';
import { MinisPaths } from '../src/minisd/paths';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let paths: MinisPaths;
const SID = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dm-off-')); paths = new MinisPaths(dir); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('OffloadEngine', () => {
  it('shouldOffload: ≤20k 字符返回 false', () => {
    const e = new OffloadEngine(paths);
    expect(e.shouldOffload('a'.repeat(20_000))).toBe(false);
    expect(e.shouldOffload('a'.repeat(19_999))).toBe(false);
  });

  it('shouldOffload: >20k 字符返回 true', () => {
    const e = new OffloadEngine(paths);
    expect(e.shouldOffload('a'.repeat(20_001))).toBe(true);
  });

  it('offload: 写文件 + 返回桩', () => {
    const e = new OffloadEngine(paths);
    const big = 'X'.repeat(25_000);
    const r = e.offload(SID, 'TOOL123', big);
    expect(r.relativePath).toBe('offloads/TOOL123.txt');
    const abs = join(dir, 'sessions', SID, 'offloads', 'TOOL123.txt');
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs, 'utf8')).toBe(big);
    expect(r.stub).toContain('[CONTEXT OFFLOADED');
    expect(r.stub).toContain('offloads/TOOL123.txt');
    expect(r.stub).toContain('/var/minis/offloads/TOOL123.txt');
  });

  it('offload: 桩包含字符数', () => {
    const e = new OffloadEngine(paths);
    const r = e.offload(SID, 'T1', 'Y'.repeat(30_000));
    expect(r.stub).toContain('30000');
  });

  it('offload: 原子写（tmp 不残留）', () => {
    const e = new OffloadEngine(paths);
    e.offload(SID, 'T2', 'Z'.repeat(21_000));
    expect(existsSync(join(dir, 'sessions', SID, 'offloads', 'T2.txt.tmp'))).toBe(false);
  });

  it('offload: 同 toolUseId 覆盖', () => {
    const e = new OffloadEngine(paths);
    e.offload(SID, 'T3', 'first'.repeat(5000));
    e.offload(SID, 'T3', 'second'.repeat(5000));
    const abs = join(dir, 'sessions', SID, 'offloads', 'T3.txt');
    expect(readFileSync(abs, 'utf8')).toContain('second');
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/offload.test.ts`
Expected: FAIL（`OffloadEngine` 未导出）

- [x] **Step 3: 创建 offload.ts**

`deskminis/src/minisd/agent/offload.ts`:

```typescript
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MinisPaths } from '../paths';

const THRESHOLD = 20_000;

/**
 * 大工具结果卸载（设计 §4.2「大工具结果卸载」段）。
 * >20k 字符写 offloads/<toolUseId>.txt，落库的 tool_result.output 替换为桩。
 * 决策：落库时替换（设计原文"历史替换为桩"）；toolEnd 事件广播替换前完整 output（Task 7 在 loop.ts 处理）。
 */
export class OffloadEngine {
  constructor(private paths: MinisPaths) {}

  shouldOffload(output: string): boolean {
    return output.length > THRESHOLD;
  }

  offload(sessionId: string, toolUseId: string, output: string): { stub: string; relativePath: string } {
    const dir = this.paths.sessionBucket(sessionId, 'offloads');
    mkdirSync(dir, { recursive: true });
    const fileName = `${toolUseId}.txt`;
    const abs = join(dir, fileName);
    // 原子写
    const tmp = abs + '.tmp';
    writeFileSync(tmp, output, 'utf8');
    renameSync(tmp, abs);
    const relativePath = `offloads/${fileName}`;
    const stub = `[CONTEXT OFFLOADED: ${relativePath} (${output.length} 字符)]\n使用 file_read 工具读取 /var/minis/offloads/${toolUseId}.txt 取回完整内容`;
    return { stub, relativePath };
  }
}
```

- [x] **Step 4: 跑测试确认通过 + 全量不回归**

Run: `cd deskminis && npm test -- tests/offload.test.ts`
Expected: PASS（6 个用例）

Run: `cd deskminis && npm test`
Expected: 全部通过（Task 1-4 + M2b 189 个测试不受影响）

- [x] **Step 5: Commit**

```bash
cd "<repo>" && git add deskminis/src/minisd/agent/offload.ts deskminis/tests/offload.test.ts && git commit -m "feat(m2a): OffloadEngine 大工具结果卸载（>20k 写 offloads + 桩替换 + 原子写）"
```

---

### Task 6: CompactEngine（LLM 压缩摘要 + effectiveAgentHistory 合成）

**Files:**
- Create: `deskminis/src/minisd/agent/compact.ts`
- Modify: `deskminis/src/minisd/store/chat-store.ts`（compact_markers CRUD）
- Modify: `deskminis/src/minisd/store/db.ts`（compact_markers 加 index）
- Modify: `deskminis/src/shared/types.ts`（增加 `CompactMarker` 类型）
- Test: `deskminis/tests/compact.test.ts`、`deskminis/tests/chat-store.test.ts`（追加）

**Interfaces:**
- Consumes: `ChatStore`（M1）、`AgentProvider`（M1）、`RawMessage`（M1，**仅用于取材与落库锚点定位**）
- Produces（Task 7 依赖）:
  - `interface CompactMarker { id: string; sessionId: string; summary: string; lastCompactedMessageId: string; createdAt: number }`
  - `class CompactEngine {
      constructor(chat: ChatStore);
      summarize(history: RawMessage[], sessionId: string, provider: AgentProvider): Promise<CompactMarker | undefined>;
      buildEffectiveHistory(history: RawMessage[], marker: CompactMarker | undefined): AgentMessage[];
    }`
  - ChatStore 新增：`appendCompactMarker(sessionId, summary, lastCompactedMessageId): CompactMarker`、`getLatestCompactMarker(sessionId): CompactMarker | undefined`
- `buildEffectiveHistory` 语义（raw history 只用于读取，永不改写）：
  - 无 marker：`history.map(m => ({ role: m.role, parts: m.parts }))` 原样返回
  - 有 marker 且 `lastCompactedMessageId` 在 history 中存在：`[{role:'user', parts:[{type:'text', value: '[对话摘要] '+summary}]}]` + history 中该 id 之后的所有消息
  - 有 marker 但锚点丢失（id 不在 history 中，如同步后 id 重映射）：按 `createdAt` 自愈——找 history 中第一个 `createdAt >= marker.createdAt` 的消息作为锚点，取其后所有消息；若全早于 marker.createdAt，返回 `[summary]` + 全部 history（保守不丢内容）

**语义**（设计 §4.2「压缩」）：LLM 摘要存 `compact_markers`，推理时合成 `effectiveAgentHistory`，**不改写存储历史**；保留最近 3 个用户回合原文。`summarize` 调用 provider 生成摘要，提示词要求模型总结到 marker 时已有的对话（不含最近 3 个用户回合——它们保留原文不进摘要）。**「最近 3 个用户回合」的判定**：只统计「`role === 'user'` 且 parts 中**含 `text` part 且不含 `toolResult` part**」的消息——本仓库 `tool_result` 也落库为 `user` 消息（M1 设计），若按 `role==='user'` 一刀切，工具密集会话里真正的用户提问会被压进摘要、丢失原文。**不足 3 个用户回合时不压缩**：返回 `undefined`、**不写任何 marker**、不调 provider（理由：若写一个锚点=最后一条消息的「跳过 marker」，下一轮 `buildEffectiveHistory` 只剩摘要占位符、整个对话上下文被抹掉——这是毒 marker）。锚点丢失按 `createdAt` 自愈（设计原文）。`compact_markers` 表 M1 已建（`db.ts` MIGRATIONS[0]），M2a 只补 CRUD + index。

- [x] **Step 1: 写失败测试**

`deskminis/tests/chat-store.test.ts` 追加（文件末尾新 describe）:

```typescript
import { openDb } from '../src/minisd/store/db';

describe('ChatStore compact_markers', () => {
  it('appendCompactMarker + getLatestCompactMarker', () => {
    const store = new ChatStore(openDb(':memory:'));
    const s = store.createSession();
    const m1 = store.appendCompactMarker(s.id, '摘要1', 'MSG1');
    expect(m1.id).toBeTruthy();
    expect(m1.summary).toBe('摘要1');
    expect(m1.lastCompactedMessageId).toBe('MSG1');
    const got = store.getLatestCompactMarker(s.id);
    expect(got?.summary).toBe('摘要1');
  });

  it('getLatestCompactMarker: 多个 marker 返回最新（createdAt 最大）', () => {
    const store = new ChatStore(openDb(':memory:'));
    const s = store.createSession();
    store.appendCompactMarker(s.id, '旧', 'MSG1');
    // 确保 createdAt 递增
    const m2 = store.appendCompactMarker(s.id, '新', 'MSG2');
    const got = store.getLatestCompactMarker(s.id);
    expect(got?.summary).toBe('新');
    expect(got?.lastCompactedMessageId).toBe('MSG2');
  });

  it('getLatestCompactMarker: 无 marker 返回 undefined', () => {
    const store = new ChatStore(openDb(':memory:'));
    const s = store.createSession();
    expect(store.getLatestCompactMarker(s.id)).toBeUndefined();
  });

  it('getLatestCompactMarker: 跨会话隔离', () => {
    const store = new ChatStore(openDb(':memory:'));
    const a = store.createSession();
    const b = store.createSession();
    store.appendCompactMarker(a.id, 'A摘要', 'MA');
    expect(store.getLatestCompactMarker(b.id)).toBeUndefined();
  });
});
```

`deskminis/tests/compact.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { CompactEngine } from '../src/minisd/agent/compact';
import { ChatStore } from '../src/minisd/store/chat-store';
import { openDb } from '../src/minisd/store/db';
import type { AgentProvider, StreamRequest } from '../src/minisd/providers/types';
import type { AgentStreamEvent, RawMessage } from '../src/shared/types';
import { ProviderError } from '../src/minisd/providers/types';

/** 脚本化假 Provider：固定返回摘要文本。 */
class SummaryProvider implements AgentProvider {
  readonly name = 'summary'; readonly modelId = 'fake';
  received: StreamRequest[] = [];
  constructor(private summaryText: string) {}
  async *streamAgentMessage(req: StreamRequest): AsyncIterable<AgentStreamEvent> {
    this.received.push(req);
    yield { kind: 'textDelta', text: this.summaryText };
    yield { kind: 'done', stopReason: 'endTurn' };
  }
}

function mkMsg(
  sessionId: string, role: 'user' | 'assistant', text: string, id: string, createdAt: number,
  parts?: RawMessage['parts'],
): RawMessage {
  return {
    id, sessionId, role,
    parts: parts ?? (text ? [{ type: 'text', value: text }] : []),
    createdAt, updatedAt: createdAt, sortOrder: 0, streamInterruptCount: 0,
  };
}

describe('CompactEngine.summarize', () => {
  it('调用 provider 生成摘要 + 写入 compact_markers', async () => {
    const store = new ChatStore(openDb(':memory:'));
    const sid = store.createSession().id;
    // 构造历史：6 个用户回合（保留最近 3 个原文，前 3 个进摘要）
    const history: RawMessage[] = [];
    for (let i = 0; i < 6; i++) {
      history.push(mkMsg(sid, 'user', `用户回合${i}`, `U${i}`, i + 1));
      history.push(mkMsg(sid, 'assistant', `助手回复${i}`, `A${i}`, i + 1.5));
    }
    const provider = new SummaryProvider('这是对话摘要');
    const engine = new CompactEngine(store);
    const marker = await engine.summarize(history, sid, provider);
    expect(marker.summary).toBe('这是对话摘要');
    // lastCompactedMessageId 应锚定到「保留最近 3 个用户回合」之前的最后一条消息
    // 最近 3 个用户回合 = U3,U4,U5；其前一条 = A2
    expect(marker.lastCompactedMessageId).toBe('A2');
    // marker 已落库
    const got = store.getLatestCompactMarker(sid);
    expect(got?.summary).toBe('这是对话摘要');
  });

  it('不足 3 个用户回合时不压缩：返回 undefined + 不调 provider + 不写 marker', async () => {
    const store = new ChatStore(openDb(':memory:'));
    const sid = store.createSession().id;
    const history = [mkMsg(sid, 'user', '只有一条', 'U0', 1)];
    const provider = new SummaryProvider('不该被调用');
    const engine = new CompactEngine(store);
    const marker = await engine.summarize(history, sid, provider);
    expect(marker).toBeUndefined();                 // 不写毒 marker
    expect(provider.received).toHaveLength(0);      // 不调 provider
    expect(store.getLatestCompactMarker(sid)).toBeUndefined(); // 库里仍无 marker
  });

  it('user 角色但只含 toolResult 的消息不计入「用户回合」（工具密集会话不丢真用户提问）', async () => {
    const store = new ChatStore(openDb(':memory:'));
    const sid = store.createSession().id;
    // 历史：U0(文本) A0 U1(文本) A1 U2(仅 toolResult) A2 U3(文本) A3 U4(文本) A4
    // 真正的「用户回合」= U0,U1,U3,U4 = 4 条 → 够 3 → 压缩
    // 「最近 3 个用户回合」= U1,U3,U4（按位置从后往前数 3 个真用户回合）
    // 锚点 = U1 前一条 = A0；toSummarize = [U0,A0]
    const history: RawMessage[] = [
      mkMsg(sid, 'user', '列目录', 'U0', 1),
      mkMsg(sid, 'assistant', '好', 'A0', 2),
      mkMsg(sid, 'user', '再列一次', 'U1', 3),
      mkMsg(sid, 'assistant', '', 'A1', 4, [{ type: 'toolUse', value: { toolUseId: 'T1', name: 'shell', input: '{}' } }]),
      mkMsg(sid, 'user', '', 'U2', 5, [{ type: 'toolResult', value: { toolUseId: 'T1', output: 'dir1\nfile1', success: true, status: 'success' } }]),
      mkMsg(sid, 'assistant', '完成', 'A2', 6),
      mkMsg(sid, 'user', '继续', 'U3', 7),
      mkMsg(sid, 'assistant', '好', 'A3', 8),
      mkMsg(sid, 'user', '谢谢', 'U4', 9),
      mkMsg(sid, 'assistant', '不客气', 'A4', 10),
    ];
    const provider = new SummaryProvider('摘要');
    const engine = new CompactEngine(store);
    const marker = await engine.summarize(history, sid, provider);
    expect(marker).toBeDefined();
    expect(marker!.lastCompactedMessageId).toBe('A0');   // 修复后：锚点在 U1 之前 = A0
    // 修复前（按 role==='user' 一刀切）：用户回合=U0,U1,U2,U3,U4=5，最近3=U2,U3,U4，锚点=A1 → 错误
    // 验证 toSummarize 只含 U0,A0（不含 U1——U1 保留原文）
    expect(provider.received[0].messages.map(m => m.role)).toEqual(['user', 'user', 'assistant']);
    // 第一条是 summaryPrompt（user），后两条是 U0(user)、A0(assistant)
  });

  it('provider 抛错时 summarize 透传错误且不写 marker', async () => {
    const store = new ChatStore(openDb(':memory:'));
    const sid = store.createSession().id;
    const history: RawMessage[] = [];
    for (let i = 0; i < 6; i++) { history.push(mkMsg(sid, 'user', `u${i}`, `U${i}`, i + 1)); history.push(mkMsg(sid, 'assistant', `a${i}`, `A${i}`, i + 1.5)); }
    const provider: AgentProvider = {
      name: 'fail', modelId: 'f',
      async *streamAgentMessage(): AsyncIterable<AgentStreamEvent> { throw new ProviderError('摘要失败', { status: 500 }); },
    };
    const engine = new CompactEngine(store);
    await expect(engine.summarize(history, sid, provider)).rejects.toThrow('摘要失败');
    expect(store.getLatestCompactMarker(sid)).toBeUndefined();
  });
});

describe('CompactEngine.buildEffectiveHistory', () => {
  it('无 marker: 原样返回', () => {
    const store = new ChatStore(openDb(':memory:'));
    const sid = store.createSession().id;
    const history = [mkMsg(sid, 'user', '你好', 'U0', 1), mkMsg(sid, 'assistant', '你好呀', 'A0', 2)];
    const out = new CompactEngine(store).buildEffectiveHistory(history, undefined);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('user');
  });

  it('有 marker 且锚点存在: 摘要 + 锚点之后的消息', () => {
    const store = new ChatStore(openDb(':memory:'));
    const sid = store.createSession().id;
    const history = [
      mkMsg(sid, 'user', '旧1', 'U0', 1), mkMsg(sid, 'assistant', '旧1回复', 'A0', 2),
      mkMsg(sid, 'user', '新1', 'U1', 3), mkMsg(sid, 'assistant', '新1回复', 'A1', 4),
    ];
    const marker = { id: 'M1', sessionId: sid, summary: '旧对话摘要', lastCompactedMessageId: 'A0', createdAt: 2 };
    const out = new CompactEngine(store).buildEffectiveHistory(history, marker);
    // 摘要（user） + U1 + A1
    expect(out).toHaveLength(3);
    expect(out[0].parts[0]).toEqual({ type: 'text', value: '[对话摘要] 旧对话摘要' });
    expect(out[1].parts[0]).toEqual({ type: 'text', value: '新1' });
  });

  it('锚点丢失（id 不在 history）: 按 createdAt 自愈', () => {
    const store = new ChatStore(openDb(':memory:'));
    const sid = store.createSession().id;
    const history = [
      mkMsg(sid, 'user', '旧', 'U0', 1),
      mkMsg(sid, 'user', '新', 'U1', 5),
      mkMsg(sid, 'assistant', '新回复', 'A1', 6),
    ];
    // 锚点 id 'GONE' 不在 history；marker.createdAt = 4
    const marker = { id: 'M1', sessionId: sid, summary: '摘要', lastCompactedMessageId: 'GONE', createdAt: 4 };
    const out = new CompactEngine(store).buildEffectiveHistory(history, marker);
    // 摘要 + createdAt >= 4 的消息（U1, A1）
    expect(out).toHaveLength(3);
    expect(out[1].parts[0]).toEqual({ type: 'text', value: '新' });
  });

  it('锚点丢失且全早于 marker.createdAt: 返回摘要 + 全部历史（保守不丢内容）', () => {
    const store = new ChatStore(openDb(':memory:'));
    const sid = store.createSession().id;
    const history = [mkMsg(sid, 'user', 'x', 'U0', 1)];
    const marker = { id: 'M1', sessionId: sid, summary: '摘要', lastCompactedMessageId: 'GONE', createdAt: 100 };
    const out = new CompactEngine(store).buildEffectiveHistory(history, marker);
    expect(out).toHaveLength(2); // 摘要 + U0
    expect(out[0].parts[0]).toEqual({ type: 'text', value: '[对话摘要] 摘要' });
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/compact.test.ts tests/chat-store.test.ts`
Expected: FAIL（`CompactEngine` 未导出；`appendCompactMarker` / `getLatestCompactMarker` 不存在）

- [x] **Step 3a: 修改 shared/types.ts 增加 CompactMarker**

在 `deskminis/src/shared/types.ts` 末尾追加：

```typescript
export interface CompactMarker {
  id: string;
  sessionId: string;
  summary: string;
  lastCompactedMessageId: string;
  createdAt: number;
}
```

- [x] **Step 3b: 修改 db.ts 加 index（追加 MIGRATIONS[1]）**

在 `deskminis/src/minisd/store/db.ts` 的 `MIGRATIONS` 数组**追加一个新元素** `MIGRATIONS[1]`（**不要**往 `MIGRATIONS[0]` 里塞 CREATE INDEX）：

```typescript
const MIGRATIONS = [
  // [0] M1 已发布：CREATE TABLE sessions / messages / compact_markers / ...（原内容不动）
  `CREATE TABLE ...原有 M1 语句...;`,
  // [1] M2a 新增：compact_markers 按 (session_id, created_at DESC) 建索引
  //  必须是新迁移条目，不能追加进 MIGRATIONS[0]——已有用户库 user_version=1，
  //  db.ts 的迁移 runner 只对 user_version < N 的库跑 MIGRATIONS[0..N-1]，
  //  改 MIGRATIONS[0] 对已发布库是 no-op（迁移一经发布不可改）。
  `CREATE INDEX IF NOT EXISTS idx_compact_markers_session ON compact_markers(session_id, created_at DESC);`,
];
```

`IF NOT EXISTS` 是双保险：开发库（M1 时已建表但无索引，user_version=1）跑 MIGRATIONS[1] 建索引；若索引已存在则跳过。迁移 runner（M1 既有）会自动把 `user_version` 推到 2。

- [x] **Step 3c: 修改 chat-store.ts 增加 compact_markers CRUD**

在 `deskminis/src/minisd/store/chat-store.ts` 的 `ChatStore` 类内（`deleteSession` 之后）追加：

```typescript
  appendCompactMarker(sessionId: string, summary: string, lastCompactedMessageId: string): CompactMarker {
    const m: CompactMarker = { id: this.newId(), sessionId, summary, lastCompactedMessageId, createdAt: this.nowEpoch() };
    this.db.prepare('INSERT INTO compact_markers (id, session_id, summary, last_compacted_message_id, created_at) VALUES (?,?,?,?,?)')
      .run(m.id, m.sessionId, m.summary, m.lastCompactedMessageId, m.createdAt);
    return m;
  }

  getLatestCompactMarker(sessionId: string): CompactMarker | undefined {
    const r = this.db.prepare('SELECT * FROM compact_markers WHERE session_id=? ORDER BY created_at DESC LIMIT 1').get(sessionId) as
      { id: string; session_id: string; summary: string; last_compacted_message_id: string; created_at: number } | undefined;
    if (!r) return undefined;
    return { id: r.id, sessionId: r.session_id, summary: r.summary, lastCompactedMessageId: r.last_compacted_message_id, createdAt: r.created_at };
  }
```

并在文件顶部 import 补充 `CompactMarker`：

```typescript
import type { CompactMarker, RawMessage, SessionMeta, TokenUsage } from '../../shared/types';
```

- [x] **Step 3d: 创建 compact.ts**

`deskminis/src/minisd/agent/compact.ts`:

```typescript
import type { AgentMessage, CompactMarker, RawMessage } from '../../shared/types';
import type { AgentProvider } from '../providers/types';
import type { ChatStore } from '../store/chat-store';

const RECENT_USER_TURNS = 3;

/**
 * 判定一条消息是否为「真正的用户回合」（用于压缩时数最近 3 个）。
 * 本仓库 tool_result 也落库为 role='user'（M1 设计），但它不是用户提问——
 * 工具密集会话里若把它也算进去，真正的用户提问会被挤进摘要、丢失原文。
 * 判定：role==='user' 且 parts 含 text part 且不含 toolResult part。
 */
function isRealUserTurn(m: RawMessage): boolean {
  if (m.role !== 'user') return false;
  let hasText = false;
  for (const p of m.parts) {
    if (p.type === 'text') hasText = true;
    if (p.type === 'toolResult') return false;
  }
  return hasText;
}

/**
 * LLM 压缩摘要（设计 §4.2「压缩」段）。
 * 摘要存 compact_markers，推理时合成 effectiveAgentHistory，不改写存储历史。
 * 保留最近 3 个真正的用户回合原文；锚点丢失按 createdAt 自愈。
 *
 * 数据流契约（与 Task 7 一致）：
 *  - raw history 在本类里只用于「取材（toSummarize）」和「锚点定位」——永不改写。
 *  - effectiveAgentHistory 由 buildEffectiveHistory 合成，是请求构建与水位估算的唯一输入。
 */
export class CompactEngine {
  constructor(private chat: ChatStore) {}

  /**
   * 调用 provider 生成摘要并写入 compact_markers。
   * lastCompactedMessageId 锚定到「保留最近 3 个用户回合」之前的最后一条消息。
   *
   * 不足 3 个真正的用户回合时返回 undefined、不写任何 marker、不调 provider——
   * 否则写一个锚点=最后一条消息的「跳过 marker」会让下一轮 effectiveHistory
   * 只剩摘要占位符、整个对话上下文被抹掉（毒 marker）。
   */
  async summarize(history: RawMessage[], sessionId: string, provider: AgentProvider): Promise<CompactMarker | undefined> {
    // 从后往前数 3 个「真正的用户回合」
    const userIdxs: number[] = [];
    for (let i = history.length - 1; i >= 0; i--) {
      if (isRealUserTurn(history[i])) userIdxs.push(i);
      if (userIdxs.length >= RECENT_USER_TURNS) break;
    }
    if (userIdxs.length < RECENT_USER_TURNS) return undefined; // 不写毒 marker

    // 锚点 = 第 3 个用户回合之前的那条消息
    const anchorIdx = userIdxs[userIdxs.length - 1] - 1;
    const anchorMsg = anchorIdx >= 0 ? history[anchorIdx] : history[0];
    const toSummarize = anchorIdx >= 0 ? history.slice(0, anchorIdx + 1) : [];

    // 调 provider 生成摘要
    const summaryPrompt = '请用不超过 500 字总结以下对话的关键信息（用户意图、已做决策、关键文件路径、待办事项）。只输出摘要正文，不要额外格式：\n\n';
    const messages: AgentMessage[] = toSummarize.map(m => ({ role: m.role, parts: m.parts }));
    messages.unshift({ role: 'user', parts: [{ type: 'text', value: summaryPrompt }] });

    let summary = '';
    for await (const ev of provider.streamAgentMessage({
      messages, systemPrompt: '你是对话摘要助手。',
      tools: [], maxTokens: 1024, thinkingLevel: 'off',
    })) {
      if (ev.kind === 'textDelta') summary += ev.text;
    }

    return this.chat.appendCompactMarker(sessionId, summary || '[摘要为空]', anchorMsg.id);
  }

  /**
   * 合成 effectiveAgentHistory（设计 §4.2「推理时合成」）。
   * 无 marker → 原样；有 marker → 摘要 + 锚点之后的消息；锚点丢失按 createdAt 自愈。
   * raw history 只读，永不改写。
   */
  buildEffectiveHistory(history: RawMessage[], marker: CompactMarker | undefined): AgentMessage[] {
    if (!marker) return history.map(m => ({ role: m.role, parts: m.parts }));

    const summaryMsg: AgentMessage = {
      role: 'user',
      parts: [{ type: 'text', value: `[对话摘要] ${marker.summary}` }],
    };

    // 锚点 id 存在 → 取其后所有消息
    const idx = history.findIndex(m => m.id === marker.lastCompactedMessageId);
    if (idx >= 0) {
      const after = history.slice(idx + 1).map(m => ({ role: m.role, parts: m.parts }));
      return [summaryMsg, ...after];
    }

    // 锚点丢失：按 createdAt 自愈（设计原文）
    const selfHealIdx = history.findIndex(m => m.createdAt >= marker.createdAt);
    if (selfHealIdx >= 0) {
      const after = history.slice(selfHealIdx).map(m => ({ role: m.role, parts: m.parts }));
      return [summaryMsg, ...after];
    }

    // 全早于 marker.createdAt：保守返回摘要 + 全部历史（不丢内容）
    return [summaryMsg, ...history.map(m => ({ role: m.role, parts: m.parts }))];
  }
}
```

- [x] **Step 4: 跑测试确认通过 + 全量不回归**

Run: `cd deskminis && npm test -- tests/compact.test.ts tests/chat-store.test.ts`
Expected: PASS（compact 8 个用例 + chat-store 新增 4 个用例）

Run: `cd deskminis && npm test`
Expected: 全部通过（Task 1-5 + M2b 189 个测试不受影响——chat-store 只新增方法，M1 既有方法签名不变）

- [x] **Step 5: Commit**

```bash
cd "<repo>" && git add deskminis/src/minisd/agent/compact.ts deskminis/src/minisd/store/chat-store.ts deskminis/src/minisd/store/db.ts deskminis/src/shared/types.ts deskminis/tests/compact.test.ts deskminis/tests/chat-store.test.ts && git commit -m "feat(m2a): CompactEngine LLM 压缩摘要 + effectiveAgentHistory 合成（compact_markers CRUD + 锚点自愈 + 保留最近3用户回合）"
```

---

### Task 7: Agent 循环装配（offload + compact + memory 注入）

**Files:**
- Modify: `deskminis/src/minisd/agent/loop.ts`
- Modify: `deskminis/src/minisd/index.ts`
- Modify: `deskminis/src/shared/types.ts`（`SessionMeta` 增加 `memoryEnabled?`）
- Modify: `deskminis/src/minisd/store/chat-store.ts`（`getSession` 读 `memory_enabled`、新增 `setMemoryEnabled`）
- Test: `deskminis/tests/agent-loop.test.ts`（追加）、`deskminis/tests/rpc.test.ts`（追加）

**Interfaces:**
- Consumes: `MemoryInjector`（Task 2）、`memoryWriteTool` / `memoryGetTool` / `MEMORY_TOOL_NAMES`（Task 3）、`ContextPolicy`（Task 4）、`OffloadEngine`（Task 5）、`CompactEngine`（Task 6）
- Produces:
  - `loop.ts` `RunOptions` 增加可选字段：
    - `contextPolicy?: ContextPolicy`
    - `compactEngine?: CompactEngine`
    - `offloadEngine?: OffloadEngine`
    - `excludedToolNames?: Set<string>`
  - `loop.ts` `LoopEvent` 增加：`{ kind: 'compacted'; markerId: string; summary: string }`、`{ kind: 'offloaded'; toolUseId: string; relativePath: string }`
  - `index.ts` 新增 RPC：`chat.sessions.setMemoryEnabled(p: { sessionId: string; enabled: boolean })`
  - `ChatStore.setMemoryEnabled(sessionId: string, enabled: boolean): void`
  - `SessionMeta` 增加 `memoryEnabled?: boolean`（默认 true）

**语义**（设计 §4.2 循环顺序 + §3.4 记忆开关）：

1. **记忆注入**（`index.ts` `chat.prompt` 入口）：用 `MemoryInjector.build(SYSTEM_PROMPT, { memoryEnabled: session.memoryEnabled })` 构建系统提示，一次注入整轮复用（决策见 Architecture）
2. **工具过滤**（`index.ts` `chat.prompt` 入口）：`session.memoryEnabled === false` 时把 `MEMORY_TOOL_NAMES` 加入 `excludedToolNames` 传给 loop
3. **卸载**（`loop.ts` tool_result 落库前）：`offloadEngine.shouldOffload(output)` 为 true 时调用 `offloadEngine.offload(...)` 替换 `output` 为桩，广播 `offloaded` 事件，再落库；`toolEnd` 事件广播替换前完整 `output`
4. **effectiveAgentHistory 合成**（`loop.ts` 每轮开头，先于水位检查）：`buildEffectiveHistory(history, chat.getLatestCompactMarker(sessionId))` 合成推理用历史；raw history 只用于取材/落库，**永不改写**——effectiveHistory 是水位估算与请求构建的唯一输入
5. **压缩**（`loop.ts` 每轮，在 effectiveHistory 之上）：`contextPolicy.decide(modelId, estimateTokens(effectiveHistory))` 返回 `compact` 且本循环压缩次数 < 3 时，调用 `compactEngine.summarize(history, sessionId, activeSlot.provider)`——返回 marker 则广播 `compacted` 事件、`turn--`、`continue` 重新取 history+effectiveHistory（水位下降）；返回 `undefined`（不足 3 个真正用户回合）则**不**发事件、**不** turn--、**不** continue，直接用现有 effectiveHistory 继续流式请求（绝不在 undefined 上 continue 重试，否则死循环）
6. **请求构建**（`loop.ts`）：复用上方合成的 `effectiveHistory`，`pairToolResults` 在其上做配对（M2b 既有，不动）

**数据流契约**（Task 4/6/7 共用同一叙述）：raw history 只用于 `summarize` 取材与落库；`estimateTokens` / `decide` / 请求构建一律基于 `effectiveHistory`。这样压缩写 marker 后 effectiveHistory 变小、水位自然下降，不会出现「存储不改写 → 水位永不降 → 每次 chat.prompt 都重复压缩到 3 次上限」的缺陷。

**装配约束**：压缩与降级链共存——压缩用当前 `activeSlot.provider`（降级后用备选 provider 压缩）；压缩失败（provider 抛错）不终止循环，跳过本次压缩继续流式请求（避免压缩失败杀掉对话）；卸载在降级循环之外（tool_result 落库是降级循环之后的事，此时 slot 已确定）。

- [x] **Step 1: 写失败测试**

`deskminis/tests/agent-loop.test.ts` 追加（文件末尾新 describe）:

```typescript
import { ContextPolicy } from '../src/minisd/agent/context-policy';
import { OffloadEngine } from '../src/minisd/agent/offload';
import { CompactEngine } from '../src/minisd/agent/compact';
import { MemoryStore } from '../src/minisd/store/memory-store';

describe('runAgentLoop + 压缩/卸载装配', () => {
  it('大工具结果触发卸载：toolEnd 广播完整 output，落库为桩', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    // 注册一个返回大输出的工具
    const bigTool: ToolExecutor = {
      definition: { name: 'big', description: '大输出', parameters: { tool_title: { type: 'string', description: 't' } }, required: ['tool_title'] },
      async execute() { return { output: 'B'.repeat(25_000), success: true }; },
    };
    tools.register(bigTool);
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: '调用 big' }], createdAt: store.nowEpoch(), streamInterruptCount: 0 });
    const provider = new ScriptedProvider([[
      { kind: 'toolCallComplete', toolUseId: 'T1', name: 'big', input: '{"tool_title":"大输出"}' },
      { kind: 'done', stopReason: 'toolUse' },
    ], [
      { kind: 'textDelta', text: '完成' }, { kind: 'done', stopReason: 'endTurn' },
    ]]);
    const offload = new OffloadEngine(new MinisPaths(mkdtempSync(join(tmpdir(), 'dm-off-'))));
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', offloadEngine: offload }));
    // toolEnd 事件广播完整 output
    const toolEnd = events.find(e => e.kind === 'toolEnd') as any;
    expect(toolEnd.output.length).toBe(25_000);
    // 落库的 tool_result output 是桩
    const msgs = store.listMessages(sessionId);
    const toolResultMsg = msgs.find(m => m.parts.some(p => p.type === 'toolResult'));
    const trPart = toolResultMsg!.parts.find(p => p.type === 'toolResult')!.value as any;
    expect(trPart.output).toContain('[CONTEXT OFFLOADED');
    expect(trPart.output.length).toBeLessThan(500);
    // offloaded 事件
    expect(events.some(e => e.kind === 'offloaded')).toBe(true);
  });

  it('压缩触发：水位超阈值 → compacted 事件 + effectiveHistory 含摘要', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    // 6 个用户回合，每条 2000 字符：raw history ~6075 token → 窗口 8000 → ratio 0.76 → compact
    // （注意：token ≠ 字符；JSON.stringify(parts).length/4 才是 estimateTokens 的口径，
    //   500 字符/条只有 ~1575 token → ratio 0.197 → 不触发。必须 2000 字符/条才够。）
    for (let i = 0; i < 6; i++) {
      store.appendMessage({ id: `U${i}`, sessionId, role: 'user', parts: [{ type: 'text', value: 'x'.repeat(2000) }], createdAt: i + 1, streamInterruptCount: 0 });
      store.appendMessage({ id: `A${i}`, sessionId, role: 'assistant', parts: [{ type: 'text', value: 'y'.repeat(2000) }], createdAt: i + 1.5, streamInterruptCount: 0 });
    }
    const policy = new ContextPolicy({ getModelContextWindow: () => 8_000 });
    const compact = new CompactEngine(store);
    // dualProvider：第 1 次被压缩引擎当摘要 provider 调，第 2 次才是正式回复
    let callCount = 0;
    const dualProvider: AgentProvider = {
      name: 'dual', modelId: 'fake',
      async *streamAgentMessage(req) {
        callCount++;
        if (callCount === 1) {
          yield { kind: 'textDelta', text: '压缩摘要' }; yield { kind: 'done', stopReason: 'endTurn' };
          return;
        }
        // 正式回复：effectiveHistory 含 [对话摘要]
        const firstUser = req.messages.find(m => m.role === 'user');
        expect(JSON.stringify(firstUser?.parts)).toContain('[对话摘要]');
        yield { kind: 'textDelta', text: '回复' }; yield { kind: 'done', stopReason: 'endTurn' };
      },
    };
    const events = await collect(runAgentLoop(store, { sessionId, provider: dualProvider, tools, toolContext, systemPrompt: 'sys', contextPolicy: policy, compactEngine: compact }));
    expect(events.some(e => e.kind === 'compacted')).toBe(true);
    expect(callCount).toBe(2); // 1 次摘要 + 1 次正式回复
    expect(events.at(-1)?.kind).toBe('turnEnd');
  });

  it('压缩一次后水位下降：同一循环不再重复压缩', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    // 4 个用户回合：U0/A0 巨大（撑高水位），U1~A3 极小
    // recent 3 真用户回合 = U1,U2,U3；anchor = A0；toSummarize = [U0,A0]
    // 压缩后 effectiveHistory = [summary, U1,A1,U2,A2,U3,A3] 全小 → 水位降到 none → 不再 compact
    store.appendMessage({ id: 'U0', sessionId, role: 'user', parts: [{ type: 'text', value: 'X'.repeat(2000) }], createdAt: 1, streamInterruptCount: 0 });
    store.appendMessage({ id: 'A0', sessionId, role: 'assistant', parts: [{ type: 'text', value: 'Y'.repeat(2000) }], createdAt: 2, streamInterruptCount: 0 });
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: '小1' }], createdAt: 3, streamInterruptCount: 0 });
    store.appendMessage({ id: 'A1', sessionId, role: 'assistant', parts: [{ type: 'text', value: '小A1' }], createdAt: 4, streamInterruptCount: 0 });
    store.appendMessage({ id: 'U2', sessionId, role: 'user', parts: [{ type: 'text', value: '小2' }], createdAt: 5, streamInterruptCount: 0 });
    store.appendMessage({ id: 'A2', sessionId, role: 'assistant', parts: [{ type: 'text', value: '小A2' }], createdAt: 6, streamInterruptCount: 0 });
    store.appendMessage({ id: 'U3', sessionId, role: 'user', parts: [{ type: 'text', value: '小3' }], createdAt: 7, streamInterruptCount: 0 });
    store.appendMessage({ id: 'A3', sessionId, role: 'assistant', parts: [{ type: 'text', value: '小A3' }], createdAt: 8, streamInterruptCount: 0 });
    // 窗口 1000：raw history ~1010 token → compact；压缩后 effectiveHistory ~80 token → none
    const policy = new ContextPolicy({ getModelContextWindow: () => 1_000 });
    const compact = new CompactEngine(store);
    let callCount = 0;
    const provider: AgentProvider = {
      name: 'p', modelId: 'fake',
      async *streamAgentMessage(req) {
        callCount++;
        if (callCount === 1) { yield { kind: 'textDelta', text: '对话摘要' }; yield { kind: 'done', stopReason: 'endTurn' }; return; }
        // 第 2 次：effectiveHistory 已含摘要且水位下降不再 compact
        const firstUser = req.messages.find(m => m.role === 'user');
        expect(JSON.stringify(firstUser?.parts)).toContain('[对话摘要]');
        yield { kind: 'textDelta', text: '回复' }; yield { kind: 'done', stopReason: 'endTurn' };
      },
    };
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', contextPolicy: policy, compactEngine: compact }));
    // 恰好 1 次 compacted（压缩后 effectiveHistory 变小、水位降到 none，同一循环不再重复压缩）
    expect(events.filter(e => e.kind === 'compacted')).toHaveLength(1);
    expect(callCount).toBe(2); // 1 次摘要 + 1 次正式回复
    expect(events.at(-1)?.kind).toBe('turnEnd');
    expect(store.getLatestCompactMarker(sessionId)?.summary).toBe('对话摘要');
  });

  it('excludedToolNames: 过滤工具定义', async () => {
    const { store, tools, toolContext, sessionId } = mkCtx();
    const hiddenTool: ToolExecutor = {
      definition: { name: 'hidden', description: '应被隐藏', parameters: { tool_title: { type: 'string', description: 't' } }, required: ['tool_title'] },
      async execute() { return { output: '不该被调用', success: true }; },
    };
    tools.register(hiddenTool);
    store.appendMessage({ id: 'U1', sessionId, role: 'user', parts: [{ type: 'text', value: '你好' }], createdAt: 1, streamInterruptCount: 0 });
    const provider = new ScriptedProvider([[
      // provider 能看到的 tools 不应含 hidden
      { kind: 'textDelta', text: 'ok' }, { kind: 'done', stopReason: 'endTurn' },
    ]]);
    provider.seen.length = 0;
    const events = await collect(runAgentLoop(store, { sessionId, provider, tools, toolContext, systemPrompt: 'sys', excludedToolNames: new Set(['hidden']) }));
    // 验证 provider 收到的 tools 不含 hidden
    expect(provider.seen[0].tools.find(t => t.name === 'hidden')).toBeUndefined();
    expect(events.at(-1)?.kind).toBe('turnEnd');
  });
});
```

`deskminis/tests/rpc.test.ts` 追加（文件末尾新 describe）:

```typescript
describe('chat.sessions.setMemoryEnabled', () => {
  it('设置 memoryEnabled 并在 getSession 读回', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    const s = (await c.call('chat.sessions.create', { title: 'M' })).result;
    // 默认 memoryEnabled = true（db.ts memory_enabled DEFAULT 1）
    expect((await c.call('chat.sessions.list')).result[0].memoryEnabled).toBe(true);
    // 关闭
    await c.call('chat.sessions.setMemoryEnabled', { sessionId: s.id, enabled: false });
    const list = (await c.call('chat.sessions.list')).result;
    expect(list[0].memoryEnabled).toBe(false);
    // 再开
    await c.call('chat.sessions.setMemoryEnabled', { sessionId: s.id, enabled: true });
    expect((await c.call('chat.sessions.list')).result[0].memoryEnabled).toBe(true);
    c.close();
  });

  it('非法 sessionId 被拒', async () => {
    const { port, authToken } = await boot();
    const c = rpcClient(port, authToken); await c.ready;
    expect((await c.call('chat.sessions.setMemoryEnabled', { sessionId: 'evil', enabled: false })).error).toBeTruthy();
    c.close();
  });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `cd deskminis && npm test -- tests/agent-loop.test.ts tests/rpc.test.ts`
Expected: FAIL（`offloadEngine` / `contextPolicy` / `compactEngine` / `excludedToolNames` 不在 `RunOptions`；`offloaded` / `compacted` 事件不存在；`setMemoryEnabled` RPC 不存在；`SessionMeta.memoryEnabled` 不存在）

- [x] **Step 3a: 修改 shared/types.ts**

`deskminis/src/shared/types.ts` 的 `SessionMeta` 增加字段：

```typescript
export interface SessionMeta {
  id: string; title: string; modelBinding?: string;
  memoryEnabled?: boolean;       // 新增：会话级记忆开关，默认 true
  createdAt: number; updatedAt: number; pinnedAt?: number;
}
```

- [x] **Step 3b: 修改 chat-store.ts**

`deskminis/src/minisd/store/chat-store.ts`：

1. `getSession` 的 SELECT 与返回增加 `memory_enabled`：

```typescript
  getSession(id: string): SessionMeta | undefined {
    const r = this.db.prepare('SELECT id, title, model_binding, memory_enabled, created_at, updated_at, pinned_at FROM sessions WHERE id=?').get(id) as
      { id: string; title: string; model_binding: string | null; memory_enabled: number; created_at: number; updated_at: number; pinned_at: number | null } | undefined;
    if (!r) return undefined;
    return { id: r.id, title: r.title, modelBinding: r.model_binding ?? undefined, memoryEnabled: r.memory_enabled === 1, createdAt: r.created_at, updatedAt: r.updated_at, pinnedAt: r.pinned_at ?? undefined };
  }
```

2. 在 `setModelBinding` 之后追加 `setMemoryEnabled`：

```typescript
  /** 写入 sessions.memory_enabled（设计 §3.4 会话级记忆开关）。 */
  setMemoryEnabled(sessionId: string, enabled: boolean): void {
    this.db.prepare('UPDATE sessions SET memory_enabled=?, updated_at=? WHERE id=?').run(enabled ? 1 : 0, this.nowEpoch(), sessionId);
  }
```

- [x] **Step 3c: 修改 loop.ts**

`deskminis/src/minisd/agent/loop.ts`：

1. 顶部 import 增加：

```typescript
import type { ContextPolicy } from './context-policy';
import type { OffloadEngine } from './offload';
import type { CompactEngine } from './compact';
```

2. `LoopEvent` 联合增加两个变体（在 `fallback` 之后）：

```typescript
  | { kind: 'compacted'; markerId: string; summary: string }
  | { kind: 'offloaded'; toolUseId: string; relativePath: string }
```

3. `RunOptions` 增加可选字段：

```typescript
export interface RunOptions {
  sessionId: string; provider: AgentProvider; tools: ToolRegistry; toolContext: ToolContext;
  systemPrompt: string; maxTokens?: number; thinkingLevel?: ThinkingLevel; maxTurns?: number;
  signal?: AbortSignal; retryDelaysMs?: number[];
  fallbackChain?: ProviderSlot[];
  contextPolicy?: ContextPolicy;       // 新增
  compactEngine?: CompactEngine;       // 新增
  offloadEngine?: OffloadEngine;       // 新增
  excludedToolNames?: Set<string>;     // 新增：按会话过滤工具（memory_enabled=false 时排除记忆工具）
}
```

4. 在 `runAgentLoop` 函数体内，`let hadToolCallInPrevTurn = false;` 之后增加压缩计数器：

```typescript
  let compactCount = 0; // 本循环已压缩次数（上限 3，设计 §4.2）
```

5. 在 `for` 循环体内，`const history = store.listMessages(opts.sessionId);` 之后，**先合成 effectiveHistory**（raw history 只用于取材/落库，estimate/decide/请求构建一律基于 effectiveHistory——这是数据流契约，见 Task 6 数据流注释）：

```typescript
    // 推理时合成 effectiveAgentHistory（设计 §4.2「推理时合成」）
    // raw history 永不改写；effectiveHistory 是水位估算与请求构建的唯一输入。
    const curMarker = opts.compactEngine ? store.getLatestCompactMarker(opts.sessionId) : undefined;
    const effectiveHistory = opts.compactEngine
      ? opts.compactEngine.buildEffectiveHistory(history, curMarker)
      : toAgentMessages(history);
```

6. 在 `effectiveHistory` 之上做水位检查 + 压缩（**不是**在原始 `history` 上——存储永不改写，压缩后 raw history 不变，在 raw history 上估算水位永远不会下降，会导致每次 `chat.prompt` 都重复压缩到 3 次上限。改为在 effectiveHistory 上估算：压缩写 marker 后 `continue`，下一轮重新取 marker + buildEffectiveHistory，effectiveHistory 变小、水位自然下降）：

```typescript
    // 上下文水位检查 + 压缩（设计 §4.2「上下文水位检查」+「压缩」段）
    if (opts.contextPolicy && opts.compactEngine && compactCount < 3) {
      const action = opts.contextPolicy.decide(
        activeSlot.provider.modelId,
        opts.contextPolicy.estimateTokens(effectiveHistory),  // ← 基于 effectiveHistory，不是 raw history
      );
      if (action === 'compact') {
        try {
          const newMarker = await opts.compactEngine.summarize(history, opts.sessionId, activeSlot.provider);
          if (newMarker) {
            compactCount++;
            yield { kind: 'compacted', markerId: newMarker.id, summary: newMarker.summary.slice(0, 200) };
            turn--; // 压缩轮不消耗 turn 额度
            continue; // 重新取 history + effectiveHistory（含新 marker，水位下降）
          }
          // summarize 返回 undefined（不足 3 个真正用户回合）：
          //  不发 compacted 事件、不 turn--、不 continue——直接落到下面的 req 构建，
          //  用现有 effectiveHistory 继续流式请求。
          //  关键：绝不能因 undefined 而 continue 重试，否则 history 不变 → 水位不变 →
          //  再次 compact → 再次 undefined → 死循环。落下去发请求才是正路。
        } catch {
          // 压缩失败（provider 抛错）不杀对话：跳过本次压缩，继续流式请求
        }
      }
    }
```

7. 构建 `req`（复用上方已合成的 `effectiveHistory`，不重复计算 marker / effectiveHistory）并应用工具过滤：

```typescript
    const allToolDefs = opts.tools.definitions();
    const toolDefs = opts.excludedToolNames ? allToolDefs.filter(t => !opts.excludedToolNames!.has(t.name)) : allToolDefs;
    const req: StreamRequest = {
      messages: pairToolResults(effectiveHistory),
      systemPrompt: opts.systemPrompt, tools: toolDefs, maxTokens, thinkingLevel,
    };
```

8. 在 tool_result 落库前（`const resultMsg = store.appendMessage(...)` 之前）插入卸载逻辑。找到现有的 `for (const { c, outcome } of results) { ... resultParts.push(...) }` 块，改为：

```typescript
    const resultParts: ContentPart[] = [];
    for (const { c, outcome } of results) {
      // 卸载：大工具结果落库前替换为桩（设计 §4.2「大工具结果卸载」）
      let outputToStore = outcome.output;
      if (opts.offloadEngine && opts.offloadEngine.shouldOffload(outcome.output)) {
        const { stub, relativePath } = opts.offloadEngine.offload(opts.sessionId, c.toolUseId, outcome.output);
        yield { kind: 'offloaded', toolUseId: c.toolUseId, relativePath };
        outputToStore = stub;
      }
      // toolEnd 事件广播替换前完整 output（UI 可见）；落库的是 outputToStore（可能是桩）
      yield { kind: 'toolEnd', toolUseId: c.toolUseId, success: outcome.success, output: outcome.output };
      resultParts.push({ type: 'toolResult', value: { toolUseId: c.toolUseId, output: outputToStore, success: outcome.success, status: outcome.success ? 'success' : 'failed' } });
    }
```

注意：原代码里 `toolEnd` 事件在 `for` 循环内 yield，需要删掉原来的 `yield { kind: 'toolEnd', ... }` 行（被上方新逻辑替代）。

- [x] **Step 3d: 修改 index.ts**

`deskminis/src/minisd/index.ts`：

1. 顶部 import 增加：

```typescript
import { MemoryStore } from './store/memory-store';
import { MemoryInjector } from './store/memory-injector';
import { memoryWriteTool, memoryGetTool, MEMORY_TOOL_NAMES } from './tools/memory';
import { ContextPolicy } from './agent/context-policy';
import { OffloadEngine } from './agent/offload';
import { CompactEngine } from './agent/compact';
```

2. 在 `const tools = new ToolRegistry(); ... tools.register(makeShellTool(shells));` 之后注册记忆工具 + 创建引擎：

```typescript
  tools.register(memoryWriteTool); tools.register(memoryGetTool);

  // 记忆 + 压缩 + 卸载 引擎（设计 §3.4 + §4.2）
  const memoryStore = new MemoryStore(paths.globalDir('memory'));
  const memoryInjector = new MemoryInjector(memoryStore);
  const contextPolicy = new ContextPolicy(catalog);
  const offloadEngine = new OffloadEngine(paths);
  const compactEngine = new CompactEngine(chat);
```

3. 在 `chat.prompt` 方法体内，链式解析 provider 之后、构建 `systemPrompt` 时注入记忆 + 工具过滤。找到 `chat.appendMessage({ id: chat.newId(), sessionId, role: 'user', ... })` 之前，把 `systemPrompt: SYSTEM_PROMPT` 改为注入后的版本：

```typescript
      // 记忆注入（设计 §3.4：每轮系统提示注入 GLOBAL/SOUL/日志）
      const session = chat.getSession(sessionId);
      const injectedPrompt = memoryInjector.build(SYSTEM_PROMPT, { memoryEnabled: session?.memoryEnabled ?? true });
      // 工具过滤：memory_enabled=false 时排除记忆工具
      const excludedToolNames = (session?.memoryEnabled ?? true) ? undefined : new Set<string>(MEMORY_TOOL_NAMES);
```

4. 在 `runAgentLoop` 调用处传入新参数：

```typescript
        for await (const event of runAgentLoop(chat, {
            sessionId, provider, tools,
            toolContext: { sessionId, paths, permissions: gateway },
            systemPrompt: injectedPrompt, thinkingLevel: clampedThinking,
            signal: controller.signal,
            fallbackChain,
            contextPolicy, compactEngine, offloadEngine, excludedToolNames,
          })) {
```

5. 在 `chat.sessions.setModelBinding` 之后追加 `chat.sessions.setMemoryEnabled` RPC：

```typescript
    'chat.sessions.setMemoryEnabled': (p: { sessionId: string; enabled: boolean }) => {
      const sessionId = assertSessionId(p.sessionId);
      chat.setMemoryEnabled(sessionId, p.enabled);
      return { ok: true };
    },
```

- [x] **Step 4: 跑测试确认通过 + 全量不回归**

Run: `cd deskminis && npm test -- tests/agent-loop.test.ts tests/rpc.test.ts`
Expected: PASS（agent-loop 新增 4 个用例 + rpc 新增 2 个用例 + 既有用例全部通过）

Run: `cd deskminis && npm test`
Expected: 全部通过（Task 1-6 新增测试 + M2b 189 个测试不回归——`RunOptions` 新字段全部可选，`SessionMeta.memoryEnabled` 可选，M2b 既有调用不传新参数行为不变）

- [x] **Step 5: Commit**

```bash
cd "<repo>" && git add deskminis/src/minisd/agent/loop.ts deskminis/src/minisd/index.ts deskminis/src/minisd/store/chat-store.ts deskminis/src/shared/types.ts deskminis/tests/agent-loop.test.ts deskminis/tests/rpc.test.ts && git commit -m "feat(m2a): Agent 循环装配压缩/卸载/记忆（水位检查触发压缩 + 大结果卸载落桩 + memory_enabled 开关 + effectiveAgentHistory 合成）"
```

---

## M2a 完成定义

- 自动化全绿（`npm test`）：M1+M2b 既有 189 个测试 + M2a 新增 memory-store（~13）/ memory-injector（~8）/ memory-tools（~11）/ context-policy（~9）/ offload（~6）/ compact（~8）/ chat-store 扩充（~4）/ agent-loop 扩充（~4）/ rpc 扩充（~2），合计 ~65 个新用例，总数约 254（相对基线估算）
- 端到端手工验收 5 步全过：
  1. 在 `%APPDATA%\DeskMinis\memory\GLOBAL.md` 写入用户偏好 → 新建会话对话 → 模型回复体现该偏好（系统提示已注入）
  2. 对话中调用 `memory_write` 写一条记忆 → 查看 `YYYY-MM-DD.md` 确认条目前插 → 调用 `memory_get` 按关键词检索到该条
  3. 关闭某会话 `memory_enabled`（RPC `chat.sessions.setMemoryEnabled`）→ 该会话的 `memory_write`/`memory_get` 不在工具 schema 中（模型无法调用）+ 系统提示不注入记忆
  4. 构造大工具输出（`shell_execute` 跑 `dir /s` 之类）→ 工具结果 >20k 字符 → `offloads/` 下出现文件 + 历史里 tool_result 是桩 + UI 上 toolEnd 仍显示完整输出
  5. 长对话累积到上下文水位阈值 → 观察 `compacted` 事件出现 + `compact_markers` 表有记录 + 后续请求的 `effectiveAgentHistory` 含 `[对话摘要]` + 存储历史未被改写（`chat.messages.list` 仍完整）
- 交付物：MemoryStore（文件 CRUD）、MemoryInjector（系统提示注入）、memory_write/memory_get 工具（评分检索）、ContextPolicy（水位分层决策）、OffloadEngine（大结果卸载落桩）、CompactEngine（LLM 摘要 + effectiveAgentHistory 合成 + 锚点自愈）、Agent 循环装配（压缩/卸载/记忆开关接入现状降级链循环）、`chat.sessions.setMemoryEnabled` RPC 面
- 下一步：M2 其余子系统（M2c 技能系统、M2d 右栏 UI、M2e windows-* 桥）；记忆文件管理 UI、压缩进度展示组件属 M2d
