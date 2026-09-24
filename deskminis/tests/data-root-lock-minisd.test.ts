/** W1b-3（侦察 lifecycle.md W1b-single；cross.md S11）：startMinisd 真的按数据根加锁。
 *
 *  以前同一个根起第二个 minisd 能完整起来：端口被占就退回随机端口、桥命名管道只让第二个降级，
 *  两个进程同写一个 minis.db，第二个还把 minisd-port.json 改成自己的端口与 token。
 *  现在 startMinisd 在 mkdir 之后、打开库之前同步拿 <dataRoot>/minisd.lock：拿不到就以 DATA_ROOT_LOCKED 拒绝，
 *  什么都不碰；拿到之后装配任何一步失败都先释放再抛；close() 的最后一步释放，同一个根能 close 后重启（auto-sync.test.ts 依赖这一点）。
 *
 *  进程内跑（DESKMINIS_TEST=1 走 InMemoryVault，不碰真实凭据库）；pid 是本进程也算存活，所以同一进程里的第二个实例同样被拒。
 *  接线的源码守卫读 src/minisd/index.ts 前先去注释，只认代码里的调用形态。 */
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startMinisd } from '../src/minisd/index';
import { DataRootLockedError } from '../src/minisd/store/data-root-lock';
import { DATA_ROOT_LOCK_NAME } from '../src/minisd/paths';
import { stripComments } from './strip-comments';

beforeAll(() => {
  process.env.DESKMINIS_TEST = '1';
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
});

const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];
function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'dm-lock-minisd-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) { try { await c(); } catch { /* 已关 */ } }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Srv = Awaited<ReturnType<typeof startMinisd>>;
async function boot(dataDir: string): Promise<Srv> {
  const srv = await startMinisd({ dataDir, host: '127.0.0.1', port: 0 });
  let closed = false;
  const close = async (): Promise<void> => { if (closed) return; closed = true; await srv.close(); };
  closers.push(close);
  return { ...srv, close };
}
const rejectionOf = async (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

/** 连上去调一次 RPC，证明第一个实例还在正常服务。 */
async function rpcOk(port: number, token: string): Promise<boolean> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  const reply = await new Promise<{ result?: unknown }>((res) => {
    ws.on('message', (d) => {
      const msg = JSON.parse(String(d)) as { id?: number; result?: unknown };
      if (msg.id === 1) res(msg);
    });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'chat.sessions.list' }));
  });
  ws.close();
  return Array.isArray(reply.result);
}

describe('startMinisd 按数据根加锁', () => {
  it('同一个根的第二个 startMinisd 以 DATA_ROOT_LOCKED 拒绝（带 pid 与数据根），不碰端口文件，第一个照常服务', async () => {
    const root = tmpRoot();
    const first = await boot(root);
    const portFile = join(root, 'minisd-port.json');
    const portBefore = readFileSync(portFile, 'utf8');

    const e = await rejectionOf(startMinisd({ dataDir: root, host: '127.0.0.1', port: 0 }));
    expect(e, '第二个实例今天能完整起来，和第一个同写一个库').toBeInstanceOf(DataRootLockedError);
    expect(e).toMatchObject({ code: 'DATA_ROOT_LOCKED', pid: process.pid, dataRoot: root });

    expect(readFileSync(portFile, 'utf8'), '被拒的实例不得改写端口文件（里面是第一个实例的 token）').toBe(portBefore);
    expect(await rpcOk(first.port, first.authToken)).toBe(true);
  });

  it('close() 最后一步释放锁：锁文件消失，同一个根能再起（auto-sync 的 close 后重启）', async () => {
    const root = tmpRoot();
    const first = await boot(root);
    expect(existsSync(join(root, DATA_ROOT_LOCK_NAME))).toBe(true);
    await first.close();
    expect(existsSync(join(root, DATA_ROOT_LOCK_NAME)), 'close 之后锁必须已释放').toBe(false);
    const second = await boot(root);
    expect(await rpcOk(second.port, second.authToken)).toBe(true);
    const rec = JSON.parse(readFileSync(join(root, DATA_ROOT_LOCK_NAME), 'utf8')) as { pid: number };
    expect(rec.pid).toBe(process.pid);
  });

  it('拿锁之后装配失败（库来自更新版本）：先释放锁再抛原始错误；修好之后同一个根能起来', async () => {
    const root = tmpRoot();
    const raw = new Database(join(root, 'minis.db'));
    raw.pragma('user_version = 99');
    raw.close();
    const e = await rejectionOf(startMinisd({ dataDir: root, host: '127.0.0.1', port: 0 }));
    expect(e, '原始错误不能被释放锁的动作盖掉').toMatchObject({ code: 'DB_NEWER_THAN_APP' });
    expect(existsSync(join(root, DATA_ROOT_LOCK_NAME)), '装配失败时不释放，同一进程里这个根就永远打不开了').toBe(false);

    rmSync(join(root, 'minis.db'), { force: true });
    const ok = await boot(root);
    expect(await rpcOk(ok.port, ok.authToken)).toBe(true);
  });

  it('上次被强杀留下的陈旧锁（pid 已退出）：照常启动并接管', async () => {
    const root = tmpRoot();
    const probe = spawnSync(process.execPath, ['-e', ''], { env: process.env });
    const dead = probe.pid as number;
    writeFileSync(join(root, DATA_ROOT_LOCK_NAME), JSON.stringify({ pid: dead, acquiredAt: 1, ownerToken: 'old' }) + '\n');
    const srv = await boot(root);
    expect(await rpcOk(srv.port, srv.authToken)).toBe(true);
    const rec = JSON.parse(readFileSync(join(root, DATA_ROOT_LOCK_NAME), 'utf8')) as { pid: number; ownerToken: string };
    expect(rec.pid).toBe(process.pid);
    expect(rec.ownerToken).not.toBe('old');
  });
});

