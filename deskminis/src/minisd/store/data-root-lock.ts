/* 部分改编自 ZCode（https://github.com/zai-org/ZCode）
 *   上游：packages/zcode-server-cli/src/runtime/lock.ts @ 29628c9
 *   许可：Apache-2.0，Copyright 2026 Z.AI Co., Ltd（全文同仓库根 LICENSE，另见 THIRD-PARTY-NOTICES.md）
 *   本文件已修改：改为同步 API；锁名取 paths.ts 的常量；被占时抛带 code / pid / dataRoot 的 DataRootLockedError；
 *   写完即关文件句柄；读到空文件或坏内容时在接管闸内等一小段再读，内容没变才接管；释放从不抛错；探活与小睡可注入。 */

/**
 * minisd 的数据根锁（W1b-3 · 止血设计稿 §3 第 9 条；侦察 lifecycle.md「W1b-single」）。
 *
 * 为什么要它：同一个数据根上起第二个 minisd 时，桥命名管道只让第二个降级、端口被占就退回随机端口，
 * 第二个能完整起来，和第一个同写一个 minis.db，还把 minisd-port.json 改成自己的端口与 token。
 * Electron 的单实例锁按 userData 算，挡不住「dev 与正式版被手动指向同一个根」、e2e 脚本另起 minisd 这类情况，
 * 所以 minisd 在打开库之前按数据根再拿一把锁。
 *
 * 做法：
 * - 获取：open(<root>/minisd.lock, 'wx', 0o600) 独占创建，写入 {pid, acquiredAt, ownerToken}。
 * - 已存在：锁里的 pid 存活（kill(pid, 0) 成功、报 EPERM，或者就是本进程）→ 抛 DataRootLockedError；
 *   pid 已不存在、空文件、坏内容 → 经接管闸 minisd.lock.recovery 接管：先把陈旧锁改名隔离，核对隔离出来的内容
 *   正是刚才读到的那份才删，不是就改回去（慢一步的进程不会删掉别人刚建的新锁）。
 * - 释放：只删 ownerToken 与自己相同的锁；从不抛错，可重复调用（close 与装配失败两条路径都会调）。
 *
 * 为什么是同步的：startMinisd 在 mkdir 之后、openDb 之前拿锁，拿不到要当场抛出，后面的装配一步都不做；
 * 同步实现也免得同一进程里两次 startMinisd 在 await 之间交错。等待只发生在争用时（每次 5ms，最多 100 次）。
 *
 * 已知边界（设计稿 §2 落定「pid 复用风险本版接受」）：Windows 会复用进程号，陈旧锁里的 pid 恰好被别的进程占着时
 * 会被误判为存活，启动被拒；对话框写明锁文件路径。W6a 再用本根的桥命名管道探活作第二判据。
 */
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_ROOT_LOCK_NAME, DATA_ROOT_LOCK_RECOVERY_NAME } from '../paths';

/** 数据根被另一个活着的 DeskMinis 占着。code / pid / dataRoot 三个字段由 src/minisd/fatal.ts 的 toMinisdFatal 挑出来，
 *  写成致命行交给主进程弹「DeskMinis 已在运行」；message 只进日志。pid 一定是正整数（只从校验过的锁内容里来）。 */
export class DataRootLockedError extends Error {
  readonly code = 'DATA_ROOT_LOCKED' as const;
  constructor(readonly pid: number, readonly dataRoot: string) {
    super(`数据目录 ${dataRoot} 正被另一个 DeskMinis（进程 ${pid}）使用，本次没有打开它`);
    this.name = 'DataRootLockedError';
  }
}

export type DataRootLockInspection =
  | { state: 'missing' }
  | { state: 'active'; pid: number }
  | { state: 'stale'; pid: number }
  | { state: 'invalid' }
  | { state: 'unreadable'; error: unknown };

export interface DataRootLockOptions {
  /** 探活，默认 process.kill(pid, 0)。测试注入 EPERM / ESRCH。 */
  kill?: (pid: number, signal: 0) => void;
  /** 同步小睡，默认 Atomics.wait。测试注入：不真睡，或在「等待期间」改写锁文件。 */
  sleep?: (ms: number) => void;
}

