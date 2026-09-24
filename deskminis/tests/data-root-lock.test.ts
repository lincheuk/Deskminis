/** W1b-3（侦察 lifecycle.md W1b-single；止血设计稿 §3 第 9 条）：minisd 的数据根锁。
 *
 *  为什么要这把锁：同一个数据根起第二个 minisd 时，桥命名管道只让第二个降级、端口被占就退回随机端口，
 *  第二个能完整起来，和第一个同写一个 minis.db、互相覆盖 minisd-port.json（报告 §4 A 组第 7 条）。
 *  Electron 的单实例锁按 userData 算，dev 与正式版、或手动用 DESKMINIS_DATA_DIR 指到同一个根时它挡不住，
 *  所以 minisd 自己在打开库之前还要再拿一把按数据根算的锁。
 *
 *  锁是 <dataRoot>/minisd.lock（名字取 paths.ts 的常量，与 dataGate 的硬拒表同一份），内容 {pid, acquiredAt, ownerToken}。
 *  判「被占」：锁里的 pid 存活——kill(pid, 0) 成功、报 EPERM，或者就是本进程。
 *  陈旧锁（pid 已不存在、空文件、坏内容）经 minisd.lock.recovery 接管闸接管；释放只删 ownerToken 相同的锁，可重复调用。
 *  思路借自 ZCode 的 runtime/lock.ts（来源与改动登记在仓库根 THIRD-PARTY-NOTICES.md 的 ZCode 表）。 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DataRootLock, DataRootLockedError, acquireDataRootLock,
} from '../src/minisd/store/data-root-lock';
import { DATA_ROOT_LOCK_NAME, DATA_ROOT_LOCK_RECOVERY_NAME } from '../src/minisd/paths';
import { toMinisdFatal, reportStartupFailure } from '../src/minisd/fatal';
import { parseMinisdFatal } from '../src/main/minisd-fatal';
import { stripComments } from './strip-comments';

const dirs: string[] = [];
const children: ChildProcess[] = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'dm-lock-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const c of children.splice(0)) { try { c.kill('SIGKILL'); } catch { /* 已退出 */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const lockPathOf = (root: string): string => join(root, DATA_ROOT_LOCK_NAME);
const gatePathOf = (root: string): string => join(root, DATA_ROOT_LOCK_RECOVERY_NAME);
const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
const errOf = (fn: () => unknown): unknown => { try { fn(); } catch (e) { return e; } return undefined; };

/** 一个已经退出的进程号：起一个空脚本等它跑完。npm test 在 ELECTRON_RUN_AS_NODE 下跑，execPath 是 electron，env 里带着这个变量。 */
function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', ''], { env: process.env });
  expect(r.status, '探针子进程应正常退出').toBe(0);
  expect(typeof r.pid === 'number' && r.pid > 0).toBe(true);
  return r.pid as number;
}
/** 一个还活着的别的进程（测完由 afterEach 杀掉）。 */
async function livePid(): Promise<{ pid: number; child: ChildProcess }> {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { env: process.env, stdio: 'ignore' });
  children.push(child);
  await new Promise<void>((res, rej) => { child.once('spawn', () => res()); child.once('error', rej); });
  return { pid: child.pid as number, child };
}
const record = (pid: number, token = 'someone-else'): string =>
  JSON.stringify({ pid, acquiredAt: Date.now() - 60_000, ownerToken: token }) + '\n';
const eperm = (): never => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
const esrch = (): never => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); };

