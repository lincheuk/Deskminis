/**
 * F09 引擎的属主轮询：主进程没了而引擎还活着时，引擎自己有序关停。
 *
 * 为什么要它：主进程被强杀之后引擎是否随之退出没有保证（docs/RELEASE.md 一直把它列为待人工确认）。不退的话引擎还握着
 * 数据根锁，它起的 shell、终端、MCP 也都留着。属主不在了，就走与主进程请求关停完全相同的那条路（由调用方接到
 * closeThenExit）：了结权限卡、停 run、回收子进程树、封账、关库、放锁。
 *
 * 只按「这个 PID 上还有没有进程」判断，不结束任何进程。PID 被复用时会误判成「还在」，后果只是退回没有这项轮询时的行为。
 */

export const PARENT_WATCH_MS = 1_000;
export const PARENT_GONE_STREAK = 3;

/** process.kill(pid, 0) 不抛、或抛 EPERM（在，但无权发信号）算在；只有 ESRCH 算不在。别的错误当作在（一次查询失败不算）。 */
function defaultIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException)?.code !== 'ESRCH'; }
}

/**
 * 每 intervalMs 查一次属主是否还在；连续 PARENT_GONE_STREAK 次不在才调一次 onGone 并停表。定时器 unref。
 * ppid 不是正整数时什么都不做。
 */
export function watchParent(o: { ppid: number; onGone: () => void; intervalMs?: number; isAlive?: (pid: number) => boolean }): { stop(): void } {
  if (!Number.isSafeInteger(o.ppid) || o.ppid <= 0) return { stop: () => undefined };
  const isAlive = o.isAlive ?? defaultIsAlive;
  let misses = 0;
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    let alive = true;
    try { alive = isAlive(o.ppid); } catch { alive = true; }
    misses = alive ? 0 : misses + 1;
    if (misses < PARENT_GONE_STREAK) return;
    stopped = true;
    clearInterval(timer);
    try { o.onGone(); } catch { /* 关停那条路自己兜错 */ }
  }, o.intervalMs ?? PARENT_WATCH_MS);
  timer.unref?.();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}

const MUTED = Symbol.for('deskminis.proc.mutedStdio');

/**
 * 给每个流挂一个吞掉错误的 'error' 监听（同一个流只挂一次）。缺省是 process.stdout 与 process.stderr。
 * 引擎的这两条流是接到主进程的管道：主进程没了之后管道已断，没有监听的话，一次直接写（握手行、崩溃钩子的提示）
 * 冒出来的 EPIPE 就是未捕获异常，引擎会在有序关停的半路上以 1 退出——不封账、不关库，还多一条崩溃记录。
 * 主进程在的时候这两条管道不会出错；它没了之后引擎的日志本来也没人收。
 */
export function muteBrokenStdio(streams?: readonly Pick<NodeJS.EventEmitter, 'on'>[]): void {
  for (const s of streams ?? [process.stdout, process.stderr]) {
    const tagged = s as unknown as Record<symbol, unknown>;
    if (tagged[MUTED] === true) continue;
    try {
      s.on('error', () => { /* 管道已断：日志写不出去，不让它变成未捕获异常 */ });
      tagged[MUTED] = true;
    } catch { /* 挂不上就算了 */ }
  }
}
