/**
 * F08 K 组（真实强杀）：K3、K4、K7 各在真实子进程上重做一遍。
 *
 * 子进程（tests/checkpoint-crash-child.ts）在同一数据根上建真实的库与存储，做一次真实的写入或恢复；走到指定注入点时
 * 向 stdout 打一行标记后永久阻塞。父进程读到标记（事件，不是定时猜）后按 PID 强杀它，再在自己进程里开库、开下一代、对账。
 * 只动自己起的进程；临时目录用完即删。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointStore } from '../src/minisd/checkpoints/store';
import { openDb } from '../src/minisd/store/db';
import { RunLedger } from '../src/minisd/store/run-ledger';
import { killTree } from './run-ledger-fixture';

const appRoot = join(__dirname, '..');
const VITE_NODE = join(appRoot, 'node_modules', 'vite-node', 'vite-node.mjs');
const ORIGINAL = 'original bytes before the crash\n';
const NEXT = 'bytes the agent wanted to write\n';
/** 等子进程走到注入点的上限：vite-node 冷启动加上机器上别的工作流的负载，留足。到点没等到就带着子进程的输出失败。 */
const MARK_WAIT_MS = 120_000;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) { try { await f(); } catch { /* 收尾尽力 */ } } });

interface Crashed { root: string; target: string; userDir: string; lines: string[] }

/** 起子进程，等它在 point 处打出标记，强杀，等它退出。 */
async function crashAt(point: string, mode: 'write' | 'restore'): Promise<Crashed> {
  const root = mkdtempSync(join(tmpdir(), 'dm-f08-kp-root-'));
  const userDir = mkdtempSync(join(tmpdir(), 'dm-f08-kp-user-'));
  cleanups.push(() => { for (const d of [root, userDir]) rmSync(d, { recursive: true, force: true }); });
  const target = join(userDir, 'target.txt');
  writeFileSync(target, ORIGINAL);
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', F08_ROOT: root, F08_TARGET: target, F08_POINT: point, F08_MODE: mode, F08_CONTENT: NEXT };
  const child: ChildProcess = spawn(process.execPath, [VITE_NODE, 'tests/checkpoint-crash-child.ts'], { cwd: appRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(res => { child.on('exit', (code, signal) => res({ code, signal })); });
  const proc = { child, pid: child.pid as number, exited };
  cleanups.push(() => killTree(proc));
  let out = ''; let err = '';
  child.stderr!.setEncoding('utf8'); child.stderr!.on('data', (d: string) => { err += d; });
  child.stdout!.setEncoding('utf8');
  const marker = `F08-CRASH-POINT ${point}`;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`子进程 ${MARK_WAIT_MS}ms 内没有走到 ${point}\n--- stdout ---\n${out}\n--- stderr ---\n${err.slice(-3000)}`)), MARK_WAIT_MS);
    const check = (): void => {
      if (out.includes(marker)) { clearTimeout(timer); resolve(); }
      else if (out.includes('F08-UNEXPECTED')) { clearTimeout(timer); reject(new Error(`子进程没有停在 ${point}：${out}`)); }
    };
    child.stdout!.on('data', (d: string) => { out += d; check(); });
    void exited.then(x => { clearTimeout(timer); reject(new Error(`子进程在走到 ${point} 之前退出（code=${x.code}）\n${out}\n${err.slice(-3000)}`)); });
  });
  await killTree(proc);
  return { root, target, userDir, lines: out.split(/\r?\n/).filter(l => l !== '') };
}

/** 父进程里开下一代：开库、新账本、新存储。 */
function nextGen(root: string) {
  const db = openDb(join(root, 'minis.db'));
  cleanups.push(() => { db.close(); });
  const ledger = new RunLedger(db, { warn: () => undefined });
  const store = new CheckpointStore(db, join(root, 'checkpoints'), { commit: fn => ledger.durableAtomic(fn), tx: fn => ledger.atomic(fn), warn: () => undefined });
  return { db, ledger, store, rows: (): any[] => db.prepare('SELECT * FROM file_checkpoints ORDER BY seq').all() };
}
const dmFiles = (dir: string): string[] => readdirSync(dir).filter(n => n.startsWith('.dm-'));

describe('F08 K 组：真实强杀后的对账', () => {
  it('K3（真实进程）替换之前被杀：下一代看到 pending，对账成 aborted；目标是旧内容，临时文件被清', async () => {
    const c = await crashAt('after-tmp', 'write');
    expect(readFileSync(c.target, 'utf8')).toBe(ORIGINAL);
    expect(dmFiles(c.userDir)).toHaveLength(1);                    // 被杀那一刻临时文件已写好
    const g = nextGen(c.root);
    expect(g.ledger.epoch).toBe(2);
    expect(g.rows().map(r => r.state)).toEqual(['pending']);        // 记录先于任何目标 IO 持久
    expect(existsSync(join(c.root, 'checkpoints', 'blobs', g.rows()[0].before_hash.slice(0, 2), g.rows()[0].before_hash))).toBe(true);
    expect(g.store.reconcile()).toHaveLength(1);
    expect(g.rows()[0]).toMatchObject({ state: 'aborted', abort_reason: 'interrupted', tmp_path: null });
    expect(readFileSync(c.target, 'utf8')).toBe(ORIGINAL);
    expect(dmFiles(c.userDir)).toEqual([]);
  }, 180_000);

  it('K4（真实进程）替换之后、记 applied 之前被杀：对账成 applied；目标是新内容；随后的内容文件就是原始字节', async () => {
    const c = await crashAt('after-replace', 'write');
    expect(readFileSync(c.target, 'utf8')).toBe(NEXT);
    const g = nextGen(c.root);
    expect(g.rows().map(r => r.state)).toEqual(['pending']);
    g.store.reconcile();
    const row = g.rows()[0];
    expect(row).toMatchObject({ state: 'applied', detail: 'reconciled' });
    expect(row.file_ino).not.toBeNull();
    expect(g.store.readBlob(row.before_blob).toString('utf8')).toBe(ORIGINAL);
    expect(dmFiles(c.userDir)).toEqual([]);
    // 对账第二遍零改动
    const once = JSON.stringify(g.rows());
    expect(g.store.reconcile()).toEqual([]);
    expect(JSON.stringify(g.rows())).toBe(once);
  }, 180_000);

  it('K7（真实进程）恢复在替换之后被杀：下一代看到「恢复中」，对账成 restored；目标是原字节，写入后的内容已存下', async () => {
    const c = await crashAt('restore-after-replace', 'restore');
    expect(c.lines.some(l => l.startsWith('F08-WRITTEN '))).toBe(true);
    expect(readFileSync(c.target, 'utf8')).toBe(ORIGINAL);
    const g = nextGen(c.root);
    expect(g.rows()[0].state).toBe('applied');
    expect(g.rows()[0].restoring_at).not.toBeNull();
    g.store.reconcile();
    const row = g.rows()[0];
    expect(row).toMatchObject({ state: 'restored', restoring_at: null, restore_tmp_path: null });
    expect(g.store.readBlob(row.after_blob).toString('utf8')).toBe(NEXT);
    expect(dmFiles(c.userDir)).toEqual([]);
  }, 180_000);
});