describe('获取：独占创建，内容带 pid / acquiredAt / ownerToken', () => {
  it('锁文件就是 <root>/minisd.lock（paths.ts 的常量），内容是本进程的 pid 与一个 ownerToken', () => {
    const root = tmpRoot();
    const lock = acquireDataRootLock(root);
    expect(lock).toBeInstanceOf(DataRootLock);
    expect(lock.path).toBe(lockPathOf(root));
    expect(lock.recoveryPath).toBe(gatePathOf(root));
    const rec = readJson(lockPathOf(root));
    expect(rec.pid).toBe(process.pid);
    expect(typeof rec.acquiredAt).toBe('number');
    expect(typeof rec.ownerToken === 'string' && (rec.ownerToken as string).length >= 16).toBe(true);
    expect(lock.held).toBe(true);
    // 0o600：锁里有 ownerToken，别的用户不必看见。Windows 上 mode 只剩只读位，不查
    if (process.platform !== 'win32') expect(statSync(lockPathOf(root)).mode & 0o777).toBe(0o600);
    // 接管闸只在接管陈旧锁时短暂存在，正常获取不留任何多余文件
    expect(readdirSync(root).sort()).toEqual([DATA_ROOT_LOCK_NAME]);
  });

  it('(a) 同一个根连续获取两次、第一把不释放：pid 是本进程也算存活，第二次抛 DATA_ROOT_LOCKED 并带 pid 与数据根', () => {
    const root = tmpRoot();
    acquireDataRootLock(root);
    const before = readFileSync(lockPathOf(root), 'utf8');
    const e = errOf(() => acquireDataRootLock(root));
    expect(e).toBeInstanceOf(DataRootLockedError);
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({ code: 'DATA_ROOT_LOCKED', pid: process.pid, dataRoot: root, name: 'DataRootLockedError' });
    expect(String((e as Error).message)).toMatch(/数据目录/);
    expect(readFileSync(lockPathOf(root), 'utf8'), '被拒的一方不得动别人的锁').toBe(before);
  });

  it('锁在另一个活着的进程手里：抛 DATA_ROOT_LOCKED，pid 是那个进程，锁文件一个字节不动', async () => {
    const root = tmpRoot();
    const { pid } = await livePid();
    writeFileSync(lockPathOf(root), record(pid));
    const before = readFileSync(lockPathOf(root), 'utf8');
    const e = errOf(() => acquireDataRootLock(root));
    expect(e).toMatchObject({ code: 'DATA_ROOT_LOCKED', pid, dataRoot: root });
    expect(readFileSync(lockPathOf(root), 'utf8')).toBe(before);
    expect(existsSync(gatePathOf(root)), '拒绝时不留接管闸').toBe(false);
  });

  it('锁里的 pid 就是本进程：不探活也算存活（同一进程里第二次 startMinisd 同样要被拒）', () => {
    const root = tmpRoot();
    writeFileSync(lockPathOf(root), record(process.pid));
    // 注入一个「谁都说不在」的探活：本进程这条规则不能依赖它
    const e = errOf(() => new DataRootLock(root, { kill: esrch }).acquire());
    expect(e).toMatchObject({ code: 'DATA_ROOT_LOCKED', pid: process.pid });
  });

  it('探活报 EPERM（进程在、只是没权限探它）算存活，照样拒绝', () => {
    const root = tmpRoot();
    writeFileSync(lockPathOf(root), record(424242));
    const e = errOf(() => new DataRootLock(root, { kill: eperm }).acquire());
    expect(e).toMatchObject({ code: 'DATA_ROOT_LOCKED', pid: 424242 });
  });
});

