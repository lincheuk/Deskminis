/**
 * F08 C 组：写入事务入口（commitFileWrite）经真实工具、真实调度器与账本、真实检查点存储。
 * 断言以磁盘字节、文件 ID、库里的行为准。全部在临时目录上跑。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitFileWrite } from '../src/minisd/checkpoints/commit';
import { buildDocx, buildPptx, buildXlsx } from '../src/minisd/office/build';
import { parseOffice } from '../src/minisd/office/parse';
import { editUtf8Bytes } from '../src/minisd/tools/edit-text';
import { fileWriteTool } from '../src/minisd/tools/files';
import type { PermissionGateway } from '../src/minisd/tools/types';
import { canSymlink, closeAllCpEnvs, cpEnv, holdOpen, junction, recIo, sha, type CpEnv } from './checkpoint-fixture';

const WIN = process.platform === 'win32';
const temps: string[] = [];
afterEach(() => {
  closeAllCpEnvs();
  for (const d of temps.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 留给系统清 */ } }
});
const tmpDir = (label: string): string => { const d = mkdtempSync(join(tmpdir(), `dm-f08-c-${label}-`)); temps.push(d); return d; };
const noTemps = (dir: string): void => { expect(readdirSync(dir).filter(n => n.startsWith('.dm-'))).toEqual([]); };
const same = (a: ReturnType<CpEnv['snapshotOf']>, b: ReturnType<CpEnv['snapshotOf']>): boolean =>
  a !== undefined && b !== undefined && a.bytes.equals(b.bytes) && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.nlink === b.nlink;
const restore = async (env: CpEnv, sid: string, id: string) => (await env.service.restore(sid, [id])).items[0];
/** 目标目录下有没有任何写操作（recIo 记录）。 */
const writesUnder = (env: CpEnv, dir: string): string[] =>
  env.io.calls.filter(c => ['writeDurable', 'rename', 'linkExclusive', 'overwriteInPlace', 'mkdirp', 'unlink'].includes(c.op) && c.path.startsWith(dir)).map(c => c.op);

/** 可控的权限网关：询问挂着，由测试放行。 */
function heldGateway(): { gateway: PermissionGateway; asked: Promise<void>; allow(): void } {
  let onAsked!: () => void; let release!: () => void;
  const asked = new Promise<void>(r => { onAsked = r; });
  const go = new Promise<void>(r => { release = r; });
  return {
    asked, allow: () => release(),
    gateway: { async check() { onAsked(); await go; return 'allow'; }, hasBridgeGrant: () => false },
  };
}