/** 争用时的重试：每次 5ms，最多 100 次（约半秒）。与上游一致。 */
const RETRY_MS = 5;
const MAX_ATTEMPTS = 100;
/** 读到空文件或坏内容时先等这么久再读一次，内容没变才当陈旧锁接管。
 *  为什么：独占创建与写入内容是两步，另一个进程刚 open('wx') 还没写进内容时，锁看起来就是空文件；
 *  这时接管会删掉它的锁，两边都以为自己拿到了。真正崩在这两步之间留下的空锁，等 50ms 内容也不会变。 */
const INVALID_SETTLE_MS = 50;

interface LockRecord { pid?: number; ownerToken?: string }
interface Observed { raw: string; record: LockRecord }

const errCode = (e: unknown): unknown => (typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined);

const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

function parseRecord(raw: string): LockRecord {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const o = parsed as { pid?: unknown; ownerToken?: unknown };
  return {
    pid: typeof o.pid === 'number' && Number.isInteger(o.pid) && o.pid > 0 ? o.pid : undefined,
    ownerToken: typeof o.ownerToken === 'string' ? o.ownerToken : undefined,
  };
}

/** 读锁文件；读不到（不存在、是目录、没权限）返回 null。 */
function readObserved(path: string): Observed | null {
  let raw: string;
  try { raw = readFileSync(path, 'utf8'); } catch { return null; }
  return { raw, record: parseRecord(raw) };
}

export class DataRootLock {
  readonly path: string;
  readonly recoveryPath: string;
  private ownerToken: string | undefined;
  private readonly kill: (pid: number, signal: 0) => void;
  private readonly sleep: (ms: number) => void;

  constructor(readonly dataRoot: string, opts: DataRootLockOptions = {}) {
    this.path = join(dataRoot, DATA_ROOT_LOCK_NAME);
    this.recoveryPath = join(dataRoot, DATA_ROOT_LOCK_RECOVERY_NAME);
    this.kill = opts.kill ?? ((pid, signal) => { process.kill(pid, signal); });
    this.sleep = opts.sleep ?? sleepSync;
  }

  /** 这个对象当前是否持有锁（acquire 成功、还没 release）。 */
  get held(): boolean { return this.ownerToken !== undefined; }

  inspect(): DataRootLockInspection {
    let raw: string;
    try { raw = readFileSync(this.path, 'utf8'); } catch (e) {
      return errCode(e) === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable', error: e };
    }
    const { pid } = parseRecord(raw);
    if (pid === undefined) return { state: 'invalid' };
    return this.isHolderAlive(pid) ? { state: 'active', pid } : { state: 'stale', pid };
  }

