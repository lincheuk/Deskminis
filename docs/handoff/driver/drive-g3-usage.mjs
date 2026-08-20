// G3 使用闭环验证：市场装技能+MCP（段1 install）→ 装出来的东西真被会话调用（段2 use）。
// 段2 的等价替换：注册表条目命令是 npx -y acme-fetcher-mcp（虚构 npm 包，云端不可得），
// 原地把 servers.json 该条目 command/args 换成 node + tests/mcp-stdio-server.mjs——
// 只换「包的运行时载体」，条目名/结构/引擎链路全真。
import { _electron as electron } from 'playwright-core';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { execSync } from 'node:child_process';

const PHASE = process.env.PHASE ?? 'install';
const APP_DIR = '/home/user/Deskminis/deskminis';
const SCRATCH = '/tmp/claude-0/-home-user-Deskminis/de13f871-02f4-5133-95e9-9105e3bca00b/scratchpad';
const SHOTS = path.join(SCRATCH, 'shots');
const DATA = path.join(SCRATCH, 'g3-usage-data');
const ZIP = fs.readFileSync(path.join(SCRATCH, 'driver', 'skill-pdf.zip'));
fs.mkdirSync(SHOTS, { recursive: true });
if (PHASE === 'install') {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'providers.json'), JSON.stringify({ providers: [], defaultProviderId: '__fake__' }));
}

const log = (...a) => console.log('[drive]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ss = async (page, name) => { await page.screenshot({ path: path.join(SHOTS, name + '.png') }); log('screenshot:', name); };
const clickText = (page, scope, text) => page.evaluate(({ scope, text }) => {
  const els = [...document.querySelectorAll(scope)];
  const el = els.find((e) => e.textContent?.trim() === text) ?? els.find((e) => e.textContent?.includes(text));
  if (!el) return 'NOT_FOUND: ' + text;
  el.click(); return 'OK';
}, { scope, text });
const waitText = async (page, needle, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    if ((await page.evaluate(() => document.body.innerText)).includes(needle)) return true;
    await sleep(400);
  }
  return false;
};

// ── fixture（三源 + download zip） ──
const awesomeIndex = JSON.stringify({ name: 'awesome-dsh-plugin', count: 0, plugins: [] });
const clawhubSearch = JSON.stringify({ results: [{ slug: 'pdf', displayName: 'Pdf', summary: 'PDF 处理技能', downloads: 47943, ownerHandle: 'awspace', isSuspicious: false, native: { skill: { isSuspicious: false, stats: { downloads: 47943, stars: 120 } } } }] });
const clawhubDetail = JSON.stringify({ skill: { slug: 'pdf', displayName: 'Pdf', summary: 'PDF 处理技能', description: '# Pdf 技能\n正文。', stats: { downloads: 47943, stars: 120 } }, latestVersion: { version: '0.1.0' }, owner: { handle: 'awspace' }, moderation: null, metadata: null });
const clawhubScan = JSON.stringify({ skill: { slug: 'pdf' }, version: { version: '0.1.0' }, security: { status: 'clean', hasScanResult: true, hasWarnings: false, checkedAt: 1, sha256hash: 'abc' }, moderation: null });
const mcpList = JSON.stringify({ servers: [{ server: { name: 'io.github.acme/fetcher', title: 'Fetcher', description: '抓取 MCP', version: '1.0.0', packages: [{ registryType: 'npm', identifier: 'acme-fetcher-mcp', transport: { type: 'stdio' }, runtimeHint: 'npx', environmentVariables: [{ name: 'API_KEY', description: '服务密钥', isRequired: true, isSecret: true }] }] }, _meta: {} }], metadata: { nextCursor: null, count: 1 } });
const mcpDetail = JSON.stringify({ server: JSON.parse(mcpList).servers[0].server, _meta: {} });

