#!/usr/bin/env node
// DeskMinis 发版冒烟（W3-smoke · 止血设计稿 §5 第 3 条、§5.1）。
//
// 用法：
//   npm run smoke:release                    先构建（electron-vite build），再跑下面四个用例；缺 key 的用例标「跳过（缺 XXX）」
//   npm run smoke:release -- --mock          用例 1、2 改连脚本内起的假端点（Anthropic 与 OpenAI 兼容各一个），不要 key、不花钱
//   npm run smoke:release -- --mock --only deepseek,mcp-spaces   几个选项都写在同一个 -- 后面（npm 只吃掉第一个 --）
//   node scripts/smoke-release.mjs [--mock] [--memory-vault] [--only 用例,…] [--help]   （不先构建，用现有的 out/）
//
// 为什么要它：发版清单 §5 第 3 条的真 key 冒烟手工做一遍要十几步，还得小心别碰到自己真实的数据根与凭据；
//   云端只有 Linux、没有 key，这几条又恰恰是 0.3.0 止血最怕在用户机器上静默失效的路径。做成一条命令，用户在 Windows 上跑，
//   --mock 在 Linux 上验证脚本本身（tests/smoke-release.test.ts 每次全量都跑一遍 --mock）。
//
// 用例（缺对应环境变量的标跳过，不算失败）：
//   1. anthropic（ANTHROPIC_API_KEY）：官方端点，claude-fable-5-1 与 claude-opus-5-5 各跑一个三轮会话——工作区里 file_write 再
//      file_read、memory_write、再追问一句。要求每轮正常结束、没有 error 事件、这三次工具调用都成功、工作区文件与记忆文件里都有约定标记。
//      memory_write 之后下一步的系统提示变了（记忆注入），正是新账号前缀绑定 400 的场景；官方端点靠 drop_block 过（W2a-3）。
//   2. deepseek（DEEPSEEK_API_KEY）：DeepSeek V4（缺省 deepseek-v4-flash，DEEPSEEK_MODEL 可改，须是 V4 族）同样三轮；
//      第二次请求起历史里带着工具调用，不回放 reasoning_content 就 400（W2a-4）。有 400 就有 error 事件，判失败。
//   3. mcp-spaces：把最小 stdio MCP 服务器写进带空格的目录，参数里再带一个 C:\Program Files\… 形状的路径；
//      用裸名 node（Windows 上经 cmd.exe 包裹）与 node 的绝对路径（Windows 上多在 C:\Program Files\nodejs\）各登记一台并试连，要列出工具。
//   4. shell-stop：假端点让模型调用 shell_execute 跑长命令（Windows ping -t 127.0.0.1，其它平台 ping 127.0.0.1），进程表里看到
//      引擎名下的 ping 之后 chat.cancel，断言 5 秒内这些 ping 都没了。非 Windows 上 shell_execute 也起 powershell.exe，本机没有就跳过。
//
// 隔离：数据根与日志目录是新建的临时目录（DESKMINIS_DATA_DIR / DESKMINIS_LOG_DIR）。Windows 上凭据写进系统凭据库的
//   DeskMinis-smoke-<pid> 服务名下（DESKMINIS_KEYRING_SERVICE），结束时删掉本次写进去的条目并核对。其它平台或 --memory-vault 时
//   引擎用内存凭据库（既有的 DESKMINIS_TEST=1，e2e 脚本一直这么用）——Linux 的 Secret Service / keyutils 在容器与无桌面环境里
//   靠不住（实测首次写入报 AccessDenied、枚举报没有 D-Bus），而引擎起动就要往凭据库写设备身份。绝不碰用户真实的数据根与凭据。
//   key 只经 RPC 交给引擎（不进命令行、不进引擎的环境变量）；打印的每一行都先把 key 换成 [已隐藏]；结束前扫一遍临时目录，有明文 key 判失败。
//
// 输出一张 PASS / FAIL / SKIP 表（四个用例外加一行「清理」）。退出码：任一 FAIL 退 1；参数错误或没有构建产物退 2；否则 0。
// 中途被 Ctrl+C、Ctrl+Break、关掉窗口或 SIGTERM 打断时照样清理（停引擎、清凭据库、删临时目录），再以 128+信号号退出（Ctrl+C 为 130）。
// 零新依赖：只用 node 内置模块与已有的 ws、electron、@napi-rs/keyring。照 scripts/e2e-*.mjs 的写法用 electron 以 node 模式起
//   out/main/minisd.js（DESKMINIS_STANDALONE=1），握手行与致命行的解析照 src/main/index.ts，经 ws 走 JSON-RPC。
// 导出纯函数、假端点与几处和引擎打交道的收尾逻辑（connectRpc、runTurn、engineGone、engineCrashed、caseShellStop）供 tests/smoke-release.test.ts 直接调用。

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { constants as osConstants, tmpdir } from 'node:os';
import { join, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);

export const CASE_NAMES = ['anthropic', 'deepseek', 'mcp-spaces', 'shell-stop'];
/** 新一代 Claude：src/minisd/providers/anthropic.ts 的 BINDING_MODELS 里，官方端点要发 drop_block 的模型（设计稿 §2 拍板）。 */
export const ANTHROPIC_MODELS = ['claude-fable-5-1', 'claude-opus-5-5'];
export const DEEPSEEK_DEFAULT_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
/** 与 src/minisd/providers/openai.ts 的 requiresReasoningContentEcho 同一条规则：DEEPSEEK_MODEL 改了也得是 V4 族，否则测不到回放。 */
const DEEPSEEK_V4_RE = /(?:^|\/)deepseek-v4(?:$|[^0-9])/i;
/** mcp-spaces 塞给服务器的参数：带空格、带反斜杠，模仿用户配置里最常见的 C:\Program Files\… 路径。 */
const MCP_PROBE_ARG = 'C:\\Program Files\\DeskMinis Smoke\\probe arg';
/** chat.cancel 之后 ping 必须在这么久之内全部退出（设计稿 §5.1「几秒内」），给 taskkill /T 起进程、枚举并杀整棵树留足余量。 */
const PING_GONE_DEADLINE_MS = 5_000;
/** 比这短的串不当 key 处理：脱敏与明文扫描都会把常见短词误伤成满屏 [已隐藏]。 */
const MIN_SECRET_LEN = 8;
const MINISD_ENTRY = fileURLToPath(new URL('../out/main/minisd.js', import.meta.url));

const USAGE = [
  '用法：npm run smoke:release -- [--mock] [--memory-vault] [--only <用例,…>]',
  '      node scripts/smoke-release.mjs [同样的参数]       （不先构建，用现有的 out/）',
  '  --mock          用例 anthropic、deepseek 改连脚本内起的假端点（Anthropic 与 OpenAI 兼容各一个），不要 key，Linux 上也能自测',
  '  --memory-vault  不碰系统凭据库：引擎用内存凭据库（DESKMINIS_TEST=1），key 只在引擎进程内存里',
  `  --only          只跑列出的用例（逗号分隔）：${CASE_NAMES.join(', ')}`,
  '环境变量：',
  '  ANTHROPIC_API_KEY  用例 anthropic：官方端点，claude-fable-5-1 与 claude-opus-5-5 各一个三轮会话；缺了标跳过',
  `  DEEPSEEK_API_KEY   用例 deepseek：${DEEPSEEK_BASE_URL}；缺了标跳过`,
  `  DEEPSEEK_MODEL     可选，缺省 ${DEEPSEEK_DEFAULT_MODEL}；须是 deepseek-v4 族（不回放 reasoning_content 就 400 的那一族）`,
  '退出码：0 没有 FAIL（跳过不算失败）；1 有 FAIL；2 参数错误或没有构建产物',
  '        中途被 Ctrl+C、Ctrl+Break、关掉窗口或 SIGTERM 打断：照样停引擎、清凭据库、删临时目录，再以 128+信号号退出（Ctrl+C 为 130）',
].join('\n');

// ---------------------------------------------------------------------------
// 参数与跳过判定

export class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { mock: false, memoryVault: false, only: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // npm run 只吃掉第一个 --，后面再出现的原样转交（npm run smoke:release -- --mock -- --memory-vault 到这里是
    // --mock、--、--memory-vault）；本脚本没有位置参数，单独的 -- 跳过即可，不必让照这种习惯写的人撞一次参数错误
    if (arg === '--') continue;
    if (arg === '--mock') { opts.mock = true; continue; }
    if (arg === '--memory-vault') { opts.memoryVault = true; continue; }
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--only' || arg.startsWith('--only=')) {
      let value = arg === '--only' ? argv[i + 1] : arg.slice('--only='.length);
      if (arg === '--only') {
        if (value === undefined || value.startsWith('--')) value = '';
        else i++;
      }
      const names = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (names.length === 0) throw new UsageError('--only 后面缺值（用例名，逗号分隔）');
      const unknown = names.filter((n) => !CASE_NAMES.includes(n));
      if (unknown.length > 0) throw new UsageError(`--only 里有不认识的用例：${unknown.join('、')}（可选：${CASE_NAMES.join(', ')}）`);
      opts.only = [...new Set(names)];
      continue;
    }
    throw new UsageError(`不认识的参数 ${arg}`);
  }
  return opts;
}

/** 这个用例为什么不跑；返回 undefined 表示要跑。which 注入以便单测，生产用 whichCommand。 */
export function skipReason(name, { mock, env, platform, which, only }) {
  if (only && !only.includes(name)) return '跳过（--only 未选）';
  const has = (k) => typeof env[k] === 'string' && env[k].trim() !== '';
  if (name === 'anthropic' && !mock && !has('ANTHROPIC_API_KEY')) return '跳过（缺 ANTHROPIC_API_KEY）';
  if (name === 'deepseek' && !mock && !has('DEEPSEEK_API_KEY')) return '跳过（缺 DEEPSEEK_API_KEY）';
  if (name === 'shell-stop' && platform !== 'win32') {
    // Windows 上产品按 System32 下的绝对路径起 powershell.exe，ping.exe 也在 System32；别的平台 tools/shell.ts 起的是裸名 powershell.exe
    if (!which('powershell.exe')) return '跳过（本机找不到 powershell.exe——shell_execute 在非 Windows 上也起 powershell.exe（src/minisd/tools/shell.ts），测不了）';
    if (!which('ping')) return '跳过（本机找不到 ping）';
  }
  return undefined;
}