  /** 拿锁；被活着的进程占着就抛 DataRootLockedError。数据根目录由调用方先建好。 */
  acquire(): void {
    if (this.tryCreate(this.path)) return;
    let gateHolder: number | undefined;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const observed = readObserved(this.path);
      if (observed && this.isHolderAlive(observed.record.pid)) {
        throw new DataRootLockedError(observed.record.pid as number, this.dataRoot);
      }
      const gate = this.tryAcquireGate();
      if (gate.token === undefined) {
        // 另一个进程正拿着接管闸（它也在接管这把陈旧锁），等一等再看：多半下一轮就看到它的新锁了
        if (gate.holder !== undefined) gateHolder = gate.holder;
        this.sleep(RETRY_MS);
        continue;
      }
      try {
        const current = readObserved(this.path);
        if (current && this.isHolderAlive(current.record.pid)) {
          throw new DataRootLockedError(current.record.pid as number, this.dataRoot);
        }
        if (current && current.record.pid === undefined) {
          this.sleep(INVALID_SETTLE_MS);
          // 内容变了：是别的进程刚写进去的，回到循环开头按新内容重新判断
          if (readObserved(this.path)?.raw !== current.raw) continue;
        }
        if (current) this.claimStale(this.path, current.raw);
        if (this.tryCreate(this.path)) return;
      } finally {
        this.releaseOwned(this.recoveryPath, gate.token);
      }
      this.sleep(RETRY_MS);
    }
    // 一直拿不到接管闸：闸在一个活着的进程手里，它就是正在占用（或正在接管）这个数据根的实例
    if (gateHolder !== undefined) throw new DataRootLockedError(gateHolder, this.dataRoot);
    throw new Error(`数据目录锁 ${this.path} 反复争用失败，没能拿到`);
  }

  /** 释放自己的锁；锁已换了主人或已不在时什么都不做。从不抛错，可重复调用：
   *  它在装配失败的 catch 里（抛了会盖掉原始错误）和 close() 的最后一步（抛了 close 就 reject）。 */
  release(): void {
    const token = this.ownerToken;
    this.ownerToken = undefined;
    if (token !== undefined) this.releaseOwned(this.path, token);
  }

  isHolderAlive(pid: number | undefined): boolean {
    if (pid === undefined) return false;
    if (pid === process.pid) return true;
    try {
      this.kill(pid, 0);
      return true;
    } catch (e) {
      // ESRCH：进程不在了（陈旧）；EPERM：进程在、只是无权探它，保守当存活
      return errCode(e) === 'EPERM';
    }
  }

  /** 独占创建并写入 {pid, acquiredAt, ownerToken}；已存在返回 false。写完即关句柄：锁靠文件存在与内容，不靠句柄。 */
  private tryCreate(path: string): boolean {
    const token = randomUUID();
    if (!this.createOwned(path, token)) return false;
    this.ownerToken = token;
    return true;
  }

  private createOwned(path: string, token: string): boolean {
    let fd: number;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (e) {
      if (errCode(e) === 'EEXIST') return false;
      throw e;
    }
    try {
      writeSync(fd, `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now(), ownerToken: token })}\n`);
    } catch (e) {
      try { closeSync(fd); } catch { /* 关不掉也要把写入错误抛出去 */ }
      // 内容没写全：只在确认还是自己那份时删；删不掉就留着，它会被当成坏内容由下一次接管
      this.releaseOwned(path, token);
      throw e;
    }
    closeSync(fd);
    return true;
  }

  /** 拿接管闸。拿不到时：闸的主人活着就报出它的 pid；闸是陈旧的（上一次接管中途崩溃）就清掉它，本轮仍算没拿到。 */
  private tryAcquireGate(): { token?: string; holder?: number } {
    const token = randomUUID();
    if (this.createOwned(this.recoveryPath, token)) return { token };
    const observed = readObserved(this.recoveryPath);
    if (observed && this.isHolderAlive(observed.record.pid)) return { holder: observed.record.pid };
    if (observed) this.claimStale(this.recoveryPath, observed.raw);
    return {};
  }

  /** 接管陈旧文件：先改名隔离，核对隔离出来的正是刚才读到的那份才删；不是（别人抢先换成了新锁）就改回去。 */
  private claimStale(path: string, expectedRaw: string): void {
    const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`;
    try {
      renameSync(path, quarantine);
    } catch (e) {
      if (errCode(e) === 'ENOENT') return;
      throw e;
    }
    let claimed: string | null;
    try { claimed = readFileSync(quarantine, 'utf8'); } catch { claimed = null; }
    if (claimed === expectedRaw) {
      rmSync(quarantine, { force: true });
      return;
    }
    try { renameSync(quarantine, path); } catch { /* 改不回去就留着隔离文件，别删别人的锁 */ }
  }

  /** 删自己名下的文件（锁或接管闸）：ownerToken 对得上才删，同样先隔离再核对。任何失败都吞掉。 */
  private releaseOwned(path: string, token: string): void {
    try {
      if (readObserved(path)?.record.ownerToken !== token) return;
      const quarantine = `${path}.release-${process.pid}-${randomUUID()}`;
      try { renameSync(path, quarantine); } catch { return; }
      if (readObserved(quarantine)?.record.ownerToken === token) {
        rmSync(quarantine, { force: true });
        return;
      }
      try { renameSync(quarantine, path); } catch { /* 同上 */ }
    } catch { /* 释放从不抛错：留下的锁会在本进程退出后被当成陈旧锁接管 */ }
  }
}

/** 建一把数据根锁并立即获取；被占时抛 DataRootLockedError。 */
export function acquireDataRootLock(dataRoot: string, opts?: DataRootLockOptions): DataRootLock {
  const lock = new DataRootLock(dataRoot, opts);
  lock.acquire();
  return lock;
}
