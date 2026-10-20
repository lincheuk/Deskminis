/** Q14：ChatStore.listMessagesAfter——调用方手里已有会话开头的一段时，只给排在它之后的消息；接不上就返回 undefined。
 *
 *  钉的性质只有一条：凡是返回了数组，「调用方手里的那一段 + 返回的数组」必须与 listMessages 逐字段相同。
 *  返回 undefined 永远是安全的（调用方改取完整列表），所以另外钉住哪些情形必须接得上、哪些必须接不上。 */
import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/minisd/store/db';
import { ChatStore } from '../src/minisd/store/chat-store';
import type { RawMessage } from '../src/shared/types';
import type { SyncPayload } from '../src/minisd/sync/wire';

let db: Database.Database;
let store: ChatStore;
let sid: string;
let other: string;

function append(id: string, at: number, session = sid): void {
  store.appendMessage({ id, sessionId: session, role: 'user', parts: [{ type: 'text', value: `内容 ${id}` }], createdAt: at, streamInterruptCount: 0 });
}
/** 经同步合并进来一条消息（真实的 mergeRemoteSession，不是直接写库）。 */
function mergeIn(id: string, at: number): void {
  const payload: SyncPayload = {
    messages: [{
      id, sessionId: sid, role: 'user', partsJson: JSON.stringify([{ type: 'text', value: `对端 ${id}` }]),
      tokenUsageJson: null, reasoningContent: null, streamInterruptCount: 0, sortOrder: 0,
      createdAt: at, updatedAt: at, originDeviceId: 'peer', createdLocallyAt: at,
    }],
    markers: [],
  };
  expect(store.mergeRemoteSession(payload, sid, { fromPeer: 'peer' })).toMatchObject({ mergedCount: 1 });
}
const ids = (ms: readonly RawMessage[] | undefined): string[] | undefined => ms?.map(m => m.id);
/** 手里是当前列表的前 k 条。 */
const haveFirst = (k: number): { count: number; lastId?: string } => {
  const list = store.listMessages(sid);
  return k === 0 ? { count: 0 } : { count: k, lastId: list[k - 1].id };
};

beforeEach(() => {
  db = openDb(':memory:');
  store = new ChatStore(db, 'A');
  sid = store.createSession('会话').id;
  other = store.createSession('另一个会话').id;
  for (let i = 0; i < 6; i++) append(`M${i}`, 100 + i * 10);
  append('X0', 105, other);
  append('X1', 205, other);
});

