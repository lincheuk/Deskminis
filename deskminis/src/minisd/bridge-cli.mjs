#!/usr/bin/env node
/**
 * DeskMinis windows-* 桥 CLI（薄 stub）：argv/stdin → 命名管道一帧请求 → minisd → 一帧信封 → stdout。
 * 零依赖单文件（架构决策 1：开发期 node 直跑；M4 用 Node SEA 打成 exe）。
 * 正常调用方式（DeskMinis 会话 shell 内环境变量已注入）：
 *   & "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" <工具> [动作] [--参数 值 ...]
 */
import net from 'node:net';

const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 5000;
/** 读响应上限 180s：30s 权限询问 + 120s 语音播报 + 余量（架构决策见计划）。 */
const READ_TIMEOUT_MS = 180000;

const EXIT = { OK: 0, ERROR: 1, DENIED: 2, ARGS: 3, UNAVAILABLE: 4 };

const GLOBAL_HELP = `DeskMinis windows-* 桥 CLI（在 DeskMinis 会话 shell 中使用）

用法:
  <工具> [动作] [--参数 值 ...] [-q|--compact] [--stdin]
  实际路径经环境变量传入，通常这样调用:
    & "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" <工具> ...

工具:
  windows-notify       弹 Windows 系统通知
  windows-clipboard    读/写剪贴板文本
  windows-open         用默认程序打开网址或文件
  windows-speak        语音播报文本（TTS）
  windows-screenshot   截取全部屏幕保存到会话附件目录
  windows-device       读取系统信息（版本/计算机名/内存等）

全局旗标:
  -q, --compact   单行紧凑 JSON 输出（默认两空格美化）
  --stdin         从标准输入读取文本载荷（clipboard set / speak 用；必须显式给出，见架构决策 7）
  --help          本说明；<工具> --help 查看该工具参数

退出码:
  0 成功 / 1 一般错误 / 2 权限被拒绝 / 3 参数错误 / 4 桥服务不可达

输出: stdout 恒为 JSON 信封 { ok, tool, action, data | error, timestamp }
示例:
  & "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" windows-notify --title 你好 --body 任务完成
  & "$env:MINIS_BRIDGE_NODE" "$env:MINIS_BRIDGE_CLI" windows-clipboard get -q
`;

/** 工具规格表：动作集合/默认动作/位置参数槽/参数白名单/工具级帮助。六桥与 minisd 侧 BRIDGES 表一一对应。 */
const TOOLS = {
  'windows-notify': {
    actions: ['show'], defaultAction: 'show', positionalArg: null, params: ['title', 'body'],
    help: `windows-notify [show] [--title 标题] [--body 正文]

弹 Windows 系统通知（toast）。
  --title   通知标题，默认 "DeskMinis"
  --body    通知正文，默认空`,
  },
  'windows-clipboard': {
    actions: ['get', 'set'], defaultAction: 'get', positionalArg: null, params: ['text'],
    help: `windows-clipboard [get]
windows-clipboard set (--text 文本 | --stdin)

读/写剪贴板文本。读取是隐私敏感操作，首次使用会向用户请求确认。
  get       输出 { text, truncated }（超过 1MB 截断）
  set       写入文本，输出 { length }；文本经 --text 或 --stdin 提供`,
  },
  'windows-open': {
    actions: ['open'], defaultAction: 'open', positionalArg: 'target', params: ['target'],
    help: `windows-open [open] <目标>

用默认程序打开网址或本机文件/目录。目标也可写作 --target <目标>。
目标必须是 http(s) 网址或已存在的本机路径，否则报 INVALID_ARGS。`,
  },
  'windows-speak': {
    actions: ['say'], defaultAction: 'say', positionalArg: null, params: ['text', 'rate'],
    help: `windows-speak [say] (--text 文本 | --stdin) [--rate -10..10]

语音播报文本（System.Speech TTS）。
  --text    要播报的文本（或用 --stdin 从标准输入读）
  --rate    语速 -10（最慢）..10（最快），默认 0`,
  },
  'windows-screenshot': {
    actions: ['capture'], defaultAction: 'capture', positionalArg: null, params: [],
    help: `windows-screenshot [capture]

截取全部屏幕，PNG 保存到会话附件目录，输出 { path, width, height, bytes }。
隐私敏感操作，首次使用会向用户请求确认。`,
  },
  'windows-device': {
    actions: ['info'], defaultAction: 'info', positionalArg: null, params: [],
    help: `windows-device [info]

读取系统信息，输出 { osVersion, computerName, userName, cpuCount, totalMemoryMB, psVersion }。
只读操作，不触发权限确认。`,
  },
};

