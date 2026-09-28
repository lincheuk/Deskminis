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
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, cpSync, copyFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CWD = process.cwd();
const results = [];
const record = (step, pass, detail) => { results.push({ step, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  [${step}] ${detail}`); };
const isWin = process.platform === 'win32';

// 产物路径支持环境变量注入：本机 dist/ 曾被工具宿主持有 resources/app.asar 句柄（EBUSY），
// 只能把产物构建到临时目录。复核方/执行方跑本脚本时可用环境变量指向实际产物根，绕开锁。
// 未设置时回落默认 dist/ 路径。
const UNPACKED = process.env.DESKMINIS_M5_UNPACKED || join(CWD, 'dist', 'win-unpacked');
// 版本号读 package.json（R 波修根：0.1.1 曾硬编码在此，升版后默认路径悄悄失效只剩提示误导）
const PKG_VERSION = JSON.parse(readFileSync(join(CWD, 'package.json'), 'utf8')).version;
const SETUP_NAME = `DeskMinis-${PKG_VERSION}-Setup.exe`;
const SETUP = process.env.DESKMINIS_M5_SETUP || join(CWD, 'dist', SETUP_NAME);

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
    console.error(`    $env:DESKMINIS_M5_SETUP="<临时目录>/${SETUP_NAME}"`);
    console.error('    再运行: npm run e2e:m5');
    process.exit(2);
  }

  // 若安装了 NSIS 安装器，尝试静默安装到含空格临时目录做真机验证（§6-1/§6-5 强校验）。
  if (existsSync(SETUP)) {
    await installAndVerify(SETUP);
  } else {
    console.log(`\n[提示] 未发现 NSIS 安装器（dist/${SETUP_NAME}），跳过 §6-1 安装段；仅验证 win-unpacked 产物面。`);
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

/** 安装目录里 electron-builder 生成的卸载程序：名字随 electron-builder.yml 的 productName（tests/e2e-m5-uninstall.test.ts 核对）。 */
export function uninstallerPath(installDir) {
  return join(installDir, 'Uninstall DeskMinis.exe');
}

/** NSIS 卸载程序的参数：/S 静默；_?=<目录> 让它在本进程里跑完才返回（不给的话它先把自己拷到临时目录再起、原进程立刻退出，
 *  spawnSync 等不到卸完），也决定 un.onInit 里「正在运行」那道检查看哪个目录。卸哪个目录不由它定：un.onInit 接着 initMultiUser，
 *  按「仅为我」读 HKCU\Software\<GUID> 的 InstallLocation 覆盖 $INSTDIR——卸的是登记的那个目录，也就是 §6-1 刚装的这份（W3-e2ef 订正）。
 *  _?= 必须是最后一个参数。 */
export function uninstallArgs(installDir) {
  return ['/S', `_?=${installDir}`];
}

/** 起卸载程序时给 spawnSync 的选项（W3-e2e 审查修）。NSIS 从命令行末尾往前找「 _?=」，其后整段当 $INSTDIR，
 *  所以 _?= 这一段不能带引号——路径有空格也不能（NSIS 手册 3.2）。Node 在 Windows 上会给含空格的参数整段加引号，
 *  而这里的临时安装目录故意带空格（「DeskMinis Install …\Program Files\DeskMinis」）：加了引号 NSIS 就认不出，
 *  照没给 _?= 处理，spawnSync 立刻返回、收尾记成失败、删目录与后台卸载抢文件。
 *  所以命令行按原样拼（windowsVerbatimArguments），程序路径带空格（临时目录名里就有），由这里加引号（argv0）。
 *  安装那一步的 /D= 同样会被加引号，但 electron-builder 的安装程序自己从完整命令行里取 /D= 之后的整段（multiUser.nsh 的 GetDParameter），
 *  真机上装进了带空格的临时目录；卸载程序没有这一层，靠的是 NSIS 自己的解析。 */
export function uninstallSpawnOptions(exePath) {
  return { argv0: `"${exePath}"`, windowsVerbatimArguments: true };
}

/** 真正去跑的那一份卸载程序：拷到安装目录之外（W3-e2ed，二审必修）。electron-builder 的卸载程序静默运行时，在 un.onInit 里
 *  先把「路径以 $INSTDIR 开头的进程」一律结束（allowOnlyOneInstallerInstance.nsh 的 FIND_PROCESS / KILL_PROCESS，
 *  PowerShell 那一支不排除自己）——就地跑的卸载程序本身就在 $INSTDIR 里，会把自己结束掉，什么都没卸。
 *  electron-builder 自己卸旧版时也是先拷到 $PLUGINSDIR 再带 _?= 跑（installUtil.nsh 的 uninstallOldVersion）。
 *  放在临时安装的上两层（workDir；安装目录是 workDir\Program Files\DeskMinis）：跑完随临时目录一起删；
 *  路径不能以安装目录开头——那边是不分大小写的 StartsWith、不带分隔符。
 *  这样卸载时 RMDir /r 连安装目录里原来那份卸载程序一起删掉。 */
export function uninstallerCopyPath(workDir) {
  return join(workDir, 'old-uninstaller.exe');
}

/** electron-builder.yml 的 appId（tests/e2e-m5-uninstall.test.ts 核对两边一致）。 */
export const APP_ID = 'com.deskminis.app';
/** app-builder-lib 的 NsisTarget 算 GUID 用的命名空间（同一测试对 app-builder-lib 核对）。 */
export const ELECTRON_BUILDER_NS_UUID = '50e065bc-3134-11e6-9bab-38c9862bdaf3';

/** NSIS 安装程序的 GUID：appId 的 UUID v5（RFC 4122：SHA-1(命名空间 + 名字) 取前 16 字节，标版本 5 与变体位），
 *  与 electron-builder 的 UUID.v5(appId, ELECTRON_BUILDER_NS_UUID) 同一算法（W3-e2ec）。
 *  安装位置登记在 HKCU\Software\<GUID>\InstallLocation（下一次安装读的就是它），「应用和功能」的条目在 …\Uninstall\<GUID>。
 *  自己算、不引 builder-util-runtime：这份脚本只用 node: 内置模块。 */
export function appGuid(appId) {
  const ns = Buffer.from(ELECTRON_BUILDER_NS_UUID.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(Buffer.from(appId, 'utf8')).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** 收尾那一行的名字（W3-e2ec）：它是 §6-1 安装的收尾。不叫 §6-6——m5 计划 §6 的第 6 项是「六个桥逐一实测」，这里的 §6-x 都指那份清单。 */
const UNINSTALL_STEP = '§6-1 收尾：静默卸载临时安装';

/** 收尾的判定（W3-e2ec，纯函数，tests/e2e-m5-uninstall.test.ts 逐项测）：卸载程序正常跑完、DeskMinis.exe 删了、
 *  安装位置登记清了，三样都成才 PASS。以前只看退出码与 DeskMinis.exe，失败时也写成功的那句，超时（spawnSync 超时给
 *  error.code = ETIMEDOUT、signal = SIGTERM、status = null）与启动失败都看不到原因；也不核对真正要紧的那条登记。
 *  registry：'present' 还在、'absent' 清了、'unknown' reg query 本身出错。
 *  失败时只写哪里没成；怎么收拾由 uninstallTemp 按剩下的情形接在破折号后面（leftoverAdvice，W3-e2ef）。 */
export function uninstallVerdict({ status, signal, errorCode, exeGone, registry }) {
  const problems = [];
  const sig = signal ? `，信号 ${signal}` : '';
  if (errorCode) problems.push(`卸载程序没能正常跑完（${errorCode}${sig}）`);
  else if (status !== 0) problems.push(`卸载程序退出码 ${status}${sig}`);
  if (!exeGone) problems.push('DeskMinis.exe 还在');
  if (registry === 'present') problems.push('安装位置登记还在（HKCU\\Software\\<GUID> 的 InstallLocation，下次安装会照它装）');
  else if (registry === 'unknown') problems.push('查不了安装位置登记（reg query 出错）');
  return problems.length === 0
    ? { pass: true, detail: '已静默卸载：DeskMinis.exe 已删，安装位置登记已清（「应用和功能」条目与快捷方式随之清掉）' }
    : { pass: false, detail: problems.join('；') };
}

/** 收尾没做成时剩下什么、怎么收拾（W3-e2ef，纯函数）。以前一律说「卸载程序还在，到『应用和功能』里卸」，三种情形都不对：
 *  找不到卸载程序；卸载程序走完了只是文件删不掉（两处登记与卸载程序都没了，只需删目录）；卸到一半（卸载程序可能删了、登记还在）。
 *  所以按安装位置登记（registry，同 uninstallVerdict）与安装目录里那份卸载程序在不在（uninstallerLeft——「应用和功能」卸载时跑的就是它）
 *  分四种，开头那句与 RELEASE 第 2 节的表逐条对应（tests/e2e-m5-uninstall.test.ts 核对）。
 *  卸载程序最后才删两处登记（先「应用和功能」那条、紧接着安装位置，uninstaller.nsh），安装程序最先写安装位置：
 *  安装位置登记清了，「应用和功能」那条也就没了。要删的是临时目录 workDir（里面还有拷出来的那份卸载程序），不是安装目录。 */
export function leftoverAdvice({ registry, uninstallerLeft, workDir }) {
  const rm = `删掉临时目录 ${workDir}`;
  const byHand = '按 RELEASE 第 2 节「登记还在、卸载程序没了」处理';
  if (registry === 'absent') return `安装位置登记已清：「应用和功能」里也没有这一条了，不用再卸，只需${rm}`;
  if (registry === 'present') {
    return uninstallerLeft
      ? `卸载程序还在：到「应用和功能」里卸载 DeskMinis（数据保留），再${rm}`
      : `卸载程序已经不在了：「应用和功能」里卸不掉，${byHand}，再${rm}`;
  }
  const then = uninstallerLeft ? '到「应用和功能」里卸载 DeskMinis（卸载程序还在，数据保留）' : `${byHand}（卸载程序已经不在了）`;
  return `先在 PowerShell 里查登记：Test-Path 'HKCU:\\Software\\${appGuid(APP_ID)}' 是 False 就不用再卸，是 True 就${then}；最后${rm}`;
}

/** reg 两次查询的退出码 → 登记状态（W3-e2ed，纯函数）。reg 的退出码 1 是笼统的失败：找不到是 1，拒绝访问、组策略禁用了注册表工具
 *  也是 1。所以先查 HKCU\Software 本身（probe）：查得了，后面那次的 1 才当「清掉了」；查不了一律算「查不了」。 */
export function registryState(probeStatus, queryStatus) {
  if (probeStatus !== 0) return 'unknown';
  if (queryStatus === 0) return 'present';
  if (queryStatus === 1) return 'absent';
  return 'unknown';
}

/** 安装位置登记在不在（HKCU\Software\<GUID> 的 InstallLocation）。spawn 可注入（W3-e2ef）。 */
function installLocationState(guid, spawn = spawnSync) {
  const opts = { encoding: 'utf8', timeout: 15000, windowsHide: true };
  const probe = spawn('reg', ['query', 'HKCU\\Software'], opts);
  const query = spawn('reg', ['query', `HKCU\\Software\\${guid}`, '/v', 'InstallLocation'], opts);
  return registryState(probe.status, query.status);
}

/** 收尾真去查文件、拷文件、起进程、记结果的四样。可注入（W3-e2ef）：tests/e2e-m5-uninstall.test.ts 换成假的，把 uninstallTemp 的每一支真跑一遍
 *  ——以前只有源码守卫，副本落进安装目录、失败照样返回 true、reg 探测被跳过都能全绿。 */
const REAL_IO = { exists: existsSync, copy: copyFileSync, spawn: spawnSync, record };

/** 把 §6-1 静默装进临时目录的那一份静默卸掉（W3-e2e）：卸载程序会删掉 HKCU 下的安装位置、「应用和功能」里的登记
 *  与开始菜单、桌面快捷方式。以前只删目录不卸载，这些都还指着已删的临时目录，之后照 RELEASE 重装会被静默装进那个 Temp 路径
 *  （0.3.0 真机验证报告 §3.3）。数据目录不动（deleteAppDataOnUninstall: false）。
 *  跑的是拷到 workDir 的那一份，带 _?= 让它就地跑完（为什么见 uninstallerCopyPath、uninstallArgs）。
 *  返回 true 表示临时目录可以删：没装上（§6-1 已记 FAIL，没有要卸的），或卸干净了。
 *  装上了却找不到卸载程序、或收尾没做成，记 FAIL、返回 false——调用方就不删临时目录：卸载程序还在的话「应用和功能」里能正常卸
 *  （删了目录，登记就指着一个没有卸载程序的空目录，只能手工处理）。FAIL 那一行破折号后面按剩下的情形说怎么收拾（leftoverAdvice，W3-e2ef）。 */
export function uninstallTemp(installDir, workDir, io = REAL_IO) {
  const un = uninstallerPath(installDir);
  const guid = appGuid(APP_ID);
  const fail = (what, registry = installLocationState(guid, io.spawn)) => {
    io.record(UNINSTALL_STEP, false, `${what}——${leftoverAdvice({ registry, uninstallerLeft: io.exists(un), workDir })}`);
    return false;
  };
  if (!io.exists(un)) {
    return io.exists(join(installDir, 'DeskMinis.exe')) ? fail(`装上了却找不到卸载程序 ${un}`) : true;
  }
  try {
    const copy = uninstallerCopyPath(workDir);
    io.copy(un, copy);
    const r = io.spawn(copy, uninstallArgs(installDir), { ...uninstallSpawnOptions(copy), encoding: 'utf8', timeout: 180000, windowsHide: true });
    const registry = installLocationState(guid, io.spawn);
    const v = uninstallVerdict({
      status: r.status, signal: r.signal, errorCode: r.error?.code,
      exeGone: !io.exists(join(installDir, 'DeskMinis.exe')),
      registry,
    });
    if (!v.pass) return fail(v.detail, registry);
    io.record(UNINSTALL_STEP, true, v.detail);
    return true;
  } catch (e) {
    return fail(`卸载异常: ${e.message}`);
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
    // 先卸载、再删目录（W3-e2e）：只删目录的话，登记与快捷方式都还指着这个临时目录。
    // 收尾没做成就不删（W3-e2ed）：卸载程序还在的话，「应用和功能」里能正常卸。删目录带重试：杀软可能还攥着刚退出的卸载程序。
    // 怎么收拾按剩下的情形分（W3-e2ef），写在「§6-1 收尾」那一行里，要删的临时目录也写在那里
    if (uninstallTemp(installDir, target)) {
      try { rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 锁则忽略 */ }
    } else {
      console.log('  临时目录没删：照上面「§6-1 收尾」那一行破折号后面说的收拾（详见 RELEASE 第 2 节「『§6-1 收尾』那一行是 FAIL」），收拾完按第 3 节安装');
    }
  }
}

const sleep = ms => new Promise(iv => setTimeout(iv, ms));

// 被测试 import 时不跑 CLI（W3-e2e，与 smoke-release.mjs 同一认法）。realpath 比对：Windows 盘符大小写、经符号链接调用时 URL 字符串对不上
const invokedDirectly = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (invokedDirectly) main().catch(e => { console.error('脚本异常:', e); process.exit(1); });