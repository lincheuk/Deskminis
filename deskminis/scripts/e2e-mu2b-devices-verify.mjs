// DeskMinis MU2b Task 7 Step 4 配对管理面行为验证（一次性背书脚本，e2e-mu2a 同款 CDP 基建）。
// 用法：node scripts/e2e-mu2b-devices-verify.mjs（dev 实例自启自收；跑前确认 5173/9222 无残留占用）。
//
// 覆盖（计划 Task 7 Step 4 三件套）：
//   1) 左栏「设备」开 DevicesModal → 三区块锚（已配对设备/发起配对/加入配对置灰）
//   2) 发起配对 → remote.pair.begin 出码（XXXX-XXXX 8 字连字符）+ 倒计时读秒（2s 后秒数递减）
//   3) CLI 侧完成配对（src/cli/remote-cli.mjs connect，扮演手机端）→ 2s 轮询感知 → 设备滑入列表 + 发起态清除
//   4) 移除 → 二次确认 → 列表清空
//
// 环境隔离同 mu2a：DESKMINIS_DATA_DIR=mkdtemp + DESKMINIS_TEST=1 + DESKMINIS_FAKE_PROVIDER=1 + 预置 providers.json。
// minisd port/token 经 CDP evaluate window.deskminis.minisdInfo() 取（preload minisd:info 桥，M3a 既有通道）。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const results = [];
function record(step, pass, detail) {
  results.push({ step, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${step}] ${detail}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DATA_ROOT = mkdtempSync(join(tmpdir(), 'dm-e2e-mu2b-t7-'));
writeFileSync(join(DATA_ROOT, 'providers.json'), JSON.stringify({
  providers: [{ id: '__fake__', name: 'Fake', kind: 'ollama', modelId: 'fake' }],
  defaultProviderId: '__fake__',
}, null, 2));
console.log('临时数据根: ' + DATA_ROOT);

const ELECTRON_VITE_BIN = join(process.cwd(), 'node_modules', 'electron-vite', 'bin', 'electron-vite.js');
const child = spawn(process.execPath, [ELECTRON_VITE_BIN, 'dev', '--', '--remote-debugging-port=9222'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DESKMINIS_DATA_DIR: DATA_ROOT,
    DESKMINIS_TEST: '1',
    DESKMINIS_FAKE_PROVIDER: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => process.stderr.write('[dev] ' + d));
child.stderr.on('data', d => process.stderr.write('[dev] ' + d));

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    this.id = 0;
    this.pending = new Map();
    this.ws.on('message', d => {
      const m = JSON.parse(d.toString());
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      }
    });
  }
  open() { return new Promise((res, rej) => { this.ws.on('open', res); this.ws.on('error', rej); }); }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const mid = ++this.id;
      this.pending.set(mid, { resolve, reject });
      this.ws.send(JSON.stringify({ id: mid, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* 尽力 */ } }
}

let cdp;
async function evaluate(expr) {
  const res = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) throw new Error('evaluate 异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
  return res.result?.value;
}
async function waitFor(expr, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try { v = await evaluate(expr); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`等待超时(${Math.round(timeoutMs / 1000)}s): ${label}`);
    await sleep(150);
  }
}

