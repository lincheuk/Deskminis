import { describe, expect, it } from 'vitest';
import { EventLog } from '../src/minisd/rpc/event-log';

describe('F06 close: physically redact deleted-session event retention', () => {
  it('replaces content and permission previews, releases retained strings, preserves sequence and other sessions', () => {
    const log = new EventLog({ epoch: 7 });
    log.append('chat.event', { sessionId: 'gone', event: { text: 'SECRET' } });
    log.append('permission.request', { req: { sessionId: 'gone', preview: { oldText: 'SECRET' } } });
    log.append('checkpoints.changed', { sessionId: 'gone', path: 'SECRET' });
    log.append('chat.sessions.lifecycle', { sessionId: 'gone', kind: 'deleted' });
    log.append('chat.sessions.changed', {});
    log.append('chat.event', { sessionId: 'other', event: { text: 'visible' } });
    expect(JSON.stringify(log.since(0))).toContain('SECRET');
    log.redactSession('gone');
    const frames = log.since(0);
    expect(Array.isArray(frames)).toBe(true);
    if (!Array.isArray(frames)) throw new Error('expected retained frames');
    expect(frames.map(f => f.ev)).toEqual([1, 2, 3, 4, 5, 6].map(seq => ({ epoch: 7, seq })));
    expect(frames.slice(0, 3).map(f => [f.method, f.params])).toEqual(Array.from({ length: 3 }, () => ['state.redacted', {}]));
    expect(frames.slice(3).map(f => f.method)).toEqual(['chat.sessions.lifecycle', 'chat.sessions.changed', 'chat.event']);
    expect(JSON.stringify((log as any).items)).not.toContain('SECRET');
    log.redactSession('gone');
    log.append('chat.event', { sessionId: 'gone', event: { text: 'after-explicit-restore' } });
    expect(log.lastSeq).toBe(7);
    expect(JSON.stringify(log.since(0))).not.toContain('SECRET');
    expect(JSON.stringify(log.since(6))).toContain('after-explicit-restore');
  });

  it('subtracts redacted byte counts before subsequent window eviction and honors replay limits', () => {
    const log = new EventLog({ epoch: 1, maxChars: 1000 });
    log.append('chat.event', { sessionId: 'gone', text: 'x'.repeat(700) });
    log.redactSession('gone');
    log.append('chat.event', { sessionId: 'other', text: 'y'.repeat(300) });
    expect(log.firstSeq).toBe(1);
    const frames = log.since(0);
    if (!Array.isArray(frames)) throw new Error('expected replay');
    const chars = frames.reduce((n, f) => n + JSON.stringify({ jsonrpc: '2.0', ...f }).length, 0);
    expect(log.since(0, chars)).toHaveLength(2);
    expect(log.since(0, chars - 1)).toBe('too-large');
    expect(log.lastSeq).toBe(2);
  });
});
