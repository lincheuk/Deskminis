#!/usr/bin/env node
// DeskMinis M5 打包与分发端到端验收驱动（对应 docs/plans/2026-08-08-m5-packaging.md §6 复核方实测清单）。
// 用法：先 `npm run build`，再 `npm run e2e:m5`。
// 产物路径默认读取 dist/；若 dist/ 被占用（EBUSY），可用环境变量
// DESKMINIS_M5_UNPACKED / DESKMINIS_M5_SETUP 指定实际产物根再运行。
//
// 执行方可自动断言（无需 GUI/真安装，对 win-unpacked 即可）：
//   1) extraResources 随包：resources/bridge-cli.mjs + resources/bridge-node.cmd（硬阻塞 1/2 产物面）
//   2) asarUnpack 原生模块：app.asar.unpacked 下 better-sqlite3 + @napi-rs/keyring-win32-x64-msvc（硬阻塞 3 产物面）
//   3) §6-4 打包态 ELECTRON_RUN_AS_NODE 等价性：经 PowerShell `&` 调随包垫片
//      跑一个探针 .mjs（打印 2 行 + 退出码 3），断言 stdout 全捕获、退出码正确传播。
//   4) §6-5 含空格安装路径下垫片可用：把 win-unpacked 拷到含空格临时目录（如 "My Apps\DeskMinis"），
//      复测同一探针，断言 %~dp0..\DeskMinis.exe 定位正确、stdout 与退出码正常。
//
// 复核方真机项（本脚本只给出指导与占位，不自动执行，避免无 GUI 环境误报）：
//   - NSIS 安装包干净安装 → 主窗口 / 托盘 / minisd 起 / DB 建 / keyring 存取 / dry-run 全项 / 六桥逐一
//   - portable 形态同一数据根
// 若构建产物不存在，脚本给出明确「先构建」提示并以退出码 2 结束（与其它 e2e 脚本一致）。

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CWD = process.cwd();
const results = [];
const record = (step, pass, detail) => { results.push({ step, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  [${step}] ${detail}`); };
const isWin = process.platform === 'win32';

// 产物路径支持环境变量注入：本机 dist/ 曾被工具宿主持有 resources/app.asar 句柄（EBUSY），
// 只能把产物构建到临时目录。复核方/执行方跑本脚本时可用环境变量指向实际产物根，绕开锁。
// 未设置时回落默认 dist/ 路径。
const UNPACKED = process.env.DESKMINIS_M5_UNPACKED || join(CWD, 'dist', 'win-unpacked');
const SETUP = process.env.DESKMINIS_M5_SETUP || join(CWD, 'dist', 'DeskMinis-0.1.1-Setup.exe');

async function main() {
  console.log('═'.repeat(64));
  console.log('  DeskMinis M5 打包验收驱动');
  console.log('═'.repeat(64));

  if (!isWin) { console.error('该脚本仅支持 Windows。'); process.exit(2); }

  // ---- 定位打包形态 ----
  let appRoot = null;
  if (existsSync(join(UNPACKED, 'DeskMinis.exe'))) appRoot = UNPACKED;
  else if (existsSync(SETUP)) appRoot = null; // 安装器存在但未解包，靠下方安装段
  else {
    console.error('错误：未找到打包产物。');
    console.error('  请先：npm run build && npx electron-builder --dir');
    console.error('  期望路径: dist/win-unpacked/DeskMinis.exe');
    console.error('  若 dist/ 被占用（EBUSY，如工具宿主已持有 resources/app.asar 句柄），');
    console.error('  请把产物构建到临时目录，并用环境变量指定产物根绕开锁：');
    console.error('    $env:DESKMINIS_M5_UNPACKED="<临时目录>/win-unpacked"');
    console.error('    $env:DESKMINIS_M5_SETUP="<临时目录>/DeskMinis-0.1.1-Setup.exe"');
    console.error('    再运行: npm run e2e:m5');
    process.exit(2);
  }

  // 若安装了 NSIS 安装器，尝试静默安装到含空格临时目录做真机验证（§6-1/§6-5 强校验）。
  if (existsSync(SETUP)) {
    await installAndVerify(SETUP);
  } else {
    console.log('\n[提示] 未发现 NSIS 安装器（dist/DeskMinis-0.1.1-Setup.exe），跳过 §6-1 安装段；仅验证 win-unpacked 产物面。');
  }

  if (appRoot) await verifyUnpacked(appRoot);

  // ---- 汇总 ----
  const failed = results.filter(r => !r.pass).length;
  console.log('\n' + '═'.repeat(64));
  console.log(`  自动断言汇总：${results.length - failed}/${results.length} PASS`);
  console.log('═'.repeat(64));
  if (failed > 0) { console.error(`有 ${failed} 项自动断言失败，请检查上方 FAIL 项。`); process.exit(1); }

  console.log('\n下列复核方真机项需在真机安装后人工确认（不在本脚本自动断言内）：');
  console.log('  - NSIS 干净安装后主窗口渲染 / 托盘图标 / minisd 起 / DB 建 / keyring 存取');
  console.log('  - dry-run 全项（桥 Node 解析在垫片缺失极端情形下 warning 且 detail 明确）');
  console.log('  - 六桥逐一（windows-notify/clipboard/open/speak/screenshot/device）');
  console.log('  - portable 形态读同一 %APPDATA%/DeskMinis 数据根（不迁移、不丢）');
  process.exit(0);
}

/** 用随包垫片跑一个探针脚本，断言 stdout 全捕获 + 退出码正确传播（§6-4）。 */
function shimProbe(shimPath, probeFile) {
  // 经 PowerShell & 调用垫片，垫片内部 set ELECTRON_RUN_AS_NODE=1 调 "%~dp0..\DeskMinis.exe" <probe>
  const ps = `& '${shimPath}' '${probeFile}'; exit $LASTEXITCODE`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  return r;
}

function writeProbe(dir) {
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, 'console.log("probe-line-1");\nconsole.log("probe-line-2");\nprocess.exit(3);\n', 'utf8');
  return probe;
}

function assertShimEquiv(label, shimPath, probe) {
  try {
    const r = shimProbe(shimPath, probe, 2);
    const out = (r.stdout ?? '').trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const captureOk = out.includes('probe-line-1') && out.includes('probe-line-2');
    const codeOk = r.status === 3;
    record(label, captureOk && codeOk,
      captureOk && codeOk
        ? `stdout 2 行全捕获，退出码 ${r.status} 正确传播`
        : `stdout=${JSON.stringify(out)} (期望 probe-line-1/2)，exit=${r.status} (期望 3)`);
  } catch (e) {
    record(label, false, `d异常: ${e.message}`);
  }
}

async function verifyUnpacked(root) {
  const resources = join(root, 'resources');
  const unpacked = join(resources, 'app.asar.unpacked');

  // 产物面：extraResources（硬阻塞 1/2）
  record('extraResources bridge-cli', existsSync(join(resources, 'bridge-cli.mjs')),
    existsSync(join(resources, 'bridge-cli.mjs')) ? join(resources, 'bridge-cli.mjs') : '缺失');
  record('extraResources bridge-node.cmd', existsSync(join(resources, 'bridge-node.cmd')),
    existsSync(join(resources, 'bridge-node.cmd')) ? join(resources, 'bridge-node.cmd') : '缺失');

  // 产物面：asarUnpack 原生模块（硬阻塞 3）
  record('asarUnpack better-sqlite3',
    existsSync(join(unpacked, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')),
    existsSync(join(unpacked, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'))
      ? 'better_sqlite3.node 已解包' : '缺失');
  record('asarUnpack @napi-rs/keyring',
    existsSync(join(unpacked, 'node_modules', '@napi-rs', 'keyring-win32-x64-msvc', 'keyring.win32-x64-msvc.node')),
    existsSync(join(unpacked, 'node_modules', '@napi-rs', 'keyring-win32-x64-msvc', 'keyring.win32-x64-msvc.node'))
      ? 'keyring.win32-x64-msvc.node 已解包' : '缺失');

  // §6-4 打包态 ELECTRON_RUN_AS_NODE 等价性
  const probe = writeProbe(root);
  const shim = join(resources, 'bridge-node.cmd');
  assertShimEquiv('§6-4 垫片 ELECTRON_RUN_AS_NODE 等价性', shim, probe);
  rmSync(probe, { force: true });

  // §6-5 含空格安装路径下垫片可用：拷贝到含空格临时目录复测
  const spaced = mkdtempSync(join(tmpdir(), 'My Apps DeskMinis-'));
  const spacedRoot = join(spaced, 'DeskMinis');
  try {
    cpSync(root, spacedRoot, { recursive: true });
    const probe2 = writeProbe(spacedRoot);
    const shim2 = join(spacedRoot, 'resources', 'bridge-node.cmd');
    assertShimEquiv('§6-5 含空格路径垫片可用', shim2, probe2);
    rmSync(probe2, { force: true });
  } finally {
    try { rmSync(spaced, { recursive: true, force: true }); } catch { /* 锁则忽略 */ }
  }
}

async function installAndVerify(setupExe) {
  const target = mkdtempSync(join(tmpdir(), 'DeskMinis Install ')); // 含空格
  const installDir = join(target, 'Program Files', 'DeskMinis');
  try {
    const r = spawnSync(setupExe, [`/S`, `/D=${installDir}`], { encoding: 'utf8', timeout: 180000, windowsHide: true });
    const waitMs = 60000;
    await sleep(waitMs); // NSIS /S 静默安装，等待落盘
    const exe = join(installDir, 'DeskMinis.exe');
    if (!existsSync(exe)) {
      record('§6-1 NSIS 静默安装', false, `安装后未找到 ${exe}（exit=${r.status}）`);
      return;
    }
    record('§6-1 NSIS 静默安装', true, `已安装到 ${installDir}`);
    await verifyUnpacked(installDir);
  } catch (e) {
    record('§6-1 NSIS 静默安装', false, `安装异常: ${e.message}`);
  } finally {
    try { rmSync(target, { recursive: true, force: true }); } catch { /* 锁则忽略 */ }
  }
}

const sleep = ms => new Promise(iv => setTimeout(iv, ms));

main().catch(e => { console.error('脚本异常:', e); process.exit(1); });