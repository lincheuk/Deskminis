#!/usr/bin/env node
/**
 * DeskMinis 同步 CLI（M3b）：status / pull / push。
 *
 * 连本端 minisd 走 WS（?token=，local 模式）；port+token 经 env MINISD_PORT/MINISD_TOKEN 或 --port/--token。
 * 手动同步按钮等价命令行（设计 §1-M3b「两触达」之 B）。
 *
 * 退出码：0 成功 / 1 一般错误 / 2 缺 MINISD_PORT/MINISD_TOKEN / 3 参数错误
 */
import WebSocket from 'ws';

const EXIT = { OK: 0, ERROR: 1, NO_ENV: 2, ARGS: 3 };
const RPC_TIMEOUT_MS = 5000;

/** WS JSON-RPC 单次调用（local 模式，?token=）。 */
function rpc(port, token, method, params) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${token}`);
    const timer = setTimeout(() => { ws.terminate(); rej(new Error('连接 minisd 超时')); }, RPC_TIMEOUT_MS);
    ws.on('error', e => { clearTimeout(timer); rej(e); });
    ws.on('open', () => {
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));
      ws.on('message', d => {
        clearTimeout(timer);
        ws.close();
        res(JSON.parse(String(d)));
      });
    });
  });
}

function parseGlobalArgs(argv) {
  const out = {
    port: process.env.MINISD_PORT,
    token: process.env.MINISD_TOKEN,
    rest: [],
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') { out.port = argv[++i]; continue; }
    if (argv[i] === '--token') { out.token = argv[++i]; continue; }
    if (argv[i] === '--help' || argv[i] === '-h') { out.help = true; continue; }
    out.rest.push(argv[i]);
  }
  return out;
}

const HELP = `DeskMinis 同步 CLI（M3b）

用法: node sync-cli.mjs <子命令> [参数] [--port <n>] [--token <t>]
环境: MINISD_PORT / MINISD_TOKEN（或 --port / --token）

子命令:
  status                列出本地会话 + cursor
  pull <sid|all>        拉取本地会话（自拉自，验证链路通；all 拉全部）
  push <sid>            从 stdin 读 JSON payload 推送到本地会话

退出码: 0 成功 / 1 一般错误 / 2 缺 MINISD_PORT/MINISD_TOKEN / 3 参数错误
`;

async function main() {
  const args = parseGlobalArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); process.exit(EXIT.OK); return; }
  if (args.rest.length === 0) { process.stderr.write('缺少子命令\n\n' + HELP); process.exit(EXIT.ARGS); return; }
  const cmd = args.rest[0];
  if (!['status', 'pull', 'push'].includes(cmd)) {
    process.stderr.write(`未知子命令: ${cmd}\n\n${HELP}`); process.exit(EXIT.ARGS); return;
  }
  if (!args.port || !args.token) {
    process.stderr.write('缺少 MINISD_PORT/MINISD_TOKEN（用 --port/--token 或 env 传入）\n');
    process.exit(EXIT.NO_ENV); return;
  }

  try {
    if (cmd === 'status') {
      const r = await rpc(args.port, args.token, 'sync.list', {});
      if (r.error) throw new Error(r.error.message);
      const sessions = r.result.sessions ?? [];
      process.stdout.write(JSON.stringify({ sessions }, null, 2) + '\n');
      process.exit(EXIT.OK);
    } else if (cmd === 'pull') {
      const sid = args.rest[1];
      if (!sid) { process.stderr.write('pull 需要 <sid|all>\n'); process.exit(EXIT.ARGS); return; }
      if (sid === 'all') {
        const lr = await rpc(args.port, args.token, 'sync.list', {});
        if (lr.error) throw new Error(lr.error.message);
        const sids = (lr.result.sessions ?? []).map(s => s.id);
        for (const id of sids) {
          const r = await rpc(args.port, args.token, 'sync.pull', { sessionId: id, afterTs: 0 });
          if (r.error) throw new Error(r.error.message);
          const { messages, markers } = r.result;
          process.stdout.write(`${id}: ${messages.length} msgs, ${markers.length} markers\n`);
        }
      } else {
        const r = await rpc(args.port, args.token, 'sync.pull', { sessionId: sid, afterTs: 0 });
        if (r.error) throw new Error(r.error.message);
        const { messages, markers } = r.result;
        process.stdout.write(`${sid}: ${messages.length} msgs, ${markers.length} markers\n`);
      }
      process.exit(EXIT.OK);
    } else if (cmd === 'push') {
      const sid = args.rest[1];
      if (!sid) { process.stderr.write('push 需要 <sid>\n'); process.exit(EXIT.ARGS); return; }
      // 从 stdin 读 JSON payload
      const chunks = [];
      await new Promise(res => {
        process.stdin.on('data', c => chunks.push(c));
        process.stdin.on('end', res);
        process.stdin.on('error', res);
      });
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { process.stderr.write('stdin 不是合法 JSON\n'); process.exit(EXIT.ARGS); return; }
      const r = await rpc(args.port, args.token, 'sync.push', { sessionId: sid, payload });
      if (r.error) throw new Error(r.error.message);
      process.stdout.write(JSON.stringify(r.result) + '\n');
      process.exit(EXIT.OK);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`错误: ${msg}\n`);
    process.exit(EXIT.ERROR);
  }
}

main();
