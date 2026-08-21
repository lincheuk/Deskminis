/**
 * V1-V3 · 新壳会话视图的能力面守卫（读 .vue 源码文本）。
 *
 * T 波换壳后 StageChat 只渲染「文本 + 工具步骤」，把三件东西丢在了旧组件树里：
 * ① **权限卡**——默认档位就是「每次确认」，没有卡等于 agent 一请求权限就无声卡死到超时。
 *    这是最严重的一条：应用看起来在跑，其实永远不会有下文。
 * ② 事件提示（降级/压缩/卸载/重试/错误）——出错没有重试入口，降级了用户不知道。
 * ③ 思考块——推理 token 照烧，但用户一个字看不到。
 * 这条守卫钉死它们不再消失。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const UI = join(__dirname, '../src/renderer/src/ui/');
const read = (p: string): string => readFileSync(join(UI, p), 'utf8').replace(/\r\n/g, '\n');
const chatv = read('StageChat.vue');

describe('V1 — 权限卡', () => {
  it('StageChat 渲染 pendingPerms，不是只在 watch 里数一下个数', () => {
    expect(existsSync(join(UI, 'PermCard.vue'))).toBe(true);
    expect(chatv).toContain("import PermCard from './PermCard.vue'");
    expect(chatv).toMatch(/v-for="p in chat\.pendingPerms"/);
  });

  it('三个决议按钮齐全（少一个就有一条路走不通）', () => {
    const c = read('PermCard.vue');
    for (const d of ['allow-once', 'allow-session', 'deny']) expect(c).toContain(`'${d}'`);
    expect(c).toContain('respondPerm');
  });

  it('路径/命令逐字完整显示，不截断', () => {
    const c = read('PermCard.vue');
    // 被截断的路径没法判断该不该批准——这是权限卡存在的全部意义
    expect(c).toMatch(/word-break:\s*break-all/);
    expect(c).toMatch(/white-space:\s*pre-wrap/);
    expect(c).not.toMatch(/text-overflow:\s*ellipsis/);
  });

  it('写文件类请求批准前能看到差分预览', () => {
    const c = read('PermCard.vue');
    expect(c).toContain('preview');
    expect(c).toContain('UiDiff');
    expect(existsSync(join(UI, 'UiDiff.vue'))).toBe(true);
  });

  it('倒计时只显示不自判——超时判定权在 minisd', () => {
    const c = read('PermCard.vue');
    expect(c).toContain('remainSeconds');
    // 组件不许自己把请求判死（那会与后端广播打架）
    expect(c).not.toMatch(/respondPerm\([^)]*'timeout'/);
  });

  it('shell 卡的桥命令双段告知还在（一次批准放行两类权限，必须说清楚）', () => {
    const c = read('PermCard.vue');
    expect(c).toContain('bridgeTriggers');
    expect(c).toContain('permTriggerLabel');
  });
});

describe('V2 — 事件提示与重试', () => {
  it('eventNotes 渲染在对话流里，错误项带重试入口', () => {
    expect(existsSync(join(UI, 'EventNotes.vue'))).toBe(true);
    expect(chatv).toContain("import EventNotes from './EventNotes.vue'");
    const e = read('EventNotes.vue');
    for (const k of ['fallback', 'compacted', 'offloaded', 'retry', 'error', 'synced', 'pruned']) {
      expect(e).toContain(k);
    }
    expect(e).toContain('retryLast');
  });
});

describe('V3 — 思考块', () => {
  it('流式思考与历史 reasoningContent 都有去处（不然推理 token 是白烧的）', () => {
    expect(existsSync(join(UI, 'ThinkBlock.vue'))).toBe(true);
    expect(chatv).toContain('streamingThinking');
    expect(chatv).toContain('reasoningContent');
  });
});
