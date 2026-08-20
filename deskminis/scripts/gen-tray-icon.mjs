// 生成 resources/tray.png（32×32 RGBA）：品牌色圆角方块 + 三条白色「对话行」。
// 不引任何依赖：PNG 容器 + zlib（node 内置）手写——图标进 git 且可复现，
// 审查这个脚本比审查二进制 PNG 现实得多。用法：npm run gen:tray-icon
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 32, R = 7;
const BRAND = [0x15, 0x5B, 0xF5, 0xFF]; // tokens.css 浅色 --accent（AionUi 蓝，I 波换肤随动；旧 Aurora 暖灰褐退场）
const WHITE = [0xFF, 0xFF, 0xFF, 0xFF];
const CLEAR = [0, 0, 0, 0];
// 三条对话行（h 取 3：通知区 16px 缩略后仍可辨）
const BARS = [
  { x: 8, y: 9, w: 16, h: 3 },
  { x: 8, y: 15, w: 16, h: 3 },
  { x: 8, y: 21, w: 10, h: 3 },
];

/** 点在圆角方块内（四角以半径 R 圆弧收角，角外透明）。 */
function inRoundedRect(x, y) {
  const cx = x < R ? R : x > SIZE - 1 - R ? SIZE - 1 - R : x;
  const cy = y < R ? R : y > SIZE - 1 - R ? SIZE - 1 - R : y;
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= R * R;
}

const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1);
  raw[row] = 0; // 每行 filter 字节：None
  for (let x = 0; x < SIZE; x++) {
    let px = inRoundedRect(x, y) ? BRAND : CLEAR;
    if (px === BRAND) {
      for (const b of BARS) {
        if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) { px = WHITE; break; }
      }
    }
    raw.set(px, row + 1 + x * 4);
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
ihdr[8] = 8; ihdr[9] = 6; // 8bit，color type 6 = RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'tray.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log('written:', out, png.length, 'bytes');