const server = http.createServer((req, res) => {
  console.log('[fixture]', req.url);
  const u = new URL(req.url, 'http://x');
  const json = (b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(b); };
  if (u.pathname === '/plugins.json') return json(awesomeIndex);
  if (u.pathname === '/api/v1/search') return json(u.searchParams.get('q') ? clawhubSearch : JSON.stringify({ results: [] }));
  if (u.pathname === '/api/v1/skills/pdf') return json(clawhubDetail);
  if (u.pathname === '/api/v1/skills/pdf/scan') return json(clawhubScan);
  if (u.pathname === '/api/v1/download') { res.writeHead(200, { 'content-type': 'application/zip' }); return res.end(ZIP); }
  if (u.pathname === '/v0.1/servers') return json(mcpList);
  if (u.pathname.startsWith('/v0.1/servers/')) return json(mcpDetail);
  res.writeHead(404); res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const FIXTURE = `http://127.0.0.1:${server.address().port}`;

if (PHASE === 'use') {
  // 等价替换：npx 包载体 → node + 真 stdio fixture（条目名/env/结构原样）
  const sj = path.join(DATA, 'mcp-servers', 'servers.json');
  const cfg = JSON.parse(fs.readFileSync(sj, 'utf8'));
  const names = Object.keys(cfg.mcpServers ?? cfg);
  const bucket = cfg.mcpServers ?? cfg;
  for (const n of names) {
    bucket[n].command = execSync('which node').toString().trim();
    bucket[n].args = [path.join(APP_DIR, 'tests', 'mcp-stdio-server.mjs')];
  }
  fs.writeFileSync(sj, JSON.stringify(cfg, null, 2));
  log('servers.json 载体替换完成:', names.join(','));
}

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron'),
  args: ['--no-sandbox', '.'],
  cwd: APP_DIR,
  timeout: 45_000,
  env: { ...process.env, DESKMINIS_DATA_DIR: DATA, DESKMINIS_MARKET_FIXTURE_URL: FIXTURE, DESKMINIS_FAKE_PROVIDER: '1' },
});
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    page = app.windows().find((w) => !w.url().startsWith('devtools://')) ?? null;
    if (!page) await sleep(500);
  }
  if (!page) page = await app.firstWindow();
  await page.waitForSelector('body', { timeout: 15_000 });
  await sleep(4000);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });

  if (PHASE === 'install') {
    // ── 装技能 ──
    await page.evaluate(() => { [...document.querySelectorAll('.wtab-main')].find((e) => e.textContent?.trim() === '扩展')?.click(); });
    await sleep(1200);
    await page.evaluate(() => {
      const cands = [...document.querySelectorAll('input')].filter((e) => e.type !== 'file' && e.type !== 'checkbox');
      const inp = cands.find((e) => (e.placeholder ?? '').includes('搜') || e.type === 'search') ?? cands[0];
      if (inp) { inp.value = 'pdf'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    await sleep(1500);
    log('install skill →', await clickText(page, 'button', 'Install'));
    await waitText(page, '确认安装');
    await sleep(600);
    log('confirm →', await clickText(page, 'button', '确认安装'));
    await sleep(2500);
    await ss(page, 'g3u-skill-installed');
    log('已装态:', await waitText(page, '已装', 10));

    // ── 装 MCP ──
    log('mcp tab →', await clickText(page, 'button', 'MCP'));
    await sleep(1500);
    log('install mcp →', await clickText(page, 'button', 'Install'));
    await waitText(page, '确认安装');
    log('env row 渲染:', await waitText(page, 'API_KEY', 20));
    await sleep(400);
    // env 填值（isSecret password 输入）
    const envFill = await page.evaluate(() => {
      const i = document.querySelector('input[type="password"]');
      if (!i) return 'NO_PASSWORD_INPUT';
      i.value = 'test-key-123'; i.dispatchEvent(new Event('input', { bubbles: true }));
      return 'FILLED';
    });
    log('env fill →', envFill);
    await sleep(400);
    await ss(page, 'g3u-mcp-confirm');
    log('confirm mcp →', await clickText(page, 'button', '确认安装'));
    await sleep(2000);
    await ss(page, 'g3u-mcp-installed');
  } else {
    // ── 使用：MCP 试连 + 会话内真调用 ──
    await page.evaluate(() => { [...document.querySelectorAll('[title]')].find((e) => (e.getAttribute('title') ?? '').includes('设置'))?.click(); });
    await page.waitForSelector('.sitem', { timeout: 8000 });
    log('nav MCP →', await clickText(page, '.sitem', 'MCP'));
    await sleep(800);
    log('row-test →', await clickText(page, 'button', '试连'));
    log('试连结果:', await waitText(page, '连接成功', 30));
    await ss(page, 'g3u-mcp-test');
    await page.keyboard.press('Escape');
    await sleep(500);

    // 会话内调用 mcp__ 工具（server 名从 servers.json 读）
    const sj = JSON.parse(fs.readFileSync(path.join(DATA, 'mcp-servers', 'servers.json'), 'utf8'));
    const serverName = Object.keys(sj.mcpServers ?? sj)[0];
    const sanitized = serverName.replace(/[^a-zA-Z0-9_-]/g, '_'); // 对齐 manager sanitizeSegment：模型侧名字符集
    const toolCall = `__tool__ mcp__${sanitized}__echo {"tool_title":"市场 MCP 真调用","greeting":"aurora-market-e2e"}`;
    log('tool call:', toolCall);
    await page.evaluate((t) => {
      const ta = document.querySelector('.composer textarea, textarea');
      ta.focus(); ta.value = t; ta.dispatchEvent(new Event('input', { bubbles: true }));
    }, toolCall);
    await sleep(300);
    await page.keyboard.press('Enter');
    // 权限卡（kind=mcp askOnce）
    const permShown = await waitText(page, '允许', 25);
    log('权限卡:', permShown);
    await ss(page, 'g3u-perm-card');
    if (permShown) {
      await page.evaluate(() => {
        const btns = [...document.querySelectorAll('button')];
        (btns.find((b) => b.textContent?.includes('本会话')) ?? btns.find((b) => b.textContent?.trim() === '允许'))?.click();
      });
    }
    // 等工具执行完成（echo 回流）
    for (let i = 0; i < 40; i++) {
      const t = await page.evaluate(() => document.body.innerText);
      if (t.includes('✓') && t.includes('echo')) break;
      await sleep(500);
    }
    await sleep(1000);
    // 展开工具行抓错误正文
    await page.evaluate(() => { [...document.querySelectorAll('.tline')].at(-1)?.click(); });
    await sleep(600);
    log('工具展开正文:', await page.evaluate(() => document.querySelector('.texpand')?.innerText?.slice(0, 400) ?? 'NO_EXPAND'));
    await ss(page, 'g3u-tool-called');
    const txt = await page.evaluate(() => document.body.innerText);
    log('echo 工具行存在:', txt.includes('echo'));
    log('页面采样:', txt.split('\n').filter((l) => l.includes('echo') || l.includes('mcp__') || l.includes('aurora-market')).slice(0, 6).join(' | '));
  }
} finally {
  await app.close().catch(() => {});
  server.close();
}
if (PHASE === 'install') {
  const sj = path.join(DATA, 'mcp-servers', 'servers.json');
  log('── servers.json（市场产物） ──\n' + (fs.existsSync(sj) ? fs.readFileSync(sj, 'utf8') : 'MISSING'));
  const skillsDir = path.join(DATA, 'skills');
  log('── skills 目录 ──', fs.existsSync(skillsDir) ? execSync(`find ${skillsDir} -type f`).toString().trim() : 'MISSING');
}
log('done PHASE=' + PHASE);
