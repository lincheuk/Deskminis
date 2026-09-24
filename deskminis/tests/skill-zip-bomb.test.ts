/** W1a-3：技能 zip 解压上限（设计稿 §2「技能 zip 上限 2000 条 / 64MB 总量 / 32MB 单文件」，
 *  附录 tools.md W1a-zip）。
 *
 *  三处把关，各有一组用例钉住「拒绝发生在哪一步」：
 *   ① openZip 之后先看 EOCD 的 entryCount——超限一个条目都不读；
 *   ② 'entry' 回调里、openReadStream（即 inflate）之前——计数、单文件声明尺寸、累计声明总量；
 *   ③ 读流时逐块累计实际字节——压缩条目由我们自己 inflate，这是字节真正出来时的尺寸校验；越界即停 inflate。
 *  「在 inflate 之前」用 spy 数 yauzl.ZipFile.prototype.openReadStream 的调用次数来证明：
 *  只看最终 reject 不够，逐条读到第 N 条才拒，内存早就被吃掉了。
 *
 *  注入小的 limits 造包，避免测试真去吃 64MB 内存；默认值另有一例守卫对齐 office 的常量。 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as yauzl from 'yauzl';
import type { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/minisd/store/db';
import { SkillStore } from '../src/minisd/skills/store';
import { SkillImporter, SKILL_ZIP_LIMITS, unzipToMemory, type ImportProgress } from '../src/minisd/skills/importer';
import {
  writeZip, readZip, createZipBudget, ZIP_MAX_ENTRIES, ZIP_MAX_TOTAL, ZIP_MAX_ENTRY, type ZipEntry,
} from '../src/minisd/office/zip';

const KB = 1024;
const MB = 1024 * KB;
const SKILL_MD = '---\nname: bomb-skill\ndescription: 上限测试\n---\n# Bomb\n';

/** 中央目录第 i 条的起始偏移：EOCD（末 22 字节）+16 是中央目录偏移，逐条跳过 46+名长+扩展长+注释长。 */
function centralHeaderOffset(buf: Buffer, index: number): number {
  const eocd = buf.length - 22;
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < index; i++) {
    off += 46 + buf.readUInt16LE(off + 28) + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32);
  }
  return off;
}
/** 改写第 i 条在中央目录里声明的解压尺寸（+24）。yauzl 只信中央目录，不看本地头。 */
function forgeDeclaredSize(buf: Buffer, index: number, size: number): Buffer {
  const out = Buffer.from(buf);
  out.writeUInt32LE(size, centralHeaderOffset(out, index) + 24);
  return out;
}
function files(n: number, prefix = 'f'): ZipEntry[] {
  return Array.from({ length: n }, (_, i) => ({ path: `${prefix}${i}.txt`, data: Buffer.from('x') }));
}

