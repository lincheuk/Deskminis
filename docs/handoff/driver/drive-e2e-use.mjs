// 端到端「装完能用」验证：段1 市场装技能+MCP（真 UI 流程）→ 产物取证；
// 段2 servers.json 命令等价替换为本地 fixture（云端无 npm 包运行环境）→ 重启 → 试连 → FakeProvider 会话真调 mcp__ 工具。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { execSync } from 'node:child_process';

const APP_DIR = '/home/user/Deskminis/deskminis';
const SCRATCH = '/tmp/claude-0/-home-user-Deskminis/de13f871-02f4-5133-95e9-9105e3bca00b/scratchpad';
const SHOTS = path.join(SCRATCH, 'shots');
const DATA = path.join(SCRATCH, 'use-data');
fs.mkdirSync(SHOTS, { recursive: true });
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));

const ZIP = fs.readFileSync(path.join(SCRATCH, 'driver', 'skill-pdf.zip'));
const NODE_BIN = execSync('which node').toString().trim();
const MCP_FIXTURE = path.join(APP_DIR, 'tests/mcp-stdio-server.mjs');

const clawhubSearch = JSON.stringify({ results: [{ slug: 'pdf', displayName: 'Pdf', summary: 'PDF 处理技能', downloads: 47943, ownerHandle: 'awspace', isSuspicious: false, native: { skill: { isSuspicious: false, stats: { downloads: 47943, stars: 120 } } } }] });
const clawhubDetail = JSON.stringify({ skill: { slug: 'pdf', displayName: 'Pdf', summary: 'PDF 处理技能', description: '# Pdf 技能\n处理 PDF。', stats: { downloads: 47943, stars: 120 } }, latestVersion: { version: '0.1.0' }, owner: { handle: 'awspace' }, moderation: null, metadata: null });
const clawhubScan = JSON.stringify({ skill: { slug: 'pdf' }, version: { version: '0.1.0' }, security: { status: 'clean', hasScanResult: true, hasWarnings: false, checkedAt: 1, sha256hash: 'abc' }, moderation: null });
const mcpList = JSON.stringify({ servers: [{ server: { name: 'io.github.acme/fetcher', title: 'Fetcher', description: '抓取 MCP', version: '1.0.0', packages: [{ registryType: 'npm', identifier: 'acme-fetcher-mcp', transport: { type: 'stdio' }, runtimeHint: 'npx', environmentVariables: [{ name: 'API_KEY', description: '服务密钥', isRequired: true, isSecret: true }] }] }, _meta: {} }], metadata: { nextCursor: null, count: 1 } });
const mcpDetail = JSON.stringify({ server: { name: 'io.github.acme/fetcher', title: 'Fetcher', description: '抓取 MCP 详情', version: '1.0.0', packages: [{ registryType: 'npm', identifier: 'acme-fetcher-mcp', transport: { type: 'stdio' }, runtimeHint: 'npx', environmentVariables: [{ name: 'API_KEY', description: '服务密钥', isRequired: true, isSecret: true }] }] }, _meta: {} });
const awesomeIndex = JSON.stringify({ name: 'awesome-dsh-plugin', count: 0, plugins: [] });

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(b); };
  if (u.pathname === '/plugins.json') return json(awesomeIndex);
  if (u.pathname === '/api/v1/search') return json(u.searchParams.get('q') ? clawhubSearch : '{"results":[]}');
  if (u.pathname === '/api/v1/skills/pdf') return json(clawhubDetail);
  if (u.pathname === '/api/v1/skills/pdf/scan') return json(clawhubScan);
  if (u.pathname === '/api/v1/download') { res.writeHead(200, { 'content-type': 'application/zip' }); return res.end(ZIP); }
  if (u.pathname === '/v0.1/servers') return json(mcpList);
  if (u.pathname.startsWith('/v0.1/servers/')) return json(mcpDetail);
  res.writeHead(404); res.end('{}');
});

const log = (...a) => console.log('[e2e]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ss = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); log('shot:', name); };
const click = (page, scope, text) => page.evaluate(({ scope, text }) => {
  const els = [...document.querySelectorAll(scope)];
  const el = els.find((e) => e.textContent?.trim() === text) ?? els.find((e) => e.textContent?.includes(text));
  if (!el) return 'NOT_FOUND:' + text;
  el.click(); return 'OK';
}, { scope, text });
const waitText = async (page, needle, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    if ((await page.evaluate(() => document.body.innerText)).includes(needle)) return true;
    await sleep(500);
  }
  return false;
};

async function launch(env) {
  const app = await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
    args: ['--no-sandbox', '.'], cwd: APP_DIR, timeout: 45_000, env: { ...process.env, ...env },
  });
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null;
    if (!page) await sleep(500);
  }
  if (!page) page = await app.firstWindow();
  await page.waitForSelector('body', { timeout: 15_000 });
  await sleep(4000);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  return { app, page };
}

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FIXTURE = `http://127.0.0.1:${server.address().port}`;
log('fixture at', FIXTURE);

