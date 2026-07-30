// DeskMinis M2e 端到端验收驱动（对应 docs/plans/2026-07-28-m2e-windows-bridges.md「M2e 完成定义」的可自动化部分）。
// 用法：先 `npm run build`，再 `node scripts/e2e-m2e-acceptance.mjs`。
//
// 覆盖（真模型 → shell_execute → 桥 CLI → 命名管道 → 权限网关 → 真 PowerShell 副作用）：
//   1) windows-device（bypass 免桥卡）+ windows-notify（askOnce 弹桥卡 + 真系统通知）
//   2) windows-clipboard set/get（写/读两类目分别弹卡 + 系统剪贴板真实写入断言）
//   3) windows-screenshot（PNG 真落盘会话附件目录）+ windows-open（打开附件目录）+ windows-speak（真 TTS）
// 权限卡 UI 渲染与真人点击留手工验收；本脚本在 RPC 层断言 permission.request 的 kind 序列——与 UI 渲染的是同一数据。
//
// 环境隔离：临时数据根（管道名含数据根哈希，不与运行中的应用撞管）+ 拷贝真实 providers.json
// （key 在系统凭据库，与数据根无关），结束后整体删除。剪贴板旧值先存后恢复（红线）。

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const electronBin = require('electron');

const MINISD_ENTRY = join(process.cwd(), 'out', 'main', 'minisd.js');
if (!existsSync(MINISD_ENTRY)) { console.error('找不到 out/main/minisd.js —— 先运行 npm run build'); process.exit(2); }

const REAL_ROOT = join(process.env.APPDATA, 'DeskMinis');
const STEP_TIMEOUT_MS = 240_000;
const INTER_PROMPT_DELAY_MS = 10_000; // 中转站限流 12 次/分钟（含失败）；桥步骤每轮多次工具往返，加大间隔

const results = [];
function record(step, pass, detail) {
  results.push({ step, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${step}] ${detail}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 剪贴板存取（UTF-8 双向编码；-STA 保证 Clipboard 类可用） ----------
function psRun(script, stdinText) {
  return new Promise(res => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', errOut = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => errOut += d);
    p.on('close', code => res({ code, out, errOut }));
    if (stdinText !== undefined) p.stdin.end(stdinText, 'utf8'); else p.stdin.end();
  });
}
const getClipboard = async () => {
  const r = await psRun('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $t = Get-Clipboard -Raw; if ($null -ne $t) { [Console]::Out.Write($t) }');
  return r.out;
};
const setClipboard = text => text
  ? psRun('[Console]::InputEncoding=[System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())', text)
  : psRun('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()');

// ---------- 临时数据根 ----------
const DATA_ROOT = mkdtempSync(join(tmpdir(), 'dm-e2e-m2e-'));
const realProviders = join(REAL_ROOT, 'providers.json');
if (!existsSync(realProviders)) { console.error('真实数据根没有 providers.json —— 先在应用里配置 provider'); process.exit(2); }
copyFileSync(realProviders, join(DATA_ROOT, 'providers.json'));
// E2E_MODEL：只改临时根副本的 modelId（不碰真实配置）——真实配置里的模型与中转站不兼容时用
if (process.env.E2E_MODEL) {
  const pj = JSON.parse(readFileSync(join(DATA_ROOT, 'providers.json'), 'utf8'));
  for (const p of pj.providers) p.modelId = process.env.E2E_MODEL;
  writeFileSync(join(DATA_ROOT, 'providers.json'), JSON.stringify(pj, null, 2));
  console.log('模型覆盖(仅临时根): ' + process.env.E2E_MODEL);
}
console.log('临时数据根: ' + DATA_ROOT);

const CLIP_TOKEN = 'M2E-剪贴板-验收①';

// ---------- minisd + RPC（沿用 M2a/M2b/M2c e2e 模式） ----------
function startMinisd() {
  const child = spawn(electronBin, [MINISD_ENTRY], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DESKMINIS_STANDALONE: '1',
      DESKMINIS_DATA_DIR: DATA_ROOT,
      DESKMINIS_TEST: '',
      DESKMINIS_FAKE_PROVIDER: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', d => process.stderr.write('[minisd] ' + d));
  return new Promise((res, rej) => {
    let buf = '';
    const timer = setTimeout(() => rej(new Error('minisd 握手超时（30s）')), 30_000);
    child.stdout.on('data', d => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        try {
          const o = JSON.parse(line);
          if (typeof o.minisdPort === 'number' && typeof o.authToken === 'string') { clearTimeout(timer); res({ child, port: o.minisdPort, token: o.authToken }); return; }
        } catch { /* 日志行 */ }
      }
    });
    child.on('exit', c => rej(new Error('minisd 提前退出 code=' + c)));
  });
}

