/**
 * 剪贴板跨文件/跨进程互斥锁（vitest 默认 fileParallelism: true 多 worker 并发）。
 * 系统剪贴板是全局资源：bridge-handlers.test.ts / bridge-cli.test.ts 各自有真剪贴板 set→get 往返，
 * 文件级并发时一方的 set 恰好落在另一方 set/get 之间会导致后者读到对方写入。
 *
 * 锁实现：固定目录 mkdirSync 原子抢锁；100ms 自旋；锁龄 > 30s 视为陈旧（崩溃/中断遗留）→ 强夺。
 * 不改动 vitest 全局并行度（fileParallelism/maxWorkers:1 之类全局串行化掩盖问题且拖慢全套件）。
 */
import { mkdtempSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOCK_DIR = join(tmpdir(), 'deskminis-test-clipboard.lock');
const STALE_MS = 30_000;
const SPIN_MS = 100;
const MAX_WAIT_MS = 60_000; // 总等待上限，极端情况下防止无限自旋

function lockCreatedAtMs(): number | undefined {
  try { return statSync(LOCK_DIR).birthtimeMs; } catch { return undefined; }
}

function tryAcquire(): boolean {
  try { mkdirSync(LOCK_DIR); return true; } catch { return false; }
}

function release(): void {
  try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* 已被强夺或路径不存在，忽略 */ }
}

export async function withClipboardLock<T>(fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  let acquired = false;
  // 自旋：mkdirSync 原子抢锁；若失败 → 若锁龄超 STALE_MS → 强夺 rmSync 后重抢 → 否则等 SPIN_MS 再试
  while (!acquired) {
    if (tryAcquire()) { acquired = true; break; }
    const age = lockCreatedAtMs();
    if (age !== undefined && Date.now() - age > STALE_MS) {
      // 陈旧锁：rmSync 后下一轮尝试（注意不保证本进程一定能抢到——也可能被其他进程同时抢，但谁抢到都比悬挂好）
      try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* 另一方先抢到 rm，忽略 */ }
      continue;
    }
    if (Date.now() - start > MAX_WAIT_MS) {
      // 总等待超时：强夺（避免全 suite 悬挂），但让 fn 正常跑——剪贴板内容坏了断言会报错提示，不会静默通过
      try { rmSync(LOCK_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
      acquired = tryAcquire();
      if (!acquired) {
        acquired = true; // 至少放行一次
      }
      break;
    }
    await new Promise<void>(r => setTimeout(r, SPIN_MS));
  }
  try { return await fn(); } finally { release(); }
}

// 未使用：占位，避免被 tree-shake 视为仅类型文件（vitest 无 esm interop 问题，保留确保可 import 函数）
export const _clipboardLockDir = LOCK_DIR;
void mkdtempSync; void existsSync;
