#!/usr/bin/env node
/** MCP stdio 测试桩（真子进程，纯 Node 零依赖）：stdin 按行读 JSON-RPC，stdout 按行应答。
 *  只服务 tests/mcp-stdio.test.ts——vitest 只收 *.test.ts，本文件不会被误当用例。
 *
 *  argv 开关：
 *   --no-init-response  收到 initialize 不应答（构造启动超时场景）
 *   --garbage-lines     每次输出前后混入非 JSON 行（考验客户端分帧容错：一行垃圾不能崩连接）
 *   --exit-after-init   收到 notifications/initialized 后 300ms 自行退出（构造进程崩溃）
 *   --env-echo          增加 envdump 工具：回传 arguments.name 指定环境变量的值
 *                       （验证 $$VAR 解析后的值真的进了子进程环境）
 *   --initdump          增加 initdump 工具：回传握手收到的 initialize 参数与 initialized 标记
 *   --paginated         tools/list 分两页（nextCursor 翻页）
 *   --batch-responses   所有输出攒 50ms 一次 write（制造「单 chunk 多条消息」）
 *   --slow-ms N         slow 工具应答前等待 N 毫秒（默认 1000）
 *   --server-request    握手完成后向客户端发一条带 id 的 server→client 请求（sampling 之类），
 *                       收到客户端应答后经 test/server-request-answered 通知回传，供断言
 *                       （D5：客户端对不支持的 server 请求回 -32601，否则对端挂等）
 */
import process from 'node:process';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : d;
};
const slowMs = Number(val('--slow-ms', '1000')) || 0;
const BATCH_MS = 50;
const garbage = flag('--garbage-lines');

// 顺手往 stderr 吐一行：让客户端的 stderr 限量采集路径在每条用例里都被真实走到
process.stderr.write('fixture stderr 诊断样例行\n');

let initParams = null; // 收到的 initialize 参数（initdump 回传，供握手断言）
let initialized = false; // 是否收到过 notifications/initialized

// --batch-responses：攒队列延后一次 write，两条应答必然落在同一个 stdout chunk 里
let queue = [];
let flushTimer = null;
function out(msg) {
  if (flag('--batch-responses')) {
    queue.push(msg);
    if (!flushTimer) flushTimer = setTimeout(flush, BATCH_MS);
  } else {
    writeLines([msg]);
  }
}
function flush() {
  flushTimer = null;
  const q = queue;
  queue = [];
  if (q.length > 0) writeLines(q);
}
function writeLines(msgs) {
  let s = '';
  if (garbage) s += 'not-json 调试垃圾行 {前}\n';
  for (const m of msgs) s += JSON.stringify(m) + '\n';
  if (garbage) s += 'not-json 调试垃圾行 [后]\n';
  process.stdout.write(s);
}

function toolsList() {
  const tools = [
    { name: 'echo', description: '原样回传 arguments', inputSchema: { type: 'object' } },
    { name: 'slow', description: '延迟应答', inputSchema: { type: 'object' } },
  ];
  if (flag('--env-echo')) tools.push({ name: 'envdump', description: '回传指定环境变量的值', inputSchema: { type: 'object' } });
  if (flag('--initdump')) tools.push({ name: 'initdump', description: '回传握手收到的内容', inputSchema: { type: 'object' } });
  return tools;
}

function handleLine(line) {
  const t = line.trim();
  if (t === '') return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return; // 客户端发来的行一定是合法 JSON；容错只是防御
  }
  if (!msg || typeof msg !== 'object') return;

  if (msg.method === 'initialize' && msg.id !== undefined) {
    initParams = msg.params ?? null;
    if (!flag('--no-init-response')) {
      // 服务器回什么版本客户端都要宽容接受——这里照抄请求版本即可
      out({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: initParams?.protocolVersion ?? '2025-06-18',
          capabilities: {},
          serverInfo: { name: 'fixture', version: '0.0.0' },
        },
      });
    }
    return;
  }
  if (msg.method === 'notifications/initialized') {
    initialized = true;
    if (flag('--server-request')) {
      // D5 -32601 用例：握手后发一条带 id 的 server→client 请求；客户端应答后回传通知
      out({ jsonrpc: '2.0', id: 999, method: 'sampling/createMessage', params: {} });
    }
    if (flag('--exit-after-init')) setTimeout(() => process.exit(0), 300);
    return;
  }
  // 客户端对 server 请求的应答：id=999 配对，经通知原样回传供断言
  if (msg.id === 999 && (msg.result !== undefined || msg.error !== undefined)) {
    out({ jsonrpc: '2.0', method: 'test/server-request-answered', params: { answer: msg } });
    return;
  }
  if (msg.method === 'notifications/cancelled') {
    // 收到取消通知立即回一条测试通知，让用例能断言「取消已透传到 server」
    out({ jsonrpc: '2.0', method: 'test/cancelled-received', params: { requestId: msg.params?.requestId } });
    return;
  }
  if (msg.method === 'tools/list' && msg.id !== undefined) {
    if (flag('--paginated')) {
      // 两页：第 1 页只给第一个工具并带 nextCursor，第 2 页给余下的
      if (msg.params?.cursor === 'page2') {
        out({ jsonrpc: '2.0', id: msg.id, result: { tools: toolsList().slice(1) } });
      } else {
        out({ jsonrpc: '2.0', id: msg.id, result: { tools: toolsList().slice(0, 1), nextCursor: 'page2' } });
      }
    } else {
      out({ jsonrpc: '2.0', id: msg.id, result: { tools: toolsList() } });
    }
    return;
  }
  if (msg.method === 'tools/call' && msg.id !== undefined) {
    const name = msg.params?.name;
    const callArgs = msg.params?.arguments ?? {};
    if (name === 'echo') {
      out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(callArgs) }] } });
    } else if (name === 'slow') {
      // 故意在取消/超时后仍应答：考验客户端对「迟到响应」的丢弃
      setTimeout(() => out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'slow done' }] } }), slowMs);
    } else if (name === 'envdump') {
      out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: process.env[callArgs.name] ?? '' }] } });
    } else if (name === 'initdump') {
      out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ initialize: initParams, initializedReceived: initialized }) }] } });
    } else {
      out({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: `unknown tool: ${name}` } });
    }
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    handleLine(line);
  }
});
