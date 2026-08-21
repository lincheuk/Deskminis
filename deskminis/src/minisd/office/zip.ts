/** U1：ZIP 读写。.docx/.xlsx/.pptx 都是 ZIP + OOXML，这是整套 Office 能力的地基。
 *
 *  读用 yauzl（项目已有，技能导入器在用）；写**自己实现**——
 *  Node 内置 zlib 提供 deflateRaw，ZIP 容器本身只是几段定长头，手写即可，
 *  不为了「写 zip」引一个新依赖（零新依赖红线）。
 *
 *  防护（agent 会拿它读任意文件，技能导入器同类成例）：条目数与解压总量都设上限，
 *  防 zip bomb；路径穿越项直接跳过。 */
import { deflateRawSync, crc32 } from 'node:zlib';
import * as yauzl from 'yauzl';

export interface ZipEntry { path: string; data: Buffer }

const MAX_ENTRIES = 2000;
const MAX_TOTAL = 64 * 1024 * 1024;   // 解压总量上限 64MB

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

/** 读 ZIP → path → Buffer。畸形字节抛可读错误（调用方会把它转成用户可见的提示）。 */
export function readZip(buf: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) { reject(badZip(err?.message)); return; }
      const out = new Map<string, Buffer>();
      let total = 0;
      let count = 0;
      zf.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        // 目录项 / 穿越项 / 绝对路径：跳过（OOXML 部件都是普通相对路径）
        if (name.endsWith('/') || name.includes('..') || name.startsWith('/')) { zf.readEntry(); return; }
        if (++count > MAX_ENTRIES) { reject(new Error('zip 条目过多，已中止')); zf.close(); return; }
        total += entry.uncompressedSize;
        if (total > MAX_TOTAL) { reject(new Error('zip 解压体积超过上限，已中止')); zf.close(); return; }
        zf.openReadStream(entry, (e2, rs) => {
          if (e2 || !rs) { reject(new Error(`读取 zip 条目失败：${name}`)); return; }
          const chunks: Buffer[] = [];
          rs.on('data', (c: Buffer) => chunks.push(c));
          rs.on('end', () => { out.set(name, Buffer.concat(chunks)); zf.readEntry(); });
          rs.on('error', () => reject(new Error(`读取 zip 条目失败：${name}`)));
        });
      });
      zf.on('end', () => resolve(out));
      zf.on('error', (e: Error) => reject(badZip(e.message)));
      zf.readEntry();
    });
  });
}
