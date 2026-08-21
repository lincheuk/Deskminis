/**
 * V6 · 附件在新壳里的接线守卫。
 *
 * 两处都必须有，缺一处都是「数据在、界面看不见」：
 * ① 输入侧——粘贴 / 拖拽 / ＋ 钮三条入口，后端能力早就有（preload saveAttachment），
 *    T 波的输入卡里那颗 ＋ 只挂了一句「后续接」；
 * ② 历史侧——落库消息里的 mediaRef part。StageChat 只渲染 text part，
 *    带图的那条消息在历史里会退化成一条空气泡。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(__dirname, '../src/renderer/src/ui/');
const read = (p: string): string => readFileSync(join(UI, p), 'utf8').replace(/\r\n/g, '\n');
const comp = read('Composer.vue');
const chatv = read('StageChat.vue');

describe('V6 — 附件输入侧', () => {
  it('粘贴 / 拖拽 / ＋ 钮三条入口都在，占位文案消失', () => {
    expect(comp).toContain('@paste');
    expect(comp).toContain('@drop');
    expect(comp).not.toContain('后续接');
    expect(comp).toContain('saveAttachment');
  });
  it('只收图片，且入库前降采样（复用既有 lib/attach/downsample）', () => {
    expect(comp).toContain('downsampleImageFile');
    expect(comp).toMatch(/startsWith\('image\//);
  });
  it('附件随消息一起发出，发完清空', () => {
    // 第二个参数是相对路径数组（后端据此落 mediaRef part）
    expect(comp).toMatch(/chat\.send\(t,\s*paths/);
    expect(comp).toContain('atts.value = []');
    // 只有图没有字也要能发——「看看这张图」是常见开法
    expect(comp).toMatch(/atts\.value\.length > 0/);
  });
});

describe('V6 — 附件历史侧', () => {
  it('mediaRef part 在历史里有 chip，不是被静默丢掉', () => {
    expect(chatv).toContain('mediaRef');
    expect(chatv).toContain('relativePath');
  });
});