describe('Q14 listMessagesAfter：接得上的情形', () => {
  it('手里是前 k 条（k 从 0 到全部）：给的正是其余的，拼起来与完整列表逐字段相同', () => {
    const full = store.listMessages(sid);
    for (let k = 0; k <= full.length; k++) {
      const rest = store.listMessagesAfter(sid, haveFirst(k));
      expect(rest, `k=${k}`).toEqual(full.slice(k));
      expect(JSON.stringify([...full.slice(0, k), ...rest!])).toBe(JSON.stringify(full));
    }
  });

  it('手里是全部：给空数组，不是 undefined（没有新消息也算接得上）', () => {
    expect(store.listMessagesAfter(sid, haveFirst(6))).toEqual([]);
  });

  it('之后本机落了新消息：只给新落的', () => {
    const have = haveFirst(6);
    append('N1', 300); append('N2', 310);
    expect(ids(store.listMessagesAfter(sid, have))).toEqual(['N1', 'N2']);
  });

  it('同步合并进来的消息排在手里最后一条之后：照样只给新的，顺序是列表顺序', () => {
    const have = haveFirst(6);
    append('N1', 300);
    mergeIn('P1', 250); // 比 N1 早、比手里最后一条（150）晚
    expect(ids(store.listMessagesAfter(sid, have))).toEqual(['P1', 'N1']);
    expect(ids(store.listMessages(sid))).toEqual(['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'P1', 'N1']);
  });

  it('时间相同按 id 排：与手里最后一条同一时刻、id 更大的算在之后', () => {
    const have = haveFirst(6); // 最后一条是 M5 @150
    mergeIn('M9', 150);
    expect(ids(store.listMessagesAfter(sid, have))).toEqual(['M9']);
  });

  it('别的会话多了消息不影响这个会话', () => {
    const have = haveFirst(6);
    append('X2', 120, other); append('X3', 400, other);
    expect(store.listMessagesAfter(sid, have)).toEqual([]);
  });

  it('空会话、手里 0 条：给空数组', () => {
    const empty = store.createSession('空的').id;
    expect(store.listMessagesAfter(empty, { count: 0 })).toEqual([]);
  });
});

describe('Q14 listMessagesAfter：接不上的情形（返回 undefined，调用方取完整列表）', () => {
  it('同步合并进来一条时间更早的消息：手里的不再是开头一段', () => {
    const have = haveFirst(6);
    mergeIn('P0', 115); // 排在 M1 与 M2 之间
    expect(store.listMessagesAfter(sid, have)).toBeUndefined();
    expect(ids(store.listMessages(sid))).toEqual(['M0', 'M1', 'P0', 'M2', 'M3', 'M4', 'M5']);
  });

  it('时间相同按 id 排：与手里最后一条同一时刻、id 更小的排在它之前', () => {
    const have = haveFirst(6); // 最后一条是 M5 @150
    mergeIn('M4Z', 150);
    expect(store.listMessagesAfter(sid, have)).toBeUndefined();
  });

  it('手里只有前 3 条时，早于第 3 条的插入接不上，晚于它的接得上', () => {
    const have = haveFirst(3); // M0 M1 M2，最后一条 @120
    mergeIn('LATE', 125);
    expect(ids(store.listMessagesAfter(sid, have))).toEqual(['LATE', 'M3', 'M4', 'M5']);
    mergeIn('EARLY', 95);
    expect(store.listMessagesAfter(sid, have)).toBeUndefined();
  });

  it('lastId 不是这个会话的消息：别的会话的、根本不存在的', () => {
    expect(store.listMessagesAfter(sid, { count: 1, lastId: 'X0' })).toBeUndefined();
    expect(store.listMessagesAfter(sid, { count: 6, lastId: 'NOPE' })).toBeUndefined();
    // 条数恰好对得上也不行：X1 @205 排在这个会话 6 条之后，按时间数正好是 6
    expect(store.listMessagesAfter(sid, { count: 6, lastId: 'X1' })).toBeUndefined();
  });

  it('条数对不上：多报、少报', () => {
    expect(store.listMessagesAfter(sid, { count: 5, lastId: 'M5' })).toBeUndefined();
    expect(store.listMessagesAfter(sid, { count: 7, lastId: 'M5' })).toBeUndefined();
    expect(store.listMessagesAfter(sid, { count: 2, lastId: 'M3' })).toBeUndefined();
  });

  it('会话被整个删掉之后', () => {
    const have = haveFirst(6);
    store.deleteSession(sid);
    expect(store.listMessagesAfter(sid, have)).toBeUndefined();
    expect(store.listMessages(sid)).toEqual([]);
  });

  it.each([
    ['null', null], ['字符串', 'M5'], ['数字', 6], ['数组', [6, 'M5']], ['空对象', {}],
    ['count 是字符串', { count: '6', lastId: 'M5' }], ['count 是小数', { count: 5.5, lastId: 'M5' }],
    ['count 是负数', { count: -1, lastId: 'M5' }], ['count 是 NaN', { count: Number.NaN, lastId: 'M5' }],
    ['有 count 没有 lastId', { count: 6 }], ['lastId 是数字', { count: 6, lastId: 5 }], ['lastId 是 null', { count: 6, lastId: null }],
    ['lastId 是对象', { count: 6, lastId: {} }], ['lastId 是数组', { count: 6, lastId: ['M5'] }], ['undefined', undefined],
    ['count 是字符串 "0"', { count: '0' }], ['count 是 null', { count: null, lastId: 'M5' }],
  ])('have 的形状不对（%s）：不抛错，返回 undefined', (_name, have) => {
    expect(store.listMessagesAfter(sid, have)).toBeUndefined();
  });
});

describe('Q14 listMessagesAfter：随机序列', () => {
  /** 确定的伪随机数（同一份种子每次跑出同一串）。 */
  const rng = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };

  it('200 轮：本机追加与同步合并（更早、更晚、同一时刻）穿插，凡是接得上的，拼起来都与完整列表逐字节相同', () => {
    const rand = rng(0x14);
    let joined = 0, refused = 0, n = 0;
    for (let round = 0; round < 200; round++) {
      const before = store.listMessages(sid);
      const k = Math.floor(rand() * (before.length + 1));
      const held = before.slice(0, k);
      const have = k === 0 ? { count: 0 } : { count: k, lastId: held[k - 1].id };
      const ops = 1 + Math.floor(rand() * 3);
      let insertedBeforeHeld = false;
      for (let o = 0; o < ops; o++) {
        const id = `R${String(n++).padStart(4, '0')}`;
        const pick = rand();
        const span = before.length ? before[before.length - 1].createdAt - before[0].createdAt : 0;
        if (pick < 0.4) {
          const max = store.listMessages(sid).at(-1)!.createdAt;
          append(id, max + 1 + Math.floor(rand() * 5));
        } else if (pick < 0.7) {
          const at = before[0].createdAt - 5 + Math.floor(rand() * (span + 10)); // 任意位置，可能早于第一条
          mergeIn(id, at);
          if (k > 0 && (at < held[k - 1].createdAt || (at === held[k - 1].createdAt && id < held[k - 1].id))) insertedBeforeHeld = true;
        } else {
          const at = before[Math.floor(rand() * before.length)].createdAt; // 与某条已有消息同一时刻
          mergeIn(id, at);
          if (k > 0 && (at < held[k - 1].createdAt || (at === held[k - 1].createdAt && id < held[k - 1].id))) insertedBeforeHeld = true;
        }
      }
      const full = store.listMessages(sid);
      const rest = store.listMessagesAfter(sid, have);
      // 接不接得上只取决于有没有消息排到了手里那一段里面
      expect(rest === undefined, `第 ${round} 轮`).toBe(insertedBeforeHeld);
      if (rest === undefined) { refused++; continue; }
      joined++;
      // 手里那一段的 sortOrder 可能在合并里被改过（界面不读它）：比对时用库里此刻的那一段
      expect(held.map(m => m.id)).toEqual(full.slice(0, k).map(m => m.id));
      expect(JSON.stringify([...full.slice(0, k), ...rest])).toBe(JSON.stringify(full));
    }
    // 两种结果都要出现过足够多次，不然这条用例什么都没钉住
    expect(joined).toBeGreaterThan(60);
    expect(refused).toBeGreaterThan(30);
  });
});

describe('Q14 listMessagesAfter：不读消息正文就能判断接不接得上', () => {
  it('数「排到 lastId 为止有几条」的那条语句只走索引（查询计划里是 COVERING INDEX）', () => {
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) n FROM messages WHERE session_id=? AND (created_at, id) <= (?, ?)').all('s', 1, 'x') as Array<{ detail: string }>;
    expect(plan.map(p => p.detail).join(' | ')).toMatch(/USING COVERING INDEX idx_messages_session/);
  });
  it('取「排在 lastId 之后」的那条语句按索引定位，不扫整个会话之外的行', () => {
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM messages WHERE session_id=? AND (created_at, id) > (?, ?) ORDER BY created_at ASC, id ASC').all('s', 1, 'x') as Array<{ detail: string }>;
    const text = plan.map(p => p.detail).join(' | ');
    expect(text).toMatch(/USING INDEX idx_messages_session \(session_id=\? AND/);
    expect(text).not.toMatch(/TEMP B-TREE/); // 顺序直接来自索引，不另排序
  });
});
