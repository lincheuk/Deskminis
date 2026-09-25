// W1b-5 实拍（lifecycle.md xvfb 节「退出」）：会话运行中、权限卡挂着时退出应用。
// 期望：窗口立即消失；5 秒内全部进程退出（远早于 5 秒 = 走的是优雅停，不是超时 kill）；MCP 子进程不留孤儿；
// 数据根锁被释放（锁文件不在 = close 走到了最后一步）；库里 tool_use 后面紧跟 [已取消] 的 toolResult；
// 重启后打开这个会话，看得到这一步的结果，没有报错条。
//
// 退出走 app.quit()：托盘菜单「退出 DeskMinis」的 click 就是 app.quit()，before-quit 走的是同一条路。
// 用法：NODE_PATH=<scratchpad>/driver/node_modules xvfb-run -a node W1b-5-quit.mjs
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const { _electron: electron } = createRequire(import.meta.url)('playwright-core');
// better-sqlite3 是按 Electron 的 ABI 编的，纯 node 加载不了；读库用 python 自带的 sqlite3
function sql(dbFile, query, ...params) {
  const py = 'import sqlite3,json,sys\nc=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True)\nprint(json.dumps([list(r) for r in c.execute(sys.argv[2],json.loads(sys.argv[3]))]))';
  return JSON.parse(execFileSync('python3', ['-c', py, dbFile, query, JSON.stringify(params)], { encoding: 'utf8' }));
}

const APP = '/home/user/wt-d1/deskminis';
const S = '/tmp/claude-0/-home-user-Deskminis/5978fcde-ee7d-5c03-bdf0-67da609444f2/scratchpad';
const SHOTS = join(S, 'hemo-shots');
const X11 = join(S, 'hemo-drivers/W1a-8-x11.py');
const ELECTRON = join(APP, 'node_modules/electron/dist/electron');
const MCP_FIXTURE = join(APP, 'tests/mcp-stdio-server.mjs');
mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const x11 = (...args) => JSON.parse(execFileSync('python3', [X11, ...args], { encoding: 'utf8' }));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); };
const log = (...a) => console.log('[W1b-5]', ...a);

/** /proc 里全部进程的 pid → { ppid, cmd, env }。 */
function procTable() {
  const t = new Map();
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, 'utf8');
      const ppid = +stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1];
      const cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8').split('\0').join(' ');
      let env = ''; try { env = readFileSync(`/proc/${d}/environ`, 'utf8'); } catch { /* */ }
      t.set(+d, { ppid, cmd, env });
    } catch { /* 进程已退 */ }
  }
  return t;
}
/** 以 rootPid 为根的整棵进程树（含自己）。 */
function treeOf(rootPid) {
  const t = procTable();
  const out = [];
  const walk = (pid) => { const p = t.get(pid); if (!p) return; out.push({ pid, cmd: p.cmd }); for (const [c, q] of t) if (q.ppid === pid) walk(c); };
  walk(rootPid);
  return out;
}
const alive = (pid) => { try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return !/\) [ZX] /.test(s); } catch { return false; } };

function env(root) {
  const e = { ...process.env, DESKMINIS_DATA_DIR: root, DESKMINIS_FAKE_PROVIDER: '1' };
  delete e.ELECTRON_RUN_AS_NODE;
  return e;
}
/** 在主进程里挂探针：第一次 before-quit 之后（应用自己的处理器已跑完）记下窗口可见性、托盘是否已收；
 *  will-quit 时记下时刻。写到文件里——主进程退得很快，driver 来不及回头问。 */
async function installQuitProbe(app, file) {
  await app.evaluate(({ app: a, BrowserWindow }, file) => {
    const fs = process.getBuiltinModule('fs');
    const rec = { t0: Date.now(), beforeQuit: [], willQuit: null };
    const flush = () => { try { fs.writeFileSync(file, JSON.stringify(rec)); } catch { /* */ } };
    a.on('before-quit', (e) => {
      rec.beforeQuit.push({ at: Date.now(), prevented: e.defaultPrevented, visible: BrowserWindow.getAllWindows().map((w) => w.isVisible()) });
      flush();
    });
    a.on('will-quit', () => { rec.willQuit = Date.now(); flush(); });
  }, file);
}
const stderrProblems = (text) => text.split('\n').filter((l) => !l.startsWith('[') && /not open|Unhandled|uncaught|TypeError|minisd 启动失败|Error:/i.test(l));