describe('F08 C 组：写入事务', () => {
  it('C1 带 BOM、CRLF、混合行尾、末尾无换行的文本被 file_edit 修改再恢复：写入结果与独立算出的期望逐字节相同，恢复后与原始字节相等', async () => {
    const env = cpEnv('c1'); const sid = env.newSession();
    const f = join(env.userDir, 'mixed.txt');
    const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('第一行\r\n第二行 alpha\n第三行\r\n末行没有换行', 'utf8')]);
    writeFileSync(f, original);
    const expected = editUtf8Bytes(original, 'alpha', 'beta');
    expect(expected.ok).toBe(true);
    const r = await env.runTool(sid, 'file_edit', { path: f, old_string: 'alpha', new_string: 'beta' });
    expect(r.success, r.output).toBe(true);
    expect(r.output).toBe(`已编辑 ${f}`);
    if (expected.ok) expect(readFileSync(f).equals(Buffer.from(expected.text, 'utf8'))).toBe(true);
    expect(readFileSync(f).subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    expect((await restore(env, sid, r.row.id)).outcome).toBe('restored');
    expect(readFileSync(f).equals(original)).toBe(true);
    noTemps(env.userDir);
  });

  it('C2 GBK 字节与含 NUL 的 1 MiB 随机二进制被 file_write 覆盖再恢复：字节相等', async () => {
    const env = cpEnv('c2'); const sid = env.newSession();
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a, 0xb2, 0xe2, 0xca, 0xd4]);
    const bin = randomBytes(1024 * 1024); bin[10] = 0; bin[4096] = 0;
    for (const [name, original] of [['gbk.txt', gbk], ['blob.bin', bin]] as const) {
      const f = join(env.userDir, name);
      writeFileSync(f, original);
      const r = await env.runTool(sid, 'file_write', { path: f, content: '覆盖后的文本\n' });
      expect(r.success, r.output).toBe(true);
      expect(r.output).toBe(`已写入 ${f}`);
      expect(r.row).toMatchObject({ before_hash: sha(original), before_size: original.length, state: 'applied' });
      expect(readFileSync(env.blobPath(sha(original))).equals(original)).toBe(true);
      expect((await restore(env, sid, r.row.id)).outcome).toBe('restored');
      expect(readFileSync(f).equals(original)).toBe(true);
    }
  });

  it('C3 在不存在的两级目录下新建文件再恢复：行 before_exists=0、没有内容文件；恢复后文件不存在，目录还在', async () => {
    const env = cpEnv('c3'); const sid = env.newSession();
    const f = join(env.userDir, 'a', 'b', 'new.txt');
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'hello' });
    expect(r.success, r.output).toBe(true);
    expect(r.row).toMatchObject({ before_exists: 0, before_blob: null, before_hash: null, state: 'applied', after_hash: sha('hello') });
    expect(env.blobFiles()).toEqual([]);
    expect((await restore(env, sid, r.row.id)).outcome).toBe('deleted');
    expect(existsSync(f)).toBe(false);
    expect(lstatSync(join(env.userDir, 'a', 'b')).isDirectory()).toBe(true);
    expect(readdirSync(join(env.userDir, 'a', 'b'))).toEqual([]);
  });

  it('C4 现有 docx / xlsx / pptx 被 office_write 覆盖再恢复：恢复后字节与原文件相等，且能被解析', async () => {
    const env = cpEnv('c4'); const sid = env.newSession();
    const cases = [
      ['old.docx', buildDocx({ blocks: [{ kind: 'para', text: '原始文档' }] as never }), JSON.stringify({ blocks: [{ kind: 'para', text: '新文档' }] })],
      ['old.xlsx', buildXlsx({ sheets: [{ name: '表', rows: [['a', 1]] }] as never }), JSON.stringify({ sheets: [{ name: '新表', rows: [['b', 2]] }] })],
      ['old.pptx', buildPptx({ slides: [{ title: '原始', bullets: ['x'] }] as never }), JSON.stringify({ slides: [{ title: '新', bullets: ['y'] }] })],
    ] as const;
    for (const [name, original, content] of cases) {
      const f = join(env.userDir, name);
      writeFileSync(f, original);
      const r = await env.runTool(sid, 'office_write', { path: f, content });
      expect(r.success, r.output).toBe(true);
      expect(r.output.startsWith(`已生成 ${f}（`)).toBe(true);
      expect(r.row).toMatchObject({ tool_name: 'office_write', before_hash: sha(original), state: 'applied' });
      expect(readFileSync(f).equals(original)).toBe(false);
      expect((await restore(env, sid, r.row.id)).outcome).toBe('restored');
      expect(readFileSync(f).equals(original)).toBe(true);
      expect((await parseOffice(f, readFileSync(f))).kind).toBe(name.split('.')[1]);
    }
  });

  it('C5 写入与现有内容相同：没有新记录，文件 ID 与修改时间不变，目标目录零写入', async () => {
    const env = cpEnv('c5'); const sid = env.newSession();
    const f = join(env.userDir, 'same.txt');
    writeFileSync(f, 'unchanged\n');
    const before = env.snapshotOf(f);
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'unchanged\n' });
    expect(r.success).toBe(true);
    expect(r.output).toBe(`已写入 ${f}`);
    expect(env.rows()).toEqual([]);
    expect(same(before, env.snapshotOf(f))).toBe(true);
    expect(writesUnder(env, env.userDir)).toEqual([]);
  });

  it('C6 检查点盘满（检查点目录的写入报 ENOSPC）：工具失败、文案含「检查点」，目标一个字节不动，目标目录零写入，没有行，账本行 failed', async () => {
    const env = cpEnv('c6'); const sid = env.newSession();
    const f = join(env.userDir, 'keep.txt');
    writeFileSync(f, 'precious original\n');
    const before = env.snapshotOf(f);
    env.io.fail('writeDurable', p => p.startsWith(env.cpDir), 'ENOSPC');
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'overwrite' });
    expect(r.success).toBe(false);
    expect(r.output).toContain('检查点');
    expect(r.output).toContain('文件没有改动');
    expect(same(before, env.snapshotOf(f))).toBe(true);
    expect(writesUnder(env, env.userDir)).toEqual([]);
    expect(env.rows()).toEqual([]);
    expect(r.exec.state).toBe('failed');
    // 新建文件同样先要落一条记录；这里内容不需要空间，照常成功（只有覆盖才需要存原内容）
    const created = await env.runTool(sid, 'file_write', { path: join(env.userDir, 'fresh.txt'), content: 'x' });
    expect(created.success).toBe(true);
  });

  it('C7 记录提交失败（注入的 commit 抛错；另一条：账本已关停）：不写目标，没有行', async () => {
    const env = cpEnv('c7a', { store: { commit: () => { throw new Error('database or disk is full'); } } });
    const sid = env.newSession();
    const f = join(env.userDir, 'keep.txt');
    writeFileSync(f, 'original\n');
    const before = env.snapshotOf(f);
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'overwrite' });
    expect(r.success).toBe(false);
    expect(r.output).toContain('检查点');
    expect(same(before, env.snapshotOf(f))).toBe(true);
    expect(writesUnder(env, env.userDir)).toEqual([]);
    expect(env.rows()).toEqual([]);
    // 新建文件也一样：记录落不下就不建
    const g = join(env.userDir, 'sub', 'new.txt');
    expect((await env.runTool(sid, 'file_write', { path: g, content: 'x' })).success).toBe(false);
    expect(existsSync(join(env.userDir, 'sub'))).toBe(false);

    const env2 = cpEnv('c7b'); const sid2 = env2.newSession();
    const f2 = join(env2.userDir, 'keep.txt');
    writeFileSync(f2, 'original\n');
    const before2 = env2.snapshotOf(f2);
    env2.ledger.close();
    const out = await fileWriteTool.execute({ path: f2, content: 'late write', tool_title: 't' }, env2.ctx(sid2));
    expect(out.success).toBe(false);
    expect(out.output).toContain('检查点');
    expect(out.output).toContain('引擎正在关闭');
    expect(same(before2, env2.snapshotOf(f2))).toBe(true);
  });

  it('C8 容量全被活动 run 的记录占着：覆盖失败且说明空间已用满，文件不变，受保护的记录仍可恢复；同状态下新建成功', async () => {
    const env = cpEnv('c8', { store: { quotaBytes: () => 8 * 1024 } });
    const sAct = env.newSession(); const sid = env.newSession();
    const held = join(env.userDir, 'held.bin'); const heldBytes = Buffer.alloc(6 * 1024, 0x21);
    writeFileSync(held, heldBytes);
    const act = await env.runTool(sAct, 'file_write', { path: held, content: 'x' }, { keepRunActive: true });
    expect(act.success).toBe(true);
    const f = join(env.userDir, 'next.bin'); const original = Buffer.alloc(6 * 1024, 0x22);
    writeFileSync(f, original);
    const before = env.snapshotOf(f);
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'y' });
    expect(r.success).toBe(false);
    expect(r.output).toContain('空间已用满');
    expect(same(before, env.snapshotOf(f))).toBe(true);
    expect(env.rows(sAct)[0].pruned_at).toBeNull();
    expect((await env.runTool(sid, 'file_write', { path: join(env.userDir, 'brand-new.txt'), content: 'ok' })).success).toBe(true);
    act.handle.end({ state: 'completed', reason: 'end_turn' });
    expect((await restore(env, sAct, act.row.id)).outcome).toBe('restored');
    expect(readFileSync(held).equals(heldBytes)).toBe(true);
  });

  it('C9 写入前文件超过单文件上限（注入成 1 KiB）：失败并说明，文件不变，没有行', async () => {
    const env = cpEnv('c9', { store: { maxFileBytes: 1024 } }); const sid = env.newSession();
    const f = join(env.userDir, 'big.bin');
    writeFileSync(f, Buffer.alloc(2048, 7));
    const before = env.snapshotOf(f);
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'small' });
    expect(r.success).toBe(false);
    expect(r.output).toContain('超过可保存检查点的上限');
    expect(same(before, env.snapshotOf(f))).toBe(true);
    expect(env.rows()).toEqual([]);
    expect(writesUnder(env, env.userDir)).toEqual([]);
  });

  describe('C10 改名做不了时的各条分支', () => {
    const setup = (label: string) => {
      const env = cpEnv(label); const sid = env.newSession();
      const f = join(env.userDir, 'busy.txt'); const original = Buffer.from('original content, long enough to truncate\n');
      writeFileSync(f, original);
      return { env, sid, f, original, before: env.snapshotOf(f)! };
    };

    it('C10 改名一直报 EPERM、原地覆盖可行：工具成功，文件 ID 不变，行 applied / in-place，无临时文件；随后恢复得到原始字节', async () => {
      const { env, sid, f, original, before } = setup('c10');
      env.io.fail('rename', p => p === f, 'EPERM');
      const r = await env.runTool(sid, 'file_write', { path: f, content: 'new content' });
      expect(r.success, r.output).toBe(true);
      expect(readFileSync(f, 'utf8')).toBe('new content');
      expect(env.snapshotOf(f)!.ino).toBe(before.ino);
      expect(r.row).toMatchObject({ state: 'applied', detail: 'in-place', tmp_path: null });
      noTemps(env.userDir);
      expect((await restore(env, sid, r.row.id)).outcome).toBe('restored');   // 恢复时改名同样做不了：也走原地覆盖
      expect(readFileSync(f).equals(original)).toBe(true);
      expect(env.snapshotOf(f)!.ino).toBe(before.ino);
      noTemps(env.userDir);
    });

    it('C10a 对照：没有任何占用的正常覆盖——文件 ID 变了（改名替换），没有原地覆盖', async () => {
      const { env, sid, f, before } = setup('c10a');
      const r = await env.runTool(sid, 'file_write', { path: f, content: 'new content' });
      expect(r.success).toBe(true);
      expect(env.snapshotOf(f)!.ino).not.toBe(before.ino);
      expect(env.io.callsOf('overwriteInPlace')).toEqual([]);
      expect(r.row.detail).toBeNull();
    });

    it('C10b 改名报 EPERM、原地打开也报 EBUSY：失败且确认文件没有改动，无临时文件，行 aborted / write-failed', async () => {
      const { env, sid, f, before } = setup('c10b');
      env.io.fail('rename', p => p === f, 'EPERM');
      env.io.fail('overwriteInPlace', p => p === f, 'EBUSY');
      const r = await env.runTool(sid, 'file_write', { path: f, content: 'new content' });
      expect(r.success).toBe(false);
      expect(r.output).toContain('文件没有改动');
      expect(same(before, env.snapshotOf(f))).toBe(true);
      noTemps(env.userDir);
      expect(r.row).toMatchObject({ state: 'aborted', abort_reason: 'write-failed', before_blob: null });
    });

    it('C10c 原地覆盖中途失败（目标已被截成一半）：失败、文案含「另存」，行 unknown；另存得到原始字节；恢复得 unknown-state、文件不被再动', async () => {
      const { env, sid, f, original } = setup('c10c');
      env.io.fail('rename', p => p === f, 'EPERM');
      env.io.hook('before-inplace', () => writeFileSync(f, original.subarray(0, 10)));
      env.io.fail('overwriteInPlace', p => p === f, 'EIO');
      const r = await env.runTool(sid, 'file_write', { path: f, content: 'new content' });
      expect(r.success).toBe(false);
      expect(r.output).toContain('另存');
      expect(r.output).not.toContain('文件没有改动');
      expect(r.row.state).toBe('unknown');
      env.io.reset();
      const copy = env.service.saveCopy(sid, r.row.id, 'before');
      expect(readFileSync(copy.path).equals(original)).toBe(true);
      const half = env.snapshotOf(f);
      expect(await restore(env, sid, r.row.id)).toMatchObject({ outcome: 'unavailable', verdict: { reason: 'unknown-state' } });
      expect(same(half, env.snapshotOf(f))).toBe(true);
    });

    it('C10d 原地覆盖返回了但内容不对（少写一个字节）：行 unknown 而不是 applied；另存得到原始字节', async () => {
      const { env, sid, f, original } = setup('c10d');
      env.io.fail('rename', p => p === f, 'EPERM');
      env.io.replace('overwriteInPlace', base => (p, d) => base(p, d.subarray(0, d.length - 1)));
      const r = await env.runTool(sid, 'file_write', { path: f, content: 'new content' });
      expect(r.success).toBe(false);
      expect(r.row.state).toBe('unknown');
      env.io.reset();
      expect(readFileSync(env.service.saveCopy(sid, r.row.id, 'before').path).equals(original)).toBe(true);
    });

    it('C10e 改名报 EPERM，回落之前目标被改：冲突，磁盘上是别人写的内容，行 aborted / changed-during-write，没有原地覆盖', async () => {
      const { env, sid, f } = setup('c10e');
      env.io.hook('rename', () => writeFileSync(f, 'user edited meanwhile'), { pred: p => p === f });
      env.io.fail('rename', p => p === f, 'EPERM');
      const r = await env.runTool(sid, 'file_write', { path: f, content: 'new content' });
      expect(r.success).toBe(false);
      expect(r.output).toContain('被别的程序改动了');
      expect(readFileSync(f, 'utf8')).toBe('user edited meanwhile');
      expect(r.row).toMatchObject({ state: 'aborted', abort_reason: 'changed-during-write' });
      expect(env.io.callsOf('overwriteInPlace')).toEqual([]);
      noTemps(env.userDir);
    });

    it('C10f 不带检查点、改名报 EPERM：失败，文件不变，没有原地覆盖', () => {
      const dir = tmpDir('c10f'); const f = join(dir, 'plain.txt');
      writeFileSync(f, 'original');
      const io = recIo();
      io.fail('rename', p => p === f, 'EPERM');
      const r = commitFileWrite({ sessionId: 's' }, { path: f, produce: () => Buffer.from('new') }, { io });
      expect(r).toMatchObject({ ok: false, stage: 'write', fileUntouched: true });
      expect(readFileSync(f, 'utf8')).toBe('original');
      expect(io.callsOf('overwriteInPlace')).toEqual([]);
      noTemps(dir);
    });

    it.runIf(WIN)('C10g win32 真机：全共享的只读句柄开着目标（本进程一条、别的进程一条）——工具成功、走原地覆盖；句柄释放后恢复得到原始字节', async () => {
      for (const who of ['self', 'other'] as const) {
        const { env, sid, f, original, before } = setup(`c10g-${who}`);
        const fd = who === 'self' ? openSync(f, 'r') : undefined;
        const release = who === 'other' ? await holdOpen(f, 'ReadWrite, Delete') : async () => { closeSync(fd as number); };
        let r;
        try { r = await env.runTool(sid, 'file_write', { path: f, content: 'new content' }); } finally { await release(); }
        expect(r.success, r.output).toBe(true);
        expect(readFileSync(f, 'utf8')).toBe('new content');
        expect(env.snapshotOf(f)!.ino).toBe(before.ino);
        expect(r.row).toMatchObject({ state: 'applied', detail: 'in-place' });
        noTemps(env.userDir);
        expect((await restore(env, sid, r.row.id)).outcome).toBe('restored');
        expect(readFileSync(f).equals(original)).toBe(true);
      }
    }, 120_000);

    it.runIf(WIN)('C10h win32 真机：对方只许共享读（改名与原地打开都被拒）——失败、文件不变、无临时文件、行 aborted；句柄释放后重试成功', async () => {
      const { env, sid, f, before } = setup('c10h');
      const release = await holdOpen(f, 'Read');
      let r;
      try { r = await env.runTool(sid, 'file_write', { path: f, content: 'new content' }); } finally { await release(); }
      expect(r.success).toBe(false);
      expect(r.output).toContain('文件没有改动');
      expect(same(before, env.snapshotOf(f))).toBe(true);
      noTemps(env.userDir);
      expect(r.row).toMatchObject({ state: 'aborted', abort_reason: 'write-failed' });
      const again = await env.runTool(sid, 'file_write', { path: f, content: 'new content' });
      expect(again.success, again.output).toBe(true);
      expect(readFileSync(f, 'utf8')).toBe('new content');
    }, 120_000);

    it.runIf(WIN)('C10i win32 真机：对方独占打开（连读都被拒）——在读原文件那一步失败，没有行，检查点目录没有新内容，文件不变', async () => {
      const { env, sid, f, original } = setup('c10i');
      const release = await holdOpen(f, 'None');
      let r;
      try { r = await env.runTool(sid, 'file_write', { path: f, content: 'new content' }); } finally { await release(); }
      expect(r.success).toBe(false);
      expect(r.output).toContain('文件没有改动');
      expect(env.rows()).toEqual([]);
      expect(env.blobFiles()).toEqual([]);
      expect(readFileSync(f).equals(original)).toBe(true);
      noTemps(env.userDir);
    }, 120_000);
  });

  it('C11 改名成功后取文件信息抛错：工具照样成功，行 applied，文件是新内容', async () => {
    const env = cpEnv('c11'); const sid = env.newSession();
    const f = join(env.userDir, 'a.txt');
    writeFileSync(f, 'old');
    env.io.fail('lstat', p => p === f, 'EIO', 3);   // 第 1 次：写入前；第 2 次：替换前复核；第 3 次：替换之后
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'new' });
    expect(r.success, r.output).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('new');
    expect(r.row).toMatchObject({ state: 'applied', file_ino: null });
  });

  it('C12 写入过程中用户另存（临时文件写好之后目标被改）：冲突，磁盘上是用户的内容，行 aborted / changed-during-write，无临时文件', async () => {
    const env = cpEnv('c12'); const sid = env.newSession();
    const f = join(env.userDir, 'a.txt');
    writeFileSync(f, 'old');
    env.io.hook('after-tmp', () => writeFileSync(f, 'saved by the user just now'));
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'agent content' });
    expect(r.success).toBe(false);
    expect(r.output).toContain('被别的程序改动了');
    expect(readFileSync(f, 'utf8')).toBe('saved by the user just now');
    expect(r.row).toMatchObject({ state: 'aborted', abort_reason: 'changed-during-write', tmp_path: null });
    noTemps(env.userDir);
  });

  it('C12b 写入过程中文件被原地改成同样大小的另一份内容（临时文件写好之后）：冲突，磁盘上是用户的内容——替换前比的是整个签名（含修改时间），不只是大小', async () => {
    const env = cpEnv('c12b'); const sid = env.newSession();
    const f = join(env.userDir, 'a.txt');
    writeFileSync(f, 'old-1234');
    const ino = env.snapshotOf(f)!.ino;
    // 原地覆盖：文件 ID 与大小都不变，变的只有内容与修改时间。修改时间显式拨开，不依赖时钟粒度
    env.io.hook('after-tmp', () => { writeFileSync(f, 'USER-567'); utimesSync(f, new Date(), new Date(Date.now() + 60_000)); });
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'agent content' });
    expect(r.success).toBe(false);
    expect(r.output).toContain('被别的程序改动了');
    expect(readFileSync(f, 'utf8')).toBe('USER-567');
    expect(env.snapshotOf(f)!.ino).toBe(ino);
    expect(r.row).toMatchObject({ state: 'aborted', abort_reason: 'changed-during-write', tmp_path: null });
    noTemps(env.userDir);
  });

  it('C13 新建路径上在复核之后冒出同名文件：不覆盖那个文件，行 aborted', async () => {
    const env = cpEnv('c13'); const sid = env.newSession();
    const f = join(env.userDir, 'appears.txt');
    env.io.hook('before-replace', () => writeFileSync(f, 'created by someone else'));
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'agent content' });
    expect(r.success).toBe(false);
    expect(readFileSync(f, 'utf8')).toBe('created by someone else');
    expect(r.row).toMatchObject({ state: 'aborted', abort_reason: 'changed-during-write' });
    noTemps(env.userDir);
  });

  it('C14 只读文件：失败、文案含「只读」，文件不变，没有行', async () => {
    const env = cpEnv('c14'); const sid = env.newSession();
    const f = join(env.userDir, 'ro.txt');
    writeFileSync(f, 'read only');
    chmodSync(f, 0o444);
    try {
      const before = env.snapshotOf(f);
      const r = await env.runTool(sid, 'file_write', { path: f, content: 'x' });
      expect(r.success).toBe(false);
      expect(r.output).toContain('只读');
      expect(same(before, env.snapshotOf(f))).toBe(true);
      expect(env.rows()).toEqual([]);
    } finally { chmodSync(f, 0o666); }
  });

  it('C15 多硬链接文件：失败并说明，两个名字的内容都不变，链接数仍为 2', async () => {
    const env = cpEnv('c15'); const sid = env.newSession();
    const f = join(env.userDir, 'one.txt'); const g = join(env.userDir, 'two.txt');
    writeFileSync(f, 'shared inode');
    linkSync(f, g);
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'x' });
    expect(r.success).toBe(false);
    expect(r.output).toContain('2 个硬链接');
    expect(readFileSync(f, 'utf8')).toBe('shared inode');
    expect(readFileSync(g, 'utf8')).toBe('shared inode');
    expect(env.snapshotOf(f)!.nlink).toBe(2);
    expect(env.rows()).toEqual([]);
  });

  it('C16 审批等待期间把路径上的目录链接换了目标再放行：拒绝（已不在写锁之内），两个目标都不变', async () => {
    const env = cpEnv('c16');
    const outside = tmpDir('c16');                       // 工作区之外：写入要问
    const sid = env.newSession(tmpDir('c16-ws'));
    const d1 = join(outside, 'D1'); const d2 = join(outside, 'D2'); const j = join(outside, 'J');
    mkdirSync(d1); mkdirSync(d2);
    writeFileSync(join(d1, 'f.txt'), 'in D1'); writeFileSync(join(d2, 'f.txt'), 'in D2');
    junction(d1, j);
    const g = heldGateway();
    const p = env.runTool(sid, 'file_write', { path: join(j, 'f.txt'), content: 'agent' }, { gateway: g.gateway });
    await g.asked;
    rmSync(j);                                           // 只摘链接本身
    junction(d2, j);
    g.allow();
    const r = await p;
    expect(r.success).toBe(false);
    expect(r.output).toContain('已不在本次调用排队时的范围内');
    expect(readFileSync(join(d1, 'f.txt'), 'utf8')).toBe('in D1');
    expect(readFileSync(join(d2, 'f.txt'), 'utf8')).toBe('in D2');
    expect(env.rows()).toEqual([]);
  });

  it.runIf(WIN)('C17 win32：尾部带点的文件名与数据流写法被拒绝，a.txt 不变', async () => {
    const env = cpEnv('c17'); const sid = env.newSession();
    const f = join(env.userDir, 'a.txt');
    writeFileSync(f, 'original');
    for (const bad of [`${f}.`, `${f}::$DATA`, `${f}:stream`, `${f} `]) {
      const r = await fileWriteTool.execute({ path: bad, content: 'x', tool_title: 't' }, env.ctx(sid));
      expect(r.success, bad).toBe(false);
      expect(r.output).toContain('文件工具不支持');
    }
    expect(readFileSync(f, 'utf8')).toBe('original');
    expect(readdirSync(env.userDir)).toEqual(['a.txt']);
    expect(env.rows()).toEqual([]);
  });

  it.runIf(WIN)('C18 win32：先经 Sub\\A.txt 写，再经 sub\\a.TXT 与目录联接的别名写——三行的路径身份键相同，后两条算作第一条的后续', async () => {
    const env = cpEnv('c18'); const sid = env.newSession();
    mkdirSync(join(env.userDir, 'Sub'));
    const alias = join(env.userDir, 'Alias');
    junction(join(env.userDir, 'Sub'), alias);
    const r1 = await env.runTool(sid, 'file_write', { path: join(env.userDir, 'Sub', 'A.txt'), content: 'one' });
    const r2 = await env.runTool(sid, 'file_write', { path: join(env.userDir, 'sub', 'a.TXT'), content: 'two' });
    const r3 = await env.runTool(sid, 'file_write', { path: join(alias, 'a.txt'), content: 'three' });
    expect([r1.success, r2.success, r3.success]).toEqual([true, true, true]);
    const rows = env.rows(sid);
    expect(new Set(rows.map(r => r.path_key)).size).toBe(1);
    expect(env.store.laterOnPath(rows[0].path_key, rows[0].seq).map(r => r.id)).toEqual([rows[1].id, rows[2].id]);
    // 写入不改变文件名的大小写：磁盘上仍是第一次建的 A.txt
    expect(readdirSync(join(env.userDir, 'Sub'))).toEqual(['A.txt']);
    expect(readFileSync(join(env.userDir, 'Sub', 'A.txt'), 'utf8')).toBe('three');
  });

  it('C19 目标是指向普通文件的符号链接：链接仍是链接，被改的是它指向的文件（不能建符号链接时跳过）', async (ctx) => {
    if (!canSymlink()) { console.log('F08-C19 跳过：这台机器不能建文件符号链接（需要开发者模式或管理员）'); ctx.skip(); return; }
    const env = cpEnv('c19'); const sid = env.newSession();
    const real = join(env.userDir, 'real.txt'); const link = join(env.userDir, 'link.txt');
    writeFileSync(real, 'target content');
    symlinkSync(real, link, 'file');
    const r = await env.runTool(sid, 'file_write', { path: link, content: 'via link' });
    expect(r.success, r.output).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('via link');
    expect((await restore(env, sid, r.row.id)).outcome).toBe('restored');
    expect(readFileSync(real, 'utf8')).toBe('target content');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('C20 带着执行身份却没有检查点保存方（接线漏了）：拒绝写入，文件不变', () => {
    const dir = tmpDir('c20'); const f = join(dir, 'a.txt');
    writeFileSync(f, 'original');
    const r = commitFileWrite({ sessionId: 's', call: { toolUseId: 't', index: 0, name: 'file_write', runId: 'r', executionId: 'e' } }, { path: f, produce: () => Buffer.from('new') });
    expect(r).toMatchObject({ ok: false, stage: 'checkpoint', fileUntouched: true });
    expect(readFileSync(f, 'utf8')).toBe('original');
    noTemps(dir);
  });

  it('C21 行的 execution_id / run_id / tool_use_id 与执行账本那一行一致；两个哈希等于测试自己算的 sha256', async () => {
    const env = cpEnv('c21'); const sid = env.newSession();
    const f = join(env.userDir, 'a.txt');
    writeFileSync(f, 'before bytes');
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'after bytes' });
    expect(r.exec.state).toBe('completed');
    expect(r.row).toMatchObject({
      execution_id: r.exec.id, run_id: r.exec.run_id, tool_use_id: r.exec.tool_use_id, tool_name: 'file_write', session_id: sid, ordinal: 0,
      before_hash: sha('before bytes'), after_hash: sha('after bytes'), before_size: 12, after_size: 11, state: 'applied',
    });
    expect(r.row.run_id).toBe(r.runId);
    expect(r.row.file_ino).toBe(env.snapshotOf(f)!.ino);
  });

  it('C22 basedOn 与当前文件不符：冲突，文件不变；相符时写入', () => {
    const dir = tmpDir('c22'); const f = join(dir, 'a.txt');
    writeFileSync(f, 'current');
    const stale = commitFileWrite({ sessionId: 's' }, { path: f, basedOn: sha('older version'), produce: () => Buffer.from('new') });
    expect(stale).toMatchObject({ ok: false, stage: 'conflict', fileUntouched: true });
    const absent = commitFileWrite({ sessionId: 's' }, { path: f, basedOn: null, produce: () => Buffer.from('new') });
    expect(absent).toMatchObject({ ok: false, stage: 'conflict' });
    expect(readFileSync(f, 'utf8')).toBe('current');
    const ok = commitFileWrite({ sessionId: 's' }, { path: f, basedOn: sha('current'), produce: () => Buffer.from('new') });
    expect(ok).toMatchObject({ ok: true, created: false, unchanged: false });
    expect(readFileSync(f, 'utf8')).toBe('new');
  });

  it('C23 权限挂起期间零行、零内容文件、目标不变；取消后仍是零。对照：同一夹具放行后有 1 行、1 个内容文件', async () => {
    for (const mode of ['cancel', 'allow'] as const) {
      const env = cpEnv(`c23-${mode}`);
      const outside = tmpDir(`c23-${mode}`);
      const sid = env.newSession(tmpDir(`c23-${mode}-ws`));
      const f = join(outside, 'guarded.txt');
      writeFileSync(f, 'value alpha\n');
      const before = env.snapshotOf(f);
      const g = heldGateway();
      const abort = new AbortController();
      const p = env.runTool(sid, 'file_edit', { path: f, old_string: 'alpha', new_string: 'beta' }, { gateway: g.gateway, signal: abort.signal });
      await g.asked;
      // 挂起期间：检查点还没有建（建在审批之前的话，这一刻就有行与内容文件）
      expect(env.rows()).toEqual([]);
      expect(env.blobFiles()).toEqual([]);
      expect(same(before, env.snapshotOf(f))).toBe(true);
      if (mode === 'cancel') {
        abort.abort();
        const r = await p;
        expect(r.output).toBe('[已取消]');
        expect(env.rows()).toEqual([]);
        expect(env.blobFiles()).toEqual([]);
        expect(same(before, env.snapshotOf(f))).toBe(true);
        g.allow();
      } else {
        g.allow();
        const r = await p;
        expect(r.success, r.output).toBe(true);
        expect(env.rows()).toHaveLength(1);
        expect(env.blobFiles()).toEqual([sha('value alpha\n')]);
        expect(readFileSync(f, 'utf8')).toBe('value beta\n');
      }
    }
  });

  it('C24 不带检查点直接调工具：文件写成功、库零写入', async () => {
    const env = cpEnv('c24'); const sid = env.newSession();
    const f = join(env.userDir, 'plain.txt');
    writeFileSync(f, 'old');
    const out = await fileWriteTool.execute({ path: f, content: 'new', tool_title: 't' }, env.ctx(sid, { checkpoints: undefined }));
    expect(out).toEqual({ output: `已写入 ${f}`, success: true });
    expect(readFileSync(f, 'utf8')).toBe('new');
    expect(env.rows()).toEqual([]);
    expect(env.blobFiles()).toEqual([]);
    noTemps(env.userDir);
  });

  it('C25 新建文件时临时文件删不掉：工具成功、目标带着两个链接、行记着临时文件；随后编辑同一文件成功并把残留清掉。另一条：只看清单也会把残留清掉', async () => {
    for (const mode of ['edit', 'list'] as const) {
      const env = cpEnv(`c25-${mode}`); const sid = env.newSession();
      const f = join(env.userDir, 'made.txt');
      env.io.replace('linkExclusive', () => (from, to) => linkSync(from, to));   // 只建链接、不删临时文件
      const r = await env.runTool(sid, 'file_write', { path: f, content: 'first line\n' });
      expect(r.success, r.output).toBe(true);
      expect(env.snapshotOf(f)!.nlink).toBe(2);
      expect(r.row.state).toBe('applied');
      expect(r.row.tmp_path).not.toBeNull();
      expect(existsSync(r.row.tmp_path)).toBe(true);
      env.io.reset();
      if (mode === 'edit') {
        const e = await env.runTool(sid, 'file_edit', { path: f, old_string: 'first', new_string: 'second' });
        expect(e.success, e.output).toBe(true);        // 不报硬链接
        expect(readFileSync(f, 'utf8')).toBe('second line\n');
      } else {
        env.service.list(sid);
      }
      noTemps(env.userDir);
      expect(env.snapshotOf(f)!.nlink).toBe(1);
      expect(env.rows(sid)[0].tmp_path).toBeNull();
    }
  });

  it('C26 用户目录里的临时文件写不成（目标所在的盘满了）：工具失败并说「文件没有改动」，目标的字节、文件 ID、修改时间都不变，行 aborted / write-failed 且不记临时文件，目录里没有残留', async () => {
    const env = cpEnv('c26'); const sid = env.newSession();
    const f = join(env.userDir, 'keep.txt');
    writeFileSync(f, 'precious original\n');
    const before = env.snapshotOf(f);
    // 检查点目录照常可写（写前状态存得下），写不成的是目标旁边的临时文件
    env.io.fail('writeDurable', p => p.startsWith(env.userDir), 'ENOSPC');
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'overwrite' });
    expect(r.success).toBe(false);
    expect(r.output).toContain('写入失败');
    expect(r.output).toContain('ENOSPC');
    expect(r.output).toContain('文件没有改动');
    expect(same(before, env.snapshotOf(f))).toBe(true);
    expect(r.row).toMatchObject({ state: 'aborted', abort_reason: 'write-failed', detail: 'ENOSPC', tmp_path: null, before_blob: null });
    noTemps(env.userDir);
    // 目标目录里只有那一次没成的临时文件写入与随后对它的清理：没有改名、没有原地覆盖
    expect(writesUnder(env, env.userDir)).toEqual(['writeDurable', 'unlink']);
    expect(env.io.callsOf('unlink', p => p.startsWith(env.userDir)).every(c => /[\\/]\.dm-[0-9a-f]{16}\.tmp$/.test(c.path))).toBe(true);
    expect(r.exec.state).toBe('failed');
    // 没生效的记录不进清单，也不挡后面的写入
    env.io.reset();
    expect(env.service.list(sid).groups).toEqual([]);
    const again = await env.runTool(sid, 'file_write', { path: f, content: 'overwrite' });
    expect(again.success, again.output).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('overwrite');
  });

  it('C26a 临时文件已经写好、替换之前出错：临时文件被删掉（不留在用户目录里），行 aborted / write-failed、不记临时文件，目标不变', async () => {
    const env = cpEnv('c26a'); const sid = env.newSession();
    const f = join(env.userDir, 'keep.txt');
    writeFileSync(f, 'precious original\n');
    const before = env.snapshotOf(f);
    let tmpSeen = ''; let tmpExisted = false;
    env.io.hook('after-tmp', info => {
      tmpSeen = info.tmp ?? '';
      tmpExisted = existsSync(tmpSeen);
      throw Object.assign(new Error('EIO: 注入的故障, after-tmp'), { code: 'EIO' });
    });
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'overwrite' });
    expect(r.success).toBe(false);
    expect(r.output).toContain('文件没有改动');
    expect(tmpExisted).toBe(true);                               // 出错那一刻临时文件确实在盘上
    expect(existsSync(tmpSeen)).toBe(false);
    noTemps(env.userDir);
    expect(same(before, env.snapshotOf(f))).toBe(true);
    expect(r.row).toMatchObject({ state: 'aborted', abort_reason: 'write-failed', detail: 'EIO', tmp_path: null });
  });

  it('C26b 新建文件时临时文件写不成：目标不存在，行 aborted，没有残留临时文件；为它建出来的父目录留着（空的），失败文案只说文件', async () => {
    const env = cpEnv('c26b'); const sid = env.newSession();
    const f = join(env.userDir, 'sub', 'deep', 'new.txt');
    env.io.fail('writeDurable', p => p.startsWith(env.userDir), 'ENOSPC');
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'x' });
    expect(r.success).toBe(false);
    expect(r.output).toContain('文件没有改动');
    expect(existsSync(f)).toBe(false);
    expect(r.row).toMatchObject({ state: 'aborted', abort_reason: 'write-failed', before_exists: 0, tmp_path: null });
    // 已知边界（写进交付说明）：检查点提交之后才建父目录，临时文件写不成时这些空目录不回收——恢复也从不删目录
    expect(lstatSync(join(env.userDir, 'sub', 'deep')).isDirectory()).toBe(true);
    expect(readdirSync(join(env.userDir, 'sub', 'deep'))).toEqual([]);
    expect(env.tree(env.userDir)).toEqual({});
  });

  it('C27 进入写入入口时取消信号已经置位（直接调入口，不靠工具自己的复查）：cancelled、「[已取消]」，没有生成新内容，目标不变，没有行、没有内容文件；覆盖与新建各一条', () => {
    const env = cpEnv('c27'); const sid = env.newSession();
    const f = join(env.userDir, 'a.txt'); const fresh = join(env.userDir, 'sub', 'new.txt');
    writeFileSync(f, 'old');
    const before = env.snapshotOf(f);
    const abort = new AbortController();
    abort.abort();
    let produced = 0;
    for (const path of [f, fresh]) {
      const r = commitFileWrite(env.ctx(sid, { signal: abort.signal }), { path, produce: () => { produced += 1; return Buffer.from('new'); } });
      expect(r).toEqual({ ok: false, stage: 'cancelled', message: '[已取消]', fileUntouched: true });
    }
    expect(produced).toBe(0);
    expect(same(before, env.snapshotOf(f))).toBe(true);
    expect(existsSync(join(env.userDir, 'sub'))).toBe(false);
    expect(env.rows()).toEqual([]);
    expect(env.blobFiles()).toEqual([]);
    expect(writesUnder(env, env.userDir)).toEqual([]);
    // 对照：同一个上下文不带取消信号时写得成（上面的零改动不是别的原因造成的）
    expect(commitFileWrite(env.ctx(sid), { path: f, produce: () => Buffer.from('new') })).toMatchObject({ ok: true, unchanged: false });
    expect(readFileSync(f, 'utf8')).toBe('new');
  });

  it('C28 目标是一个目录：file_write、file_edit 都失败并说「目标不是普通文件」，目录与里面的文件不变，目标目录零写入，没有行', async () => {
    const env = cpEnv('c28'); const sid = env.newSession();
    const d = join(env.userDir, 'folder');
    mkdirSync(d);
    writeFileSync(join(d, 'inside.txt'), 'keep me');
    const tree = env.tree(env.userDir);
    const w = await env.runTool(sid, 'file_write', { path: d, content: 'x' });
    expect(w.success).toBe(false);
    expect(w.output).toBe(`没有写入 ${d}：目标不是普通文件（是目录、失效的链接或设备）。`);
    const e = await env.runTool(sid, 'file_edit', { path: d, old_string: 'a', new_string: 'b' });
    expect(e.success).toBe(false);
    expect(e.output).toBe(`没有写入 ${d}：目标不是普通文件（是目录、失效的链接或设备）。`);
    expect(lstatSync(d).isDirectory()).toBe(true);
    expect(env.tree(env.userDir)).toEqual(tree);
    expect(env.rows()).toEqual([]);
    expect(env.blobFiles()).toEqual([]);
    expect(writesUnder(env, env.userDir)).toEqual([]);
  });
});
