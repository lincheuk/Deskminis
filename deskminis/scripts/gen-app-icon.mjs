// 生成 build/icon.ico（256×256 单条目，PNG-in-ICO）：应用/安装器图标。
// motif 与 resources/tray.png 同源（识别连续性）：品牌蓝圆角方块 + 三条白「对话行」，
// 品牌色 = tokens.css 浅色 --accent（AionUi 蓝，I 波换肤后 Aurora 暖灰褐退场）。
// 不引任何依赖：PNG 容器 + zlib（node 内置）+ ICO 目录头手写——图标进 git 且可复现
//（gen-tray-icon 成例）。ICO 容器原生支持 256 条目内嵌 PNG，electron-builder 最低要求 256。
// 用法：npm run gen:app-icon
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 256, R = 56;
const BRAND = [0x15, 0x5B, 0xF5]; // #155BF5
const WHITE = [0xFF, 0xFF, 0xFF];
// 三条对话行 = tray 的 32px 坐标 ×8（比例一致，缩到任务栏 16px 仍同一形）
const BARS = [
  { x: 64, y: 72, w: 128, h: 24 },
  { x: 64, y: 120, w: 128, h: 24 },
  { x: 64, y: 168, w: 80, h: 24 },
];

/** 采样点在圆角方块内（四角以半径 R 圆弧收角）。 */
function inRoundedRect(x, y) {
  const cx = x < R ? R : x > SIZE - R ? SIZE - R : x;
  const cy = y < R ? R : y > SIZE - R ? SIZE - R : y;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= R * R;
}

// 256px 下硬边缘的圆弧会有明显锯齿（32px tray 看不出来）：每像素 4×4 超采样出边缘 alpha
const SS = 4;
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1);
  raw[row] = 0; // filter: None
  for (let x = 0; x < SIZE; x++) {
    let hit = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        if (inRoundedRect(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS)) hit++;
      }
    }
    const alpha = Math.round((hit / (SS * SS)) * 255);
    let rgb = BRAND;
    for (const b of BARS) {
      if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) { rgb = WHITE; break; }
    }
    raw.set([...rgb, alpha], row + 1 + x * 4);
  }
}

// CRC32（PNG 块校验，多项式 0xEDB88320）
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit，RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

// ICO 容器：ICONDIR(6) + ICONDIRENTRY(16) + PNG。宽高字节 0 = 256（格式约定）。
const dir = Buffer.alloc(6 + 16);
dir.writeUInt16LE(0, 0);            // reserved
dir.writeUInt16LE(1, 2);            // type: icon
dir.writeUInt16LE(1, 4);            // count
dir[6] = 0; dir[7] = 0;             // 256×256
dir[8] = 0; dir[9] = 0;             // palette / reserved
dir.writeUInt16LE(1, 10);           // planes
dir.writeUInt16LE(32, 12);          // bitcount
dir.writeUInt32LE(png.length, 14);  // data size
dir.writeUInt32LE(22, 18);          // data offset = 6 + 16

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.ico');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, Buffer.concat([dir, png]));
console.log('written:', out, 22 + png.length, 'bytes');