describe('接管陈旧锁', () => {
  it('(b) 锁里的 pid 已退出：获取成功，锁里的 pid 换成本进程，ownerToken 换新', () => {
    const root = tmpRoot();
    const dead = deadPid();
    writeFileSync(lockPathOf(root), record(dead, 'old-token'));
    const lock = acquireDataRootLock(root);
    const rec = readJson(lockPathOf(root));
    expect(rec.pid).toBe(process.pid);
    expect(rec.ownerToken).not.toBe('old-token');
    expect(lock.held).toBe(true);
    expect(readdirSync(root).sort(), '接管闸与隔离文件都不留下').toEqual([DATA_ROOT_LOCK_NAME]);
  });

  it('探活报 ESRCH 的 pid 算陈旧，照样接管', () => {
    const root = tmpRoot();
    writeFileSync(lockPathOf(root), record(424242));
    new DataRootLock(root, { kill: esrch }).acquire();
    expect(readJson(lockPathOf(root)).pid).toBe(process.pid);
  });

  it.each([
    ['空文件', ''],
    ['坏 JSON', '{"pid": 12'],
    ['pid 不是正整数', JSON.stringify({ pid: 0, ownerToken: 'x' })],
    ['pid 是字符串', JSON.stringify({ pid: '123', ownerToken: 'x' })],
    ['JSON 不是对象', '[1,2,3]'],
  ])('(c) %s 的锁能被接管', (_what, content) => {
    const root = tmpRoot();
    writeFileSync(lockPathOf(root), content);
    const lock = acquireDataRootLock(root);
    expect(lock.held).toBe(true);
    expect(readJson(lockPathOf(root)).pid).toBe(process.pid);
    expect(readdirSync(root).sort()).toEqual([DATA_ROOT_LOCK_NAME]);
  });

  it('空锁在等待期间被写进一个活着的持有者：不接管，按被占拒绝（防止把别人刚建、还没写进内容的锁当陈旧锁删掉）', async () => {
    const root = tmpRoot();
    const { pid } = await livePid();
    writeFileSync(lockPathOf(root), '');
    let wrote = false;
    // 注入的小睡：第一次睡的时候模拟「另一个进程 open('wx') 之后才写进内容」
    const sleep = (): void => { if (!wrote) { wrote = true; writeFileSync(lockPathOf(root), record(pid, 'fresh')); } };
    const e = errOf(() => new DataRootLock(root, { sleep }).acquire());
    expect(wrote, '读到空锁时必须先等一下再读').toBe(true);
    expect(e).toMatchObject({ code: 'DATA_ROOT_LOCKED', pid });
    expect(readJson(lockPathOf(root)).ownerToken, '别人的新锁必须原样留着').toBe('fresh');
  });

  it('接管途中锁已被别人换成新的：隔离出来一看不是刚才读到的那份，原样改回去，按被占拒绝', () => {
    const root = tmpRoot();
    writeFileSync(lockPathOf(root), record(111, 'stale'));
    const newcomer = record(777, 'newcomer');
    let staleProbes = 0;
    // 探活是「读到锁之后、改名隔离之前」的最后一步：第二次探 111（已在接管闸里）时，模拟另一个进程抢先换上了新锁
    const kill = (pid: number): void => {
      if (pid === 777) return;
      if (++staleProbes === 2) writeFileSync(lockPathOf(root), newcomer);
      esrch();
    };
    const e = errOf(() => new DataRootLock(root, { kill, sleep: () => {} }).acquire());
    expect(staleProbes).toBe(2);
    expect(e).toMatchObject({ code: 'DATA_ROOT_LOCKED', pid: 777 });
    expect(readFileSync(lockPathOf(root), 'utf8'), '别人的新锁必须原样留着').toBe(newcomer);
    expect(readdirSync(root).sort(), '隔离文件改回去了，接管闸也放了').toEqual([DATA_ROOT_LOCK_NAME]);
  });

  it('上一次接管中途崩溃留下的陈旧接管闸：清掉它，照常接管陈旧锁', () => {
    const root = tmpRoot();
    const dead = deadPid();
    writeFileSync(lockPathOf(root), record(dead));
    writeFileSync(gatePathOf(root), record(dead, 'gate-old'));
    acquireDataRootLock(root);
    expect(readJson(lockPathOf(root)).pid).toBe(process.pid);
    expect(readdirSync(root).sort()).toEqual([DATA_ROOT_LOCK_NAME]);
  });

  it('接管闸在另一个活着的进程手里（它正在接管）：等过一轮仍拿不到就按被占拒绝，带那个进程的 pid，闸与锁都不动', async () => {
    const root = tmpRoot();
    const { pid } = await livePid();
    const dead = deadPid();
    writeFileSync(lockPathOf(root), record(dead));
    writeFileSync(gatePathOf(root), record(pid, 'gate-live'));
    const lockBefore = readFileSync(lockPathOf(root), 'utf8');
    const gateBefore = readFileSync(gatePathOf(root), 'utf8');
    let naps = 0;
    const e = errOf(() => new DataRootLock(root, { sleep: () => { naps++; } }).acquire());
    expect(naps, '拿不到闸时要等一等再试，不能一次就放弃').toBeGreaterThan(1);
    expect(e).toMatchObject({ code: 'DATA_ROOT_LOCKED', pid, dataRoot: root });
    expect(readFileSync(lockPathOf(root), 'utf8')).toBe(lockBefore);
    expect(readFileSync(gatePathOf(root), 'utf8')).toBe(gateBefore);
  });
});

