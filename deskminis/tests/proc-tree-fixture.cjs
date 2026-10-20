/* F09 fixture（不是测试）：进程树里的进程。Electron Node 模式运行（与引擎是同一个可执行文件，所以树里的进程、
 * 无关进程、引擎都是同名映像）。参数：<fx> <角色> <令牌> [--no-handshake] [--stderr-early]
 *
 * 角色：
 *  child          登记自己；起 leaf（普通）、leaf-detached（detached + unref）、bouncer；写心跳。
 *  leaf / leaf-detached / leaf-orphan   登记并写心跳。
 *  bouncer        登记自己，以 detached 起 leaf-orphan，然后立即退出：父链断开，taskkill /T 按父进程号找不到 leaf-orphan。
 *                 （为什么要 detached：Node 把普通子进程放进自己的 KILL_ON_JOB_CLOSE 作业，bouncer 一退 leaf-orphan 就跟着没了。）
 *  mcp            最小 MCP stdio server（initialize / tools/list / 一个 noop），启动即登记并按 child 的形状起树；stdin 关闭后不退出。
 *                 --no-handshake：永不应答 initialize。--stderr-early：第一件事是往 stderr 写一段不带换行的文本。
 *                 noop 的入参带 exit（数字）时以它为退出码退出；带 echo 时原样返回；带 dump 时返回 argv 与环境。
 *
 * 每个进程自限：<fx>\stop 出现，或存活满 15 分钟，就往心跳文件写一行 self-exit 然后退出。测试从不为清理而杀它们。 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const [fx, role, token, ...flags] = process.argv.slice(2);
const SELF = __filename;
const LIFE_MS = 15 * 60_000;
const born = Date.now();
const beatFile = path.join(fx, `beat-${role}-${process.pid}.log`);

function append(file, text) {
  // 多个进程同时追加同一个文件：Windows 上偶发 EBUSY，短暂重试；写不进去就算了（登记缺一行由测试按「没长成」处理）
  for (let i = 0; i < 20; i++) {
    try { fs.appendFileSync(file, text); return; } catch { /* 重试 */ }
  }
}
function register(as) {
  append(path.join(fx, 'procs.jsonl'), JSON.stringify({ role: as, pid: process.pid, ppid: process.ppid, at: Date.now(), token }) + '\n');
}
function sub(childRole, detached) {
  const c = spawn(process.execPath, [SELF, fx, childRole, token], {
    stdio: 'ignore', detached, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  c.on('error', () => { /* 起不来：测试按「没长成」处理 */ });
  if (detached) c.unref();
}
function heartbeat() {
  const tick = () => {
    if (fs.existsSync(path.join(fx, 'stop')) || Date.now() - born > LIFE_MS) {
      append(beatFile, 'self-exit\n');
      process.exit(0);
    }
    append(beatFile, Date.now() + '\n');
  };
  tick();
  setInterval(tick, 100);
}
function growTree() {
  sub('leaf', false);
  sub('leaf-detached', true);
  sub('bouncer', false);
}

if (role === 'bouncer') {
  register('bouncer');
  sub('leaf-orphan', true);
  // 等 leaf-orphan 的 CreateProcess 返回（spawn 是同步创建的），下一拍退出
  setTimeout(() => process.exit(0), 50);
} else if (role === 'child') {
  register('child');
  growTree();
  heartbeat();
} else if (role === 'mcp') {
  if (flags.includes('--stderr-early')) process.stderr.write('early-stderr-without-newline');
  // --no-tree：只当 MCP server，不登记、不起后代（参数 / 环境 / 退出码的差分用例一次要连几十台）
  if (!flags.includes('--no-tree')) { register('mcp'); growTree(); }
  heartbeat();
  const noHandshake = flags.includes('--no-handshake');
  const send = (m) => { process.stdout.write(JSON.stringify(m) + '\n'); };
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line === '') continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === 'initialize') {
        if (noHandshake) continue;
        send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'f09-fixture', version: '0' } } });
      } else if (msg.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'noop', description: 'F09 fixture', inputSchema: { type: 'object', properties: {} } }] } });
      } else if (msg.method === 'tools/call') {
        const a = (msg.params && msg.params.arguments) || {};
        if (typeof a.exit === 'number') process.exit(a.exit);
        const text = a.dump ? JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() })
          : typeof a.echo === 'string' ? a.echo : 'ok';
        send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text }] } });
      }
    }
  });
  // stdin 关闭后不退出：只靠自限与被回收
  process.stdin.on('end', () => { /* 留着 */ });
} else {
  register(role);
  heartbeat();
}
