/** L5 会话级 MCP 勾选 UI 守卫（设计稿 2026-08-20-pool-batch-design.md §5）。
 *  后端全通（sessions.mcp_disabled_json + chat.sessions.setMcpDisabled + 双保险执行），
 *  本步纯补 renderer 入口——守卫锚定：store 镜像 + composer pill + 行内面板（wspanel 成例）。
 *  .vue 不进 typecheck，故按源文接线断言（renderer-* 守卫成例）。 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const { _rpcCall, _rpcOn, _handlers, _rpcLost, _rpcConnect } = vi.hoisted(() => {
  const handlers = new Map<string, (params: any) => unknown>();
  return { _rpcCall: vi.fn(), _rpcOn: vi.fn((method: string, handler: (params: any) => unknown) => { handlers.set(method, handler); }), _handlers: handlers, _rpcLost: vi.fn(), _rpcConnect: vi.fn(async () => {}) };
});
vi.mock('../src/renderer/src/rpc', () => ({ rpc: { call: _rpcCall, on: _rpcOn, onLost: _rpcLost, connect: _rpcConnect } }));

import fs from 'node:fs';
import path from 'node:path';

import { resetStoreRpc, initStore, deferred, type Equal, type Chat, type SessionRow } from './renderer-store-fixture';

const root = path.resolve(__dirname, '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');

const _probe = { call: _rpcCall, on: _rpcOn, handlers: _handlers, lost: _rpcLost, connect: _rpcConnect };
// 每例使用新的真实 Pinia；RPC 桩只记调用与订阅，由用例放行应答。
beforeEach(() => { resetStoreRpc(_probe); });
afterEach(() => { vi.restoreAllMocks(); });

describe('L5 store：sessions 镜像 mcpDisabled + setSessionMcpDisabled 动作', () => {
  it('sessions 类型带 mcpDisabled；动作调 chat.sessions.setMcpDisabled 后重拉列表', async () => {
    // 后端会话声明精确相等，mcpDisabled 必须可选字符串数组；应答列表才改本地镜像。
    const sessionType: true = true as Equal<Chat['sessions'], SessionRow[]>;
    expect(sessionType).toBe(true);
    const chat = await initStore(_probe);
    for (const servers of [[], ['one', 'two']]) {
      const reply = [{ id: 'S', title: 'session', mcpDisabled: servers }];
      const gate = deferred();
      _rpcCall.mockClear();
      _rpcCall.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(reply);
      const setting = chat.setSessionMcpDisabled('S', servers);
      expect(_rpcCall.mock.calls).toEqual([['chat.sessions.setMcpDisabled', { sessionId: 'S', servers }]]);
      gate.resolve({ ok: true });
      await setting;
      expect(_rpcCall.mock.calls).toEqual([['chat.sessions.setMcpDisabled', { sessionId: 'S', servers }], ['chat.sessions.list']]);
      expect(chat.sessions).toEqual(reply);
    }
    // 写失败不重拉，切片伸到文件尾也不能让这条空转通过。
    _rpcCall.mockClear();
    _rpcCall.mockRejectedValueOnce(new Error('rejected'));
    await expect(chat.setSessionMcpDisabled('S', ['one'])).rejects.toThrow('rejected');
    expect(_rpcCall.mock.calls).toEqual([['chat.sessions.setMcpDisabled', { sessionId: 'S', servers: ['one'] }]]);
  });
});

/* T6e-3 曾把「L5 ChatView：composer MCP pill + 行内面板」整组退场（能力随 ChatView 丢失，ui/ 零引用）；
   Y2（2026-09-10）在 ui/Composer.vue 上补回，本组复位、重指新树。 */
describe('L5 Composer：MCP pill + 行内面板（Y2 复位）', () => {
  it('pill 显隐取决于「有会话 + 存在已启用 server」，面板逐台勾选调 setSessionMcpDisabled', () => {
    const c = read('src/renderer/src/ui/Composer.vue');
    expect(c).toContain('mcpPillVisible');
    expect(c).toMatch(/class="mcpbtn"/);
    expect(c).toMatch(/class="mcpanel"/);
    expect(c).toMatch(/\.setSessionMcpDisabled\(/);
    // 计数只数「已启用 ∩ 已禁用」——名单里可能残留已全局删除的 server 名
    expect(c).toMatch(/enabledMcpServers\.value\.filter\(s => sessionMcpDisabled\.value\.includes\(s\.name\)\)/);
  });
});