async function launch(root) {
  const app = await electron.launch({ executablePath: ELECTRON, args: ['--no-sandbox', '.'], cwd: APP, timeout: 45_000, env: env(root) });
  let stderr = '';
  app.process().stderr?.on('data', (d) => { stderr += d; });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) { page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null; if (!page) await sleep(250); }
  if (!page) page = await app.firstWindow();
  await page.waitForSelector('textarea.field', { timeout: 30_000 });
  await sleep(1500);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  return { app, page, stderr: () => stderr };
}

const root = mkdtempSync(join(S, 'W1b-5-quit-'));
writeFileSync(join(root, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
// 一台真的 stdio MCP：run 开始时 minisd 会把它拉起来，退出后它不该留成孤儿
mkdirSync(join(root, 'mcp-servers'), { recursive: true });
writeFileSync(join(root, 'mcp-servers', 'servers.json'), JSON.stringify({ mcpServers: { stub: { command: ELECTRON, args: [MCP_FIXTURE], env: { ELECTRON_RUN_AS_NODE: '1' } } } }));

// ---------- 第一段：权限卡挂着时退出 ----------
let sessionId;
{
  const { app, page, stderr } = await launch(root);
  const mainPid = app.process().pid;
  await page.evaluate((payload) => {
    const ta = document.querySelector('textarea.field');
    ta.focus(); ta.value = payload;
    ta.setSelectionRange(ta.value.length, ta.value.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }, '__tool__ file_write ' + JSON.stringify({ path: '/var/minis/skills/x/SKILL.md', content: '---\nname: x\n---\n', tool_title: '写一个技能' }));
  await sleep(250);
  await page.keyboard.press('Enter');
  let seen = false;
  for (let i = 0; i < 50 && !seen; i++) { await sleep(300); seen = await page.evaluate(() => !!document.querySelector('.perm')); }
  check('权限卡出现（run 正卡在权限上）', seen);
  await sleep(600);
  await page.screenshot({ path: join(SHOTS, 'W1b-5-quit-before.png') });
  sessionId = await page.evaluate(() => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat.activeId);

  const tree = treeOf(mainPid);
  const minisd = tree.find((p) => p.cmd.includes('node.mojom.NodeService'));
  const mcp = tree.find((p) => p.cmd.includes('mcp-stdio-server.mjs'));
  check('退出前：minisd 与它拉起的 MCP 子进程都在', !!minisd && !!mcp, `minisd=${minisd?.pid} mcp=${mcp?.pid}`);
  check('退出前：数据根锁在盘上', existsSync(join(root, 'minisd.lock')));
  log('tree before:', tree.map((p) => `${p.pid} ${p.cmd.slice(0, 90)}`).join(' | '));

  const PROBE = join(root, '..', 'W1b-5-quit-probe-' + Date.now() + '.json');
  await installQuitProbe(app, PROBE);
  let exitAt = null;
  app.process().on('exit', () => { exitAt = Date.now(); });
  const t0 = Date.now();
  // 与托盘「退出 DeskMinis」同一条路：app.quit() → before-quit
  void app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); }).catch(() => {});
  for (let i = 0; i < 100 && exitAt === null; i++) await sleep(100);
  const ms = exitAt === null ? null : exitAt - t0;
  check('主进程在 5 秒内退出，且远早于超时（优雅停，不是 kill 兜底）', ms !== null && ms < 4000, `${ms}ms`);
  await sleep(500);
  const leftovers = [minisd, mcp, ...tree].filter(Boolean).filter((p) => alive(p.pid));
  check('整棵进程树都退了（minisd、MCP 子进程不留孤儿）', leftovers.length === 0, JSON.stringify(leftovers.map((p) => p.pid)));
  check('数据根锁已释放（close 走到了最后一步）', !existsSync(join(root, 'minisd.lock')));
  check('技能文件没写（没批准）', !existsSync(join(root, 'skills', 'x', 'SKILL.md')));
  const errLines = stderrProblems(stderr());
  check('主进程 stderr 没有「库已关闭」/未处理异常', errLines.length === 0, errLines.slice(0, 3).join(' | '));
  const probe = JSON.parse(readFileSync(PROBE, 'utf8'));
  const first = probe.beforeQuit[0];
  check('第一次 before-quit 被挡住，处理完窗口已全部隐藏', first?.prevented === true && first.visible.every((v) => v === false), JSON.stringify(first));
  check('停完才真正退出：第二次 before-quit 放行，will-quit 在它之后',
    probe.beforeQuit.length >= 2 && probe.beforeQuit.at(-1).prevented === false && probe.willQuit >= probe.beforeQuit.at(-1).at,
    `before-quit×${probe.beforeQuit.length}，停止耗时 ${probe.beforeQuit.at(-1)?.at - first?.at}ms`);

  const rows = sql(join(root, 'minis.db'), 'SELECT role, parts_json FROM messages WHERE session_id = ? ORDER BY sort_order', sessionId).map(([role, parts_json]) => ({ role, parts_json }));
  const audit = sql(join(root, 'minis.db'), "SELECT payload_json FROM audit_logs WHERE event_type = 'permission.resolved'").map(([p]) => JSON.parse(p).reason);
  const iUse = rows.findIndex((r) => r.role === 'assistant' && JSON.parse(r.parts_json).some((p) => p.type === 'toolUse'));
  const tr = iUse >= 0 ? JSON.parse(rows[iUse + 1]?.parts_json ?? '[]').find((p) => p.type === 'toolResult') : undefined;
  check('库里 tool_use 后面紧跟 [已取消] 的 toolResult', tr?.value?.output === '[已取消]' && tr?.value?.success === false, JSON.stringify(tr?.value ?? rows.map((r) => r.role)));
  check('审计里这张卡按 shutdown 了结', audit.includes('shutdown'), JSON.stringify(audit));
}

