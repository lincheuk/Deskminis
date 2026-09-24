/** U1：ZIP 读写。.docx/.xlsx/.pptx 都是 ZIP + OOXML，这是整套 Office 能力的地基。
 *
 *  读用 yauzl（项目已有，技能导入器在用）；写**自己实现**——
 *  Node 内置 zlib 提供 deflateRaw，ZIP 容器本身只是几段定长头，手写即可，
 *  不为了「写 zip」引一个新依赖（零新依赖红线）。
 *
 *  防护（agent 会拿它读任意文件，技能导入器同类成例）：条目数与解压总量都设上限，
 *  防 zip bomb；路径穿越项直接跳过。
 *
 *  W1a-3：上限与读条目的逻辑抽成共享预算闸（createZipBudget + readZipEntry），
 *  技能导入（skills/importer.ts 的 unzipToMemory）与这里的 readZip 共用同一套，只是上限不同。 */
import { deflateRawSync, crc32, createInflateRaw } from 'node:zlib';
import type { Readable } from 'node:stream';
import * as yauzl from 'yauzl';

export interface ZipEntry { path: string; data: Buffer }

export const ZIP_MAX_ENTRIES = 2000;
export const ZIP_MAX_TOTAL = 64 * 1024 * 1024;   // 解压总量上限 64MB
/** office 的单文件上限取总量值：止血波不收紧 office 的行为——原来只有条目数与总量两道闸，
 *  单文件超过总量时总量闸本来就会拒，所以单文件闸取同值等于没加，行为不变。
 *  技能包另有更紧的单文件上限（skills/importer.ts 的 SKILL_ZIP_LIMITS）。 */
export const ZIP_MAX_ENTRY = ZIP_MAX_TOTAL;

export interface ZipLimits {
  /** 条目数上限（含不含目录项由调用方决定：它只数 admit 过的条目） */
  readonly maxEntries: number;
  /** 解压总量上限（字节） */
  readonly maxTotal: number;
  /** 单个条目解压后的上限（字节） */
  readonly maxEntry: number;
}

const OFFICE_ZIP_LIMITS: ZipLimits = Object.freeze({
  maxEntries: ZIP_MAX_ENTRIES, maxTotal: ZIP_MAX_TOTAL, maxEntry: ZIP_MAX_ENTRY,
});

/** 预算闸的判定结果。只给结构，不给文案：office 与技能导入各有各的说法（调用方翻译）。 */
export type ZipGuardHit =
  | { kind: 'entries'; limit: number }
  | { kind: 'entry'; name: string; limit: number }
  | { kind: 'total'; limit: number }
  /** 实际解压出的字节多于中央目录声明——声明值被伪造，前面按声明做的预扣就不可信了 */
  | { kind: 'declared'; name: string; declared: number }
  /** 实际解压出的字节少于声明——截断或损坏 */
  | { kind: 'short'; name: string; declared: number; actual: number };

export class ZipGuardError extends Error {
  constructor(readonly hit: ZipGuardHit) {
    super(`zip 预算闸拒绝：${JSON.stringify(hit)}`);
    this.name = 'ZipGuardError';
  }
}

/** 逐块累计实际字节；越界时返回判定，否则 null。 */
export type ZipMeter = (chunkBytes: number) => ZipGuardHit | null;

export interface ZipBudget {
  /** 第一道：EOCD 里的 entryCount。openZip 之后、读任何条目之前看——超限就一个条目都不读。
   *  这个数可以被伪造得比实际小，所以回调里 admit 的逐条计数不能省。 */
  checkEntryCount(count: number): ZipGuardHit | null;
  /** 第二道：openReadStream（也就是 inflate）之前。计一条，并按声明的解压尺寸预扣单文件与总量额度。
   *  顺序是计数 → 单文件 → 总量，先到先报：单文件超限时报出文件名，比「总量超了」更能说明问题。 */
  admit(name: string, declaredSize: number): ZipGuardHit | null;
  /** 第三道：读流时逐块累计实际字节。声明值是压缩包自己说的，不可信，只能在字节真正出来时再数一遍。 */
  meter(name: string, declaredSize: number): ZipMeter;
}