describe('释放', () => {
  it('release 删掉自己的锁；再调一次什么都不做、不抛；之后同一个根能再次获取（close 后重启同一个根）', () => {
    const root = tmpRoot();
    const lock = acquireDataRootLock(root);
    lock.release();
    expect(existsSync(lockPathOf(root))).toBe(false);
    expect(lock.held).toBe(false);
    expect(() => lock.release()).not.toThrow();
    const again = acquireDataRootLock(root);
    expect(again.held).toBe(true);
    again.release();
    expect(readdirSync(root)).toEqual([]);
  });

  it('(d) release 只删 ownerToken 相同的锁：锁已换了主人（别人接管后新建的），原样留着', () => {
    const root = tmpRoot();
    const lock = acquireDataRootLock(root);
    const theirs = record(process.pid, 'their-token');
    writeFileSync(lockPathOf(root), theirs);
    lock.release();
    expect(readFileSync(lockPathOf(root), 'utf8')).toBe(theirs);
    expect(readdirSync(root).sort(), '也不留隔离文件').toEqual([DATA_ROOT_LOCK_NAME]);
  });

  it('release 从不抛错：锁文件已经不在了也一样（它在出错释放与 close 的最后一步，抛了会盖掉原始错误）', () => {
    const root = tmpRoot();
    const lock = acquireDataRootLock(root);
    rmSync(lockPathOf(root));
    expect(() => lock.release()).not.toThrow();
    expect(lock.held).toBe(false);
  });
});

describe('inspect', () => {
  it('missing / active / stale / invalid', () => {
    const root = tmpRoot();
    const probe = new DataRootLock(root);
    expect(probe.inspect()).toEqual({ state: 'missing' });
    const lock = acquireDataRootLock(root);
    expect(probe.inspect()).toEqual({ state: 'active', pid: process.pid });
    lock.release();
    const dead = deadPid();
    writeFileSync(lockPathOf(root), record(dead));
    expect(probe.inspect()).toEqual({ state: 'stale', pid: dead });
    writeFileSync(lockPathOf(root), 'garbage');
    expect(probe.inspect()).toEqual({ state: 'invalid' });
  });
});

describe('DataRootLockedError 走 W1a-8 的致命行通道', () => {
  it('toMinisdFatal 从错误对象带出 {code, pid, dataRoot}（错误自带的数据根优先于调用方给的）', () => {
    const e = new DataRootLockedError(4242, '/data/root');
    expect(toMinisdFatal(e, '/fallback')).toEqual({ code: 'DATA_ROOT_LOCKED', pid: 4242, dataRoot: '/data/root' });
  });

  it('reportStartupFailure 往 stdout 写恰一行致命行，主进程 parseMinisdFatal 能原样解析回来', () => {
    const root = tmpRoot();
    acquireDataRootLock(root);
    const e = errOf(() => acquireDataRootLock(root));
    const stdout: string[] = [];
    const cbs: Array<() => void> = [];
    let exited: number | undefined;
    reportStartupFailure(e, '/fallback', {
      stdout: { write: (s, cb) => { stdout.push(s); cbs.push(cb); return true; } },
      stderr: { write: (_s, cb) => { cbs.push(cb); return true; } },
      exit: (code) => { exited = code; },
      later: (fn) => { fn(); },
    });
    for (const cb of cbs.splice(0)) cb();
    expect(stdout).toHaveLength(1);
    expect(parseMinisdFatal(stdout[0].trimEnd())).toEqual({ code: 'DATA_ROOT_LOCKED', pid: process.pid, dataRoot: root });
    expect(exited).toBe(1);
  });
});

describe('源码守卫（先去注释，认调用形态）', () => {
  const src = stripComments(readFileSync(join(__dirname, '..', 'src/minisd/store/data-root-lock.ts'), 'utf8').replace(/\r\n/g, '\n'));

  it('锁名只取 paths.ts 的常量，不另写一份字面量（锁改名而硬拒表没跟上，agent 就能删改锁）', () => {
    expect(src).toMatch(/import \{[^}]*\bDATA_ROOT_LOCK_NAME\b[^}]*\} from '\.\.\/paths'/);
    expect(src).toMatch(/import \{[^}]*\bDATA_ROOT_LOCK_RECOVERY_NAME\b[^}]*\} from '\.\.\/paths'/);
    expect(src).toMatch(/join\(\s*dataRoot\s*,\s*DATA_ROOT_LOCK_NAME\s*\)/);
    expect(src).toMatch(/join\(\s*dataRoot\s*,\s*DATA_ROOT_LOCK_RECOVERY_NAME\s*\)/);
    expect(src).not.toMatch(/['"`]minisd\.lock/);
  });

  it('没有绕过开关：锁模块不读任何环境变量（设计稿 §2「e2e 脚本不留锁绕过开关」）', () => {
    expect(src).not.toMatch(/process\.env/);
  });

  it('独占创建用 openSync(…, \'wx\', 0o600)', () => {
    expect(src).toMatch(/openSync\(\s*\w+\s*,\s*'wx'\s*,\s*0o600\s*\)/);
  });
});