/** 大小写不敏感地取环境变量：Windows 上拷出来的普通对象里键名常是 Path，不是 PATH。 */
function envGet(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** 按 PATH（Windows 再加 PATHEXT）找可执行文件，找不到返回 undefined。 */
export function whichCommand(cmd, env, platform) {
  const dirs = (envGet(env, 'PATH') ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? ['', ...(envGet(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, cmd + ext);
      try {
        if (!statSync(full).isFile()) continue;
        if (platform !== 'win32') accessSync(full, fsConstants.X_OK);
        return full;
      } catch { /* 不在这个目录 */ }
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 隔离与脱敏

export function keyringServiceName(pid) {
  return `DeskMinis-smoke-${pid}`;
}

/** 这些变量不交给引擎：key 只经 RPC 交给 provider 存进凭据库；外层 shell 残留的 DESKMINIS_* 会改掉数据根、凭据库或打开假 provider；
 *  MINISD_HOST 会让冒烟用的引擎监听局域网。引擎的子进程（shell、MCP）继承引擎的环境，在这里剥一处就都干净。 */
const DROP_ENV_RE = /^(?:DESKMINIS_.*|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|MINISD_HOST|ELECTRON_RUN_AS_NODE)$/i;

/** 引擎的环境：剥掉上面那些，再写临时数据根、日志目录（不写的话以后按天日志会落进用户真实的 LOCALAPPDATA）与凭据库选择。 */
export function buildMinisdEnv(base, { dataRoot, logDir, keyringService }) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string' && !DROP_ENV_RE.test(k)) env[k] = v;
  env.ELECTRON_RUN_AS_NODE = '1'; // 以 node 模式跑引擎，不拉 GUI
  env.DESKMINIS_STANDALONE = '1'; // 走 standalone 分支，stdout 写握手行
  env.DESKMINIS_DATA_DIR = dataRoot;
  env.DESKMINIS_LOG_DIR = logDir;
  if (keyringService) env.DESKMINIS_KEYRING_SERVICE = keyringService;
  else env.DESKMINIS_TEST = '1'; // 既有开关：InMemoryVault（src/minisd/index.ts），不是为冒烟新加的
  return env;
}

export function redactSecrets(text, secrets) {
  let out = String(text);
  for (const s of secrets) if (typeof s === 'string' && s.length >= MIN_SECRET_LEN) out = out.split(s).join('[已隐藏]');
  return out;
}

/** 逐文件（含二进制）找明文 key，返回相对 dir 的路径。符号链接不跟：临时目录里本不该有，跟了可能扫出目录外。 */
export function findSecretsInTree(dir, secrets) {
  const needles = secrets.filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LEN).map((s) => Buffer.from(s, 'utf8'));
  if (needles.length === 0 || !existsSync(dir)) return [];
  const hits = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      let st;
      try { st = lstatSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) {
        let buf;
        try { buf = readFileSync(full); } catch { continue; }
        if (needles.some((n) => buf.includes(n))) hits.push(relative(dir, full));
      }
    }
  };
  walk(dir);
  return hits;
}

/** 某条凭据还在不在。getPassword 对不存在的条目回 null；个别平台抛 NoEntry，也算不在；别的错往上抛（交给调用方记为残留）。 */
function credentialPresent(keyring, service, account) {
  try {
    return new keyring.Entry(service, account).getPassword() != null;
  } catch (e) {
    if (/no ?entry|not found|no matching/i.test(String(e?.message ?? e))) return false;
    throw e;
  }
}

/**
 * 删掉冒烟写进系统凭据库的条目并核对：已知条目（设备身份、每个建过的 provider）加上按服务名枚举到的（引擎自己写的、脚本不知道的）。
 * 只动 service 这一个服务名——正式版的 DeskMinis 与开发态的 DeskMinis-dev 一条不碰。枚举结果里的密码不看、不打印。
 * sweep：'ok' 枚举可用；'unsupported' 系统不支持枚举，只核对了已知条目。
 */
export function cleanupKeyring(keyring, service, accounts) {
  const enumerate = () => {
    if (typeof keyring.findCredentials !== 'function') throw new Error('不支持按服务名枚举');
    return keyring.findCredentials(service).map((c) => c.account);
  };
  let sweep = 'ok';
  let found = [];
  try { found = enumerate(); } catch { sweep = 'unsupported'; }
  const targets = [...new Set([...accounts, ...found])];
  const deleted = [];
  for (const account of targets) {
    try {
      if (credentialPresent(keyring, service, account)) {
        new keyring.Entry(service, account).deletePassword();
        deleted.push(account);
      }
    } catch { /* 删不掉的留给下面核对，记为残留 */ }
  }
  const leftovers = targets.filter((a) => {
    try { return credentialPresent(keyring, service, a); } catch { return true; }
  });
  if (sweep === 'ok') {
    try { for (const a of enumerate()) if (!leftovers.includes(a)) leftovers.push(a); } catch { /* 刚才能枚举、这会儿不能：以逐条核对为准 */ }
  }
  return { deleted, leftovers, sweep };
}

function firstLine(e) {
  return String(e?.message ?? e).split(/\r?\n/)[0].trim();
}

/**
 * 选凭据库。系统凭据库只在 Windows 上用（产品只在 Windows 上发），而且先探一次（写、读回、删）：探不通就退回内存凭据库并说明原因，
 * 冒烟照跑——key 反正只在引擎进程内存里，不落盘。Linux 的原因见文件头；macOS 钥匙串对别的程序写入的条目会弹授权框
 * （条目是引擎 electron 写的、清理的是脚本 node），无人值守跑到清理那步会卡住。
 */
function chooseVault({ memoryVault, platform, service }) {
  if (memoryVault) return { kind: 'memory', reason: '（--memory-vault）' };
  if (platform !== 'win32') {
    return { kind: 'memory', reason: `（${platform} 上不用系统凭据库：Linux 的 Secret Service / keyutils 在容器与无桌面环境里靠不住，macOS 钥匙串会弹授权框）` };
  }
  let keyring;
  try { keyring = require('@napi-rs/keyring'); } catch (e) {
    return { kind: 'memory', reason: `（加载 @napi-rs/keyring 失败：${firstLine(e)}）` };
  }
  try {
    const probe = new keyring.Entry(service, '__smoke_probe__');
    probe.setPassword('probe');
    const back = probe.getPassword();
    probe.deletePassword();
    if (back !== 'probe') return { kind: 'memory', reason: '（系统凭据库写入后读回不一致）' };
  } catch (e) {
    return { kind: 'memory', reason: `（系统凭据库不可用：${firstLine(e)}${platform === 'win32' ? '——Windows 上本不该如此，正式版的 key 也会存不进去，请先查凭据管理器' : ''}）` };
  }
  return { kind: 'keyring', service, keyring };
}

// ---------------------------------------------------------------------------
// 握手行与致命行：解析照 src/main/index.ts 的 parseHandshake 与 src/main/minisd-fatal.ts 的 parseMinisdFatal（单测逐行比对）

/** 同时带数值端口与非空 token 才算握手行 `{"minisdPort":<n>,"authToken":"<uuid>"}`。 */
export function parseHandshakeLine(line) {
  try {
    const o = JSON.parse(line);
    const port = o?.minisdPort;
    const token = o?.authToken;
    if (typeof port === 'number' && Number.isFinite(port) && typeof token === 'string' && token.length > 0) return { port, token };
  } catch { /* 不是握手行 */ }
  return undefined;
}

const isInt = (v) => typeof v === 'number' && Number.isInteger(v);

/** 致命行 `{"minisdFatal":{code,…}}`：只认 src/minisd/fatal.ts 白名单里的两种，只取白名单字段。 */
export function parseFatalLine(line) {
  let o;
  try { o = JSON.parse(line); } catch { return undefined; }
  if (typeof o !== 'object' || o === null) return undefined;
  const f = o.minisdFatal;
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return undefined;
  const dataRoot = typeof f.dataRoot === 'string' && f.dataRoot !== '' ? f.dataRoot : undefined;
  if (dataRoot === undefined) return undefined;
  if (f.code === 'DB_NEWER_THAN_APP' && isInt(f.dbVersion) && isInt(f.appVersion)) {
    return { code: 'DB_NEWER_THAN_APP', dbVersion: f.dbVersion, appVersion: f.appVersion, dataRoot };
  }
  if (f.code === 'DATA_ROOT_LOCKED' && isInt(f.pid) && f.pid > 0) return { code: 'DATA_ROOT_LOCKED', pid: f.pid, dataRoot };
  return undefined;
}

// ---------------------------------------------------------------------------
// 结果表

/** 显示宽度：CJK 算两格，名字列（「清理」）才对得齐。 */
function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0) >= 0x2e80 ? 2 : 1;
  return w;
}

export function formatResults(results) {
  const width = Math.max(10, ...results.map((r) => displayWidth(r.name)));
  const indent = ' '.repeat(4 + 2 + width + 2);
  const lines = [];
  for (const r of results) {
    const [first, ...rest] = String(r.detail).split('\n');
    lines.push(`${r.status}  ${r.name}${' '.repeat(width - displayWidth(r.name))}  ${first}`);
    for (const l of rest) lines.push(`${indent}${l}`);
  }
  const count = (s) => results.filter((r) => r.status === s).length;
  lines.push(`汇总：PASS ${count('PASS')} · FAIL ${count('FAIL')} · SKIP ${count('SKIP')}`);
  return { lines, exitCode: count('FAIL') > 0 ? 1 : 0 };
}

// ---------------------------------------------------------------------------
// 剧本：真模型与假端点读同一套提示。关键词与标记都放在反引号里，假端点靠它们推下一步（parseDirective）