type OpenCb = (err: Error | null, rs: Readable) => void;
/** 在任何 spy 之前取原函数：beforeEach 已经把原型上的换成了 spy，再取就是 spy 自己（会无限递归）。 */
const ORIG_OPEN = yauzl.ZipFile.prototype.openReadStream;
function spyOpenReadStream() { return vi.spyOn(yauzl.ZipFile.prototype, 'openReadStream'); }
let openSpy: ReturnType<typeof spyOpenReadStream>;
beforeEach(() => { openSpy = spyOpenReadStream(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('① entryCount 阶段：超限一个条目都不读', () => {
  it('maxEntries=3、包里 4 条：拒绝，文案含「条目过多」，openReadStream 0 次', async () => {
    const buf = writeZip(files(4));
    await expect(unzipToMemory(buf, { ...SKILL_ZIP_LIMITS, maxEntries: 3 }))
      .rejects.toThrow('技能包条目过多（超过 3 个），已拒绝导入');
    expect(openSpy).toHaveBeenCalledTimes(0);
  });

  it('恰好等于上限（3 条）照常解压——上限是「超过」才拒', async () => {
    const out = await unzipToMemory(writeZip(files(3)), { ...SKILL_ZIP_LIMITS, maxEntries: 3 });
    expect([...out.keys()].sort()).toEqual(['f0.txt', 'f1.txt', 'f2.txt']);
  });
});

describe('② inflate 之前：计数（含目录项）、单文件声明尺寸、累计声明总量', () => {
  it('maxTotal=1MB、3 个 400KB 全零条目：第三个在打开前就被拒，文案含「总大小」', async () => {
    const zero = Buffer.alloc(400 * KB);
    const buf = writeZip([{ path: 'a.bin', data: zero }, { path: 'b.bin', data: zero }, { path: 'c.bin', data: zero }]);
    await expect(unzipToMemory(buf, { ...SKILL_ZIP_LIMITS, maxTotal: 1 * MB }))
      .rejects.toThrow('技能包解压后总大小超过 1MB，已拒绝导入');
    expect(openSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('maxEntry=512KB、1 个 600KB 条目：拒绝，文案点名文件，openReadStream 0 次', async () => {
    const buf = writeZip([{ path: 'big/huge.bin', data: Buffer.alloc(600 * KB) }]);
    await expect(unzipToMemory(buf, { ...SKILL_ZIP_LIMITS, maxEntry: 512 * KB }))
      .rejects.toThrow('技能包内文件 big/huge.bin 解压后超过 512KB，已拒绝导入');
    expect(openSpy).toHaveBeenCalledTimes(0);
  });

  it('目录项也计数：2 个目录项 + 2 个文件、上限 3，在 entryCount 阶段就拒', async () => {
    const buf = writeZip([
      { path: 'd1/', data: Buffer.alloc(0) }, { path: 'd2/', data: Buffer.alloc(0) },
      { path: 'SKILL.md', data: Buffer.from(SKILL_MD) }, { path: 'x.txt', data: Buffer.from('x') },
    ]);
    await expect(unzipToMemory(buf, { ...SKILL_ZIP_LIMITS, maxEntries: 3 })).rejects.toThrow('条目过多');
    expect(openSpy).toHaveBeenCalledTimes(0);
  });

  it('entryCount 报小、实际发出的条目更多：回调里的计数（含目录项）接住第 4 条', async () => {
    // EOCD 写成 3 条让 ① 放行；再在第一次 readEntry 时把 entryCount 改回真实的 4，
    // 模拟「EOCD 字段不可信、解析器照中央目录多发条目」——回调计数就是为这种情形留的
    const buf = writeZip([
      { path: 'd1/', data: Buffer.alloc(0) }, { path: 'd2/', data: Buffer.alloc(0) },
      { path: 'SKILL.md', data: Buffer.from(SKILL_MD) }, { path: 'x.txt', data: Buffer.from('x') },
    ]);
    const forged = Buffer.from(buf);
    forged.writeUInt16LE(3, forged.length - 22 + 8);
    forged.writeUInt16LE(3, forged.length - 22 + 10);
    const origRead = yauzl.ZipFile.prototype.readEntry;
    vi.spyOn(yauzl.ZipFile.prototype, 'readEntry').mockImplementation(function (this: yauzl.ZipFile) {
      this.entryCount = 4;
      origRead.call(this);
    });
    await expect(unzipToMemory(forged, { ...SKILL_ZIP_LIMITS, maxEntries: 3 }))
      .rejects.toThrow('技能包条目过多（超过 3 个），已拒绝导入');
    // 只有 SKILL.md 被读过：两个目录项不读字节但占了计数，x.txt 在打开前被拒
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('中央目录声明 2^31 字节：以我们的上限文案拒绝（不是 yauzl 读流时的 not enough bytes），openReadStream 0 次', async () => {
    const buf = forgeDeclaredSize(writeZip([{ path: 'SKILL.md', data: Buffer.from(SKILL_MD) }]), 0, 2 ** 31);
    const err = await unzipToMemory(buf).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toBe('技能包内文件 SKILL.md 解压后超过 32MB，已拒绝导入');
    expect(err!.message).not.toMatch(/not enough bytes/);
    expect(openSpy).toHaveBeenCalledTimes(0);
  }, 5000);
});

describe('③ 流式：实际字节与声明不符时读流中断，不再永远挂起', () => {
  // 这三例在改动前不是「报错」而是「永远挂起」：yauzl 2.10 自己的尺寸校验触发后，错误经被它换掉的
  // destroy() 吞掉，读流既不 end 也不 error。所以给 5 秒超时，挂起就以超时的形式翻红。
  it('声明 10 字节、实际 1MB 的 deflate 条目：计量器拦下，拒绝时 inflate 已停（raw 已 unpipe、inflate 已 destroy）', async () => {
    // 不数 raw.destroy 的次数：fromBuffer 下 raw 是 fd-slicer 的 PassThrough，数据在创建时已全部写入，
    // 它的 destroy 被换成只置标志的空函数；而 Node 的 autoDestroy 在 'end' 时本来就会调一次 destroy，
    // 所以「destroy ≥ 1 次」不管实现停没停流都成立（W1a-3 审查实测：删掉停流三句仍 20/20 全绿）。
    // 真正起作用的是 unpipe + inflate.destroy：不停的话 inflate 会把整段压缩数据解压到底，炸弹越大越久。
    // 所以抓住 raw.pipe 的目标（readZipEntry 自己建的 inflate），拒绝后断言它已被 destroy。
    // raw.readableFlowing===false 只是停流后的状态核对：inflate close 时 pipe 会自动解绑，
    // 单删显式 unpipe 这一句它区分不出来（Node 22 下两者行为等价，见提交正文的变异核对）。
    const raws: Readable[] = [];
    const sinks: NodeJS.WritableStream[] = [];
    openSpy.mockImplementation(function (this: yauzl.ZipFile, entry: yauzl.Entry, ...rest: unknown[]) {
      const cb = rest[rest.length - 1] as OpenCb;
      const tapped: OpenCb = (err, rs) => {
        if (rs) {
          raws.push(rs);
          const origPipe = rs.pipe.bind(rs);
          rs.pipe = (<T extends NodeJS.WritableStream>(dest: T, opts?: { end?: boolean }) => {
            sinks.push(dest);
            return origPipe(dest, opts);
          }) as typeof rs.pipe;
        }
        cb(err, rs);
      };
      // 两种重载（带不带 options）都原样转发，只把回调换成记录 pipe 目标的那个
      Reflect.apply(ORIG_OPEN, this, [entry, ...rest.slice(0, -1), tapped]);
    } as never);
    const buf = forgeDeclaredSize(writeZip([{ path: 'liar.bin', data: Buffer.alloc(1 * MB) }]), 0, 10);
    await expect(unzipToMemory(buf)).rejects.toThrow('技能包内文件 liar.bin 解压出的字节多于它声明的 10 字节，已拒绝导入');
    expect(raws.length).toBe(1);
    expect(sinks.length).toBe(1);   // 压缩条目：raw 只 pipe 进自己建的那一个 inflate
    expect((sinks[0] as unknown as { destroyed: boolean }).destroyed).toBe(true);
    expect(raws[0].readableFlowing).toBe(false);
  }, 5000);

  it('声明 4096 字节、实际 8 字节：以「少于声明」拒绝', async () => {
    const buf = forgeDeclaredSize(writeZip([{ path: 'short.txt', data: Buffer.from('12345678') }]), 0, 4096);
    await expect(unzipToMemory(buf))
      .rejects.toThrow('技能包内文件 short.txt 解压出的字节少于它声明的 4096 字节，包可能已损坏，已拒绝导入');
  }, 5000);

  it('office readZip 同样不再挂起：声明 10 字节、实际 1MB 报「读取 zip 条目失败」', async () => {
    const buf = forgeDeclaredSize(writeZip([{ path: 'liar.bin', data: Buffer.alloc(1 * MB) }]), 0, 10);
    await expect(readZip(buf)).rejects.toThrow('读取 zip 条目失败：liar.bin');
  }, 5000);

  it('压缩数据损坏：zlib 的错误照常冒出来（现状即绿；改成自己 inflate 后不能丢）', async () => {
    const forged = Buffer.from(writeZip([{ path: 'bad.txt', data: Buffer.from('hello hello hello') }]));
    forged[30 + 'bad.txt'.length] = 0xff;   // 第一个 deflate 块头：BTYPE=11 是保留值
    await expect(unzipToMemory(forged)).rejects.toThrow();
    await expect(readZip(forged)).rejects.toThrow('读取 zip 条目失败：bad.txt');
  }, 5000);

  it('正常 deflate 包逐字节读回（自己 inflate 的通路不改内容）', async () => {
    const noise = randomBytes(200 * KB);
    const text = Buffer.from('技能正文\n'.repeat(5000), 'utf8');
    const buf = writeZip([
      { path: 'pack/SKILL.md', data: Buffer.from(SKILL_MD) },
      { path: 'pack/bin/noise.bin', data: noise },
      { path: 'pack/doc.txt', data: text },
      { path: 'pack/empty.txt', data: Buffer.alloc(0) },
    ]);
    const out = await unzipToMemory(buf);
    expect([...out.keys()].sort()).toEqual(['SKILL.md', 'bin/noise.bin', 'doc.txt', 'empty.txt']);
    expect(out.get('bin/noise.bin')!.equals(noise)).toBe(true);
    expect(out.get('doc.txt')!.equals(text)).toBe(true);
    expect(out.get('empty.txt')!.length).toBe(0);
    const back = await readZip(buf);
    expect(back.get('pack/bin/noise.bin')!.equals(noise)).toBe(true);
  });
});

describe('默认值守卫', () => {
  it('技能默认 2000 条 / 64MB 总量取自 office 导出的常量，单文件 32MB', () => {
    expect(ZIP_MAX_ENTRIES).toBe(2000);
    expect(ZIP_MAX_TOTAL).toBe(64 * MB);
    expect(SKILL_ZIP_LIMITS.maxEntries).toBe(ZIP_MAX_ENTRIES);
    expect(SKILL_ZIP_LIMITS.maxTotal).toBe(ZIP_MAX_TOTAL);
    expect(SKILL_ZIP_LIMITS.maxEntry).toBe(32 * MB);
    expect(Object.isFrozen(SKILL_ZIP_LIMITS)).toBe(true);
  });

  it('office 的单文件上限等于总量（64MB）——readZip 行为不变', () => {
    // 先钉具体值：只比两者相等的话，两个导出都不存在时 undefined === undefined 也会绿
    expect(ZIP_MAX_ENTRY).toBe(64 * MB);
    expect(ZIP_MAX_ENTRY).toBe(ZIP_MAX_TOTAL);
  });

  it('createZipBudget：计数 → 单文件 → 总量，先到先报', () => {
    const b = createZipBudget({ maxEntries: 3, maxTotal: 100, maxEntry: 60 });
    expect(b.checkEntryCount(3)).toBeNull();
    expect(b.checkEntryCount(4)).toEqual({ kind: 'entries', limit: 3 });
    expect(b.admit('a', 50)).toBeNull();
    expect(b.admit('b', 61)).toEqual({ kind: 'entry', name: 'b', limit: 60 });
    const b2 = createZipBudget({ maxEntries: 3, maxTotal: 100, maxEntry: 60 });
    expect(b2.admit('a', 50)).toBeNull();
    expect(b2.admit('b', 50)).toBeNull();
    expect(b2.admit('c', 1)).toEqual({ kind: 'total', limit: 100 });
    const b3 = createZipBudget({ maxEntries: 1, maxTotal: 100, maxEntry: 60 });
    expect(b3.admit('a', 0)).toBeNull();
    expect(b3.admit('b', 0)).toEqual({ kind: 'entries', limit: 1 });
  });

  it('createZipBudget 的计量器：逐块累计，越过声明值即报', () => {
    const b = createZipBudget({ maxEntries: 3, maxTotal: 100, maxEntry: 60 });
    expect(b.admit('a', 10)).toBeNull();
    const m = b.meter('a', 10);
    expect(m(6)).toBeNull();
    expect(m(4)).toBeNull();
    expect(m(1)).toEqual({ kind: 'declared', name: 'a', declared: 10 });
  });
});

describe('端到端：SkillImporter 导入超条目包', () => {
  let root: string; let skillsRoot: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dm-zipbomb-'));
    skillsRoot = join(root, 'skills');
    mkdirSync(skillsRoot, { recursive: true });
  });

  async function waitTask(importer: SkillImporter, taskId: string, timeoutMs = 10_000): Promise<ImportProgress> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const t = importer.status(taskId);
      if (t && t.state !== 'running') return t;
      if (Date.now() > deadline) throw new Error('等待导入任务超时');
      await new Promise(r => setTimeout(r, 10));
    }
  }

  it('2001 条的包：任务 failed，错误含「条目过多」，skillsRoot 下没有新目录', async () => {
    const zipPath = join(root, 'many.zip');
    writeFileSync(zipPath, writeZip([{ path: 'SKILL.md', data: Buffer.from(SKILL_MD) }, ...files(2000)]));
    const importer = new SkillImporter(skillsRoot, new SkillStore(openDb(':memory:')));
    const t = await waitTask(importer, importer.startImport('zip', zipPath).taskId);
    expect(t.state).toBe('failed');
    expect(t.error).toBe('技能包条目过多（超过 2000 个），已拒绝导入');
    expect(readdirSync(skillsRoot)).toEqual([]);
    expect(openSpy).toHaveBeenCalledTimes(0);
  });
});

describe('office readZip 改用共享预算后行为不变（现状即绿，钉住不变）', () => {
  it('超过 2000 个文件：原文案「zip 条目过多，已中止」', async () => {
    await expect(readZip(writeZip(files(2001)))).rejects.toThrow('zip 条目过多，已中止');
  });

  it('目录项不计入 office 的条目数：2000 个文件 + 5 个目录项照常读出', async () => {
    const dirs: ZipEntry[] = Array.from({ length: 5 }, (_, i) => ({ path: `d${i}/`, data: Buffer.alloc(0) }));
    const out = await readZip(writeZip([...dirs, ...files(2000)]));
    expect(out.size).toBe(2000);
  });

  it('单条声明 2^31 字节：原文案「zip 解压体积超过上限，已中止」，inflate 之前就拒', async () => {
    const buf = forgeDeclaredSize(writeZip([{ path: 'word/document.xml', data: Buffer.from('<w/>') }]), 0, 2 ** 31);
    await expect(readZip(buf)).rejects.toThrow('zip 解压体积超过上限，已中止');
    expect(openSpy).toHaveBeenCalledTimes(0);
  });
});
