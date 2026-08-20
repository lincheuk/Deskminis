/** R2 应用图标守卫（设计稿 2026-08-20-release-design.md §2）。
 *  发布不过关点：build/icon.ico 缺失 → 装出来是 Electron 默认图标。
 *  图标由纯 node 脚本生成（gen-tray-icon 成例）可复现进 git；ICO 走 256 PNG-in-ICO。
 *  这里直接解析二进制头——「文件存在」不等于「是合法 ICO」。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('R2 build/icon.ico：合法 ICO 容器 + 256 PNG 条目', () => {
  it('ICONDIR 头 + 首条目 256×256 + 数据区是 PNG 且 IHDR 尺寸一致', () => {
    const ico = readFileSync(join(repoRoot, 'build', 'icon.ico'));
    // ICONDIR: reserved=0, type=1(icon), count>=1
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(1);
    // ICONDIRENTRY: width/height 字节 0 表示 256（ICO 格式约定）
    expect(ico[6]).toBe(0);
    expect(ico[7]).toBe(0);
    const size = ico.readUInt32LE(6 + 8);
    const offset = ico.readUInt32LE(6 + 12);
    expect(offset + size).toBeLessThanOrEqual(ico.length);
    // 数据区：PNG 魔数 + IHDR 宽高 256（electron-builder 最低要求 256）
    expect(ico.subarray(offset, offset + 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(ico.readUInt32BE(offset + 16)).toBe(256);
    expect(ico.readUInt32BE(offset + 20)).toBe(256);
  });
});

describe('R2 接线：yml win.icon + 生成脚本 + 品牌色对齐', () => {
  it('electron-builder.yml win 段接 icon；package.json 有 gen:app-icon', () => {
    const yml = readFileSync(join(repoRoot, 'electron-builder.yml'), 'utf8');
    expect(yml).toMatch(/icon:\s*build\/icon\.ico/);
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['gen:app-icon']).toContain('gen-app-icon.mjs');
  });
  it('两个生成脚本品牌色 = AionUi 蓝 #155BF5（Aurora 暖灰褐退场，I 波换肤随动）', () => {
    for (const f of ['scripts/gen-tray-icon.mjs', 'scripts/gen-app-icon.mjs']) {
      const src = readFileSync(join(repoRoot, f), 'utf8');
      expect(src).toMatch(/0x15,\s*0x5B,\s*0xF5/i);
      expect(src).not.toMatch(/0xB7,\s*0xAF,\s*0x96/i); // 旧暖灰褐不残留
    }
  });
});