try {
  // —— CDP 连接（60s 轮询 9222；先等初始挂载再 reload，mu2a 沉淀技法①） ——
  console.log('等待 CDP 9222 …');
  let targets;
  {
    const t0 = Date.now();
    for (;;) {
      try { targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json()); break; } catch { /* 未就绪 */ }
      if (Date.now() - t0 > 60_000) throw new Error('9222 不透（60s）');
      await sleep(500);
    }
  }
  let page;
  {
    const t0 = Date.now();
    for (;;) {
      page = targets.find(t => t.type === 'page' && /localhost:517\d/.test(t.url))
          ?? targets.find(t => t.type === 'page' && t.url.startsWith('http://localhost:'));
      if (page) break;
      if (Date.now() - t0 > 60_000) throw new Error('找不到渲染 page');
      await sleep(500);
      targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json());
    }
  }
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await waitFor(`!!document.querySelector('textarea.field')`, 60_000, '初始挂载');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(500);
  await waitFor(`!!document.querySelector('textarea.field')`, 60_000, 'reload 后应用挂载');

  // —— 1) 左栏「设备」→ DevicesModal 三区块 ——
  await evaluate(`[...document.querySelectorAll('.lfoot .lfbtn')].find(b => b.textContent.includes('设备')).click()`);
  await waitFor(`!!document.querySelector('.modal .dtitle')`, 10_000, 'DevicesModal 出现');
  const anchorsOk = await evaluate(`(() => {
    const t = document.querySelector('.modal').textContent;
    const disabledJoin = !!document.querySelector('.codeinput:disabled') && !!document.querySelector('.joinrow .pbtn:disabled');
    return t.includes('已配对设备') && t.includes('发起配对') && t.includes('加入配对') && t.includes('M3c') && disabledJoin;
  })()`);
  record('1. DevicesModal 三区块 + 加入配对置灰（M3c）', anchorsOk === true, `三区块锚+M3c 说明+输入/按钮 disabled 断言=${anchorsOk}`);

  // —— 2) 发起配对 → 出码 + 倒计时读秒 ——
  await evaluate(`[...document.querySelectorAll('.modal .pbtn')].find(b => b.textContent.includes('发起配对')).click()`);
  await waitFor(`!!document.querySelector('.modal .code')`, 10_000, '配对码出现');
  const codeText = await evaluate(`document.querySelector('.modal .code').textContent.trim()`);
  const codeFmtOk = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(codeText);
  const stateText1 = await evaluate(`document.querySelector('.modal .codestate').textContent`);
  const sec1 = Number(/（(\d+)s）/.exec(stateText1)?.[1] ?? -1);
  await sleep(2200);
  const stateText2 = await evaluate(`document.querySelector('.modal .codestate').textContent`);
  const sec2 = Number(/（(\d+)s）/.exec(stateText2)?.[1] ?? -1);
  const countdownOk = sec1 > 0 && sec2 > 0 && sec2 < sec1 && stateText1.includes('等待对端输入');
  record('2. 出码 8 字连字符 + 倒计时读秒递减', codeFmtOk && countdownOk,
    `码=${codeText}（格式=${codeFmtOk}）倒计时 ${sec1}s → ${sec2}s（递减=${countdownOk}）`);

  // —— 3) CLI 侧完成配对 → 2s 轮询感知 → 设备滑入 + 发起态清除 ——
  const info = await evaluate(`window.deskminis.minisdInfo()`);
  const rawCode = codeText.replace('-', '');
  // remote-cli connect 第二参为「对端公钥」占位（真机用于派生 authKey；RPC 参数不含它，remote-cli.mjs L104-111 实证）
  const cli = spawnSync(process.execPath, [
    join(process.cwd(), 'src', 'cli', 'remote-cli.mjs'), 'connect', rawCode, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    '--port', String(info.port), '--token', info.token,
  ], { encoding: 'utf8', timeout: 15_000 });
  const cliOut = (cli.stdout ?? '') + (cli.stderr ?? '');
  const cliOk = cli.status === 0 && cliOut.includes('fingerprint');
  // UI 2s 轮询 → 设备卡出现（peerName=remote-cli）+ pairingSession 清除（回到「发起配对」按钮态）
  let slideOk = false;
  let slideDebug = '';
  const SLIDE_EXPR = `(() => {
      const cards = [...document.querySelectorAll('.modal .devcard')];
      const hasCli = cards.some(c => c.textContent.includes('remote-cli'));
      const backToIdle = ![...document.querySelectorAll('.modal .pbtn')].some(b => b.textContent.includes('取消'))
        && !document.querySelector('.modal .code');
      return hasCli && backToIdle;
    })()`;
  if (cliOk) {
    slideOk = await waitFor(SLIDE_EXPR, 12_000, '设备滑入 + 发起态清除').then(() => true).catch(() => false);
    if (!slideOk) {
      // 诊断：不吞异常直评同一表达式，看真实返回值/异常
      const direct = await evaluate(SLIDE_EXPR).then(v => `value=${v}`).catch(e => `throw=${e.message}`);
      slideDebug = JSON.stringify(await evaluate(`(() => {
        const cards = [...document.querySelectorAll('.modal .devcard')].map(c => c.textContent.slice(0, 60));
        return { devcards: cards, hasCode: !!document.querySelector('.modal .code'),
          modalText: document.querySelector('.modal').textContent.slice(0, 200), direct };
      })()`).catch(e => 'dump 失败: ' + e.message));
    }
  }
  record('3. CLI 完成配对 → 设备滑入列表 + 发起态清除', cliOk && slideOk,
    `remote-cli exit=${cli.status}（${cliOut.trim().split('\n')[0] ?? ''}）设备滑入+发起态清除=${slideOk}${slideDebug ? ' DEBUG=' + slideDebug : ''}`);

  // —— 4) 移除 → 二次确认 → 列表清空 ——
  await evaluate(`[...document.querySelectorAll('.modal .devcard .rbtn')].find(b => b.textContent.includes('移除')).click()`);
  await waitFor(`!![...document.querySelectorAll('.modal .devcard .rbtn')].find(b => b.textContent.includes('确认移除'))`, 5_000, '二次确认态');
  await evaluate(`[...document.querySelectorAll('.modal .devcard .rbtn')].find(b => b.textContent.includes('确认移除')).click()`);
  const clearedOk = await waitFor(`document.querySelectorAll('.modal .devcard').length === 0 && !!document.querySelector('.modal .empty')`,
    10_000, '列表清空 + 空态').then(() => true).catch(() => false);
  record('4. 移除二次确认 → 列表清空', clearedOk, `二次确认后 devcard=0 空态出现=${clearedOk}`);
} catch (e) {
  record('异常', false, e.message);
} finally {
  try { cdp?.close(); } catch { /* 尽力 */ }
  if (child.pid) {
    const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'pipe' });
    console.log(r.status === 0 ? 'dev 进程树已回收' : 'taskkill 非零退出（可能已自行退出）');
  }
  await sleep(800);
  try { rmSync(DATA_ROOT, { recursive: true, force: true }); console.log('临时数据根已清理'); }
  catch { console.warn('临时数据根清理失败（可手动删除）: ' + DATA_ROOT); }
}

const failed = results.filter(r => !r.pass);
console.log(`\n===== ${results.length - failed.length}/${results.length} 步通过 =====`);
process.exit(failed.length ? 1 : 0);
