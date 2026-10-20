/**
 * F08 文件原语：用**真实的** nodeFileIo（不换 FileIo 的实现），只在 node:fs 这一层注入故障。
 *
 * 别的组（C / R / K）的注入打在 FileIo 这一层：linkExclusive、writeDurable 被整个换掉或在进门前抛错，
 * 它们自己内部的分支（硬链接做不了时退回改名、写到一半时收拾自己建出来的文件）一条都走不到。这里补的就是这两处：
 *  - 硬链接做不了时报什么错误码因平台与文件系统而异（Windows 的 FAT32 报 EISDIR，不在任何一张「不支持硬链接」的表里）。
 *    按表判断的话，这类卷上一个新文件都建不出来。
 *  - 另存的副本直接写在最终名字上：写到一半失败留下的半截文件，名字与完整的旧版本一模一样。
 * 全部在真实文件系统的临时目录上跑。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

// node:fs 的命名空间在 ESM 下不能 spy：整体换成「按开关注入、否则原样转给原实现」的包装。
// 被测模块（checkpoints/fs.ts、sync/attachments/io.ts）与夹具拿到的都是这一份。
const inject = vi.hoisted(() => ({
  /** linkSync 不建链接、直接抛这个错误码。 */
  linkCode: undefined as string | undefined,
  /** 对匹配的路径（'wx' 打开的文件）写入时只写前 5 个字节就抛 ENOSPC。 */
  shortWrite: undefined as ((path: string) => boolean) | undefined,
  links: 0,
  fds: new Map<number, string>(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const coded = (code: string, what: string): Error => Object.assign(new Error(`${code}: 注入的故障, ${what}`), { code });
  return {
    ...real,
    linkSync: ((from: string, to: string) => {
      inject.links += 1;
      if (inject.linkCode !== undefined) throw coded(inject.linkCode, `link '${from}' -> '${to}'`);
      return real.linkSync(from, to);
    }) as typeof real.linkSync,
    openSync: ((...a: Parameters<typeof real.openSync>) => {
      const fd = real.openSync(...a);
      inject.fds.set(fd, String(a[0]));
      return fd;
    }) as typeof real.openSync,
    closeSync: ((fd: number) => { inject.fds.delete(fd); return real.closeSync(fd); }) as typeof real.closeSync,
    writeSync: ((fd: number, ...rest: unknown[]) => {
      const path = inject.fds.get(fd);
      if (inject.shortWrite && path !== undefined && inject.shortWrite(path)) {
        const [buf, off, , pos] = rest as [Buffer, number, number, number];
        (real.writeSync as (...x: unknown[]) => number)(fd, buf, off, Math.min(5, buf.length - off), pos);
        throw coded('ENOSPC', `write '${path}'`);
      }
      return (real.writeSync as (...x: unknown[]) => number)(fd, ...rest);
    }) as typeof real.writeSync,
  };
});

// eslint-disable-next-line import/first —— vi.mock 由 vitest 提升到顶部
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errCode, nodeFileIo } from '../src/minisd/checkpoints/fs';
import { closeAllCpEnvs, cpEnv } from './checkpoint-fixture';

const temps: string[] = [];
afterEach(() => {
  inject.linkCode = undefined; inject.shortWrite = undefined;
  vi.useRealTimers();
  closeAllCpEnvs();
  for (const d of temps.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 留给系统清 */ } }
});
const tmpDir = (label: string): string => { const d = mkdtempSync(join(tmpdir(), `dm-f08-fs-${label}-`)); temps.push(d); return d; };
const dmFiles = (dir: string): string[] => readdirSync(dir).filter(n => n.startsWith('.dm-'));
const thrown = (fn: () => void): unknown => { try { fn(); } catch (e) { return e; } return undefined; };

