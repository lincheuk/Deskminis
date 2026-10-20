/**
 * F08 真实进程崩溃用的子进程（不是测试；由 checkpoint-crash-process.test.ts 经 vite-node 在 Electron Node 模式下起）。
 *
 * 在给定的数据根上建真实的库、账本、检查点存储，对给定的目标文件做一次真实的写入（或先写入、再恢复）；
 * 走到指定的注入点时向 stdout 打一行标记，然后永久阻塞——父进程读到标记后按 PID 强杀，再在自己进程里开库对账。
 * 产品代码里没有任何崩溃钩子：停在哪一步只靠 FileIo.at 这一个注入缝。
 *
 * 环境变量：F08_ROOT 数据根；F08_TARGET 目标文件；F08_POINT 注入点；F08_MODE write | restore；F08_CONTENT 要写入的文本。
 */
import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { commitFileWrite } from '../src/minisd/checkpoints/commit';
import { nodeFileIo, type FileIo, type IoPoint } from '../src/minisd/checkpoints/fs';
import { CheckpointService } from '../src/minisd/checkpoints/restore';
import { CheckpointStore } from '../src/minisd/checkpoints/store';
import { MinisPaths } from '../src/minisd/paths';
import { ChatStore } from '../src/minisd/store/chat-store';
import { openDb } from '../src/minisd/store/db';
import { RunLedger } from '../src/minisd/store/run-ledger';
import { ResourceLockManager } from '../src/minisd/tools/resource-locks';

const need = (k: string): string => {
  const v = process.env[k];
  if (v === undefined || v === '') throw new Error(`缺少环境变量 ${k}`);
  return v;
};
const say = (line: string): void => { writeSync(1, `${line}\n`); };

async function main(): Promise<void> {
  const root = need('F08_ROOT'); const target = need('F08_TARGET');
  const point = need('F08_POINT') as IoPoint; const mode = need('F08_MODE');
  const content = need('F08_CONTENT');

  const db = openDb(join(root, 'minis.db'));
  const ledger = new RunLedger(db, { warn: () => undefined });
  const chat = new ChatStore(db);
  const paths = new MinisPaths(root);
  const sessionId = chat.createSession().id;
  paths.ensureSessionDirs(sessionId);
  const io: FileIo = {
    ...nodeFileIo,
    at(p) {
      if (p !== point) return;
      // 标记同步写出去之后永久阻塞：进程停在这一步，等父进程来杀
      say(`F08-CRASH-POINT ${p}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    },
  };
  const store = new CheckpointStore(db, join(root, 'checkpoints'), { commit: fn => ledger.durableAtomic(fn), tx: fn => ledger.atomic(fn), io, warn: () => undefined });
  store.markSinceEpoch(ledger.epoch);
  say(`F08-SESSION ${sessionId}`);

  const r = commitFileWrite({ sessionId, checkpoints: store }, { path: target, produce: () => Buffer.from(content, 'utf8') });
  if (mode === 'write') { say(`F08-UNEXPECTED write returned ${JSON.stringify(r)}`); return; }
  if (!r.ok || r.checkpointId === undefined) { say(`F08-UNEXPECTED write failed ${JSON.stringify(r)}`); return; }
  say(`F08-WRITTEN ${r.checkpointId}`);
  const service = new CheckpointService({
    store, paths, locks: new ResourceLockManager(), io, warn: () => undefined,
    isSessionRunning: () => false, isSessionDeleted: sid => chat.isDeleted(sid), uncoveredCalls: () => new Map(), runMeta: () => new Map(),
  });
  const rep = await service.restore(sessionId, [r.checkpointId]);
  say(`F08-UNEXPECTED restore returned ${JSON.stringify(rep)}`);
}

main().catch(e => { say(`F08-UNEXPECTED ${String(e)}`); process.exitCode = 1; });
