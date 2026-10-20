/**
 * F08 G 组：源码守卫。防的是「以后改着改着绕开了」：写入绕开入口、恢复直接写回、借版本库命令处理用户目录、
 * 文案宣称 shell / MCP 可撤销、没有检查点也原地覆盖、为了测试在产品里留降低容量下限的开关。
 * 一律去注释后再匹配（注释里留着旧写法不算数）。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHECKPOINTED_TOOLS, CHECKPOINT_SCOPE_NOTE } from '../src/shared/checkpoint';
import { fileEditTool, fileReadTool, fileWriteTool } from '../src/minisd/tools/files';
import { memoryGetTool, memoryWriteTool } from '../src/minisd/tools/memory';
import { officeReadTool, officeWriteTool } from '../src/minisd/tools/office';
import { closeAllCpEnvs, cpEnv } from './checkpoint-fixture';
import { stripComments } from './strip-comments';
import { expectSame, callMark, onCall } from './engine-trace';
import { watchEngine, type EngineWatch } from './engine-wiring';
import { startCapturedEngine, probeConnection, type CapturedEngine } from './engine-assembly';
import type { StartMinisdOpts } from '../src/minisd/index';

afterEach(() => { closeAllCpEnvs(); });

const qEngines: CapturedEngine[] = [];

const qSavedFake = process.env.DESKMINIS_FAKE_PROVIDER;

afterEach(async () => {
  for (const e of qEngines.splice(0).reverse()) await e.close();
  vi.restoreAllMocks();
  if (qSavedFake === undefined) delete process.env.DESKMINIS_FAKE_PROVIDER;
  else process.env.DESKMINIS_FAKE_PROVIDER = qSavedFake;
});

async function qStart(opts: StartMinisdOpts = {}): Promise<CapturedEngine> {
  process.env.DESKMINIS_FAKE_PROVIDER = '1';
  const e = await startCapturedEngine(opts);
  qEngines.push(e);
  return e;
}

async function qRpc(e: CapturedEngine, name: string, p: any = {}, conn = probeConnection('local')): Promise<any> {
  return await e.methods[name](p, conn);
}

function qObserved(w: EngineWatch, name: string, owner: unknown, args: unknown[], invoke: () => unknown): unknown {
  const from = callMark();
  const result = invoke();
  expect(w.count(name, from)).toBe(1);
  expect(w.args(name)).toEqual(args);
  for (const [i, arg] of args.entries()) expectSame(w.args(name)[i], arg);
  expectSame(w.spy(name).mock.contexts.at(-1), owner);
  expect(result).toBe(w.spy(name).mock.results.at(-1)?.value);
  return result;
}

async function qUntil(what: string, ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('等待超时: ' + what);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

type QCheckpointKeys = { [K in keyof StartMinisdOpts]: Lowercase<K> extends `${string}checkpoint${string}` | `${string}quota${string}` ? K : never }[keyof StartMinisdOpts];

type QCheckpointShape = [Exclude<QCheckpointKeys, undefined>] extends ['checkpointIo'] ? ['checkpointIo'] extends [Exclude<QCheckpointKeys, undefined>] ? true : never : never;

const SRC = join(__dirname, '..', 'src');
const raw = (...p: string[]): string => readFileSync(join(SRC, ...p), 'utf8');
const code = (...p: string[]): string => stripComments(raw(...p));
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out); else out.push(full);
  }
  return out;
}
const CP_FILES = ['fs.ts', 'commit.ts', 'store.ts', 'restore.ts', 'rpc.ts'];

describe('F08 G 组：源码守卫', () => {
  it('G1 files.ts / office.ts 不直接写盘：没有 writeFileSync / renameSync / mkdirSync / appendFileSync，各自经 commitFileWrite 落盘', () => {
    for (const f of ['files.ts', 'office.ts']) {
      const c = code('minisd', 'tools', f);
      for (const banned of ['writeFileSync(', 'renameSync(', 'mkdirSync(', 'appendFileSync(', 'copyFileSync(', 'createWriteStream(', 'writeFile(']) {
        expect(c.includes(banned), `${f} 里出现了 ${banned}`).toBe(false);
      }
      expect(c).toContain('commitFileWrite(');
    }
    expect((code('minisd', 'tools', 'files.ts').match(/commitFileWrite\(/g) ?? [])).toHaveLength(2);
    expect((code('minisd', 'tools', 'office.ts').match(/commitFileWrite\(/g) ?? [])).toHaveLength(1);
  });

  it('G2 写本地文件的内置工具恰好是 CHECKPOINTED_TOOLS 加显式豁免的 memory_write；三个工具各真实调用一次后都有 applied 行', async () => {
    const tools = [fileReadTool, fileWriteTool, fileEditTool, officeReadTool, officeWriteTool, memoryWriteTool, memoryGetTool];
    const localFiles = tools.filter(t => t.scheduling?.sideEffects === 'local-files').map(t => t.definition.name).sort();
    expect(localFiles).toEqual([...CHECKPOINTED_TOOLS, 'memory_write'].sort());
    // 整个引擎源码里声明「写本地文件」的地方只有这四处：别处新增一个写工具，这里就红，提醒它接入口或列为豁免
    const declared = walk(join(SRC, 'minisd')).filter(f => f.endsWith('.ts'))
      .map(f => (stripComments(readFileSync(f, 'utf8')).match(/sideEffects:\s*'local-files'/g) ?? []).length).reduce((a, b) => a + b, 0);
    expect(declared).toBe(4);
    // 豁免要在范围说明里点名
    expect(CHECKPOINT_SCOPE_NOTE).toContain('记忆写入');

    const env = cpEnv('g2'); const sid = env.newSession();
    writeFileSync(join(env.userDir, 'e.txt'), 'alpha');
    const a = await env.runTool(sid, 'file_write', { path: join(env.userDir, 'w.txt'), content: 'x' });
    const b = await env.runTool(sid, 'file_edit', { path: join(env.userDir, 'e.txt'), old_string: 'alpha', new_string: 'beta' });
    const c = await env.runTool(sid, 'office_write', { path: join(env.userDir, 'o.docx'), content: JSON.stringify({ blocks: [{ kind: 'para', text: 'x' }] }) });
    expect([a.row?.state, b.row?.state, c.row?.state]).toEqual(['applied', 'applied', 'applied']);
    expect(env.rows().map(r => r.tool_name)).toEqual(['file_write', 'file_edit', 'office_write']);
  });

  it('G3 index.ts：起跑时的 toolContext 带 checkpoints: checkpointStore；new CheckpointStore( 只出现一次且在 recoverOnBoot( 之前', async () => {
    // 启动只建一份检查点，在恢复之前完成对账。
    const w = watchEngine();
    const e = await qStart();
    const store = w.made('new CheckpointStore');
    expect(w.count('new CheckpointStore')).toBe(1);
    expect(w.seq(['new CheckpointStore', 'checkpoints.reconcile', 'recoverOnBoot'])).toEqual(['new CheckpointStore', 'checkpoints.reconcile', 'recoverOnBoot']);
    // 真起一轮运行，循环拿到的toolContext是这份store。
    const { id } = await qRpc(e, 'chat.sessions.create');
    await qRpc(e, 'chat.prompt', { sessionId: id, providerId: '__fake__', text: 'Q20A CHECKPOINT' });
    await qUntil('实际循环已被调用', () => w.count('runAgentLoop') === 1);
    expect(w.args('runAgentLoop')[0]).toBe(w.made('new ChatStore'));
    expectSame(w.args('runAgentLoop')[1].toolContext.checkpoints, store);
    // 真交给恢复的证据回调问同一store的effectEvidence，包括非检查点边界工具。
    const callback = w.args('recoverOnBoot')[0].effectEvidence;
    for (const row of [{ id: 'Q20A-NO-EXEC', name: 'file_write', epoch: w.made('new RunLedger').epoch }, { id: '', name: 'shell_execute', epoch: 0 }]) {
      qObserved(w, 'checkpoints.effectEvidence', store, [row], () => callback(row));
    }
  }, 60000);

  it('G4 checkpoints/ 不起子进程、不借版本库：没有 child_process、spawn / exec 调用，源码里没有 git 这个词', () => {
    const files = readdirSync(join(SRC, 'minisd', 'checkpoints'));
    expect(files.sort()).toEqual([...CP_FILES].sort());
    for (const f of files) {
      const text = raw('minisd', 'checkpoints', f);
      expect(text.includes('child_process'), f).toBe(false);
      expect(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/.test(text), f).toBe(false);
      expect(/\bgit\b/i.test(text), `${f} 里出现了 git`).toBe(false);
      expect(/process\.env/.test(text), `${f} 里读了环境变量`).toBe(false);
    }
  });

  it('G5 restore.ts：对目标文件的写入只有 replaceExisting( 与 io.unlink( 两种，且都在 beginRestore 之后；没有直接改名、原地覆盖、写文件；放锁在 finally 里；没有强制参数', () => {
    const c = code('minisd', 'checkpoints', 'restore.ts');
    for (const banned of ['io.rename(', 'overwriteInPlace(', 'writeFileSync(', 'renameSync(', 'unlinkSync(', 'rmSync(']) {
      expect(c.includes(banned), `restore.ts 里出现了 ${banned}`).toBe(false);
    }
    const begin = c.indexOf('this.store.beginRestore(');
    expect(begin).toBeGreaterThan(0);
    // import 行里是「replaceExisting,」不带括号：带括号的只有调用
    const replaces = [...c.matchAll(/\breplaceExisting\(/g)].map(m => m.index as number);
    const unlinks = [...c.matchAll(/\bio\.unlink\(/g)].map(m => m.index as number);
    expect(replaces).toHaveLength(1);
    expect(replaces[0]).toBeGreaterThan(begin);
    expect(unlinks).toHaveLength(1);
    expect(unlinks[0]).toBeGreaterThan(begin);
    expect(c.match(/this\.store\.beginRestore\(/g) ?? []).toHaveLength(1);
    // 放锁：唯一的一处 lock.release() 在 finally 块里
    expect(c.match(/lock\.release\(\)/g) ?? []).toHaveLength(1);
    expect(/finally\s*\{[^{}]*lock\.release\(\);[^{}]*\}/.test(c)).toBe(true);
    for (const f of ['restore.ts', 'rpc.ts']) {
      const t = code('minisd', 'checkpoints', f);
      expect(/\b(?:force|overwrite)\s*\??\s*:/.test(t), `${f} 里有名为 force / overwrite 的参数或字段`).toBe(false);
      expect(/\bforce\b/i.test(t), `${f} 里出现了 force`).toBe(false);
    }
  });

  it('G6 文案：提到 shell 或 MCP 的句子必同时说「不」；渲染端不出现「全部撤销」「撤销所有」「一键还原」', () => {
    const sentences = (text: string): string[] => text.split(/[。；\n]/).filter(s => /shell|MCP/i.test(s));
    const scope = sentences(CHECKPOINT_SCOPE_NOTE);
    expect(scope.length).toBeGreaterThan(0);
    for (const s of scope) expect(s.includes('不'), s).toBe(true);
    // shared/checkpoint.ts 里所有带 shell / MCP 的字符串字面量
    const lits = [...code('shared', 'checkpoint.ts').matchAll(/'([^'\n]*)'|`([^`]*)`/g)].map(m => m[1] ?? m[2]).filter(s => /shell|MCP/i.test(s));
    for (const lit of lits) for (const s of sentences(lit)) expect(s.includes('不'), s).toBe(true);
    const renderer = walk(join(SRC, 'renderer')).filter(f => /\.(vue|ts)$/.test(f));
    for (const f of renderer) {
      const text = readFileSync(f, 'utf8');
      for (const banned of ['全部撤销', '撤销所有', '一键还原']) expect(text.includes(banned), `${f} 里出现了「${banned}」`).toBe(false);
    }
    // 四个新组件：模板与脚本里带 shell / MCP 的句子同样必须说「不」
    for (const name of ['ChangeListView.vue', 'ChangeList.vue', 'ChangeReviewView.vue', 'ChangeReview.vue']) {
      const p = join(SRC, 'renderer', 'src', 'ui', name);
      expect(existsSync(p), `${name} 应当存在`).toBe(true);
      for (const s of sentences(readFileSync(p, 'utf8').replace(/<[^>]+>/g, '\n'))) {
        if (/[一-龥]/.test(s)) expect(s.includes('不'), `${name}: ${s}`).toBe(true);
      }
    }
  });

  it('G7 run-recovery.ts 仍引不到任何执行入口，也不引检查点模块（事实以函数形式注入）', () => {
    const c = code('minisd', 'agent', 'run-recovery.ts');
    const imports = [...c.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
    for (const bad of ['registry', 'scheduler', '/tools/', 'checkpoints', '/mcp/']) {
      expect(imports.filter(i => i.includes(bad)), `run-recovery.ts 引了 ${bad}`).toEqual([]);
    }
    expect(c).toContain('deps.effectEvidence?.(');
  });

  it('G8 原地覆盖只发生在 replaceExisting 里；commit.ts 只在检查点已持久时允许回落（allowInPlace 的实参是 cp !== undefined）', () => {
    const hits: string[] = [];
    for (const f of walk(SRC).filter(x => /\.(ts|vue)$/.test(x))) {
      const n = (stripComments(readFileSync(f, 'utf8')).match(/\boverwriteInPlace\(/g) ?? []).length;
      if (n > 0) hits.push(`${f.slice(SRC.length + 1).replace(/\\/g, '/')}:${n}`);
    }
    // fs.ts 里恰好三处：接口声明、nodeFileIo 的实现、replaceExisting 里唯一的调用
    expect(hits).toEqual(['minisd/checkpoints/fs.ts:3']);
    const fsCode = code('minisd', 'checkpoints', 'fs.ts');
    const fn = fsCode.slice(fsCode.indexOf('export function replaceExisting('));
    expect(fn.match(/io\.overwriteInPlace\(/g) ?? []).toHaveLength(1);
    expect(fsCode.match(/io\.overwriteInPlace\(/g) ?? []).toHaveLength(1);
    // 回落之前先改名、再复核签名
    expect(fn.indexOf('io.rename(')).toBeLessThan(fn.indexOf('io.overwriteInPlace('));
    expect(fn.indexOf('sameSig(')).toBeLessThan(fn.indexOf('io.overwriteInPlace('));
    const commit = code('minisd', 'checkpoints', 'commit.ts');
    expect(commit.match(/allowInPlace:/g) ?? []).toHaveLength(1);
    expect(commit).toMatch(/allowInPlace:\s*cp !== undefined\b/);
  });

  it('G9 StartMinisdOpts 里与检查点有关的字段只有 checkpointIo；没有读环境变量来改容量或下限的代码', () => {
    // 声明可搬到任意minisd模块，必须全树恰好一份。
    const declarations = walk(join(SRC, 'minisd')).filter(f => f.endsWith('.ts')).flatMap(f => {
      const c = stripComments(readFileSync(f, 'utf8'));
      return [...c.matchAll(/\btype\s+StartMinisdOpts\s*=\s*\{/g)].map(m => c.slice(m.index!, c.indexOf('};', m.index!)));
    });
    expect(declarations).toHaveLength(1);
    const body = declarations[0];
    const shape: QCheckpointShape = true;
    expect(shape).toBe(true);
    expect((body.match(/\b\w*[Cc]heckpoint\w*\??:/g) ?? []).map(s => s.replace(/\??:$/, ''))).toEqual(['checkpointIo']);
    expect(/quota/i.test(body)).toBe(false);
    for (const f of walk(SRC).filter(x => /\.ts$/.test(x))) {
      const t = stripComments(readFileSync(f, 'utf8'));
      expect(/process\.env\.[A-Z_]*(?:CHECKPOINT|QUOTA)/.test(t), f).toBe(false);
    }
    expect(/process\.env/.test(code('shared', 'checkpoint.ts'))).toBe(false);
  });
});