describe('F08 文件原语：新建文件的发布（硬链接做不了时退回改名）', () => {
  // EISDIR：Windows 上 FAT32 的 CreateHardLinkW 报 ERROR_INVALID_FUNCTION，libuv 把它映射成 EISDIR。
  // 其余几个是别的平台、别的文件系统见过的；逐个列出来是为了钉住「不按错误码表判断」。
  it.each(['EISDIR', 'EINVAL', 'UNKNOWN', 'EACCES', 'EPERM', 'ENOTSUP', 'EXDEV', 'ENOSYS'])(
    'linkSync 报 %s：file_write 新建文件照样成功——内容对、单链接、没有残留临时文件、行 applied；随后恢复把它删掉', async (code) => {
      const env = cpEnv(`fs-link-${code.toLowerCase()}`); const sid = env.newSession();
      const f = join(env.userDir, 'sub', 'new.txt');
      inject.linkCode = code;
      const linksBefore = inject.links;
      const r = await env.runTool(sid, 'file_write', { path: f, content: 'made on a volume without hard links\n' });
      expect(r.success, r.output).toBe(true);
      expect(inject.links).toBe(linksBefore + 1);                 // 真的先试了硬链接（走的是 nodeFileIo 自己的实现）
      expect(readFileSync(f, 'utf8')).toBe('made on a volume without hard links\n');
      expect(lstatSync(f).nlink).toBe(1);
      expect(dmFiles(join(env.userDir, 'sub'))).toEqual([]);
      expect(r.row).toMatchObject({ state: 'applied', before_exists: 0, tmp_path: null });
      // 覆盖已有文件不经硬链接，一直是可用的：对照
      const again = await env.runTool(sid, 'file_write', { path: f, content: 'second\n' });
      expect(again.success, again.output).toBe(true);
      expect(inject.links).toBe(linksBefore + 1);
      const rep = await env.service.restore(sid, [r.row.id, again.row.id]);
      expect(rep.items.map(i => i.outcome)).toEqual(['deleted', 'restored']);
      expect(existsSync(f)).toBe(false);
    });

  it('硬链接做不了、而目标那一刻已经存在：照旧以 EEXIST 失败，不被改名盖掉（工具报冲突，那个文件一个字节不动）', async () => {
    const env = cpEnv('fs-link-exists'); const sid = env.newSession();
    const f = join(env.userDir, 'appears.txt');
    inject.linkCode = 'EISDIR';
    env.io.hook('before-replace', () => writeFileSync(f, 'created by someone else'));
    const r = await env.runTool(sid, 'file_write', { path: f, content: 'agent content' });
    expect(r.success).toBe(false);
    expect(r.output).toContain('被别的程序改动了');
    expect(readFileSync(f, 'utf8')).toBe('created by someone else');
    expect(r.row).toMatchObject({ state: 'aborted', abort_reason: 'changed-during-write' });
    expect(dmFiles(env.userDir)).toEqual([]);

    // 原语本身：目标已存在 → EEXIST，目标与临时文件都不动
    const dir = tmpDir('exists');
    const from = join(dir, 'from.tmp'); const to = join(dir, 'to.txt');
    writeFileSync(from, 'new'); writeFileSync(to, 'existing');
    expect(errCode(thrown(() => nodeFileIo.linkExclusive(from, to)))).toBe('EEXIST');
    expect(readFileSync(to, 'utf8')).toBe('existing');
    expect(readFileSync(from, 'utf8')).toBe('new');
    // 硬链接本身报 EEXIST（文件系统支持硬链接、目标已存在）：原样抛，不去改名
    inject.linkCode = 'EEXIST';
    expect(errCode(thrown(() => nodeFileIo.linkExclusive(from, to)))).toBe('EEXIST');
    expect(readFileSync(to, 'utf8')).toBe('existing');
  });

  it('硬链接做不了、改名也做不成（临时文件不在）：抛的是改名自己的错，不把硬链接的错误码当成结论', () => {
    const dir = tmpDir('rename-fails');
    inject.linkCode = 'EISDIR';
    const e = thrown(() => nodeFileIo.linkExclusive(join(dir, 'missing.tmp'), join(dir, 'to.txt')));
    expect(errCode(e)).toBe('ENOENT');
    expect(existsSync(join(dir, 'to.txt'))).toBe(false);
  });

  it('对照：硬链接可用时走硬链接、临时文件被删、目标单链接', () => {
    const dir = tmpDir('link-ok');
    const from = join(dir, 'from.tmp'); const to = join(dir, 'to.txt');
    writeFileSync(from, 'new');
    const before = inject.links;
    nodeFileIo.linkExclusive(from, to);
    expect(inject.links).toBe(before + 1);
    expect(readFileSync(to, 'utf8')).toBe('new');
    expect(existsSync(from)).toBe(false);
    expect(lstatSync(to).nlink).toBe(1);
  });
});

describe('F08 文件原语：writeDurable 写到一半失败时收拾自己建出来的文件', () => {
  it('写了几个字节之后盘满：抛错，并且不留下那个半截文件；目标已存在（EEXIST）时不动别人的文件', () => {
    const dir = tmpDir('durable');
    const p = join(dir, 'copy.txt');
    inject.shortWrite = path => path === p;
    expect(errCode(thrown(() => nodeFileIo.writeDurable(p, Buffer.from('ORIGINAL CONTENT, 27 bytes.'))))).toBe('ENOSPC');
    expect(existsSync(p)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    // 对照：注入确实写下了半截（把收拾的那一步去掉，这里留下的就是 5 个字节的文件）——用另一条路证明注入是活的
    inject.shortWrite = undefined;
    nodeFileIo.writeDurable(p, Buffer.from('complete'));
    expect(readFileSync(p, 'utf8')).toBe('complete');
    // 'wx'：目标已存在时在打开那一步就失败——这个文件不是这一次建的，绝不能删
    inject.shortWrite = path => path === p;
    expect(errCode(thrown(() => nodeFileIo.writeDurable(p, Buffer.from('second attempt'))))).toBe('EEXIST');
    expect(readFileSync(p, 'utf8')).toBe('complete');
  });

  it('另存写到一半失败：报「另存失败」，目录里不留残缺的「改动前」副本；重试得到完整的副本，名字不带 -2', async () => {
    const env = cpEnv('fs-savecopy'); const sid = env.newSession();
    const f = join(env.userDir, 'doc.txt');
    const original = 'ORIGINAL CONTENT, 27 bytes.';
    writeFileSync(f, original);
    const w = await env.runTool(sid, 'file_write', { path: f, content: 'agent wrote this' });
    expect(w.success, w.output).toBe(true);
    const copies = (): string[] => readdirSync(env.userDir).filter(n => n.includes('改动前'));
    vi.useFakeTimers({ now: new Date(2026, 9, 4, 12, 0, 0), toFake: ['Date'] });   // 两次另存落在同一秒：名字相同
    inject.shortWrite = path => path.includes('改动前');
    expect(() => env.service.saveCopy(sid, w.row.id, 'before')).toThrow('另存失败');
    expect(copies()).toEqual([]);                                 // 没有名字像完整旧版本、内容只有 5 个字节的文件
    inject.shortWrite = undefined;
    const copy = env.service.saveCopy(sid, w.row.id, 'before');
    expect(copies()).toEqual(['doc.改动前-20261004-120000.txt']);   // 不是 …-2.txt：上一次没有留下占名字的残缺文件
    expect(readFileSync(copy.path, 'utf8')).toBe(original);
    expect(readFileSync(f, 'utf8')).toBe('agent wrote this');
  });
});