// ---------- 第二段：重启后打开这个会话 ----------
{
  const { app, page, stderr } = await launch(root);
  await page.evaluate((sid) => document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('chat').open(sid), sessionId);
  await sleep(1500);
  const dom = await page.evaluate(() => ({
    errBar: document.querySelector('.err')?.textContent?.trim() ?? '',
    perm: document.querySelectorAll('.perm').length,
    text: document.body.innerText.slice(0, 4000),
    lastError: document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value.chat.lastError,
  }));
  check('重启后打开会话：没有报错条、没有残留权限卡', dom.errBar === '' && dom.perm === 0 && !dom.lastError, JSON.stringify({ errBar: dom.errBar, perm: dom.perm, lastError: dom.lastError }));
  await page.screenshot({ path: join(SHOTS, 'W1b-5-quit-reopen.png') });
  // 展开这一步看结果原文（工具步骤默认折叠）
  const expanded = await page.evaluate(() => {
    const el = document.querySelector('.grp .head'); if (!el) return 'NOT_FOUND'; el.click(); return 'OK';
  });
  await sleep(800);
  const step = await page.evaluate(() => {
    const st = document.querySelector('.grp .step');
    return st ? { title: st.querySelector('.stitle')?.textContent?.trim(), bad: !!st.querySelector('.dot.bad'), outs: [...st.querySelectorAll('pre.out')].map((e) => e.textContent.trim().slice(0, 80)) } : null;
  });
  check('展开这一步：标题是工具标题、标失败、结果原文是 [已取消]（不是「被用户拒绝」）',
    step?.title === '写一个技能' && step.bad && step.outs.includes('[已取消]') && !step.outs.some((o) => o.includes('被用户拒绝')), `expand=${expanded} ${JSON.stringify(step)}`);
  await page.screenshot({ path: join(SHOTS, 'W1b-5-quit-reopen-expanded.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await sleep(400);
  await page.screenshot({ path: join(SHOTS, 'W1b-5-quit-reopen-dark.png') });
  // 这一次也走退出，顺带看空闲时退出多快
  let exitAt = null;
  app.process().on('exit', () => { exitAt = Date.now(); });
  const t0 = Date.now();
  void app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); }).catch(() => {});
  for (let i = 0; i < 100 && exitAt === null; i++) await sleep(100);
  check('空闲时退出也很快', exitAt !== null && exitAt - t0 < 3000, `${exitAt === null ? null : exitAt - t0}ms`);
  check('第二段 stderr 干净', stderrProblems(stderr()).length === 0, stderrProblems(stderr()).slice(0, 2).join(' | '));
  check('第二次退出后锁也已释放', !existsSync(join(root, 'minisd.lock')));
}