function createRpcClient(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`);
  let idc = 0;
  const pending = new Map();
  const waiters = [];
  const permLog = []; // 所有 permission.request 的 { kind, detail }，步骤间由调用方截段
  ws.on('message', data => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'permission.request') {
      const { requestId, req } = msg.params;
      permLog.push({ kind: req.kind, detail: req.detail });
      console.log(`  → 权限卡: kind=${req.kind}「${req.toolTitle}」→ 自动应答 allow-once`);
      const id = ++idc;
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'permission.respond', params: { requestId, decision: 'allow-once' } }));
      return;
    }
    if (msg.method) for (const w of [...waiters]) {
      let hit = false;
      try { hit = (!w.method || msg.method === w.method) && w.pred(msg.params); } catch { /* 未命中 */ }
      if (hit) { clearTimeout(w.timer); waiters.splice(waiters.indexOf(w), 1); w.resolve(msg.params); }
    }
  });
  const call = (method, params) => new Promise((res, rej) => {
    const id = ++idc;
    pending.set(id, m => m.error ? rej(new Error(`${method}: ${m.error.message ?? JSON.stringify(m.error)}`)) : res(m.result));
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  const waitBroadcast = (method, pred, timeoutMs, what) => new Promise((res, rej) => {
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); rej(new Error(`等待超时(${timeoutMs / 1000}s): ${what}`)); }, timeoutMs);
    const w = { method, pred, resolve: res, timer };
    waiters.push(w);
  });
  return new Promise((res, rej) => {
    ws.on('open', () => res({ ws, call, waitBroadcast, permLog, close: () => ws.close() }));
    ws.on('error', rej);
  });
}

async function runPrompt(client, sessionId, text) {
  const out = { text: '', toolStarts: [], toolEnds: [], error: undefined, permKinds: [] };
  const permBase = client.permLog.length;
  const nameById = new Map();
  const terminal = client.waitBroadcast('chat.event',
    p => p.sessionId === sessionId && (p.event.kind === 'turnEnd' || p.event.kind === 'error'),
    STEP_TIMEOUT_MS, `prompt 终态: ${text.slice(0, 30)}`);
  const collector = data => {
    const msg = JSON.parse(String(data));
    if (msg.method !== 'chat.event' || msg.params.sessionId !== sessionId) return;
    const ev = msg.params.event;
    if (ev.kind === 'textDelta') out.text += ev.text;
    else if (ev.kind === 'toolStart') { nameById.set(ev.toolUseId, ev.name); out.toolStarts.push(ev); console.log(`  → 工具调用: ${ev.name}「${ev.title}」input=${String(ev.input).slice(0, 110)}`); }
    else if (ev.kind === 'toolEnd') { out.toolEnds.push({ ...ev, name: nameById.get(ev.toolUseId) }); console.log(`  → 工具结束: ${ev.success ? '成功' : '失败'} len=${ev.output.length}`); }
  };
  client.ws.on('message', collector);
  try {
    await client.call('chat.prompt', { sessionId, text });
    const done = await terminal;
    if (done.event.kind === 'error') out.error = done.event.message;
  } finally { client.ws.off('message', collector); }
  out.permKinds = client.permLog.slice(permBase).map(p => p.kind);
  return out;
}

/** 汇总一轮里所有 shell_execute 的输入+输出文本，便于断言桥调用痕迹。 */
const shellTrace = r => r.toolStarts.filter(t => t.name === 'shell_execute').map(t => String(t.input)).join('\n')
  + '\n' + r.toolEnds.filter(t => t.name === 'shell_execute').map(t => String(t.output)).join('\n');

// ---------- 验收 ----------
let inst;
let savedClipboard;
try {
  savedClipboard = await getClipboard();
  console.log(`已保存用户剪贴板旧值（${savedClipboard.length} 字符，结束后恢复）\n`);

  inst = await startMinisd();
  inst.client = await createRpcClient(inst.port, inst.token);

  const providers = await inst.client.call('provider.instances.list');
  const p0 = providers.find(p => p.hasApiKey);
  if (!p0) throw new Error('临时根里没有带密钥的 provider');
  console.log(`provider: ${p0.name || p0.modelId} (${p0.kind}:${p0.modelId})\n`);

  const sid = (await inst.client.call('chat.sessions.create', { title: 'M2e验收' })).id;

  // —— 步骤 1：device（bypass 免桥卡）+ notify（askOnce 桥卡 + 真通知） ——
  console.log('— 步骤 1: windows-device + windows-notify —');
  const r1 = await runPrompt(inst.client, sid,
    '请依次做两件事，都通过会话 shell 里的桥 CLI 完成：1) 用 windows-device 查看本机系统信息；2) 用 windows-notify 弹一条标题「DeskMinis」正文「M2E验收」的系统通知。做完用一句话汇报设备信息要点。');
  const t1 = shellTrace(r1);
  const usedDevice = t1.includes('windows-device');
  const usedNotify = t1.includes('windows-notify');
  const noDeviceCard = !r1.permKinds.includes('bridge-device');
  const notifyCard = r1.permKinds.includes('bridge-notify');
  record('1. device 免桥卡 + notify 弹桥卡', !r1.error && usedDevice && usedNotify && noDeviceCard && notifyCard,
    r1.error ? `agent 错误: ${r1.error}` : `device调用=${usedDevice} notify调用=${usedNotify} 桥卡序列=[${r1.permKinds.join(', ')}]（应无 bridge-device、有 bridge-notify）`);
  await sleep(INTER_PROMPT_DELAY_MS);

  // —— 步骤 2：clipboard 写/读两类目分别弹卡 + 系统剪贴板真实写入 ——
  console.log('\n— 步骤 2: windows-clipboard set→get —');
  const r2 = await runPrompt(inst.client, sid,
    `请用桥 CLI 的 windows-clipboard：先把文本「${CLIP_TOKEN}」原样写进剪贴板（set），再读出来（get），最后原样告诉我读到的内容。`);
  const writeCard = r2.permKinds.includes('bridge-clipboard-write');
  const readCard = r2.permKinds.includes('bridge-clipboard-read');
  // 只看最终回复：shellTrace 含 set 命令入参，用它匹配 token 会平凡为真
  const readBack = r2.text.includes(CLIP_TOKEN);
  const sysClip = await getClipboard();
  const sysClipOk = sysClip.trim() === CLIP_TOKEN; // 直接读系统剪贴板：副作用真实发生（测试期间请勿手动复制）
  record('2. 剪贴板写/读分卡 + 真实写入', !r2.error && writeCard && readCard && readBack && sysClipOk,
    r2.error ? `agent 错误: ${r2.error}` : `写卡=${writeCard} 读卡=${readCard} 读回=${readBack} 系统剪贴板=「${sysClip.trim().slice(0, 30)}」匹配=${sysClipOk}`);
  await sleep(INTER_PROMPT_DELAY_MS);

  // —— 步骤 3：screenshot PNG 落盘 + open 打开附件目录 + speak 真 TTS ——
  console.log('\n— 步骤 3: windows-screenshot + windows-open + windows-speak —');
  const r3 = await runPrompt(inst.client, sid,
    '请用桥 CLI 依次：1) windows-screenshot 截一张屏；2) 用 windows-open 打开截图所在的目录；3) 用 windows-speak 语音播报「验收完成」。最后汇报截图保存路径。');
  const shotCard = r3.permKinds.includes('bridge-screenshot');
  const openCard = r3.permKinds.includes('bridge-open');
  const speakCard = r3.permKinds.includes('bridge-speak');
  // speak 断言链路到达音频层即可：无活动音频端点的环境（含本驱动的非交互上下文）会 EXEC_ERROR AudioException，
  // 属环境事实而非产品缺陷；TTS 可闻性留手工验收（应用内交互会话）。
  const endOuts3 = r3.toolEnds.map(t => String(t.output)).join('\n');
  const speakChain = endOuts3.includes('"spoken"') || endOuts3.includes('音频设备') || endOuts3.includes('AudioException');
  const attachDir = join(DATA_ROOT, 'sessions', sid, 'attachments');
  const pngs = existsSync(attachDir) ? readdirSync(attachDir).filter(f => /^screenshot-.*\.png$/.test(f)) : [];
  const pngOk = pngs.length > 0 && statSync(join(attachDir, pngs[0])).size > 10_000; // 真屏 PNG 远大于 10KB
  record('3. 截屏落盘 + open/speak 弹卡', !r3.error && shotCard && openCard && speakCard && speakChain && pngOk,
    r3.error ? `agent 错误: ${r3.error}` : `桥卡=[${r3.permKinds.join(', ')}] speak链路=${speakChain} PNG=${pngs[0] ?? '无'}（${pngOk ? statSync(join(attachDir, pngs[0])).size + 'B' : 'MISSING'}）`);
} catch (e) {
  record('异常', false, e.message);
} finally {
  try { inst?.client?.close(); } catch { /* 尽力 */ }
  try { inst?.child?.kill(); } catch { /* 尽力 */ }
  await sleep(800);
  if (savedClipboard !== undefined) {
    try { await setClipboard(savedClipboard); console.log('\n用户剪贴板已恢复'); }
    catch { console.warn('\n剪贴板恢复失败——旧值前 50 字符: ' + savedClipboard.slice(0, 50)); }
  }
  try { rmSync(DATA_ROOT, { recursive: true, force: true }); console.log('临时数据根已清理'); }
  catch { console.warn('临时数据根清理失败（可手动删除）: ' + DATA_ROOT); }
}

const failed = results.filter(r => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 步通过 =====`);
console.log('（权限卡 UI 渲染与真人点击、跨会话重问，请在应用里按手工验收指引过一遍）');
process.exit(failed.length ? 1 : 0);