export function smokePrompts(nonce) {
  const tag = nonce.toUpperCase();
  const file = `smoke-${nonce}.txt`;
  const fileMarker = `SMOKE-${tag}-FILE`;
  const memMarker = `SMOKE-${tag}-MEMORY`;
  return {
    file, fileMarker, memMarker,
    turns: [
      'DeskMinis 发版前的自动冒烟测试，请严格按步骤调用工具，不要做别的事：\n'
        + `1. 调用 \`file_write\`，在工作区写文件 \`${file}\`（就用这个相对路径），内容只有一行：\`${fileMarker}\`\n`
        + `2. 等 file_write 返回之后，再调用 \`file_read\` 读回 \`${file}\`（分两步，不要同时调用）\n`
        + '3. 最后用一句话告诉我读到的内容。',
      `接着请调用 \`memory_write\` 记一条记忆，markdown 内容就写：\`${memMarker}\`。写完用一句话确认，不要调用别的工具。`,
      '最后一个问题：第 1 步写入的文件名是什么？只回答文件名，不要调用任何工具。',
    ],
  };
}

export function shellStopPrompt(command) {
  return `DeskMinis 发版前的自动冒烟测试。请调用 \`shell_execute\` 运行 \`${command}\`，timeout_seconds 设为 600；它会一直运行，等我点停止。`;
}

/** Windows 的 ping 缺省只发 4 个包，-t 才一直跑；其它平台的 ping 缺省就一直跑。 */
export function pingCommand(platform) {
  return platform === 'win32' ? 'ping -t 127.0.0.1' : 'ping 127.0.0.1';
}

export function parseDirective(text) {
  const tokens = [...String(text).matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  if (tokens.includes('file_write')) {
    return {
      kind: 'write-read',
      file: tokens.find((t) => /^smoke-[0-9a-z]+\.txt$/i.test(t)),
      content: tokens.find((t) => /^SMOKE-[0-9A-Z]+-FILE$/.test(t)),
    };
  }
  if (tokens.includes('memory_write')) return { kind: 'memory', markdown: tokens.find((t) => /^SMOKE-[0-9A-Z]+-MEMORY$/.test(t)) };
  if (tokens.includes('shell_execute')) return { kind: 'shell', command: tokens.find((t) => t !== 'shell_execute') };
  return { kind: 'text' };
}

function clip(s, n = 200) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function toolInput(c) {
  if (typeof c.input !== 'string') return c.input ?? {};
  try { return JSON.parse(c.input) ?? {}; } catch { return {}; }
}

/**
 * 用例 1、2 的判定（设计稿 §5.1）：每轮正常结束、没有 error 事件；成功的 file_write 之后有读到标记的 file_read；
 * 有写进标记的 memory_write；盘上工作区文件与记忆文件都有标记。多出来的失败调用只记一笔：模型走了弯路不等于产品坏了。
 */
export function assessToolSession(turns, { file, fileMarker, memMarker, workspaceFileText, memoryText }) {
  const problems = [];
  const notes = [];
  turns.forEach((t, i) => {
    const terminal = t.terminal ?? { kind: '无终态' };
    if (terminal.kind !== 'turnEnd') problems.push(`第 ${i + 1} 轮以错误结束：${clip(terminal.message ?? terminal.kind)}`);
    for (const e of t.errors ?? []) if (e !== terminal.message) problems.push(`第 ${i + 1} 轮有 error 事件：${clip(e)}`);
  });
  const tools = turns.flatMap((t) => t.tools ?? []);
  const isFile = (p) => typeof p === 'string' && p.replace(/\\/g, '/').split('/').pop() === file;
  const writeAt = tools.findIndex((c) => c.name === 'file_write' && c.success && isFile(toolInput(c).path));
  if (writeAt < 0) problems.push(`没有成功的 file_write（应写 ${file}）`);
  else if (!tools.some((c, i) => i > writeAt && c.name === 'file_read' && c.success && String(c.output).includes(fileMarker))) {
    problems.push(`file_write 之后没有读到 ${fileMarker} 的 file_read`);
  }
  if (!tools.some((c) => c.name === 'memory_write' && c.success && String(toolInput(c).markdown ?? '').includes(memMarker))) {
    problems.push(`没有写进 ${memMarker} 的成功 memory_write`);
  }
  if (workspaceFileText === undefined) problems.push(`工作区里没有 ${file}`);
  else if (!workspaceFileText.includes(fileMarker)) problems.push(`工作区里的 ${file} 没有 ${fileMarker}`);
  if (!String(memoryText ?? '').includes(memMarker)) problems.push(`记忆文件里没有 ${memMarker}`);
  for (const c of tools) if (!c.success) notes.push(`${c.name} 有一次失败：${clip(c.output, 120)}`);
  return { ok: problems.length === 0, problems, notes, toolCount: tools.length };
}

/** 权限卡应答：只放行本用例登记过的那一条（同会话、同类、同内容），其余一律拒绝——真模型越出剧本时，冒烟脚本不替用户点「允许」。 */
export function permissionDecision(params, allow) {
  const req = params?.req;
  if (!req || typeof req !== 'object') return 'deny';
  return allow.some((a) => a.sessionId === req.sessionId && a.kind === req.kind && a.detail === req.detail) ? 'allow-once' : 'deny';
}

// ---------------------------------------------------------------------------
// 进程表（shell-stop）：按父进程号从引擎往下找 ping。启动时刻一起记下，核对「还在」时防进程号复用

/** /proc/<pid>/stat：进程名在第一个「(」与最后一个「)」之间（名字里可以有空格和括号），其后第 1 段是状态、第 2 段父进程号、第 20 段启动时刻。 */
export function parseProcStat(text) {
  const s = String(text);
  const open = s.indexOf('(');
  const close = s.lastIndexOf(')');
  if (open < 0 || close < open) return undefined;
  const pid = Number(s.slice(0, open).trim());
  const rest = s.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  if (!Number.isInteger(pid) || !Number.isInteger(ppid) || rest.length < 20) return undefined;
  return { pid, ppid, name: s.slice(open + 1, close), state: rest[0], start: rest[19] };
}

/** PowerShell 的 CreationDate：5.1 的 ConvertTo-Json 写成 /Date(毫秒)/，7.x 写 ISO 串，缺了是 null。 */
function winStart(v) {
  if (typeof v !== 'string' || v === '') return undefined;
  const m = /\/Date\((\d+)/.exec(v);
  return m ? m[1] : v;
}

/** `Get-CimInstance Win32_Process | Select … | ConvertTo-Json -Compress` 的输出：只有一个进程时是对象，不是数组。 */
export function parseWin32Processes(json) {
  const text = String(json).trim();
  if (!text) return [];
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  const out = [];
  for (const p of Array.isArray(data) ? data : [data]) {
    if (!p || typeof p !== 'object') continue;
    const pid = Number(p.ProcessId);
    const ppid = Number(p.ParentProcessId);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue;
    out.push({ pid, ppid, name: String(p.Name ?? ''), start: winStart(p.CreationDate) });
  }
  return out;
}

export function findDescendants(table, rootPid) {
  const children = new Map();
  for (const p of table) {
    if (p.pid === p.ppid) continue; // Windows 的 0 号进程父子都是 0
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const out = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    for (const c of children.get(queue.shift()) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      out.push(c);
      queue.push(c.pid);
    }
  }
  return out;
}

/** 与 src/minisd/proc/win-exec.ts 的 systemRoot 同一取法：只认盘符开头的绝对路径，否则回落 C:\Windows。 */
function windowsRoot(env = process.env) {
  for (const k of ['SystemRoot', 'windir']) {
    const v = envGet(env, k);
    if (v && /^[A-Za-z]:\\/.test(v)) return v;
  }
  return 'C:\\Windows';
}

function runCapture(cmd, args, timeoutMs = 30_000) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${cmd} ${timeoutMs / 1000} 秒没结束`)); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(out);
      else reject(new Error(`${cmd} 退出码 ${code}：${clip(err, 200)}`));
    });
  });
}

export async function takeProcessSnapshot(platform = process.platform) {
  if (platform === 'win32') {
    const ps = win32.join(windowsRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // 先把输出切成 UTF-8：中文 Windows 缺省按 GBK 吐字节，GBK 双字节字的尾字节可以是 0x5C（反斜杠），
    // 按 UTF-8 解码后落进 JSON 字符串会变成一个转义符，整份 JSON 解析失败，就再也找不到 ping 了
    const script = '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; '
      + 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate | ConvertTo-Json -Compress';
    return parseWin32Processes(await runCapture(ps, ['-NoProfile', '-NonInteractive', '-Command', script]));
  }
  if (platform === 'linux' && existsSync('/proc/self/stat')) {
    const out = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const e = parseProcStat(readFileSync(`/proc/${name}/stat`, 'utf8'));
        if (e) out.push(e);
      } catch { /* 读的这一刻它退出了 */ }
    }
    return out;
  }
  const text = await runCapture('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'comm=']);
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3].trim().split('/').pop() });
  }
  return out;
}

/** 这个进程是否还在跑：Linux 看 /proc（僵尸算已退出，启动时刻对不上算被复用）；别处用 kill(pid, 0)，libuv 在 Windows 上会看退出码。 */
function stillRunning(p, platform) {
  if (platform === 'linux' && existsSync('/proc/self/stat')) {
    try {
      const e = parseProcStat(readFileSync(`/proc/${p.pid}/stat`, 'utf8'));
      return Boolean(e) && e.state !== 'Z' && (p.start === undefined || e.start === p.start);
    } catch { return false; }
  }
  try { process.kill(p.pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

function forceKill(pid, platform) {
  if (platform === 'win32') {
    spawnSync(win32.join(windowsRoot(), 'System32', 'taskkill.exe'), ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(pid, 'SIGKILL'); } catch { /* 已经没了 */ }
  }
}

const isPing = (p) => /^ping(?:\.exe)?$/i.test(p.name);

// ---------------------------------------------------------------------------
// 最小 stdio MCP 服务器（mcp-spaces）

export function mcpServerSource(expectedArgs) {
  return `// DeskMinis 发版冒烟写出的最小 stdio MCP 服务器（scripts/smoke-release.mjs 生成，跑完随临时目录删除）。
// 参数与预期不符——路径或参数里的空格被拆开——就以 3 退出，试连随即失败：冒烟要抓的正是这种情况。
const expected = ${JSON.stringify(expectedArgs)};
const actual = process.argv.slice(2);
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  process.stderr.write('smoke mcp: 参数与预期不符 ' + JSON.stringify(actual) + '\\n');
  process.exit(3);
}
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n');
function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.id === undefined) return; // 通知（notifications/initialized 之类）不应答
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: (msg.params && msg.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'deskminis-smoke', version: '0.0.0' } } });
  } else if (msg.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'smoke_ping', description: '冒烟用：回 pong', inputSchema: { type: 'object', properties: {} } }] } });
  } else if (msg.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'pong' }] } });
  } else {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (let nl = buf.indexOf('\\n'); nl >= 0; nl = buf.indexOf('\\n')) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(line);
  }
});
process.stdin.on('end', () => process.exit(0));
`;
}

// ---------------------------------------------------------------------------
// 假端点：Anthropic Messages 与 OpenAI 兼容（DeepSeek）各一个。「模型」是从请求历史推下一步的剧本，无状态——
// 同一段历史永远得到同一步，provider 重试也一样。流式格式照各家真端点，provider 解析不认就说明假端点或 provider 漂了（单测钉着）。

/** 新一代 Claude（同 anthropic.ts 的 BINDING_MODELS）：那里的注释引官方 model-migration 文档——enabled 与 disabled 思考在这些模型上都 400，
 *  只能不写或写 adaptive。假端点照此拦，provider 哪天在第三方端点上给它们发了 budget_tokens，--mock 就会红。 */
const MOCK_BINDING_MODELS = new Set(['claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5-5']);

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 32 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
}

/** 关服务器顺带断开 keep-alive 连接：引擎的 fetch（undici）会留着连接复用，光 close() 要等它们自己超时。 */
function closeServer(server) {
  return new Promise((resolvePromise) => {
    server.close(() => resolvePromise());
    server.closeAllConnections?.();
  });
}

/** 按字符（不按 UTF-16 码元）切成大约 n 段：provider 要自己把分段的 delta 拼回去，真端点就是这么吐的。 */
function splitText(s, n) {
  const chars = Array.from(String(s));
  const size = Math.max(1, Math.ceil(chars.length / n));
  const out = [];
  for (let i = 0; i < chars.length; i += size) out.push(chars.slice(i, i + size).join(''));
  return out.length > 0 ? out : [''];
}

/**
 * 剧本「模型」：transcript 是归一后的历史 [{role, text, toolNames}]。找最后一条带正文的用户消息当指令（工具结果不算），
 * 看它之后已经发过哪些工具调用，决定下一步。没有工具的请求是自动取标题。
 */
function decideStep(transcript, hasTools) {
  if (!hasTools) return { kind: 'title', text: '发版冒烟' };
  let at = -1;
  for (let i = transcript.length - 1; i >= 0; i--) {
    if (transcript[i].role === 'user' && transcript[i].text.trim() !== '') { at = i; break; }
  }
  const directive = at >= 0 ? parseDirective(transcript[at].text) : { kind: 'text' };
  const issued = transcript.slice(at + 1).filter((m) => m.role === 'assistant').flatMap((m) => m.toolNames);
  const tool = (name, input) => ({ kind: 'tool', tool: { name, input } });
  switch (directive.kind) {
    case 'write-read':
      if (!issued.includes('file_write')) return tool('file_write', { path: directive.file, content: directive.content, tool_title: '写冒烟文件' });
      if (!issued.includes('file_read')) return tool('file_read', { path: directive.file, tool_title: '读回冒烟文件' });
      return { kind: 'text', text: `读到的内容是 ${directive.content}。` };
    case 'memory':
      if (!issued.includes('memory_write')) return tool('memory_write', { markdown: directive.markdown, tool_title: '记下冒烟标记' });
      return { kind: 'text', text: '已记下。' };
    case 'shell':
      if (!issued.includes('shell_execute')) return tool('shell_execute', { command: directive.command, timeout_seconds: 600, tool_title: '跑一条长命令' });
      return { kind: 'text', text: '命令结束了。' };
    default: {
      // 追问文件名：从更早的指令里找
      const earlier = transcript.map((m) => (m.role === 'user' ? parseDirective(m.text) : undefined)).find((d) => d?.kind === 'write-read');
      return { kind: 'text', text: earlier?.file ?? '好的。' };
    }
  }
}

function anthropicContent(m) {
  return Array.isArray(m?.content) ? m.content : [{ type: 'text', text: String(m?.content ?? '') }];
}

function anthropicTranscript(messages) {
  return messages.map((m) => {
    const content = anthropicContent(m);
    return {
      role: m.role,
      text: content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('\n'),
      toolNames: content.filter((b) => b?.type === 'tool_use').map((b) => b.name),
    };
  });
}

/** 照 Anthropic 真端点拦下 provider 可能发错的请求；返回 400 的说明，没问题返回 undefined。 */
function checkAnthropicRequest(body, signatures) {
  if (body.stream !== true) return 'stream: this endpoint only serves streaming requests';
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages: at least one message is required';
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1) return 'max_tokens: must be a positive integer';
  if (MOCK_BINDING_MODELS.has(body.model) && body.thinking && body.thinking.type !== 'adaptive') {
    return `thinking.type: "${body.thinking.type}" is not supported for ${body.model}; omit thinking or use "adaptive"`;
  }
  for (let i = 0; i < body.messages.length; i++) {
    const content = anthropicContent(body.messages[i]);
    if (content.length === 0) return `messages.${i}: content must be non-empty`;
    for (let j = 0; j < content.length; j++) {
      // 回放的思考块必须原样带回本端点签发的签名：签名丢了、被改了，真端点都是 400
      if (content[j]?.type === 'thinking' && !signatures.has(content[j].signature)) return `messages.${i}.content.${j}: Invalid \`signature\` in \`thinking\` block`;
    }
    if (body.messages[i].role !== 'assistant') continue;
    const ids = content.filter((b) => b?.type === 'tool_use').map((b) => b.id);
    if (ids.length === 0) continue;
    const next = body.messages[i + 1];
    const answered = new Set(anthropicContent(next).filter((b) => b?.type === 'tool_result').map((b) => b.tool_use_id));
    const missing = ids.filter((id) => next?.role !== 'user' || !answered.has(id));
    if (missing.length > 0) return `messages.${i}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${missing.join(', ')}`;
  }
  return undefined;
}

