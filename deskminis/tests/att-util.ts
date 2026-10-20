/**
 * F11A 附件同步测试的共用夹具（文件名不匹配 *.test.ts，不会被当成用例）。
 *
 * 测试文件全部现场生成：补丁里不放二进制夹具，也不用任何用户文件。
 * 哈希在这里独立实现（node:crypto），不 import 被测模块。
 */
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const sha256Of = (buf: Uint8Array): string => createHash('sha256').update(buf).digest('hex');
export const sha256File = (path: string): string => sha256Of(readFileSync(path));

/** 种子伪随机（mulberry32）：同一个种子生成同一份文件，失败时可复现。 */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomBytesSeeded(n: number, seed: number): Buffer {
  const next = prng(seed);
  const out = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor(next() * 256);
  return out;
}

/** 48 字节的随机 ASCII 标记：嵌进文件里，抓包断言用它搜明文。 */
export function markerOf(seed: number): string {
  const next = prng(seed ^ 0x5bd1e995);
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 48; i++) s += alphabet[Math.floor(next() * alphabet.length)];
  return s;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * 手写一张真实的 PNG，总长度恰为 bytes：8×8 的真彩图（IHDR / IDAT / IEND），外加一个辅助块（解码器会跳过）
 * 装标记与伪随机填充，把长度补到位。返回文件字节与嵌在里面的标记。
 */
export function makePng(bytes: number, seed: number): { buf: Buffer; marker: string } {
  const next = prng(seed);
  const w = 8; const h = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8 位、RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 3)] = 0;   // 每行的滤波类型
    for (let x = 0; x < w * 3; x++) raw[y * (1 + w * 3) + 1 + x] = Math.floor(next() * 256);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const head = Buffer.concat([sig, pngChunk('IHDR', ihdr)]);
  const idat = pngChunk('IDAT', deflateSync(raw, { level: 0 }));
  const iend = pngChunk('IEND', Buffer.alloc(0));
  const marker = markerOf(seed);
  const fixed = head.length + idat.length + iend.length + 12;   // 12 = 辅助块的长度、类型、CRC
  const fill = bytes - fixed;
  if (fill < marker.length) throw new Error(`makePng: 至少要 ${fixed + marker.length} 字节`);
  const pad = Buffer.concat([Buffer.from(marker, 'latin1'), randomBytesSeeded(fill - marker.length, seed + 1)]);
  const buf = Buffer.concat([head, pngChunk('prVt', pad), idat, iend]);
  if (buf.length !== bytes) throw new Error('makePng: 长度没对上');
  return { buf, marker };
}

/** 手写的最小 PDF（一页、一句文字），标记写在内容流里。 */
export function makePdf(seed: number): { buf: Buffer; marker: string } {
  const marker = markerOf(seed);
  const stream = `BT /F1 12 Tf 72 720 Td (${marker}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { buf: Buffer.from(body, 'latin1'), marker };
}

/** 受控的闸门：被测代码走到 wait() 处停住，测试 release() 之后才继续。entered 在第一次有人等的那一刻兑现。 */
export interface Gate {
  /** 关着时等到放行；开着时立即返回。 */
  wait(): Promise<void>;
  close(): void;
  release(): void;
  /** 下一次有人在闸门处停住时兑现。 */
  entered(): Promise<void>;
  readonly waiting: number;
}

export function makeGate(closed = false): Gate {
  let isClosed = closed;
  let waiters: Array<() => void> = [];
  let onEnter: Array<() => void> = [];
  return {
    wait() {
      if (!isClosed) return Promise.resolve();
      return new Promise<void>(resolve => {
        waiters.push(resolve);
        const fire = onEnter; onEnter = [];
        for (const f of fire) f();
      });
    },
    close() { isClosed = true; },
    release() {
      isClosed = false;
      const run = waiters; waiters = [];
      for (const w of run) w();
    },
    entered() {
      if (waiters.length > 0) return Promise.resolve();
      return new Promise<void>(resolve => { onEnter.push(resolve); });
    },
    get waiting() { return waiters.length; },
  };
}

/** 等到条件成立（轮询，不猜固定时长）；超时抛错并带上说明。 */
export async function waitFor<T>(what: string, probe: () => T | undefined | false | Promise<T | undefined | false>, timeoutMs = 8000, stepMs = 20): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）：${what}`);
    await new Promise<void>(r => setTimeout(r, stepMs));
  }
}

/** 列出目录下全部文件的相对路径、长度、sha256（按路径排序），用来断言「没有多出任何文件」。 */
export function treeOf(dir: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    let names: string[];
    try { names = readdirSync(abs); } catch { return; }
    for (const n of names.sort()) {
      const childRel = rel ? `${rel}/${n}` : n;
      if (skip(childRel)) continue;
      const child = join(abs, n);
      let st;
      try { st = lstatSync(child); } catch { continue; }
      if (st.isDirectory()) { out.push(`${childRel}/`); walk(child, childRel); }
      else if (st.isFile()) {
        let digest = '?';
        try { digest = sha256File(child); } catch { /* 被占用的文件（如打开的数据库）只记长度 */ }
        out.push(`${childRel} ${st.size} ${digest}`);
      } else out.push(`${childRel} <link>`);
    }
  };
  walk(dir, '');
  return out;
}

/** sync-incoming 里的暂存文件名（.part / .stage）。目录不存在返回空数组。 */
export function incomingFiles(root: string): string[] {
  const dir = join(root, 'sync-incoming');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}