export function createZipBudget(limits: ZipLimits): ZipBudget {
  let admitted = 0;
  let declaredTotal = 0;
  let actualTotal = 0;
  return {
    checkEntryCount(count) {
      return count > limits.maxEntries ? { kind: 'entries', limit: limits.maxEntries } : null;
    },
    admit(name, declaredSize) {
      if (++admitted > limits.maxEntries) return { kind: 'entries', limit: limits.maxEntries };
      if (declaredSize > limits.maxEntry) return { kind: 'entry', name, limit: limits.maxEntry };
      declaredTotal += declaredSize;
      if (declaredTotal > limits.maxTotal) return { kind: 'total', limit: limits.maxTotal };
      return null;
    },
    meter(name, declaredSize) {
      let actual = 0;
      return (chunkBytes) => {
        actual += chunkBytes;
        actualTotal += chunkBytes;
        // 按声明预扣过额度，所以「不多于声明」就蕴含了后两条；后两条留着，
        // 是为了不经 admit 直接 meter 的调用也有底线
        if (actual > declaredSize) return { kind: 'declared', name, declared: declaredSize };
        if (actual > limits.maxEntry) return { kind: 'entry', name, limit: limits.maxEntry };
        if (actualTotal > limits.maxTotal) return { kind: 'total', limit: limits.maxTotal };
        return null;
      };
    },
  };
}

/** 按预算读出一个条目的全部字节。超限或尺寸不符时以 ZipGuardError 拒绝；其余错误原样拒绝。
 *
 *  压缩条目**取原始字节、自己 inflate**，不用 yauzl 的解压管线。原因：yauzl 2.10 把它返回的读流的
 *  destroy() 换成了不收参数的版本，而 Node 14 起流在 transform / flush 出错时正是调 destroy(err) 来报错——
 *  于是它自己的尺寸校验（validateEntrySizes）一触发，错误就被吞掉，读流既不 end 也不 error，
 *  调用方的 Promise 永远挂着（W1a-3 实测：声明 10 字节、实际 1MB 的条目让技能导入任务永远停在 running，
 *  office_read 同样卡死）。自己 inflate 之后：多于声明由 meter 逐块拦，少于声明在 end 时拦，
 *  zlib 的错误走我们自己挂的监听，照常冒出来。原始字节那一段是按压缩尺寸精确切的，不受上述问题影响。
 *
 *  拒绝前先停流：计量器拦下时 inflate 手里往往还有大段压缩数据（伪造尺寸的炸弹正是这样），不停它就会
 *  一直解压到底，炸弹越大白耗的 CPU 越多。先 unpipe 再 destroy inflate：先解绑，raw 就不会再往已销毁的
 *  inflate 里写。raw.destroy() 在 fromBuffer 下只是 fd-slicer 换上的置标志空函数，留着是为了将来换成
 *  文件型 reader（fromFd / open）时能真正停读；附录担心的「读流进行中 zf.close() 报错」在 fromBuffer 下
 *  并不存在（close 只是 unref），所以真正起作用的是停 inflate，测试也钉在这一点上。 */
export function readZipEntry(zf: yauzl.ZipFile, entry: yauzl.Entry, meter: ZipMeter): Promise<Buffer> {
  const name = entry.fileName;
  return new Promise((resolve, reject) => {
    const onStream = (err: Error | null, raw: Readable) => {
      if (err || !raw) { reject(err ?? new Error(`读取 zip 条目失败：${name}`)); return; }
      const inflate = entry.isCompressed() ? createInflateRaw() : null;
      const out: Readable = inflate ? raw.pipe(inflate) : raw;
      const chunks: Buffer[] = [];
      let actual = 0;
      let settled = false;
      const fail = (e: Error) => {
        if (settled) return;
        settled = true;
        if (inflate) { raw.unpipe(inflate); inflate.destroy(); }
        raw.destroy();
        reject(e);
      };
      raw.on('error', fail);                // pipe 不转发上游错误，两头都要挂
      if (inflate) inflate.on('error', fail);
      out.on('data', (c: Buffer) => {
        if (settled) return;
        actual += c.length;
        const hit = meter(c.length);
        if (hit) { fail(new ZipGuardError(hit)); return; }
        chunks.push(c);
      });
      out.on('end', () => {
        if (settled) return;
        if (actual < entry.uncompressedSize) {
          fail(new ZipGuardError({ kind: 'short', name, declared: entry.uncompressedSize, actual }));
          return;
        }
        settled = true;
        resolve(Buffer.concat(chunks));
      });
    };
    // decompress 只许对压缩条目指定（yauzl 会对存储条目直接抛），所以分两种调用
    if (entry.isCompressed()) zf.openReadStream(entry, { decompress: false, decrypt: null, start: null, end: null }, onStream);
    else zf.openReadStream(entry, onStream);
  });
}

