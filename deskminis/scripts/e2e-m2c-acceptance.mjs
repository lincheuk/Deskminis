// DeskMinis M2c 端到端验收驱动（对应 docs/plans/2026-07-28-m2c-skills.md Task 8 手工验收的可自动化部分）。
// 用法：先 `npm run build`，再 `node scripts/e2e-m2c-acceptance.mjs`。
//
// 覆盖：1) agent 直写技能目录（file_write 到 /var/minis/skills/<id>/SKILL.md，数据根内不弹权限卡）
//       2) 重启 minisd → adoptOrphans 孤儿回收 → skills.list 可见
//       3) 真实模型按 <available_skills> 提示 file_read 技能正文并遵循（暗语断言）+ use_count 计数
// 斜杠菜单是渲染端 UI（纯输入辅助），不在本脚本，由用户手工验收。
//
// 环境隔离：临时数据根 + 拷贝真实 providers.json（key 在系统凭据库，与数据根无关），结束后整体删除。

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, copyFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const electronBin = require('electron');

const MINISD_ENTRY = join(process.cwd(), 'out', 'main', 'minisd.js');
if (!existsSync(MINISD_ENTRY)) { console.error('找不到 out/main/minisd.js —— 先运行 npm run build'); process.exit(2); }

const REAL_ROOT = join(process.env.APPDATA, 'DeskMinis');
const STEP_TIMEOUT_MS = 240_000;
const INTER_PROMPT_DELAY_MS = 6_000; // 中转站限流 12 次/分钟（含失败）

