/** 修复：循环降级（fallback）重播时旧半截正文与新正文拼接。
 *  与 retry 分支同理：fallback 分支必须清空 streamingText，否则模型切到备选后重播，
 *  界面上会看到「旧半截正文 + 新正文」粘在一起。chat.ts 属 renderer 源码守卫范畴。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const chatTs = fs.readFileSync(path.join(root, 'src/renderer/src/stores/chat.ts'), 'utf8').replace(/\r\n/g, '\n');

describe('chat.ts fallback 分支清空流式缓冲（源码守卫）', () => {
  it('fallback 分支在更新 fallbackState 前清空 streamingText（与 retry 分支同款防拼接）', () => {
    // 锚定分支内部顺序：fallback 处理必须先清缓冲，再挂降级状态/事件条
    expect(chatTs).toMatch(/e\.kind === 'fallback'[\s\S]*?this\.streamingText = ''[\s\S]*?this\.fallbackState =/);
  });

  it('retry 分支既有清空不回归（同为防拼接锚，证明改动是补 fallback 而非新造机制）', () => {
    expect(chatTs).toMatch(/e\.kind === 'retry'[\s\S]*?this\.streamingText = ''/);
  });
});