function streamAnthropic(res, model, step, newSignature, newToolId) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  ev('message_start', { message: { id: `msg_mock_${randomBytes(6).toString('hex')}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 1 } } });
  let index = 0;
  if (step.kind !== 'title') {
    // 新一代 Claude 缺省自适应思考：每步先回一个带签名的思考块，provider 下次回放时由 checkAnthropicRequest 核对签名
    ev('content_block_start', { index, content_block: { type: 'thinking', thinking: '', signature: '' } });
    ev('content_block_delta', { index, delta: { type: 'thinking_delta', thinking: '（假思考）按剧本走下一步。' } });
    ev('content_block_delta', { index, delta: { type: 'signature_delta', signature: newSignature() } });
    ev('content_block_stop', { index });
    index++;
  }
  res.write('event: ping\ndata: {"type": "ping"}\n\n');
  if (step.kind === 'tool') {
    ev('content_block_start', { index, content_block: { type: 'tool_use', id: newToolId(), name: step.tool.name, input: {} } });
    for (const piece of splitText(JSON.stringify(step.tool.input), 3)) ev('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: piece } });
    ev('content_block_stop', { index });
    ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 30 } });
  } else {
    ev('content_block_start', { index, content_block: { type: 'text', text: '' } });
    for (const piece of splitText(step.text, 2)) ev('content_block_delta', { index, delta: { type: 'text_delta', text: piece } });
    ev('content_block_stop', { index });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
  }
  ev('message_stop', {});
  res.end();
}

/** Anthropic Messages 假端点：POST <url>/v1/messages，x-api-key 须等于 apiKey。hits 逐次记路径、模型、动作与状态码。 */
export async function startMockAnthropic({ apiKey }) {
  const hits = [];
  const signatures = new Set();
  let seq = 0;
  const server = createServer((req, res) => {
    readBody(req).then((raw) => {
      const hit = { path: req.url ?? '', model: '', action: '', status: 0 };
      hits.push(hit);
      const fail = (status, type, message) => {
        hit.status = status;
        hit.action = 'error';
        sendJson(res, status, { type: 'error', error: { type, message } });
      };
      if (req.method !== 'POST' || !(req.url ?? '').startsWith('/v1/messages')) return fail(404, 'not_found_error', 'Not found');
      if (req.headers['x-api-key'] !== apiKey) return fail(401, 'authentication_error', 'invalid x-api-key');
      if (!req.headers['anthropic-version']) return fail(400, 'invalid_request_error', 'anthropic-version: header is required');
      let body;
      try { body = JSON.parse(raw); } catch { return fail(400, 'invalid_request_error', 'request body is not valid JSON'); }
      hit.model = String(body.model ?? '');
      const problem = checkAnthropicRequest(body, signatures);
      if (problem) return fail(400, 'invalid_request_error', problem);
      const step = decideStep(anthropicTranscript(body.messages), Array.isArray(body.tools) && body.tools.length > 0);
      hit.action = step.kind === 'tool' ? step.tool.name : step.kind;
      hit.status = 200;
      streamAnthropic(res, body.model, step, () => {
        const sig = `mock-sig-${++seq}-${randomBytes(6).toString('hex')}`;
        signatures.add(sig);
        return sig;
      }, () => `toolu_mock_${++seq}`);
      return undefined;
    }).catch(() => { res.destroy(); });
  });
  await listen(server);
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, port, hits, close: () => closeServer(server) };
}

function openaiTranscript(messages) {
  return messages.map((m) => ({
    role: m?.role,
    text: typeof m?.content === 'string' ? m.content
      : Array.isArray(m?.content) ? m.content.filter((p) => p?.type === 'text').map((p) => String(p.text ?? '')).join('\n') : '',
    toolNames: Array.isArray(m?.tool_calls) ? m.tool_calls.map((c) => c?.function?.name) : [],
  }));
}

/** 照 OpenAI 兼容端点（DeepSeek）拦下 provider 可能发错的请求。 */
function checkOpenAIRequest(body, requireReasoningEcho) {
  if (body.stream !== true) return 'stream: this endpoint only serves streaming requests';
  if (!Array.isArray(body.messages) || body.messages.length === 0) return 'messages must be a non-empty array';
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i];
    if (m?.role !== 'assistant') continue;
    // DeepSeek V4 思考模式：每条 assistant 历史都要把 reasoning_content 带回来，缺了 400（W2a-4 修的就是这个）
    if (requireReasoningEcho && typeof m.reasoning_content !== 'string') {
      return 'The `reasoning_content` in the thinking mode must be passed back to the API.';
    }
    const ids = Array.isArray(m.tool_calls) ? m.tool_calls.map((c) => c?.id) : [];
    const answered = new Set();
    for (let j = i + 1; j < body.messages.length && body.messages[j]?.role === 'tool'; j++) answered.add(body.messages[j].tool_call_id);
    if (ids.some((id) => !answered.has(id))) {
      return "An assistant message with 'tool_calls' must be followed by tool messages responding to each 'tool_call_id'.";
    }
  }
  return undefined;
}

function streamOpenAI(res, body, step, withReasoning, newCallId) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const id = `chatcmpl-mock-${randomBytes(6).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);
  const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  const chunk = (delta, finish = null) => ({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, logprobs: null, finish_reason: finish }] });
  send(chunk({ role: 'assistant', content: '' }));
  if (withReasoning && step.kind !== 'title') {
    // V4 思考模式：推理在 delta.reasoning_content，先于正文与工具调用
    for (const piece of splitText('（假推理）按剧本走下一步。', 2)) send(chunk({ reasoning_content: piece }));
  }
  if (step.kind === 'tool') {
    send(chunk({ tool_calls: [{ index: 0, id: newCallId(), type: 'function', function: { name: step.tool.name, arguments: '' } }] }));
    for (const piece of splitText(JSON.stringify(step.tool.input), 3)) send(chunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }));
    send(chunk({}, 'tool_calls'));
  } else {
    for (const piece of splitText(step.text, 2)) send(chunk({ content: piece }));
    send(chunk({}, 'stop'));
  }
  if (body.stream_options?.include_usage) send({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage: { prompt_tokens: 42, completion_tokens: 12, total_tokens: 54 } });
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * OpenAI 兼容假端点：POST <url>/chat/completions（url 以 /v1 结尾）。apiKey 给了就要求 Bearer 一致。
 * requireReasoningEcho：像 DeepSeek V4 思考模式那样先吐 reasoning_content，并要求历史里每条 assistant 都带回来。
 */