// ---------- 帧编解码：Task 1 算法的最小副本（有意重复，保持 stub 零依赖单文件） ----------

function encodeFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  if (body.length > MAX_FRAME_BYTES) throw new Error(`帧体 ${body.length} 超过上限 ${MAX_FRAME_BYTES}`);
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

class FrameDecoder {
  constructor(maxBytes = MAX_FRAME_BYTES) { this.maxBytes = maxBytes; this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    const out = [];
    while (true) {
      if (this.buf.length < 4) return out;
      const len = this.buf.readUInt32BE(0);
      if (len > this.maxBytes) { this.buf = Buffer.alloc(0); throw new Error(`帧长度 ${len} 超过上限 ${this.maxBytes}`); }
      if (this.buf.length < 4 + len) return out;
      out.push(this.buf.subarray(4, 4 + len));
      this.buf = this.buf.subarray(4 + len);
    }
  }
}

// ---------- argv 解析 ----------

class ArgsError extends Error {}

/** 全局旗标 -q/--compact、--stdin 先于 --参数 识别；其余 --key 必须带值（值不能以 -- 开头）。 */
function parseArgs(argv) {
  const args = {};
  const positional = [];
  let compact = false;
  let useStdin = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-q' || a === '--compact') { compact = true; continue; }
    if (a === '--stdin') { useStdin = true; continue; }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (!key) throw new ArgsError('非法参数: --');
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) throw new ArgsError(`参数 --${key} 缺少值`);
      args[key] = val;
      i++;
      continue;
    }
    if (a.startsWith('-') && a !== '-') throw new ArgsError(`未知旗标: ${a}`);
    positional.push(a);
  }
  return { args, positional, compact, useStdin };
}

/** 动作解析：第二位置参数命中动作集则消费之（否则用默认动作）；windows-open 的下一个位置参数进 target 槽。 */
function resolveAction(spec, positional, args) {
  const rest = positional.slice(1);
  let action = spec.defaultAction;
  if (rest.length > 0 && spec.actions.includes(rest[0])) action = rest.shift();
  if (spec.positionalArg && rest.length > 0) {
    if (args[spec.positionalArg] !== undefined) throw new ArgsError(`目标重复：位置参数与 --${spec.positionalArg} 同时给出`);
    args[spec.positionalArg] = rest.shift();
  }
  if (rest.length > 0) throw new ArgsError(`未知动作或多余的位置参数: ${rest.join(' ')}`);
  return action;
}

// ---------- stdin / 管道 ----------

function readStdin() {
  return new Promise((resolvePromise, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => resolvePromise(data));
    process.stdin.on('error', reject);
  });
}

/** 一次性管道客户端：连上 → 发已编码帧 → 等一帧信封 → 关。任何失败 reject（调用方归一为 BRIDGE_UNAVAILABLE）。 */
function requestEnvelope(pipePath, wire) {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const socket = net.connect(pipePath);
    const decoder = new FrameDecoder();
    const done = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(readTimer);
      socket.destroy();
      fn(v);
    };
    const connectTimer = setTimeout(() => done(reject, new Error('连接桥服务超时（5s）')), CONNECT_TIMEOUT_MS);
    let readTimer;
    socket.on('error', e => done(reject, e));
    socket.on('connect', () => {
      clearTimeout(connectTimer);
      readTimer = setTimeout(() => done(reject, new Error(`等待桥服务响应超时（${READ_TIMEOUT_MS / 1000}s）`)), READ_TIMEOUT_MS);
      socket.write(wire);
    });
    socket.on('data', chunk => {
      let frames;
      try { frames = decoder.push(chunk); } catch (e) { done(reject, e); return; }
      if (frames.length === 0) return;
      try { done(resolvePromise, JSON.parse(frames[0].toString('utf8'))); }
      catch { done(reject, new Error('桥服务响应不是合法 JSON')); }
    });
    socket.on('close', () => done(reject, new Error('桥服务未应答即断开连接')));
  });
}

// ---------- 输出与退出码 ----------

function formatEnvelope(env, compact) {
  return compact ? JSON.stringify(env) + '\n' : JSON.stringify(env, null, 2) + '\n';
}

function localEnvelope(tool, action, code, message) {
  return { ok: false, tool, action, error: { code, message }, timestamp: Date.now() / 1000 };
}

/** 信封 error.code → 进程退出码（架构决策 4；语义同时写进 --help 固化）。 */
function exitCodeFor(env) {
  if (env.ok) return EXIT.OK;
  const code = env.error && env.error.code;
  if (code === 'PERMISSION_DENIED') return EXIT.DENIED;
  if (code === 'INVALID_ARGS') return EXIT.ARGS;
  if (code === 'BRIDGE_UNAVAILABLE') return EXIT.UNAVAILABLE;
  return EXIT.ERROR;
}