// ═══ 段 1：市场安装（技能 + MCP） ═══
{
  const { app, page } = await launch({ DESKMINIS_DATA_DIR: DATA, DESKMINIS_MARKET_FIXTURE_URL: FIXTURE, DESKMINIS_FAKE_PROVIDER: '1' });
  try {
    await page.evaluate(() => { [...document.querySelectorAll('.wtab-main')].find((e) => e.textContent?.trim() === '扩展')?.click(); });
    await sleep(1200);
    // 技能：搜 pdf → Install → 确认安装
    await page.evaluate(() => {
      const inp = [...document.querySelectorAll('input')].filter((e) => e.type !== 'file' && e.type !== 'checkbox')[0];
      if (inp) { inp.value = 'pdf'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    await sleep(1500);
    log('skill Install →', await click(page, 'button', 'Install'));
    log('确认卡出现:', await waitText(page, '确认安装'));
    await ss(page, 'use-skill-confirm');
    log('确认安装 →', await click(page, 'button', '确认安装'));
    log('技能装完(已装/toast):', await waitText(page, '已装') || await waitText(page, '已安装', 10));
    await ss(page, 'use-skill-installed');

    // MCP：切子 tab → Install → env 填值 → 确认安装
    log('切 MCP tab →', await click(page, 'button', 'MCP'));
    await sleep(1500);
    log('mcp Install →', await click(page, 'button', 'Install'));
    log('mcp 确认卡:', await waitText(page, '确认安装'));
    // env API_KEY 填值（password 输入行）
    await sleep(1000);
    const envFill = await page.evaluate(() => {
      // dump 已证实：确认卡 env 输入是全页唯一 password 框（placeholder=服务密钥）
      const inp = document.querySelector('input[type="password"]');
      if (!inp) return 'NO_ENV_INPUT';
      inp.value = 'test-key-123';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return 'FILLED(' + inp.placeholder + ')';
    });
    log('env 填值 →', envFill);
    await ss(page, 'use-mcp-confirm');
    log('确认安装 →', await click(page, 'button', '确认安装'));
    await sleep(2500);
    await ss(page, 'use-mcp-installed');
  } finally { await app.close().catch(() => {}); }

  // 产物取证
  const sj = path.join(DATA, 'mcp-servers', 'servers.json');
  log('── servers.json 产物 ──');
  log(fs.readFileSync(sj, 'utf8'));
  const skillsDir = path.join(DATA, 'skills');
  log('── skills 目录 ──', fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir, { recursive: true }).join(', ') : 'MISSING');
}

// ═══ 段 2：等价替换命令 → 真启动 → 会话真调用 ═══
{
  const sj = path.join(DATA, 'mcp-servers', 'servers.json');
  const cfg = JSON.parse(fs.readFileSync(sj, 'utf8'));
  const names = Object.keys(cfg.mcpServers ?? cfg.servers ?? {});
  const serverName = names[0];
  const store = cfg.mcpServers ?? cfg.servers;
  log('市场装出的条目名:', serverName, '| 原命令:', JSON.stringify(store[serverName].command), store[serverName].args);
  // 等价替换：npx 包在云端不可得，换 node + 本仓 stdio fixture（条目其余字段原样，env 保留）
  store[serverName].command = NODE_BIN;
  store[serverName].args = [MCP_FIXTURE];
  fs.writeFileSync(sj, JSON.stringify(cfg, null, 2));
  log('已等价替换为 node fixture');

  const { app, page } = await launch({ DESKMINIS_DATA_DIR: DATA, DESKMINIS_FAKE_PROVIDER: '1' });
  try {
    // 新会话发 __tool__ 调 mcp__<server>__echo
    const toolName = `mcp__${serverName}__echo`;
    log('调用工具:', toolName);
    await page.evaluate((t) => {
      const ta = document.querySelector('.composer textarea, textarea');
      ta.value = t; ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, `__tool__ ${toolName} {"hi":"aurora","from":"market-install"}`);
    await sleep(300);
    await page.keyboard.press('Enter');
    // 权限卡（kind=mcp askOnce）
    const permShown = await waitText(page, '仅此次') || await waitText(page, '允许', 10);
    log('MCP 权限卡出现:', permShown);
    await ss(page, 'use-perm-card');
    if (permShown) {
      const r = await click(page, 'button', '本会话允许');
      log('点允许 →', r === 'OK' ? r : await click(page, 'button', '允许'));
    }
    // 等工具执行完成（✓ 或 echo 内容回显）
    const done = await waitText(page, 'aurora', 40);
    log('工具执行回显 aurora:', done);
    await sleep(800);
    await ss(page, 'use-tool-result');
    const txt = await page.evaluate(() => document.body.innerText);
    log('── 会话文本采样 ──');
    log(txt.split('\n').filter((l) => l.includes('echo') || l.includes('aurora') || l.includes('fetcher') || l.includes('允许')).slice(0, 10).join('\n'));
  } finally { await app.close().catch(() => {}); }
}
server.close();
log('done');