// ---------- 第三段：minisd 卡死不应答 → 主进程 5 秒兜底 kill，退出不被卡住 ----------
{
  const root3 = mkdtempSync(join(S, 'W1b-5-hang-'));
  writeFileSync(join(root3, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
  const { app, stderr } = await launch(root3);
  const tree = treeOf(app.process().pid);
  const minisd = tree.find((p) => p.cmd.includes('node.mojom.NodeService'));
  check('卡死前 minisd 在', !!minisd, String(minisd?.pid));
  x11('shot', join(SHOTS, 'W1b-5-hang-before.png')); // 对照：退出前根窗口上看得到应用窗口
  process.kill(minisd.pid, 'SIGSTOP'); // 冻住：收不到也回不了 shutdown
  const PROBE = join(S, 'W1b-5-hang-probe-' + Date.now() + '.json');
  await installQuitProbe(app, PROBE);
  let exitAt = null;
  app.process().on('exit', () => { exitAt = Date.now(); });
  const t0 = Date.now();
  void app.evaluate(({ app: a }) => { setTimeout(() => a.quit(), 0); }).catch(() => {});
  await sleep(1500);
  x11('shot', join(SHOTS, 'W1b-5-hang-during.png'));
  check('等 minisd 期间主进程还在、窗口已隐藏', exitAt === null && JSON.parse(readFileSync(PROBE, 'utf8')).beforeQuit[0]?.visible.every((v) => v === false), `${Date.now() - t0}ms`);
  for (let i = 0; i < 120 && exitAt === null; i++) await sleep(100);
  const ms = exitAt === null ? null : exitAt - t0;
  check('约 5 秒后兜底 kill，主进程退出（不会永远卡住）', ms !== null && ms >= 4900 && ms < 8000, `${ms}ms`);
  await sleep(800);
  // 被 SIGSTOP 冻住的进程收到 SIGTERM 不会立刻死，信号挂在待处理位上；解冻后才生效。
  // 所以先看挂起信号里有没有 SIGTERM（第 15 号，掩码 0x4000）——有就说明主进程的兜底 kill() 真的发到了它身上
  const stateOf = (pid) => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].slice(0, 1); } catch { return 'gone'; } };
  const pendingTerm = (pid) => {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const masks = ['SigPnd', 'ShdPnd'].map((k) => BigInt('0x' + (new RegExp(`^${k}:\\s*([0-9a-f]+)`, 'm').exec(status)?.[1] ?? '0')));
      return masks.some((m) => (m & 0x4000n) !== 0n);
    } catch { return null; }
  };
  const st0 = stateOf(minisd.pid);
  const pend = pendingTerm(minisd.pid);
  check('兜底 kill() 发到了被冻住的 minisd（挂起信号里有 SIGTERM，或它已不在）', st0 === 'gone' || st0 === 'Z' || pend === true, `state=${st0} SIGTERM 挂起=${pend}`);
  if (st0 === 'T') process.kill(minisd.pid, 'SIGCONT');
  await sleep(800);
  const st1 = stateOf(minisd.pid);
  check('解冻后它按那个 SIGTERM 退出，不留孤儿', st1 === 'gone' || st1 === 'Z', `state=${st1}`);
  if (st1 !== 'gone' && st1 !== 'Z') { try { process.kill(minisd.pid, 'SIGKILL'); } catch { /* */ } }
  check('kill 兜底时锁留在盘上（下次启动按陈旧锁接管，W1b-3 已验）', existsSync(join(root3, 'minisd.lock')));
  check('第三段 stderr 没有未处理异常', stderrProblems(stderr()).length === 0, stderrProblems(stderr()).slice(0, 2).join(' | '));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PASS`);
process.exit(failed.length ? 1 : 0);