/** stdout 是管道时 write 异步 flush，直接 process.exit 会截断输出——等写完再退。 */
function writeOutThenExit(text, code) {
  process.stdout.write(text, () => process.exit(code));
}

function fail(tool, action, code, message, exitCode, compact) {
  writeOutThenExit(formatEnvelope(localEnvelope(tool, action, code, message), compact), exitCode);
}

async function main() {
  const argv = process.argv.slice(2);

  // --help 优先于一切：纯文本输出（非信封），全局级或工具级
  if (argv.includes('--help') || argv.includes('-h')) {
    const name = argv.find(a => !a.startsWith('-'));
    const spec = name ? TOOLS[name] : undefined;
    writeOutThenExit((spec ? spec.help : GLOBAL_HELP) + '\n', EXIT.OK);
    return;
  }

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    fail('', '', 'INVALID_ARGS', e.message, EXIT.ARGS, false);
    return;
  }
  const { args, positional, compact, useStdin } = parsed;

  const tool = positional[0];
  if (!tool) {
    fail('', '', 'INVALID_ARGS', '缺少工具名；运行 --help 查看用法', EXIT.ARGS, compact);
    return;
  }
  const spec = TOOLS[tool];
  if (!spec) {
    fail(tool, '', 'INVALID_ARGS', `未知工具: ${tool}（支持 ${Object.keys(TOOLS).join(' / ')}）`, EXIT.ARGS, compact);
    return;
  }
  let action;
  try {
    action = resolveAction(spec, positional, args);
  } catch (e) {
    fail(tool, '', 'INVALID_ARGS', e.message, EXIT.ARGS, compact);
    return;
  }

  // 参数白名单校验：先于环境检查（e2e 缺陷发现：--action set 被静默吞成默认动作）
  const unknownKeys = Object.keys(args).filter(k => !spec.params.includes(k));
  if (unknownKeys.length > 0) {
    const unknownDisplay = unknownKeys.map(k => `--${k}`).join('、');
    const supportedDisplay = spec.params.length
      ? spec.params.map(p => `--${p}`).join(' ')
      : '(无参数)';
    const paramsHint = spec.params.length ? `，支持参数：${supportedDisplay}` : '，不支持任何参数';
    const tip = `未知参数 ${unknownDisplay}${paramsHint}；动作是位置参数（如：${tool} ${action} ${supportedDisplay.trimEnd() ? '--参数 值' : ''}）。运行 \`${tool} --help\` 查看详情。`;
    fail(tool, action, 'INVALID_ARGS', tip, EXIT.ARGS, compact);
    return;
  }

  // 环境契约：会话 id 缺失属用法错误（3）；管道缺失/空串（桥降级）属服务不可达（4）
  const sessionId = process.env.MINIS_CHAT_SESSION_ID;
  if (!sessionId) {
    fail(tool, action, 'INVALID_ARGS', '缺少环境变量 MINIS_CHAT_SESSION_ID；桥命令只能在 DeskMinis 会话 shell 中调用', EXIT.ARGS, compact);
    return;
  }
  const pipePath = process.env.MINIS_BRIDGE_PIPE;
  if (!pipePath) {
    fail(tool, action, 'BRIDGE_UNAVAILABLE', '缺少环境变量 MINIS_BRIDGE_PIPE：桥服务不可达（minisd 未启动或桥监听失败）', EXIT.UNAVAILABLE, compact);
    return;
  }

  const req = { tool, action, args, sessionId };
  if (useStdin) req.stdin = await readStdin();

  // 先编码再连接：载荷超 16MB 是本地参数问题（退出 3），不应混进"桥不可达"（退出 4）
  let wire;
  try {
    wire = encodeFrame(req);
  } catch (e) {
    fail(tool, action, 'INVALID_ARGS', `载荷过大: ${e.message}`, EXIT.ARGS, compact);
    return;
  }

  let env;
  try {
    env = await requestEnvelope(pipePath, wire);
  } catch (e) {
    fail(tool, action, 'BRIDGE_UNAVAILABLE', `桥服务不可达: ${e.message}`, EXIT.UNAVAILABLE, compact);
    return;
  }
  writeOutThenExit(formatEnvelope(env, compact), exitCodeFor(env));
}

main().catch(e => {
  writeOutThenExit(formatEnvelope(localEnvelope('', '', 'INTERNAL_ERROR', e instanceof Error ? e.message : String(e)), false), EXIT.ERROR);
});