export async function startMockOpenAI({ apiKey, requireReasoningEcho = false } = {}) {
  const hits = [];
  let seq = 0;
  const server = createServer((req, res) => {
    readBody(req).then((raw) => {
      const hit = { path: req.url ?? '', model: '', action: '', status: 0 };
      hits.push(hit);
      const fail = (status, type, message) => {
        hit.status = status;
        hit.action = 'error';
        sendJson(res, status, { error: { message, type, param: null, code: null } });
      };
      if (req.method !== 'POST' || !/\/chat\/completions$/.test(req.url ?? '')) return fail(404, 'not_found', 'Not found');
      if (apiKey !== undefined && req.headers.authorization !== `Bearer ${apiKey}`) return fail(401, 'authentication_error', 'Authentication Fails (mock): api key is invalid');
      let body;
      try { body = JSON.parse(raw); } catch { return fail(400, 'invalid_request_error', 'request body is not valid JSON'); }
      hit.model = String(body.model ?? '');
      const problem = checkOpenAIRequest(body, requireReasoningEcho);
      if (problem) return fail(400, 'invalid_request_error', problem);
      const step = decideStep(openaiTranscript(body.messages), Array.isArray(body.tools) && body.tools.length > 0);
      hit.action = step.kind === 'tool' ? step.tool.name : step.kind;
      hit.status = 200;
      streamOpenAI(res, body, step, requireReasoningEcho, () => `call_mock_${++seq}`);
      return undefined;
    }).catch(() => { res.destroy(); });
  });
  await listen(server);
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/v1`, port, hits, close: () => closeServer(server) };
}

// ---------------------------------------------------------------------------
// 引擎与 RPC

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (bytes) => randomBytes(bytes).toString('hex');

/** promise 与超时赛跑，超时得 fallback。计时器用完就清：赛输的 sleep 会把脚本在打完结果表之后再拖住好几秒。 */
async function withTimeout(promise, ms, fallback) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((r) => { timer = setTimeout(() => r(fallback), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** 末尾若干字节的环形缓冲：引擎起不来或用例失败时附上它的最后输出（真正的原因多在这里）。 */
function tailBuffer(limit = 8192) {
  let text = '';
  return { push(s) { text = (text + s).slice(-limit); }, get text() { return text; } };
}

/** 起引擎、等握手行。按完整行扫描，致命行先认（照 src/main/index.ts 的 startMinisdProcess）；握手之后的行照样收进末尾缓冲。 */
function startMinisd(electronBin, entry, env, engine) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(electronBin, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    engine.child = child;
    let settled = false;
    const settle = (fn) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const timer = setTimeout(() => settle(() => reject(new Error('30 秒内没有握手行（引擎可能卡在打开库或凭据库上）'))), 30_000);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (line.trim() === '') continue;
        const fatal = parseFatalLine(line);
        if (fatal !== undefined) { settle(() => reject(new Error(`引擎报告致命错误 ${fatal.code}（数据目录 ${fatal.dataRoot}）`))); continue; }
        const hs = parseHandshakeLine(line);
        if (hs !== undefined) { settle(() => resolvePromise(hs)); continue; }
        engine.tail.push(`${line}\n`);
      }
    });
    child.stderr.on('data', (d) => engine.tail.push(d.toString('utf8')));
    child.on('error', (e) => settle(() => reject(e)));
    child.on('exit', (code, signal) => {
      engine.exit = { code, signal };
      settle(() => reject(new Error(`引擎提前退出（${code ?? signal}）`)));
    });
  });
}

export async function connectRpc(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  await new Promise((resolvePromise, reject) => { ws.once('open', resolvePromise); ws.once('error', reject); });
  let nextId = 0;
  let closed = false;
  const pending = new Map();
  const listeners = new Set();
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${p.method}：${msg.error.message ?? JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method) for (const l of [...listeners]) { try { l(msg.method, msg.params); } catch { /* 一个监听器出错不连累别的 */ } }
  });
  ws.on('error', () => { /* 断线由 close 收口 */ });
  ws.on('close', () => {
    closed = true;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`${p.method}：与引擎的连接断了（引擎退出了？）`)); }
    pending.clear();
    // 也告诉正在等事件的回合：引擎半路退出时立刻判失败，不必干等到回合超时（真 key 模式一轮要等 4 分钟）
    for (const l of [...listeners]) { try { l('rpc.closed', {}); } catch { /* 同上 */ } }
  });
  return {
    /** 连接已断（多半是引擎退出了）：之后的 call 一律立即拒绝。 */
    get closed() { return closed; },
    call(method, params = {}, timeoutMs = 30_000) {
      // 断了之后的请求立即判失败：ws 在 CLOSING / CLOSED 时 send 不抛错，不给回调也不报告，不拦就只能干等满超时，
      // 结果表里只剩「30 秒没有应答」，看不出是引擎退出了
      if (closed || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`${method}：与引擎的连接已断开（引擎退出了？）`));
      return new Promise((resolvePromise, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method}：${timeoutMs / 1000} 秒没有应答`)); }, timeoutMs);
        pending.set(id, { resolve: resolvePromise, reject, timer, method });
        try { ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); } catch (e) { clearTimeout(timer); pending.delete(id); reject(e); }
      });
    },
    onNotify(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    close() { try { ws.close(); } catch { /* 已断 */ } },
  };
}

/** 连接断开与引擎的 exit 事件谁先到不一定：连接先断时稍等 exit，退出码或信号才拿得到，也不会把崩溃当成正常。 */
async function settleEngineExit(ctx) {
  if (!ctx.engine.exit && ctx.client?.closed) await waitFor(() => ctx.engine.exit, 3_000, 50);
}

/**
 * 引擎已经没了（进程退出，或与它的连接断开）就返回一句说明，否则 undefined；when 填「已在前面」或「在这个用例进行中」。
 * 没了之后一个 RPC 也发不出去：用例据此直接判 FAIL、不再发 RPC，结论里写真正的原因，而不是一串「没有应答」。
 */
export async function engineGone(ctx, when) {
  await settleEngineExit(ctx);
  if (ctx.engine.exit) return `引擎${when}退出（${ctx.engine.exit.code ?? ctx.engine.exit.signal}）`;
  if (ctx.client?.closed) return `与引擎的连接${when}断开`;
  return undefined;
}

/** 上一轮的 turnEnd 广播先于引擎摘掉「运行中」，紧跟着发下一轮会撞「该会话正在运行中」：短退避重试（同 e2e-mcp-acceptance）。 */
async function promptWithRetry(client, params) {
  for (let i = 0; ; i++) {
    try { return await client.call('chat.prompt', params); } catch (e) {
      if (i < 20 && String(e?.message).includes('正在运行')) { await sleep(300); continue; }
      throw e;
    }
  }
}

/**
 * 从现在起收这个会话的 chat.event，直到 turnEnd 或 error。先挂监听再发 chat.prompt（chat.prompt 立即返回，事件随后才到）。
 * rec.tools 按 toolStart 的顺序记，toolEnd 回填结果。
 */
