#!/usr/bin/env node
// M4 Task 4：dry-run CLI 包装——ws 连本机 minisd 调 diagnostics.dryRun，格式化输出报告。
// 用法：node scripts/dry-run.mjs
// 不做成 npm script（避免与 npm test/npm run build 混淆）。
//
// 读取 minisd-port.json（含 port + authToken）连接本机 minisd，authMode=local。
// 如果 minisd 未运行或文件不存在，输出提示并退出。

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';

const APPDATA = process.env.APPDATA ?? join(process.env.HOME ?? '.', '.config');
const DATA_DIR = process.env.DESKMINIS_DATA_DIR ?? join(APPDATA, 'DeskMinis');
const PORT_FILE = join(DATA_DIR, 'minisd-port.json');

if (!existsSync(PORT_FILE)) {
  console.error('错误：minisd-port.json 不存在——请先启动 DeskMinis 应用（minisd 会自动运行并写入端口文件）。');
  console.error(`  预期路径: ${PORT_FILE}`);
  process.exit(1);
}

let port, authToken;
try {
  const obj = JSON.parse(readFileSync(PORT_FILE, 'utf8').replace(/\r\n/g, '\n'));
  port = obj.port;
  authToken = obj.authToken;
} catch (e) {
  console.error(`错误：minisd-port.json 解析失败: ${e.message}`);
  process.exit(1);
}

if (!port || !authToken) {
  console.error('错误：minisd-port.json 缺少 port 或 authToken——请重启 DeskMinis 应用。');
  process.exit(1);
}

const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(authToken)}`);
const id = 1;

ws.on('error', (e) => {
  console.error(`错误：无法连接 minisd (ws://127.0.0.1:${port})——请确认应用正在运行。`);
  console.error(`  ${e.message}`);
  process.exit(1);
});

ws.on('open', () => {
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'diagnostics.dryRun', params: {} }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(String(data));
  if (msg.id !== id) return;

  if (msg.error) {
    console.error(`错误：diagnostics.dryRun 调用失败: ${msg.error.message ?? JSON.stringify(msg.error)}`);
    ws.close();
    process.exit(1);
  }

  const r = msg.result;
  printReport(r);
  ws.close();
  process.exit(0);
});

function statusIcon(status) {
  return status === 'ready' ? '[OK]' : status === 'warning' ? '[!!]' : '[XX]';
}

function printReport(r) {
  console.log('═'.repeat(60));
  console.log(`  DeskMinis dry-run 预检报告`);
  console.log(`  总体状态: ${statusIcon(r.overall)} ${r.overall.toUpperCase()}`);
  console.log('═'.repeat(60));
  console.log();

  console.log('── Providers ──');
  printCheck('providers.json 完整性', r.checks.providers);
  printCheck('默认 provider', r.checks.defaultProvider);
  printCheck('降级链完整性', r.checks.fallbackChain);
  console.log();

  console.log('── 模型 ──');
  printCheck('model-catalog 窗口', r.checks.modelCatalog);
  console.log();

  console.log('── 技能 ──');
  if (r.checks.skills.length === 0) {
    console.log('  （无启用的技能）');
  } else {
    for (const s of r.checks.skills) printCheck(s.detail ?? '技能', s);
  }
  console.log();

  console.log('── 桥 ──');
  printCheck('Node.js 解析', r.checks.bridgeNode);
  console.log();

  console.log('── M3c 配对 ──');
  if (r.checks.pairing.length === 0) {
    console.log('  （无已配对设备）');
  } else {
    for (const d of r.checks.pairing) {
      console.log(`  ${d.peerName} (${d.peerFingerprint})${d.address ? ' @ ' + d.address : ''}`);
    }
  }
  console.log();

  console.log('── 系统提示预览 ──');
  console.log(`  预估 token: ${r.estimatedTokens}`);
  console.log(`  预览长度: ${r.promptPreview.length} 字符`);
  console.log();

  if (r.overall === 'blocked') {
    console.log('═'.repeat(60));
    console.log('  ⚠ 存在阻断问题，请按上述 [XX] 项修复后重试。');
    console.log('═'.repeat(60));
  } else if (r.overall === 'warning') {
    console.log('═'.repeat(60));
    console.log('  ⚠ 有非阻断警告，系统仍可运行但建议检查上述 [!!] 项。');
    console.log('═'.repeat(60));
  } else {
    console.log('═'.repeat(60));
    console.log('  ✓ 所有检查通过，系统就绪。');
    console.log('═'.repeat(60));
  }
}

function printCheck(label, check) {
  const icon = statusIcon(check.status);
  const detail = check.detail ? ` — ${check.detail}` : '';
  console.log(`  ${icon} ${label}${detail}`);
}
