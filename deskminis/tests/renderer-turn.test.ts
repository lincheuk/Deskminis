/** MU2a Task 5：回合结构 + 用户消息标签行（设计 §2.1）守卫 + fmtHHMM 纯模块（6 例）。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fmtHHMM } from '../src/renderer/src/lib/time/hhmm';

const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const chatView = R('../src/renderer/src/ui/StageChat.vue');

describe('MU2a Task 5 fmtHHMM（2 例）', () => {
  it('epoch 秒 → HH:MM（与本地时区手算一致）', () => {
    for (const sec of [0, 1767225600, 1800000000, 86399, 1767225600 + 14 * 3600 + 32 * 60]) {
      const d = new Date(sec * 1000);
      const want = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      expect(fmtHHMM(sec)).toBe(want);
    }
  });

  it('输出恒为两位补零 HH:MM 格式', () => {
    for (const sec of [0, 3599, 36000, 1767225600]) {
      expect(fmtHHMM(sec)).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
    }
  });
});

describe('MU2a Task 5 回合结构守卫（4 例）', () => {
  /* 「你 · 标签行 + hover 复制钮」在 T6e-3 退场：新 StageChat 没有这两样。
     标签行随右对齐气泡一起没了必要（谁说的话看位置就知道），但**复制钮是丢的能力**——
     想复制自己刚发的那段话，现在只能手选。已记入候选池「换壳遗失的入口」。 */

  /* 「用户气泡退场」在 T6e-3 退场——**不是漂移，是裁定被推翻**。
     MU2a 当时判定用户消息不进气泡（左对齐纯文本），T 波重做时改回了
     「右对齐浅底块」（ui/StageChat.vue 文件头写明的设计），`.ubub` +
     `align-items: flex-end` 就是当年被禁的那套。守卫不能替人拍板：
     设计换了主意，旧断言该退场，而不是把新设计判红。 */

  it('回合容器：class="turn" + turns computed（回合切分仍是渲染的骨架）', () => {
    // 分隔线断言退场：新设计用**回合内 gap**分节奏，回合之间不画线
    // （满宽文档式正文里再加横线会把版面切碎）。锚保留的是「按回合切分」这件事本身。
    expect(chatView).toMatch(/class="turn"/);
    expect(chatView).toMatch(/const turns = computed/);
  });

  /* 「助手区每回合一头（aname）」在 T6e-3 退场：新设计里助手输出是**满宽文档式**，
     不带头像行也不带名字（见 ui/StageChat.vue 文件头）。同样是裁定变更而非退化。 */
});