function watchTurn(client, sessionId, timeoutMs) {
  const rec = { terminal: undefined, errors: [], tools: [], retries: 0, text: '' };
  const byId = new Map();
  let stop;
  const done = new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`等了 ${timeoutMs / 1000} 秒回合还没结束`)); }, timeoutMs);
    const off = client.onNotify((method, params) => {
      if (method === 'rpc.closed') {
        clearTimeout(timer);
        off();
        // 也记成终态：轮询 rec.terminal 的等待（shell-stop 等工具开始、等 ping 出现）据此立刻收手，不干等到各自的时限
        rec.terminal = { kind: 'error', message: '与引擎的连接断了（引擎退出了？）' };
        reject(new Error(rec.terminal.message));
        return;
      }
      if (method !== 'chat.event' || params?.sessionId !== sessionId) return;
      const ev = params.event ?? {};
      if (ev.kind === 'textDelta') rec.text += ev.text;
      else if (ev.kind === 'toolStart') {
        const t = { name: ev.name, input: ev.input, success: false, output: '', ended: false };
        byId.set(ev.toolUseId, t);
        rec.tools.push(t);
      } else if (ev.kind === 'toolEnd') {
        const t = byId.get(ev.toolUseId);
        if (t) Object.assign(t, { success: ev.success === true, output: String(ev.output ?? ''), ended: true });
      } else if (ev.kind === 'retry') rec.retries++;
      else if (ev.kind === 'error') rec.errors.push(String(ev.message ?? ''));
      if (ev.kind === 'turnEnd' || ev.kind === 'error') {
        clearTimeout(timer);
        off();
        rec.terminal = { kind: ev.kind, message: ev.message, stopReason: ev.stopReason };
        resolvePromise(rec);
      }
    });
    stop = (err) => { clearTimeout(timer); off(); reject(err); };
  });
  done.catch(() => { /* 由调用方 await 时处理 */ });
  return { rec, done, stop };
}

export async function runTurn(ctx, sessionId, text, providerId) {
  const w = watchTurn(ctx.client, sessionId, ctx.turnTimeoutMs);
  try { await promptWithRetry(ctx.client, { sessionId, text, providerId }); } catch (e) {
    w.stop(e);
    // 终态与 errors 用同一句：assessToolSession 按这个去重，否则同一个原因会以「以错误结束」「有 error 事件」各报一次。
    // call 的报错本就以「chat.prompt：」开头，不再加前缀
    const message = firstLine(e);
    return { ...w.rec, terminal: { kind: 'error', message }, errors: [message] };
  }
  try { return await w.done; } catch (e) {
    return { ...w.rec, terminal: { kind: 'error', message: firstLine(e) }, errors: [...w.rec.errors, firstLine(e)] };
  }
}

function describeTurn(t) {
  const head = t.terminal?.kind === 'turnEnd' ? '正常结束' : `出错：${clip(t.terminal?.message, 160)}`;
  const tools = t.tools.length > 0 ? ` · 工具 ${t.tools.map((c) => `${c.name}${c.success ? '成功' : '失败'}`).join('、')}` : '';
  return `${head}${tools}${t.retries ? ` · 重试 ${t.retries} 次` : ''}`;
}

function readTextIfExists(file) {
  try { return readFileSync(file, 'utf8'); } catch { return undefined; }
}

/** 记忆日志：<数据根>/memory/<日期>.md（memory_write 写当天那个；跨零点的话是两个，都读）。 */
function readMemoryText(dir) {
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => readFileSync(join(dir, n), 'utf8')).join('\n');
  } catch { return ''; }
}

// ---------------------------------------------------------------------------
// 四个用例

/** 用例 1、2 共用：建 provider 与会话，照剧本跑三轮，读回工作区文件与记忆文件，按 assessToolSession 判定；收尾删会话与 provider（连同凭据库里的 key）。 */
async function runToolSession(ctx, label, providerParams) {
  const { client } = ctx;
  const created = await client.call('provider.instances.create', providerParams);
  ctx.accounts.add(`provider:${created.id}`);
  let sessionId;
  try {
    sessionId = (await client.call('chat.sessions.create', { title: `冒烟 ${label}` })).id;
    const pr = smokePrompts(hex(3));
    const turns = [];
    for (let i = 0; i < pr.turns.length; i++) {
      const t = await runTurn(ctx, sessionId, pr.turns[i], created.id);
      turns.push(t);
      ctx.say(`  ${label} 第 ${i + 1} 轮：${describeTurn(t)}`);
      if (t.terminal?.kind !== 'turnEnd') break; // 这一轮都没过，后面的轮次缺前提，问了也只是多花钱
    }
    // 引擎半路退出时这个调用也会失败：退回缺省工作区（sessions/<id>/workspace）照样判，结论里留着回合报的真正原因
    const wsRoot = await client.call('workspace.get', { sessionId }).then((w) => w.root, () => join(ctx.dataRoot, 'sessions', sessionId, 'workspace'));
    const a = assessToolSession(turns, {
      file: pr.file, fileMarker: pr.fileMarker, memMarker: pr.memMarker,
      workspaceFileText: readTextIfExists(join(wsRoot, pr.file)),
      memoryText: readMemoryText(join(ctx.dataRoot, 'memory')),
    });
    const denied = ctx.denied.filter((d) => d.sessionId === sessionId).map((d) => `越出剧本的权限请求已拒绝（${d.kind}：${clip(d.detail, 80)}）`);
    const notes = [...a.notes, ...denied];
    // 有回合出错时只报回合的错：那是根因，「没有 file_write」「工作区里没有文件」之类都是它的后果，列出来只会把它淹掉
    const turnProblems = a.problems.filter((p) => p.startsWith('第 '));
    const summary = a.ok
      ? `${turns.length} 轮都正常结束，工具调用 ${a.toolCount} 次（file_write、file_read、memory_write 均成功），工作区文件与记忆文件都有标记`
      : (turnProblems.length > 0 ? turnProblems : a.problems).slice(0, 4).join('；');
    return { ok: a.ok, summary: notes.length > 0 ? `${summary}（另：${notes.slice(0, 3).join('；')}）` : summary };
  } finally {
    if (sessionId) await client.call('chat.sessions.delete', { sessionId, confirm: true }, 20_000).catch(() => {});
    await client.call('provider.instances.delete', { id: created.id, confirm: true }).catch(() => {});
  }
}

async function caseAnthropic(ctx) {
  const key = ctx.mock ? `sk-ant-smoke-mock-${hex(8)}` : ctx.env.ANTHROPIC_API_KEY.trim();
  if (ctx.mock) ctx.secrets.push(key);
  const server = ctx.mock ? await startMockAnthropic({ apiKey: key }) : undefined;
  try {
    const lines = [];
    let ok = true;
    for (const model of ANTHROPIC_MODELS) {
      // 每个模型的结论各占一行：一个模型出事（引擎没了、RPC 报错）只记在它自己那一行，
      // 不能变成整条用例的一句「异常」，把前一个模型已经得出的结论盖掉
      const gone = await engineGone(ctx, '已在前面');
      if (gone) { ok = false; lines.push(`${model}：没有跑：${gone}`); continue; }
      try {
        // 不写 baseUrl 就是官方端点 https://api.anthropic.com：这两个模型在那里才带 beta 头与 drop_block（W2a-3）
        const r = await runToolSession(ctx, model, { name: `冒烟 ${model}`, kind: 'anthropic', modelId: model, apiKey: key, ...(server ? { baseUrl: server.url } : {}) });
        lines.push(`${model}：${r.summary}`);
        if (!r.ok) ok = false;
      } catch (e) {
        ok = false;
        lines.push(`${model}：异常：${firstLine(e)}`);
      }
    }
    if (server) lines.push(`（假端点共收到 ${server.hits.length} 次请求，非 200 的 ${server.hits.filter((h) => h.status !== 200).length} 次）`);
    return { status: ok ? 'PASS' : 'FAIL', detail: lines.join('\n') };
  } finally {
    await server?.close();
  }
}

async function caseDeepseek(ctx) {
  const model = ctx.deepseekModel;
  const key = ctx.mock ? `sk-smoke-mock-${hex(8)}` : ctx.env.DEEPSEEK_API_KEY.trim();
  if (ctx.mock) ctx.secrets.push(key);
  const server = ctx.mock ? await startMockOpenAI({ apiKey: key, requireReasoningEcho: true }) : undefined;
  try {
    const r = await runToolSession(ctx, model, { name: `冒烟 ${model}`, kind: 'openai-compat', modelId: model, apiKey: key, baseUrl: server ? server.url : DEEPSEEK_BASE_URL });
    const lines = [`${model}：${r.summary}`];
    if (server) lines.push(`（假端点共收到 ${server.hits.length} 次请求，非 200 的 ${server.hits.filter((h) => h.status !== 200).length} 次；第二次起每次都核对了 reasoning_content 回放）`);
    return { status: r.ok ? 'PASS' : 'FAIL', detail: lines.join('\n') };
  } finally {
    await server?.close();
  }
}

