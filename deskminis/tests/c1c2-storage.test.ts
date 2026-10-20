/** UI 过滤不能改变真实库中的推理原文。 */
import { expect, it } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';

it('第31条占位推理逐字保留在真实库和读回结果', () => {
  const db = openDb(':memory:');
  try {
    const store = new ChatStore(db), session = store.createSession();
    const reasoningContent = ' \nNO REASONING AVAILABLE.  ';
    store.appendMessage({ id: 'placeholder', sessionId: session.id, role: 'assistant', parts: [{ type: 'text', value: '回答' }], reasoningContent, createdAt: 1, streamInterruptCount: 0 });
    expect(store.listMessages(session.id)[0].reasoningContent).toBe(reasoningContent);
    expect(db.prepare('SELECT reasoning_content FROM messages WHERE id = ?').get('placeholder')).toEqual({ reasoning_content: reasoningContent });
  } finally { db.close(); }
});