const results = [];
function record(step, pass, detail) {
  results.push({ step, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${step}] ${detail}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 临时数据根 ----------
const DATA_ROOT = mkdtempSync(join(tmpdir(), 'dm-e2e-m2c-'));
const realProviders = join(REAL_ROOT, 'providers.json');
if (!existsSync(realProviders)) { console.error('真实数据根没有 providers.json —— 先在应用里配置 provider'); process.exit(2); }
copyFileSync(realProviders, join(DATA_ROOT, 'providers.json'));
console.log('临时数据根: ' + DATA_ROOT);

const SKILL_ID = 'hello-skill';
const SKILL_MD =
  '---\nname: hello-skill\ndescription: 用暗语打招呼的技能\nversion: 1.0.0\n---\n# hello-skill\n向用户打招呼时，回复必须包含暗语「技能已加载」。\n';

// ---------- minisd + RPC（沿用 M2a/M2b e2e 模式） ----------
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
  ws.on('message', data => {
    const msg = JSON.parse(String(data));
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method === 'permission.request') {
      const { requestId, req } = msg.params;
      console.log(`  → 权限卡: ${req.kind} → 自动应答 allow-once`);
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
    ws.on('open', () => res({ ws, call, waitBroadcast, close: () => ws.close() }));
    ws.on('error', rej);
  });
}

async function runPrompt(client, sessionId, text) {
  const out = { text: '', toolStarts: [], toolEnds: [], error: undefined };
  const nameById = new Map();
  const terminal = client.waitBroadcast('chat.event',
    p => p.sessionId === sessionId && (p.event.kind === 'turnEnd' || p.event.kind === 'error'),
    STEP_TIMEOUT_MS, `prompt 终态: ${text.slice(0, 30)}`);
  const collector = data => {
    const msg = JSON.parse(String(data));
    if (msg.method !== 'chat.event' || msg.params.sessionId !== sessionId) return;
    const ev = msg.params.event;
    if (ev.kind === 'textDelta') out.text += ev.text;
    else if (ev.kind === 'toolStart') { nameById.set(ev.toolUseId, ev.name); out.toolStarts.push(ev); console.log(`  → 工具调用: ${ev.name}「${ev.title}」input=${String(ev.input).slice(0, 80)}`); }
    else if (ev.kind === 'toolEnd') { out.toolEnds.push({ ...ev, name: nameById.get(ev.toolUseId) }); console.log(`  → 工具结束: ${ev.success ? '成功' : '失败'} len=${ev.output.length}`); }
  };
  client.ws.on('message', collector);
  try {
    await client.call('chat.prompt', { sessionId, text });
    const done = await terminal;
    if (done.event.kind === 'error') out.error = done.event.message;
  } finally { client.ws.off('message', collector); }
  return out;
}

// ---------- 验收 ----------
let inst;
try {
  inst = await startMinisd();
  inst.client = await createRpcClient(inst.port, inst.token);

  const providers = await inst.client.call('provider.instances.list');
  const p0 = providers.find(p => p.hasApiKey);
  if (!p0) throw new Error('临时根里没有带密钥的 provider');
  console.log(`provider: ${p0.name || p0.modelId} (${p0.kind}:${p0.modelId})\n`);

  // —— 步骤 1：agent 直写技能目录（数据根内，不弹权限卡） ——
  console.log('— 步骤 1: agent 直写技能目录 —');
  const sA = (await inst.client.call('chat.sessions.create', { title: 'M2c验收-直写' })).id;
  const r1 = await runPrompt(inst.client, sA,
    `请调用 file_write 工具，在路径 /var/minis/skills/${SKILL_ID}/SKILL.md 创建文件，文件内容必须与下面反引号之间的原文一字不差（含 frontmatter 三横线）：\n\`\`\`\n${SKILL_MD}\`\`\`\n写完只回复：已创建。`);
  const wrote = r1.toolStarts.some(t => t.name === 'file_write');
  const skillFile = join(DATA_ROOT, 'skills', SKILL_ID, 'SKILL.md');
  const fileOk = existsSync(skillFile) && readFileSync(skillFile, 'utf8').includes('name: hello-skill');
  record('1. agent 直写技能目录', !r1.error && wrote && fileOk,
    r1.error ? `agent 错误: ${r1.error}` : `file_write=${wrote}；落盘=${fileOk}（${skillFile}）`);
  await sleep(INTER_PROMPT_DELAY_MS);

  // —— 步骤 2：重启 minisd → adoptOrphans → skills.list 可见 ——
  console.log('\n— 步骤 2: 重启 → 孤儿回收 —');
  inst.client.close(); inst.child.kill();
  await sleep(1500);
  inst = await startMinisd();
  inst.client = await createRpcClient(inst.port, inst.token);
  const skills = await inst.client.call('skills.list', {});
  const adopted = skills.find(s => s.id === SKILL_ID);
  record('2. 孤儿回收入库', !!adopted && adopted.description.includes('暗语'),
    adopted ? `skills.list 含 ${SKILL_ID}（description=「${adopted.description}」, useCount=${adopted.useCount}）` : `skills.list 未见 ${SKILL_ID}！（共 ${skills.length} 条）`);

  // —— 步骤 3：真实模型 file_read 技能正文并遵循 + use_count ——
  console.log('\n— 步骤 3: 技能加载与遵循 —');
  const sB = (await inst.client.call('chat.sessions.create', { title: 'M2c验收-遵循' })).id;
  const r3 = await runPrompt(inst.client, sB, `请按 ${SKILL_ID} 技能向我打招呼。`);
  const readSkill = r3.toolStarts.some(t => t.name === 'file_read' && String(t.input).includes(SKILL_ID));
  const followed = r3.text.includes('技能已加载');
  const after = (await inst.client.call('skills.list', {})).find(s => s.id === SKILL_ID);
  const counted = (after?.useCount ?? 0) >= 1;
  record('3. 技能读取+遵循+计数', !r3.error && readSkill && followed && counted,
    r3.error ? `agent 错误: ${r3.error}` : `file_read=${readSkill}；暗语遵循=${followed}（回复「${r3.text.trim().slice(0, 40)}」）；useCount=${after?.useCount}`);
} catch (e) {
  record('异常', false, e.message);
} finally {
  try { inst?.client?.close(); } catch { /* 尽力 */ }
  try { inst?.child?.kill(); } catch { /* 尽力 */ }
  await sleep(800);
  try { rmSync(DATA_ROOT, { recursive: true, force: true }); console.log('\n临时数据根已清理'); }
  catch { console.warn('\n临时数据根清理失败（可手动删除）: ' + DATA_ROOT); }
}

const failed = results.filter(r => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 步通过 =====`);
console.log('（斜杠菜单为渲染端 UI，需在应用里手工验收：输入 / 弹菜单、/hell 过滤、Enter 补全）');
process.exit(failed.length ? 1 : 0);
