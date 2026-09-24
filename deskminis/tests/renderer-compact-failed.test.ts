/** W2a-1 渲染端 compactFailed 的呈现（设计稿 §3 第 4 条：eventNotes kind 联合在末尾追加 'compactFailed'）。
 *  .vue 不在 typecheck 覆盖内，先用源码守卫钉住接线；实拍与溢出提示条同组件，放在 W2a-6 一起做。
 *  守卫认调用形态（分支条件、push 进 eventNotes 的对象字面量、ICONS/TONES 对象里的键），不认散文里的裸字符串。 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { eventCopy } from '../src/renderer/src/lib/eventnote/copy';

const R = (p: string) => readFileSync(resolve(__dirname, p), 'utf8').replace(/\r\n/g, '\n');
const chatTs = R('../src/renderer/src/stores/chat.ts');
const notesVue = R('../src/renderer/src/ui/EventNotes.vue');

/** 取 `const NAME ... = { ... };` 对象字面量的正文，只在这个范围里认键。 */
function objectBody(src: string, name: string): string {
  const m = new RegExp(`const ${name}[^=]*= \\{([\\s\\S]*?)\\};`).exec(src);
  expect(m, `${name} 对象字面量`).not.toBeNull();
  return m![1];
}

describe('W2a-1 compactFailed 渲染接线', () => {
  it('chat.ts：kind 联合在末尾追加 compactFailed（renderer-eventnote 的子串守卫靠前缀不变）', () => {
    expect(chatTs).toContain("kind: 'fallback'|'compacted'|'offloaded'|'retry'|'error'|'synced'|'pruned'|'compactFailed'; ts: number;");
  });

  it('chat.ts：onEvent 的 compactFailed 分支把 message 原样放进 detail，不给重试钮、不动 running', () => {
    const m = /else if \(e\.kind === 'compactFailed'\) \{([\s\S]*?)\n {6}\}/.exec(chatTs);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toMatch(/this\.eventNotes = \[\.\.\.this\.eventNotes\.slice\(-9\), \{ kind: 'compactFailed', ts: Date\.now\(\), detail: String\(e\.message\) \}\]/);
    // 压缩失败不结束回合：本轮照常回复，所以不能碰 running / lastError，也不给重试钮
    expect(body).not.toMatch(/this\.running\s*=/);
    expect(body).not.toMatch(/this\.lastError\s*=/);
    expect(body).not.toMatch(/retryable/);
  });

  it('copy：compactFailed → alert 图标、warn 语调、短句「上下文压缩失败，本轮按原样继续」', () => {
    expect(eventCopy('compactFailed', '摘要为空：…')).toEqual({ icon: 'alert', short: '上下文压缩失败，本轮按原样继续', tone: 'warn' });
  });

  it('EventNotes.vue：ICONS / TONES 都登记了 compactFailed（漏登会退回 alert/info，警告条显示成普通提示）', () => {
    expect(objectBody(notesVue, 'ICONS')).toMatch(/\bcompactFailed: 'alert'/);
    expect(objectBody(notesVue, 'TONES')).toMatch(/\bcompactFailed: 'warn'/);
  });
});
