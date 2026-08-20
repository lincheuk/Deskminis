/** F2a/F2c 入库降采样：
 *  纯计算部分（planDownsample / approxDataUrlBytes）node 直测——尺寸/格式分支表驱动；
 *  canvas 实际缩放 jsdom 测不了，用源码守卫锚定上传路径（ChatView.saveImages 调用了
 *  downsampleImageFile + 1568 长边上限字面量经 MAX_LONG_EDGE 锚定）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { planDownsample, approxDataUrlBytes, MAX_LONG_EDGE } from '../src/renderer/src/lib/attach/downsample';

const root = path.resolve(__dirname, '..');
const readSrc = (rel: string): string =>
  fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

const chatView = readSrc('src/renderer/src/components/ChatView.vue');

describe('F2a planDownsample 纯函数：是否需缩 / 目标尺寸 / 格式选择（表驱动）', () => {
  it('长边上限锚定：MAX_LONG_EDGE === 1568', () => {
    expect(MAX_LONG_EDGE).toBe(1568);
  });

  it('gif 豁免：不进 canvas（丢动画），原字节直传', () => {
    expect(planDownsample(4000, 3000, 'image/gif')).toBeNull();
  });

  it('未知/未支持 mime 豁免：main 侧 decodeImageDataUrl 本就只收四类，原样直传交给既有拒绝路径', () => {
    expect(planDownsample(4000, 3000, 'image/bmp')).toBeNull();
    expect(planDownsample(4000, 3000, '')).toBeNull();
  });

  const table: { name: string; w: number; h: number; mime: string; expect: { needsResize: boolean; tw?: number; th?: number; outMime?: string } }[] = [
    { name: '1568 边界内（含正好 1568）：原字节直传不动', w: 1568, h: 1000, mime: 'image/png', expect: { needsResize: false } },
    { name: '横图 png 超限：等比缩到长边 1568，保 png', w: 4000, h: 3000, mime: 'image/png', expect: { needsResize: true, tw: 1568, th: 1176, outMime: 'image/png' } },
    { name: '竖图 png 超限：长边落在高上', w: 3000, h: 4000, mime: 'image/png', expect: { needsResize: true, tw: 1176, th: 1568, outMime: 'image/png' } },
    { name: 'jpeg 超限：导出 jpeg', w: 4000, h: 3000, mime: 'image/jpeg', expect: { needsResize: true, tw: 1568, th: 1176, outMime: 'image/jpeg' } },
    { name: 'webp 超限：导出 jpeg', w: 4000, h: 4000, mime: 'image/webp', expect: { needsResize: true, tw: 1568, th: 1568, outMime: 'image/jpeg' } },
    { name: '1569 刚过线：也要缩（短边 800→799，四舍五入）', w: 1569, h: 800, mime: 'image/png', expect: { needsResize: true, tw: 1568, th: 799, outMime: 'image/png' } },
    { name: 'jpeg 边界内：不缩不转格式', w: 1200, h: 900, mime: 'image/jpeg', expect: { needsResize: false } },
  ];
  for (const row of table) {
    it(row.name, () => {
      const plan = planDownsample(row.w, row.h, row.mime);
      expect(plan).not.toBeNull();
      expect(plan!.needsResize).toBe(row.expect.needsResize);
      if (row.expect.needsResize) {
        expect(plan!.targetW).toBe(row.expect.tw);
        expect(plan!.targetH).toBe(row.expect.th);
        expect(plan!.exportMime).toBe(row.expect.outMime);
      }
    });
  }

  it('极端长宽比：短边向下取整后至少 1px', () => {
    const plan = planDownsample(100000, 20, 'image/png');
    expect(plan!.targetW).toBe(1568);
    expect(plan!.targetH).toBeGreaterThanOrEqual(1);
  });
});

describe('F2c approxDataUrlBytes：base64 payload 长度 × 3/4 向下取整（表驱动）', () => {
  const table: { name: string; dataUrl: string; expect: number }[] = [
    { name: '空 payload = 0', dataUrl: 'data:image/png;base64,', expect: 0 },
    { name: 'payload 4 字符（QUJD=ABC）→ 3 字节', dataUrl: 'data:image/png;base64,QUJD', expect: 3 },
    { name: 'payload 8 字符含填充（QUJDRA==）→ 6 字节', dataUrl: 'data:image/jpeg;base64,QUJDRA==', expect: 6 },
    { name: '大 payload：2000 字符 → 1500 字节', dataUrl: `data:image/png;base64,${'A'.repeat(2000)}`, expect: 1500 },
    { name: '无逗号坏输入 → 0', dataUrl: 'not-a-data-url', expect: 0 },
  ];
  for (const row of table) {
    it(row.name, () => {
      expect(approxDataUrlBytes(row.dataUrl)).toBe(row.expect);
    });
  }
});

describe('F2a 上传路径源码守卫：ChatView.saveImages 走降采样', () => {
  it('saveImages 调用 downsampleImageFile（canvas 缩放在选图后、saveAttachment 前）', () => {
    expect(chatView).toContain("from '../lib/attach/downsample'");
    expect(chatView).toMatch(/downsampleImageFile/);
    // 守卫退役直传路径：saveImages 不再直接 fileToDataUrl（fileToDataUrl 仍是 downsample 模块的内部工具，
    // ChatView 内不应再出现对它的调用）
    expect(chatView).not.toMatch(/await fileToDataUrl\(/);
  });
  it('1568 上限字面量锚定在 downsample 模块（MAX_LONG_EDGE），不散落组件', () => {
    const mod = readSrc('src/renderer/src/lib/attach/downsample.ts');
    expect(mod).toContain('1568');
  });
});

describe('F2c 像素上限硬约束源码守卫：字节取小退役、导出兜底常量锚定', () => {
  const mod = readSrc('src/renderer/src/lib/attach/downsample.ts');
  it('pickSmallerDataUrl 已删除（防回魂反向锚：字节取小会让超像素原图胜出）', () => {
    expect(mod).not.toContain('pickSmallerDataUrl');
  });
  it('approxDataUrlBytes 与 MAX_EXPORT_BYTES 存在（5MB 导出兜底同口径锚定）', () => {
    expect(mod).toContain('approxDataUrlBytes');
    expect(mod).toContain('MAX_EXPORT_BYTES');
    expect(mod).toContain('5 * 1024 * 1024');
  });
});
