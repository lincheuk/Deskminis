import { describe, expect, it } from 'vitest';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import { buildCompactMeta, defaultToolKindOf, parseSummaryReply } from '../src/minisd/agent/compact-meta';
import { makeSeen } from '../src/minisd/sync/lifecycle';

describe('F03 integrate: compact metadata follows F11B lifecycle', () => {
  for (const mode of ['covered', 'purge', 'release', 'restore']) {
    it(`retains or clears structured metadata correctly on ${mode}`, () => {
      const db = openDb(':memory:');
      try {
        const store = new ChatStore(db);
        const sid = store.createSession().id;
        for (let i = 0; i < 7; i++) store.appendMessage({ id: `M${i}`, sessionId: sid,
          role: i % 2 === 0 ? 'user' : 'assistant', parts: [{ type: 'text', value: `turn ${i}` }], createdAt: i + 1, streamInterruptCount: 0 });
        const history = store.listMessages(sid);
        const reply = parseSummaryReply('【目标】\n- review\n【约束】\n- preserve history\n【已完成】\n- （无）\n【进行中】\n- （无）\n【待办】\n- report\n【关键决策】\n- （无）\n【涉及文件】\n- （无）');
        if (!reply.ok) throw new Error('bad fixture');
        const built = buildCompactMeta({ history, to: 1, rule: 'recent-turns', prev: undefined, reply, toolKindOf: defaultToolKindOf,
          record: { trigger: 'watermark', request: { estInput: 1, maxTokens: 2, attempts: 1 } } });
        const marker = store.appendCompactMarker(sid, built.summary, history[1].id, built.meta);
        const count = () => (db.prepare('SELECT COUNT(*) AS n FROM compact_marker_meta WHERE session_id=?').get(sid) as { n: number }).n;
        store.applyTombstone(sid, { v: 1, opId: 'REMOTE-1', originDeviceId: 'remote', at: 1,
          seen: makeSeen(mode === 'covered' ? history.map(m => m.id) : []) });
        expect(store.isDeleted(sid)).toBe(true);
        expect(() => store.appendCompactMarker(sid, built.summary, history[1].id, built.meta)).toThrow('会话已删除');
        if (mode === 'covered') expect(count()).toBe(0);
        else {
          expect(count()).toBe(1);
          if (mode === 'purge') { store.purgeRetained(sid); expect(count()).toBe(0); }
          if (mode === 'release') {
            store.applyTombstone(sid, { v: 1, opId: 'REMOTE-1', originDeviceId: 'remote', at: 1, seen: makeSeen(history.map(m => m.id)) });
            expect(count()).toBe(0);
          }
          if (mode === 'restore') {
            store.restoreSession(sid);
            expect(store.isDeleted(sid)).toBe(false);
            expect(count()).toBe(1);
            expect(store.getLatestCompactMarker(sid)).toEqual(marker);
          }
        }
      } finally { db.close(); }
    });
  }
});