/** crc32：Node 22.15+ 的 zlib 才有；旧版本回落到自算表（Electron 内 Node 版本不定）。 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32of(buf: Buffer): number {
  if (typeof crc32 === 'function') return crc32(buf) >>> 0;
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 写 ZIP：每项 local header + deflate 数据，末尾 central directory + EOCD。
 *  一律 deflate（OOXML 全是文本，压缩率高）；不写 data descriptor（尺寸提前就知道）。 */
export function writeZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.path, 'utf8');
    const comp = deflateRawSync(e.data, { level: 9 });
    const crc = crc32of(e.data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);   // local file header 签名
    lh.writeUInt16LE(20, 4);           // version needed
    lh.writeUInt16LE(0x0800, 6);       // flags: bit 11 = 文件名为 UTF-8（中文路径必须）
    lh.writeUInt16LE(8, 8);            // method: deflate
    lh.writeUInt16LE(0, 10);           // mod time（固定 0：产出可复现，不随时间变）
    lh.writeUInt16LE(0x0021, 12);      // mod date（1980-01-01，同上）
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);   // central directory 签名
    ch.writeUInt16LE(20, 4);           // version made by
    ch.writeUInt16LE(20, 6);           // version needed
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0x0021, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(0, 42);           // 相对偏移，下面回填
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + comp.length;
  }

  const central = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, eocd]);
}

/** 这条错误会**原样出现在预览卡上**，所以必须是一句中文人话：
 *  yauzl 的原文（"end of central directory record signature not found"）
 *  对用户等于没说。真实原因括号里保留一份，方便排查。 */
function badZip(cause?: string): Error {
  return new Error('这不是一个有效的 OOXML 包——.docx/.xlsx/.pptx 本质是 zip，' +
    `这份文件的 zip 结构读不出来，可能已损坏，或只是把别的文件改了扩展名${cause ? `（${cause}）` : ''}`);
}

/** 预算闸判定 → office 沿用的原文案。单文件与总量超限同一句：单文件上限等于总量，
 *  单文件超了总量必然也超，原来报的就是这句。尺寸与声明不符在原来会经 yauzl 的读流报错，
 *  落到「读取 zip 条目失败」这句（只是被 yauzl 吞了，见 readZipEntry），这里照接。 */
function officeGuardError(hit: ZipGuardHit): Error {
  switch (hit.kind) {
    case 'entries': return new Error('zip 条目过多，已中止');
    case 'entry':
    case 'total': return new Error('zip 解压体积超过上限，已中止');
    case 'declared':
    case 'short': return new Error(`读取 zip 条目失败：${hit.name}`);
  }
}

/** 读 ZIP → path → Buffer。畸形字节抛可读错误（调用方会把它转成用户可见的提示）。 */
export function readZip(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) { reject(badZip(err?.message)); return; }
      const out = new Map<string, Buffer>();
      // 不在这里看 zf.entryCount：office 历来只数「跳过目录项与穿越项之后」的条目，
      // EOCD 的总数含目录项，拿它提前拒会误伤原本能读的包（行为不变是本波对 office 的约束）
      const budget = createZipBudget(OFFICE_ZIP_LIMITS);
      zf.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        // 目录项 / 穿越项 / 绝对路径：跳过（OOXML 部件都是普通相对路径）
        if (name.endsWith('/') || name.includes('..') || name.startsWith('/')) { zf.readEntry(); return; }
        const hit = budget.admit(name, entry.uncompressedSize);
        if (hit) { reject(officeGuardError(hit)); zf.close(); return; }
        readZipEntry(zf, entry, budget.meter(name, entry.uncompressedSize)).then(
          (data) => { out.set(name, data); zf.readEntry(); },
          (e: unknown) => {
            reject(e instanceof ZipGuardError ? officeGuardError(e.hit) : new Error(`读取 zip 条目失败：${name}`));
            zf.close();
          },
        );
      });
      zf.on('end', () => resolve(out));
      zf.on('error', (e: Error) => reject(badZip(e.message)));
      zf.readEntry();
    });
  });
}