async function caseMcpSpaces(ctx) {
  const { client } = ctx;
  const dir = join(ctx.tempRoot, 'smoke mcp server'); // 目录名带空格
  mkdirSync(dir, { recursive: true });
  const serverFile = join(dir, 'server.mjs');
  writeFileSync(serverFile, mcpServerSource([MCP_PROBE_ARG]), 'utf8');
  const args = [serverFile, MCP_PROBE_ARG];
  // 脚本自己跑在 electron 的 node 模式下（单测）时，process.execPath 是 electron，得带上 ELECTRON_RUN_AS_NODE
  const absEnv = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : undefined;
  const entries = [
    { name: 'smoke-mcp-bare', command: 'node', label: `裸名 node${ctx.platform === 'win32' ? '（Windows 上经 cmd.exe /d /s /c 包裹）' : ''}` },
    { name: 'smoke-mcp-abs', command: process.execPath, env: absEnv, label: `绝对路径 ${process.execPath}` },
  ];
  const lines = [`服务器：${serverFile}；参数：${MCP_PROBE_ARG}`];
  let ok = true;
  try {
    for (const e of entries) {
      await client.call('mcp.servers.upsert', { name: e.name, command: e.command, args, ...(e.env ? { env: e.env } : {}) });
      const r = await client.call('mcp.servers.test', { name: e.name }, 90_000);
      if (r?.ok === true && r.toolCount === 1) {
        lines.push(`${e.label}：连上并列出 1 个工具（${r.elapsedMs}ms）`);
      } else {
        ok = false;
        const why = String(r?.error ?? JSON.stringify(r));
        const hint = /code 3\b/.test(why) ? '——参数里的空格被拆开了' : /code 1\b/.test(why) ? '——多半是 node 找不到脚本（路径里的空格被拆开）' : '';
        lines.push(`${e.label}：${r?.ok === true ? `列出 ${r.toolCount} 个工具，应为 1 个` : `试连失败：${clip(why, 200)}${hint}`}`);
      }
    }
    const listed = await client.call('mcp.servers.list', {});
    const names = Array.isArray(listed?.servers) ? listed.servers.map((s) => s.name) : [];
    const missing = entries.filter((e) => !names.includes(e.name)).map((e) => e.name);
    if (missing.length > 0) { ok = false; lines.push(`登记后 mcp.servers.list 里找不到：${missing.join('、')}`); }
  } finally {
    for (const e of entries) await client.call('mcp.servers.remove', { name: e.name }).catch(() => {});
  }
  return { status: ok ? 'PASS' : 'FAIL', detail: lines.join('\n') };
}

async function waitFor(check, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await sleep(intervalMs);
  }
}

/**
 * chat.cancel 之后等这些 ping 退出（shell-stop 的判定本身）。deadline 到了还在的，先拿进程表核对身份——进程号、名字、
 * 启动时刻都对得上——再替用户结束掉：残留不能留在用户机器上，被复用了进程号的别的程序也绝不能误杀；核对不了就不杀。
 * 依赖（isAlive / snapshot / kill）注入，单测用假的。
 */
export async function reapPings(pings, { deadlineMs, isAlive, snapshot, kill, intervalMs = 100 }) {
  const gone = await waitFor(() => (pings.some((p) => isAlive(p)) ? undefined : true), deadlineMs, intervalMs);
  if (gone) return { ok: true, killed: [] };
  const table = await Promise.resolve().then(snapshot).catch(() => []);
  const stuck = pings.filter((p) => table.some((s) => s.pid === p.pid && isPing(s) && (p.start === undefined || s.start === p.start)));
  for (const p of stuck) kill(p.pid);
  return { ok: false, killed: stuck.map((p) => p.pid) };
}

export async function caseShellStop(ctx) {
  const { client, platform } = ctx;
  const command = pingCommand(platform);
  const server = await startMockOpenAI({ requireReasoningEcho: false });
  let providerId;
  let sessionId;
  let allow;
  let w;
  try {
    // ollama 类免 key：这个用例不需要往凭据库写任何东西
    providerId = (await client.call('provider.instances.create', { name: '冒烟 shell 假端点', kind: 'ollama', baseUrl: server.url, modelId: 'smoke-shell' })).id;
    sessionId = (await client.call('chat.sessions.create', { title: '冒烟 shell-stop' })).id;
    allow = { sessionId, kind: 'shell', detail: command };
    ctx.allow.push(allow); // ping 不在只读白名单里，会弹权限卡；只放行这一条
    w = watchTurn(client, sessionId, 120_000);
    await promptWithRetry(client, { sessionId, text: shellStopPrompt(command), providerId });
    const started = await waitFor(() => w.rec.tools.find((t) => t.name === 'shell_execute') ?? w.rec.terminal, 30_000, 100);
    if (!started || !w.rec.tools.some((t) => t.name === 'shell_execute')) {
      w.stop(new Error('没开始'));
      return { status: 'FAIL', detail: `shell_execute 没有开始：${w.rec.terminal ? clip(w.rec.terminal.message ?? w.rec.terminal.kind) : '30 秒内没有 toolStart'}` };
    }
    const findPings = async () => {
      const found = findDescendants(await takeProcessSnapshot(platform), ctx.engine.child.pid).filter(isPing);
      return found.length > 0 ? found : undefined;
    };
    // 回合已经收尾（命令早早结束，或与引擎的连接断了）就不必再等 ping 出现
    const pings = await waitFor(async () => (await findPings()) ?? (w.rec.terminal ? [] : undefined), 20_000, 300);
    if (!pings?.length) {
      const shell = w.rec.tools.find((t) => t.name === 'shell_execute');
      const when = w.rec.terminal ? `回合已经收尾（${clip(w.rec.terminal.message ?? w.rec.terminal.kind, 80)}），` : '20 秒内';
      w.stop(new Error('没有 ping'));
      await client.call('chat.cancel', { sessionId }).catch(() => {});
      return { status: 'FAIL', detail: `${when}引擎名下没出现 ping${shell?.ended ? `（命令已结束：${clip(shell.output, 160)}）` : ''}` };
    }
    const cancelAt = Date.now();
    await client.call('chat.cancel', { sessionId });
    // 先等 ping 退出（不退就核对身份后替用户结束掉），再等回合收尾：命令还卡在 ping 上时，回合要等它退出才收得了尾
    const reap = await reapPings(pings, {
      deadlineMs: PING_GONE_DEADLINE_MS,
      isAlive: (p) => stillRunning(p, platform),
      snapshot: () => takeProcessSnapshot(platform),
      kill: (pid) => forceKill(pid, platform),
    });
    const goneMs = Date.now() - cancelAt;
    const rec = await withTimeout(w.done.catch(() => undefined), 20_000, undefined);
    if (!rec) w.stop(new Error('没收尾'));
    const terminal = !rec ? 'chat.cancel 之后 20 秒回合没收尾'
      : rec.terminal?.kind === 'error' ? `回合以「${clip(rec.terminal.message, 40)}」收尾` : `回合以 ${rec.terminal?.kind} 收尾`;
    const pidList = pings.map((p) => p.pid).join(', ');
    if (reap.ok) return { status: 'PASS', detail: `chat.cancel 后 ${goneMs}ms 内引擎名下的 ping 全部退出（pid ${pidList}）；${terminal}` };
    const killed = reap.killed.length > 0 ? `已由冒烟脚本结束 pid ${reap.killed.join(', ')}` : '核对不了身份，没有替你结束，请到任务管理器里看一眼';
    return { status: 'FAIL', detail: `chat.cancel 后 ${PING_GONE_DEADLINE_MS / 1000} 秒 ping 仍在（pid ${pidList}），进程树没回收干净；${killed}。${terminal}` };
  } finally {
    // 中途抛出也要摘掉回合监听（chat.prompt 报错，或挂上监听之前连接就断了、收不到 rpc.closed）：
    // 不摘的话它 120 秒的计时器会把脚本在打完结果表之后再拖住
    w?.stop(new Error('用例已结束'));
    if (allow) ctx.allow.splice(ctx.allow.indexOf(allow), 1);
    if (sessionId) await client.call('chat.sessions.delete', { sessionId, confirm: true }, 20_000).catch(() => {});
    if (providerId) await client.call('provider.instances.delete', { id: providerId, confirm: true }).catch(() => {});
    await server.close();
  }
}

const CASES = { anthropic: caseAnthropic, deepseek: caseDeepseek, 'mcp-spaces': caseMcpSpaces, 'shell-stop': caseShellStop };

// ---------------------------------------------------------------------------
// 清理：停引擎 → 扫明文 key → 清凭据库 → 删临时目录。只跑一次（正常收尾与 Ctrl+C 可能同时要它）

/**
 * 收到这些信号时先清理再退。只挂 SIGINT、SIGTERM 不够：Windows 上关掉控制台窗口，node 收到的是 SIGHUP——没有监听器就当场终止，
 * 有监听器系统约 10 秒后才强杀（Node 文档 process 信号事件一节），够停引擎、删几条凭据；Ctrl+Break 是 SIGBREAK。漏挂哪个，凭据库里本次写进去的 key（provider:<id>）
 * 与设备身份就一条都不删，临时目录也留下。SIGHUP 在 Linux、macOS 上是终端挂断；SIGBREAK 只有 Windows 会发，别处不挂。
 */
export function cleanupSignals(platform) {
  return platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
}

/** 被信号打断时的退出码：照 shell 的惯例取 128 + 信号号（Ctrl+C 即 130，SIGHUP 129，SIGTERM 143，Windows 的 SIGBREAK 149），看得出是被什么打断的。 */
function signalExitCode(sig) {
  const n = osConstants.signals[sig];
  return typeof n === 'number' ? 128 + n : 130;
}

async function stopEngine(engine, platform) {
  const child = engine.child;
  if (!child || engine.exit) return;
  const exited = new Promise((r) => child.once('exit', () => r(true)));
  // 引擎只在 utilityProcess 下接 shutdown 消息，这里没有那条通道，只能直接结束。它名下的 shell 与 MCP 子进程前面已随会话删除、
  // mcp.servers.remove 回收；Windows 上 libuv 还把子进程放进「句柄关闭即杀」的作业对象（推断），引擎一退它们也跟着退
  child.kill();
  if (await withTimeout(exited, 10_000, false)) return;
  forceKill(child.pid, platform);
  await withTimeout(exited, 5_000, false);
}

/**
 * 起来过、又不是我们停的却已经退了，才算中途崩溃（返回它的 exit，否则 undefined）；压根没起来的，用例那几行已经写了「引擎没起来」。
 * 连接先断、exit 事件还没到时先等它：不然清理会把崩溃的引擎当成自己停的，报「引擎已停」。
 */
export async function engineCrashed(ctx) {
  if (!ctx.engine.booted || ctx.engine.stopping) return undefined;
  await settleEngineExit(ctx);
  return ctx.engine.exit;
}