describe('接线（源码守卫：先去注释，认调用形态）', () => {
  const minisd = stripComments(readFileSync(join(__dirname, '..', 'src/minisd/index.ts'), 'utf8').replace(/\r\n/g, '\n'));

  /** 从 anchor 之后的第一个 `{` 起做括号配对，取出块体。 */
  function blockAfter(src: string, anchor: string, from = 0): string {
    const at = src.indexOf(anchor, from);
    expect(at, `源码里找不到锚点 ${anchor}`).toBeGreaterThanOrEqual(0);
    const open = src.indexOf('{', at + anchor.length - 1);
    let depth = 1; let i = open + 1;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    return src.slice(open + 1, i - 1);
  }

  it('startMinisd 是外壳：mkdir → 无条件拿锁 → try { return await assembleMinisd(root, lock, opts) } catch { lock.release(); throw }', () => {
    const body = blockAfter(minisd, 'export async function startMinisd(');
    const stmts = body.split('\n').map(l => l.trim()).filter(Boolean);
    const iMk = stmts.findIndex(l => /^mkdirSync\(\s*root\s*,\s*\{\s*recursive:\s*true\s*\}\s*\);$/.test(l));
    const iLock = stmts.findIndex(l => /^const lock = acquireDataRootLock\(\s*root\s*\);$/.test(l));
    expect(iMk, '外壳里要先建数据根').toBeGreaterThanOrEqual(0);
    expect(iLock, '拿锁必须是外壳里的一条独立语句（不包在任何 if 里：不留绕过开关）').toBeGreaterThan(iMk);
    expect(body).toMatch(/try \{\s*return await assembleMinisd\(\s*root\s*,\s*lock\s*,\s*opts\s*\);\s*\} catch \((\w+)\) \{\s*lock\.release\(\);\s*throw \1;\s*\}/);
    expect(body, '外壳不打开库：openDb 在 assembleMinisd 里、锁之后').not.toMatch(/openDb\(/);
    expect(minisd.match(/\bacquireDataRootLock\(/g) ?? [], '全文件只在外壳里拿一次锁').toHaveLength(1);
  });

  it('assembleMinisd 收下锁，不自己再建根或拿锁；openDb 仍在它的开头', () => {
    expect(minisd).toMatch(/async function assembleMinisd\(\s*root: string,\s*lock: DataRootLock,\s*opts\?: StartMinisdOpts\s*\)/);
    const body = blockAfter(minisd, 'async function assembleMinisd(');
    expect(body).not.toMatch(/mkdirSync\(\s*root\b/);
    expect(body).toMatch(/const db = openDb\(\s*join\(\s*root\s*,\s*'minis\.db'\s*\)\s*\);/);
  });

  // W1b-5 重指：close 改成幂等包装（close: (o) => (closed ??= shutdown(...))），关停步骤搬进 async function shutdown(；
  // 前面哪一步抛错都要关库、放锁，所以收尾是 try { db.close(); } finally { lock.release(); }。意图不变：放锁是最后一步，且在关库之后。
  it('close() 的最后一步是 lock.release()（在 db.close() 之后：库关了才让别人进来；前面抛错也照放）', () => {
    expect(minisd).toMatch(/close: \(o\?: \{ graceMs\?: number \}\) => \(closed \?\?= shutdown\(/);
    const body = blockAfter(minisd, 'async function shutdown(');
    const tail = body.replace(/[\s}]+$/, '');
    expect(tail.endsWith('try { db.close(); } finally { lock.release();')).toBe(true);
    expect(body.lastIndexOf('db.close()')).toBeGreaterThanOrEqual(0);
    expect(body.lastIndexOf('db.close()')).toBeLessThan(body.lastIndexOf('lock.release()'));
  });
});
