/** 图片附件端到端进模型（renderer 侧源码守卫）：
 *  ChatView 发送带 attachments + 用户消息 mediaRef chip + attachNote 尾注路径退役 + chat.ts send 新签名。
 *  .vue 不在 typecheck 覆盖范围，故用源文本守卫（与 renderer-composer.test.ts 同款写法）。 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const readSrc = (rel: string): string =>
  fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');

// T6e-3 重指：输入卡（历史/@文件/自增高/附件）从 ChatView 独立成 ui/Composer.vue。
const chatView = readSrc('src/renderer/src/ui/Composer.vue');
const chatStore = readSrc('src/renderer/src/stores/chat.ts');
// 历史消息里的附件 chip 留在会话视图，草稿态在输入卡——换壳后两边分家了
const stage = readSrc('src/renderer/src/ui/StageChat.vue');

describe('renderer 附件进模型：ChatView 源码守卫', () => {
  it('send() 把 pendingAttachments 的 path 数组传给 chat.send，不再拼 attachNote 尾注', () => {
    expect(chatView).toContain('.map(a => a.path)');
    expect(chatView).toContain('chat.send(');
    // 尾注路径退役：不再 import/调用 attachNote
    expect(chatView).not.toContain('attachNote');
    expect(chatView).not.toContain("from '../lib/composer/attach'");
  });

  it('用户消息渲染 mediaRef chip：📎 样式 + originalFileName/文件名兜底，不加载图片字节', () => {
    // 模板里有 mediaRef 分支（历史消息 parts 渲染附件 chip）
    // 新写法是早退过滤（p?.type !== 'mediaRef' → continue），语义同一件事：
    // 只挑出 mediaRef part 来渲 chip。锚「认得出这个 part 类型」而不是某种写法。
    expect(stage).toMatch(/p\??\.type\s*[!=]==\s*'mediaRef'/);
    // 📎 emoji 换成了 UiIcon 的 file 图标（新树统一走图标集，不混用 emoji）
    expect(stage).toMatch(/UiIcon name="file"/);
    // chip 文案：优先 originalFileName，否则从 relativePath 取文件名
    expect(stage).toContain('originalFileName');
    // 不做 IPC 读图：历史 chip 只用元数据，不出现针对历史消息的图片字节加载
    expect(stage).not.toContain('attachments.read');
  });

  it('发送键禁用条件放宽：文本为空但有附件可发送', () => {
    // canSend 由「有文本」放宽为「有文本或有附件」
    expect(chatView).toMatch(/atts\.value\.length/);  // 草稿附件态改名 pendingAttachments → atts
    expect(chatView).not.toMatch(/canSend = computed\(\(\) => input\.value\.trim\(\)\.length > 0 && !chat\.running\)/);
  });
});

describe('renderer 附件进模型：chat.ts 源码守卫', () => {
  it('send 新签名 send(text, attachments?)：乐观消息 parts 带 mediaRef，RPC 参数带 attachments', () => {
    expect(chatStore).toContain('async send(text: string, attachments?: string[])');
    // 乐观消息与后端同构：mediaRef part（mimeType 经 mimeFromPath 映射）
    expect(chatStore).toContain("type: 'mediaRef'");
    expect(chatStore).toContain('mimeFromPath');
    // RPC 参数带 attachments
    expect(chatStore).toMatch(/chat\.prompt',\s*\{\s*sessionId: this\.activeId,\s*text,\s*attachments/);
  });
});

describe('renderer 附件进模型：attachNote 尾注路径退役', () => {
  it('lib/composer/attach.ts 已删除（路径已被 attachments 参数替代）', () => {
    expect(fs.existsSync(path.join(root, 'src/renderer/src/lib/composer/attach.ts'))).toBe(false);
  });
});