async function cleanup(ctx) {
  const problems = [];
  const done = [];
  const crashed = await engineCrashed(ctx);
  ctx.engine.stopping = true;
  ctx.client?.close();
  await stopEngine(ctx.engine, ctx.platform);
  if (crashed) problems.push(`引擎在冒烟过程中自己退出了（${crashed.code ?? crashed.signal}）`);
  else if (ctx.engine.child) done.push('引擎已停');
  const leaks = findSecretsInTree(ctx.tempRoot, ctx.secrets);
  if (leaks.length > 0) problems.push(`临时目录里发现明文 key：${leaks.join('、')}`);
  if (ctx.vault.kind === 'keyring') {
    const r = cleanupKeyring(ctx.vault.keyring, ctx.vault.service, [...ctx.accounts]);
    if (r.leftovers.length > 0) problems.push(`凭据库 ${ctx.vault.service} 还剩 ${r.leftovers.length} 条（${r.leftovers.join('、')}），可在系统凭据管理器里手动删`);
    else done.push(`凭据库 ${ctx.vault.service} 已清空（删 ${r.deleted.length} 条${r.sweep === 'ok' ? '' : '；系统不支持按服务名枚举，只核对了已知条目'}）`);
  }
  try { rmSync(ctx.tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 下面核对 */ }
  if (existsSync(ctx.tempRoot)) problems.push(`临时目录删不掉：${ctx.tempRoot}`);
  else done.push('临时目录已删');
  if (leaks.length === 0) done.push('临时目录里没有明文 key');
  return { name: '清理', status: problems.length > 0 ? 'FAIL' : 'PASS', detail: problems.length > 0 ? problems.join('；') : done.join('；') };
}

/**
 * 跑完整个冒烟，返回结果表（四个用例 + 清理）。print 收到的每一行都已脱敏。
 * 中途收到 cleanupSignals 里的信号（Ctrl+C、SIGTERM、关终端或控制台窗口的 SIGHUP、Windows 的 Ctrl+Break）时照样清理
 * （停引擎、清凭据库、删临时目录），再以 128+信号号退出。
 */
export async function runSmoke({ mock, memoryVault, only, deepseekModel = DEEPSEEK_DEFAULT_MODEL, electronBin, minisdEntry = MINISD_ENTRY, env = process.env, platform = process.platform, print = console.log }) {
  const secrets = [env.ANTHROPIC_API_KEY, env.DEEPSEEK_API_KEY].map((s) => (typeof s === 'string' ? s.trim() : '')).filter(Boolean);
  const say = (line) => print(redactSecrets(line, secrets));
  const tempRoot = mkdtempSync(join(tmpdir(), 'dm-smoke-'));
  const dataRoot = join(tempRoot, 'data');
  const logDir = join(tempRoot, 'logs');
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const vault = chooseVault({ memoryVault, platform, service: keyringServiceName(process.pid) });
  const ctx = {
    mock, env, platform, deepseekModel, tempRoot, dataRoot, secrets, say, vault,
    turnTimeoutMs: mock ? 60_000 : 240_000,
    engine: { child: undefined, exit: undefined, booted: false, stopping: false, tail: tailBuffer() },
    client: undefined,
    accounts: new Set(['pairing.static-identity']), // 引擎起动时自己写的设备身份；provider 的 key 建时再记
    allow: [], denied: [],
  };
  let cleaning;
  const cleanupOnce = () => (cleaning ??= cleanup(ctx));
  let interruptedBy; // 第一个打断的信号，退出码按它算
  const onSignal = (sig) => {
    // 挂 on 而不是 once：清理途中再按一次 Ctrl+C（或接着关窗口）若回到默认动作，脚本当场被打死，凭据库里本次写的条目就留下了。
    // 清理本身有上限（停引擎最多等 15 秒，其余是几次凭据库调用与删目录），清完就退
    if (interruptedBy) { say(`又收到 ${sig}：还在清理，清完就退出……`); return; }
    interruptedBy = sig;
    say(`收到 ${sig}：停引擎、清凭据库、删临时目录后退出……`);
    cleanupOnce().then((r) => say(`${r.status}  清理  ${r.detail}`)).finally(() => process.exit(signalExitCode(sig)));
  };
  // 按本机平台挂（不是 ctx.platform）：收得到哪些信号由真实的操作系统决定
  const signals = cleanupSignals(process.platform);
  for (const sig of signals) process.on(sig, onSignal);

  say('═'.repeat(64));
  say(`  DeskMinis 发版冒烟${mock ? '（--mock：anthropic、deepseek 连脚本内起的假端点）' : '（真 key）'}`);
  say('═'.repeat(64));
  say(`临时目录：${tempRoot}`);
  say(vault.kind === 'keyring'
    ? `凭据库：系统凭据库，服务名 ${vault.service}（结束时删掉本次写入的条目并核对）`
    : `凭据库：引擎的内存凭据库（DESKMINIS_TEST=1），key 只在引擎进程内存里${vault.reason}`);

  const which = (cmd) => whichCommand(cmd, env, platform);
  const plan = CASE_NAMES.map((name) => ({ name, skip: skipReason(name, { mock, env, platform, which, only }) }));
  const results = [];
  let bootError;
  if (plan.some((p) => !p.skip)) {
    try {
      const minisdEnv = buildMinisdEnv(env, { dataRoot, logDir, keyringService: vault.kind === 'keyring' ? vault.service : undefined });
      const hs = await startMinisd(electronBin, minisdEntry, minisdEnv, ctx.engine);
      ctx.engine.booted = true;
      ctx.client = await connectRpc(hs.port, hs.token);
      say(`引擎：pid ${ctx.engine.child.pid}，端口 ${hs.port}`);
      ctx.client.onNotify((method, params) => {
        if (method !== 'permission.request') return;
        const decision = permissionDecision(params, ctx.allow);
        if (decision === 'deny') ctx.denied.push({ sessionId: params?.req?.sessionId, kind: params?.req?.kind, detail: String(params?.req?.detail ?? '') });
        ctx.client.call('permission.respond', { requestId: params?.requestId, decision }).catch(() => {});
      });
    } catch (e) {
      bootError = e;
      say(`引擎没起来：${firstLine(e)}`);
      if (ctx.engine.tail.text.trim()) say(`引擎最后的输出：\n${ctx.engine.tail.text.trimEnd()}`);
    }
  }
  for (const { name, skip } of plan) {
    if (skip) { results.push({ name, status: 'SKIP', detail: skip }); continue; }
    if (bootError) { results.push({ name, status: 'FAIL', detail: `引擎没起来：${firstLine(bootError)}` }); continue; }
    // 引擎在前面的用例里没了：余下的用例一个 RPC 也不发，直接写明原因
    const goneBefore = await engineGone(ctx, '已在前面');
    if (goneBefore) { results.push({ name, status: 'FAIL', detail: `没有跑：${goneBefore}` }); continue; }
    say(`── ${name} ──`);
    let result;
    try {
      result = { name, ...(await CASES[name](ctx)) };
    } catch (e) {
      result = { name, status: 'FAIL', detail: `异常：${firstLine(e)}` };
    }
    if (result.status === 'FAIL') {
      // 引擎在这个用例里没了：第一句就点明，免得读表的人把随之而来的「连接断了」「没有 ping」当成产品问题去查
      const goneDuring = await engineGone(ctx, '在这个用例进行中');
      if (goneDuring) result.detail = `${goneDuring}\n${result.detail}`;
    }
    results.push(result);
    if (result.status === 'FAIL' && ctx.engine.tail.text.trim()) say(`引擎最后的输出：\n${ctx.engine.tail.text.trimEnd().split('\n').slice(-20).join('\n')}`);
  }
  results.push(await cleanupOnce());
  // 打断过的话，退出由信号那条路负责（清理一完就 process.exit）：处理器留到那时，这中间再来一个信号也不会把脚本当场打死
  if (!interruptedBy) for (const sig of signals) process.removeListener(sig, onSignal);
  return { results, say };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    console.error(`参数错误：${e.message}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (args.help) { console.log(USAGE); return; }
  const deepseekModel = (process.env.DEEPSEEK_MODEL ?? '').trim() || DEEPSEEK_DEFAULT_MODEL;
  // 只在要跑 deepseek 时核对：外层 shell 里残留的 DEEPSEEK_MODEL 不该拦住只跑别的用例的人
  if ((!args.only || args.only.includes('deepseek')) && !DEEPSEEK_V4_RE.test(deepseekModel)) {
    console.error(`参数错误：DEEPSEEK_MODEL=${deepseekModel} 不是 deepseek-v4 族——这个用例要测的是 V4 的 reasoning_content 回放`);
    process.exitCode = 2;
    return;
  }
  if (!existsSync(MINISD_ENTRY)) {
    console.error(`找不到 ${MINISD_ENTRY}——先 npm run build（npm run smoke:release 会先构建）`);
    process.exitCode = 2;
    return;
  }
  let electronBin;
  try { electronBin = require('electron'); } catch { electronBin = undefined; }
  if (typeof electronBin !== 'string' || !existsSync(electronBin)) {
    console.error('找不到 electron 可执行文件——先 npm ci');
    process.exitCode = 2;
    return;
  }
  const { results, say } = await runSmoke({ ...args, deepseekModel, electronBin });
  const { lines, exitCode } = formatResults(results);
  say('═'.repeat(64));
  for (const l of lines) say(l);
  say('═'.repeat(64));
  if (exitCode !== 0) say('有 FAIL——先按上面的原因处理，不要发版（docs/RELEASE.md）。');
  // 用 exitCode 而不是 process.exit：Windows 上 stdout 接管道时是异步写，process.exit 会截掉尾部输出
  process.exitCode = exitCode;
}

// 被测试 import 时不跑 CLI。realpath 比对（同 verify-release.mjs）：Windows 盘符大小写、经符号链接调用时 URL 字符串对不上
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invokedDirectly) {
  main().catch((e) => { console.error('脚本异常：', e); process.exitCode = 1; });
}
